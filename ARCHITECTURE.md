# System Architecture: Vibe Remote

A remote control plane for AI coding agents (Claude Code, OpenCode, Gemini CLI). It allows a user to approve/deny tool calls from their phone in real time, inject prompts, browse remote files, and manage multiple machines.

---

## 1. High-Level System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         VIBE REMOTE — SYSTEM OVERVIEW                           │
└─────────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────┐          ┌───────────────────────────────────┐
  │       DESKTOP MACHINE       │          │           VPS SERVER              │
  │  vRdeksMultiharness         │  HTTPS   │  vibe_remote (serverside)         │
  │  ─────────────────────────  │◄────────►│  ─────────────────────────────── │
  │                             │          │                                   │
  │  ┌─────────────────────┐    │          │  ┌──────────────────────────────┐ │
  │  │  Electron App        │    │          │  │  Express.js REST API         │ │
  │  │  (React 19 + Vite)  │    │          │  │  /machines /relay            │ │
  │  │                     │    │          │  │  /mobile   /harness          │ │
  │  │  • Auth UI          │    │          │  └──────────────┬───────────────┘ │
  │  │  • Dashboard        │    │          │                 │                  │
  │  │  • QR Code display  │    │          │  ┌──────────────▼───────────────┐ │
  │  │  • Harness toggles  │    │          │  │  Supabase (self-hosted)       │ │
  │  └──────────┬──────────┘    │          │  │  PostgreSQL + Realtime WS    │ │
  │             │ IPC           │          │  └──────────────────────────────┘ │
  │  ┌──────────▼──────────┐    │          │                                   │
  │  │  Relay Daemon        │    │          │  ┌──────────────────────────────┐ │
  │  │  (Node.js)          │    │          │  │  Firebase Admin SDK           │ │
  │  │                     │    │          │  │  (FCM Push Notifications)     │ │
  │  │  • heartbeat.js     │    │          │  └──────────────────────────────┘ │
  │  │  • hook.js          │    │          └───────────────────────────────────┘
  │  │  • harness-cli.js   │    │                         ▲
  │  └──────────┬──────────┘    │                         │ HTTPS
  │             │               │                         │
  │  ┌──────────▼──────────┐    │          ┌──────────────▼───────────────────┐
  │  │  AI Agent Harnesses  │    │          │       MOBILE APP                  │
  │  │                     │    │          │  AgentControl (React Native)      │
  │  │  • Claude Code      │    │          │  ─────────────────────────────── │
  │  │  • OpenCode         │    │          │                                   │
  │  │  • Gemini CLI       │    │          │  • QR code scan (auth)           │
  │  └─────────────────────┘    │          │  • Approve / Deny tool calls     │
  └─────────────────────────────┘          │  • Chat with agent               │
                                           │  • File browser                  │
                                           │  • Machine & harness mgmt        │
                                           │  • Push notification handling    │
                                           └──────────────────────────────────┘
```

---

## 2. Technology Stack

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              TECHNOLOGY STACK                                    │
├──────────────────────┬─────────────────────────┬────────────────────────────────┤
│ DESKTOP APP          │ SERVER                  │ MOBILE APP                     │
├──────────────────────┼─────────────────────────┼────────────────────────────────┤
│ Electron 42          │ Node.js (ES Modules)    │ React Native 0.85.3            │
│ React 19.2.6         │ Express.js 4.21.2       │ TypeScript 5.3.3               │
│ Vite 5.4.21          │ Supabase JS 2.49.8      │ React 19.2.3                   │
│ Electron Forge 7.11  │ Firebase Admin 13.10    │ Supabase JS 2.43.1             │
│ Supabase JS          │ jsonwebtoken 9.0.3      │ React Query (TanStack) v5      │
│ qrcode.react         │ express-rate-limit 7.5  │ Zustand 5.0.0                  │
│ node-pty (optional)  │ dotenv 16.5.0           │ React Navigation 7             │
│ diff library         │ cors                    │ react-native-mmkv 4.3.1        │
│ @supabase/supabase-js│ CORS middleware         │ Firebase Messaging 21.3        │
│ dotenv               │                         │ @notifee/react-native 9.1.8    │
│                      │ Database: PostgreSQL     │ react-native-vision-camera 4.7 │
│ Relay Daemon:        │ (self-hosted Supabase)  │ react-native-reanimated 4.3    │
│ Node.js ES Modules   │                         │ react-native-linear-gradient   │
│ @supabase/supabase-js│ Push: Firebase FCM      │ react-native-vector-icons      │
│                      │                         │ date-fns 3.6.0                 │
│ Build: Squirrel      │ Auth: Supabase JWT +    │                                │
│ (Windows installer)  │       SHA-256 API keys  │ Storage: MMKV (encrypted)      │
│                      │                         │ Camera: Vision Camera          │
│ Installer: NSIS      │ Rate limiting: per-IP   │ Platform: Android + iOS        │
└──────────────────────┴─────────────────────────┴────────────────────────────────┘
```

