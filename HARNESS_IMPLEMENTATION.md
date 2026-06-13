# Multi-Harness Desktop — Implementation Notes

This codebase is the multi-harness build of the Vibe Remote desktop app, implementing the
design in **`HARNESS_PLATFORM_ARCHITECTURE.md`**. It was scaffolded from the original
single-harness (`my-app`) app and extended so mobile support can be toggled **independently
per coding agent** (Claude Code, OpenCode, Gemini CLI, …) without breaking the proven Claude
Code path.

> Design rationale lives in `HARNESS_PLATFORM_ARCHITECTURE.md` and `MULTI_HARNESS_GUIDE.md`.
> This file is the "what actually got built and how to run it" companion.

---

## What changed vs. the original app

| Area | Original | Now |
|---|---|---|
| Interception model | Claude Code hardcoded in `main.js` + `relay.cjs` | Pluggable **harness adapters** behind a **Harness SDK** |
| Desktop toggle | One "Claude Code Interception" switch | One switch **per installed harness** |
| Adding a harness | Edit core files | Drop a folder in `relay-deamon1/src/harnesses/<id>/` |
| Harnesses supported | Claude Code | Claude Code, OpenCode, Gemini CLI (+ trivial to add more) |
| main.js ↔ daemon | spawns heartbeat | also spawns `harness-cli.js` for list/enable/disable |

**The original Claude Code path is preserved byte-for-byte.** The Claude Code adapter wraps
the existing `hook.js`, `*-wrapper.cjs`, and `heartbeat.js` unchanged; it only moves the
`settings.json` install/remove logic behind the SDK's `SettingsHookStrategy`. The legacy
`relay:getHookStatus` / `relay:setHookEnabled` IPC handlers are still present as shims.

---

## New file map (all under `relay-deamon1/`)

```
harness-cli.js                     # bridge the Electron main process spawns
src/registry.js                    # auto-discovers adapters, validates, lists
src/harness-sdk/                   # the stable contract every adapter compiles against
  index.js                         #   re-exports everything below
  env.js                           #   loose .env loader + machineCtx() (never exits)
  transport.js                     #   the ONE place adapters hit the VPS (/relay, /harness)
  schema.js                        #   canonical RelayRequest / NarrativeEvent + validation
  validate.js                      #   capability ↔ implementation contract (SDK_VERSION)
  strategies/
    settingsHook.js                #   Claude Code  (settings.json + exit-code hooks)
    plugin.js                      #   OpenCode     (JS plugin + flag file)
    ptyProxy.js                    #   Gemini/Pi    (wrap CLI in node-pty, parse prompts)
    null.js                        #   read-only / flag-only lifecycle
src/harnesses/
  claude-code/   provider.js  manifest.json
  opencode/      provider.js  manifest.json  plugin/relay.js
  gemini-cli/    provider.js  manifest.json  grammar.js
```

Desktop changes: `src/main.js` (harness IPC + report/apply-desired loops),
`src/preload.js` (`window.harness`), `src/components/Dashboard.jsx` (per-harness toggle list),
`src/index.css` (`.harness-row`).

---

## How it works at runtime

1. **List.** `Dashboard` calls `window.harness.list()` → main.js spawns
   `node harness-cli.js list` → `registry.listInstalled()` runs each adapter's `detect()`
   and `mobile.status()` → returns `[{harness, displayName, version, installed,
   mobile_enabled, capabilities}]`. The dashboard renders a toggle only for **installed**
   harnesses.
2. **Toggle.** Flipping a switch → `window.harness.setMobile(id, enable)` → main.js spawns
   `harness-cli.js enable|disable <id>` → the adapter's `mobile.enable(ctx)` / `disable()`:
   - **Claude Code** writes/removes the hook block in `~/.claude/settings.json`.
   - **OpenCode** copies `plugin/relay.js` + env JSON + flag into `~/.config/opencode/plugin/`.
   - **Gemini CLI** writes a flag file; gating happens when launched via the PTY shim.
   The CLI then POSTs the new inventory to the server (`/harness/report`).
3. **Approvals** flow exactly as before through `/relay/upload` + `/relay/status`, now stamped
   with a `harness` field so the phone can label and route them.
4. **Remote toggle (optional).** main.js polls `harness-cli.js apply-desired` every 15s; if the
   phone set `desired_enabled` on the server, the desktop applies it and reports back.

---

## Running it

```bash
# 1. Desktop app deps
cd D:\Projects\vRdeksMultiharness
npm install

# 2. Daemon deps (node-pty + @opencode-ai/sdk are OPTIONAL — only needed for
#    Gemini PTY proxy / OpenCode SDK narrative+injection; install failures are non-fatal)
cd relay-deamon1
npm install

# 3. Dev run
cd ..
npm start
```

Quick daemon-only sanity check (no app, no .env needed):

```bash
cd relay-deamon1
npm run harness:list          # detects which agent CLIs are installed
node harness-cli.js status claude-code
```

> Verified on Node 22: `harness-cli.js list` discovers all three adapters, detects installed
> CLIs, and an `enable → status → disable` round-trip works. A bad/incomplete adapter is
> logged and skipped by the registry rather than crashing the list.

---

## Server + mobile (still required, see the guides)

This repo is the **desktop** half. To light up the per-harness state end to end you also need
the additive server + DB changes from `MULTI_HARNESS_GUIDE.md §3–4` and
`HARNESS_PLATFORM_ARCHITECTURE.md §8`:

- `pending_requests` / `agents` / `terminal_events` get a `harness` column (default
  `'claude-code'` → existing rows unaffected).
- New `machine_harnesses` table + `/harness/*` routes (`report`, `desired`, `:machineId`,
  `:machineId/desire`).
- The OpenCode plugin and the harness-cli POST to `/relay/upload` and `/harness/report`; until
  the server routes exist, toggles still work locally but the phone won't see harness state.

The mobile app stays harness-agnostic: render by `capabilities`, badge by `harness`.

---

## Adding the next harness (e.g. Pi)

1. `relay-deamon1/src/harnesses/pi/manifest.json` — declare honest `capabilities` +
   `approvalMechanism` (`pty-proxy` if it's a bare CLI, `api` if it has a server).
2. `provider.js` — compose a shared strategy (≤ ~80 lines). For a bare CLI: `ptyProxyStrategy`
   + a `grammar.js` describing its approval prompt.
3. Done — the registry discovers it; the dashboard shows it when `detect()` says installed.
   No edits to core, server, mobile, or other adapters.

See `HARNESS_PLATFORM_ARCHITECTURE.md §7` for the full worked Gemini example, and `§9` for the
conformance rules that keep Claude Code safe.

---

## Notes / caveats

- **node-pty / @opencode-ai/sdk are optional deps.** The PTY proxy and OpenCode SDK
  narrative/injection load them lazily and degrade gracefully if absent (approvals still work).
  `forge.config.js`'s `postPackage` already trims node-pty for packaging.
- **Gemini grammar is illustrative.** The approval-prompt regexes in
  `harnesses/gemini-cli/grammar.js` must be derived against the installed Gemini CLI version;
  PTY gating fails **closed** by design.
- **Claude Code conformance.** The Claude Code adapter must keep emitting the exact legacy
  `settings.json` hook block. Treat changes to `harnesses/claude-code/provider.js` as
  high-risk and verify against the original `main.js buildHookBlock()`.
