# Token-Usage Streaming — Design

Stream live token usage from each harness (Claude Code, OpenCode, Gemini) to the mobile
app and show it **inside the compose bar while the harness is working**, so the user has a
running sense of how many tokens the current turn is burning.

This document is the implementation plan. It reuses the existing relay architecture
(desktop harness hooks/plugin → VPS server → mobile over Supabase broadcast) and the
lessons already baked into it (broadcast is reliable, `postgres_changes` is not; the feed
walk keys off broadcast events; the compose bar already renders a live "working" row).

---

## 1. Goal & UX

- **Where:** the compose bar's "working" row — the same row that shows the rotating spinner
  word and the **Stop** button while a turn is live (`ChatScreen.tsx`, the `turnActive`
  branch).
- **When:** only while the harness is working (`turnActive === true`). Hidden otherwise.
- **What:** a compact, live-updating token counter for the **current turn**.

```
┌───────────────────────────────────────────────┐
│ ◠ Pondering…  ·  ↑ 8.2k  ↓ 1.4k        [ Stop ]│   ← compose bar, working row
└───────────────────────────────────────────────┘
        spinner word     token usage      stop
```

Recommended default display: **`↑ <input> ↓ <output>`** for the current turn, formatted
compactly (`1.2k`, `18.4k`, `1.1M`). Optionally a single `12.3k tok` total, or append cost
(`$0.04`) later. Keep it one short segment — the row is tight.

### What metric?

A "turn" can make several model calls (tool loops). Per call the model reports:

- `input_tokens` — the whole context sent (grows each call).
- `output_tokens` — tokens generated that call.
- cache read/write tokens (Claude) — cheap-but-real context reuse.

Two useful framings; pick one for v1 and keep the other as a stretch:

1. **Turn cumulative (recommended)** — sum `output_tokens` across the turn's calls
   (`turnOutput`), and take the **latest** call's `input_tokens` as the current context
   size (`turnInput` = context, not summed — summing inputs double-counts the growing
   context). Display `↑ context ↓ generated`.
2. **Session cumulative** — running totals across the whole session. Better for a "budget"
   feel; store on the agent row and never reset.

v1: **turn cumulative**, reset at each turn start. Expose session totals in the payload too
(cheap) so the UI can switch later without a protocol change.

---

## 2. Data sources per harness

### Claude Code — from the transcript (already tailed)

The heartbeat already tails the Claude transcript JSONL
(`~/.claude/projects/<encoded-cwd>/<session>.jsonl`) for narrative output in
`scripts/heartbeat.js → tailOneTranscript()`. Each `assistant` line carries usage:

```jsonc
{ "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [ ... ],
    "usage": {
      "input_tokens": 8213,
      "output_tokens": 142,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 7710
    } } }
```

So **no new hook is needed** — the same loop that reads `entry.message.content` reads
`entry.message.usage`. Accumulate per turn as lines stream in (the tailer runs every 3s, a
good update cadence). This is the cleanest source and covers the exact "while working"
window because the transcript grows as the model works.

> Note: the PreToolUse/PostToolUse hooks (`hook.js`/`postHook.js`) do NOT receive usage,
> and they only fire on tool calls. The transcript tailer is the right place — it sees every
> assistant message, including tool-less reasoning turns.

### OpenCode — from the plugin's message events

The in-process plugin (`src/harnesses/opencode/plugin/relay.js`) already handles the SDK
event stream. OpenCode assistant messages carry token usage. On `message.updated` (and on
the message info attached to `message.part.updated`), read the message's `tokens` and
`cost`. Expected shape (verify against installed `@opencode-ai/sdk@0.4.45`):

```jsonc
{ "tokens": { "input": 8213, "output": 142, "reasoning": 0,
              "cache": { "read": 7710, "write": 0 } },
  "cost": 0.0123 }
```

Emit usage from the plugin the same way it emits `output`/`tool_*` events. Throttle to
≤ ~1/s (see §6). The plugin already knows the `sessionID`.

### Gemini CLI — best-effort (phase 2)

Gemini runs under the PTY wrapper (`vibe run gemini-cli`), which owns the live PTY and has
no structured usage stream. Options, in order of preference:

1. Gemini's own session/telemetry files if it writes them (check
   `~/.gemini/` for a usage/stats JSON) — tail like Claude's transcript.
