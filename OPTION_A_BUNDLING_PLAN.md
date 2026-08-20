# Option A — Bundle `relay-deamon1` into Sealed Entry Files (Plan)

**Goal:** stop shipping the readable `relay-deamon1` source tree. Collapse the whole
`src/` tree into a handful of self-contained, obfuscated entry files so end users see a few
opaque blobs instead of ~35 readable `.js`/`.cjs` files.

> Status: **✅ IMPLEMENTED & VERIFIED** (bundling). Implemented in `forge/bundleRelay.cjs`,
> wired into `forge.config.js` `postPackage` (step 5, before obfuscation). The size-reduction
> items further below (locales/LICENSES/GPU DLLs) are still **recommendations, not yet applied**.
>
> **How it was verified** (bundled a real copy of `relay-deamon1`, then ran it):
> - `harness-cli.js list` → valid JSON, all 3 harnesses discovered via the external chain
>   (`registry.js` readdir → dynamic import of bundled providers → external `index.js`/`env.js`/
>   `machineEnv.js`), with real version detection (Claude Code 2.1.214, OpenCode 1.18.3).
> - `hook.js` → fired, uploaded a real request to Supabase, showed the risk prompt, blocked for
>   approval (correct).
> - `relay.cjs status`, `postHook`/`stopHook` wrappers → all exit 0.
> - Full pipeline (bundle **+** obfuscate) re-verified together: `harness-cli.js list` still exit 0.
> - Result: `src/` collapses from ~24 modules to **9 kept files** (3 providers, opencode plugin,
>   `registry.js`, `machineEnv.js`, `harness-sdk/env.js`, `harness-sdk/index.js`, `tty-worker.cjs`);
>   18 readable leaf modules inlined away. All shipped files are minified + obfuscated.
>
> ### Implementation notes (what the built helper actually does)
> - Every entry is bundled **in place** (output path = source path) so `import.meta.url` and
>   relative `external` specifiers stay valid.
> - The 4 depth-sensitive shared modules are marked **external** and their import specifiers are
>   **rewritten relative to each entry's output dir** (a leaf's `./machineEnv.js` becomes
>   `./src/machineEnv.js` when inlined into a root entry — this was the key correctness fix).
> - npm deps are `packages: 'external'` — never bundled; `node_modules` is untouched (so the
>   **size reduction from Option A is modest**; the big wins are the locale/LICENSE trims below).
> - Deletion is driven by esbuild's **metafile** — only files actually inlined are removed; nothing
>   is guessed, and `node_modules` can never be caught.

---

## Your development workflow does NOT change

Important: Option A changes nothing about how you work day to day.

- Your `relay-deamon1/` source tree stays **exactly as it is** — separate, readable, editable files.
- You keep editing, running `npm start`, and debugging against the normal tree.
- Git keeps tracking clean, readable source.

**All bundling, obfuscation, and packing happen only during `npm run dist`**, against a *copy* in
the build output — never against your real source. A bug introduced by bundling would therefore
only appear in the built `.exe`, not in `npm start` — which is why the verification plan below
exercises the *packaged* build end-to-end.

| | Your `relay-deamon1/` source | The packaged `.exe` |
|---|---|---|
| Structure | Full readable tree (unchanged) | Bundled + obfuscated blobs |
| Produced when | Always | Only at `npm run dist` |
| You edit here? | ✅ Yes | ❌ Never — generated output |

---

## Why we can't just "archive" the folder (the constraint)

`relay-deamon1` is executed by **plain system `node`**, and some files are launched **by external
programs, by path**:

- Claude Code `settings.json` runs hooks as `node "…/relay-deamon1/hook-wrapper.cjs"`.
- OpenCode loads `src/harnesses/opencode/plugin/relay.js` as a plugin.
- `main.js` spawns `harness-cli.js` and `scripts/heartbeat.js` via `node`.
- `ptyProxy` spawns `src/tty-worker.cjs` as a worker thread.

None of these can read an asar/zip — so the **entry files must stay as real files on disk**.
What we *can* do is make each entry file **self-contained** (its imports inlined) so the rest of
the tree no longer needs to ship.

---

## What Option A actually does

Use **esbuild** to bundle each entry point + all of its local imports into ONE file, then run the
existing obfuscation pass over the bundles.

### The entry points (everything else gets absorbed into these)

| Entry file (must stay) | Invoked by | Notes |
|------------------------|-----------|-------|
| `hook-wrapper.cjs` + `hook.js` | Claude Code PreToolUse | CJS wrapper dynamically imports ESM hook |
| `postHook-wrapper.cjs` + `postHook.js` | Claude Code PostToolUse | |
| `stopHook-wrapper.cjs` + `stopHook.js` | Claude Code Stop | |
| `notifyHook-wrapper.cjs` + `notifyHook.js` | Claude Code Notification | |
| `harness-cli.js` | `main.js` (`execFile node`) | harness platform CLI |
| `scripts/heartbeat.js` | `main.js` (`spawn node`) | |
| `scripts/setup.js` | setup step | |
| `relay.cjs`, `decide.cjs` | harness hooks | confirm invokers during build |
| `src/harnesses/opencode/plugin/relay.js` | OpenCode runtime | must keep OpenCode plugin API shape |
| `src/tty-worker.cjs` | worker thread (by path) | must stay a standalone file |