---

## 3. Communication Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                        COMMUNICATION CHANNELS                                    │
└──────────────────────────────────────────────────────────────────────────────────┘

DESKTOP INTERNAL (Electron IPC)
──────────────────────────────
  Renderer (React UI)
       │
       │  contextBridge / ipcRenderer.invoke()
       ▼
  Main Process (Electron)
       │
       │  ipcMain.handle() — Channel names:
       │  • relay:getMachineConfig / relay:writeMachineConfig
       │  • relay:getHookStatus / relay:setHookEnabled
       │  • harness:list / harness:setMobile
       │  • window:minimize/maximize/close
       │  • system:getHostname
       ▼
  Relay Daemon (spawned child process)
       │
       └── heartbeat.js (long-running)
       └── hook.js (per tool-call invocation)
       └── harness-cli.js (invoked on demand)


DESKTOP ↔ SERVER (HTTPS REST)
──────────────────────────────
  Auth: x-machine-api-key header (SHA-256 hashed API key)
  Base: https://insight25.lk

  Heartbeat (every 30s):    POST /machines/heartbeat
  Registration:             POST /machines/register
  Machine list:             GET  /machines/mine
  Tool upload:              POST /relay/upload
  Tool decide (PC):         POST /relay/decide
  Tool status poll:         GET  /relay/status/:requestId   (every 3s)
  Agent ping:               POST /relay/agent-ping
  Terminal event:           POST /relay/terminal-event
  File tree poll:           GET  /machines/fs/pending       (every 5s)
  File tree respond:        POST /machines/fs/respond
  Mobile prompt poll:       GET  /mobile/command/next       (every 10s)
  Harness report:           POST /harness/report
  Harness desired toggles:  GET  /harness/desired           (poll)
  Offline:                  POST /machines/offline


DESKTOP ↔ SUPABASE (WebSocket — Realtime)
───────────────────────────────────────────
  Channel: decision:{requestId}
  Event: UPDATE on pending_requests table
  Purpose: Fast decision notification when mobile approves/denies
  Fallback: HTTP polling every 3s via /relay/status/:requestId


MOBILE ↔ SERVER (HTTPS REST)
──────────────────────────────
  Auth: x-machine-api-key (from QR code scan)
  Base: https://insight25.lk  (or from QR override)

  Verify credentials:       POST /mobile/machine
  List requests:            GET  /mobile/requests          (poll 8s)
  Decide (mobile):          POST /mobile/decide
  List sessions:            GET  /mobile/sessions          (poll 10s)
  Session requests:         GET  /mobile/sessions/:id/requests   (newest-first, fixed)
  Chat feed (paginated):    GET  /mobile/sessions/:id/feed?before=<cursor>&limit=40
                              └─ unified windowed feed (terminal+request+prompt)
                                 backed by session_feed view + get_session_feed RPC
                                 Realtime carries live edge; 30s poll = safety net
  Send prompt:              POST /mobile/prompt
  Poll prompt:              GET  /mobile/command/next
  Cancel prompt:            DELETE /mobile/prompt/:id
  Terminal events:          GET  /mobile/terminal
  FS request:               POST /mobile/fs/request
  FS result poll:           GET  /mobile/fs/result/:id     (poll 2s)
  Register FCM token:       POST /mobile/push-token
  Get Realtime JWT:         POST /mobile/realtime-token
  Harness read:             GET  /harness/:machineId
  Harness toggle:           POST /harness/:machineId/desire


MOBILE ↔ SUPABASE (WebSocket — Realtime)
──────────────────────────────────────────
  Auth: JWT from /mobile/realtime-token
  Channels:
    chat:{sessionId}    → terminal_events  INSERT
                        → pending_requests INSERT + UPDATE
                        → mobile_commands  INSERT + UPDATE   (added — see below)
    terminal:{sessionId} → terminal_events INSERT
  Purpose: Instant updates to chat feed; rows are pushed straight into the
           useInfiniteQuery page cache (live edge), no refetch.
  Fallback: React Query polling at 30s (demoted from 5s — Realtime is primary)
  NOTE: mobile_commands was added to the supabase_realtime publication in
        migration 005 so a user's sent prompt appears instantly.


