# ADR: Replace Polling with a Push Transport

> **Status:** Proposed · **Date:** 2026-06-20
> **Decision owners:** mobile + server + relay-daemon
> **Supersedes:** the fixed-interval React Query polling described in
> `CHAT_REQUESTS_AND_LATENCY_FIX.md` (Part C)

---

## 1. Context

The app currently mixes two delivery models:

- **Supabase Realtime (WebSocket)** — already used for the live chat feed
  (`useChatFeed` subscribes to `chat:{sessionId}`) and for machine broadcasts
  (`useMachineChannel` → `machine:{machineId}`).
- **HTTP polling on fixed timers** — for nearly everything else:

| Surface | Query | Interval | Direction |
|---------|-------|----------|-----------|
| Sessions list | `['sessions']` | **5s** | server→mobile |
| Pending requests | `['requests','pending']` | **8s** | server→mobile |
| Chat feed (safety net) | `['feed', id]` | 30s | server→mobile |
| Harness state | `['harnesses', id]` | **10s** | server→mobile |
| Machines | `['machines']` | 30–60s | server→mobile |
| Decision status (desktop) | `GET /relay/status/{id}` | **3s** | server→desktop |
| Prompt delivery (desktop) | `GET /mobile/command/next` | heartbeat loop | server→desktop |

### Why polling hurts as we grow

Polling cost is **independent of activity** — every client pays it even when
nothing is happening. Per active mobile client, the steady-state load is roughly:

```
sessions  5s  → 12 req/min
pending   8s  → ~7.5 req/min
harness  10s  → 6 req/min
feed     30s  → 2 req/min
machines 45s  → ~1.3 req/min
                ─────────────
               ~29 requests/min/client of pure idle polling
```

At **1,000 concurrent clients** that's ~29,000 req/min ≈ **480 req/s hitting the
database** before a single real event occurs. At 10,000 clients it's ~4,800 req/s
of nothing. This is a linear cost wall, and it's the opposite of how the workload
actually behaves — long idle stretches punctuated by bursts.

A push transport inverts the economics: **idle cost ≈ holding a socket open;
work happens only when there's an actual event.**

---

## 2. Decision

**Adopt Supabase Realtime as the single push transport for all
server→client and server→desktop event delivery. Keep REST for
client→server commands. Keep one slow poll (30–60s) purely as a
reconnect safety net. Do not build a bespoke WebSocket server now.**

Concretely:

1. **Migrate the remaining polled reads onto Realtime** — sessions list,
   pending-request changes, harness state — using `postgres_changes`
   subscriptions and/or `broadcast`, the same mechanism the chat feed already
   uses.
2. **Keep client→server actions on REST** (`/mobile/decide`, `/mobile/prompt`,
   `/mobile/fs/request`, pairing). These are request/response by nature; a socket
   adds nothing and complicates error handling. Combined with the optimistic
   cache updates from the latency doc, the acting user already sees instant
   feedback.
3. **Replace the desktop's 3s decision poll and command-poll with a Realtime
   nudge + atomic claim** (details in §6).
4. **Demote every remaining poll to a 30–60s "did I miss anything while the
   socket was down" backstop**, paused when the app is backgrounded.

### Why not build our own WebSocket server?

Because **we already operate a production WebSocket system** — Supabase Realtime —
and it already solves the hard parts: Postgres change-data-capture fan-out,
per-row authorization via RLS, JWT auth (we already mint Realtime tokens at
`POST /mobile/realtime-token`), connection management, and horizontal scaling.
Standing up our own `ws`/Socket.IO layer on the Express server would mean
re-implementing connection state, sticky-session/Redis fan-out across instances,
auth, presence, and reconnection — net-negative operational complexity for
capability we already have.

We keep a custom WS/SSE layer as a documented **escape hatch** (§7), to be
revisited only if Supabase Realtime quotas or cost become the binding
constraint.

---

## 3. Options considered

### Option A — Lean fully into Supabase Realtime ✅ (chosen)

WebSocket transport we already use; extend it to the remaining surfaces.

| Pros | Cons |
|------|------|
| Zero new infrastructure; already integrated on all three tiers | Bound to Supabase quotas (concurrent connections, messages/s, channels) |
| RLS gives per-row auth for free — no custom authz on the socket | `postgres_changes` fan-out has a practical scale ceiling (mitigable with `broadcast`) |
| JWT auth already built (`/mobile/realtime-token`, 12h HS256) | Vendor coupling |
| Auto reconnect/backoff handled by `supabase-js` | Debugging CDC filters is fiddly |
| Same model the chat feed already proves in production | |

### Option B — Custom WebSocket server (ws / Socket.IO on Express)

| Pros | Cons |
|------|------|
| Full control over protocol, batching, presence | We now own connection state, scaling, auth, reconnection |
| Could be cheaper at very high scale | Multi-instance needs sticky sessions or a Redis/NATS adapter |
| No per-message vendor quota | Duplicates what Supabase Realtime already does |
| | Largest effort + ongoing ops burden; new failure modes |

