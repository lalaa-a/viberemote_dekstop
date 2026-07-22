# Lightning-speed machine-offline & harness-toggle updates on mobile

Goal: when a machine goes offline, or a harness's mobile support is toggled, the phone reflects
it in **seconds, not up to 90s / 15s**. This is the propagation companion to
`STALE_WORKING_ON_DISCONNECT_DESIGN.md` (which handles the *turn* state); here we make the
*machine/harness* state itself fast.

---

## 1. Why it's slow today

### Machine offline
- The desktop heartbeat POSTs `/machines/heartbeat` every **30s** → `is_online=true, last_seen=now`.
- `/mobile/sessions` derives `machine_is_online = (now − last_seen) < ONLINE_THRESHOLD_MS`
  where **`ONLINE_THRESHOLD_MS = 90_000`**.
- **Sudden death** (network drop, app killed, laptop sleep): `last_seen` simply stops updating,
  so the machine is "online" for a full **90s**, and only then *if* the mobile refetches.
- **Clean shutdown** posts `/machines/offline` → sets the stored `is_online=false`, but **does
  not touch `last_seen` and does not broadcast**. So the sessions view (which reads the derived
  `< 90s last_seen`) still shows online for 90s anyway.
- There is **no Realtime signal for offline at all** — the mobile only learns by polling and
  re-deriving.

### Inconsistent source of truth
Two different "online" values are read across screens:
- **Sessions / chat** → derived `machine_is_online` (`< 90s last_seen`).
- **Machines list / Sessions chips / request cards** → the **stored `is_online` column**.

On sudden death nobody sets `is_online=false`, so the stored column can stay `true` **forever**,
while the derived one flips after 90s. They disagree.

### Harness toggle
- Server `/harness/report` already fires `broadcastMachine(id, 'harness')`, and the mobile's
  `useMachineChannel` invalidates on it — so the **mobile side is already instant**.
- The lag is on the **desktop**: mobile-initiated toggles are applied by a **15s** loop
  (`harnessDesiredTimer = setInterval(..., 15000)` in `src/main.js`). A desktop-initiated
  toggle reports immediately; a phone-initiated one waits up to 15s to be applied and reported.

---

## 2. The mechanisms that make it instant

Three tools, each for a different failure shape:

| Event | Instant mechanism | Latency |
| --- | --- | --- |
| Toggle off / app close / clean shutdown | **Explicit broadcast** (`broadcastMachine`) + presence untrack | sub-second |
| App killed (process dies, socket closes) | **Realtime Presence `leave`** (WebSocket close) | ~1–3s |
| Network drop / sleep (no socket close) | **Presence timeout** (Phoenix socket heartbeat), tuned aggressive | ~10–15s (vs 90s) |
| Harness toggle (either direction) | **Broadcast to apply now** + broadcast the result | sub-second |

---

## 3. Solution A — Realtime **Presence** for instant offline (the core change)

Supabase Realtime Presence tracks who is connected to a channel and fires `join`/`leave` the
moment a client's socket appears/disappears — exactly the "is the desktop there right now?"
question, answered without waiting on `last_seen`.

### A1. Desktop: track presence on the machine channel

In the heartbeat (`relay-deamon1/scripts/heartbeat.js`), alongside the existing broadcast
subscription, join `machine:<id>` and `track()`:

```js
const presenceChannel = supabase.channel(`machine:${config.machineId}`, {
  config: { presence: { key: config.machineId } },
})
presenceChannel.subscribe((status) => {
  if (status === 'SUBSCRIBED') {
    presenceChannel.track({ online: true, at: Date.now() })
  }
})
// On clean shutdown: presenceChannel.untrack() then markOffline() (see A3).
```

When the desktop's socket drops (kill / network / sleep), Supabase removes its presence and
fires `leave` to every other subscriber — no heartbeat math, no 90s wait.

### A2. Mobile: watch presence and flip offline instantly

Extend `useMachineChannel(machineId)` (already subscribed to `machine:<id>` broadcast) to also
read presence and expose a live `machineOnline`:

```ts
const channel = client.channel(`machine:${machineId}`, {
  config: { presence: { key: 'viewer' } },   // mobile is a viewer; it doesn't track
})
  .on('presence', { event: 'sync' }, () => {
    const present = Object.keys(channel.presenceState()).some(k => k === machineId)
    setMachineOnline(present)              // instant online/offline
  })
  .on('presence', { event: 'leave' }, () => { /* recompute from presenceState() */ })
  .on('broadcast', { event: 'harness' }, () => qc.invalidateQueries(...))
  .subscribe()
```

Then `machineOnline` (presence-backed) becomes the authoritative online signal:
- **Presence says gone → offline immediately**, overriding a stale `last_seen`-derived value.
- **Presence says present → online**, even before the next `/machines/heartbeat`.

`ChatScreen`'s `liveOnline` and the Machines/Sessions chips read this instead of (or ANDed
with) the fetched value.

### A3. Presence + the existing markOffline (graceful path)

On clean shutdown / toggle-off, `untrack()` first (fires an instant `leave`), then keep
`markOffline()` for the durable DB state. Belt (presence, instant) and suspenders (DB, durable).

### A4. Tune the presence/socket timeout for the network-drop case

A hard network drop has no close frame, so `leave` waits for the Phoenix socket heartbeat to
lapse. Lower it (client `heartbeatIntervalMs` / server timeout) so a dropped desktop is
declared gone in ~10–15s instead of the default. This is the one case that can't be truly
instant — but it's still far better than 90s, and it's the safety net behind A1/A2.