SERVER → MOBILE (Firebase FCM Push)
─────────────────────────────────────
  Trigger: New pending_request inserted (tool needs approval)
  Payload: { requestId, toolName, sessionId, machineName }
  Delivery: FCM data-only message
  Display: @notifee/react-native (foreground + background)
  Tap action: Deep link to RequestDetail screen
```

---

## 4. Tool Approval Flow (Primary Use Case)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                     TOOL APPROVAL SEQUENCE                                       │
│                                                                                  │
│  User runs Claude Code which attempts a file write / bash / edit operation      │
└──────────────────────────────────────────────────────────────────────────────────┘

  Claude Code (Agent)
       │
       │  1. Tool call event → stdout JSON (stdin to hook)
       ▼
  hook.js  ◄── registered as Claude Code settings.json hook
       │
       │  2. Parse tool name, args, diff, session info
       │  3. POST /relay/upload  →  Server
       │                              │
       │                              │  4. INSERT pending_requests (PostgreSQL)
       │                              │  5. Fire FCM push notification  →  Mobile
       │                              │
       │  ┌────────────────────────────┘
       │  │
       │  │  6. Subscribe Supabase Realtime channel: decision:{requestId}
       │  │     OR poll GET /relay/status/:requestId  every 3s (fallback)
       │  │
       │  │                         Mobile App
       │  │                              │
       │  │                              │  7. FCM push arrives → user sees alert
       │  │                              │  8. User taps → RequestDetail screen
       │  │                              │  9. User taps Approve / Deny
       │  │                              │  10. POST /mobile/decide
       │  │                              │
       │  │  Server                      │
       │  │    │  11. UPDATE pending_requests.status = 'approved'/'denied'
       │  │    │  12. Supabase Realtime broadcasts change to channel
       │  │    │
       │  │  hook.js receives Realtime event (or polling detects status change)
       │  │
       │  └──► 13. exit(0)  = approved (tool proceeds)
       │           exit(2)  = denied   (tool blocked)
       │
       ▼
  Claude Code continues or rolls back based on exit code


  FALLBACKS:
  ──────────
  A) No mobile → user types:  ! node relay.cjs 1  (approve)
                              ! node relay.cjs 3  (deny)
     → Creates signal file: C:\temp\relay-{id}.approved / .denied
     → hook.js detects file → exits accordingly

  B) Allow-all mode → C:\temp\relay-allow-all.txt exists → auto-approve

  C) Timeout (default 300s) → hook.js exits 2 (deny) to prevent hang
```

---

## 5. Database Schema

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                     SUPABASE (PostgreSQL) SCHEMA                                 │
└──────────────────────────────────────────────────────────────────────────────────┘

  ┌───────────────────┐      ┌───────────────────────┐
  │     machines      │      │        agents          │
  │ ─────────────────-│      │ ─────────────────────- │
  │ id (uuid) PK      │◄─────│ machine_id (FK)        │
  │ user_id           │  1:N │ session_id             │
  │ api_key_hash      │      │ harness                │
  │ label             │      │ cwd                    │
  │ is_online         │      │ cli_alive              │
  │ last_seen         │      │ pending_count          │
  └───────────────────┘      │ last_activity_at       │
           │                 └───────────┬────────────┘
           │ 1:N                         │ 1:N
           │              ┌──────────────▼────────────┐
  ┌────────▼──────────┐   │      pending_requests      │
  │  machine_harnesses │   │ ──────────────────────── │
  │ ─────────────────-│   │ id (uuid) PK              │
  │ machine_id (FK)   │   │ session_id (FK → agents)  │
  │ harness           │   │ machine_id (FK)            │
  │ installed         │   │ harness                   │
  │ mobile_enabled    │   │ tool_name                 │
  │ desired_enabled   │   │ status (pending/approved/ │
  │ capabilities      │   │         denied/timeout)   │
  │ version           │   │ decided_by (mobile/pc)    │
  └───────────────────┘   │ tool_args (JSONB)         │
                          │ diff                      │
  ┌───────────────────┐   │ risk_level                │
  │   terminal_events  │   └───────────────────────────┘
  │ ─────────────────-│
  │ id                │   ┌───────────────────────────┐
  │ session_id (FK)   │   │       fs_requests          │
  │ machine_id        │   │ ──────────────────────── │
  │ harness           │   │ id                        │
  │ event_type        │   │ machine_id (FK)           │
  │ tool_name         │   │ user_id                   │
  │ summary           │   │ status                    │
  │ created_at        │   │ result (JSONB)             │
  └───────────────────┘   │ resolved_at               │
                          └───────────────────────────┘
  ┌───────────────────┐   ┌───────────────────────────┐
  │  mobile_commands   │   │       push_tokens          │
  │ ─────────────────-│   │ ──────────────────────── │
  │ id                │   │ id                        │
  │ machine_id (FK)   │   │ user_id                   │
  │ session_id        │   │ token (FCM registration)  │
  │ prompt (text)     │   │ platform (android/ios)    │
  │ status (pending/  │   │ created_at                │
  │  delivered/cancel)│   └───────────────────────────┘
  │ created_at        │
  └───────────────────┘


  CHAT FEED — VIEW + RPC (migration 006)
  ────────────────────────────────────────
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  VIEW  session_feed                                                       │
  │   UNION ALL of the 3 chat sources, normalized to one shape:              │
  │     terminal_events  → source='terminal'                                 │
  │     pending_requests → source='request'    (id, user_id, session_id,    │
  │     mobile_commands  → source='prompt'       created_at, source,         │
  │                                               payload jsonb = to_jsonb(row)) │
  │   Server-only: REVOKE from public/anon/authenticated, GRANT service_role │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  RPC  get_session_feed(p_session_id, p_user_id,                          │
  │                        p_before_ts, p_before_id, p_limit)                │
  │   SECURITY DEFINER, execute granted to service_role ONLY.                │
  │   Returns one page newest-first with a (created_at, id) TUPLE CURSOR     │
  │   → no gaps / duplicates at page boundaries. Planner merge-appends the   │
  │   three (session_id, created_at desc) indexes and stops early at LIMIT.  │
  └─────────────────────────────────────────────────────────────────────────┘

  PER-SESSION INDEXES (migration 005)
    terminal_events  (session_id, created_at desc)   ← pre-existing
    pending_requests (session_id, created_at desc)   ← added
    mobile_commands  (session_id, created_at desc)   ← added