2. Parse a usage line from stdout if the CLI prints one at end-of-turn.
3. Ship without Gemini usage in v1; the compose bar simply omits the counter for Gemini
   sessions (graceful — see §8).

Do **not** block v1 on Gemini.

---

## 3. Architecture

Mirror the stop/feed path exactly — it's proven on this self-hosted Supabase:

```
harness (desktop)                     VPS server                         mobile
─────────────────                     ──────────                         ──────
Claude: heartbeat transcript tailer   POST /relay/usage  ─┬─► UPDATE agents.usage_*   (durable)
OpenCode: plugin message.updated  ──► (machine-authed)    └─► broadcastSession(id,     (live)
                                                              'usage', {counts})
                                                                    │
                                          session:<id> broadcast ───┘──► useSessionUsage()
                                                                          → compose bar
```

- **Live path:** a `usage` **broadcast** on the existing `session:<id>` topic. Broadcast is
  the reliable channel here (`postgres_changes` is silently dropped — see
  `LIVE_FEED_REALTIME_DIAGNOSIS.md`). Unlike the feed nudge, the usage broadcast carries the
  small **numeric payload directly** (see §9 on why that's acceptable), so the phone updates
  the counter with no round-trip.
- **Durable path:** the server also writes the running totals onto the `agents` row, so a
  remount (leave + reopen the chat) reads the current numbers from the feed/sessions fetch
  instead of waiting for the next broadcast. This is the same durability gap we hit with the
  Stop event (`refetchOnMount: 'always'` in `useChatFeed`) — usage must survive remount too.

Why not put usage in a `terminal_event`? Because it updates far too often and would flood
the feed/DB and the feed-walk logic. Usage is **ephemeral session state**, not a feed row —
it belongs on the agent row + a broadcast, not in `terminal_events`.

---

## 4. Data model

### New `agents` columns (server migration)

```sql
ALTER TABLE public.agents
  ADD COLUMN turn_tokens_input     integer NOT NULL DEFAULT 0,
  ADD COLUMN turn_tokens_output    integer NOT NULL DEFAULT 0,
  ADD COLUMN session_tokens_input  bigint  NOT NULL DEFAULT 0,
  ADD COLUMN session_tokens_output bigint  NOT NULL DEFAULT 0,
  ADD COLUMN tokens_updated_at     timestamptz;
```

(Or a single `usage jsonb` column — but discrete integer columns are cheaper to update and
easier to expose. Prefer columns.)

### Broadcast / endpoint payload

```jsonc
{
  "sessionId":   "ses_abc",
  "turnInput":   8213,     // current context size (latest call)
  "turnOutput":  1420,     // generated this turn (cumulative)
  "sessionInput":  41022,  // optional running totals
  "sessionOutput": 9106,
  "cost":        0.0123,   // optional, harness-dependent
  "turnSeq":     7         // monotonic per turn — lets the client ignore stale/out-of-order updates
}
```

`turnSeq` (or a turn id) lets the client and server drop a late update from a previous
turn, and lets the server know when to reset `turn_*` (new `turnSeq` for this session →
zero the turn counters before applying).

---

## 5. Server implementation (`vibe_remote(serverside)`)

**`src/routes/relay.js` — new endpoint:**

```js
// POST /relay/usage — live token usage for a session's current turn.
router.post('/usage', requireMachineAuth, async (req, res) => {
  const { sessionId, turnInput = 0, turnOutput = 0,
          sessionInput, sessionOutput, cost } = req.body
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' })

  // Persist the running totals (durable across mobile remounts).
  const patch = {
    turn_tokens_input:  turnInput,
    turn_tokens_output: turnOutput,
    tokens_updated_at:  new Date().toISOString(),
  }
  if (sessionInput  != null) patch.session_tokens_input  = sessionInput
  if (sessionOutput != null) patch.session_tokens_output = sessionOutput

  await db.from('agents').update(patch)
    .eq('machine_id', req.machine.id).eq('session_id', sessionId)

  // Live push — numeric only, safe to ride the broadcast payload (see design §9).
  broadcastSession(sessionId, 'usage', { turnInput, turnOutput, sessionInput, sessionOutput, cost })
  res.json({ ok: true })
})
```

**Reset semantics:** either (a) the desktop sends absolute turn totals (server just stores
them — simplest, recommended), or (b) send deltas and let the server accumulate. Absolute
totals avoid drift if a broadcast/POST is dropped. A new turn starts fresh because the
desktop resets its per-turn accumulator at turn start (§7).

**Expose on the mobile fetch:** add `turn_tokens_input/output` (and session totals) to the
`/mobile/sessions` and/or the session feed/`agents` selection so a remount can seed the
counter. (Same place `deriveStatus` is computed in `src/routes/mobile.js`.)

---

## 6. Desktop implementation

### Claude — `scripts/heartbeat.js`

In `tailOneTranscript`, while iterating assistant lines, accumulate usage and post once per
tick if it changed:

```js
// module scope: per-session turn accumulators
const usageBySession = new Map() // sessionId → { input, output, seq }

// inside the assistant-line loop:
const u = entry.message?.usage
if (u) {
  const acc = usageBySession.get(sessionId) ?? { input: 0, output: 0, seq: 0 }
  acc.input   = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) // context size
  acc.output += u.output_tokens                                                                          // cumulative generated
  usageBySession.set(sessionId, acc)
}

// after the loop, if usage changed this tick:
if (usageChanged) postUsage(sessionId, acc)   // POST /relay/usage (throttled by the 3s tick)
```

- **Reset at turn start:** clear `usageBySession[sessionId]` when a new turn begins. Cheapest
  signal available: the busy flag flipping from absent→present, or the first assistant line
  after a `stop`/turn-end. Simplest robust rule: reset when a `stop` was posted for the
  session (turn ended) OR when a new user prompt is injected.
- **Throttle:** the tailer already runs every 3s, so usage POSTs are naturally ≤ 1 per 3s
  per session. Skip the POST if nothing changed.

Add `postUsage` to `src/supabase.js` next to `agentTouch`:

```js
export async function postUsage(sessionId, u) {
  return apiPost('/relay/usage', { sessionId, ...u })
}
```

### OpenCode — `src/harnesses/opencode/plugin/relay.js`

On `message.updated` (or when a part completes), read `tokens`/`cost`, accumulate per
session, and POST — throttled to ≤ 1/s with a small timestamp guard (the plugin fires many
part updates). Reset the per-session accumulator on `session.idle` (turn end) so the next
turn starts at zero. Reuse the plugin's existing `postTerminalEvent`-style `fetch` helper
with a new `/relay/usage` call.

### Gemini — phase 2 (see §2).

---

## 7. Turn-reset semantics

The counter is **per turn** and must reset when a new turn starts:

- **Claude:** reset `usageBySession[sessionId]` when the turn ends (a `stop` event is posted,
  or `session.idle`-equivalent) — the next assistant line seeds a fresh accumulator. Bump
  `turnSeq`.
- **OpenCode:** reset on `session.idle`.
- The server stores absolute turn totals, so "reset" is just the desktop sending small
  numbers again for the new turn (with a new `turnSeq`). The client shows `turnOutput` which
  naturally restarts.

Keep `session_tokens_*` monotonic (never reset) for the optional "session budget" view.

---

## 8. Mobile implementation (`vibe_remote(reactNative)`)

### `useSessionUsage(sessionId)` — new hook

Subscribe to the `session:<id>` channel (the same topic `useChatFeed` uses) for the `usage`
broadcast event and keep the latest numbers in state. Seed from the durable value on mount.

```ts
export function useSessionUsage(sessionId: string) {
  const [usage, setUsage] = useState<Usage | null>(null)
  useEffect(() => {
    let unsub: (() => void) | null = null
    ;(async () => {
      const client = await getRealtimeClient(); if (!client) return
      const ch = client.channel(`session:${sessionId}`)
        .on('broadcast', { event: 'usage' }, ({ payload }) => setUsage(payload as Usage))
        .subscribe()
      unsub = () => { try { ch.unsubscribe() } catch {} }
    })()
    return () => { if (unsub) unsub() }
  }, [sessionId])
  return usage
}
```

- **Reuse the channel:** ideally fold the `usage` listener into `useChatFeed`'s existing
  `session:<id>` subscription instead of opening a second channel to the same topic (one
  socket, one channel). Return `usage` alongside `feed`.
- **Seed on remount:** the live counter is lost when the screen unmounts; read the durable
  `turn_tokens_*` from the session (via `useSessions`/the feed fetch that now includes them)
  so reopening shows the last known value immediately, then live updates take over. This is
  the same remount lesson as the Stop event.

### Compose bar — `ChatScreen.tsx`

In the `turnActive` working row, render the counter between the spinner word and Stop:

```tsx
const usage = /* from useChatFeed or useSessionUsage */
// ...
<View style={styles.workingStatus}>
  <ActivityIndicator size="small" color={DarkColors.online} />
  <Text style={styles.workingStatusText}>{workingWord}…</Text>
  {usage && (
    <Text style={styles.usageText}>
      ↑ {fmtTokens(usage.turnInput)}  ↓ {fmtTokens(usage.turnOutput)}
    </Text>
  )}
</View>
```

`fmtTokens(n)` → `n < 1000 ? String(n) : n < 1e6 ? (n/1e3).toFixed(1)+'k' : (n/1e6).toFixed(1)+'M'`.
Style `usageText` muted (`DarkColors.textTertiary`, mono) so it reads as metadata, not a
primary control. Only render while `turnActive` (the row only exists then anyway). Guard the
row width on small screens (truncate the spinner word before the counter).

---

## 9. Security / privacy of the broadcast payload

The `session:<id>` topic is **not** RLS-protected — which is why the feed nudge deliberately
carries *no* row content (no reasoning/diff text). Token **counts are non-sensitive
integers** (and an optional cost float): they reveal nothing about the code or conversation,
so putting them directly in the `usage` broadcast payload is acceptable and avoids a
per-update refetch. Do **not** add prompt text, file names, or model names that could leak
context. If even counts are considered sensitive later, fall back to the feed pattern:
broadcast an empty `usage` nudge and have the client refetch a usage endpoint — at the cost
of a round-trip per update.

---

## 10. Throttling & performance

- **Claude:** naturally ≤ 1 POST / 3s (tailer cadence); skip when unchanged.
- **OpenCode:** throttle to ≤ 1/s with a `lastSentAt` guard; always send the final value on
  `session.idle`.
- **Server:** the `UPDATE agents` + broadcast is cheap; no fan-out beyond the one session
  topic.
- **Mobile:** setState at ≤ 1/s causes no list re-render (the counter is in the compose bar,
  outside the FlatList). Keep it out of the feed data so it never triggers a feed re-render.

---

## 11. Edge cases & failure modes

| Case | Behaviour |
| --- | --- |
| Harness doesn't report usage (Gemini v1) | No `usage` broadcast → `usage` stays null → counter simply hidden. |
| Broadcast dropped | Next tick's absolute value corrects it; remount reads the durable agent row. |
| Turn ends | Stop/`session.idle` → counter hidden when `turnActive` goes false; `turn_*` left at final value (or zeroed on next turn start). |
| Out-of-order update from a previous turn | `turnSeq` lets client/server ignore it. |
| Remount mid-turn | Seed from durable `turn_tokens_*`, then live updates resume. |
| Multiple turns rapidly | Reset on turn start keyed by `turnSeq`; absolute totals prevent drift. |

---

## 12. Phased rollout

1. **Server:** migration (agent columns) + `POST /relay/usage` + expose fields on
   `/mobile/sessions`. Ship dark (no client yet).
2. **Claude desktop:** accumulate usage in the transcript tailer + `postUsage`. Verify rows
   update in the DB.
3. **Mobile:** `useSessionUsage` (folded into `useChatFeed`) + compose-bar counter + remount
   seeding.
4. **OpenCode:** plugin usage emission.
5. **Gemini:** best-effort source (phase 2), or leave hidden.
6. **Stretch:** cost display, session-total toggle, per-turn sparkline.

---

## 13. Alternatives considered

- **Usage as `terminal_events`** — rejected: updates too frequently, floods the feed + DB,
  and pollutes the feed-walk turn logic. Usage is ephemeral session state.
- **`postgres_changes` on `agents`** — rejected: silently dropped on this self-hosted
  Supabase (documented); broadcast is the reliable channel.
- **Polling a usage endpoint from mobile** — rejected for the live path (laggy, wasteful);
  used only as the remount seed + as a fallback if broadcast counts are ever deemed sensitive.
- **Per-token streaming** — unnecessary; 1–3s cadence is plenty for a "sense of usage" and
  keeps traffic and re-renders low.

---

## 14. Open questions

- Confirm OpenCode `@opencode-ai/sdk@0.4.45` message token field path (`tokens` on
  `message.updated` `properties.info`?).
- Does Gemini CLI expose a usage/stats file we can tail?
- Show cost ($)? Requires per-model pricing; harness-dependent. Defer.
- Turn-cumulative vs session-cumulative as the default display — start turn, keep session in
  payload for a later toggle.
