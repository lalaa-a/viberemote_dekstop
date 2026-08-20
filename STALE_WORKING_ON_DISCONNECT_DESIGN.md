# Mobile stuck on "working" after the desktop disconnects mid-turn — Solutions

## 1. The problem

1. A turn is running in the CLI (harness working, mobile shows the spinner + Stop).
2. The desktop's connection to the server is cut **mid-turn** — network drops, the app /
   heartbeat is killed, or mobile support is toggled off. The CLI keeps running.
3. The turn later **finishes** in the CLI.
4. The phone **still shows "working"** — forever.

The mobile never learns the turn ended, because the turn-end signal it relies on was produced
(or would have been produced) at a moment when the desktop couldn't reach the server.

---

## 2. Root cause

There are two independent "is the turn live?" signals, and the disconnect defeats the way the
mobile combines them.

### Signal A — the explicit `stop` event (the definitive one)

Turn-end posts a `stop` terminal-event (Claude Stop hook / `hook.js` / `postHook.js`;
OpenCode `session.idle`; or the heartbeat). The server backdates `last_activity_at` and the
mobile feed shows a `stop` boundary → not working.

**Why it's lost on disconnect:** the `stop` event is a single fire-and-forget HTTPS POST with
**no retry**. If the network is down (or the poster is gone / mobile mode was disabled) at the
instant the turn ends, that POST fails and is never resent. The stop is gone for good.

### Signal B — `deriveStatus(last_activity_at)` (the decay backstop) — *this already works*

The server derives status purely from recency (`src/utils.js`):

```
< 30s   → active
< 10min → idle
else    → finished
```

`last_activity_at` is kept fresh **only while the desktop is connected** (the heartbeat
keepalive `agentTouch`, tool-call pings, transcript-tailer touches). When the desktop
disconnects, **all of those stop**, so `last_activity_at` goes stale and the server correctly
derives `idle` within **30s**. The machine also goes offline within **90s**
(`ONLINE_THRESHOLD_MS`, heartbeat interval 30s).

**So the server figures it out.** The bug is that the mobile ignores it.

### The actual bug — the feed override (`ChatScreen.tsx`)

```ts
const feedActive = feedTurn === 'ended' ? false : (feedTurn === 'active' || isActive)
```

`feedTurn` walks the feed to the last lifecycle boundary. With no `stop` event, the last
boundary is an `activity`/`sent`/pending-request → `feedTurn === 'active'`. That term **forces
`feedActive` true regardless of `isActive`**. So even after the server has decayed the session
to `idle` and marked the machine offline, the phone keeps showing "working" because the feed's
dangling `'active'` boundary overrides everything.

`feedTurn` was made authoritative on purpose — it *leads* `isActive`, which lags turn
boundaries by up to ~15s. That's right at turn start/end, but wrong here: a dangling
`'active'` with no follow-up is stale, and it shouldn't override a server status that has
since decayed.

---

## 3. Solutions (defense in depth)

Layer these; each self-heals a different failure mode.

### Solution A — Mobile: reconcile the dangling `'active'` with the server (PRIMARY, cheapest)

Make `feedTurn === 'active'` a *leading* signal only, not an authoritative one. Trust
`isActive` (which decays) and `machine_is_online` as the real "is the desktop alive and
working" truth; use the feed's `'active'` only to lead `isActive` for a short recency window
at turn start.

```ts
// last feed item's timestamp
const lastTs     = lastItem ? Date.parse(lastItem.ts) : 0
const feedRecent = Date.now() - lastTs < 45_000      // covers the ~15s isActive lag + margin

const feedActive =
  feedTurn === 'ended'      ? false :        // definitive end
  liveOnline === false      ? false :        // machine offline → can't be working
  isActive                  ? true  :        // server says active (keepalive is fresh)
  (feedTurn === 'active' && feedRecent)      // leading edge at turn start, before isActive flips
```

Why each line:
- **Alive turn:** the keepalive keeps `last_activity` fresh → `isActive` true → working, even
  during a long quiet reasoning phase. ✓
- **Turn start:** feed shows activity before `isActive` flips → `feedRecent` covers it. ✓
- **Disconnect:** keepalive stops → `isActive` decays false (30s), `feedRecent` goes false
  (no new items after ~45s), machine goes offline (90s). Any of these flips it → **not
  working.** Self-heals in ≤ ~45s. ✓

> **Re-render note:** during a disconnect the feed stops changing, so nothing re-renders to
> re-evaluate `feedRecent`. `useSessions` already polls every 15s, which re-renders and
> re-checks — but add a small `setInterval` (e.g. 10s) while `turnActive` to guarantee the
> recency check re-runs even if the poll is throttled.