```

---

## 6. Harness Architecture (Multi-Agent Support)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                      PLUGGABLE HARNESS SDK                                       │
│               relay-deamon1/src/harness-sdk/                                     │
└──────────────────────────────────────────────────────────────────────────────────┘

  ┌───────────────────────────────────────────────────────────────────────────────┐
  │                         STRATEGY LAYER                                        │
  ├─────────────────┬──────────────────┬──────────────────┬────────────────────-─┤
  │ settingsHook    │ pluginStrategy   │ ptyProxyStrategy │ mcpGateway /          │
  │ Strategy        │                  │                  │ apiMediator (future)  │
  │                 │                  │                  │                       │
  │ Exit code gate  │ JS plugin hook   │ Wraps PTY        │ MCP permission        │
  │ via             │ via              │ terminal,        │ protocol /            │
  │ settings.json   │ async throw in   │ intercepts by    │ headless API          │
  │ "hooks" config  │ tool.execute.    │ pattern matching │ control               │
  │                 │ before           │ on output        │                       │
  │ exit(0) = allow │                  │                  │                       │
  │ exit(2) = block │                  │                  │                       │
  └────────┬────────┴───────┬──────────┴────────┬─────────┴────────────┬──────────┘
           │                │                   │                      │
           ▼                ▼                   ▼                      ▼
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                     HARNESS ADAPTERS (auto-discovered)                      │
  │              relay-deamon1/src/harnesses/{id}/provider.js                   │
  ├──────────────────────┬──────────────────────┬────────────────────────────── ┤
  │   claude-code/       │    opencode/          │    gemini-cli/                │
  │   provider.js        │    provider.js        │    provider.js                │
  │                      │                       │                               │
  │   Strategy:          │   Strategy:           │   Strategy:                   │
  │   settingsHook       │   pluginStrategy      │   ptyProxy (planned)          │
  │                      │                       │                               │
  │   Detection:         │   Detection:          │   Detection:                  │
  │   claude-code CLI    │   opencode CLI        │   gemini / aistudio CLI       │
  │   exists?            │   exists?             │   exists?                     │
  │                      │                       │                               │
  │   Enable:            │   Enable:             │   Enable:                     │
  │   Writes hook in     │   Installs plugin     │   Wraps PTY (future)          │
  │   .claude/settings.  │   at ~/.config/       │                               │
  │   json               │   opencode/plugin/    │                               │
  │                      │   vibe-relay.js       │                               │
  └──────────────────────┴──────────────────────┴───────────────────────────────┘
           │
           ▼
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                       CANONICAL SCHEMA                                      │
  │                                                                             │
  │   RelayRequest  { id, sessionId, machineId, harness, toolName, toolArgs,   │
  │                   diff, riskLevel, status, createdAt }                      │
  │                                                                             │
  │   NarrativeEvent { type, content, sessionId, harness, timestamp }           │
  └─────────────────────────────────────────────────────────────────────────────┘


  REGISTRY (relay-deamon1/src/registry.js)
  ──────────────────────────────────────────
  • Scans src/harnesses/ for provider.js files at startup
  • Each provider declares: manifest, detect(), enable(), disable()
  • Plus runtime pieces: interceptor, narrator, injector, fileTree, sessionList
  • No central switch — new harness = new folder = zero core changes
```

