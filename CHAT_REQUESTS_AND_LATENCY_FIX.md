# Chat-Embedded Requests & Decision-Latency Fix

> Two issues, fully diagnosed against the live source, with concrete fixes and a
> scaling plan for growth.
>
> 1. **Requests-in-chat migration** — approval requests now live inside the
>    session chat (not a separate Requests tab); tapping a card should open a
>    detail screen showing the full diff.
> 2. **Slow approve/deny** — after the user taps Allow/Deny, the card takes
>    seconds to reflect the decision. Root cause found; surgical fix below.
> 3. **Scaling: replace polling with push** — fixed-interval polling is the cost
>    wall as the userbase grows. Per the decision in
>    `REALTIME_TRANSPORT_DECISION.md`, **we go with Option A: Supabase Realtime
>    as the single push transport** for server→client and server→desktop
>    delivery, REST for client→server actions, and one slow poll only as a
>    reconnect backstop. **No custom WebSocket server.** Part C below is the
>    concrete, implementation-ready version of that decision.
>
> This document is the **implementation source of truth**. The ADR
> (`REALTIME_TRANSPORT_DECISION.md`) holds the rationale and the options that were
> rejected; everything you actually build is specified here.
>
> Files referenced are in `D:\Projects\vibe_remote(reactNative)\AgentControl` (mobile)
> and `D:\Projects\vibe_remote(serverside)` (server). The desktop relay daemon is
> in `D:\Projects\vRdeksMultiharness\relay-deamon1`.

---

## TL;DR

| # | Problem | Root cause | Fix | Effort |
|---|---------|-----------|-----|--------|
| A1 | Can't open a request's diff from the chat | The chat `RequestCard` has no `onPress` → no navigation to `RequestDetail` | Wrap the card in a tappable, navigate to the already-registered `RequestDetail` screen | ~15 min |
| A2 | Leftover Requests-tab plumbing still polling | `usePendingRequests` (8s) / `useHistory` no longer drive the UI | Remove/retire the dead queries; badge already uses `sessions.pending_count` | ~20 min |
| **B1** | **Approve/Deny is slow to show** | **`useDecideRequest` patches `['requests','pending']`, but the chat reads `['feed', sessionId]` — so the card waits for the Supabase Realtime round-trip** | **Optimistically patch the `['feed', …]` cache in `onMutate`** | **~30 min** |
| B2 | Real propagation slower than it needs to be at scale | `decide` route does 4 serial DB calls; pending-count synced in app code | Collapse to one `UPDATE … RETURNING`; move count to a trigger | ~1 hr |
| **C** | **Cost/latency grows linearly with users** | **Every client polls on fixed timers regardless of focus/activity (~29 req/min/client of pure idle polling)** | **Option A — move all server→client/desktop delivery to Supabase Realtime; demote remaining polls to a 30–60s backstop, paused when backgrounded** | ~3–4 hr |

---

## Part A — Requests live inside the chat

### A0. What already works (no change needed)

The migration is mostly complete:

- The unified feed (`useChatFeed.ts`) already merges `pending_requests` into the
  chat stream as `kind: 'request'` items (`useChatFeed.ts:191-194`).
- `ChatScreen` already renders an inline `RequestCard` with **Approve/Deny**
  buttons while `status === 'pending'`, and shows an "Approved/Denied" badge once
  decided (`ChatScreen.tsx:118-187, 247-253`).
- `RequestDetailScreen` (full diff, files, command, risk) already exists and is
  **already registered in the Sessions stack** (`RootNavigator.tsx:119`,
  param type `SessionsStackParamList.RequestDetail: { id: string }` at
  `types/index.ts:232`).

So the detail screen is reachable by the navigator — there is just nothing in the
chat that navigates to it yet.

### A1. Make the chat request card open the detail/diff screen

**Goal:** Approve/Deny stays inline on the card (fast path). Tapping the card body
(or an explicit "View diff" affordance) opens `RequestDetail`, where the user can
read the full diff freely.

**Change 1 — `ChatScreen.tsx`, the `RequestCard` component.** Make the card body
tappable and add an `onOpen` prop. Keep the Approve/Deny buttons as-is so a tap on
them does *not* also trigger navigation.