Everything under `src/` that is only *imported* (e.g. `config.js`, `supabase.js`, `risk.js`,
`registry.js`, `parsers.js`, `differ.js`, `filter.js`, the whole `harness-sdk/` and
`harnesses/*/provider.js`) gets **inlined into the bundles and no longer shipped**.

### What stays external (NOT bundled)

Native / runtime-loaded modules must remain in `node_modules`:
- **`node-pty`** — native addon (`.node` binary); cannot be bundled.
- **`@opencode-ai/sdk`** — optional, loaded by the OpenCode side.
- Pure-JS deps (`diff`, `dotenv`, `@supabase/supabase-js`) *can* be inlined into the bundles,
  which lets us drop them from the shipped `node_modules` (smaller + less readable).

---

## Resulting file layout (before → after)

**Before (today):**
```
resources/relay-deamon1/
├── hook.js, postHook.js, stopHook.js, notifyHook.js
├── *-wrapper.cjs
├── harness-cli.js, relay.cjs, decide.cjs
├── scripts/ (heartbeat.js, setup.js)
├── src/            ← whole readable tree: config, supabase, risk, registry,
│   ├── ...             parsers, harness-sdk/, harnesses/*/provider.js, tty-worker.cjs
└── node_modules/   ← full dep tree
```

**After (Option A):**
```
resources/relay-deamon1/
├── hook.js, postHook.js, stopHook.js, notifyHook.js   ← each a single obfuscated bundle
├── *-wrapper.cjs                                       ← thin, obfuscated
├── harness-cli.js                                      ← single obfuscated bundle
├── scripts/heartbeat.js, scripts/setup.js             ← single obfuscated bundles
├── relay.cjs, decide.cjs                              ← single obfuscated bundles
├── src/harnesses/opencode/plugin/relay.js            ← single obfuscated bundle (OpenCode entry)
├── src/tty-worker.cjs                                 ← single obfuscated bundle (worker)
└── node_modules/
    └── node-pty/   ← only the native module remains
```
The entire readable `src/` logic tree is **gone** — inlined into the entries above.

---

## Build pipeline changes

The build gains one step, inserted **before** obfuscation:

```
electron-forge package
        │  (postPackage hook)
        ├─ 1. existing cleanup (.env, .git, dev deps, node-pty trim)
        ├─ 2. NEW: esbuild-bundle each entry point → self-contained files
        ├─ 3. NEW: delete now-orphaned src/ files + inlined node_modules deps
        └─ 4. obfuscate the resulting bundles   (existing step, unchanged)
electron-builder --prepackaged → NSIS installer
```

Concretely:
- Add `esbuild` as a dev dependency.
- New helper `forge/bundleRelay.cjs`:
  - Bundles each entry with `platform: 'node'`, correct `format` per file
    (`cjs` for `.cjs`, `esm` for ESM `.js`), `bundle: true`,
    `external: ['node-pty', '@opencode-ai/sdk']`.
  - Preserves filenames (external configs depend on them).
  - After bundling, removes the orphaned `src/` sources and the now-inlined pure-JS deps.
- `forge/obfuscateRelay.cjs` then runs over the smaller, bundled set (no change needed).

---

## Risks & things that need careful verification

Bundling a multi-entry daemon with worker threads and a plugin API is the risky part. Each of
these will be tested on a real packaged build before we call it done:

1. **CJS/ESM correctness** — ESM entries must stay ESM (dynamic `import()` in wrappers,
   `import.meta.url`); CJS entries stay CJS. esbuild `format` must be set per file.
2. **OpenCode plugin contract** — `plugin/relay.js` must keep the exact export shape OpenCode
   expects (default export / named hooks). Bundling must not rename or drop it.
3. **Worker thread** — `tty-worker.cjs` is loaded by path from a worker; it must remain a valid
   standalone file with its deps inlined.
4. **`import.meta.url` / `__dirname` path assumptions** — code that resolves sibling files by
   relative path must still resolve after bundling (paths may need to stay relative to the entry).
5. **`node-pty` external resolution** — bundles that use node-pty must still `require('node-pty')`
   from the remaining `node_modules/node-pty`.
6. **Dynamic requires / registry lookups** — the harness `registry.js` may load providers
   dynamically; esbuild can't follow non-static requires, so those must be bundled explicitly or
   kept as files.

### Verification plan (per entry)
- `node --check` every bundle (syntax + module type).
- Run the app end-to-end from the packaged build: pair a device, trigger a Claude Code hook,
  run the heartbeat, exercise the OpenCode plugin and a pty session — confirm each still works.

