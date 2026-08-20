# Instant machine-offline & harness updates — What was implemented

Implements the recommended combination (A → D → C → B → tuning) from
`INSTANT_OFFLINE_AND_HARNESS_UPDATES.md`. Machine online/offline now propagates to the phone
in **seconds** (presence) instead of up to **90s** (last-seen decay), and mobile-initiated
harness toggles apply in **~5s** instead of **~15s**. All three repos pass `node --check` /
`tsc`.

---

## A — Realtime Presence (the headline change)

**Desktop** (`relay-deamon1/scripts/heartbeat.js`)
- `subscribeCommandNudge()` now creates the `machine:<id>` channel **with presence config**
  (`presence: { key: machineId }`), keeps it in a module-level `machineChannel`, and calls
  `machineChannel.track({ online: true, at })` on `SUBSCRIBED`.
- `shutdown()` calls `machineChannel.untrack()` **before** `markOffline()` — an instant
  `leave` on clean exit, then the durable DB write.

**Mobile** — new `src/hooks/useMachinesPresence.ts`, mounted **once** in `AppNavigator`
(`RootNavigator.tsx`). For every paired machine it subscribes to `machine:<id>` and:
- **Presence** `sync`/`join`/`leave` → the machine is online iff its `key === machineId` is in
  `presenceState()`. A dropped desktop socket (kill / network / sleep) fires `leave` and flips
  it offline in ~seconds — no `last_seen` wait.
- `'harness'` broadcast → invalidates `['harnesses', id]`, `['machines']`, `['sessions']`.
- `'offline'` / `'online'` broadcast → patches caches directly (the B path).
- Manages channel lifecycle as the machine set changes; tears down on unmount.

The per-screen `useMachineChannel` (previously mounted in `ChatScreen` **and** per row in
`MachinesScreen`) was **removed** and the file **deleted** — the app-root hook is now the
single subscriber, so there's never a double-subscribe to the same topic.

## D — Cache patching (instant UI, no refetch)

`useMachinesPresence` writes online changes straight into the React-Query caches
(`qc.setQueryData(['machines'…])` and `['sessions'…]`), so every screen reading them — Machines
list, Sessions list, and `ChatScreen`'s `liveOnline` (hence the composer) — flips the moment
the presence/broadcast event arrives, with no server round-trip.

## B — Durable offline signal (backstop + cross-screen consistency)

**Server**
- `POST /machines/offline` (`routes/machines.js`) now `broadcastMachine(id, 'offline')` after
  setting `is_online = false`.
- `src/sweeper.js` gained `sweepOfflineMachines()`: every 45s it flips `is_online = false` and
  broadcasts `'offline'` for machines whose `last_seen` lapsed past the threshold — the
  durability backstop behind presence for sudden death (no clean `/offline`). Runs before the
  existing stale-turn sweep so it sees fresh machine state.

## C — Faster harness apply (partial)

- **Desktop** (`src/main.js`): the `apply-desired` poll was tightened **15s → 5s**, so a
  **mobile-initiated** harness toggle lands in ~5s. Desktop-initiated toggles already report
  immediately via `/harness/report` → `broadcastMachine('harness')` → the mobile hook.
- **Deferred (documented):** a fully event-driven apply (the Electron main process subscribing
  to a `harness_desired` broadcast and applying once) would make it ~instant with lower load,
  but needs a new realtime client in `main.js` plus double-apply race handling vs the poll —
  left as the follow-up in §5 of the design doc rather than wired blind.

## Tuning — tighter offline backstop

- `ONLINE_THRESHOLD_MS` **90s → 45s** (`routes/mobile.js`) — the derived-online backstop when
  presence isn't the source (cold start / presence unavailable).
- Machine heartbeat interval **30s → 15s** (`heartbeat.js`) — kept at ~⅓ of the 45s threshold
  so a single missed heartbeat can't flip a live machine offline.
- Sweeper `OFFLINE_MS` aligned to **45s**.

---

## Files changed

| Repo | File | Change |
| --- | --- | --- |
| desktop | `relay-deamon1/scripts/heartbeat.js` | presence track/untrack (A); heartbeat 30s→15s (tuning) |
| desktop | `src/main.js` | `apply-desired` poll 15s→5s (C) |
| server | `src/routes/machines.js` | `/offline` broadcasts `'offline'` (B) |
| server | `src/routes/mobile.js` | `ONLINE_THRESHOLD_MS` 90s→45s (tuning) |
| server | `src/sweeper.js` | `sweepOfflineMachines()` — flip+broadcast lapsed machines (B) |
| mobile | `src/hooks/useMachinesPresence.ts` | **new** — presence + broadcast + cache-patch (A+D) |
| mobile | `src/navigation/RootNavigator.tsx` | mount `useMachinesPresence()` at app root |
| mobile | `src/screens/Sessions/ChatScreen.tsx` | drop per-screen `useMachineChannel` |
| mobile | `src/screens/Machines/MachinesScreen.tsx` | drop per-screen `useMachineChannel` |
| mobile | `src/hooks/useMachineChannel.ts` | **deleted** (replaced by the app-root hook) |

---

## Expected latency after this

| Event | Before | After |
| --- | --- | --- |
| App close / clean shutdown | up to 90s | sub-second (presence untrack + `/offline` broadcast) |
| App killed (socket closes) | up to 90s | ~1–3s (presence `leave`) |
| Network drop / sleep | up to 90s | ~10–20s (presence timeout, then 45s sweeper backstop) |
| Machine back online | up to 90s + poll | ~seconds (presence `join`) |
| Harness toggle (desktop-initiated) | already instant | instant |
| Harness toggle (mobile-initiated) | ~15s | ~5s |

---

## Deploy & test

- **Server:** restart (new `/offline` broadcast, sweeper machine sweep, 45s threshold).
- **Desktop:** restart the heartbeat (presence + 15s heartbeat) **and** the Electron app
  (5s apply poll).
- **Mobile:** reload (JS-only; presence hook + cache patches).

Live checks:
1. In a chat with a working turn, **kill the desktop app** → the composer flips off "working"
   and the "Machine offline" note appears within ~1–3s (presence leave).
2. **Pull the desktop's network** → offline within ~10–20s (presence timeout) even without a
   clean shutdown; the 45s sweeper is the final backstop.
3. **Reconnect** → machine flips back online in ~seconds (presence join).
4. **Toggle a harness from the phone** → applied on the desktop in ~5s.

---

## Follow-ups (documented, not implemented)

- **Flap debounce:** the design doc's §8 suggests debouncing the offline flip ~2–3s so a brief
  socket blip doesn't flash "offline". Not added; presence timing already smooths most of it.
- **Fully event-driven harness apply** (main.js subscribes to `harness_desired`) — see C above.
- **Presence unavailable on self-hosted Supabase:** if presence isn't enabled on the anon key,
  the tuning (45s threshold) + `'offline'` sweeper broadcast still give a much-improved result;
  presence is the upgrade on top.