### Option C — Server-Sent Events (SSE)

One-way server→client streaming over plain HTTP. A natural fit since **most of
our traffic is server→client**.

| Pros | Cons |
|------|------|
| Dead simple; runs over existing Express, no new infra | One-way only (fine — client→server stays REST) |
| Trivial through proxies/CDNs; auto-reconnect built into the browser/RN EventSource | We'd still hand-roll fan-out + per-user authz that RLS gives us in A |
| Great fit for the **desktop relay** (replace `/relay/status` + command polling) | Another transport to maintain alongside Realtime → inconsistency |
| Lower overhead than WS for our pattern | HTTP/1.1 connection-count limits per host (less relevant on RN/native) |

### Option D — Keep polling, just tune intervals

| Pros | Cons |
|------|------|
| Zero work | Doesn't fix the linear scaling wall |
| Dead simple | Always a latency/cost tradeoff; never both |

**Verdict:** A is the pragmatic winner — it removes the polling wall with the
least new surface area because the transport already exists and is proven here.
C (SSE) is the strongest *alternative* and the preferred shape **if** we ever move
the relay path off Supabase; it's documented as the escape hatch. B is reserved
for a scale we are nowhere near.

---

## 4. Transport per data flow (target state)

| Flow | Direction | Transport | Mechanism |
|------|-----------|-----------|-----------|
| New approval request | server→mobile | **Realtime** | `postgres_changes` INSERT on `pending_requests` (already) |
| Approval request while app killed | server→mobile | **FCM push** | unchanged — Realtime can't wake a killed app |
| Decision made | server→mobile (other viewers) | **Realtime** | `postgres_changes` UPDATE (already) |
| Decision made | server→desktop relay | **Realtime** | decision channel nudge + 30s poll backstop (replaces 3s poll) |
| Narrative / terminal events | server→mobile | **Realtime** | `postgres_changes` INSERT on `terminal_events` (already) |
| Prompt available to deliver | server→desktop relay | **Realtime nudge → atomic claim** | replaces steady `command/next` polling (§6) |
| Sessions list changes (pending_count, activity) | server→mobile | **Realtime** | NEW subscription → invalidate `['sessions']` |
| Harness toggle state | server→mobile | **Realtime** | `machine:{id}` broadcast (already) + slower poll |
| Approve / Deny | mobile→server | **REST** | `POST /mobile/decide` (+ optimistic cache) |
| Send prompt | mobile→server | **REST** | `POST /mobile/prompt` |
| File-tree request | mobile→server | **REST** | `POST /mobile/fs/request` |
| Pairing | mobile→server | **REST** | unchanged |

Principle: **push for fan-out (server→many), request/response for commands
(one→server).** Don't force user actions through a socket.

---

## 5. What changes on the mobile client

Add Realtime subscriptions for the surfaces still on fast polls, then relax those
polls to a backstop. Example — make the **sessions list** live so its 5s poll can
drop to 15s:

```ts
// useSessionsRealtime.ts — invalidate the sessions query on relevant changes
export function useSessionsRealtime(machineIds: string[]) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!machineIds.length) return
    let unsub: (() => void) | null = null
    ;(async () => {
      const client = await getRealtimeClient()
      if (!client) return
      const channel = client.channel('sessions')
        // pending_count / last_activity changes ride on agents + pending_requests
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'agents',
            filter: `machine_id=in.(${machineIds.join(',')})` },
          () => qc.invalidateQueries({ queryKey: ['sessions'] }))
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'pending_requests',
            filter: `machine_id=in.(${machineIds.join(',')})` },
          () => qc.invalidateQueries({ queryKey: ['sessions'] }))
        .subscribe()
      unsub = () => { try { channel.unsubscribe() } catch {} }
    })()
    return () => { if (unsub) unsub() }
  }, [machineIds.join(',')]) // eslint-disable-line
}
```

Then in `useSessions`:

```ts
refetchInterval: 15_000,            // was 5_000 — backstop only now
refetchIntervalInBackground: false, // don't poll when app is backgrounded
```

And globally on the `QueryClient`:

```ts
defaultOptions: { queries: {
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: false,
  staleTime: 5_000,
}}
```

Wire React Query's `focusManager` to RN `AppState` so background = no polling and
sockets can be torn down/restored cleanly.

> Note on invalidate-vs-patch: for the **sessions list** we invalidate (cheap, the
> list is small and the query is the source of truth). For the **chat feed** we
> patch the cache from the payload directly (already done) to avoid a refetch per
> event — important because terminal events are high-volume.

---

## 6. What changes on the desktop relay

Two polls to retire:

### 6a. Decision status — `GET /relay/status/{id}` every 3s

