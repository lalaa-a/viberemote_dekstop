# Close-to-tray + harness cleanup on quit — Implemented

## The problem

Closing the desktop app used to **quit** it (`window-all-closed → app.quit()`), which left every
enabled harness's mobile hooks in place — Claude Code's `settings.json` hooks and OpenCode's
plugin stayed installed. With no heartbeat running, the CLIs kept intercepting tool calls with
nothing behind them: approvals hang, prompts can't be injected, the local CLI is degraded even
though the user isn't using mobile.

## The behaviour now

- **Close (the window's X / custom title-bar close)** → the app **hides to the system tray**.
  The heartbeat keeps running and **mobile support keeps working**. Nothing is disabled.
- **Quit (tray → "Quit Vibe Remote", or Cmd+Q / OS shutdown)** → the app **disables mobile
  support for every enabled harness** (removes the hooks / plugin so the CLIs behave normally),
  then exits.
- **Relaunch** → the harnesses that were auto-disabled on quit are **re-enabled**, so mobile
  support resumes seamlessly. The user never has to re-toggle.

So harnesses are on exactly while the app is running (window shown *or* in the tray), and off
while it's fully closed.

## What changed

### `relay-deamon1/harness-cli.js` — two new commands
- **`disable-all`** — disables mobile support for every currently-enabled harness and writes the
  set it turned off to `<runtime>/mobile-restore.json`, then reports the new state.
- **`restore`** — re-enables the harnesses listed in `mobile-restore.json` (only if not already
  on), deletes the file, and reports.

### `src/main.js` — tray + lifecycle
- Imports `Tray, Menu, nativeImage`.
- Module state: `mainWindow`, `tray`, `isQuitting`, `appReady`, and a `TRAY_ICON` path
  (packaged: `process.resourcesPath/vibeRemote_icon.png`; dev: the source asset).
- `createWindow()` keeps the window in `mainWindow` and, on `close`, **`preventDefault()` +
  `hide()`** unless a real quit is in progress.
- `createTray()` — tray icon + context menu (**Show Vibe Remote** / **Quit Vibe Remote**);
  left-click shows the window.
- `gracefulQuit()` — the single real-exit path: sets `isQuitting`, runs `disable-all` (capped at
  5s via `Promise.race` so a hung CLI can't stall the quit), then `app.quit()`.
- On launch: runs **`restore`** (before `report`) to bring back the previously-enabled harnesses,
  and creates the tray.
- `before-quit` → if not already quitting **and the app is ready**, cancels the quit and calls
  `gracefulQuit()`; otherwise runs the normal cleanup (`stopHeartbeat`, clear the apply timer).
  The `appReady` guard skips this during the Squirrel install/uninstall early-quit.
- `window-all-closed` → **no-op** (stay alive in the tray).

### `forge.config.js`
- Added `src/assets/logo/vibeRemote_icon.png` to `extraResource` so the tray icon exists in
  packaged builds (`src/` is otherwise excluded from packaging).

## Interactions & edge cases handled

- **Custom frameless close button** (`window:close` IPC → `BrowserWindow.close()`) now hits the
  `close` handler → hides to tray, same as the OS chrome.
- **Squirrel install/uninstall** calls `app.quit()` before the app is ready; the `appReady`
  guard lets that quit through without running `disable-all`. (On uninstall, `RELAY_ENV` is gone
  or the check is skipped, so nothing hangs.)
- **Hung / offline CLI on quit** — the 5s `Promise.race` cap means the app still quits promptly.
- **Fast offline propagation** — on quit, `stopHeartbeat()` kills the heartbeat; its socket
  dies → Realtime **presence `leave`** flips the machine offline on the phone within seconds
  (and on POSIX its SIGTERM handler also `untrack()`s + `markOffline()`s). Composes with
  `INSTANT_OFFLINE_AND_HARNESS_UPDATES.md`.
- **Crash / force-kill** — `disable-all` can't run if the process is SIGKILL'd; that's
  unavoidable. The design covers the normal *close/quit* path the user described.

## To verify (after a rebuild)

1. Enable a harness, **close the window** → it disappears to the tray; the phone still shows the
   session working / online (heartbeat alive).
2. Open the CLI's `~/.claude/settings.json` — hooks still present while in the tray.
3. Tray → **Quit** → `settings.json` hooks are gone / OpenCode plugin removed; the CLIs behave
   normally.
4. **Relaunch** → the harness is enabled again automatically; the phone shows it online.

Requires a rebuild of the Electron app (`main.js`, `forge.config.js`) and the packaged
`relay-deamon1` (harness-cli).