- **Pros:** no backend change; fixes the reported bug directly; self-heals ≤45s.
- **Cons:** ~30–45s of stale "working" before it flips (bounded by `deriveStatus`'s 30s window
  — can't be faster without Solution B).

### Solution B — Server: synthesize a turn-end when a session goes stale (makes it consistent)

Solution A fixes the *composer*, but the *feed* still lacks a `stop` divider and other screens
(session list) rely on `deriveStatus`. To make the feed itself consistent, add a lightweight
**server sweeper** (cron/interval, e.g. every 30–60s):

> For each agent whose `last_activity_at` is older than the active window (30s) **and** whose
> latest feed event isn't already a `stop`, insert a synthetic turn-end and broadcast it:
> `event_type: 'stop'`, `status: 'stopped'`, `summary: 'Connection to the machine was lost —
> turn state unknown.'`

Now every surface — feed walk, session list, composer — agrees, and the chat shows an honest
"connection lost" divider instead of a dangling live turn.

- **Pros:** consistent across all screens; an explicit, labelled event; works even if the
  mobile logic (Solution A) isn't updated.
- **Cons:** a backend job to run and guard (don't double-post; only for sessions that were
  actually mid-turn); adds a "stopped" event that wasn't user-initiated (label it clearly so
  it's not confused with a real Stop).

### Solution C — Desktop: durable turn-end + disable-time flush (covers "connection returns")

Make Signal A survive a *transient* disconnect:

1. **Retry the `stop` POST.** If posting the turn-end fails, write it to a small local queue
   (`<runtime>/pending-usage`-style) and have the heartbeat flush the queue on reconnect. A
   turn that ends during a 20-second network blip then still delivers its stop once the link
   returns.
2. **Flush on mobile-support disable.** When mobile support is toggled off mid-turn, the
   disable path should post a final turn-end (`stop`, "Mobile support turned off") *before*
   removing the hooks/plugin — otherwise the turn is orphaned by design.

- **Pros:** delivers the *real* turn-end for transient drops; no false "stopped".
- **Cons:** does nothing if the machine never reconnects (that's what A/B are for); the
  disable-time flush is harness-specific plumbing.

### Solution D — UX: show "machine offline / status unknown", not a live spinner

When `machine_is_online === false` (or status has decayed while the feed says active), don't
render a *live* working spinner — render an honest state:

> **"Machine offline — last seen 2m ago. The agent may still be running locally; its status
> will update when the machine reconnects."**

…with the composer disabled (you can't send into an unreachable CLI anyway — the existing
`cliClosed`/offline handling is the model). This is the truthful representation: the phone
genuinely doesn't know, so don't imply live progress.

- **Pros:** never misleads; reuses existing offline affordances.
- **Cons:** copy/UX work; needs to distinguish "offline" from "finished".

---

## 4. Recommended combination

| Layer | Fixes | Effort | Self-heal |
| --- | --- | --- | --- |
| **A. Mobile reconcile** | The reported bug (composer stuck) | Low | ≤45s |
| **D. Offline UX** | Misleading spinner while offline | Low | ≤90s (machine offline) |
| **B. Server sweeper** | Feed/session-list consistency, honest divider | Medium | ≤60s |
| **C. Desktop retry/flush** | Transient drops deliver the *real* stop | Medium | on reconnect |

**Ship A + D first** — they're client-only, fix the exact symptom, and can't make anything
worse. Add **B** when you want the feed and every screen to agree (and a labelled "connection
lost" divider). Add **C** to recover the true turn-end after brief blips.

The one-line essence: **the server already detects the dead turn via `deriveStatus` decay and
machine-offline; the mobile must stop letting a dangling feed `'active'` override that.**

---

## 5. Edge cases & guards

- **Long quiet reasoning ≠ disconnect.** The keepalive touches `last_activity_at` during
  active reasoning, so `isActive` stays true — Solution A must key off `isActive`
  (keepalive-backed), not off feed silence alone. (This is why the `feedRecent` term is only a
  *leading* fallback, gated behind `isActive`.)
- **Don't double-fire the sweeper (B).** Only synthesize a stop for sessions whose newest
  event isn't already `stop`, and that were genuinely active (had a recent turn), to avoid
  posting "connection lost" for idle sessions.
- **Reconnect after A/B fired.** If the desktop reconnects and the turn is *still* running, a
  fresh tool-call ping / output re-freshens `last_activity_at` → `isActive` true again and new
  feed activity arrives → the composer re-locks naturally. A synthesized stop (B) followed by
  real new activity is fine — the feed walk keys off the *newest* boundary.
- **Machine-offline threshold (90s) vs status window (30s).** They differ on purpose; Solution
  A checks both so it flips on whichever trips first (usually the 30s status decay).

---

## 6. Reference points in the code

- `vibe_remote(serverside)/src/utils.js` — `deriveStatus` (30s / 10min windows).
- `vibe_remote(serverside)/src/routes/mobile.js` — `ONLINE_THRESHOLD_MS = 90_000`, session
  status/`machine_is_online` mapping.
- `relay-deamon1/scripts/heartbeat.js` — `keepActiveTurnsAlive` / `agentTouch` (the keepalive
  that stops on disconnect), machine heartbeat `tick` (30s), transcript-tailer touch.
- `vibe_remote(reactNative)/AgentControl/src/screens/Sessions/ChatScreen.tsx` — `feedTurn`,
  `feedActive` (the override to fix), `isActive`, `liveOnline`.
- Related prior fixes: `STOP_AGENT_DESIGN.md` (turn-end signaling), and the `refetchOnMount:
  'always'` fix in `useChatFeed` (a sibling "mobile didn't learn the turn ended" bug).
