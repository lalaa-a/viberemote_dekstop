# Live Token Counter via Claude Code `statusLine` — Design

Goal: make the mobile compose-bar token counter update as close to Claude Code's own
working-spinner counter as an *external* integration allows — driven by Claude Code's own
refresh cadence instead of a 3s transcript poll, and adding live **cost**.

This builds on the shipped feature in `TOKEN_USAGE_STREAMING_DESIGN.md` (the `/relay/usage`
endpoint + `usage` broadcast + compose-bar counter). It only changes the **source/cadence**
of Claude's token data on the desktop; the server and mobile paths stay the same.

---

## 1. Read this first — what's actually achievable (honest scope)

Claude Code's spinner ticks **per token** because it reads its *own live streaming API
response*. **No external Claude Code integration point exposes that per-token stream** —
not hooks (PreToolUse/PostToolUse have no usage), not the transcript (`message.usage` is
written only when a response *completes*), and not `statusLine` (its JSON carries session +
**cost**, not a live per-token count).

So this design does **not** promise a per-token tick. What it *does* deliver:

- **Claude-cadence updates.** `statusLine` is invoked by Claude Code on its own refresh
  schedule (fast, event-driven), so the counter advances the moment Claude Code updates —
  instead of up to 3s later on our heartbeat poll. For multi-step turns (several model
  responses) this feels much closer to "live."
- **Live cost.** `statusLine`'s JSON includes running `cost.total_cost_usd`, which Claude
  Code updates as the turn progresses — a genuinely live number we can show (`$0.04`).
- Token **counts** still come from the transcript (per completed response), but surfaced at
  Claude Code's cadence rather than a 3s poll.

If a true per-token tick is a hard requirement, it is **not achievable** from outside Claude
Code — the only way is Claude Code itself exposing live token usage to a hook, which it
currently does not. Set expectations accordingly.

---

## 2. What `statusLine` is

Claude Code lets you replace its status line with a custom command
(`settings.json → "statusLine": { "type": "command", "command": "…" }`). Claude Code runs
that command frequently, pipes **JSON on stdin**, and renders the command's **stdout** as
the status line. Documented input shape (fields vary by version — read defensively):

```jsonc
{
  "hook_event_name": "Status",
  "session_id":      "ses_…",
  "transcript_path": "C:\\Users\\…\\.claude\\projects\\…\\ses_….jsonl",
  "cwd":             "C:\\project",
  "model":           { "id": "claude-…", "display_name": "Claude …" },
  "workspace":       { "current_dir": "…", "project_dir": "…" },
  "version":         "…",
  "cost": {
    "total_cost_usd":        0.0123,
    "total_duration_ms":     45000,
    "total_api_duration_ms": 12000,
    "total_lines_added":     156,
    "total_lines_removed":   18
  }
}
```

Key properties for us:

- It carries `session_id` and `transcript_path` — everything we need to attribute + read
  token usage.
- It carries running `cost` that updates through the turn.
- **It must be fast.** Claude Code times the command out (sub-second) and calls it often, so
  it must print immediately and never block on the network.

---

## 3. Architecture

