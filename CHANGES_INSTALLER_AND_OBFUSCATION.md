# Changes: Wizard Installer + Source Protection

This document records the concrete changes made to give **VibeRemote** a proper Windows
setup wizard (installs to `Program Files`) and to protect the `relay-deamon1` core logic
that ships outside the asar.

---

## 1. Wizard Installer (electron-builder + NSIS)

### Why
The project shipped with `@electron-forge/maker-squirrel` (Squirrel.Windows), which installs to
`%LocalAppData%` with **no wizard**. To install into `C:\Program Files` with a proper
Welcome → Folder → Install → Finish wizard, we wrap the Forge-packaged app with **electron-builder
NSIS**.

### Key design decision: `--prepackaged`
Forge already does critical work a plain electron-builder run doesn't know about:
- ships `relay-deamon1` as an `extraResource` (outside the asar),
- runs a `postPackage` cleanup hook,
- applies Electron Fuses.

So we let **Forge package the app**, then point **electron-builder at the finished folder** with
`--prepackaged`. electron-builder only builds the NSIS installer around it — it does **not**
re-package from source (which would have broken relay-deamon1 and skipped the cleanup/fuses).

### Files changed

**`package.json`** — added a build script and rewired `dist`:
```jsonc
"build:vite": "electron-forge package",
"dist": "npm run build:vite && electron-builder --win --prepackaged \"out/VibeRemote-win32-x64\" --config electron-builder.yml"
```
- `build:vite` runs `electron-forge package` → produces the finished app in `out/VibeRemote-win32-x64/`.
- `dist` then wraps that folder into an NSIS installer.
- Also added `electron-builder` (dev dependency).

**`electron-builder.yml`** (new) — installer config only (packaging is owned by Forge):
```yaml
appId: com.spiralware.viberemote
productName: VibeRemote
copyright: Copyright © 2026 spiralware

directories:
  output: dist-installer

win:
  target:
    - nsis

nsis:
  oneClick: false                          # multi-step wizard
  perMachine: true                         # installs to C:\Program Files (UAC)
  allowToChangeInstallationDirectory: true # user can pick the folder
  allowElevation: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  runAfterFinish: true
```
> `files` / `asar` / `asarUnpack` were intentionally removed — they are ignored under
> `--prepackaged` and Forge owns packaging.

### How to build
```bash
npm run dist
```
Output: **`dist-installer/VibeRemote Setup 1.4.0.exe`**

Result: multi-page wizard, installs to `C:\Program Files\VibeRemote` (UAC prompt),
Desktop + Start Menu shortcuts, and an entry in "Installed apps" with an uninstaller.

---

## 2. Source Protection for `relay-deamon1` (obfuscation)

### Why
`relay-deamon1` holds the core logic and ships as **loose, readable `.js`/`.cjs` files** in
`resources/relay-deamon1` (outside the asar, because Node spawns them as child processes). It was
the least-protected part of the app. We obfuscate it at package time.

### Why obfuscation (not bytenode)
The daemon is launched via **system `node`** (`execFile('node', ...)`, `spawn('node', ...)`).
`bytenode` (V8 bytecode) would break across machines with different Node/V8 versions.
Obfuscation keeps files as valid `.js`/`.cjs` that run on any Node, but unreadable.

### Files changed

**`forge/obfuscateRelay.cjs`** (new) — obfuscation helper:
- Recursively obfuscates every `.js`/`.cjs` in the **packaged** relay folder.
- **Skips `node_modules`** (obfuscating deps would break them).
- Conservative settings chosen to preserve behavior:
  - `renameProperties: false`, `transformObjectKeys: false` → cross-file `require`/`import`
    exports keep their names.
  - `disableConsoleOutput: false` → the daemon's file logging via `console.*` still works.
  - `controlFlowFlattening: 0.6`, `deadCodeInjection: false`, `selfDefending: false` → prioritize
    not breaking the daemon; can be dialed up later.

**`forge.config.js`** — wired the helper into the existing `postPackage` hook:
```js
const { obfuscateRelayDir } = require('./forge/obfuscateRelay.cjs');
// ...inside postPackage, after existing cleanup steps (as step 5):
obfuscateRelayDir(relayPath);
```
Runs **last**, so only files that actually ship get scrambled.

**`package.json`** — added `javascript-obfuscator` (dev dependency).

### Important: source stays clean
Obfuscation runs against the **packaged output only**. The git source in `relay-deamon1/`
remains readable and debuggable — only the shipped copy is scrambled.

### Verification performed
Tested the real helper against actual relay files before finishing:
- ✅ ESM `import`/`export` specifiers preserved (e.g. `./src/config.js` intact).
- ✅ Real ESM files and the `.cjs` wrapper pass `node --check`.
- ✅ `#!/usr/bin/env node` shebang preserved.
- ✅ Exports/property names untouched; `console.*` logging still works.

---

## 3. Electron Fuses (context — reviewed, not changed)

`forge.config.js` already sets protective fuses (`RunAsNode: false`,
`EnableNodeCliInspectArguments: false`, `EnableNodeOptionsEnvironmentVariable: false`,
`EnableCookieEncryption: true`).

Two fuses are intentionally left `false`:
- `OnlyLoadAppFromAsar` — **safe to enable** (main app is in asar). Optional hardening.
- `EnableEmbeddedAsarIntegrityValidation` — **leave off** unless asar-integrity hash injection is
  verified; otherwise the app can fail to launch. Not related to relay-deamon1.

These fuses protect the **main app bundle**, not `relay-deamon1` — which is why the obfuscation
above is the relevant protection for the daemon.

---

## Summary of files

| File | Type | Purpose |
|------|------|---------|
| `package.json` | modified | `build:vite`/`dist` scripts; `electron-builder` + `javascript-obfuscator` dev deps |
| `electron-builder.yml` | new | NSIS wizard installer config (Program Files, perMachine) |
| `forge/obfuscateRelay.cjs` | new | Obfuscates packaged relay-deamon1 source |
| `forge.config.js` | modified | Calls `obfuscateRelayDir` in `postPackage` |

## Important caveats
- **Obfuscation ≠ encryption.** It deters casual reading; a determined expert can partially
  reverse it. **Never ship real secrets in the client** — keep service-role keys and privileged
  logic server-side; ship only the anon/public Supabase key with Row Level Security enforced.
- The definitive test is a full `npm run dist` build with the daemon confirmed running inside the
  installed app.