```tsx
// ChatScreen.tsx
function RequestCard({ req, onApprove, onDeny, onOpen }: {
  req:       PendingRequest
  onApprove: () => void
  onDeny:    () => void
  onOpen:    () => void
}) {
  const riskCfg  = Colors.risk[req.risk_level] ?? Colors.risk.low
  // …unchanged…
  const isPending  = req.status === 'pending'
  const isApproved = req.status === 'approved'
  // A request is "inspectable" if it carries a diff or a command worth opening.
  const canInspect = !!req.diff || !!req.command || (req.files_affected?.length ?? 0) > 0

  return (
    <TouchableOpacity
      activeOpacity={canInspect ? 0.85 : 1}
      onPress={canInspect ? onOpen : undefined}
      style={[styles.reqCard, { borderLeftColor: riskCfg.dot }]}
    >
      {/* …existing header / summary / command block unchanged… */}

      {/* Hint that the card is tappable for the full diff */}
      {canInspect && (
        <View style={styles.reqOpenHint}>
          <Ionicons name="document-text-outline" size={12} color={Colors.textTertiary} />
          <Text style={styles.reqOpenHintText}>
            {req.diff ? 'View full diff' : 'View details'}
          </Text>
          <Ionicons name="chevron-forward" size={12} color={Colors.textTertiary} />
        </View>
      )}

      {/* Action buttons (only while pending) — keep their own onPress so a tap
          here does not bubble up to the card's onPress. */}
      {isPending && (
        <View style={styles.reqActions}>
          <TouchableOpacity style={styles.denyBtn}    onPress={onDeny}    activeOpacity={0.8}>…</TouchableOpacity>
          <TouchableOpacity style={styles.approveBtn} onPress={onApprove} activeOpacity={0.8}>…</TouchableOpacity>
        </View>
      )}

      <Text style={styles.reqTime}>…</Text>
    </TouchableOpacity>
  )
}
```

> Note: nested `TouchableOpacity` for the buttons already stops the press from
> reaching the parent on both iOS and Android, so Approve/Deny won't accidentally
> navigate.

**Change 2 — the memoized `FeedRow`** (`ChatScreen.tsx:237-254`): thread an
`onOpen` callback through, same pattern as `onApprove`/`onDeny`.

```tsx
const FeedRow = React.memo(function FeedRow({ item, onApprove, onDeny, onOpen }: {
  item:      ChatItem
  onApprove: (id: string) => void
  onDeny:    (id: string) => void
  onOpen:    (id: string) => void
}) {
  // …unchanged kinds…
  return (
    <RequestCard
      req={item.req}
      onApprove={() => onApprove(item.req.id)}
      onDeny={()    => onDeny(item.req.id)}
      onOpen={()    => onOpen(item.req.id)}
    />
  )
})
```

**Change 3 — `ChatScreen` body:** add the navigation handler and pass it down.

```tsx
const handleOpen = useCallback(
  (id: string) => navigation.navigate('RequestDetail', { id }),
  [navigation],
)

// in renderItem:
renderItem={({ item }) => (
  <FeedRow item={item} onApprove={handleApprove} onDeny={handleDeny} onOpen={handleOpen} />
)}
```

**Change 4 — styles** (add to the `StyleSheet`):

```tsx
reqOpenHint: {
  flexDirection: 'row', alignItems: 'center', gap: 4,
  marginTop: 2,
},
reqOpenHintText: {
  flex: 1, fontSize: FontSize.metadata, color: Colors.textTertiary, fontWeight: '500',
},
```

That's the whole "tap a card → see the diff" flow. `RequestDetailScreen` already
renders the diff via `DiffViewer` and even offers Approve/Deny from there
(`RequestDetailScreen.tsx:166-174, 204-226`).

**Optional polish — fix the detail screen's nav typing.** `RequestDetailScreen`
is mounted inside `SessionsStack` but types its route/nav as
`RequestsStackParamList` (`RequestDetailScreen.tsx:18-21`). It works at runtime
(both stacks declare `RequestDetail: { id: string }`), but switch it to
`SessionsStackParamList` for correctness and so a future `navigation.navigate`
from that screen is type-checked against the right stack.

### A2. Retire the old Requests-tab plumbing

