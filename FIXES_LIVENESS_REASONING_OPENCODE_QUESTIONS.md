# Fixes — CLI Liveness, Reasoning Streaming & OpenCode Question Picker

> Session date: 2026-06-24. Four related defects found while debugging "CLI shows
> closed", "reasoning not streaming to mobile", and "the question picker doesn't work
> in OpenCode". Each fix was applied to **both** the repo source and the live installed
> copy under `C:\Users\lala\AppData\Local\VibeRemote\app-1.3.0\...` (and, for the
> OpenCode plugin, the `~/.config/opencode` copy) so it takes effect without a rebuild.

---

## TL;DR

| # | Symptom | Root cause | Fix | Files |
|---|---------|-----------|-----|-------|
| 1 | Mobile shows **CLI closed** while it's open; reasoning missing for question-led sessions | The `AskUserQuestion` branch in `hook.js` `return`ed **before** `storeClaudePid()` / `recordTranscriptPath()`, so a session whose first hook fire is a question never wrote its PID file or transcript mapping | Moved PID + transcript registration **above** the `AskUserQuestion` branch | `relay-deamon1/hook.js` |
| 2 | **Reasoning never streams** to mobile (but "task complete" does) | `stopHook.js` deleted the transcript mapping on **every** `Stop` event — and `Stop` fires at the end of every turn, not when the CLI closes — so the heartbeat's 3s tailer lost the mapping before it could read the turn's reasoning | Stopped deleting the mapping on `Stop`; aging is handled by the heartbeat's 5‑min `STALE_MAPPING_MS` gate | `relay-deamon1/stopHook.js` |
| 3 | The **AskUserQuestion picker doesn't work in OpenCode** | OpenCode has no built-in AskUserQuestion tool, and the integration never intercepted questions | Registered a custom `askUserQuestion` OpenCode plugin tool that reuses the existing harness-agnostic upload/answer pipeline; added a system-prompt nudge so the model uses it | `relay-deamon1/src/harnesses/opencode/plugin/relay.js` |
| 4 | OpenCode plugin edits **kept reverting** | Toggling mobile mode runs `enable()` → `copyFileSync(PLUGIN_SRC, PLUGIN_DST)`, overwriting hand-edits to the installed `vibe-relay.js` | Synced the new plugin into all three locations (dev source, app-bundled `PLUGIN_SRC`, live `PLUGIN_DST`) so a toggle can't drift it | (sync only) |

---

## 1. `hook.js` — PID / transcript registration ordering

**Before** (broken): the `AskUserQuestion` early-return ran before registration.

```js
if (event.tool_name === "AskUserQuestion") {
  await handleQuestion(event)
  return                          // ← returns here…
}
storeClaudePid(event.session_id)              // ← …so these never ran
recordTranscriptPath(event.session_id, event.transcript_path)
```

**After** (fixed): registration runs first, so it happens for *every* hook fire
including questions.

```js
storeClaudePid(event.session_id)
recordTranscriptPath(event.session_id, event.transcript_path)

if (event.tool_name === "AskUserQuestion") {
  await handleQuestion(event)
  return
}
```

**Why it mattered.** `C:\temp\relay-pid-<sessionId>.txt` drives `agents.cli_alive`
(heartbeat probes it every 15s). `C:\temp\transcript-paths\<sessionId>.path` is what
the heartbeat's transcript tailer needs to forward reasoning. A session that *led*
with a question got neither — so mobile saw the CLI as closed and no reasoning
streamed. Pre-update this never surfaced because `AskUserQuestion` wasn't in the hook
matcher; the update (`provider.js` / `relay.cjs`) added it.

---

## 2. `stopHook.js` — don't delete the transcript mapping every turn

**Removed:**

```js
// Session ended — drop the transcript mapping so heartbeat stops tailing it
if (event.session_id) {
  try { unlinkSync(join(TRANSCRIPT_DIR, `${event.session_id}.path`)) } catch {}
}
```

