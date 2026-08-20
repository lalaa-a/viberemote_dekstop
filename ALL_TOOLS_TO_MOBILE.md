# Route ALL permission-requiring tools to mobile — Implemented

## The problem

With Claude Code mobile support enabled, some tool calls **still needed a manual CLI accept** —
`WebFetch`, `WebSearch`, and anything else outside a short hard-coded list. They never reached the
phone at all.

Two independent things caused this:

1. **The hook matcher was a fixed list.** The `PreToolUse` matcher was
   `Bash|Write|Edit|MultiEdit|Read|AskUserQuestion`, so any other tool — `WebFetch`, `WebSearch`,
   `Task`, MCP tools (`mcp__*`), plugin tools — simply didn't fire the hook and fell through to
   Claude Code's native `Allow? [y/n]` prompt.
2. **A bare `exit 0` doesn't suppress the native prompt.** Even for the listed tools, what actually
   hides Claude's own prompt is `settings.json` `permissions.allow` (`Bash(*)`, `Write(*)`, …). The
   hook's `process.exit(0)` only means "hook succeeded"; Claude then runs its *normal* permission
   flow. So a tool that isn't in `permissions.allow` would prompt in the CLI even if the hook
   approved it. (Per the official docs, a PreToolUse hook must return
   `hookSpecificOutput.permissionDecision: "allow"` to actually bypass the prompt.)

## The fix

**Match every tool, auto-allow the read-only ones, and approve the rest via `permissionDecision`.**

- **Matcher → `'*'`** (matches all tools, per the hooks docs). Now `WebFetch`, `WebSearch`, `Task`,
  MCP tools, and any future/plugin tool reach the hook → the phone.
- **Read-only tools are auto-allowed** in `preFilter` (`Glob`, `Grep`, `LS`, `TodoWrite`,
  `TodoRead`, `NotebookRead`, `BashOutput`) so matching `'*'` doesn't spam the phone with approvals
  for tools Claude auto-approves anyway. (`Read` is intentionally NOT in this list — it keeps going
  to mobile exactly like before.)
- **The approve path emits `permissionDecision: "allow"`** (new `approveExit()` in `hook.js`),
  making the hook the *sole* permission authority. Once the phone approves — or `preFilter`
  auto-allows a read-only tool — the tool runs with **no manual CLI accept**, for every tool, not
  just the handful in `permissions.allow`.

Net effect: everything Claude Code would otherwise prompt for now goes to the phone. Read-only
searches/lists stay silent. Nothing needs a manual terminal accept.

## Files changed (`relay-deamon1/`)

| File | Change |
|---|---|
| `src/harnesses/claude-code/provider.js` | `PreToolUse` **and** `PostToolUse` matcher → `'*'`. |
| `src/filter.js` | New exported `READONLY_TOOLS` set; `preFilter` auto-allows them (before the default `ask`). |
| `hook.js` | New `approveExit()` emitting `permissionDecision:"allow"`; the three approve paths (preFilter-allow, allow-all, mobile-approved) now use it instead of a bare `exit 0`. |
| `postHook.js` | Matches `'*'` now; skips posting a `tool_end` for the read-only tools (no orphan feed rows) but still runs the stop check. Adds `WebFetch`/`WebSearch`/`Task` result summaries. |
| `src/parsers.js` | `genericSummary()` gives clean approval-card text for `WebFetch`/`WebSearch`/`Task`/MCP tools (kept `display_type:'unknown'` so the mobile fallback card renders unchanged). |
| `src/risk.js` | Sensible risk level + icon for `WebFetch` 🌐 / `WebSearch` 🔎 / `Task` 🤖 / `mcp__*` 🔌 instead of "Unknown tool type". |

### Desktop (`src/main.js`)
There are **two copies of `buildHookBlock()`** that write `settings.json` and must stay in sync:
`main.js` (used by the legacy toggle + `refreshHookPathIfEnabled()`) and `provider.js` (used by the
harness-cli path). Both are now `'*'`. Because `refreshHookPathIfEnabled()` runs on **every launch**,
an already-enabled Claude Code picks up the widened matcher automatically after the update — **no
manual re-toggle required**.

## Notes / trade-offs

- **Applies after an update on next launch** (via `refreshHookPathIfEnabled()`), or immediately on
  the next enable/toggle. Requires the packaged `relay-deamon1` to be rebuilt/shipped.
- **`permissions.allow` is now redundant** (the hook force-allows via `permissionDecision`), but is
  left in place — harmless, and it keeps the native prompt suppressed even before the hook returns.
- **Performance:** read-only tools (`Glob`/`Grep`/…) now fire the hook and exit fast (auto-allow).
  That adds a small per-call overhead vs. never firing. If it ever matters, a negative-lookahead
  matcher (`^(?!(?:Glob|Grep|LS|TodoWrite|TodoRead|NotebookRead|BashOutput)$).+`) would exclude them
  from firing entirely — kept as `'*'` here for simplicity and to guarantee nothing slips through.
- **Scope:** this is the **Claude Code** path (settings.json hooks), which is what the report was
  about. OpenCode uses a different plugin mechanism and isn't touched here.

## To verify (after a rebuild)

1. Enable Claude Code mobile support; relaunch the desktop app.
2. `~/.claude/settings.json` → `hooks.PreToolUse[0].matcher` is `"*"`.
3. In the CLI, ask Claude to fetch a URL or run a web search → the approval appears **on the phone**,
   not as a CLI `Allow?` prompt. Approve → it runs with no terminal interaction.
4. Ask it to grep/glob around → those run silently (no phone spam).
