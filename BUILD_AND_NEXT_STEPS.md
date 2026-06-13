# Build & Next Steps — Multi-Harness Desktop

Two things in one place:

- **Part A — Deferred next step:** wire the `vibe run <harness>` PTY shim into the runtime so
  PTY-proxy harnesses (Gemini CLI, Pi, …) gate approvals, stream narrative, and receive mobile
  prompts **end to end**. (Designed, not yet implemented.)
- **Part B — Packaging with Electron Forge:** how to dev-run, package, and make an installer for
  this app, exactly like the original `my-app`.

---

# Part A — Next step: the `vibe run` PTY shim (DEFERRED)

## Why this is needed

Claude Code and OpenCode gate tools *inside their own process* (a settings hook / a plugin), so
the desktop never has to host them. **PTY-proxy harnesses have no such hook** — the only way to
intercept them is to run the CLI inside a pseudo-terminal we control. The plumbing already
exists (`harness-sdk/strategies/ptyProxy.js` + each PTY adapter's `interceptor.spawn()`); what's
missing is the **launcher** that the user runs instead of the bare CLI, plus **session
registration** and **mobile→PTY prompt delivery**.

```
Today:   user runs `gemini`  ───────────────► no interception possible
Goal:    user runs `vibe run gemini-cli` ───► PTY proxy gates + streams + injects
```

## Design

The PTY lives in the launcher process, so make that process **self-contained**: it registers a
session, hosts the PTY, and polls the server for prompts targeting *its* session. The heartbeat
does **not** need to change — PTY harnesses are fully encapsulated in the shim.

```
vibe-run.js (one per running Gemini/Pi session)
  ├─ register session  → POST /relay/agent-ping { sessionId, cwd, harness }
  ├─ interceptor.spawn(cwd, { sessionId })      // ptyProxy: gates + streams narrative
  │     • onData  → your terminal + POST /relay/terminal-event (narrative)
  │     • prompt detected → POST /relay/upload → poll /relay/status → write y/n
  ├─ stdin (raw) → PTY                            // you type normally
  └─ every 1.5s → GET /mobile/command/next?session=<id> → handle.inject(prompt)
```

## Implementation (drop-in, when you pick this up)

### 1. `relay-deamon1/vibe-run.js`

```js
#!/usr/bin/env node
/**
 * vibe run <harnessId> — launch a PTY-proxy harness under Vibe Remote interception.
 * Usage:  node vibe-run.js gemini-cli
 */
import { randomUUID } from 'node:crypto'
import { getAdapter } from './src/registry.js'
import { machineCtx } from './src/harness-sdk/index.js'
import { agentPing, getNextCommand } from './src/supabase.js'   // reuse existing helpers

const harnessId = process.argv[2]
if (!harnessId) { console.error('usage: vibe-run <harnessId>'); process.exit(1) }

const adapter = await getAdapter(harnessId)
if (!adapter?.interceptor?.spawn) {
  console.error(`${harnessId} is not a PTY-proxy harness`); process.exit(1)
}
if (!(await adapter.mobile.status()).enabled) {
  console.error(`Mobile support is OFF for ${harnessId} — enable it in the desktop app first.`)
  process.exit(1)
}

const sessionId = randomUUID()
const cwd = process.cwd()

// Register the session so it shows up in the app/mobile and can receive prompts.
await agentPing(sessionId, cwd, harnessId).catch(() => {})

// Launch the wrapped CLI inside the PTY (gating + narrative happen in here).
const handle = await adapter.interceptor.spawn(cwd, { sessionId })

// Forward your keystrokes into the PTY.
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on('data', (d) => handle.write(d.toString()))

// Poll for mobile-sent prompts targeting THIS session and inject them.
const poll = setInterval(async () => {
  try {
    const cmd = await getNextCommand()                 // see note ▼ about per-session filtering
    if (cmd?.prompt && (!cmd.sessionId || cmd.sessionId === sessionId)) {
      handle.inject(cmd.prompt)
    }
  } catch {}
}, 1500)

function shutdown() { clearInterval(poll); handle.stop(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
```

> **Server note:** `/mobile/command/next` is currently idle-gated and global. For PTY sessions
> add an optional `?session=<id>` filter (or a dedicated `/mobile/command/next/:sessionId`) so a
> prompt routes to the right running shim. The mobile `sendPrompt(prompt, sessionId)` already
> carries `sessionId`; the server just needs to honor it for PTY harnesses.

### 2. A friendly `vibe` command (optional)

Add a bin so users type `vibe run gemini-cli` instead of `node …/vibe-run.js`:

```jsonc
// relay-deamon1/package.json
"bin": { "vibe": "./vibe-cli.js" }   // vibe-cli.js parses `run <harness>` → imports vibe-run.js
```

Or have the **desktop** launch it: add an IPC `harness:launch` that spawns a terminal running
the shim in the user's chosen folder — mirrors `openNewTerminalWindow()` in `heartbeat.js`.

### 3. Capability honesty

Once the shim ships, the PTY adapters genuinely have narrative+injection at runtime, so their
manifests can keep `narrative: true, injection: true`. Until then, those are delivered **only**
while running through the shim — document that in the dashboard hint (already shown for
`approvalMechanism === 'pty-proxy'`).

## Definition of done for this step

- [ ] `vibe-run.js` launches Gemini inside the PTY; you can type normally.
- [ ] A risky command in Gemini → appears on the phone tagged `gemini-cli` → approve/deny writes
      the right keystroke (deny on timeout — fail-closed).
- [ ] Gemini output streams to the mobile Terminal tab.
- [ ] A prompt sent from mobile lands in the running Gemini session.
- [ ] `/mobile/command/next` honors `sessionId` for PTY routing.
- [ ] Closing the shim ends the session cleanly.

---

# Part B — Packaging with Electron Forge

This project was scaffolded from the original app, so the **Forge setup is already present and
identical**: `forge.config.js`, the `@electron-forge/*` dev-deps, the Vite plugin, and the
Squirrel/zip/deb/rpm makers. You build it the same way as before.

## Prerequisites

| Need | Why |
|---|---|
| **Node.js 18+** (20/22 fine) and npm | dev + build; also required at **runtime** on the end-user machine (the app spawns `node` for the heartbeat, the harness CLI, and the hook wrappers) |
| The agent CLIs (`claude`, `opencode`, `gemini`) | only the ones a user actually uses; the dashboard hides uninstalled ones |
| **Windows build tools** (VS Build Tools + Python) | *only* if you want `node-pty` to compile for the Gemini PTY proxy. It's an **optional** dependency — skip it and everything except PTY harnesses still works |

## Install

```bash
# Desktop app (Electron + React + Forge)
cd D:\Projects\vRdeksMultiharness
npm install

# Daemon (shipped as a resource, has its own deps)
cd relay-deamon1
npm install        # node-pty + @opencode-ai/sdk are optionalDependencies — build failures are non-fatal
cd ..
```

## Dev run

```bash
npm start
```

`electron-forge start` runs the Vite plugin (builds `src/main.js`, `src/preload.js`, and the
`main_window` renderer) and launches Electron with HMR on the renderer. In dev, `main.js`
resolves the daemon at `../../relay-deamon1` (the `app.isPackaged ? resources : ..` branch is
unchanged).

> First dev run with no `relay-deamon1/.env`: the app starts, you sign in, register the machine
> (writes the `.env`), and the heartbeat + harness reporting kick in. `harness:list` works even
> before registration (detection only).

## Package (unpacked app, no installer)

```bash
npm run package
# → out/VibeRemote-win32-x64/VibeRemote.exe
```

This produces a runnable folder. Use it to smoke-test the packaged layout before making an
installer.

## Make (distributable installer)

```bash
npm run make
# Windows → out/make/squirrel.windows/x64/VibeRemoteSetup.exe
# (macOS zip / Linux deb+rpm makers are configured too, build on those OSes)
```

## What gets shipped (and how the new harness code rides along)

From `forge.config.js`:

- `asar: true` and an `ignore` function that keeps only `.vite/` + `package.json` inside the asar
  (the renderer/main/preload bundles).
- **`extraResource: ['relay-deamon1']`** — the entire daemon is copied to
  `resources/relay-deamon1/`. **All the new multi-harness files live inside `relay-deamon1/`**
  (`harness-cli.js`, `src/harness-sdk/`, `src/harnesses/`, `src/registry.js`), so they ship
  automatically with **no Forge changes needed**.
- A `postPackage` hook that, in the packaged daemon, strips: the dev `.env`, `.git`,
  `node-addon-api`, `@types`, `undici-types`, and trims `node-pty` to the `win32-x64` runtime
  (removing `.pdb` and build/src/deps dirs). This already anticipates `node-pty`, which is now a
  declared optional dep — no change required.

## Runtime assumptions (unchanged from the old app)

- The end user has **Node on PATH** (the app spawns `node` for the heartbeat, `harness-cli.js`,
  and the Claude Code hook wrappers).
- The user has whichever **agent CLIs** they want to drive. Uninstalled harnesses are detected
  as `installed: false` and hidden in the dashboard.
- Per-install secrets live in `resources/relay-deamon1/.env`, generated on first registration
  (the dev `.env` is stripped at package time).

## Versioning, icons, publish

- Bump `version` in the **root** `package.json` (Squirrel uses it). The daemon has its own
  `version` (now `1.1.0`) for the relay package.
- `setupIcon` is currently `undefined` in the Squirrel maker — set it to an `.ico` to brand the
  installer.
- `npm run publish` is wired to Forge's publisher flow if/when you configure a target (e.g.
  GitHub releases for Squirrel auto-update).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `harness:list` returns `[]` in the packaged app | `node` not on the user's PATH, or `relay-deamon1` missing from `resources/`. Confirm `out/.../resources/relay-deamon1/harness-cli.js` exists. |
| Gemini toggle appears but approvals never fire | `node-pty` didn't build/ship (optional). Install Windows build tools and reinstall in `relay-deamon1`, or accept that PTY harnesses are unavailable on that machine. |
| OpenCode narrative/injection silent | `@opencode-ai/sdk` not installed, or `opencode serve` not reachable at `OPENCODE_URL` (default `http://localhost:4096`). Approvals (the plugin) still work regardless. |
| Squirrel `make` fails with a SharpCompress/Deflate error | A large/zero-byte file slipped into the daemon's `node_modules`. The `postPackage` hook already trims the known offenders (`node-pty` pdbs, `node-addon-api`); add any new culprit there. |
| Claude Code stopped intercepting after an app update | Squirrel changed the install dir; `refreshHookPathIfEnabled()` rewrites the hook paths on launch — just reopen the app. |

---

## See also

- `HARNESS_IMPLEMENTATION.md` — what was built and the file map.
- `HARNESS_PLATFORM_ARCHITECTURE.md` — the design (strategies, capabilities, conformance).
- `MULTI_HARNESS_GUIDE.md` — the server + mobile changes needed to complete the end-to-end loop.