The badge on the Chats tab already comes from sessions, not the old list
(`RootNavigator.tsx:130`: `sessions.filter(s => s.pending_count > 0)`), so the
old pending-requests query is now dead weight that still polls every 8s.

- `usePendingRequests()` (`useRequests.ts:11-18`) — **8s poll**. If nothing
  renders it anymore, delete it (and `fetchPendingRequests` in `server.ts:108`).
- `useHistory()` (`useRequests.ts:31-37`) — keep only if a History screen still
  uses it; otherwise remove.
- Keep `useRequest(id)` — `RequestDetailScreen` depends on it
  (`RequestDetailScreen.tsx:30`).

> Grep `usePendingRequests` / `useHistory` across `src/` before deleting to
> confirm nothing else imports them.

---

## Part B — Fix the slow approve/deny (the main issue)

### B1. Root cause (confirmed in source)

When the user taps Allow/Deny in the chat, `ChatScreen` calls
`useDecideRequest()` (`ChatScreen.tsx:264, 331-332`). That mutation's optimistic
update only touches the **pending-list** cache:

```ts
// useRequests.ts:50-58  — the bug
onMutate: async ({ id }) => {
  await queryClient.cancelQueries({ queryKey: ['requests', 'pending'] })
  const previous = queryClient.getQueryData<PendingRequest[]>(['requests', 'pending'])
  queryClient.setQueryData<PendingRequest[]>(
    ['requests', 'pending'],
    (prev = []) => prev.filter(r => r.id !== id),   // ← only the OLD tab's cache
  )
  return { previous }
},
```

But the chat does **not** read `['requests','pending']`. It reads the infinite
feed cache `['feed', sessionId]` (`useChatFeed.ts:37,81-89`), and the card's
status comes from `item.req.status`. Nothing patches the feed on mutate.

So the sequence today is:

```
tap Allow
  → POST /mobile/decide                     (network write)
  → server UPDATE pending_requests          (DB commit)
  → Supabase WAL → Realtime broadcast        (replication + fan-out)
  → device receives UPDATE
  → useChatFeed patchRow() runs              (useChatFeed.ts:121-127)
  → NOW the card flips to "Approved"
```

The card only changes after that **full round-trip** — typically 1–4s, and on a
slow/reconnecting Realtime socket it can fall back to the 30s feed poll. That is
exactly the "shows it later" symptom.

### B2. The fix — optimistically patch the feed cache

Patch the `['feed', …]` cache the instant the button is tapped, with the same
shape the Realtime handler would later apply. The later Realtime UPDATE then
becomes a no-op (idempotent), so there's no flicker or double-render.

This also unlocks the composer immediately: `pendingCount` is derived from the
feed (`ChatScreen.tsx:325`), so as soon as the row flips to `approved`, the
"approvals pending" note disappears and the input returns — no wait.

**Rewrite `useDecideRequest`** (`useRequests.ts`):

```ts
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { decideRequest } from '../api/server'
import type { PendingRequest, FeedPage } from '../types'

// Patch a request row wherever it lives across all cached feed pages.
// Mirrors patchRow() in useChatFeed so optimistic + Realtime converge.
function patchPendingInFeeds(
  data: InfiniteData<FeedPage> | undefined,
  id: string,
  patch: Partial<PendingRequest>,
): InfiniteData<FeedPage> | undefined {
  if (!data) return data
  return {
    ...data,
    pages: data.pages.map(p => ({
      ...p,
      items: p.items.map(i =>
        i.id === id ? { ...i, row: { ...i.row, ...patch } } : i,
      ),
    })),
  }
}

export function useDecideRequest() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'denied' }) =>
      decideRequest(id, decision),

    onMutate: async ({ id, decision }) => {
      // Stop in-flight refetches from clobbering the optimistic write.
      await qc.cancelQueries({ queryKey: ['feed'] })
      await qc.cancelQueries({ queryKey: ['requests', 'pending'] })

      const patch: Partial<PendingRequest> = {
        status:     decision,
        decided_by: 'mobile',
        decided_at: new Date().toISOString(),
      }

      // Snapshot every feed cache + the pending list for rollback.
      const prevFeeds   = qc.getQueriesData<InfiniteData<FeedPage>>({ queryKey: ['feed'] })
      const prevPending = qc.getQueryData<PendingRequest[]>(['requests', 'pending'])

      // 1) THE FIX: flip the card in the chat instantly.
      qc.setQueriesData<InfiniteData<FeedPage>>(
        { queryKey: ['feed'] },
        old => patchPendingInFeeds(old, id, patch),
      )

      // 2) Keep the legacy pending list consistent (harmless if unused).
      qc.setQueryData<PendingRequest[]>(['requests', 'pending'], (prev = []) =>
        prev.filter(r => r.id !== id),
      )

      // 3) Patch a possibly-open detail screen too.
      qc.setQueryData<PendingRequest>(['requests', id], old =>
        old ? { ...old, ...patch } : old,
      )

      return { prevFeeds, prevPending, id }
    },

    onError: (_err, _vars, ctx) => {
      // Roll everything back on failure.
      ctx?.prevFeeds?.forEach(([key, data]) => qc.setQueryData(key, data))
      if (ctx?.prevPending) qc.setQueryData(['requests', 'pending'], ctx.prevPending)
    },

    onSettled: (_d, _e, vars) => {
      // Reconcile with the server (Realtime usually already matches).
      qc.invalidateQueries({ queryKey: ['requests', 'history'] })
      qc.invalidateQueries({ queryKey: ['requests', vars.id] })
    },
  })
}
```

