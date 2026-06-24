# Supabase Broadcast — How It Works in This System

## What is broadcast?

Supabase Realtime has three modes:

| Mode | What it watches | Auth |
|---|---|---|
| `postgres_changes` | Database row changes via Postgres WAL | Respects row-level security (RLS) |
| `presence` | Who is online on a channel | Requires auth |
| **broadcast** | Arbitrary named events pushed by your server | No RLS — server decides who gets what |

This system uses **broadcast only**. We don't use `postgres_changes` because the most important events (pairing, harness toggles) either happen while the machine has no user session yet, or originate from the desktop which has no Supabase user token — so RLS would block delivery entirely.

---

## The full flow, step by step

```
Desktop toggles harness
       │
       ▼
POST /harness/report  (server)
  ├─ upserts new state into machine_harnesses table
  ├─ clears any stale desired_enabled desires
  └─ calls broadcastMachine(machineId, 'harness')
            │
            ▼
      HTTP POST to Supabase broadcast endpoint
      /realtime/v1/api/broadcast
      topic: "machine:<uuid>"
      event: "harness"
      payload: {}   ← intentionally empty
            │
            ▼  (Supabase pushes this to all subscribers of that topic)
            │
  Phone (useMachineChannel hook is subscribed to "machine:<uuid>")
       │
       ▼
  Receives 'harness' event
       │
       ├─ invalidateQueries(['harnesses', machineId])  → refetches HarnessPanel
       ├─ invalidateQueries(['machines'])               → refetches machine list
       └─ invalidateQueries(['sessions'])               → refetches sessions + harness_enabled
            │
            ▼
  UI updates with new toggle state
  (typically < 500 ms after the desktop toggle)
```

---

## Server side — `broadcastMachine`

**File:** `src/realtime.js`

```js
export function broadcastMachine(machineId, event, payload = {}) {
  fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method:  'POST',
    headers: {
      apikey:        SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      messages: [{ topic: `machine:${machineId}`, event, payload }],
    }),
  }).catch(() => {})   // fire-and-forget
}
```

Key design decisions:

- **HTTP POST, not WebSocket.** The server doesn't hold a persistent connection to Supabase. Each call is a single stateless HTTP request. This means any Express route handler can fire a broadcast and return immediately — no setup, no teardown.
- **Service key.** We use the Supabase service role key (bypasses RLS) because the desktop has no user JWT.
- **Fire-and-forget.** The `.catch(() => {})` means a Supabase outage or network blip will never fail the HTTP response to the desktop. The poll intervals are the correctness backstop.
- **Empty payload.** The phone re-fetches the data over its authenticated REST API after receiving the event. No sensitive token or state ever travels over the unauthenticated broadcast channel.

Currently called from:
- `POST /harness/report` — fires `'harness'` event every time the desktop reports new toggle state
- `POST /pairing/*` — fires `'paired'` / `'unpaired'` events during QR pairing flow

---

## Mobile side — `getRealtimeClient`

**File:** `src/api/realtime.ts`

The phone can't use the service key. Instead it gets a **short-lived realtime JWT** from the server:

```
Phone                         Server                    Supabase
  │                              │                          │
  │  POST /mobile/realtime-token │                          │
  │  (Bearer: user access_token) │                          │
  │ ─────────────────────────────>                          │
  │                              │  signs a JWT scoped      │
  │                              │  to this user's topics   │
  │  { token }  ◄────────────────│                          │
  │                              │                          │
  │  createClient(SUPABASE_URL, token)                      │
  │ ─────────────────────────────────────────────────────── >
  │                       WebSocket connection established   │
```

The client is **cached in a module-level variable** — one connection per app session, reused across all channel subscriptions.

---

## Mobile side — `useMachineChannel`

**File:** `src/hooks/useMachineChannel.ts`

