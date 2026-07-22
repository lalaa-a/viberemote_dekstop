# Live Token Counter via `statusLine` — What Changed (Claude Code)

Implements the **"poke" variant** from `LIVE_TOKEN_STATUSLINE_DESIGN.md` for **Claude Code
only**, and **token usage only** (no cost streamed to mobile). The mobile token counter now
updates at Claude Code's own refresh cadence instead of waiting up to 3s for the heartbeat's
transcript poll.

This builds on the already-shipped token feature (`TOKEN_USAGE_STREAMING_DESIGN.md`): the
server `/relay/usage` endpoint + `usage` broadcast + the compose-bar counter are unchanged.
Only the **desktop source/cadence** of Claude's token numbers changed.

---

## How it works now

```
Claude Code ──(refreshes status line, pipes JSON)──► statusLine.cjs   (fast, local)
                                                         │ 1. writes <runtime>/usage-<sid>.json  (a "poke")
                                                         │ 2. prints a compact status line for the CLI
                                                         ▼
                                     heartbeat  checkUsagePokes() every 1s
                                       └─ poke changed? → tailOneTranscript(sid) NOW
                                            └─ accumulates turn tokens → postUsage()  (unchanged)
                                                 └─ server persists + broadcasts 'usage' → mobile counter
```

- The **heartbeat stays the single accumulator** (turn-cumulative output, reset on a genuine
  user prompt) — exactly the metric the compose bar already shows. The statusLine file is
  only a *poke*: "re-read this session's transcript now."
- Because `tailOneTranscript` reads only new bytes and advances its position synchronously,
  the 1s poke and the 3s backstop tick **never double-count**.
- Net effect: the token counter advances ~1s after Claude updates its own status, instead of
  up to 3s. Noticeably tighter on multi-step turns. (It's still per-model-response, not a
  per-token tick — that data isn't exposed externally; see the design doc §1.)

---

## Files changed

**New**
- `relay-deamon1/statusLine.cjs` — the Claude Code `statusLine` command. Reads the piped
  JSON, writes `<runtime>/usage-<sessionId>.json` (poke), reads only the transcript **tail**
  for the latest usage, and prints a compact status line (`<dir> · <model> · ↑<ctx> ↓<out> tok`).
  CommonJS so Claude Code launches it directly (no ESM wrapper needed). Fast + fail-safe.

**Modified**
- `relay-deamon1/src/harness-sdk/strategies/settingsHook.js` — the settings strategy now
  optionally installs a `statusLine` into `~/.claude/settings.json` on `enable` and removes
  it on `disable`, with **backup/restore of any pre-existing user statusLine** (stashed in
  `<runtime>/statusline-backup.json`). It only ever removes a statusLine that is *ours*.
- `relay-deamon1/src/harnesses/claude-code/provider.js` — passes `statusLineCommand`
  (`node "<relay>/statusLine.cjs"`) and the backup-file path to the strategy.
- `relay-deamon1/scripts/heartbeat.js` —
  - added `checkUsagePokes()` (1s interval): on a changed `usage-<sid>.json`, immediately
    `tailOneTranscript(sid)` so usage lands at Claude's cadence;
  - registered `setInterval(checkUsagePokes, 1_000)`;
  - `reportSessionLiveness()` now also deletes the poke file when a session's CLI dies.

**Not changed** (already shipped): `/relay/usage`, the `usage` broadcast, `agents` token
columns, `useChatFeed` usage subscription, and the compose-bar `<output> tokens` counter.

---

## Behaviour notes

- **Desktop status line:** while mobile support for claude-code is ON, the CLI's status line
  is *ours* (`<dir> · <model> · ↑<ctx> ↓<out> tok`). If the user had a custom `statusLine`,
  it's backed up and **restored on disable**. If they had none, Claude's default returns on
  disable. (A user statusLine set *after* enable is never clobbered.)
- **Token-only:** the desktop line shows context (↑) + output (↓); the **mobile** counter
  still shows only `<output> tokens` (unchanged). Cost is *not* streamed to mobile (per scope).
- **Perf:** the statusLine command is lean (tail read + one small write + print). Claude Code
  invokes it on its own throttle; each call is a short-lived `node` process.
- **Degrades safely:** on a Claude Code build without `statusLine` support, nothing pokes and
  the existing 3s heartbeat tailer still drives the counter — no regression.
- **OpenCode / Gemini:** untouched. OpenCode already streams usage via its plugin.

---

## To deploy / test

1. **Restart the heartbeat** (new `checkUsagePokes` loop).
2. **Re-enable mobile support for Claude Code** in the desktop app so the strategy rewrites
   `~/.claude/settings.json` with the `statusLine` block (and backs up any existing one).
3. **Start a new Claude Code session** (it reads `settings.json` at launch).
4. Give it a prompt and watch the mobile compose-bar counter — it should advance close to
   Claude Code's own status-line updates. Verify `~/.claude/settings.json` has a
   `statusLine` pointing at `statusLine.cjs`, and that toggling mobile support OFF removes it
   (restoring any prior one).

Smoke test (no Claude needed):
```
echo '{"session_id":"t1","cwd":"D:/x","model":{"display_name":"Claude"}}' | node statusLine.cjs
# prints "x  ·  Claude" and writes <runtime>/usage-t1.json
```