**Why this is safe with Realtime:**
`appendLiveRow`/`patchRow` already dedupe by `id` and the feed's item cache is
keyed by a signature that includes `req.status` (`useChatFeed.ts:193`). When the
Realtime UPDATE arrives carrying the same `status`, the signature is unchanged →
the memoized `ChatItem` is reused → React skips the re-render. Optimistic and
authoritative states converge with zero visible churn.

**Result:** the card flips to Approved/Denied and the composer unlocks the moment
the user taps — 0ms perceived latency — while the server write and Realtime
continue in the background and reconcile.

### B3. (Recommended) Speed up the *real* propagation for the desktop/CLI

The optimistic patch fixes what the *acting user* sees. The desktop hook
(`relay-deamon1/hook.js`) that's blocking the CLI still learns of the decision via
Supabase Realtime (fast path) or its 3s status poll (fallback) — that part is
already fine. But the `decide` endpoint can be made leaner so the DB write that
triggers Realtime happens sooner and costs less under load.

**Current `decide` route does 4 serial round-trips** (`mobile.js:257-299`):
1. `pairedMachineIds` (in-process cached — fine)
2. `SELECT agent_id` from the request
3. `UPDATE pending_requests`
4. `syncAgentPendingCount` → `COUNT(*)` + `UPDATE agents`

**Collapse 2 + 3 into one `UPDATE … RETURNING`:**

```js
// mobile.js — POST /mobile/decide
const { data: updated, error } = await db
  .from('pending_requests')
  .update({ status: decision, decided_at: new Date().toISOString(), decided_by: 'mobile' })
  .eq('id', requestId)
  .in('machine_id', ids)
  .eq('status', 'pending')          // also prevents double-decide / races
  .select('agent_id')
  .single()

if (error) { /* 500 */ }
if (!updated) return res.status(409).json({ error: 'Already decided or not found' })

// Respond immediately; keep the count sync off the critical path.
res.json({ ok: true })
syncAgentPendingCount(updated.agent_id).catch(() => {})   // fire-and-forget
```

Two wins: one fewer round-trip before the row is written (so Realtime fires
sooner), and the pending-count maintenance no longer delays the HTTP response.

**Optional (best at scale):** make `agents.pending_count` a database trigger on
`pending_requests` INSERT/UPDATE/DELETE, and delete `syncAgentPendingCount` from
the app entirely. The count then stays correct without any app round-trips on
every decide and every upload.

---

## Part C — Replace polling with Supabase Realtime (Option A)

**Decision (from `REALTIME_TRANSPORT_DECISION.md`): Option A.** Use Supabase
Realtime — the WebSocket transport we *already* run for the chat feed — as the
single push channel for everything server→client and server→desktop. Keep REST for
client→server actions. Keep one slow poll (30–60s) only as a reconnect backstop.
**Do not build a custom WebSocket server.**

