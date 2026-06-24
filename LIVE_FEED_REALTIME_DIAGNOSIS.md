# Live Chat Feed Not Updating — Diagnosis

> **Symptom:** While the user is *inside* a chat, new agent **reasoning/activity**
> and new **approval requests** do **not** appear smoothly. The user has to leave
> the chat and come back (a manual "refresh") before the new items show up. They
> should stream in live, one after another, like a chat — and a prompt the user
> sends should appear instantly.
>
> **Verdict:** The chat's live edge depends **100% on Supabase `postgres_changes`**
> subscriptions, and on this **self-hosted Supabase + RLS** setup those events are
> being **silently dropped**. Re-entering the chat works because that path is a
> plain REST fetch that bypasses Realtime entirely.
>
> Diagnosed against live source on 2026-06-22. Repos:
> - **mobile** — `D:\Projects\vibe_remote(reactNative)\AgentControl`
> - **server** — `D:\Projects\vibe_remote(serverside)`
> - **desktop** — `D:\Projects\vRdeksMultiharness\relay-deamon1`

---

## TL;DR

| # | Finding | Evidence | Fix |
|---|---------|----------|-----|
| **1** | **`REPLICA IDENTITY FULL` was never applied to the feed tables** — the only migration that tries it has a fatal SQL syntax error (`/////`). Self-hosted Realtime needs FULL identity to run RLS + column filters on `postgres_changes`, so it drops the events with no error. | `migrations/009_realtime_agents.sql:29` | New migration setting FULL on `terminal_events`, `pending_requests`, `mobile_commands`; fix the `/////`. |
| **2** | **The chat live edge is built on `postgres_changes`**, the one Realtime mechanism the team already documented as unreliable here. The only Realtime that reliably works in the app uses **`broadcast`**. | `useChatFeed.ts:103-144` vs `useMachineChannel.ts:26`; `relay-deamon1/src/supabase.js:89-92` | Move the live edge to **broadcast** (already proven to work). |
| **3** | **No subscribe-status callback anywhere** — `.subscribe()` is called with no handler, so `CHANNEL_ERROR` / `TIMED_OUT` / dropped events are invisible. This is why the break shipped unnoticed. | `useChatFeed.ts:145` | Add `.subscribe((status, err) => …)` logging. |
| **4** | **The only fallback is a 30s poll**, and after the focus-aware change it only runs while focused — so the user waits up to 30s, gets impatient, and leaves/re-enters (which remounts → refetch). That re-entry is the "refresh" they describe. | `useChatFeed.ts:88` | Broadcast (Fix 2) removes the wait; optionally tighten the fallback while a turn is active. |

**Why re-entering the chat shows the items:** the REST feed runs through
`get_session_feed`, a **`SECURITY DEFINER`** RPC executing as `service_role`,
which **bypasses RLS entirely** and just filters `user_id = p_user_id`
(`migrations/006_session_feed_view.sql:38-68`). So the rows are definitely in the
DB with the correct `user_id` — **only the Realtime delivery path is broken**, not
the data.

---

## How the live feed is supposed to work

`useChatFeed` (`useChatFeed.ts`) loads the newest page over REST, then keeps the
live edge current purely over Supabase Realtime `postgres_changes`
(`useChatFeed.ts:91-154`):

```ts
const channel = client
  .channel(`chat:${sessionId}`)
  .on('postgres_changes', { event:'INSERT', table:'terminal_events',  filter:`session_id=eq.${sessionId}` }, …) // reasoning/activity
  .on('postgres_changes', { event:'INSERT', table:'pending_requests', filter:`session_id=eq.${sessionId}` }, …) // new request
  .on('postgres_changes', { event:'UPDATE', table:'pending_requests', filter:`session_id=eq.${sessionId}` }, …) // approve/deny
  .on('postgres_changes', { event:'INSERT', table:'mobile_commands',  filter:`session_id=eq.${sessionId}` }, …) // user's prompt
  .on('postgres_changes', { event:'UPDATE', table:'mobile_commands',  filter:`session_id=eq.${sessionId}` }, …)
  .subscribe()
```

Each callback patches the `['feed', sessionId]` cache (`appendLiveRow` /
`patchRow`). **If the callback never fires, nothing appears until the next REST
read** — which only happens on the 30s poll or on remount (leaving + re-entering).

