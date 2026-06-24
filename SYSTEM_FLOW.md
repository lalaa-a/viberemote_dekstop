# vRdeks Multiharness — Complete System Flow

> How harness requests reach the mobile app, how the user sends prompts back, and how everything connects end-to-end.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Component Roles](#2-component-roles)
3. [Pairing & Authentication](#3-pairing--authentication)
4. [Harness Request Flow (Desktop → Mobile)](#4-harness-request-flow-desktop--mobile)
   - 4.1 [Claude Code hooks fire](#41-claude-code-hooks-fire)
   - 4.2 [Relay daemon parses & uploads](#42-relay-daemon-parses--uploads)
   - 4.3 [Server stores & pushes notification](#43-server-stores--pushes-notification)
   - 4.4 [Mobile receives & renders](#44-mobile-receives--renders)
5. [Decision Flow (Mobile → Desktop)](#5-decision-flow-mobile--desktop)
6. [Prompt Flow (Mobile → Claude Code)](#6-prompt-flow-mobile--claude-code)
7. [Narrative / Activity Stream](#7-narrative--activity-stream)
8. [Real-Time vs Polling Strategies](#8-real-time-vs-polling-strategies)
9. [Complete Message Schemas](#9-complete-message-schemas)
10. [Database Tables](#10-database-tables)
11. [Harness Adapters In Detail](#11-harness-adapters-in-detail)
12. [End-to-End Sequence Diagrams](#12-end-to-end-sequence-diagrams)
13. [File Map](#13-file-map)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  DESKTOP (Windows)                                                       │
│                                                                          │
│  ┌──────────────────┐     hooks / PTY / plugin     ┌─────────────────┐ │
│  │  AI Harness       │─────────────────────────────▶│  relay-daemon1  │ │
│  │  (Claude Code /  │◀─────────────────────────────│  (Node.js)      │ │
│  │   OpenCode /     │  keystroke / SDK inject       └────────┬────────┘ │
│  │   Gemini CLI)    │                                        │           │
│  └──────────────────┘                               HTTP (machine key)  │
└────────────────────────────────────────────────────────────┼────────────┘
                                                             │
                                                ┌────────────▼────────────┐
                                                │   SERVER (VPS / Node)   │
                                                │   vibe_remote(server)   │
                                                │                         │
                                                │  Express REST API       │
                                                │  Supabase (PostgreSQL   │
                                                │   + Realtime + RLS)     │
                                                │  Firebase FCM push      │
                                                └────────────┬────────────┘
                                                             │
                                               Supabase Realtime + FCM push
                                                             │
                                          ┌──────────────────▼──────────────────┐
                                          │  MOBILE (React Native)               │
                                          │  AgentControl                        │
                                          │                                      │
                                          │  Auth → Sessions → ChatScreen        │
                                          │  FlatList feed  ← Realtime INSERTs  │
                                          │  Approve/Deny   → POST /mobile/decide│
                                          │  Send Prompt    → POST /mobile/prompt│
                                          └──────────────────────────────────────┘
```

The system has **three tiers**:

| Tier | Location | Codebase |
|------|----------|----------|
| Desktop relay daemon | `D:\Projects\vRdeksMultiharness\relay-deamon1` | Node.js (ESM + CJS bridges) |
| Central server | `D:\Projects\vibe_remote(serverside)` | Express + Supabase + Firebase |
| Mobile client | `D:\Projects\vibe_remote(reactNative)\AgentControl` | React Native + TypeScript |

---

## 2. Component Roles

### relay-daemon1 (Desktop)

The relay daemon is a collection of Node.js scripts that intercept every tool call made by an AI harness before it runs. It:

- Reads the tool call from stdin (injected by Claude Code's hook system, or OpenCode's plugin, or a PTY wrapper for Gemini CLI)
- Parses the tool call into a human-readable summary with a risk score
- Uploads the pending request to the server and blocks until a decision (approve/deny) comes back
- After the tool runs, posts a narrative event (tool_end, notification, stop) to the server
- Also polls the server for mobile-sent prompts and injects them into the AI harness

### vibe_remote(serverside) (Server)

Acts as the central message bus and persistent store. It:

- Stores every pending tool request in `pending_requests`
- Stores every narrative event in `terminal_events`
- Stores every mobile-sent prompt in `mobile_commands`
- Authenticates desktop via machine API key (SHA-256 hash), mobile via Supabase JWT
- Broadcasts Supabase Realtime events to mobile subscribers
- Fires Firebase Cloud Messaging push notifications when a new request arrives

### AgentControl (Mobile)

The React Native app that a user uses to remotely supervise the AI agent. It:

- Shows a unified chat feed: agent output, tool approval requests, and the user's own prompts all in chronological order
- Lets the user approve or deny tool requests with a tap
- Lets the user type new prompts and send them into the AI session
- Updates in real time via Supabase Realtime subscriptions

---

## 3. Pairing & Authentication

Before any requests flow, the desktop machine must be paired to the mobile app. This uses a QR code challenge-response handshake.

### 3.1 Machine Registration (Desktop, First Launch)

```
relay-daemon1
  └─▶ POST /machines/register
        Body: { machineId, machineLabel, apiKeyHash }
        Auth: none (public endpoint, rate-limited)
        Response: { ok, machineId }
```

The machine generates a random UUID (`machineId`) and a random API key. Only the SHA-256 hash of the API key is stored on the server. The raw API key is kept locally in `%APPDATA%\my-app\machine.env`.

### 3.2 QR Challenge (Desktop → Mobile)

```
relay-daemon1
  └─▶ POST /machines/:id/challenge
        Auth: x-machine-api-key
        Response: { challenge, expiresAt }   ← 32-byte hex nonce, 5-min TTL
```

The desktop app renders `{ machineId, apiKey, challenge }` as a QR code.

### 3.3 QR Scan (Mobile)

The user opens `QRScanScreen`, scans the QR, and the app calls:

```
AgentControl
  └─▶ POST /machines/:machineId/pair
        Auth: Bearer <userJWT>
        Body: { apiKey, deviceId, challenge }
        Response: { ok, alreadyPaired? }
```

The server:
1. Hashes the submitted `apiKey` and verifies it matches the stored hash
2. Consumes the challenge nonce (sets `used_at`, prevents replay)
3. Sets `machines.user_id` and `machines.paired_device_id`
4. Issues a `session_token` that the desktop can fetch via `GET /machines/:id/session`
5. Broadcasts `paired` event on channel `machine:{machineId}` so the desktop gets notified instantly

### 3.4 Device Registration (Mobile)

On first sign-in the mobile app registers itself:

```
AgentControl
  └─▶ POST /machines/devices
        Auth: Bearer <userJWT>
        Body: { deviceName, platform }
        Response: { deviceId }
```

The `deviceId` is stored in MMKV (persisted across restarts). Every subsequent API request includes the header `x-device-id: {deviceId}`.

### 3.5 Push Token Registration (Mobile)

```
AgentControl
  └─▶ POST /mobile/push-token
        Auth: Bearer <userJWT>
        Body: { token, platform }   ← FCM registration token
```

Stored in `push_tokens` table. Used later when the server sends FCM push notifications for new approval requests.

---

## 4. Harness Request Flow (Desktop → Mobile)

This is the critical path: a tool call in Claude Code reaching the user's phone for approval.

### 4.1 Claude Code Hooks Fire

Claude Code is configured (via `~/.claude/settings.json`) with four hooks:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Write|Edit|MultiEdit|Read",
      "hooks": [{ "type": "command", "command": "node hook-wrapper.cjs" }]
    }],
    "PostToolUse": [{
      "matcher": "Bash|Write|Edit|MultiEdit|Read",
      "hooks": [{ "type": "command", "command": "node postHook-wrapper.cjs" }]
    }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node notifyHook-wrapper.cjs" }] }],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "node stopHook-wrapper.cjs" }] }]
  }
}
```

When Claude Code is about to run `Bash`, `Write`, `Edit`, `MultiEdit`, or `Read`, it:

1. Serialises the tool call as JSON
2. Pipes it to the matching hook script via **stdin**
3. **Blocks** until the hook process exits
4. Reads the exit code: `0` = allow, `2` = block

The `hook-wrapper.cjs` files are thin CommonJS shims (because Claude Code calls hooks via `node`, which defaults to CJS on Windows). They dynamically `import()` the actual ES module hook.

**Stdin payload to PreToolUse hook (`hook.js`):**
```json
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm install",
    "cwd": "D:/Projects/..."
  },
  "session_id": "abc-123-uuid",
  "transcript_path": "C:/Users/.../.claude/transcripts/session.jsonl"
}
```

### 4.2 Relay Daemon Parses & Uploads

Inside `hook.js` the following happens in sequence:

#### Step 1 — Read stdin
```js
const raw = await readStdinWithTimeout(3000)  // 3-second timeout
const event = JSON.parse(raw)
```

#### Step 2 — Cache Claude's PID
The hook walks the Windows process tree via PowerShell to find the actual `claude.exe` PID (not the transient shell PID). This is stored in `C:\temp\relay-pid-{sessionId}.txt` so the heartbeat daemon can inject keystrokes later.

```powershell
Get-CimInstance Win32_Process
# Walk ParentProcessId chain from current PID
# Until CommandLine matches 'claude' and not 'hook-wrapper|heartbeat|relay-deamon'
```

#### Step 3 — Record transcript path
```
C:\temp\transcript-paths\{sessionId}.path  ←  path/to/transcript.jsonl
```
Used by the heartbeat daemon to tail the transcript for narrative streaming.

#### Step 4 — Pre-filter check
`filter.js` checks `ALWAYS_BLOCK` and `ALWAYS_ALLOW` regex lists. If a match is found, the decision is made immediately without uploading to the server.

#### Step 5 — Parse & risk-assess
`parsers.js` reads `tool_name` and builds a rich display object:

| Field | Source |
|-------|--------|
| `summary` | e.g. `"npm install"` for Bash, `"Edit src/App.tsx"` for Edit |
| `risk_level` | `low / medium / high / critical` (from `risk.js` regex patterns) |
| `risk_reason` | e.g. `"Installs npm packages"` |
| `risk_icon` | `✅ 🔶 ⚠️ 🚨` |
| `diff` | Structured hunks (from `differ.js`) for Write/Edit/MultiEdit |
| `files_affected` | List of file paths |

**Risk patterns (examples):**

| Level | Example triggers |
|-------|-----------------|
| critical | `rm -rf /`, `mkfs`, `dd if=...of=/dev/` |
| high | recursive delete, `sudo`, `curl \| bash`, `chmod 777`, paths like `.env`/`id_rsa` |
| medium | `npm install`, `pip install`, `git push`, docker commands, database ops |
| low | everything else |

#### Step 6 — Agent ping
```
POST /relay/agent-ping
Auth: x-machine-api-key
Body: { sessionId, cwd, toolName }
Response: { agentId }
```
Upserts a row in the `agents` table so the mobile app can see active sessions.

#### Step 7 — Upload request
```
POST /relay/upload
Auth: x-machine-api-key
Body: { payload: { id, harness, session_id, tool_name, display_type, summary,
                   risk_level, risk_reason, risk_icon, files_affected,
                   command, file_path, old_content, new_content, raw_input,
                   diff, status: "pending", created_at } }
Response: { id }   ← same UUID we generated
```

The hook stores the returned UUID in `C:\temp\relay-current.txt`.

#### Step 8 — Show terminal feedback
The hook prints to **stderr** (so Claude Code displays it to the user in the terminal):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RELAY  Bash  🔶 medium
  npm install
  
  → Sent to mobile app for approval
    Or respond from terminal:
      ! node relay.cjs 1   (Yes)
      ! node relay.cjs 3   (No)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

#### Step 9 — Block and wait for decision

The hook enters a **race** between two parallel mechanisms:

```
┌──────────────────────────────────────────────────────┐
│  RACE: whichever resolves first wins                  │
│                                                       │
│  Path A — Supabase Realtime (fast)                   │
│    supabase.channel(`decision:{requestId}`)           │
│    .on('postgres_changes',                            │
│        filter: `id=eq.{requestId}`,                  │
│        event: 'UPDATE')                               │
│    → resolves when status changes to approved|denied  │
│                                                       │
│  Path B — HTTP Polling (reliable fallback)           │
│    setInterval(() =>                                  │
│      GET /relay/status/{requestId}                   │
│    , 3000)                                            │
│    → resolves when status != 'pending'                │
│                                                       │
│  Path C — CLI file signal (local fallback)           │
│    setInterval(() =>                                  │
│      fs.exists(`C:\temp\relay-pending\{id}.approved`)│
│    , 150)                                             │
│                                                       │
│  Timeout: 300 seconds (configurable via env)         │
└──────────────────────────────────────────────────────┘
```

#### Step 10 — Exit with decision
- `approved` → `process.exit(0)` → Claude Code runs the tool
- `denied`   → `process.exit(2)` → Claude Code blocks the tool
- `timeout` + `failOpen=true` → `process.exit(0)` (allow, log warning)
- `timeout` + `failOpen=false` → `process.exit(2)` (block, safe default)

### 4.3 Server Stores & Pushes Notification

When `POST /relay/upload` arrives at the server (`relay.js` route):

1. Inserts the full payload into `pending_requests` (with `status: 'pending'`)
2. Resolves `agent_id` by looking up `agents` table via `session_id`
3. Calls `syncAgentPendingCount(agentId)` — counts actual pending rows and updates `agents.pending_count`
4. Calls `notifyMachine(machineId, { title, body, requestId })` — fires FCM push

**FCM push payload sent to the paired phone:**
```json
{
  "data": {
    "requestId": "uuid",
    "title": "Bash — medium risk",
    "body": "npm install"
  },
  "android": { "priority": "high" },
  "apns": {
    "headers": { "apns-priority": "5" },
    "payload": { "aps": { "contentAvailable": true } }
  }
}
```

Supabase also automatically publishes the row INSERT to any Realtime subscribers filtered on `pending_requests` for that `session_id`.

### 4.4 Mobile Receives & Renders

On the mobile side, `useChatFeed` has a Supabase Realtime subscription active whenever `ChatScreen` is mounted:

```
Channel: chat:{sessionId}
Subscriptions:
  INSERT on terminal_events    → append OutputBubble / ActivityBubble
  INSERT on pending_requests   → append RequestCard
  UPDATE on pending_requests   → patch status in-place
  INSERT on mobile_commands    → append SentBubble
  UPDATE on mobile_commands    → patch delivery status
```

When the `pending_requests` INSERT event arrives, the `FeedRow` renderer displays a `RequestCard`:

```
┌─────────────────────────────────────────────┐
│  🔶 MEDIUM  Bash                             │
│  npm install                                 │
│  Installs npm packages                       │
│                                              │
│  ┌───────────────────────────────────────┐  │
│  │ $ npm install                         │  │
│  └───────────────────────────────────────┘  │
│                                              │
│       [ ✓ Allow ]     [ ✗ Deny ]            │
└─────────────────────────────────────────────┘
```

For `Write`/`Edit` operations, the card also shows a syntax-highlighted diff using the `DiffViewer` component (built from the `diff.hunks` array).

---

## 5. Decision Flow (Mobile → Desktop)

When the user taps Allow or Deny on the `RequestCard`:

### Step 1 — Mobile posts decision

```
POST /mobile/decide
Auth: Bearer <userJWT>
Body: { requestId: "uuid", decision: "approved" | "denied" }
Response: { ok: true }
```

### Step 2 — Server updates row

```sql
UPDATE pending_requests
   SET status     = 'approved',
       decided_at = now(),
       decided_by = 'mobile'
 WHERE id = '{requestId}'
   AND user_id = '{userId}'
   AND machine_id IN (paired machines for this user)
```

Then calls `syncAgentPendingCount(agentId)` to decrement the badge count.

### Step 3 — Supabase publishes UPDATE

The `pending_requests` row update is automatically broadcast by Supabase Realtime to all subscribers. The desktop `hook.js` Realtime listener fires immediately and resolves the race:

```
supabase.channel(`decision:{requestId}`)
  .on('postgres_changes', ...)
  → payload.new.status === 'approved'
  → decision resolved
  → hook.js exits 0
```

The HTTP polling path (running in parallel) also eventually sees the status change if Realtime drops. The file signal path handles the case where the user responds from the terminal instead of the phone.

### Step 4 — Mobile feed updates

The same UPDATE event also reaches the mobile `useChatFeed` subscription and patches the `RequestCard` in place — showing a green "Approved by you" or red "Denied by you" badge without a page reload.

---

## 6. Prompt Flow (Mobile → Claude Code)

The user can also type a new prompt into the compose bar and send it directly into the AI session.

### 6.1 Compose Bar (Mobile)

`ChatScreen` renders a text input at the bottom. The bar has five states:

| State | Condition | UI |
|-------|-----------|-----|
| Normal | Session active, no pending requests | TextInput + Send button |
| Pending approvals | `pending_count > 0` | Lock note: "Decide pending requests first" |
| CLI closed | `cli_alive === false` | Warning: terminal may be closed |
| Mobile support off | `harness_enabled === false` | Power icon: toggle on desktop |
| Machine offline | `machine_is_online === false` | Greyed placeholder |

### 6.2 Send Prompt (Mobile → Server)

```
POST /mobile/prompt
Auth: Bearer <userJWT>
Body: { prompt: "add a loading spinner to the button", sessionId: "abc-123" }
Response: { id: "command-uuid" }
```

Server logic:
1. Resolves `targetMachineId` from `sessionId` (via `agents` table) or defaults to first paired machine
2. Checks `machine_harnesses.mobile_enabled === true` for the session's harness
3. Checks `agents.cli_alive === true`
4. Inserts into `mobile_commands` table with `status: 'pending'`
5. Returns the new command's `id`

After a successful send:
- The prompt is immediately visible in the feed as a right-aligned `SentBubble`
- Status shows as "pending" (not yet picked up by the desktop)

### 6.3 Delivery Detection (Desktop Polling)

The relay daemon (specifically the heartbeat process) polls:

```
GET /mobile/command/next
Auth: x-machine-api-key
Response: { id, prompt, sessionId } | null
```

The server returns the oldest undelivered `mobile_commands` row for this machine **only when the agent is idle** (no pending approval requests). This prevents a prompt from interrupting the AI in the middle of a tool sequence.

When a command is returned, the server atomically marks it as `status: 'delivered'`, `delivered_at: now()`.

### 6.4 Keystroke Injection (Desktop → Harness)

Once the relay daemon receives the prompt, it injects it into the appropriate harness:

#### Claude Code (keystroke injection)

The heartbeat daemon uses the cached PID from `C:\temp\relay-pid-{sessionId}.txt` and injects keystrokes directly into the Claude Code terminal process via Windows API:

```powershell
# Write text to the Claude process window
[void][System.Reflection.Assembly]::LoadWithPartialName('Microsoft.VisualBasic')
Microsoft.VisualBasic.Interaction::AppActivate($pid)
# send keystrokes
```

This simulates the user typing in the terminal — Claude Code sees it as a new user prompt and begins responding.

#### OpenCode (SDK injection)

```js
// opencode/provider.js
await injector.deliver(sessionId, prompt)
// Calls: session.prompt({ path: { id: sessionId }, body: { parts: [{ type: 'text', text: prompt }] } })
```

Uses the `@opencode-ai/sdk` to deliver the prompt programmatically.

#### Gemini CLI (PTY write)

```js
// gemini-cli PTY proxy
term.write(prompt + '\r')
```

The PTY wrapper writes the prompt directly to Gemini CLI's stdin.

### 6.5 Mobile Feed Reflects Delivery

When the server marks the `mobile_commands` row as `delivered`, the Supabase UPDATE event reaches the mobile feed and the `SentBubble` switches from "pending" to "delivered" (a subtle tick indicator).

---

## 7. Narrative / Activity Stream

Between tool calls, Claude Code emits progress notifications and the PostToolUse/Notification/Stop hooks capture them. These are sent to the server as `terminal_events` and appear in the mobile feed as lighter activity bubbles.

### Event Types

| event_type | Hook source | Mobile display |
|------------|-------------|----------------|
| `tool_start` | PreToolUse (future) | Small activity pill |
| `tool_end` | PostToolUse hook (`postHook.js`) | Tool result summary |
| `notification` | Notification hook (`notifyHook.js`) | Claude's progress message |
| `output` | OpenCode event hook / Gemini PTY | Raw output fragment |
| `stop` | Stop hook (`stopHook.js`) | "Task complete" divider |

### PostToolUse event payload

```
POST /relay/terminal-event
Auth: x-machine-api-key
Body: {
  session_id: "abc-123",
  harness:    "claude-code",
  event_type: "tool_end",
  tool_name:  "Bash",
  summary:    "Bash: npm install",
  detail:     "added 42 packages",   ← first 500 chars of output
  status:     "success"
}
```

### Stop hook cleanup

`stopHook.js` does two things:
1. Posts `event_type: 'stop'` to the server
2. Deletes `C:\temp\transcript-paths\{sessionId}.path` — signals to the heartbeat daemon that this session has ended and it should stop tailing the transcript

---

## 8. Real-Time vs Polling Strategies

The system uses multiple parallel strategies for reliability.

### Desktop → Server (Always HTTP)

| Operation | Mechanism | Frequency |
|-----------|-----------|-----------|
| Request upload | `POST /relay/upload` | Per tool call |
| Decision wait (primary) | Supabase Realtime `postgres_changes` | Event-driven |
| Decision wait (fallback) | `GET /relay/status/{id}` | Every 3s |
| Decision wait (local) | File poll `C:\temp\relay-pending\*.approved` | Every 150ms |
| Heartbeat | `POST /machines/heartbeat` | Every 15s |
| Session alive reconcile | `POST /relay/sessions-alive` | Every 15s |
| Harness desired poll | `GET /harness/desired` | Every 15s |
| Prompt delivery | `GET /mobile/command/next` | Inside heartbeat loop |

### Server → Mobile (Supabase Realtime + FCM)

| Event | Mechanism | Channel |
|-------|-----------|---------|
| New tool request arrives | Supabase Realtime INSERT | `chat:{sessionId}` |
| Request decision changes | Supabase Realtime UPDATE | `chat:{sessionId}` |
| User's prompt appears | Supabase Realtime INSERT | `chat:{sessionId}` |
| Prompt delivered | Supabase Realtime UPDATE | `chat:{sessionId}` |
| Agent output event | Supabase Realtime INSERT | `chat:{sessionId}` |
| Machine paired/unpaired | Supabase Realtime broadcast | `machine:{machineId}` |
| Harness state changed | Supabase Realtime broadcast | `machine:{machineId}` |
| New request (app in background) | Firebase Cloud Messaging push | FCM token |

### Mobile Polling (Safety Net)

React Query provides fallback polling when Realtime misses an event:

| Data | Refetch Interval |
|------|-----------------|
| Session list | 5s |
| Chat feed | 30s (Realtime is primary) |
| Pending requests | 8s |
| Harness states | 10s |
| Machines list | 30–60s |
| Terminal events | 5–30s |

---

## 9. Complete Message Schemas

### 9.1 PreToolUse hook stdin (Claude Code → relay daemon)

```typescript
{
  tool_name:       "Bash" | "Write" | "Edit" | "MultiEdit" | "Read",
  tool_input:      {
    // Bash:
    command?:      string,
    cwd?:          string,
    // Write:
    file_path?:    string,
    content?:      string,
    // Edit:
    file_path?:    string,
    old_string?:   string,
    new_string?:   string,
    // MultiEdit:
    edits?:        Array<{ file_path, old_string, new_string }>,
    // Read:
    file_path?:    string,
    offset?:       number,
    limit?:        number,
  },
  session_id:      string,      // UUID
  transcript_path: string,      // absolute path
}
```

### 9.2 Pending request (relay daemon → server → mobile)

```typescript
{
  id:             string,            // UUID generated by daemon
  harness:        "claude-code" | "opencode" | "gemini-cli",
  user_id:        string,            // set server-side from machine ownership
  machine_id:     string,
  session_id:     string | null,
  tool_name:      "Bash" | "Write" | "Edit" | "MultiEdit" | "Read",
  display_type:   "bash" | "write" | "edit" | "multi_edit" | "read" | "unknown",
  summary:        string,            // "npm install" or "Edit src/App.tsx"
  risk_level:     "low" | "medium" | "high" | "critical",
  risk_reason:    string,
  risk_icon:      "✅" | "🔶" | "⚠️" | "🚨" | "👁️",
  files_affected: string[],
  command:        string | null,     // Bash only
  file_path:      string | null,
  old_content:    string | null,     // Edit only
  new_content:    string | null,     // Write/Edit
  raw_input:      object,            // full original tool_input
  diff: {
    // For Write (file_diff):
    type:         "file_diff",
    is_new_file:  boolean,
    file_path:    string,
    language:     string,            // "typescript", "python", etc.
    stats:        { added: number, removed: number },
    hunks: [{
      type:       "add" | "remove" | "context",
      content:    string,
      line_old?:  number,
      line_new?:  number,
    }],

    // For Edit (edit_diff):
    type:         "edit_diff",
    edit_line:    number,
    word_diff:    [{ value: string, added: boolean, removed: boolean }],

    // For MultiEdit (multi_edit_diff):
    type:         "multi_edit_diff",
    files:        [/* per-file diffs */],
    file_count:   number,
    edit_count:   number,
    grand_stats:  { added: number, removed: number },
  } | null,
  status:         "pending" | "approved" | "denied" | "timeout" | "cli_pending",
  decided_at:     string | null,     // ISO 8601
  decided_by:     "pc" | "mobile" | null,
  created_at:     string,            // ISO 8601
}
```

### 9.3 Terminal event (relay daemon → server → mobile)

```typescript
{
  id:          string,               // UUID (set by server)
  session_id:  string,
  machine_id:  string,
  harness:     string,
  event_type:  "tool_start" | "tool_end" | "notification" | "output" | "stop",
  tool_name:   string | null,
  summary:     string | null,        // max 4000 chars
  detail:      string | null,        // first 500 chars of output
  status:      "success" | "error" | null,
  created_at:  string,               // ISO 8601 (set by server)
}
```

### 9.4 Mobile command / prompt (mobile → server → desktop)

```typescript
// POST /mobile/prompt body:
{
  prompt:    string,                 // user's text
  sessionId: string | null,          // target session UUID
}

// Stored row / Realtime event:
{
  id:           string,
  machine_id:   string,
  user_id:      string,
  session_id:   string | null,
  prompt:       string,
  status:       "pending" | "delivered" | "cancelled",
  created_at:   string,
  delivered_at: string | null,
}
```

### 9.5 Agent session (server → mobile feed list)

```typescript
{
  id:                string,         // agents.id
  machine_id:        string,
  machine_label:     string,
  machine_is_online: boolean,
  session_id:        string,
  cwd:               string | null,
  harness:           string,
  cli_alive:         boolean,
  harness_enabled:   boolean,
  status:            "active" | "idle" | "finished",  // derived from last_activity_at
  pending_count:     number,
  last_activity_at:  string,
  started_at:        string,
}
```

### 9.6 Decision payload (mobile → server)

```typescript
// POST /mobile/decide body:
{
  requestId: string,
  decision:  "approved" | "denied",
}
```

### 9.7 Unified chat feed item

```typescript
// GET /mobile/sessions/:id/feed response:
{
  items: FeedRow[],
  nextCursor: string | null,  // "{created_at}|{id}" tuple cursor
  hasMore: boolean,
}

type FeedRow = {
  source:     "terminal" | "request" | "prompt",
  id:         string,
  created_at: string,
  row:        TerminalEvent | PendingRequest | MobileCommand,
}
```

---

## 10. Database Tables

| Table | Purpose |
|-------|---------|
| `machines` | Desktop machine registry (id, api_key_hash, user_id, paired_device_id) |
| `agents` | Active AI sessions (session_id, cwd, harness, cli_alive, pending_count) |
| `pending_requests` | Tool-use approval queue |
| `terminal_events` | Narrative activity log (tool output, notifications, stops) |
| `mobile_commands` | User-sent prompts queue |
| `mobile_devices` | Registered phones (push_token, platform) |
| `push_tokens` | FCM tokens per device |
| `machine_challenges` | QR pairing nonces (5-min TTL, one-time use) |
| `machine_harnesses` | Per-harness capability + mobile_enabled state per machine |
| `fs_requests` | File browser requests/results |
| `profiles` | User display name / avatar |

**Key indexes used for feed pagination:**
- `(session_id, created_at DESC)` on `pending_requests` and `mobile_commands`
- `(session_id, created_at DESC)` on `terminal_events`

**Supabase RPC used for feed:**
```sql
-- get_session_feed(p_session_id, p_user_id, p_before_ts, p_before_id, p_limit)
-- Merges terminal_events + pending_requests + mobile_commands
-- Ordered by (created_at DESC, id DESC) for stable cursor pagination
-- Returns rows with: source, id, created_at, row (jsonb)
```

---

## 11. Harness Adapters In Detail

The daemon supports three AI harnesses, each with a different interception mechanism.

### 11.1 Claude Code (`claude-code`)

- **Approval mechanism:** `settingsHook` — modifies `~/.claude/settings.json`
- **Event capture:** stdin/stdout hooks (PreToolUse, PostToolUse, Notification, Stop)
- **Prompt injection:** PowerShell keystroke injection via cached PID
- **File tree:** Supported (heartbeat reads filesystem and serves via `/machines/fs/respond`)
- **Session list:** Supported
- **Fail-open default:** Yes (`failOpen=true`)

Hooks fire for: `Bash`, `Write`, `Edit`, `MultiEdit`, `Read`

### 11.2 OpenCode (`opencode`)

- **Approval mechanism:** `plugin` — copies `relay.js` to `~/.config/opencode/plugin/vibe-relay.js`
- **Event capture:** Three plugin hooks: `tool.execute.before` (gate), `tool.execute.after` (narrative), `event` (streaming reasoning)
- **Prompt injection:** `@opencode-ai/sdk` `session.prompt()` call
- **File tree:** Not supported
- **Session list:** Not supported
- **Fail-open:** Follows machine config

Hooks fire for: `bash`, `edit`, `write`, `patch`

### 11.3 Gemini CLI (`gemini-cli`)

- **Approval mechanism:** `ptyProxy` — wraps Gemini CLI in a pseudo-terminal
- **Event capture:** Stdout stream; grammar patterns detect when Gemini asks "Allow this? [y/N]"
- **Prompt injection:** Write directly to PTY stdin
- **File tree:** Not supported
- **Session list:** Not supported
- **Fail-open default:** No (`failOpen=false` — safer default since no hook blocking)

**Grammar patterns watched:**
```
/Allow execution of [`'"]?(.+?)[`'"]?\?\s*\[y\/N\]/i  → y\r / n\r
/Apply this change to (.+?)\?\s*\(y\/n\)/i             → y\r / n\r
/Do you want to proceed\?\s*\[Y\/n\]/i                 → \r  / n\r
```

---

## 12. End-to-End Sequence Diagrams

### 12.1 Tool approval (happy path)

```
Claude Code          relay daemon         Server (VPS)         Mobile App
─────────────────────────────────────────────────────────────────────────
User runs "npm i"
     │
     ├─ fires PreToolUse hook (stdin JSON) ──────────────────────────────
     │                    │
     │            parse & risk-assess
     │                    │
     │            POST /relay/upload ──────▶ INSERT pending_requests
     │                    │                       │
     │                    │                 FCM push ─────────────────▶  🔔 notification
     │                    │                       │                           │
     │                    │                 Supabase Realtime ─────────────▶  RequestCard appears
     │                    │                       │                           │
     │            wait for decision               │                     user taps Allow
     │                    │                       │◀── POST /mobile/decide ───┘
     │                    │                 UPDATE status='approved'
     │                    │                       │
     │                    │◀─ Realtime UPDATE ─────┘
     │            exit 0 ◀┘
     │
     ├─ tool runs (npm install)
     │
     └─ PostToolUse fires ──────────────────▶ POST /relay/terminal-event (tool_end)
                                                    │
                                             INSERT terminal_events
                                                    │
                                             Supabase Realtime ────────────▶ ActivityBubble appears
```

### 12.2 User sends a prompt from mobile

```
Mobile App           Server (VPS)         relay daemon         Claude Code
─────────────────────────────────────────────────────────────────────────
User types prompt
taps Send
     │
     ├─ POST /mobile/prompt ──────────────▶ INSERT mobile_commands (pending)
     │                                            │
     │                                      Supabase Realtime ──────────────────────────────▶ SentBubble (pending)
     │                                            │
     │                             (heartbeat loop, every ~15s)
     │                                            │◀── GET /mobile/command/next ──┘
     │                                      UPDATE status='delivered'
     │                                            │
     │                                      Supabase Realtime ──────────────────────────────▶ SentBubble (delivered ✓)
     │                                                               │
     │                                                      inject keystrokes into
     │                                                      Claude process
     │                                                               │
     │                                                      Claude reads prompt
     │                                                      and starts responding
     │                                                               │
     │                                      POST /relay/terminal-event ◀─────────────────────┘
     │                                            │
     │                                      Realtime ──────────────────────────────────────▶ OutputBubble appears
```

---

## 13. File Map

### relay-deamon1 (Desktop)

```
relay-deamon1/
├── hook.js                          PreToolUse gate (main approval logic)
├── hook-wrapper.cjs                 CJS→ESM bridge for hook.js
├── postHook.js                      PostToolUse narrative emitter
├── postHook-wrapper.cjs
├── notifyHook.js                    Notification hook forwarder
├── notifyHook-wrapper.cjs
├── stopHook.js                      Stop hook + session cleanup
├── stopHook-wrapper.cjs
├── harness-cli.js                   CLI bridge to harness registry
├── relay.cjs                        User control script (approve/deny/status)
├── src/
│   ├── config.js                    Env var loading (MACHINE_ID, API_URL, etc.)
│   ├── logger.js                    JSON structured logging
│   ├── machineEnv.js                Credential path resolution (%APPDATA%)
│   ├── parsers.js                   parseEvent() → display payload per tool type
│   ├── differ.js                    diffForWrite/Edit/MultiEdit() → hunk arrays
│   ├── risk.js                      assessRisk() regex patterns → risk_level
│   ├── filter.js                    preFilter() ALWAYS_BLOCK/ALLOW lists
│   ├── registry.js                  Harness discovery + adapter loading
│   ├── supabase.js                  Realtime decision listener + polling
│   ├── harness-sdk/
│   │   ├── env.js                   machineCtx(), isRegistered()
│   │   ├── transport.js             apiPost/Get, uploadRequest, pollDecision, postNarrative
│   │   ├── schema.js                CANONICAL_TOOLS, RISK_LEVELS, normalizeRequest()
│   │   ├── validate.js              validateProvider(), SDK_VERSION
│   │   └── strategies/
│   │       ├── settingsHook.js      Modify ~/.claude/settings.json (Claude Code)
│   │       ├── plugin.js            Copy plugin file (OpenCode)
│   │       ├── ptyProxy.js          Pseudo-terminal wrapper (Gemini CLI)
│   │       └── null.js              Observer-only (no gate)
│   └── harnesses/
│       ├── claude-code/
│       │   ├── provider.js          Hook installer + narrator + injector references
│       │   └── manifest.json
│       ├── opencode/
│       │   ├── provider.js          Plugin installer + SDK narrator + SDK injector
│       │   ├── plugin/relay.js      Three hook points (before/after/event)
│       │   └── manifest.json
│       └── gemini-cli/
│           ├── provider.js          PTY wrapper + null-strategy toggle
│           ├── grammar.js           PATTERNS regex → keystroke answers
│           └── manifest.json
```

### vibe_remote(serverside) (Server)

```
vibe_remote(serverside)/
├── src/
│   ├── index.js                     Express server + route mounting
│   ├── supabase.js                  Service-role + anon Supabase clients
│   ├── realtime.js                  broadcastMachine() → Supabase HTTP broadcast
│   ├── notify.js                    notifyMachine() → Firebase FCM
│   ├── utils.js                     syncAgentPendingCount(), deriveStatus()
│   ├── middleware/
│   │   └── auth.js                  requireUserAuth, requireMachineAuth, attachDevice
│   └── routes/
│       ├── machines.js              /machines/* (register, heartbeat, pair, fs, devices)
│       ├── relay.js                 /relay/* (upload, decide, terminal-event, agent-ping)
│       ├── mobile.js                /mobile/* (sessions, feed, decide, prompt, fs, push-token)
│       ├── harness.js               /harness/* (report, desired, desire toggle)
│       └── profile.js               /profile/* (get, patch, password, delete)
├── supabase/
│   └── schema.sql                   Base DDL
└── migrations/
    ├── 003_multiharness.sql
    ├── 004_cli_alive.sql
    ├── 005_feed_pagination.sql
    ├── 006_session_feed_view.sql
    ├── 007_user_accounts_pairing.sql
    └── 008_mobile_first_pairing.sql
```

### AgentControl (Mobile)

```
AgentControl/src/
├── api/
│   ├── server.ts                    All REST functions (sendPrompt, decideRequest, etc.)
│   ├── realtime.ts                  getRealtimeClient() — cached Supabase Realtime client
│   ├── supabase.ts                  Supabase auth client (MMKV storage adapter)
│   └── device.ts                    getDeviceId / saveDeviceId (MMKV)
├── hooks/
│   ├── useAuth.ts                   signIn/signUp/signOut, session state
│   ├── useChatFeed.ts               Unified paginated feed + Realtime subscriptions
│   ├── useSessions.ts               Session list + useSendPrompt mutation
│   ├── useRequests.ts               Approval queue + useDecideRequest mutation
│   ├── useTerminal.ts               Terminal events query
│   ├── useMachineChannel.ts         Machine broadcast listener (paired/unpaired/harness)
│   ├── useFileTree.ts               File browser with lazy-load + polling
│   └── usePushNotifications.ts      FCM + Notifee setup
├── navigation/
│   └── RootNavigator.tsx            Auth guard + Tab navigator + device bootstrap
├── screens/
│   ├── Auth/
│   │   ├── SignInScreen.tsx
│   │   ├── SignUpScreen.tsx
│   │   └── QRScanScreen.tsx         Camera + pairMachine() + error codes
│   ├── Sessions/
│   │   ├── SessionsScreen.tsx       Session list with machine filter chips
│   │   ├── ChatScreen.tsx           Main chat (FlatList feed + compose bar)
│   │   └── FileBrowserScreen.tsx    Lazy tree view of machine filesystem
│   ├── Machines/
│   │   └── MachinesScreen.tsx       Machine list + harness toggles
│   ├── Requests/
│   │   └── RequestDetailScreen.tsx  Full request view + approve/deny
│   └── Profile/
│       └── ProfileScreen.tsx        Profile editor + sign out
├── store/
│   └── useAppStore.ts               Zustand (session, deviceId, selectedMachineId, toast)
└── types/
    └── index.ts                     All TypeScript types
```

---

*Document generated 2026-06-20. Covers relay-deamon1, vibe_remote(serverside), and AgentControl (ReactNative) as analysed from source.*