Why this and not a new WS server: Supabase Realtime already solves Postgres
change fan-out, per-row auth via RLS, JWT auth (`POST /mobile/realtime-token`,
12h HS256), reconnection, and horizontal scaling. We extend what's proven in the
chat feed to the surfaces still on polls.

### Why it matters (the cost wall)

Polling cost is independent of activity. Per active mobile client today:

```
sessions  5s → 12/min   pending  8s → 7.5/min   harness 10s → 6/min
feed     30s →  2/min   machines 45s → 1.3/min
                         ≈ 29 requests/min/client of pure idle polling
```

At 1,000 concurrent clients ≈ 480 req/s hitting the DB before any real event; at
10,000 ≈ 4,800 req/s of nothing. Realtime makes idle cost ≈ a held socket; work
happens only on actual change.

### Target transport per flow

| Flow | Direction | Transport |
|------|-----------|-----------|
| New approval request (live) | server→mobile | **Realtime** `postgres_changes` (already) |
| New request while app **killed** | server→mobile | **FCM push** (unchanged — Realtime can't wake a killed app) |
| Decision → other mobile viewers | server→mobile | **Realtime** (already) |
| Decision → desktop relay | server→desktop | **Realtime** nudge + 25s backstop (replaces 3s poll) |
| Narrative / terminal events | server→mobile | **Realtime** (already) |
| Prompt available to deliver | server→desktop | **Realtime nudge → atomic claim** (replaces steady `command/next` poll) |
| Sessions-list changes | server→mobile | **Realtime** → invalidate `['sessions']` (NEW) |
| Harness toggle state | server→mobile | **Realtime** `machine:{id}` broadcast (already) + slow poll |
| Approve / Deny / Prompt / FS / Pair | mobile→server | **REST** (unchanged; + optimistic cache from Part B) |

Principle: **push for fan-out (server→many), request/response for commands.**
Don't force user actions through a socket.

### C1. Make polling focus-aware (global, do this first)

React Query fires its interval even when the screen is blurred or the app is
backgrounded. Stop that.

```ts
// App-level QueryClient (where the app creates its client)
new QueryClient({
  defaultOptions: {
    queries: {
      refetchIntervalInBackground: false,   // no polling when app is backgrounded
      refetchOnWindowFocus:        false,
      staleTime:                   5_000,
    },
  },
})
```

Wire React Query's `focusManager` to RN `AppState` once, near app startup:

```ts
import { AppState, type AppStateStatus } from 'react-native'
import { focusManager } from '@tanstack/react-query'

AppState.addEventListener('change', (s: AppStateStatus) =>
  focusManager.setFocused(s === 'active'),
)
```

This alone removes most idle traffic and lets Realtime carry the live edge.

### C2. Move the sessions list onto Realtime, then relax its poll

Today only the open chat subscribes to Realtime; the sessions list leans on the 5s
poll for new pending counts. Add a per-device channel that invalidates
`['sessions']` on relevant changes, then raise the poll to a backstop.

```ts
// hooks/useSessionsRealtime.ts
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getRealtimeClient } from '../api/realtime'

export function useSessionsRealtime(machineIds: string[]) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!machineIds.length) return
    let unsub: (() => void) | null = null
    ;(async () => {
      const client = await getRealtimeClient()
      if (!client) return
      const inList = `machine_id=in.(${machineIds.join(',')})`
      const bump   = () => qc.invalidateQueries({ queryKey: ['sessions'] })
      const channel = client.channel('sessions')
        // pending_count / activity changes ride on these two tables
        .on('postgres_changes', { event: '*', schema: 'public', table: 'agents',           filter: inList }, bump)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_requests', filter: inList }, bump)
        .subscribe()
      unsub = () => { try { channel.unsubscribe() } catch {} }
    })()
    return () => { if (unsub) unsub() }
  }, [machineIds.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
}
```

Call it once where the sessions list lives (e.g. `SessionsScreen`), passing the
distinct `machine_id`s from `useSessions()`. Then in `useSessions`:

```ts
refetchInterval: 15_000,            // was 5_000 — backstop only now
refetchIntervalInBackground: false,
```

> ⚠️ **Prerequisite:** the `agents` table must be in the `supabase_realtime`
> publication or the `agents` listener above delivers nothing (new sessions /
> idle transitions would lag to the 15s poll). It is **not** published today —
> apply migration `009_realtime_agents.sql` first. See C5.

> Invalidate (not patch) here on purpose: the sessions list is small and the query
> is its own source of truth, so a cheap refetch on change is simpler than
> reconstructing rows. The **chat feed** stays patch-from-payload (already done)
> because terminal events are high-volume and a refetch per event would be wasteful.

### C3. Relax the remaining mobile polls

| Query | Now | Target | Why it's safe |
|-------|-----|--------|---------------|
| `['sessions']` | 5s | **15s** + Realtime (C2) | Realtime carries changes; poll is a backstop |
| `['feed', id]` | 30s (`useChatFeed.ts:88`) | **keep 30s** | Already Realtime-primary |
| `['requests','pending']` | 8s | **remove** | Dead in the chat-centric model (Part A2) |
| `['harnesses', id]` | 10s | **30s** + Realtime | `machine:{id}` broadcast already exists (`useMachineChannel`) |
| `['machines']` | 30–60s | **keep** | Already low-frequency |

### C4. Desktop relay — retire its two polls

The daemon in `relay-deamon1` already holds a Supabase Realtime client. Use it as
the primary signal and demote the polls to backstops.

**C4a — decision status (`GET /relay/status/{id}`, currently every 3s).**
`hook.js` already races Realtime vs. polling for the decision. Keep Realtime
primary and drop the poll to a single **25s backstop** (covers a dropped socket).
On a healthy socket the decision lands in <1s, so the CLI resumes immediately.

**C4b — prompt delivery (steady `GET /mobile/command/next`).** Replace steady
polling with a **nudge + atomic claim**:

1. Server inserts the `mobile_commands` row (already).
2. Daemon receives a Realtime nudge — `postgres_changes` INSERT on
   `mobile_commands` filtered by its `machine_id` (or a `machine:{id}` broadcast
   `command_available`).
3. **Only on a nudge** the daemon calls `GET /mobile/command/next`, which keeps the
   existing **server-side idle-gating + atomic "mark delivered"** semantics (so a
   prompt never interrupts a tool sequence). The HTTP claim stays; the steady
   polling disappears.

This preserves the one piece of real logic (idle-gated atomic claim) while
removing the constant request stream.

### C5. Server / DB hygiene that makes Realtime cheaper

- **Publish `agents` on Realtime — REQUIRED for C2 (confirmed gap).** The
  `supabase_realtime` publication currently contains **`machines`,
  `pending_requests`, `terminal_events`, `mobile_commands`** (schema.sql:434/438/442
  + migration 005). **`agents` is NOT published.** Until it is, the C2 subscription
  only fires on its `pending_requests` half — new approvals/decisions refresh
  `pending_count`, but a **new session (INSERT into `agents`)** and **status
  transitions** (`last_activity_at` / `cli_alive` UPDATEs) won't push, so they lag
  to the 15s backstop. Apply **migration `009_realtime_agents.sql`** (adds `agents`
  to the publication + `REPLICA IDENTITY FULL` so `machine_id`-filtered UPDATE/DELETE
  events match) before raising the sessions poll.
- The desktop command nudge (C4b) subscribes to `mobile_commands` INSERT — that
  table **is** already published (migration 005), so no migration is needed there.
- **Confirm the feed indexes exist** (migrations 005/006):
  `pending_requests(session_id, created_at desc)`,
  `mobile_commands(session_id, created_at desc)`,
  `terminal_events(session_id, created_at desc)`.
- **Trim heavy feed payloads.** Feed/request rows carry `raw_input`,
  `new_content`, `old_content`, and full `diff`. For the **feed** response, send
  only `diff` (+ a `has_more_detail` flag) and omit
  `new_content`/`old_content`/`raw_input`; load the heavy fields only in
  `GET /requests/:id` (the detail screen — Part A). Smaller pages = faster scroll
  and less Realtime/bandwidth payload at scale.
- `pairedMachineIds` is cached 60s in-process (`mobile.js:24-37`); per-instance on
  a multi-instance deploy — fine, already busted on pair/unpair via
  `bustPairCache`.

### C6. Connection economics & the escape hatch

Each open chat opens **one** `chat:{sessionId}` channel with five
`postgres_changes` listeners (`useChatFeed.ts:100-145`) — keep it one channel per
session (already the case) and unsubscribe on unmount (already in the cleanup;
confirm the screen actually unmounts vs. staying alive under the stack).

Stay on Option A until Supabase Realtime quotas (concurrent connections /
messages-per-second) become the binding limit. Escalation ladder **before** ever
building a custom WS server:

> tune polls → `postgres_changes` → **`broadcast`** (server emits an explicit
> event instead of per-row CDC) → self-hosted Realtime / SSE → custom WS

We are at the `postgres_changes` step; moving the hottest path to `broadcast` is
the cheap next lever if fan-out latency degrades. The optimistic-update fix (Part
B) already removes Realtime from the *acting* device's critical path, leaving
Realtime mainly for other viewers and the desktop.

---

## Implementation order

Each step is independently shippable and reversible (revert to the prior interval
or cache behavior).

1. **B2 — optimistic feed patch** (`useRequests.ts`). Biggest perceived win,
   lowest risk, no backend change. Ship first.
2. **A1 — tappable card → `RequestDetail`** (`ChatScreen.tsx`). Completes the
   chat-centric UX.
3. **A2 — remove dead pending-requests polling.** Cleanup + small load win.
4. **B3 — `UPDATE … RETURNING` + fire-and-forget count** (`mobile.js`). Cheaper,
   faster propagation.
5. **C1 — focus-aware `QueryClient` + `focusManager`/`AppState`.** Immediate
   idle-load win, zero behavioral risk.
6. **C2 — apply migration `009_realtime_agents.sql` FIRST** (publishes `agents` —
   confirmed missing from the publication), then add `useSessionsRealtime` and move
   the sessions poll 5s→15s. Skipping the migration silently breaks live
   new-session / idle updates (C5).
7. **C3 — relax harness poll (10s→30s); remove `['requests','pending']`.**
8. **C4 — desktop relay: decision poll 3s→25s backstop, then command nudge +
   atomic claim** (`relay-deamon1`).
9. **C5 — verify publication/indexes; trim heavy feed payloads** (`mobile.js`).
10. **Load-test** at target concurrency; watch Supabase Realtime connection +
    message metrics. If they approach quota, migrate the hottest
    `postgres_changes` path to `broadcast` (C6) — **before** considering a custom
    WS server.

---

## How to verify

- **B2:** Open a chat with a pending request. Tap Approve. The card must flip to
  "Approved" and the composer must unlock **immediately** (no spinner wait).
  Kill Realtime (airplane-mode the socket briefly) and confirm the card still
  flips instantly and reconciles on reconnect. Force the mutation to 500 and
  confirm it rolls back to "pending".
- **A1:** Tap a request card with a diff → `RequestDetail` opens with the full
  diff. Tap Approve/Deny on the *buttons* → no navigation occurs.
- **B3:** Decide the same request twice quickly → second call returns 409
  (`status='pending'` guard), no double count mutation.
- **C1 (idle load):** Foreground with nothing happening → network is quiet (only
  socket keepalives). Background the app → **zero** requests fire.
- **C2 (liveness):** Start a new agent session on the desktop → it appears in the
  mobile sessions list within ~1s **without** a manual refresh, even with the poll
  at 15s.
- **C2/C3 (cross-device):** Two phones on the same session — decide on one → the
  other updates via Realtime within ~1s.
- **C4 (desktop):** Approve on mobile → CLI resumes in <1s with the 3s poll
  disabled (Realtime path); still resumes within the 25s backstop if the socket is
  forcibly dropped. Send a prompt → desktop claims it on the nudge, not on a timer.
- **Killed app:** approval request still arrives via **FCM** (Realtime does not
  replace push).

---

*Diagnosis grounded in: `useRequests.ts`, `useChatFeed.ts`, `ChatScreen.tsx`,
`RequestDetailScreen.tsx`, `RootNavigator.tsx`, `types/index.ts`,
`api/server.ts`, `api/realtime.ts`, server `routes/mobile.js`, `realtime.js`, and
the `relay-deamon1` decision/command loops. Transport decision recorded in
`REALTIME_TRANSPORT_DECISION.md` (Option A). Generated 2026-06-20.*