The daemon **already** subscribes to a Supabase Realtime decision channel
(`hook.js` races Realtime vs. polling). Keep Realtime as the primary signal and
**demote the poll from 3s to a single 20–30s backstop** (the cache window
boundary). On a healthy socket the decision arrives in well under a second; the
backstop only covers a dropped socket.

### 6b. Prompt delivery — steady `GET /mobile/command/next`

Replace the steady poll with a **nudge + atomic claim**:

1. Server inserts the `mobile_commands` row (already).
2. Daemon receives a Realtime nudge (`postgres_changes` INSERT on
   `mobile_commands` for its `machine_id`, **or** a `machine:{id}` broadcast
   `command_available`).
3. On nudge — and only then — the daemon calls `GET /mobile/command/next`, which
   **keeps the existing server-side idle-gating and atomic "mark delivered"**
   semantics (so a prompt never interrupts a tool sequence). The HTTP call stays;
   what disappears is the *steady polling*.

This preserves the one piece of real logic (idle-gated, atomic claim) while
removing the constant request stream.

---

## 7. Escape hatch (when to revisit)

Stay on Option A until one of these triggers fires, then move the heaviest flow to
**SSE on our own Express server** (Option C) or self-hosted Realtime:

- Supabase Realtime **concurrent-connection** or **messages/second** quota becomes
  the binding limit (watch the Realtime dashboard).
- `postgres_changes` fan-out latency degrades under load → migrate hot paths from
  `postgres_changes` to **`broadcast`** (server emits an explicit event instead of
  the DB emitting per-row CDC) *before* considering leaving Supabase. This is the
  cheap intermediate step and often enough on its own.
- Realtime cost per MAU exceeds the cost of running our own SSE/WS tier.

Order of escalation: **tune polls → postgres_changes → broadcast → self-hosted
Realtime / SSE → custom WS.** We are at step 2.

---

## 8. Consequences

**Positive**
- Idle cost drops from ~29 req/min/client to ≈ one held socket; the linear DB
  polling wall disappears.
- Lower end-to-end latency on sessions/harness updates (push vs. up-to-interval
  wait).
- One consistent push model across mobile + desktop; fewer moving parts than
  adding a second transport.
- No new infrastructure, no new auth surface — reuses the existing Realtime token
  and RLS.

**Negative / risks**
- Deeper coupling to Supabase Realtime quotas and behavior (mitigated by §7 and by
  keeping a backstop poll).
- `postgres_changes` filters and RLS interactions need careful testing; a wrong
  filter silently delivers nothing.
- More open sockets to reason about — must unsubscribe on blur/unmount and rely on
  `supabase-js` reconnect/backoff.
- FCM remains mandatory for killed-app delivery; Realtime does **not** replace push
  notifications.

**Neutral**
- Client→server stays REST; no change to how actions are issued or error-handled.

---

## 9. Rollout plan

1. **Mobile global `QueryClient`**: `refetchIntervalInBackground: false`,
   `refetchOnWindowFocus: false`; wire `focusManager` to `AppState`. *(low risk,
   immediate idle-load win)*
2. **Sessions list → Realtime** (`useSessionsRealtime`), poll 5s → 15s.
3. **Harness state**: rely on existing `machine:{id}` broadcast, poll 10s → 30s.
4. **Remove the dead `['requests','pending']` 8s poll** (chat-centric model no
   longer renders it — see latency doc Part A2).
5. **Desktop decision poll** 3s → 25s backstop (Realtime primary).
6. **Desktop command delivery** → nudge + atomic claim (§6b).
7. **Load-test** at target concurrency; watch Supabase Realtime connection +
   message metrics. If they approach quota, migrate hottest path
   `postgres_changes` → `broadcast` (§7).

Each step is independently shippable and reversible (revert to the prior interval).

---

## 10. Verification

- **Idle load:** with the app foregrounded and nothing happening, network is quiet
  (only socket keepalives). Background the app → zero requests.
- **Liveness:** start a new agent session on the desktop → it appears in the mobile
  sessions list within ~1s without a manual refresh.
- **Decision latency (desktop):** approve on mobile → CLI resumes in <1s with the
  3s poll disabled (Realtime path), and still resumes (within the backstop) if the
  socket is forcibly dropped.
- **Resilience:** kill the socket (airplane-mode toggle) → backstop poll keeps data
  fresh; on reconnect, subscriptions resume and no events are permanently missed.
- **Killed app:** approval request still arrives via FCM.

---

*Decision grounded in the existing stack: Supabase Realtime
(`api/realtime.ts`, `useChatFeed.ts`, `useMachineChannel.ts`, server
`realtime.js`, `POST /mobile/realtime-token`), HTTP polling
(`useSessions.ts`, `useRequests.ts`), and the relay daemon's decision/command
loops. Pairs with `CHAT_REQUESTS_AND_LATENCY_FIX.md`.*
