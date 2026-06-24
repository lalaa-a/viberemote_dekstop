# Implementation Log — Chat Requests, Decision Latency & Realtime Migration

> What was actually built from `CHAT_REQUESTS_AND_LATENCY_FIX.md` (the spec) and
> `REALTIME_TRANSPORT_DECISION.md` (Option A). Implemented 2026-06-20.
>
> Repos:
> - **mobile** — `D:\Projects\vibe_remote(reactNative)\AgentControl`
> - **server** — `D:\Projects\vibe_remote(serverside)`
> - **desktop** — `D:\Projects\vRdeksMultiharness\relay-deamon1`

---

## Status at a glance

| Step | What | Repo | Status |
|------|------|------|--------|
| B2 | Optimistic feed-cache patch on approve/deny | mobile | ✅ Done |
| A1 | Tappable request card → `RequestDetail` (diff screen) | mobile | ✅ Done |
| A2 | Remove dead Requests-tab polling + orphaned screens | mobile | ✅ Done |
| B3 | `decide` route → one `UPDATE … RETURNING` + async count | server | ✅ Done |
| C1 | Focus-aware `QueryClient` + `AppState`→`focusManager` | mobile | ✅ Done |
| C2 | `agents` published on Realtime (migration 009) | server | ✅ Done |
| C2 | `useSessionsRealtime` + sessions poll 5s→15s | mobile | ✅ Done |
| C3 | Harness poll 10s→30s; pending-list poll removed | mobile | ✅ Done |
| C4a | Desktop decision poll 3s→25s backstop | desktop | ✅ Done |
| C4b | Desktop prompt delivery: Realtime nudge + atomic claim | desktop | ✅ Done |
| C5 | Trim heavy feed payloads (`new_content`/`old_content`/`raw_input`) | server | ⏭️ Deferred (see notes) |
| C6 | `postgres_changes`→`broadcast` escape hatch | — | ⏭️ Not needed yet |
| 10 | Load-test at target concurrency | — | ⏳ Pending (ops) |