```ts
export function useMachineChannel(machineId?: string) {
  const qc = useQueryClient()

  useEffect(() => {
    if (!machineId) return

    ;(async () => {
      const client = await getRealtimeClient()   // reuses cached connection
      if (!client) return

      client
        .channel(`machine:${machineId}`)         // subscribe to this machine's topic
        .on('broadcast', { event: 'harness' }, () => {
          qc.invalidateQueries({ queryKey: ['harnesses', machineId] })
          qc.invalidateQueries({ queryKey: ['machines'] })
          qc.invalidateQueries({ queryKey: ['sessions'] })
        })
        .subscribe()
    })()

    return () => { channel.unsubscribe() }       // cleanup on unmount
  }, [machineId])
}
```

**Where it's mounted:**

| Component | Why |
|---|---|
| `MachineCard` (Machines tab) | Updates the harness toggle switch instantly |
| `ChatScreen` | Updates `harness_enabled` on the live session so the compose bar locks/unlocks |

Because the hook takes a `machineId`, it only subscribes to the one specific machine's topic — no noise from other users' machines.

---

## Why the payload is empty (and the optional optimisation)

Currently the broadcast carries `payload: {}`. On receipt, the phone fires three `invalidateQueries` calls, which each trigger a network round-trip to the server. So the sequence is:

```
broadcast received (< 100 ms)
  → 3 REST fetches (each ~100–300 ms)
    → UI updates
```

Total latency: roughly 200–500 ms after the desktop toggle.

**Optional zero-round-trip optimization** (not yet implemented):

Put the new harness rows directly in the payload:

```js
// server
broadcastMachine(machineId, 'harness', { harnesses: updatedRows })
```

```ts
// mobile
.on('broadcast', { event: 'harness' }, ({ payload }) => {
  qc.setQueryData(['harnesses', machineId], payload.harnesses)
  // no network fetch needed — UI flips the instant the packet arrives
})
```

Trade-off: the payload now carries real state, so if a broadcast is missed the phone would be stale until the next poll. The current design (invalidate → refetch) is always consistent because the fetch is authoritative. For a toggle UI the difference is invisible in practice.

---

## The "desired_enabled" interaction

When the **phone** initiates a toggle (tap on Machines tab), it calls `POST /harness/:machineId/desire`, which writes `desired_enabled = true/false` to the database. The desktop's 15-second poll (`GET /harness/desired`) picks this up and applies it, then the next `POST /harness/report` reflects the new state and fires a broadcast.

So phone-initiated toggles flow:

```
Phone tap → /desire (DB write) → desktop poll (15 s max) → desktop applies
  → /harness/report → broadcastMachine → phone receives → UI updates
```

Worst case: ~15 s round-trip for phone-initiated toggles. Desktop-initiated toggles are instant (broadcast fires the moment the toggle happens on the desktop).

---

## Poll intervals (backstop)

Broadcast is the fast path. These polls are the safety net if a broadcast is missed (WebSocket reconnect, app backgrounded, etc.):

| Hook / query | Interval | What it covers |
|---|---|---|
| `useSessions` | 5 s | `harness_enabled` in chat composer |
| `HarnessPanel` (Machines tab) | 10 s | Toggle state in machine card |
| `fetchMachines` | 30 s | Machine online/offline |

---

## Summary

| Component | File | Role |
|---|---|---|
| `broadcastMachine()` | `server/src/realtime.js` | Server utility — HTTP POST to Supabase |
| `POST /harness/report` | `server/src/routes/harness.js` | Calls `broadcastMachine` after every upsert |
| `getRealtimeClient()` | `mobile/src/api/realtime.ts` | Gets/caches Supabase WS client with scoped JWT |
| `useMachineChannel()` | `mobile/src/hooks/useMachineChannel.ts` | Subscribes, invalidates queries on event |
| `MachineCard` | `MachinesScreen.tsx` | Mounts hook so toggle switches update instantly |
| `ChatScreen` | `ChatScreen.tsx` | Mounts hook so compose bar lock updates instantly |