---

## Outcome & honest caveats

**What you gain:** the readable `src/` tree stops shipping entirely; users see ~10 opaque,
obfuscated blob files instead of a browsable source tree. Smaller install too (inlined deps drop
from `node_modules`).

**What it is NOT:** still not encryption. A determined expert can partially reverse bundled +
obfuscated JS. So the rule stands — **never ship real secrets in the client**; anon/public key +
server-side Row Level Security only. If you need true "no JS visible at all," that's **Option B**
(compile to a single `.exe` via Node SEA/`pkg`), a larger architectural change tracked separately.

---

## Reducing installed size (~336 MB → target ~250 MB)

### Where the size actually goes (measured on the current packaged build, 367 MB)

| Item | Size | Reducible? |
|------|------|-----------|
| `VibeRemote.exe` (Chromium + V8 + Node) | **217 MB** | ❌ This is the Electron/Chromium floor — not reducible |
| `locales/` (~55 Chromium `.pak` files) | **48 MB** | ✅ Keep only `en-US.pak` → save ~47 MB |
| `dxcompiler.dll` + `dxil.dll` (DirectX/WebGPU shader compiler) | **26 MB** | ⚠️ Removable if the app doesn't use WebGPU — test rendering |
| `LICENSES.chromium.html` | **20 MB** | ✅ Plain-text licenses; can ship a smaller NOTICE file |
| `icudtl.dat` (Unicode/ICU data) | 11 MB | ❌ Required by Chromium |
| `resources/relay-deamon1` | 13 MB | ✅ Option A bundling drops it to ~4 MB |
| `resources.pak`, `ffmpeg.dll`, GL/EGL DLLs | ~18 MB | ❌ Needed for rendering/media |
| `vk_swiftshader.dll` + `vulkan-1.dll` (software GPU fallback) | 6 MB | ⚠️ Removable if you don't need SwiftShader fallback — risky |

> **Key takeaway:** ~217 MB is Chromium itself and cannot be removed — every Electron app carries
> this floor. Realistic target after trimming is **~250–260 MB installed**, not "small-app" size.
> Only a non-Electron rewrite (Tauri/native) escapes the Chromium floor.

### Recommended size reductions (in order of value / safety)

All of these are implemented in the **`postPackage` hook** (same place as the existing cleanup), so
they run automatically at `npm run dist` and never touch your source.

1. **Trim locales → keep only `en-US`** (save ~47 MB, safe).
   Delete every file in `locales/` except `en-US.pak`. VibeRemote is English-only, so the other
   ~54 locale packs are dead weight.

2. **Delete `LICENSES.chromium.html`** (save ~20 MB, safe).
   Replace with a short `NOTICE.txt` pointing to the Chromium/Electron license URLs so attribution
   is preserved without the 20 MB HTML dump.

3. **Option A bundling of `relay-deamon1`** (save ~9 MB).
   Inlining `@supabase/supabase-js` (7.5 MB), `diff`, `dotenv` into the bundles lets them drop out
   of the shipped `node_modules` — only native `node-pty` remains. (Security + size in one step.)

4. **Remove `dxcompiler.dll` + `dxil.dll`** (save ~26 MB, ⚠️ TEST FIRST).
   These are the DirectX shader compiler for WebGPU. If the app renders fine without WebGPU
   (a standard React UI does), they can be deleted. Verify on a clean machine before shipping.

5. **Remove `vk_swiftshader.dll` + `vulkan-1.dll`** (save ~6 MB, ⚠️ RISKY).
   Software-rendering fallback used on machines with no working GPU. Removing it can cause a black
   window on some systems/VMs. Only drop it if you control the target machines.

6. **Maximize installer compression** (smaller *download*, not installed size).
   In `electron-builder.yml`: `compression: maximum`. Shrinks the `Setup.exe` a user downloads;
   installed footprint is unchanged.

**Projected result:** 367 MB → **~250 MB** applying the safe items (1–3) plus dxcompiler removal
after testing (4).

### Size vs. the Chromium floor — honest note
If a truly small installer is a hard requirement, Electron is the wrong tool — the ~217 MB Chromium
runtime is unavoidable. A rewrite in **Tauri** (uses the OS WebView instead of bundling Chromium)
produces ~5–15 MB installers, but that is a full rewrite of the desktop shell, not a build tweak.

---

## Decision needed

- [ ] Proceed with Option A (bundling) as scoped above?
- [ ] Apply the **safe** size reductions (trim locales, drop LICENSES html, bundle relay)?
- [ ] Test + apply the **risky** ones (dxcompiler/dxil, swiftshader/vulkan)?
- [ ] Any entry point in the table that should NOT be touched?
- [ ] OK to drop pure-JS deps (`diff`, `dotenv`, `@supabase/supabase-js`) from `node_modules` by
      inlining them, keeping only `node-pty`?