---

## 7. Mobile App Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                       MOBILE APP — AgentControl                                  │
│                         React Native Architecture                                │
└──────────────────────────────────────────────────────────────────────────────────┘

  App.tsx
    │ GestureHandlerRootView
    │ QueryClientProvider (React Query)
    └── RootNavigator
          │
          ├── [unauthenticated] QRScanScreen
          │       Vision Camera → scan QR → save to MMKV → navigate to app
          │
          └── [authenticated] Bottom Tab Navigator
                │
                ├── RequestsTab
                │     ├── RequestsListScreen  (poll 8s, filter pending/tool-type)
                │     └── RequestDetailScreen (diff viewer, approve/deny)
                │
                ├── ChatsTab (Sessions)
                │     ├── SessionsScreen     (poll 10s, show status/pending badge)
                │     ├── ChatScreen         (windowed feed: recent page + load older)
                │     │     │  Realtime (live edge) + 30s safety poll
                │     │     │  scroll-anchored (maintainVisibleContentPosition),
                │     │     │  conditional auto-scroll + "jump to latest" pill,
                │     │     │  React.memo rows + virtualization tuning
                │     │     ├── terminal_events  (agent reasoning — left bubbles)
                │     │     ├── pending_requests (inline approval cards)
                │     │     └── mobile_commands  (user prompts — right bubbles)
                │     ├── FileBrowserScreen  (request→poll pattern, 2s poll)
                │     └── RequestDetailScreen
                │
                └── MachinesTab
                      └── MachinesScreen    (per-harness toggle, online status)


  STATE LAYERS
  ─────────────
  ┌─────────────────────────────────────────────────────────┐
  │  Zustand Store (useAppStore)                            │
  │  • credentials (machineId, apiKey, supabaseUrl, apiUrl) │
  │  • selectedMachineId (filter)                           │
  │  • toast (3s auto-clear notifications)                  │
  │  Persisted via MMKV                                     │
  └─────────────────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────────────────┐
  │  React Query Cache                                      │
  │  • Server state with automatic polling                  │
  │  • Optimistic updates for decide / harness toggle       │
  │  • Rollback on error                                    │
  │  • gcTime: 5 minutes                                    │
  └─────────────────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────────────────┐
  │  Supabase Realtime (PRIMARY for chat liveness)          │
  │  • JWT via /mobile/realtime-token                       │
  │  • channel chat:{sessionId}                             │
  │  • terminal/request/prompt INSERT → append live edge   │
  │  • request/prompt UPDATE → patch row in page cache     │
  │  • Polling demoted to 30s safety net (was 5s)          │
  └─────────────────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────────────────┐
  │  Firebase FCM + Notifee                                 │
  │  • Background handler (app killed / backgrounded)       │
  │  • Foreground handler (in-app display)                  │
  │  • Tap → navigationRef.navigate to RequestDetail        │
  └─────────────────────────────────────────────────────────┘


  HOOKS (Data Layer)
  ───────────────────
  useAuth.ts          → credentials from Zustand
  useRequests.ts      → React Query: pending/history/decide mutations
  useSessions.ts      → React Query: sessions/session-requests/prompts
  useChatFeed.ts      → useInfiniteQuery over /feed (windowed pages, oldest→newest);
                        Realtime appends to live edge + patches decisions in cache;
                        id-keyed item cache → stable refs for React.memo
  usePushNotifications → FCM token registration + Notifee display + deep link
  useTerminal.ts      → Terminal events with Realtime subscription
  useFileTree.ts      → Request/poll pattern for remote file tree