**Why it mattered.** Claude Code's `Stop` hook fires at the **end of every turn**, not
when the CLI closes. Deleting the mapping there meant the heartbeat's 3s
`checkTranscripts` tailer lost the file before it could read a short turn's reasoning,
so narrative never reached mobile — while the `'stop'` terminal event it also posts
("task finished") *did* arrive, which is why "task complete" showed but reasoning
didn't. Aging of genuinely dead sessions is already handled by the heartbeat's 5‑minute
`STALE_MAPPING_MS` gate, so the deletion was both redundant and destructive.

> Note: this is a **pre-existing** bug, not introduced by the AskUserQuestion feature —
> but it only became the visible blocker once #1 and the dead daemon were cleared.

---

## 3. OpenCode plugin — `askUserQuestion` custom tool

OpenCode exposes `Hooks.tool` (a plugin can register custom tools whose `execute()`
returns a real result) — cleaner than Claude Code, which can only block with exit 2.
Added an `askUserQuestion` tool in `relay.js`:

- **args** mirror Claude's AskUserQuestion shape (`questions[]` with `header?`,
  `question`, `multiSelect?`, `options[]`), so the harness-agnostic mobile QuestionCard
  renders it identically.
- **execute** uploads a `kind='question'` row via `/relay/upload`, polls
  `/relay/status/:id` until `status='answered'`, and returns the chosen option(s) as
  the tool result string the model reads. (New helpers `uploadAndWaitAnswer` +
  `formatAnswer`.)
- Loaded via **dynamic `import('@opencode-ai/plugin/tool')` inside try/catch**, so a
  resolution failure can never break the existing gating/narrative hooks.
- Added an `experimental.chat.system.transform` **nudge** instructing the model to call
  `askUserQuestion` instead of asking in plain prose (only when mobile mode is on).
- Diagnostics in the plugin debug log (`~/.config/opencode/vibe-relay-debug.log`):
  `askUserQuestion tool registered OK`, `system.transform nudge added`,
  `askUserQuestion.execute CALLED`.

The mobile + server side is already harness-agnostic (the Claude Code question flow uses
the same `/relay/upload`, `/relay/status`, `/mobile/answer`, and QuestionCard), so this
was a **desktop-only** change — no server or mobile work required.

**Known limitation:** unlike Claude Code's native tool, the OpenCode model must *choose*
to call the custom tool. The system nudge encourages it; a weaker model may still answer
in prose (in which case the text streams to mobile but no picker renders).

---

## 4. Plugin install path / sync

`src/harness-sdk/strategies/plugin.js` `enable()` runs
`copyFileSync(PLUGIN_SRC, PLUGIN_DST)` on every mobile-mode enable, where (from
`opencode/provider.js`):

- `PLUGIN_SRC = <relay-root>/src/harnesses/opencode/plugin/relay.js` (app-bundled)
- `PLUGIN_DST = ~/.config/opencode/plugin/vibe-relay.js` (what OpenCode loads)

So editing only `PLUGIN_DST` is wiped by the next toggle. Fix #3 was synced into the dev
source, `PLUGIN_SRC`, and `PLUGIN_DST` together so they stay in lockstep.

---

## Operational notes (not code)

- The "reasoning not streaming" investigation also surfaced that the **heartbeat daemon
  had died** (laptop sleep → `fetch failed` storm → process gone). It's spawned/supervised
  by the VibeRemote desktop app; relaunching the app restores it. The daemon streams
  reasoning (`checkTranscripts` → `postTerminalEvent`), reports liveness, and sends
  heartbeats — none of which work while it's down.
- The "hook error" banner on `AskUserQuestion` is **cosmetic**: the interception blocks
  the native picker with exit 2 (Claude Code labels any exit‑2 PreToolUse as a "hook
  error"), and `logger.info('Hook fired')` writes a JSON line to stderr that shows inside
  it. The answer still flows. Optional cleanup: downgrade that `logger.info` to `debug`.

---

## Verification status

- `node --check` passes for `hook.js`, `stopHook.js`, and the OpenCode plugin (all copies).
- #1 confirmed live: `transcript-paths/<session>.path` and `relay-pid-<session>.txt` now
  written for a question-led session.
- #2 logic-verified; mapping now persists across turns instead of vanishing on `Stop`.
- #3 pending end-to-end test in OpenCode (restart OpenCode, ask a choice, watch the debug
  log markers above).
