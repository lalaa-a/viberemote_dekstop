# External Paths Audit — consolidating `C:\temp\` and friends

**Goal:** the app scatters runtime files across `C:\temp\` (and a couple of other
machine-wide spots). You want them "inside the installation directory" — tidy, app-owned,
not littering the disk. This audit lists every external path, explains which can move,
and gives a concrete plan.

---

## ✅ IMPLEMENTED (2026-07-19)

`C:\temp\*` and the hardcoded `C:\Users\lala` fallback are gone. All runtime/coordination
files now live under **`%LOCALAPPDATA%\VibeRemote\{runtime,logs}\`** (per-user, writable,
tidy). Verified end-to-end: OpenCode approval + chat entry both work.

### What changed

**New shared modules — single source of truth (computed from `os.homedir()`):**
- `relay-deamon1/src/paths.js` (ESM) + `src/paths.cjs` (CJS twin) — export `RUNTIME_DIR`,
  `LOG_DIR`, `runtimePath()`, `logPath()`, `ensureDirs()`.
  - `runtime` → `%LOCALAPPDATA%\VibeRemote\runtime` (flags, pending, PID files, transcript maps)
  - `logs`    → `%LOCALAPPDATA%\VibeRemote\logs` (hook-debug.log, heartbeat.log, inject-log.txt)

**`C:\temp` → runtime/logs across every file that used it:**
- ESM: `hook.js`, `postHook.js`, `stopHook.js`, `notifyHook.js`, `scripts/heartbeat.js`
  (including the PowerShell inject/interrupt scripts), `src/supabase.js`,
  `src/harnesses/claude-code/provider.js`.
- CJS: `relay.cjs`, `decide.cjs`, all four `*-wrapper.cjs`.
- Isolated (can't import — inline the identical formula, with "keep in sync" comments):
  `src/harnesses/opencode/plugin/relay.js` (copied out to OpenCode's dir) and Electron
  `src/main.js` (uses `os.homedir()`, **not** `app.getPath('userData')` which is Roaming).

**`C:\Users\lala` fallback fixed:** `relay.cjs` `SETTINGS_FILE` now uses `os.homedir()`.
Throwaway PowerShell scratch scripts now fall back to `os.tmpdir()` instead of `C:\temp`.

### Verification done
- No hardcoded `C:\temp` / `C:\Users\lala` left in source; all 16 edited files `node --check` clean.
- All four independent path computations (paths.js, paths.cjs, plugin inline, main.js inline)
  resolve to the **identical** directory — so cross-process coordination can't drift.
- Ran `harness-cli list`, `relay.cjs status`, and a live `hook.js` fire → files landed in
  `%LOCALAPPDATA%\VibeRemote\{runtime,logs}`, not `C:\temp`.

### ⚠️ Gotcha found & fixed: the OpenCode plugin goes STALE
The OpenCode plugin is **copied** to `~/.config/opencode/plugin/vibe-relay.js` and only
re-copied when mobile mode is toggled. After this path change the **installed copy stayed
stale** — still writing PID/busy/ready flags to `C:\temp` while the updated heartbeat read
the new `runtime` dir. Result: `reportSessionLiveness()` never saw the session → server
marked `cli_alive=false` → **the approval "changes screen" appeared but no chat entry was
created** (the upload path is file-independent, the liveness path is not).

**Fix:** added `syncOpencodePluginFile()` to `scripts/heartbeat.js` — a twin of the existing
`syncOpencodePluginEnv()` self-heal. On launch and every 30s tick it re-copies the plugin
from the shipped source whenever the installed copy differs, so the plugin **auto-heals
after every app update** (this staleness could bite on any future plugin change, not just
this one). Applies to a plugin that is already installed; first install is still `enable()`'s job.

> Note: after an app update the fix takes effect once the **new heartbeat runs** (app
> restart) and OpenCode is **restarted** to load the refreshed plugin.

---

## ⚠️ Read this first: the install dir is the WRONG target (and why)

Your app now installs to **`C:\Program Files\VibeRemote`** (`perMachine: true`).
**`C:\Program Files` is read-only for standard (non-admin) users.** A normal user running
the app cannot create/modify files there — Windows blocks it. If we moved the `C:\temp`
coordination files into the install dir, the app would **fail for every non-admin user**
(approvals would hang, logs wouldn't write). This is also explicitly against Windows app
conventions.

So we honor your *intent* — stop littering `C:\temp`, keep everything app-owned in ONE
tidy place — but target the correct per-user, writable location instead:

| Purpose | Correct location | Env expansion |
|---------|------------------|---------------|
| Transient runtime/coordination (flags, pending, PIDs) | `%LOCALAPPDATA%\VibeRemote\runtime\` | `C:\Users\<you>\AppData\Local\VibeRemote\runtime` |
| Logs | `%LOCALAPPDATA%\VibeRemote\logs\` | `C:\Users\<you>\AppData\Local\VibeRemote\logs` |
| Machine credentials (already external — leave as-is) | `%APPDATA%\Roaming\VibeRemote\machine.env` | (survives reinstall — do NOT move) |

`%LOCALAPPDATA%` is per-user, always writable without admin, tidy (one folder), and
removed cleanly. Transient files go in **Local** (not Roaming) so they never sync across
machines in a domain. This mirrors the pattern the app **already** uses for `machine.env`.

---

## The hard constraint: these are CROSS-PROCESS coordination files

`C:\temp\` wasn't a lazy choice — it's a **rendezvous point shared by independent
processes** that don't share memory and are started by different parents:

- **Claude Code hooks** (`hook.js`, `postHook.js`, …) — spawned by *Claude Code*, not by our app.
- **The heartbeat** (`scripts/heartbeat.js`) — spawned by our Electron app.
- **`relay.cjs` / `decide.cjs`** — run manually by the user (`! node relay.cjs 1`).
- **The OpenCode plugin** (`plugin/relay.js`) — runs *inside OpenCode's* process, from a
  copied-out file in `~/.config/opencode/plugin/`.
- **Electron `main.js`**.

They coordinate by reading/writing the **same files** (busy/ready/stop flags, pending
requests, PID files, allow-all, transcript maps). Therefore **every process must compute
the exact same directory, independently.** `C:\temp` was trivially agreed-upon.

The replacement must keep that property: derive the path from a formula every process can
compute identically — `os.homedir()` + `AppData\Local\VibeRemote`. (This is exactly how
`machineEnv.js` already computes `machine.env` across processes.) **Critical:** do NOT use
`app.getPath('userData')` in `main.js` for this — that returns the **Roaming** dir and
would mismatch the daemon's Local path, silently breaking coordination.

---

## Full inventory

### Category A — our runtime/coordination files under `C:\temp` → **MOVE these**

| File | What it stores in `C:\temp` |
|------|------------------------------|
| `relay-deamon1/hook.js` | `relay-pending/`, `relay-current.txt`, `relay-allow-all.txt`, `transcript-paths/`, `relay-stop-*.flag`, `relay-busy-*.flag`, `relay-pid-*.txt`, `relay-current-question.json`, `hook-debug.log` |
| `relay-deamon1/postHook.js` | `transcript-paths/`, `relay-stop-*.flag`, `relay-busy-*.flag` |
| `relay-deamon1/stopHook.js` | `transcript-paths/`, `relay-busy/ready/stop-*.flag` |
| `relay-deamon1/notifyHook.js` | `transcript-paths/` |
| `relay-deamon1/*-wrapper.cjs` (×4) | `hook-debug.log` |
| `relay-deamon1/relay.cjs` | `TEMP_DIR`, `relay-pending/`, `relay-current.txt`, `relay-allow-all.txt` |
| `relay-deamon1/decide.cjs` | `relay-pending/` |
| `relay-deamon1/scripts/heartbeat.js` | `heartbeat.log`, `inject-log.txt`, `relay-busy/stop-*.flag`, `relay-pid-*.txt`, `transcript-paths/`, plus `readdir`/cleanup of `C:\temp` |
| `relay-deamon1/src/supabase.js` | `relay-pending/` (question pending dir) |
| `relay-deamon1/src/harnesses/claude-code/provider.js` | `relay-allow-all.txt` |
| `relay-deamon1/src/harnesses/opencode/plugin/relay.js` | `PID_DIR = C:\temp` — **ISOLATED FILE** (see note) |
| `src/main.js` (Electron) | `relay-allow-all.txt`, `heartbeat.log`, `mkdir C:\temp` |

### Category B — third-party locations we must write to → **CANNOT move**

| Path | Owner | Why it stays |
|------|-------|--------------|
| `~/.claude/settings.json` | Claude Code | We inject/remove our hook block here; Claude Code dictates the path (`main.js`, `relay.cjs`, `claude-code/provider.js`). |
| `~/.config/opencode/plugin/` | OpenCode | OpenCode auto-loads plugins from here; we must install `vibe-relay.js` + flag there (`opencode/provider.js`, `plugin/relay.js`). |

### Category C — our per-user state (already external) → **leave / optional tidy**

| Path | Verdict |
|------|---------|
| `%APPDATA%\Roaming\VibeRemote\machine.env` | **Keep.** Intentionally in userData so it survives reinstalls (`machineEnv.js`). Must NOT go in the install dir. |
| `~/.config/vibe-remote/gemini-cli.on` | Optional: could fold under `%LOCALAPPDATA%\VibeRemote\`, minor. |

### Category D — bugs/smells found while auditing → **fix**

| File:line | Issue |
|-----------|-------|
| `relay-deamon1/relay.cjs:23` | Hardcoded fallback `'C:\\Users\\lala'` — leaks the dev's username and is wrong on any other machine. Replace with `os.homedir()`. |
| `dist-installer/builder-debug.yml` | Build-tool temp references — generated output, not source. Ignore. |

---

## Migration plan

### 1. Add one shared path module — `relay-deamon1/src/paths.js`
Computes the dirs from `os.homedir()` (NOT `import.meta.url`), so it is **bundling-safe**
(can be inlined into every entry — unlike the depth-sensitive `machineEnv.js`).

```js
// src/paths.js
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

function localAppData() {
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Local')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  return path.join(os.homedir(), '.local', 'share')
}

export const APP_DIR     = path.join(localAppData(), 'VibeRemote')
export const RUNTIME_DIR = path.join(APP_DIR, 'runtime')
export const LOG_DIR     = path.join(APP_DIR, 'logs')

export function ensureDirs() {
  for (const d of [RUNTIME_DIR, LOG_DIR]) { try { fs.mkdirSync(d, { recursive: true }) } catch {} }
}

// Named helpers so every process derives identical paths:
export const pendingDir      = ()      => path.join(RUNTIME_DIR, 'relay-pending')
export const currentFile     = ()      => path.join(RUNTIME_DIR, 'relay-current.txt')
export const allowAllFile    = ()      => path.join(RUNTIME_DIR, 'relay-allow-all.txt')
export const transcriptDir   = ()      => path.join(RUNTIME_DIR, 'transcript-paths')
export const busyFlag        = (s)     => path.join(RUNTIME_DIR, `relay-busy-${s}.flag`)
export const readyFlag       = (s)     => path.join(RUNTIME_DIR, `relay-ready-${s}.flag`)
export const stopFlag        = (s)     => path.join(RUNTIME_DIR, `relay-stop-${s}.flag`)
export const pidFile         = (s)     => path.join(RUNTIME_DIR, `relay-pid-${s}.txt`)
export const hookDebugLog    = ()      => path.join(LOG_DIR, 'hook-debug.log')
export const heartbeatLog    = ()      => path.join(LOG_DIR, 'heartbeat.log')
export const injectLog       = ()      => path.join(LOG_DIR, 'inject-log.txt')
```

### 2. Replace Category-A hardcodes with imports from `paths.js`
All ESM consumers (`hook.js`, `postHook.js`, `stopHook.js`, `notifyHook.js`,
`scripts/heartbeat.js`, `src/supabase.js`, `claude-code/provider.js`) import the helpers.

### 3. Handle the CJS + isolated files (the tricky ones)
- **CJS entries** (`relay.cjs`, `decide.cjs`, the 4 `*-wrapper.cjs`): they use `require`,
  not `import`. Either add a sibling `src/paths.cjs` they `require`, or inline the ~6-line
  formula. (Both bundle fine — computed from `os.homedir()`.)
- **`src/harnesses/opencode/plugin/relay.js`** is **copied out** to
  `~/.config/opencode/plugin/vibe-relay.js` and runs isolated — it **cannot import**
  `paths.js`. It must inline the same `os.homedir()`-based formula so it lands on the
  identical `RUNTIME_DIR`.
- **`src/main.js`** (Electron): compute `RUNTIME_DIR`/`LOG_DIR` with the **same formula**
  (`os.homedir()` + `AppData\Local\VibeRemote`). Do **not** use `app.getPath('userData')`
  (that's Roaming → would mismatch the daemon).

### 4. Startup: create dirs + migrate
- Call `ensureDirs()` early (Electron `main.js` boot, and defensively in each hook).
- Optional one-time migration: move any leftover `C:\temp\relay-*`/`transcript-paths` into
  the new `RUNTIME_DIR`, then remove them, so in-flight sessions don't lose state on upgrade.

### 5. Fix the `C:\Users\lala` fallback (`relay.cjs:23`) → `os.homedir()`.

---

## Interaction with the bundling work (Option A) — already checked

- `paths.js` derives everything from `os.homedir()`, so it is **NOT depth-sensitive** and is
  safe to inline into every bundle (unlike `machineEnv.js`, which stays external).
- No change to the external set in `forge/bundleRelay.cjs` is needed.

---

## Risks & how to verify

1. **All processes must agree on the path (highest risk).** If one process computes a
   different dir, coordination silently breaks — a hook writes a busy flag the heartbeat
   never sees, and approvals hang. Every consumer must use the **same formula**. The
   isolated OpenCode plugin and Electron `main.js` are the two most likely to drift.
2. **Verify end-to-end after the change:**
   - Enable mobile mode; trigger a Claude Code tool call → hook writes to
     `%LOCALAPPDATA%\VibeRemote\runtime\`, phone gets it, approval flows back.
   - Confirm `relay.cjs 1/3` still resolves a pending request (same dir).
   - Confirm the heartbeat's busy/idle + inject/interrupt flags still coordinate.
   - Confirm the OpenCode plugin path writes land in the same `runtime` dir.
   - Confirm logs appear under `…\VibeRemote\logs\`.
3. **Cross-platform:** the formula covers win/mac/linux, but this app is Windows-primary;
   test there first.

---

## Summary

| | |
|---|---|
| Move `C:\temp\*` → | `%LOCALAPPDATA%\VibeRemote\{runtime,logs}\` (per-user, writable, tidy) |
| Do NOT move into | `C:\Program Files\VibeRemote` (read-only for standard users) |
| Leave alone | `machine.env` (Roaming, survives reinstall), Claude/OpenCode third-party dirs |
| Also fix | hardcoded `C:\Users\lala` fallback in `relay.cjs` |
| Files touched | ~14 (all of Category A) + `main.js` + new `paths.js`/`paths.cjs` |
| Bundling impact | none — `paths.js` is inline-safe |
