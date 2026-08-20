# Vibe Remote — System Architecture

> Remote-control coding-agent CLIs (Claude Code, OpenCode, Gemini CLI) running on a desktop machine, from a phone, via a relay API. This document covers all three repositories that make up the system.

| Repo | Path | Role |
|---|---|---|
| **Desktop** | `D:\Projects\vRdeksMultiharness` | Electron app + Node "relay daemon" that runs on the machine where the coding CLI lives. Intercepts tool-use/approval events and injects prompts. |
| **Mobile** | `D:\Projects\vibe_remote(reactNative)\AgentControl` | React Native app ("Agent Control"). Pairs with a desktop machine, shows a live chat feed of agent activity, approves/denies tool calls, answers agent questions, sends prompts. |
| **Server** | `D:\Projects\vibe_remote(serverside)` | Stateless Express REST API + Postgres (self-hosted Supabase). The mailbox and router between desktop and mobile. No sockets of its own. |

---

## 1. System Overview

There is **no persistent socket connection anywhere in this system** between the three parties. Instead:

- Desktop and mobile both talk to the server over plain **HTTPS REST**.
- **Supabase Realtime** (a separate service, part of the self-hosted Supabase stack) is used purely as a low-latency "doorbell": both desktop and mobile subscribe *directly* to Supabase Realtime channels (bypassing the Express server entirely for the push itself), and the Express server fires stateless HTTP broadcasts to those channels when something changes.
- Every push-style notification is a **content-free nudge** ("something changed, go refetch") — the receiver always re-fetches real data via an authenticated REST call. This is a deliberate design choice: broadcast topics are unauthenticated (Supabase broadcast bypasses row-level security), so nothing sensitive is ever put in the nudge payload.
- Every realtime path has an **HTTP polling backstop**, because the team hit real bugs where self-hosted Supabase Realtime silently drops `postgres_changes` events (documented at length in migration comments and in the desktop repo's `LIVE_FEED_REALTIME_DIAGNOSIS.md`, since deleted from the working tree but referenced in code comments).

```
 ┌─────────────────────────┐        HTTPS REST (x-machine-api-key)        ┌─────────────────────────┐
 │   DESKTOP                │ ───────────────────────────────────────────▶ │   SERVER                 │
 │   Electron app            │ ◀─────────────────────────────────────────── │   Express + Postgres      │
 │   + relay-deamon1          │        (polling: /relay/status,             │   (self-hosted Supabase)  │
 │   (Node daemon)            │         /mobile/command/next, fs/pending)   │                           │
 │                            │                                             │                           │
 │  intercepts tool calls in  │◀── Supabase Realtime broadcast: machine:id ─┤  fires broadcast on write │
 │  claude-code / opencode /  │    (paired, unpaired, harness,              │  (fire-and-forget, never  │
 │  gemini-cli, injects       │     command_available)                     │   blocks the response)    │
 │  prompts via keystroke/PTY │                                             │                           │
 └─────────────────────────┘                                             │  fires FCM push via        │
                                                                            │  firebase-admin on new     │
 ┌─────────────────────────┐        HTTPS REST (Bearer user JWT)          │  approval/question         │
 │   MOBILE                  │ ───────────────────────────────────────────▶│                           │
 │   React Native app        │ ◀─────────────────────────────────────────── │                           │
 │   (Agent Control)          │        (polling: sessions, feed, requests) └─────────────────────────┘
 │                            │
 │  Supabase Realtime direct  │◀── Supabase Realtime broadcast: session:id ── (server fires this too)
 │  subscription (own JWT     │    + postgres_changes CDC on
 │  minted by server)         │    terminal_events / pending_requests / mobile_commands / agents
 └─────────────────────────┘
```

### Core domain concepts (shared vocabulary across all three repos)

- **Machine** — one Electron app installation. Identified by a desktop-generated `machineId` (UUID) + `MACHINE_API_KEY` (raw secret; server stores only its SHA-256 hash). No user login on the desktop — identity arrives entirely by pairing.
- **Harness** — one of `claude-code` / `opencode` / `gemini-cli` (open-ended, adapter-based). Each has its own interception mechanism, capability set, and approval/narrative/injection strategy. A machine can have multiple harnesses installed and toggled independently.
- **Session** (aka `agent` in the DB) — one CLI conversation, keyed by `session_id`. A machine can run multiple concurrent sessions across harnesses.
- **Pairing** — binds exactly **one mobile device** to **one machine** at a time (1:1, not many-to-many), via QR code + one-time challenge nonce.
- **Request** (`pending_requests` row) — either a **tool-approval** card (`kind: 'approval'`) or an **agent question** card (`kind: 'question'`, from Claude Code's `AskUserQuestion` tool or OpenCode's native/custom question tool). This table is effectively the "message" unit for anything requiring user attention.
- **Terminal event** (`terminal_events` row) — free-form narrative stream: the agent's reasoning text, tool start/end markers, notifications, turn-stop markers. Feeds the chat UI's non-actionable bubbles.
- **Mobile command** (`mobile_commands` row) — a prompt the phone wants injected into a live desktop session.

---

## 2. Desktop — Electron App (`D:\Projects\vRdeksMultiharness`)

**Stack**: Electron 42 + React 19 renderer, built via `@electron-forge/cli` + Vite (`vite.main.config.mjs`, `vite.preload.config.mjs`, `vite.renderer.config.mjs`). `@supabase/supabase-js` for Realtime only (not the write path). No socket.io/ws dependency of its own. Product name `VibeRemote`, package name `my-app`, v1.3.0.

### 2.1 Process split

- **Main process** — `src/main.js`. Frameless BrowserWindow (400×780, `contextIsolation: true`, `nodeIntegration: false`), loads `preload.js`.
- **Renderer** — React UI (`src/App.jsx` → `TitleBar` + `Dashboard`).
- **Daemon** — `relay-deamon1/`, a *separate* standalone Node project (own `package.json`, ESM, own `node_modules` including native `node-pty` binaries) shipped as an Electron `extraResource` **outside the asar** so it can be executed directly by `node`/spawned as child processes. This is where essentially all the interesting logic lives.

IPC surface (`src/preload.js` → `window.relay` / `window.harness` / `window.windowControls`):

| Channel | Purpose |
|---|---|
| `relay:getMachineConfig` / `relay:writeMachineConfig` | Read/write `machine.env` (machine identity) |
| `relay:getHookStatus` / `relay:setHookEnabled` | Legacy single-harness (Claude Code) hook toggle |
| `harness:list` | Delegates to `relay-deamon1/harness-cli.js list` |
| `harness:setMobile` | Delegates to `harness-cli.js enable/disable <id>` |
| `system:getHostname`, `window:minimize/maximize/close/isMaximized` | OS/window chrome |

### 2.2 Machine identity & why it's stored outside the app bundle

`RELAY_ENV = <userData>/machine.env` (e.g. `%APPDATA%\my-app\machine.env`) — deliberately **outside** the reinstallable app resources so a Squirrel auto-update doesn't wipe machine identity. Contains `MACHINE_ID`, `MACHINE_API_KEY` (raw), `MACHINE_LABEL`, `USER_ID`, `MACHINE_SESSION_TOKEN`, Supabase/API URLs, and per-machine policy: `TIMEOUT_SECONDS=300`, `FAIL_OPEN=true`, `ALWAYS_ALLOW=node_modules,\.git/,dist/,\.next/`. A one-time `migrateMachineEnv()` moves a legacy bundled `.env` into this stable location on first launch of an updated build.

### 2.3 UI — `src/components/Dashboard.jsx`

Self-registration on first launch (no desktop login): generates `machineId = crypto.randomUUID()` + a raw API key, `POST /machines/register {machineId, machineLabel, apiKeyHash}` (only the hash leaves the client), writes the result to `machine.env`.

Three cards:
1. **Machine** — label/hostname, copyable machine ID.
2. **Mobile Connection** — pairing QR (`qrcode.react`), built from `{machineId, apiKey, challenge, supabaseUrl, apiUrl}` where `challenge` is a one-time nonce minted via `POST /machines/{id}/challenge`. Subscribes to Supabase channel `machine:<machineId>` for instant `paired`/`unpaired` broadcasts, backstopped by polling `/machines/{id}/session` (10s unpaired / 120s paired). Unpair via `DELETE /machines/{id}/pair`.
3. **Harness Support** — lists detected harnesses (`window.harness.list()`) with a per-harness mobile-mode toggle. Harnesses with `approvalMechanism: 'pty-proxy'` (Gemini CLI) show a hint to launch via `vibe run gemini-cli` since there's no hook/plugin API to attach to.

`src/components/MachineSelector.jsx` (a "restore an existing machine" picker) exists but is **not imported anywhere** — orphaned code from a prior multi-machine reclaim flow.

`src/lib/supabase.js` hardcodes `SUPABASE_URL=https://database.insight25.lk`, a public anon key, and `API_URL=https://insight25.lk`. The anon key is safe to ship (RLS-protected); the privileged service-role key never touches the desktop.

### 2.4 `relay-deamon1` — the harness abstraction

`src/registry.js` auto-discovers adapters from `src/harnesses/<id>/provider.js` — no central switch statement; adding a harness is purely additive (a new folder), validated individually so one broken adapter can't break the others.

`src/harness-sdk/index.js` is the **only** import surface adapters may use — a deliberate boundary keeping adapters out of Electron/React and out of each other:

- `transport.js` — single choke point for all server calls: `uploadRequest` (`POST /relay/upload`), `pollDecision` (`GET /relay/status/:id`), `postNarrative` (`POST /relay/terminal-event`), `reportHarness` (`POST /harness/report`), `getDesired` (`GET /harness/desired`). All send `x-machine-api-key`.
- `schema.js` — canonical row shapes for `pending_requests` and `terminal_events`, matching exactly what the server expects.
- Four **strategies**, three distinct interception mechanisms:

| Harness | Mechanism | How it intercepts | Narrative source | Prompt injection |
|---|---|---|---|---|
| **claude-code** | `settingsHook` | Writes a `hooks` block + `permissions.allow` into `~/.claude/settings.json` | Heartbeat tails the JSONL transcript file | Heartbeat keystroke-injects into the live terminal |
| **opencode** | `plugin` | Installs `~/.config/opencode/plugin/vibe-relay.js`, gated by a flag file | In-daemon, via `@opencode-ai/sdk` SSE `event.subscribe()` | In-daemon, via SDK `session.prompt()` — no keystroke hack |
| **gemini-cli** | `ptyProxy` (universal fallback, fail-closed) | Wraps the CLI in a `node-pty` pseudo-terminal, pattern-matches approval prompts via a harness-specific grammar | Streamed live from the PTY buffer | Writes keystrokes directly into the PTY |

Claude Code is the "reference adapter" — it wraps a pre-existing, proven `hook.js`/`heartbeat.js` runtime unchanged; the SDK abstraction is a compatibility layer bolted on top, not a rewrite.

### 2.5 Claude Code hook flow (`hook.js`, `PreToolUse`)

1. Reads the Claude Code hook event from stdin (`tool_name`, `tool_input`, `session_id`, `cwd`, `transcript_path`).
2. Resolves and caches the real long-lived `claude` process PID by walking the Win32 process tree (`Get-CimInstance Win32_Process` via PowerShell) — necessary because `process.ppid` inside a hook is a transient shell that dies immediately. Written to `C:\temp\relay-pid-<sessionId>.txt` so the heartbeat knows which PID is still alive.
3. If `tool_name === 'AskUserQuestion'` → branches into the question flow (§2.7).
4. Otherwise: `preFilter()` checks `ALWAYS_ALLOW`/`ALWAYS_BLOCK` regexes from `machine.env` — allow → `exit(0)`, block → `exit(2)`. A local flag file `relay-allow-all.txt` bypasses everything (set by a CLI shortcut).
5. Otherwise: builds a risk-scored summary + diff (`src/risk.js`, `src/differ.js`), uploads a `pending_requests` row (`POST /relay/upload`), fires a `tool_start` terminal event, and **blocks** on `raceDecision(requestId)`.
6. `raceDecision()` races Supabase Realtime (`postgres_changes` UPDATE on the row, 25s polling backstop against `/relay/status/:id`) against a 150ms local file poll (`C:\temp\relay-pending\<id>.approved|.denied`, written by a CLI-side fallback shortcut).
7. Approved → `exit(0)`; denied/timeout → `exit(2)` with a JSON reason on stdout, which Claude Code renders as a hook block.

Sibling hooks, all wrapped in `*-wrapper.cjs` shims (needed because Claude Code launches hooks as CommonJS on Windows, and Windows bare paths break ESM `import` — the wrapper dynamic-`import()`s the real ESM file via a `file://` URL):
- **`postHook.js`** (PostToolUse) — posts a `tool_end` narrative event.
- **`notifyHook.js`** (Notification) — forwards Claude's progress messages ("Searching…") as narrative.
- **`stopHook.js`** (Stop) — posts a `stop` event with Claude's turn summary, clears the busy flag, drops a ready flag so any prompt queued mid-turn gets drained immediately.

### 2.6 Injection & liveness — `scripts/heartbeat.js`

There is **no long-lived process that owns the Claude Code/OpenCode CLI** — the user runs the CLI themselves in their own terminal; the relay intercepts via hook/plugin. `heartbeat.js` is a separate always-running child process (auto-restarted on crash) that:

- **Injects queued mobile prompts into the already-open terminal** via a generated PowerShell script that P/Invokes `WriteConsoleInput`/`AttachConsole` against the CLI's PID, falling back to clipboard-set + window-focus + paste + Enter for ConPTY/Windows Terminal where the first method doesn't reach the real console buffer.
- **Opens a new terminal window** running `claude --resume "<sessionId>" -p $p` / `opencode run --session "<sessionId>" $p` / `gemini -p $p` only when no live terminal is found for that session — explicitly *never* for a session whose CLI has closed (posts a "please restart the agent" notification instead).
- Reports session liveness every 15s (`POST /relay/sessions-alive`) by `process.kill(pid, 0)`-checking each tracked PID.
- Tails Claude's JSONL transcript every 3s to forward narrative text.
- Polls `GET /mobile/command/next` (session-scoped, ~10s / broadcast-driven) to discover queued prompts, gated by per-session busy/ready flag files so it never interrupts a live turn.

This entire mechanism (`WriteConsoleInput`, PID tree walk, `C:\temp\...` coordination files) is **Windows-only** — guarded by `process.platform === 'win32'` checks. Linux/macOS builds (deb/rpm/zip makers exist in `forge.config.js`) would lose keystroke injection and PID liveness; REST-based approvals/narrative would still work.

### 2.7 Question/answer flow

**Claude Code**: `hook.js`'s `handleQuestion()` uploads a `display_type: 'question'` row, blocks on `waitForAnswer()` (same Realtime+poll racing pattern), then on answer calls `answerExit()` which writes Claude Code's official PreToolUse "clean deny" contract to stdout (`hookSpecificOutput.permissionDecision: 'deny'` with the choice embedded in `permissionDecisionReason`) and exits **0** — so Claude's native question UI never renders; the model reads the user's choice out of the deny reason text instead.

**OpenCode**: two parallel paths in `plugin/relay.js` — a custom `askUserQuestion` tool (registered dynamically; the plugin's system-prompt injection tells the model the user is remote and must use this tool) which returns the formatted answer directly as the tool's result; and interception of OpenCode's own native `question.asked` event, replying via `POST {serverUrl}/session/{sessionID}/question/{requestID}/reply`.

Both harnesses share a CLI-side fallback (`relay.cjs answer <n>`) that writes a local signal file and also POSTs to `/relay/answer` so the mobile UI stays in sync even if the phone was the slow path.

### 2.8 Packaging (`forge.config.js`)

- `asar: true` for the main app, but a custom `ignore` function keeps only the Vite build output — everything under `src/` is pre-bundled, so raw source isn't shipped.
- `extraResource: ['relay-deamon1']` — copies the daemon (with `node_modules`, including native `node-pty` prebuilds) outside the asar so Node can execute it directly.
- `postPackage` hook aggressively trims the shipped `node_modules` (strips dev `.env`, `.git`, type packages, non-Windows `node-pty` prebuilds, debug symbols) to shrink the installer and avoid a Squirrel/SharpCompress bug.
- Squirrel (Windows) is the primary maker; zip/deb/rpm are also configured despite the codebase being heavily Windows-specific.
- Electron Fuses harden the build (`RunAsNode: false`, cookie encryption on, Node inspect/`NODE_OPTIONS` disabled); asar integrity validation is deliberately **off** because `relay-deamon1` intentionally lives outside the asar.
- No Authenticode/notarization config found. An untracked `my-release-key.keystore` sits in the repo root but isn't referenced anywhere in the build — looks like a stray Android artifact, not part of this build.

### 2.9 Local state on the desktop

| Data | Location |
|---|---|
| Machine identity, policy | `<userData>/machine.env` |
| Claude Code hook config | `~/.claude/settings.json` |
| OpenCode plugin + credentials | `~/.config/opencode/plugin/vibe-relay.js`, `vibe-relay.env.json`, on-flag `~/.config/opencode/.vibe-mobile-on` |
| Gemini CLI mobile flag | `~/.config/vibe-remote/gemini-cli.on` |
| Ephemeral coordination files | `C:\temp\relay-pending\*`, `relay-current.txt`, `relay-current-question.json`, `relay-pid-<session>.txt`, `relay-busy-<session>.flag`, `relay-ready-<session>.flag`, `heartbeat.log` |
| Everything else (pairing, history, harness inventory) | Server-side Postgres — nothing authoritative lives only on the desktop |

---

## 3. Mobile — React Native App (`AgentControl`)

**Stack**: bare React Native 0.85 (not Expo) + React 19, TypeScript. `@react-navigation` v7 (native-stack + bottom-tabs). **Zustand** for small global state (session, deviceId, selected machine filter, toast). **TanStack React Query v5** as the primary data layer (queries, mutations, optimistic updates, infinite queries for the chat feed). `@supabase/supabase-js` for auth + Realtime. `react-native-mmkv` for local storage. `react-native-vision-camera` for QR scanning. `@notifee/react-native` + `@react-native-firebase/messaging` for push. `react-native-keychain` for biometric-gated secrets.

### 3.1 Navigation

```
RootStack
 ├── Auth (no session)      → SignIn / SignUp
 ├── App (has session)      → bottom tabs
 │     ├── Chats  → SessionsScreen → ChatScreen → RequestDetailScreen / FileBrowserScreen
 │     ├── Machines → MachinesScreen
 │     └── Profile → ProfileScreen → SecurityScreen
 └── QRScan (modal, from any tab) → QRScanScreen
```

A custom floating pill tab bar hides itself on full-screen routes (Chat, RequestDetail, FileBrowser, Security). The Chats tab badge sums `pending_count` across all sessions. `TerminalScreen` exists in the tree but is unreferenced by any navigator — orphaned, superseded by `ChatScreen`.

Two always-mounted helpers: `DeviceBootstrap` (registers/validates the device ID after sign-in) and `AppLockGate` (optional PIN/biometric lock over the whole app).

### 3.2 Networking — two channels

**REST** (`src/api/server.ts`) — every call attaches `Authorization: Bearer <supabase JWT>` + `x-device-id`. Full endpoint surface mirrors the server's `/mobile/*`, `/machines/*`, `/harness/*`, `/profile` routes (see §4 for the canonical list). Errors surface as `Error` objects with `.code`/`.status` that screens pattern-match on (`bad_challenge`, `paired_elsewhere`, `owned_elsewhere`).

**Supabase Realtime** (`src/api/realtime.ts`) — a *second*, dedicated Supabase client (`persistSession: false`), authenticated with a short-lived token the server mints via `POST /mobile/realtime-token` (needed because self-hosted Realtime sits behind Kong, which validates the `apikey` header against registered consumers — a user JWT alone won't pass). Three realtime hooks:

- `useMachineChannel(machineId)` — channel `machine:<id>`, `broadcast` event `harness` → invalidates harness/machine/session queries.
- `useSessionsRealtime(machineIds)` — channel `sessions`, `postgres_changes` on `agents` + `pending_requests` → invalidates session list.
- `useChatFeed(sessionId)` — channel `session:<id>`: `broadcast` `feed` (debounced 600ms reconciliation refetch) + `postgres_changes` INSERT on `terminal_events` and INSERT/UPDATE on `pending_requests`/`mobile_commands`, patched directly into the React Query cache (no refetch needed on the fast path).

Polling exists everywhere as a safety net only (sessions 15s, feed 30s, terminal events 5–30s, single request 8s, machines/harness state 30s) — Realtime is the "live edge," polling is the "reconnect backstop," per explicit code comments.

### 3.3 Auth & pairing

**User auth**: Supabase email/password (`signInWithPassword`/`signUp`), session persisted via a custom MMKV storage adapter, mirrored into Zustand via `onAuthStateChange`. If the configured Supabase URL differs from the last-launch cached one, the entire auth store is wiped defensively.

**Device registration**: on sign-in, `DeviceBootstrap` reads a cached `deviceId` from MMKV; if present, confirms it still exists server-side (self-healing after a server DB reset); if absent, registers a new one (`POST /machines/devices`).

**Machine pairing** (`QRScanScreen`): scans a QR encoding `{machineId, apiKey, challenge}` (produced by the desktop's Dashboard), then `POST /machines/:machineId/pair {apiKey, deviceId, challenge}`. Distinct error codes drive distinct UI: `paired_elsewhere` (machine already claimed by another phone), `bad_challenge` (QR expired/replayed), `owned_elsewhere` (machine belongs to a different account). Pairing is strictly 1:1 — a machine can only be paired to one phone at a time.

### 3.4 Chat feed & question picker

`ChatScreen` renders a flattened `ChatItem[]` union (`output` | `activity` | `notify` | `stop` | `request` | `sent`) from `useChatFeed`, with a one-time typewriter reveal on the newest output row, auto-scroll that respects user scroll position (shows a "Latest ↓" pill instead of yanking the view), and cursor-paginated infinite scroll upward.

**`QuestionCard`** (`src/components/QuestionCard.tsx`) renders `pending_requests` rows with `kind: 'question'`. Supports multi-question requests via a tab strip (one tab per question, `✓` once answered), single-select (radio) or multi-select (checkbox) per question, an always-available free-text "Other…" field per question, and preview blocks for side-by-side option comparison. Submission (`useAnswerRequest`) is optimistic — the UI flips to "answered" immediately, patched across every cached feed/detail query, with rollback on error; the later Realtime UPDATE just confirms what's already shown.

### 3.5 Push notifications

FCM (`@react-native-firebase/messaging`) + Notifee for local display — the server sends **data-only** messages, so the app fully controls rendering. A background handler is registered before `AppRegistry.registerComponent` so notifications display even when the app is backgrounded/killed. Tapping a notification deep-links straight to `RequestDetailScreen` for that `requestId`, whether the app was foregrounded, backgrounded, or cold-started from killed.

### 3.6 Local storage

All via MMKV (no AsyncStorage/SQLite): `supabase-auth` (session), `device-identity` (deviceId), `app-lock` (PIN/biometric flags, encrypted). No chat history is persisted client-side — the feed is always re-fetched from the server on screen mount and lives only in the React Query in-memory cache. Biometric-gated secrets go through OS Keychain/Keystore via `react-native-keychain`, not MMKV.

### 3.7 Multi-machine / multi-harness

`MachinesScreen` lists every machine paired to the account; `SessionsScreen` filters by machine via horizontal chips. Each `MachineHarness` tracks `installed`, `mobile_enabled` (actual desktop state), `desired_enabled` (mobile-requested toggle — actual toggling only happens on the desktop UI; mobile can only *request* a state change via `POST /harness/:machineId/desire`), and a capability object (`approvalMechanism: 'hook'|'plugin'|'mcp'|'pty-proxy'|'api'|'none'`, `fileTree`, `sessionList`). Sessions are the real multi-tenancy unit — one machine can run several concurrent sessions across harnesses simultaneously.

---

## 4. Server — Relay API (`vibe_remote(serverside)`)

**This is a stateless Express REST API, not a WebSocket relay.** No `ws`/`socket.io`/`uWebSockets` dependency exists anywhere in the codebase. Every "push" is either (a) an outbound HTTP call to Supabase's broadcast endpoint, or (b) an FCM push — the server itself never holds a live client connection.

**Stack**: Express 4, ESM (`"type": "module"`), `@supabase/supabase-js` (both as a Postgres/PostgREST client and as the broadcast transport), `firebase-admin` (FCM), `jsonwebtoken` (local JWT verification), `express-rate-limit` (in-memory store — a known scaling limitation).

### 4.1 Entry point & auth

`src/index.js` mounts: `/health`, `/confirmed` (static post-email-confirm page), `/mobile/command` (mounted *before* `/mobile` deliberately, so the daemon's machine-key-authed `GET /command/next` matches before the user-JWT-gated `mobileRouter`), `/machines`, `/relay`, `/mobile`, `/harness`, `/profile`.

Two credential types, checked purely by header shape (no session objects, no connection registry):

| Caller | Credential | Middleware |
|---|---|---|
| Desktop daemon | `x-machine-api-key` (raw secret; server stores only `sha256(key)`) | `requireMachineAuth` |
| Mobile app | `Authorization: Bearer <supabase JWT>` | `requireUserAuth` (real round-trip to Supabase Auth, used for sensitive ops) or `requireUserAuthFast` (local HS256 verify against `SUPABASE_JWT_SECRET`, used on hot polled paths) |
| Unpair only | either | `requireUserOrMachine` |

Rate limits: global 120 req/min/IP, `POST /machines/register` limited to 5/min/IP (registration needs no auth, so this is the anti-abuse gate), a per-user 300 req/min limiter inside the mobile router.

### 4.2 Routing without a connection registry

Because there's no live socket, "routing" a message to the right desktop/phone pair is done entirely through **foreign keys in Postgres**: every actionable row (`pending_requests`, `terminal_events`, `agents`, `mobile_commands`) carries `machine_id` (often `user_id` too); `pairedMachineIds(userId, deviceId)` resolves which machines a given phone is currently allowed to see (60s in-process cache, busted on pair/unpair).

The "room" equivalent is a **broadcast topic string** the server constructs by convention and fires an HTTP POST at — it never subscribes to anything itself:
- `machine:<machineId>` → events `paired`, `unpaired`, `harness`, `command_available` (payload `{sessionId}`)
- `session:<sessionId>` → event `feed` (deliberately empty payload — consumer always re-fetches)

### 4.3 Pairing flow (server side, mobile-first / login-free desktop)

1. `POST /machines/register {machineId, machineLabel, apiKeyHash}` — no auth required; inserts an unowned row (`user_id: null`); idempotent, never overwrites an existing `api_key_hash` (anti-hijack).
2. `POST /machines/:id/challenge` (machine-authed) — mints a random 32-byte hex nonce, 5-minute TTL, stored in `machine_challenges`.
3. `POST /machines/:id/pair {apiKey, deviceId, challenge}` (user-authed) — verifies the key hash, atomically consumes the challenge (`used_at IS NULL AND expires_at > now()`, so a replayed QR photo consumes nothing), rejects if owned by a different user or already paired to a different device, then does a single optimistic-lock `UPDATE machines SET user_id, paired_device_id, paired_at, session_token WHERE paired_device_id IS NULL` — this one conditional UPDATE both claims first-time ownership and does device pairing, closing the TOCTOU race. Broadcasts `paired`.
4. `GET /machines/:id/session` (machine-authed) — desktop's read of current pairing state.
5. `DELETE /machines/:id/pair` — either party can unpair; broadcasts `unpaired`.
6. `POST /machines/:id/reclaim` (user-authed) — re-key a machine after a desktop reinstall without losing history.

### 4.4 The two hottest data flows

**Tool approval / question**: desktop `POST /relay/upload` inserts a `pending_requests` row → server fires `broadcastSession(feed)` + `notifyMachine()` (FCM push, fire-and-forget) → mobile gets the Realtime nudge or its poll fires, reads via `GET /mobile/sessions/:id/feed` or `/mobile/requests` → user decides → `POST /mobile/decide` (optimistic-concurrency `UPDATE ... WHERE status='pending'` so a race between phone and a local terminal decision can't double-fire) → `broadcastSession` again → desktop discovers the decision via Realtime or its 25s `GET /relay/status/:id` poll.

**Prompt injection (mobile → desktop)**: `POST /mobile/prompt` inserts into `mobile_commands`, then fires **both** `broadcastSession(feed)` and `broadcastMachine(command_available, {sessionId})` — the latter is what wakes the desktop daemon in ~1s instead of waiting out its poll interval, explicitly because `postgres_changes` was found unreliable on this self-hosted Supabase setup. Desktop claims it via `GET /mobile/command/next`, which has deliberate idle-gating: unscoped calls only claim if the target session has been quiet >30s (a safety backstop against interrupting a live turn); session-scoped calls (used by the fast-path heartbeat poll) skip that gate, trusting the desktop's own local busy flag. The claim itself is a conditional UPDATE (`status='pending'` guard) so concurrent polls can't double-deliver.

### 4.5 Realtime nudges — design principle

Broadcast payloads never carry actual data, only "go refetch" signals, because Supabase broadcast bypasses row-level security — real data always comes back through an authenticated REST call. `POST /mobile/realtime-token` mints a short-lived (12h) Supabase-shaped JWT purely so the mobile app can authenticate its *own direct* Realtime subscription against Supabase — unrelated to the REST-API bearer token.

### 4.6 Push notifications (`src/notify.js`)

Firebase Admin SDK, data-only FCM messages (`contentAvailable: true` on iOS) so the client fully controls notification rendering/deep-linking. `notifyMachine()` resolves tokens via a single-hop `machine_push_tokens(machineId)` RPC (`machines.paired_device_id → push_tokens.device_id`), sends via `sendEachForMulticast`, auto-prunes tokens on `messaging/registration-token-not-registered`. Only fired from `POST /relay/upload` — pushes exist for things needing the user's decision (approvals, questions), not for plain narrative/chat updates.

### 4.7 Database schema (Postgres, self-hosted Supabase)

Base schema in `supabase/schema.sql`, evolved by hand-applied numbered migrations (003–011, no ORM/migration runner).

| Table | Purpose |
|---|---|
| `machines` | Registry: id, owner, api_key_hash, online status, pairing state, session_token |
| `mobile_devices` | One row per installed phone: device_name, platform, push_token |
| `machine_challenges` | One-time QR pairing nonces (id, expiry, used_at) |
| `agents` | One row per CLI session: machine_id, session_id, cwd, harness, last_activity_at, pending_count, cli_alive |
| `pending_requests` | Central approval/question card table — tool_name, risk fields, diff, `kind` (`approval`\|`question`), `question`/`selected_options` (jsonb) |
| `mobile_commands` | Queued prompts, phone → desktop |
| `terminal_events` | Narrative/reasoning stream (unbounded growth — flagged as top scaling risk) |
| `fs_requests` | Remote file-tree browsing jobs |
| `push_tokens` | FCM tokens, device-scoped |
| `machine_harnesses` | Per-machine harness inventory + capabilities + `desired_enabled` tri-state |
| `profiles` | Display name / avatar |

Notable view/RPCs: `session_feed` (UNION ALL of terminal_events/pending_requests/mobile_commands, service-role only) + `get_session_feed(...)` (cursor-paginated reader backing the mobile feed endpoint, tuple cursor to avoid skip/dupe at page boundaries); `machine_push_tokens(machineId)`; `batch_decide`; `cleanup_old_requests()`.

`REPLICA IDENTITY FULL` is set on `agents`, `terminal_events`, `pending_requests`, `mobile_commands` (migrations 009/010) — required because self-hosted Supabase Realtime silently drops filtered UPDATE/DELETE WAL events under RLS without full-row images; this was a real production bug the team debugged and documented.

The only genuinely in-memory server state is the 60s `_pairCache` and the rate-limiter's default store — both flagged as horizontal-scaling blockers once the server runs as more than one process.

### 4.8 Deployment

Single VPS, nginx reverse proxy, no Dockerfile/PM2 config currently checked in (documented as a "next step," not yet implemented). Production domains: `insight25.lk` (Node app, port 3000) and `database.insight25.lk` (self-hosted Supabase stack via Kong, port 8000) — Postgres itself is never exposed publicly; Studio is SSH-tunnel-only. A staged scaling runbook (`SCALING.md`) exists but describes future work: PM2 cluster mode, then Redis for shared rate-limiting, then replacing the two hot polling loops (`/machines/fs/pending` every 5s, `/mobile/command/next` every 10s per machine) with SSE or Redis pub/sub plus a push-notification queue, then full horizontal scaling with a pooler.

---

## 5. End-to-End Flows

### 5.1 Pairing a new phone to a machine
1. Desktop self-registers on first launch (`POST /machines/register`), gets an unowned machine row.
2. Dashboard shows a QR (`{machineId, apiKey, challenge, supabaseUrl, apiUrl}`), challenge refreshed client-side before it expires.
3. Phone scans it, `POST /machines/:id/pair` with the same payload + its own `deviceId`.
4. Server atomically claims ownership + pairing in one conditional UPDATE, broadcasts `paired` on `machine:<id>`.
5. Desktop's Realtime subscription (backstopped by its 10s poll) sees `paired`, re-fetches `/machines/:id/session`, updates the UI.

### 5.2 Approving a tool call (Claude Code)
1. Claude Code fires `PreToolUse` → `hook.js` → filters, risk-scores, uploads `pending_requests`, blocks.
2. Server stores the row, broadcasts `session:<id> feed`, sends an FCM push ("`${tool_name}` needs approval").
3. Phone shows a push (deep-links to `RequestDetailScreen`) or the chat feed updates live via Realtime; user taps Approve/Deny.
4. `POST /mobile/decide` — optimistic-concurrency UPDATE, broadcast fired again.
5. `hook.js`'s `raceDecision()` picks it up via Realtime or its 25s poll fallback, exits 0/2 accordingly.
6. `postHook.js` posts a `tool_end` narrative event once the tool actually runs.

### 5.3 Answering an agent question
1. Claude Code calls `AskUserQuestion` → `hook.js`'s `handleQuestion()` uploads a `kind:'question'` row, blocks on `waitForAnswer()`.
   *(OpenCode: either its custom `askUserQuestion` tool or interception of the native `question.asked` event — same server contract either way.)*
2. Phone renders `QuestionCard` (multi-question tab strip if needed), submits via `POST /mobile/answer` with an optimistic local update.
3. `hook.js` sees the answer, writes Claude Code's "clean deny" PreToolUse response embedding the choice in `permissionDecisionReason`, exits 0 — the model reads the answer out of that text rather than Claude's native picker rendering.
4. OpenCode's paths return the answer directly as tool output, or POST to OpenCode's own reply endpoint for the native question flow.

### 5.4 Sending a prompt from the phone into a live session
1. `POST /mobile/prompt` inserts a `mobile_commands` row, fires both a `feed` broadcast (chat viewers) and a `command_available` broadcast on `machine:<id>` (wakes the desktop daemon fast).
2. Desktop's heartbeat calls `GET /mobile/command/next?session=<id>` (session-scoped, skips the 30s idle gate, trusts its own local busy flag) and claims the row via conditional UPDATE.
3. Heartbeat injects the prompt into the live terminal via `WriteConsoleInput`/clipboard-paste (Claude Code/generic terminal) or `session.prompt()` via SDK (OpenCode) or a PTY keystroke write (Gemini CLI) — gated so it never lands mid-turn.

---

## 6. Security Model

- **Desktop identity**: no user login; a self-generated API key, hashed server-side (`sha256`), never transmitted in the clear except once at registration.
- **Pairing replay protection**: challenge nonces are single-use (`used_at` set atomically on consumption) and short-lived (5 minutes).
- **Optimistic-lock claims**: both pairing and decision endpoints use conditional UPDATEs (`WHERE paired_device_id IS NULL`, `WHERE status='pending'`) to close TOCTOU races without needing application-level locks.
- **Realtime is intentionally content-free**: broadcast channels bypass RLS, so payloads never carry more than "type + maybe a session id" — real data always requires an authenticated REST round trip.
- **Two JWT verification tiers** on the server: full round-trip to Supabase Auth for sensitive mutations, local HS256 verification for hot polled reads — a deliberate latency/security tradeoff, valid because the server signs with the same `SUPABASE_JWT_SECRET` Supabase Auth uses.
- **Known gap — plaintext secrets in the server repo**: `D:\Projects\vibe_remote(serverside)\.env` contains what appear to be live credentials (Supabase JWT secret, self-hosted service-role key, a full Firebase service-account private key), and a `.env.example` sits alongside it implying `.env` was meant to be gitignored. **Verify this file is actually excluded from git (check `.gitignore` and `git log -- .env`) before this repo is pushed anywhere or shared, and rotate these credentials if it has ever been committed.**
- **Platform gap**: the desktop's keystroke-injection and PID-liveness mechanisms are Windows-only; non-Windows builds silently lose live prompt injection while still supporting hook-based approvals over REST.

---

## 7. Known Gaps / Orphaned Code (worth cleaning up or resolving intentionally)

| Item | Location | Status |
|---|---|---|
| `MachineSelector.jsx` | desktop `src/components/` | Not imported anywhere — dead code from a prior multi-machine reclaim UI |
| `TerminalScreen` | mobile `src/screens/Terminal/` | Not wired into any navigator — superseded by `ChatScreen` |
| `my-release-key.keystore` | desktop repo root, untracked | Not referenced by `forge.config.js` — looks like a stray Android artifact, not part of the Electron signing pipeline |
| No Windows code-signing config | desktop `forge.config.js` | No Authenticode/notarization set up despite Squirrel being the primary maker |
| `.env` with live secrets | server repo root | See Security Model above |
| In-memory `_pairCache` + rate-limit store | server `src/routes/mobile.js`, `express-rate-limit` | Breaks under multi-process/PM2-cluster scaling — documented in `SCALING.md` as future work, not yet fixed |
| `terminal_events` unbounded growth | server DB | No TTL/cleanup job running yet; `cleanup_old_requests()` exists but scheduling (`pg_cron`) is proposed, not confirmed active |
| Hot polling loops | `GET /machines/fs/pending` (5s), `GET /mobile/command/next` (10s/machine) | Estimated ~100 idle DB reads/sec at 500 machines per `SCALING.md`; proposed fix is SSE or Redis pub/sub, not yet implemented |

---

## 8. File Reference Index

**Desktop**
- `src/main.js` — Electron main process, IPC, hook/heartbeat lifecycle
- `src/preload.js` — contextBridge API surface
- `src/App.jsx`, `src/components/Dashboard.jsx`, `TitleBar.jsx`
- `src/lib/supabase.js` — hardcoded Supabase/API endpoints
- `forge.config.js` — packaging, extraResource, fuses
- `relay-deamon1/hook.js`, `postHook.js`, `notifyHook.js`, `stopHook.js` (+ `*-wrapper.cjs`)
- `relay-deamon1/relay.cjs`, `harness-cli.js`
- `relay-deamon1/scripts/heartbeat.js`
- `relay-deamon1/src/config.js`, `supabase.js`, `machineEnv.js`, `filter.js`, `registry.js`
- `relay-deamon1/src/harness-sdk/{index,env,transport,schema,validate}.js`, `strategies/{settingsHook,plugin,ptyProxy,null}.js`
- `relay-deamon1/src/harnesses/{claude-code,opencode,gemini-cli}/{provider.js,manifest.json}`, `opencode/plugin/relay.js`, `gemini-cli/grammar.js`

**Mobile**
- `App.tsx`, `index.js`, `src/navigation/RootNavigator.tsx`
- `src/hooks/useAuth.ts`, `src/api/supabase.ts`, `src/api/realtime.ts`, `src/api/server.ts`, `src/api/device.ts`
- `src/store/useAppStore.ts`
- `src/screens/Auth/QRScanScreen.tsx`
- `src/hooks/useChatFeed.ts`, `useSessions.ts`, `useSessionsRealtime.ts`, `useMachineChannel.ts`, `useRequests.ts`
- `src/screens/Sessions/ChatScreen.tsx`, `src/components/chat/TerminalText.tsx`
- `src/components/QuestionCard.tsx`, `src/screens/Requests/RequestDetailScreen.tsx`
- `src/components/DiffViewer/DiffViewer.tsx`
- `src/screens/Machines/MachinesScreen.tsx`
- `src/hooks/usePushNotifications.ts`
- `src/components/AppLockGate.tsx`, `PinEntry.tsx`, `src/api/appLock.ts`, `biometric.ts`

**Server**
- `src/index.js` — entry point, route mounting, `/mobile/command/next` claim logic
- `src/realtime.js` — `broadcastMachine`/`broadcastSession`
- `src/notify.js` — FCM push
- `src/supabase.js` — service-role + anon clients
- `src/middleware/auth.js` — all auth strategies
- `src/routes/machines.js`, `relay.js`, `mobile.js`, `harness.js`, `profile.js`
- `supabase/schema.sql`, `migrations/003_multiharness.sql` … `011_question_requests.sql`
- `SCALING.md`, `SELF_HOST_SUPABASE.md`