Do **not** POST to the VPS from inside the `statusLine` command (network latency would stall
Claude Code's status line and risk timeouts). Instead decouple:

```
Claude Code ──stdin JSON──► statusLine command (fast, local)
                              │  1. print a status string to stdout (Claude renders it)
                              │  2. write latest usage+cost to <runtime>/usage-<sessionId>.json
                              ▼
                       heartbeat (already running)
                       watches usage-*.json → POST /relay/usage (absolute totals)
                              ▼
                    server persists + broadcasts 'usage' ──► mobile compose-bar counter
```

- The `statusLine` command stays **local and instant**: parse stdin, compute the token
  numbers, write one small JSON file, print the status line. No `await fetch`.
- The **heartbeat** (which already runs and already owns `/relay/usage`) watches those files
  and forwards changes — reusing the exact server + mobile path already shipped. This also
  keeps the network/rate-limit handling in one place.

Token numbers in the `statusLine` command come from the transcript (`transcript_path` is in
the JSON) — read only the **tail** for the latest `message.usage`, never the whole file (it
can be large and this runs often). Cost comes straight from the JSON.

---

## 4. Desktop implementation

### 4a. `statusLine` command — `relay-deamon1/statusLine.js`

```js
#!/usr/bin/env node
// Registered as Claude Code's statusLine command when mobile mode is on. MUST be fast:
// print the status line, stash usage+cost locally, and return. The heartbeat forwards it.
import fs from 'node:fs'
import { runtimePath, ensureDirs } from './src/paths.js'

function readStdin() { try { return fs.readFileSync(0, 'utf8') } catch { return '' } }

// Read only the last ~64KB of the transcript and find the newest assistant usage.
function latestUsage(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath)
    const start = Math.max(0, stat.size - 64 * 1024)
    const fd = fs.openSync(transcriptPath, 'r')
    const buf = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      let e; try { e = JSON.parse(lines[i]) } catch { continue }
      const u = e?.type === 'assistant' && e.message?.usage
      if (u) return {
        input:  (u.input_tokens||0) + (u.cache_read_input_tokens||0) + (u.cache_creation_input_tokens||0),
        output: u.output_tokens || 0,
      }
    }
  } catch {}
  return null
}

const j = (() => { try { return JSON.parse(readStdin()) } catch { return {} } })()
const sid = j.session_id
const u   = j.transcript_path ? latestUsage(j.transcript_path) : null
const cost = j.cost?.total_cost_usd ?? null

if (sid) {
  try {
    ensureDirs()
    fs.writeFileSync(runtimePath(`usage-${sid}.json`), JSON.stringify({
      sessionId: sid, turnOutput: u?.output ?? 0, turnInput: u?.input ?? 0,
      cost, ts: Date.now(),
    }))
  } catch {}
}

// stdout = the status line Claude Code renders. Keep the CLI's normal-looking status.
process.stdout.write(u ? `↓ ${u.output} tokens` : '')
```

> Note the per-turn **reset**: `latestUsage` returns the newest message's usage, so
> `turnOutput` here is the *last response's* output, not the turn cumulative. To match the
> shipped "turn cumulative" metric, either (a) keep the cumulative accumulator in the
> heartbeat (below) and treat the statusLine file only as a "poke to re-read", or (b) sum in
> the statusLine command by tracking a turn boundary. Simplest: **the heartbeat stays the
> single accumulator** (it already resets on the user-prompt transcript line); the statusLine
> file just makes the heartbeat re-read *now* instead of on its 3s tick.

### 4b. Heartbeat — forward the file (or use it as a poke)

Two options:

- **Poke (recommended, least duplication):** keep the heartbeat's existing transcript
  accumulator (`usageBySession`) as the source of truth. Add a fast watcher: when
  `usage-<sid>.json` changes, run the transcript-usage step for that session immediately and
  POST — so updates land at Claude's cadence, not the 3s tick. Include `cost` from the file.
- **Direct forward:** if you accept "last response output" instead of turn-cumulative, the
  heartbeat just reads `usage-<sid>.json` and POSTs it (plus cost).

Either way, reuse `postUsage()` → `POST /relay/usage`; add `cost` to the payload.

### 4c. Register the statusLine (mobile-mode install)

Where the relay installs the Claude hooks (the `mobile enable` path that writes
`settings.json`), also set:

```jsonc
"statusLine": { "type": "command", "command": "node \"<abs>/relay-deamon1/statusLine.js\"" }
```

Remove it on `mobile disable` (and **restore any pre-existing user statusLine** — back it up
on enable, restore on disable, so we don't clobber a custom status line the user had).

---

## 5. Server & mobile (mostly already done)

- **Server:** `/relay/usage` already persists + broadcasts. Add an optional `cost` column
  (`agents.turn_cost_usd numeric`) and include `cost` in the broadcast payload.
- **Mobile:** the compose-bar counter already consumes the `usage` broadcast. Optionally
  render cost next to tokens (`1.4k tokens · $0.04`). No structural change — just a wider
  `SessionUsage` (`cost?: number`) and one more `<Text>`.

---

## 6. Constraints, edge cases, failure modes

| Concern | Handling |
| --- | --- |
| statusLine timeout | Command never awaits the network; it only reads a 64KB tail + writes one small file, then prints. Must complete well under Claude Code's timeout. |
| Large transcript | Read only the tail (last 64KB), newest-first; never parse the whole file. |
| User already has a statusLine | Back it up on enable; restore on disable. Never silently overwrite. |
| statusLine not supported (old Claude Code) | Feature degrades to the existing 3s heartbeat tailer — no regression. |
| Cost only, no live tokens | Expected — see §1. Tokens stay per-response; cost is the live-est number. |
| OpenCode / Gemini | Unaffected — this is Claude-only. OpenCode already streams via its plugin. |

---

## 7. Is it worth building?

**Yes if:** you want the counter to advance at Claude Code's cadence (snappier on multi-step
turns) and to show **live cost**. Those are real, visible improvements over the 3s poll.

**No if:** the expectation is a smooth *per-token* tick identical to Claude Code's own UI —
that data isn't exposed to any external integration, so no amount of statusLine/hook work
achieves it. In that case, the shipped per-response counter is already the ceiling.

**Recommendation:** implement the **poke** variant (§4b, option A) — it's low-risk (reuses
the heartbeat accumulator and the existing `/relay/usage` path), adds live cost, and makes
token updates event-driven. Skip it if per-token smoothness is the only acceptable outcome.

---

## 8. Phased rollout

1. `statusLine.js` (writes `usage-<sid>.json` + prints status).
2. Register/unregister statusLine on mobile enable/disable (with backup/restore of any
   existing user statusLine).
3. Heartbeat: watch `usage-<sid>.json` → immediate transcript re-read + `postUsage` (poke).
4. Server: `cost` column + include in broadcast.
5. Mobile: show `· $cost` next to the token count.

---

## 9. Open questions

- Exact `statusLine` invocation cadence during a single long response (does Claude Code
  refresh mid-stream, or only on message/cost change?). Determines how "live" cost feels.
- Whether newer Claude Code versions add token/context fields to the `statusLine` JSON — if
  so, read them directly and skip the transcript tail.
- Claude Code's statusLine timeout budget (keep the command well under it).