---

## 4. Solution B — Broadcast offline explicitly (durable + instant, no presence needed)

Even without presence, make offline a *pushed* event instead of a *polled* derivation.

- **Server:** in `/machines/offline`, after setting `is_online=false`, add
  `broadcastMachine(id, 'offline')`. Also set `last_seen` old so the derived value agrees.
- **Server sweeper (optional):** a job that flips `is_online=false` and broadcasts `offline`
  for any machine whose `last_seen` is stale > threshold — this is what closes the sudden-death
  case for the stored column (which nobody updates today), and it can reuse the stale-turn
  sweeper from `STALE_WORKING_ON_DISCONNECT_DESIGN.md §3-B`.
- **Mobile:** `useMachineChannel` handles `'offline'` (and a matching `'online'` on heartbeat)
  by patching the cache directly (Solution D) — instant, no refetch round-trip.

Solution B is the fallback/durability layer; Solution A (presence) is what makes sudden death
fast. Do both: presence for speed, broadcast+DB for durability and cross-screen consistency.

---

## 5. Solution C — Kill the 15s harness apply lag

Mobile-initiated toggles wait on the desktop's 15s loop. Make them event-driven like prompt
delivery already is:

- **Server:** when the phone requests a harness toggle, `broadcastMachine(id, 'harness_desired',
  { harness, enabled })` (same pattern as `command_available`).
- **Desktop:** subscribe to `harness_desired` and **apply immediately**, then POST
  `/harness/report` (which already broadcasts `'harness'` back). Keep the 15s loop only as a
  missed-broadcast backstop.
- **Desktop-initiated** toggles already report immediately — just confirm the local UI path
  POSTs `/harness/report` synchronously on toggle, not on the timer.

Result: a toggle round-trips phone → server → desktop → server → phone in ~1s instead of ≤15s.

---

## 6. Solution D — Mobile reacts by patching the cache, not refetching

Today the broadcast handlers call `invalidateQueries` → a **refetch round-trip** before the UI
updates. For truly instant UI, patch the cached data directly in the handler, then let the
(also-fired) refetch reconcile:

```ts
// on 'offline' / presence leave:
qc.setQueryData(['sessions'], (rows) =>
  rows?.map(s => s.machine_id === machineId ? { ...s, machine_is_online: false } : s))
qc.setQueryData(['machines'], (ms) =>
  ms?.map(m => m.id === machineId ? { ...m, is_online: false } : m))
// on 'harness': patch harness_enabled locally, then invalidate to reconcile.
```

This removes the server round-trip from the perceived latency — the chip flips the instant the
broadcast/presence event arrives.

---

## 7. Recommended combination & order

1. **A (presence)** — the headline fix; makes sudden-death offline ~seconds. Desktop track +
   mobile watch + `machineOnline` as the authoritative signal.
2. **D (cache patch)** — instant UI on every machine/harness event; cheap, mobile-only.
3. **C (harness apply broadcast)** — removes the 15s mobile-toggle lag.
4. **B (offline broadcast + `is_online` sweep)** — durability and cross-screen consistency;
   fixes the stored-vs-derived split so the Machines list agrees with the chat.
5. **Tuning** — drop the socket heartbeat timeout (A4) and optionally the machine heartbeat
   (30s → 10s) as the non-presence backstop.

One-line essence: **stop polling `last_seen` and start pushing presence** — the desktop's live
socket *is* the online signal, and its disappearance is the offline signal, delivered the
moment it happens.

---

## 8. Edge cases & guards

- **Flapping.** A brief socket blip could fire leave→join. Debounce the mobile "offline" flip
  by ~2–3s so a reconnect within that window doesn't flash "offline".
- **Multiple viewers.** Presence `key: 'viewer'` for phones is fine; only the *machine's* key
  presence matters for "is the desktop here". Filter `presenceState()` by the machine id.
- **Presence unavailable on self-hosted.** If presence isn't enabled/allowed on the anon key,
  Solutions B + tuning still give a much-improved (~10–25s) result; presence is the upgrade.
- **Consistency with the turn sweeper.** When presence fires offline, `ChatScreen` already
  treats `liveOnline === false` as "not working" (per the stale-turn fix), so the composer
  flips off instantly too — the two features compose.
- **Reconnect.** On desktop reconnect, `track()` + the next `/machines/heartbeat` restore
  online via presence join and the `'online'`/`'harness'` broadcasts; cache patches reconcile.

---

## 9. Reference points

- `relay-deamon1/scripts/heartbeat.js` — `tick` (30s heartbeat), `shutdown`/`markOffline`,
  `subscribeCommandNudge` (where the presence channel would join), `supabase` anon client.
- `vibe_remote(serverside)/src/routes/machines.js` — `/heartbeat` (`is_online`/`last_seen`),
  `/offline` (add the broadcast here).
- `vibe_remote(serverside)/src/routes/harness.js` — `/harness/report` → `broadcastMachine('harness')`.
- `vibe_remote(serverside)/src/routes/mobile.js` — `ONLINE_THRESHOLD_MS = 90_000`, derived
  `machine_is_online`.
- `vibe_remote(serverside)/src/realtime.js` — `broadcastMachine`, `broadcastSession`.
- `vibe_remote(reactNative)/AgentControl/src/hooks/useMachineChannel.ts` — where presence +
  cache-patch handlers go.
- `src/main.js` — `harnessDesiredTimer` (the 15s apply loop to replace with `harness_desired`).