```

---

## 8. Desktop App Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                     DESKTOP APP — vRdeksMultiharness                             │
│                          Electron Architecture                                   │
└──────────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                            ELECTRON MAIN PROCESS                            │
  │  src/main.js                                                                │
  │                                                                             │
  │  • BrowserWindow (900×700, frameless)                                       │
  │  • IPC handlers for relay: and harness: channels                           │
  │  • Machine credential persistence → %APPDATA%/my-app/machine.env           │
  │  • Spawns heartbeat.js as child process                                     │
  │  • Auto-restarts heartbeat on crash                                         │
  │  • Writes hook into .claude/settings.json                                  │
  └──────────────────────────────────────┬────────────────────────────────────┘
                                         │ contextBridge
  ┌──────────────────────────────────────▼────────────────────────────────────┐
  │                      PRELOAD (src/preload.js)                              │
  │                                                                             │
  │  window.relay.*         → machine config, hook status                      │
  │  window.harness.*       → list/enable/disable harnesses                    │
  │  window.windowControls.*→ min/max/close                                    │
  │  window.system.*        → hostname                                          │
  └──────────────────────────────────────┬────────────────────────────────────┘
                                         │
  ┌──────────────────────────────────────▼────────────────────────────────────┐
  │                  RENDERER (React 19 + Vite)                                │
  │  src/renderer.jsx → src/App.jsx                                            │
  │                                                                             │
  │  ┌───────────────────┐  ┌────────────────────────┐  ┌──────────────────┐  │
  │  │   Auth.jsx        │  │  Dashboard.jsx         │  │ MachineSelector  │  │
  │  │                   │  │                        │  │    .jsx          │  │
  │  │ Supabase auth     │  │ • Machine config       │  │                  │  │
  │  │ (email/password)  │  │ • QR code display      │  │ Restore/reclaim  │  │
  │  │                   │  │ • Harness toggles      │  │ existing machine  │  │
  │  │                   │  │ • Hook status          │  │                  │  │
  │  └───────────────────┘  └────────────────────────┘  └──────────────────┘  │
  └───────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                          RELAY DAEMON                                        │
  │  relay-deamon1/                                                              │
  │                                                                              │
  │  ┌─────────────────────────────────────────────────────────────────────┐   │
  │  │  heartbeat.js  (long-running process, auto-restarted)               │   │
  │  │                                                                     │   │
  │  │  Tick 1 — every 30s:  POST /machines/heartbeat                     │   │
  │  │  Tick 2 — every 10s:  GET /mobile/command/next                     │   │
  │  │                         └─ if prompt found: keystroke inject        │   │
  │  │  Tick 3 — every 5s:   GET /machines/fs/pending                     │   │
  │  │                         └─ if job found: walk fs → POST /fs/respond │   │
  │  │  Tick 4 — continuous:  tail transcript → POST /relay/terminal-event │   │
  │  │  Tick 5 — on shutdown: POST /machines/offline                      │   │
  │  └─────────────────────────────────────────────────────────────────────┘   │
  │                                                                              │
  │  ┌─────────────────────────────────────────────────────────────────────┐   │
  │  │  hook.js  (runs once per tool call, invoked by Claude Code)         │   │
  │  │                                                                     │   │
  │  │  1. Read stdin (JSON event from Claude Code)                        │   │
  │  │  2. POST /relay/upload   → upload request + diff                   │   │
  │  │  3. Subscribe Supabase Realtime  channel: decision:{requestId}     │   │
  │  │  4. Poll /relay/status every 3s  (fallback)                        │   │
  │  │  5. Wait for status ≠ pending  (timeout: 300s)                     │   │
  │  │  6. exit(0) = approved │ exit(2) = denied │ exit(2) = timeout      │   │
  │  └─────────────────────────────────────────────────────────────────────┘   │
  │                                                                              │
  │  ┌─────────────────────────────────────────────────────────────────────┐   │
  │  │  harness-cli.js  (invoked by Electron via IPC on demand)           │   │
  │  │                                                                     │   │
  │  │  Commands: list | enable <id> | disable <id>                        │   │
  │  │  Uses registry.js to auto-discover harness providers               │   │
  │  └─────────────────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────────────────┘

  LOCAL SIGNAL FILES (C:\temp\)
  ──────────────────────────────
  relay-current.txt            → current active requestId
  relay-{id}.approved          → signal: user approved from terminal
  relay-{id}.denied            → signal: user denied from terminal
  relay-allow-all.txt          → bypass mode (auto-approve everything)
  relay-pid-{sessionId}.txt    → PID of running CLI process
  transcript-paths/{sid}.path  → path to session transcript file


  PACKAGING (Electron Forge + Squirrel)
  ──────────────────────────────────────
  Main app:    bundled into .asar via Vite
  Relay daemon: shipped as resources/relay-deamon1/ (outside .asar)
  Post-package: strips .env, .git, .pdb, @types/* from bundle
  Installer:   Squirrel (Windows) — supports auto-update
```

---