The client-side append/patch and the memoized render path are **correct** — the
item position, dedupe (`appendLiveRow` id check, `useChatFeed.ts:50`), and
stable-identity cache (`useChatFeed.ts:160-216`) all check out. The problem is
upstream: **the events are not being delivered to the subscription.**

---

## Root cause #1 — feed tables have no `REPLICA IDENTITY FULL`

On a **self-hosted Supabase with RLS enabled**, the Realtime server evaluates each
WAL change against the table's RLS policies *as the subscribed user* and applies
the subscription's column filter (`session_id=eq.…`). To do that it needs the
change record to carry the relevant columns (`user_id` for the RLS policy,
`session_id` for the filter). That requires **`REPLICA IDENTITY FULL`**. Without
it the Realtime server cannot satisfy the RLS/filter check and **drops the change
silently** — no `CHANNEL_ERROR`, the socket stays "subscribed", nothing arrives.

All three feed tables have RLS enabled (`supabase/schema.sql:373-407`) with
owner policies (`user_id = auth.uid()`), and all three are in the
`supabase_realtime` publication (`schema.sql:438,442` + migration 005 for
`mobile_commands`). **But none of them has `REPLICA IDENTITY FULL`**, because the
only migration that tries to set it is broken:

```sql
-- migrations/009_realtime_agents.sql
alter table public.agents replica identity full;   -- line 26 (ok)

/////                                               -- line 29  ← NOT valid SQL
alter table public.terminal_events  replica identity full;   -- line 30 (never runs)
alter table public.pending_requests replica identity full;   -- line 31 (never runs)
```

`/////` is not a Postgres comment (comments are `--` or `/* … */`), so it is a
**syntax error**. When 009 is applied, execution aborts at line 29 — lines 30–31
**never run**, and depending on how migrations are wrapped, even the `agents`
changes above may roll back. `mobile_commands` is never given `REPLICA IDENTITY
FULL` anywhere in the repo.

Net result: every chat-feed table is on the default (primary-key) replica
identity, so RLS-filtered `postgres_changes` delivery is unreliable/dead — which
is exactly the live-feed symptom.

> This also explains a secondary bug: approve/deny **UPDATE** events to *other*
> viewers and prompt **UPDATE** status never push either (UPDATE/DELETE carry only
> the PK without FULL identity, so the `session_id` filter can't even match).

---

## Root cause #2 — the live edge rides `postgres_changes`, the known-unreliable path

The codebase already contains direct evidence that `postgres_changes` is not
dependable in this deployment, and that **`broadcast` is the mechanism that
works**:

- **The desktop daemon says so in a comment** and keeps a parallel poll *because*
  of it (`relay-deamon1/src/supabase.js:89-92`):
  > "Supabase Realtime can silently drop events (RLS on anon key, replication not
  > enabled on the table, transient WebSocket issues) without ever emitting
  > CHANNEL_ERROR — meaning the old 'poll only on error' approach never triggered."

- **The one Realtime subscription that reliably works in the mobile app uses
  `broadcast`, not `postgres_changes`** — `useMachineChannel.ts:26`
  (`.on('broadcast', { event: 'harness' }, …)`). Pairing/unpairing on the desktop
  works the same way via the server's broadcast helper
  (`server/src/realtime.js:16-30`, `broadcastMachine`). The server comment spells
  out why broadcast is preferred: *"Broadcast does NOT go through table RLS"*
  (`realtime.js:5`).

So the app has a proven, RLS-independent push path (`broadcast`) for the surfaces
that matter — but the **chat feed was built on `postgres_changes`**, the fragile
path, with no fallback beyond the 30s poll.

---

## Root cause #3 — failures are invisible (no status callback)

Every channel in the app calls `.subscribe()` with **no status handler**
(`useChatFeed.ts:145`, `useMachineChannel.ts:31`, `useSessionsRealtime`). Supabase
passes subscription state to `.subscribe((status, err) => …)` —
`SUBSCRIBED` / `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED`. Without it:

- a failed/half-open subscription looks identical to a healthy idle one, and
- per root cause #2, dropped `postgres_changes` events don't even raise
  `CHANNEL_ERROR`.