Validation: all three edited backend/daemon JS files pass `node --check`; the
mobile project passes `tsc --noEmit` with **no new errors** in any touched file
(three unrelated pre-existing errors remain — see [Validation](#validation)).

---

## Mobile (`AgentControl`)

### B2 — Optimistic feed patch *(the main latency fix)*
**File:** `src/hooks/useRequests.ts` (rewritten)

- `useDecideRequest` now patches the **`['feed', …]` infinite-query cache** in
  `onMutate` (via a new `patchPendingInFeeds` helper that mirrors `patchRow` in
  `useChatFeed`), so the request card flips to Approved/Denied **instantly** on tap
  instead of waiting for the Supabase Realtime UPDATE round-trip.
- Also patches an open `['requests', id]` detail cache.
- Snapshots all feed caches and rolls them back on error; `onSettled` reconciles
  the detail query. The later Realtime UPDATE carries the same `status`, so the
  feed item signature is unchanged and React skips the re-render (no flicker).
- Because `pendingCount` is derived from the feed, the composer **unlocks
  immediately** too.

### A1 — Tappable request card → detail/diff screen
**File:** `src/screens/Sessions/ChatScreen.tsx`

- `RequestCard` container is now a `TouchableOpacity`; tapping it calls
  `onOpen` → `navigation.navigate('RequestDetail', { id })`. Tapping only fires
  when the request is inspectable (`canInspect = diff || command || files`).
- Added a "View full diff" / "View details" hint row with a chevron.
- Approve/Deny buttons keep their own `onPress`, so tapping them does **not**
  bubble up to navigation.
- Threaded `onOpen` through the memoized `FeedRow`; added `handleOpen`
  (`useCallback`) in the screen and passed it into `renderItem`.
- Added styles `reqOpenHint` / `reqOpenHintText`.

`RequestDetailScreen` already renders the full diff (`DiffViewer`), files,
command, and Approve/Deny — no change needed there beyond the typing fix below.

### A2 — Retire the dead Requests-tab plumbing
- `src/hooks/useRequests.ts`: **removed** `usePendingRequests` (8s poll) and
  `useHistory`; kept `useRequest(id)` (used by the detail screen) and
  `useDecideRequest`.
- `src/api/server.ts`: removed `fetchPendingRequests` and `fetchHistory`.
- **Deleted orphaned screens** (not registered in any navigator, no importers):
  - `src/screens/Requests/RequestsListScreen.tsx`
  - `src/screens/History/HistoryScreen.tsx` (and the now-empty `History/` dir)
  - `src/api/requests.ts` (dead re-export module; no importers)
- `src/screens/Requests/RequestDetailScreen.tsx`: retyped route/nav from
  `RequestsStackParamList` → `SessionsStackParamList` (the stack it's actually
  mounted in).
- `src/types/index.ts`: removed the now-unused `RequestsStackParamList` type.

### C1 — Focus-aware polling
**File:** `App.tsx`

- `QueryClient` defaults gained `refetchIntervalInBackground: false` and
  `refetchOnWindowFocus: false`.
- Added an `AppState` listener wiring foreground/background to React Query's
  `focusManager.setFocused(...)`, so all interval polling pauses when the app is
  backgrounded and resumes (one refetch) on foreground.

### C2 — Sessions list on Realtime
**New file:** `src/hooks/useSessionsRealtime.ts`

- Subscribes to `postgres_changes` on `agents` **and** `pending_requests`
  (filtered by `machine_id in (...)`) and invalidates `['sessions']` on any
  change. Cleans up the channel on unmount.
- **Wired in** `src/screens/Sessions/SessionsScreen.tsx`: derives the distinct
  `machine_id`s from `useSessions()` (memoized) and calls `useSessionsRealtime`.

**File:** `src/hooks/useSessions.ts` — `refetchInterval` 5s → **15s** (backstop;
Realtime is now primary).

### C3 — Relax remaining polls
- `src/hooks/useSessions.ts`: 5s → 15s (above).
- `src/screens/Machines/MachinesScreen.tsx`: harness query `refetchInterval`
  10s → **30s** (the `machine:{id}` broadcast via `useMachineChannel` is primary).
- The `['requests','pending']` 8s poll is **gone** (removed with `usePendingRequests`).

---

## Server (`vibe_remote(serverside)`)

### B3 — Leaner `/mobile/decide`
**File:** `src/routes/mobile.js`

- Collapsed the prior **SELECT agent_id → UPDATE → await syncAgentPendingCount**
  (3–4 serial round-trips) into a **single `UPDATE … .select('agent_id').single()`**,
  still guarded by `.eq('status','pending')` so a phone/PC double-decide can't flip
  twice.
- Returns **409 "Already decided or not found"** when no pending row matches
  (`PGRST116`).
- Responds `{ ok: true }` immediately, then runs
  `syncAgentPendingCount(updated.agent_id)` **fire-and-forget** (off the response
  path) so the HTTP latency that triggers Realtime is minimal.

### C2 — Publish `agents` on Realtime
**New file:** `migrations/009_realtime_agents.sql` (created in the prior step)

- `alter publication supabase_realtime add table public.agents` (guarded; no-op if
  already a member).
- `alter table public.agents replica identity full` so `machine_id`-filtered
  UPDATE/DELETE events match.
- **Required** for `useSessionsRealtime`'s `agents` listener. **Must be applied to
  the database** (it ships as a file; run it via your migration process).

### C5 — Payload trimming — DEFERRED
Not implemented. The feed comes from the `get_session_feed` RPC returning a
`payload` jsonb per row; trimming `new_content`/`old_content`/`raw_input` from the
**feed** (while keeping them in `GET /requests/:id`) requires editing that RPC and
is a larger DB change than the rest of this batch. The detail screen already loads
full rows via `useRequest(id)`, so this is a pure bandwidth optimization and safe
to do later. Tracked as the next server task.

---

## Desktop (`relay-deamon1`)

### C4a — Decision poll demoted to a backstop
**File:** `src/supabase.js`

- `waitForDecision`'s status poll `setInterval(..., 3000)` → **`25_000`**.
  Supabase Realtime remains the primary path (sub-second on a healthy socket); the
  25s poll only covers a dropped WebSocket.

### C4b — Prompt delivery: Realtime nudge + atomic claim
**File:** `scripts/heartbeat.js`

- Imported the anon `supabase` Realtime client from `../src/supabase.js`.
- Added `subscribeCommandNudge()`: subscribes to `INSERT` on `mobile_commands`
  filtered by this machine's id; each nudge calls `checkPendingCommands()`, which
  still performs the existing **server-gated, atomic** `GET /mobile/command/next`
  claim (idle-gating + mark-delivered preserved — a prompt never interrupts a tool
  sequence).
- Startup now calls `subscribeCommandNudge()` and a one-time `checkPendingCommands()`
  to drain anything already queued.
- The steady `setInterval(checkPendingCommands, 10_000)` → **`30_000`** (backstop
  only; the nudge is primary). `mobile_commands` is already in the Realtime
  publication (migration 005), so no DB change was needed here.

---

## Validation

- **Server / daemon JS:** `node --check` passes for `src/routes/mobile.js`,
  `relay-deamon1/src/supabase.js`, and `relay-deamon1/scripts/heartbeat.js`.
- **Mobile TypeScript:** `tsc --noEmit` (run with `--ignoreDeprecations 5.0` to
  work around a **pre-existing** tsconfig/tsc-version mismatch — config targets
  `"6.0"`, installed tsc is 5.3.3) reports **zero errors in any touched file**.
- Remaining errors are **pre-existing and unrelated**:
  - `__tests__/App.test.tsx` — missing `@types/jest`
  - `src/screens/Profile/ProfileScreen.tsx` — `Spacing.px14` typo
  - `src/screens/Sessions/FileBrowserScreen.tsx` — `[...new Set()]` downlevel
    iteration (same pattern the codebase already uses; our new use in
    `SessionsScreen` uses `Array.from` to avoid adding another instance)

---

## Required follow-ups before this is live

1. **Apply migration `009_realtime_agents.sql`** to the database. Until then, the
   `agents` half of `useSessionsRealtime` delivers nothing and new-session / idle
   transitions fall back to the 15s poll (the `pending_requests` half still works).
2. **Confirm the Realtime publication** also still contains `pending_requests`,
   `terminal_events`, `mobile_commands` (it does per schema.sql + migration 005) —
   the new subscriptions rely on them.
3. **Restart the desktop `heartbeat.js`** process so the nudge subscription and new
   intervals take effect.
4. **Rebuild/reload the mobile app** (App.tsx + hook changes).
5. **Optional next:** implement C5 payload trimming in `get_session_feed`.

---

## Manual test checklist (from the spec's "How to verify")

- **B2:** pending request → tap Approve → card flips to "Approved" and composer
  unlocks **immediately**; airplane-mode the socket → still instant + reconciles on
  reconnect; force a 500 → rolls back to "pending".
- **A1:** tap a card with a diff → `RequestDetail` opens with the full diff; tapping
  the Approve/Deny **buttons** does not navigate.
- **B3:** decide the same request twice fast → second call returns **409**, no
  double count mutation.
- **C1:** background the app → **zero** requests fire; foreground → refreshes.
- **C2:** start a new agent session on desktop → appears in the mobile list in ~1s
  without manual refresh (with migration 009 applied), poll at 15s.
- **C4:** approve on mobile → CLI resumes in <1s (Realtime), still resumes within
  25s if the socket is dropped; send a prompt → desktop claims it on the nudge.
- **Killed app:** new request still arrives via **FCM** (unchanged).