## 9. Authentication & Security

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                      AUTH & SECURITY MODEL                                       │
└──────────────────────────────────────────────────────────────────────────────────┘

  TWO-TIER AUTHENTICATION ON SERVER
  ────────────────────────────────────
  Tier 1 — User Auth (Supabase JWT)
    • Used for: /machines/mine, harness state, machine ownership checks
    • Header: Authorization: Bearer <supabase-jwt>
    • Verified by Supabase anon client

  Tier 2 — Machine Auth (SHA-256 API Key)
    • Used for: /relay/*, /mobile/*, heartbeat, tool uploads, decisions
    • Header: x-machine-api-key: <raw-api-key>
    • Server hashes incoming key → looks up machines.api_key_hash
    • API key stored raw only on: desktop (%APPDATA%/machine.env) + mobile (MMKV)

  MACHINE REGISTRATION FLOW
  ────────────────────────────
  1. User logs in via Supabase auth (desktop app)
  2. Desktop generates UUID (machineId) + random API key
  3. POST /machines/register  {machineId, label, apiKey}
  4. Server stores SHA-256(apiKey) in machines table
  5. Desktop displays QR code encoding: {machineId, apiKey, supabaseUrl, apiUrl}
  6. Mobile scans QR → stores credentials in MMKV
  7. Mobile POST /mobile/machine to verify credentials

  RECLAIM (multi-device / reinstall)
  ────────────────────────────────────
  • POST /machines/reclaim  with user JWT → generates new API key
  • Old credentials invalidated (hash replaced)

  RATE LIMITING
  ─────────────
  • Global: 120 req/min per IP
  • Registration: 5 attempts/min per IP

  REALTIME AUTH (Supabase)
  ─────────────────────────
  • Mobile calls POST /mobile/realtime-token
  • Server vends signed JWT (12h expiry) for Supabase Realtime channel access
  • Method: JWT signing (SUPABASE_JWT_SECRET) or magic link exchange

  ROW-LEVEL SECURITY
  ───────────────────
  • Supabase RLS policies ensure users can only see their own machines/requests
  • machine_harnesses has RLS enabled
```

---

## 10. Prompt Injection Flow

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│               MOBILE → AGENT PROMPT INJECTION FLOW                               │
└──────────────────────────────────────────────────────────────────────────────────┘

  Mobile App (user types a message in ChatScreen)
       │
       │  POST /mobile/prompt  {prompt, sessionId, machineId}
       ▼
  Server
       │  INSERT mobile_commands {status: 'pending'}
       │  Condition to deliver: agent.pending_count = 0 AND idle > 30s
       │
  Desktop heartbeat.js polling every 10s
       │  GET /mobile/command/next
       │  ← returns {prompt} if agent idle & pending_count = 0
       │
       │  Optimistic lock prevents double-delivery
       │  (server marks 'delivered' atomically before returning)
       │
       │  heartbeat.js injects prompt via:
       │  • Keystroke injection (node-pty / process signaling)
       │  • Writes to agent stdin
       ▼
  AI Agent (Claude Code / OpenCode) receives prompt
  and continues working with the user's instruction
```

---

## 11. File Browser Flow

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                     REMOTE FILE BROWSER FLOW                                     │
└──────────────────────────────────────────────────────────────────────────────────┘

  Mobile (FileBrowserScreen)
       │  POST /mobile/fs/request  {machineId, path}
       │  ← {requestId}
       │
       │  Poll every 2s: GET /mobile/fs/result/{requestId}
       │  ← {status: 'pending'}  (keep polling)
       │  15s timeout
       │
  Desktop heartbeat.js polling every 5s
       │  GET /machines/fs/pending
       │  ← {requestId, path} if job exists
       │
       │  Walk filesystem at requested path
       │  Build directory tree JSON
       │
       │  POST /machines/fs/respond  {requestId, result: {tree}}
       │
  Server
       │  UPDATE fs_requests SET status='resolved', result={tree}
       │
  Mobile (next 2s poll)
       │  GET /mobile/fs/result/{requestId}
       │  ← {status: 'resolved', result: {tree}}
       │
       ▼  Renders file tree UI
```

---

## 12. Polling Intervals Summary

```
┌─────────────────────────────────────────────────────────────────────┐
│                    POLLING INTERVALS                                 │
├───────────────────────────────────┬─────────────────────────────────┤
│ Who                               │ Interval                        │
├───────────────────────────────────┼─────────────────────────────────┤
│ Desktop → heartbeat               │ 30 seconds                      │
│ Desktop → mobile commands         │ 10 seconds                      │
│ Desktop → fs pending jobs         │ 5 seconds                       │
│ Desktop → harness desired state   │ on-demand (IPC call)            │
│ Desktop → tool decision (poll)    │ 3 seconds (fallback to Realtime) │
│ Mobile → pending requests list    │ 8 seconds                       │
│ Mobile → sessions list            │ 10 seconds                      │
│ Mobile → chat feed (/feed)        │ 30 seconds (safety net only)    │
│   └─ older history                │ on scroll-up (fetchNextPage)    │
│ Mobile → file tree result         │ 2 seconds (while loading)       │
│ Mobile → Realtime (PRIMARY)       │ push (< 1s latency)             │
│ Mobile → FCM push                 │ instant (server-triggered)      │
└───────────────────────────────────┴─────────────────────────────────┘

  NOTE: the chat feed previously ran three 5s polls (terminal + requests +
  prompts). These are replaced by a single useInfiniteQuery on /feed with a 30s
  safety poll; Supabase Realtime carries sub-second liveness.
```

---

## 13. Infrastructure

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              INFRASTRUCTURE                                      │
└──────────────────────────────────────────────────────────────────────────────────┘

  VPS (insight25.lk)
  ───────────────────
  • 2 vCPU, 8 GB RAM  (current baseline: 0–50 users)
  • Node.js Express server  (PORT 3000, default)
  • Reverse proxy (nginx or similar → https://insight25.lk)
  • PM2 cluster mode recommended for CPU utilization

  Supabase (self-hosted at database.insight25.lk)
  ─────────────────────────────────────────────────
  • PostgreSQL 15+
  • Supabase Realtime (WebSocket server)
    └─ published tables: machines, pending_requests, terminal_events,
       mobile_commands (added in 005)
  • Supabase Auth (JWT-based)
  • Row-Level Security on all user tables
  • Migrations: 003_multiharness.sql, 004_cli_alive.sql,
                005_feed_pagination.sql  (session indexes + publish mobile_commands),
                006_session_feed_view.sql (session_feed view + get_session_feed RPC)

  Firebase (Google Cloud)
  ────────────────────────
  • Firebase Cloud Messaging (FCM)
  • Service account key on VPS server
  • Sends data-only push to Android + iOS

  Desktop Distribution
  ─────────────────────
  • Electron Forge + Squirrel (Windows installer)
  • Auto-update support built-in
  • Target OS: Windows 11 (primary)

  Mobile Distribution
  ────────────────────
  • React Native 0.85.3
  • Targets: Android (Gradle) + iOS (CocoaPods)
  • Build: Metro bundler

  Scaling Path (from SCALING.md)
  ───────────────────────────────
  Tier 0: PM2 cluster mode (0 cost, instant CPU gain)
  Tier 1: Supabase Pro ($25/mo), Redis rate limiter, pg_cron TTL cleanup
  Bottlenecks: terminal_events table growth, Realtime connection limits
```

---

## 14. Chat Feed — Windowed Loading Flow

The chat (`ChatScreen`) loads like WhatsApp/Telegram: the most recent page renders
instantly, older history loads on scroll-up, and new activity streams in over Realtime.
See `AgentControl/PERFORMANCE.md` and `CHAT_PERFORMANCE_IMPLEMENTATION.md` for rationale.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   CHAT FEED — WINDOWED LOADING + LIVE EDGE                       │
└──────────────────────────────────────────────────────────────────────────────────┘

  OPEN SESSION (most-recent page)
  ─────────────────────────────────
  ChatScreen → useChatFeed (useInfiniteQuery)
       │  GET /mobile/sessions/:id/feed?limit=40        (no cursor = newest page)
       ▼
  Server → db.rpc('get_session_feed', { p_session_id, p_user_id, p_limit })
       │  SELECT from session_feed view (UNION ALL of 3 tables)
       │  ORDER BY created_at DESC, id DESC  LIMIT 40
       ▼
  ← { items:[{source,id,created_at,row}], nextCursor:"<ts>|<id>", hasMore }
       │  client flattens pages oldest→newest, maps source→ChatItem
       ▼  renders; auto-scrolls to bottom on first mount


  SCROLL UP (load older history)
  ─────────────────────────────────
  FlatList onStartReached → fetchOlder() → fetchNextPage()
       │  GET /mobile/sessions/:id/feed?before=<nextCursor>&limit=40
       │  RPC tuple cursor: (created_at,id) < (before_ts, before_id)
       ▼
  ← older page prepended to the list
       │  maintainVisibleContentPosition keeps the viewport anchored
       ▼  no jump; "isNearBottom" stays false so live edge does NOT yank down


  LIVE EDGE (new activity arrives)
  ─────────────────────────────────
  Supabase Realtime  channel chat:{sessionId}
       │  terminal_events INSERT  → append to newest page (live edge)
       │  pending_requests INSERT → append approval card
       │  pending_requests UPDATE → patch card (approved/denied) in place
       │  mobile_commands INSERT/UPDATE → append/patch sent-prompt bubble
       ▼
  Rows pushed straight into the useInfiniteQuery page cache (no refetch).
       │  if user is near bottom → auto-scroll follows
       │  if scrolled up reading  → "Jump to latest ↓" pill shown instead
       ▼
  30s safety poll only reconciles missed events if the socket dropped.
```