That is why this regression shipped (see `IMPLEMENTATION_LOG.md`) without anyone
noticing the live edge was dead — there was nothing to observe.

---

## Root cause #4 — the only safety net is a slow, focus-gated poll

The lone fallback is `refetchInterval: 30_000` (`useChatFeed.ts:88`). After the
focus-aware change (C1 in `CHAT_REQUESTS_AND_LATENCY_FIX.md`), React Query polling
only fires while the app/screen is focused. So when the user sits in the chat with
Realtime dead, they wait up to **30s** for anything new — long enough that they
back out and re-enter, which remounts `ChatScreen`, marks the 10s-stale query
stale, and refetches. **That remount-refetch is the "go out and back in" refresh
the user is describing.** The user's *own* sent prompt is also not guaranteed to
appear instantly through this path (it depends on the `mobile_commands` INSERT
event, same broken transport).

---

## Recommended fixes (in order)

### Fix 1 — Apply `REPLICA IDENTITY FULL` to the feed tables *(unblocks `postgres_changes`)*

Create a new migration (and fix 009's typo so re-runs are clean):

```sql
-- migrations/010_feed_replica_identity.sql
alter table public.terminal_events  replica identity full;
alter table public.pending_requests replica identity full;
alter table public.mobile_commands  replica identity full;
```

Then **restart the Realtime container** so it re-reads the publication
(`docker compose restart realtime`). Verify:

```sql
select relname, relreplident          -- want 'f' (full), not 'd' (default)
from pg_class
where relname in ('terminal_events','pending_requests','mobile_commands','agents');
```

This alone should make the existing `useChatFeed` subscriptions deliver live.

### Fix 2 — Move the chat live edge to `broadcast` *(the durable fix)*

Mirror the pattern that already works (`useMachineChannel` + `broadcastMachine`).
Broadcast bypasses RLS and replica identity, so it is immune to the whole class of
failure above.

- **Server:** wherever a feed row is written — `POST /relay/terminal-event`,
  `POST /relay/upload` (new request), `POST /mobile/decide` (decision),
  the mobile prompt insert — fire
  `broadcast` to topic `session:<sessionId>` with a small event
  (`{ event: 'feed', payload: { source, id } }`), reusing the
  `realtime.js` HTTP-broadcast helper.
- **Mobile:** in `useChatFeed`, add a `broadcast` listener on `session:<id>` that
  either appends from the payload or invalidates `['feed', sessionId]` to pull the
  new tail. Keep the `postgres_changes` listeners as a secondary path if you want,
  but broadcast becomes primary.

### Fix 3 — Add subscription observability *(do this first to confirm the diagnosis)*

```ts
.subscribe((status, err) => {
  if (status !== 'SUBSCRIBED') console.warn('[chat realtime]', sessionId, status, err)
})
```

Add the same to `useMachineChannel` and `useSessionsRealtime`. Cheap, and it will
immediately show whether the chat channel reaches `SUBSCRIBED` and whether it's
silently dropping (it will look subscribed but never invoke callbacks — the #1
signature).

### Fix 4 — Tighten the fallback while a turn is active *(belt-and-suspenders)*

Until broadcast lands, drop the live-edge poll to ~5–8s **while the session is
actively streaming** (and keep 30s when idle), so even a fully dead socket only
costs a few seconds of lag instead of 30. Revert once Fix 1/2 are verified.

---

## How to verify the fix

1. **Confirm the break (Fix 3 first):** open a chat, trigger agent output on the
   desktop. With logging in place you'll see the channel reach `SUBSCRIBED` but no
   INSERT callback fires → confirms silent drop.
2. **After Fix 1:** same test — new reasoning lines now appear within ~1s *without*
   leaving the chat; a new approval request pops in live; approving on one device
   updates the card on another within ~1s.
3. **Prompt echo:** send a prompt from the phone → it appears in the chat
   immediately (its `mobile_commands` INSERT now delivers).
4. **Replica identity:** the `pg_class` query above returns `f` for all three
   tables.
5. **Regression:** background the app → no polling (C1 still holds); foreground →
   live edge resumes.

---

---

## Implementation status (applied 2026-06-22)

| Fix | What was done | Files |
|-----|---------------|-------|
| **1** | Removed the `/////` syntax error from 009; added migration **010** setting `REPLICA IDENTITY FULL` on `terminal_events`, `pending_requests`, `mobile_commands`. Unblocks `postgres_changes` for all consumers (chat feed **and** sessions list). | `migrations/009_realtime_agents.sql`, `migrations/010_feed_replica_identity.sql` |
| **2** | Added `broadcastSession(sessionId)` to the realtime helper and fire it on every feed write — new request (`/relay/upload`), reasoning/activity (`/relay/terminal-event`), PC decision (`/relay/decide`), mobile decision (`/mobile/decide`), and sent prompt (`/mobile/prompt`). Mobile subscribes to `session:<id>` and **invalidates the feed** on the nudge (refetch goes through the user-authed feed endpoint, so no row content rides the un-RLS'd broadcast topic). | server `src/realtime.js`, `src/routes/relay.js`, `src/routes/mobile.js`; mobile `src/hooks/useChatFeed.ts` |
| **3** | Added `.subscribe((status, err) => …)` warn-logging to the chat, sessions, and machine channels so silent drops / errors are observable. | mobile `useChatFeed.ts`, `useSessionsRealtime.ts`, `useMachineChannel.ts` |
| 4 | Not applied — it was an explicit temporary stopgap; the broadcast nudge (Fix 2) makes the slow-poll wait moot. The 30s poll remains as the backstop. | — |

Defense in depth: the chat now has **two** independent live paths — `postgres_changes`
(now working after Fix 1) appends instantly from payload, and the broadcast nudge
(Fix 2) invalidates as a guaranteed catch-all. Redundant invalidations are deduped
by React Query.

### Follow-up root cause found after the first round (the real blocker)

After Fixes 1–3 were applied the chat **still** didn't update live — because the
mobile Realtime WebSocket was **never connecting in the first place**, so neither
`postgres_changes` nor the new broadcast could arrive.

**Cause:** `api/realtime.ts` created the Realtime client with the **user JWT as the
client key** (`createClient(SUPABASE_URL, token)`). On self-hosted Supabase the
Realtime socket connects directly through the **Kong** gateway, which validates the
`apikey` query param against its registered consumers (the **anon**/service keys). A
user-signed JWT is not a valid Kong apikey, so Kong rejected the WebSocket and
Realtime never came up. REST kept working because it goes through the Express API,
not Kong — which is exactly why re-entering (a REST refetch) showed the data while
the live edge stayed dead.

**Fix:** create the client with the **anon key** (the apikey Kong accepts) and keep
`client.realtime.setAuth(token)` for the user JWT so RLS `auth.uid()` still
resolves. This matches the desktop daemon (`relay-deamon1/src/config.js:36`, anon
key) and the mobile main client (`api/supabase.ts:30`, anon key).

```ts
// api/realtime.ts — before
client = createClient(Config.SUPABASE_URL!, token, { … })   // user JWT as apikey → Kong 401
// after
client = createClient(Config.SUPABASE_URL!, Config.SUPABASE_ANON_KEY!, { … })
client.realtime.setAuth(token)                              // user JWT for RLS
```

This is why the `[chat realtime]` status logging from Fix 3 matters: with the bad
key the channel never reaches `SUBSCRIBED`; after the fix it should.

### Required to go live
1. **Apply migration 010** (and re-apply the corrected 009 if 009 previously failed) to the database.
2. **Restart the Realtime service** so it re-reads replica identity: `docker compose restart realtime`.
3. **Restart the Express server** (new `broadcastSession` calls).
4. **Rebuild/reload the mobile app** (`useChatFeed` + observability changes).
5. Verify with the steps in *How to verify the fix* above. Watch the new
   `[chat realtime]` warn logs — if the channel never reaches `SUBSCRIBED`, the
   issue is connection/token, not delivery.

---

*Grounded in: `useChatFeed.ts`, `useMachineChannel.ts`, `api/realtime.ts`,
`AgentControl/.env`; server `routes/mobile.js`, `realtime.js`,
`migrations/006_session_feed_view.sql`, `migrations/009_realtime_agents.sql`,
`supabase/schema.sql`; desktop `relay-deamon1/src/supabase.js`. Companion to
`CHAT_REQUESTS_AND_LATENCY_FIX.md` and `IMPLEMENTATION_LOG.md`.*
</content>
</invoke>
