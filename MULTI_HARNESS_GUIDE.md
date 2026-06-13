# Multi-Harness Support + Per-Harness Mobile Toggle

**Goal:** Let Vibe Remote drive more than one coding agent ("harness") — starting with **Claude Code** (already supported) and **OpenCode** — and let the user switch *mobile support* on/off **independently per harness** from the desktop dashboard (and optionally from the phone).

This guide spans all three repos:

| Repo | Path | Role |
|---|---|---|
| Desktop | `D:\Projects\vibe_remote(dekstop)\my-app` | Electron app + `relay-deamon1` daemon — the orchestrator |
| Server | `D:\Projects\vibe_remote(serverside)` | Express API on `insight25.lk`, holds the Supabase service key |
| Mobile | `D:\Projects\vibe_remote(reactNative)\AgentControl` | React Native app |

---

## 0. TL;DR — what we're building

1. A **harness adapter** abstraction in the daemon: everything that is "how Claude Code works" becomes one implementation of a common interface; OpenCode becomes a second implementation.
2. A **per-harness on/off** state, stored on the machine and mirrored to the server, so the desktop shows one toggle **per installed harness** instead of the single "Claude Code Interception" toggle.
3. A new **OpenCode relay plugin** that does for OpenCode what `hook.js` does for Claude Code (gate tool calls, stream narrative), plus SDK-based prompt injection that *replaces* the fragile Win32 keystroke injection.
4. Small **schema + route** changes so every request/session/terminal event carries a `harness` tag, and the mobile app can label (and optionally remote-toggle) each harness.

> **Why an adapter, not `if (harness === 'opencode')` everywhere?** The coupling to Claude Code is spread across `main.js`, `relay.cjs`, `hook.js`, and `heartbeat.js`. Centralizing it behind one interface is the difference between adding harness #3 in an afternoon vs. re-touching four files every time.

---

## 1. How it works today (Claude Code only)

Reading the current code, the integration touches exactly five Claude-Code-specific things:

| # | Coupling point | Where | Claude Code specifics |
|---|---|---|---|
| 1 | **Interception install** | `src/main.js → buildHookBlock()`, `relay.cjs → HOOK_BLOCK` | Writes a hook block into `~/.claude/settings.json` |
| 2 | **Tool gating** | `relay-deamon1/hook.js` | `PreToolUse` hook reads stdin JSON, `exit 0` = allow / `exit 2` = deny |
| 3 | **Tool matchers** | both above | Hardcoded `Bash\|Write\|Edit\|MultiEdit\|Read` |
| 4 | **Narrative stream** | `scripts/heartbeat.js → tailOneTranscript()` | Tails `~/.claude/projects/<cwd>/<session>.jsonl` |
| 5 | **Prompt injection** | `scripts/heartbeat.js → tryInjectIntoExistingTerminal()` | `claude --resume` + Win32 `WriteConsoleInput`/clipboard paste |

Everything else — the VPS API (`/relay/*`, `/mobile/*`), the Supabase tables (`pending_requests`, `agents`, `terminal_events`, `fs_requests`), the mobile app — is **harness-agnostic already**. That's the good news: ~80% of the system doesn't care which agent produced a request.

The single desktop toggle today:

```jsx
// Dashboard.jsx
await window.relay.setHookEnabled(!hookEnabled);   // → main.js writes/removes settings.json hooks
```

---

## 2. Target architecture — the harness adapter

Create a small adapter layer in the daemon. Each harness implements:

```ts
// relay-deamon1/src/harness/types.d.ts  (illustrative interface)
interface HarnessAdapter {
  id: 'claude-code' | 'opencode';
  displayName: string;                       // "Claude Code", "OpenCode"

  // Detection — is this CLI installed on the machine?
  isInstalled(): Promise<boolean>;

  // Mobile support lifecycle (idempotent)
  enableMobile(ctx: MachineCtx): Promise<void>;   // install hooks/plugin
  disableMobile(): Promise<void>;                 // remove them, clean up
  isMobileEnabled(): boolean;

  // Narrative: how do we read the agent's "thinking" text for the Terminal tab?
  // Returns events to POST to /relay/terminal-event. Implementation differs wildly
  // (Claude = tail JSONL; OpenCode = SDK SSE), so each adapter owns its own watcher.
  startNarrativeWatcher(post: (e: TerminalEvent) => void): () => void;  // returns stop()

  // Prompt injection: deliver a prompt from mobile into a session
  injectPrompt(sessionId: string | null, prompt: string, cwd: string): Promise<boolean>;
}
```

```
relay-deamon1/
  src/
    harness/
      types.d.ts
      registry.js          ← getAdapter(id), listInstalled()
      claudeCode.js        ← existing behavior, extracted
      opencode.js          ← NEW
    config.js              ← unchanged
  hook.js                  ← stays Claude-Code's PreToolUse entrypoint
  opencode-plugin/
    relay.js               ← NEW — OpenCode's equivalent of hook.js
```

The **request payload** that both adapters ultimately produce is identical (the `row` object in `hook.js`), with **one new field: `harness`**. That single field is what flows all the way to the phone.

---

## 3. Data model changes (Supabase)

Run these in Studio (SSH tunnel → `http://localhost:8001`) or via `docker exec ... psql`. All are additive and backward-compatible (defaults make existing rows = Claude Code).

```sql
-- 1. Tag every request, session, and terminal event with its harness.
alter table pending_requests add column if not exists harness text not null default 'claude-code';
alter table agents          add column if not exists harness text not null default 'claude-code';
alter table terminal_events add column if not exists harness text not null default 'claude-code';

-- 2. Per-machine, per-harness mobile state. One row per (machine, harness).
--    `installed`      = CLI detected on the machine
--    `mobile_enabled` = interception currently active for that harness
create table if not exists machine_harnesses (
  machine_id     uuid not null references machines(id) on delete cascade,
  harness        text not null,                       -- 'claude-code' | 'opencode'
  installed      boolean not null default false,
  mobile_enabled boolean not null default false,
  -- desired_enabled lets the PHONE request a state the desktop then applies (optional, §6)
  desired_enabled boolean,
  updated_at     timestamptz not null default now(),
  primary key (machine_id, harness)
);

-- RLS: a user can read/write harness rows only for machines they own
alter table machine_harnesses enable row level security;

create policy "owner reads harness rows" on machine_harnesses
  for select using (
    exists (select 1 from machines m where m.id = machine_id and m.user_id = auth.uid())
  );
-- writes go through the service key (Express), so no client write policy is needed.
```

> If your other tables don't use RLS (the Express server uses the **service key**, which bypasses RLS), you can skip the policy — but the mobile app reads some tables directly via Realtime, so keep RLS consistent with how `pending_requests` is already configured in `schema.sql`.

---

## 4. Server (Express) changes

The server is the only writer with the service key, so harness state lives behind it.

### 4.1 Accept `harness` on existing writes

In `src/routes/relay.js`, the `/upload`, `/agent-ping`, and `/terminal-event` handlers already spread the client payload. Just make sure `harness` is allowed through and defaulted:

```js
// relay.js  — /upload
.insert({
  ...payload,
  harness:    payload.harness ?? 'claude-code',   // ← add
  agent_id:   agentId,
  machine_id: req.machine.id,
  user_id:    req.machine.user_id,
  status:     'pending',
  created_at: new Date().toISOString(),
})
```

```js
// relay.js — /agent-ping
.upsert({
  session_id:       sessionId,
  machine_id:       req.machine.id,
  cwd:              cwd || null,
  harness:          req.body.harness ?? 'claude-code',   // ← add
  last_activity_at: new Date().toISOString(),
}, { onConflict: 'session_id' })
```

```js
// relay.js — /terminal-event
.insert({
  session_id, machine_id: req.machine.id, user_id: req.machine.user_id,
  event_type, tool_name: tool_name ?? null,
  harness:    req.body.harness ?? 'claude-code',         // ← add
  summary: summary ?? null, detail: detail ?? null, status: status ?? null,
})
```

### 4.2 New harness-state endpoints

Add `src/routes/harness.js`:

```js
import { Router } from 'express'
import { db } from '../supabase.js'
import { requireMachineAuth, requireUserAuth } from '../middleware/auth.js'

const router = Router()

// Desktop daemon reports detected CLIs + current mobile state (machine-authed)
// Body: { harnesses: [{ harness, installed, mobile_enabled }] }
router.post('/report', requireMachineAuth, async (req, res) => {
  const rows = (req.body.harnesses ?? []).map(h => ({
    machine_id:     req.machine.id,
    harness:        h.harness,
    installed:      !!h.installed,
    mobile_enabled: !!h.mobile_enabled,
    updated_at:     new Date().toISOString(),
  }))
  if (rows.length) {
    const { error } = await db
      .from('machine_harnesses')
      .upsert(rows, { onConflict: 'machine_id,harness' })
    if (error) return res.status(500).json({ error: error.message })
  }
  res.json({ ok: true })
})

// Desktop daemon polls this for a phone-requested toggle (optional remote control, §6)
router.get('/desired', requireMachineAuth, async (req, res) => {
  const { data } = await db
    .from('machine_harnesses')
    .select('harness, desired_enabled')
    .eq('machine_id', req.machine.id)
    .not('desired_enabled', 'is', null)
  res.json(data ?? [])
})

// Mobile (user-authed) reads harness state for a machine it owns
router.get('/:machineId', requireUserAuth, async (req, res) => {
  const { data: m } = await db.from('machines')
    .select('user_id').eq('id', req.params.machineId).single()
  if (!m || m.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' })

  const { data } = await db.from('machine_harnesses')
    .select('harness, installed, mobile_enabled, desired_enabled')
    .eq('machine_id', req.params.machineId)
  res.json(data ?? [])
})

// Mobile asks the desktop to flip a harness (sets desired_enabled; desktop applies it)
router.post('/:machineId/desire', requireUserAuth, async (req, res) => {
  const { harness, enabled } = req.body
  const { data: m } = await db.from('machines')
    .select('user_id').eq('id', req.params.machineId).single()
  if (!m || m.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' })

  const { error } = await db.from('machine_harnesses').upsert({
    machine_id: req.params.machineId, harness,
    desired_enabled: !!enabled, updated_at: new Date().toISOString(),
  }, { onConflict: 'machine_id,harness' })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

export default router
```

Wire it up in `src/index.js`:

```js
import harnessRouter from './routes/harness.js'
// ...
app.use('/harness', harnessRouter)
```

---

## 5. Desktop changes

### 5.1 Adapter registry

`relay-deamon1/src/harness/registry.js`:

```js
import { claudeCode } from './claudeCode.js'
import { opencode }   from './opencode.js'

const ADAPTERS = { 'claude-code': claudeCode, 'opencode': opencode }

export function getAdapter(id) { return ADAPTERS[id] || null }
export function allAdapters()  { return Object.values(ADAPTERS) }

export async function listInstalled() {
  const out = []
  for (const a of allAdapters()) {
    out.push({
      harness:        a.id,
      displayName:    a.displayName,
      installed:      await a.isInstalled().catch(() => false),
      mobile_enabled: a.isMobileEnabled(),
    })
  }
  return out
}
```

### 5.2 Claude Code adapter (extract existing behavior)

`relay-deamon1/src/harness/claudeCode.js` — this is just the logic already in `main.js`/`relay.cjs`, moved behind the interface:

```js
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import fs from 'fs'

const exec = promisify(execFile)
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json')
const HOOK_TOOLS_ALLOW = ['Bash(*)', 'Write(*)', 'Edit(*)', 'MultiEdit(*)', 'Read(*)']
const RELAY_ROOT = path.join(__dirname, '..', '..')   // adjust for your build layout

const read  = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) } catch { return {} } }
const write = (o) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(o, null, 2) + '\n', 'utf8')
const wrap  = (n) => `node "${path.join(RELAY_ROOT, n)}"`

function hookBlock() {
  return {
    PreToolUse:   [{ matcher: 'Bash|Write|Edit|MultiEdit|Read', hooks: [{ type: 'command', command: wrap('hook-wrapper.cjs') }] }],
    PostToolUse:  [{ matcher: 'Bash|Write|Edit|MultiEdit|Read', hooks: [{ type: 'command', command: wrap('postHook-wrapper.cjs') }] }],
    Notification: [{ hooks: [{ type: 'command', command: wrap('notifyHook-wrapper.cjs') }] }],
    Stop:         [{ hooks: [{ type: 'command', command: wrap('stopHook-wrapper.cjs') }] }],
  }
}

export const claudeCode = {
  id: 'claude-code',
  displayName: 'Claude Code',

  async isInstalled() {
    try { await exec('claude', ['--version']); return true } catch { return false }
  },

  isMobileEnabled() {
    const s = read(); return !!(s.hooks && s.hooks.PreToolUse)
  },

  async enableMobile() {
    const s = read()
    s.hooks = hookBlock()
    s.permissions ??= {}; s.permissions.allow ??= []
    for (const t of HOOK_TOOLS_ALLOW) if (!s.permissions.allow.includes(t)) s.permissions.allow.push(t)
    write(s)
  },

  async disableMobile() {
    const s = read()
    delete s.hooks
    if (s.permissions?.allow) {
      s.permissions.allow = s.permissions.allow.filter(t => !HOOK_TOOLS_ALLOW.includes(t))
      if (!s.permissions.allow.length) delete s.permissions.allow
      if (!Object.keys(s.permissions).length) delete s.permissions
    }
    write(s)
    try { fs.unlinkSync('C:\\temp\\relay-allow-all.txt') } catch {}
  },

  // Narrative + injection: keep the EXISTING heartbeat code (transcript tail + keystroke).
  // We just route to it. See §5.6 for how heartbeat becomes harness-aware.
  startNarrativeWatcher() { /* handled by existing checkTranscripts() */ return () => {} },
  injectPrompt() { /* handled by existing tryInjectIntoExistingTerminal() */ return Promise.resolve(false) },
}
```

> Keep `hook.js` and the existing heartbeat transcript/injection code as-is — they *are* the Claude Code adapter's runtime. The adapter object above is mostly about install/detect/toggle; the per-tool runtime stays in the proven hook scripts.

### 5.3 OpenCode adapter (new)

OpenCode's extensibility is **cleaner** than Claude Code's, so this adapter is actually simpler:

- **Interception** → a plugin file dropped in `~/.config/opencode/plugin/`. The plugin's `tool.execute.before` does the same `upload → wait for decision → allow/throw` dance as `hook.js`.
- **Narrative + injection** → OpenCode runs a local server; we use the SDK to subscribe to events (narrative) and `session.prompt()` (injection). **No keystroke hacking.**

`relay-deamon1/src/harness/opencode.js`:

```js
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import fs from 'fs'

const exec = promisify(execFile)
// OpenCode global config dir (mirror: macOS/Linux ~/.config/opencode, Windows %USERPROFILE%\.config\opencode)
const OC_DIR     = path.join(os.homedir(), '.config', 'opencode')
const PLUGIN_DIR = path.join(OC_DIR, 'plugin')
const PLUGIN_DST = path.join(PLUGIN_DIR, 'vibe-relay.js')
const PLUGIN_SRC = path.join(__dirname, '..', '..', 'opencode-plugin', 'relay.js')
const FLAG_FILE  = path.join(OC_DIR, '.vibe-mobile-on')   // simple on/off marker the plugin reads

export const opencode = {
  id: 'opencode',
  displayName: 'OpenCode',

  async isInstalled() {
    try { await exec('opencode', ['--version']); return true } catch { return false }
  },

  isMobileEnabled() { return fs.existsSync(PLUGIN_DST) && fs.existsSync(FLAG_FILE) },

  async enableMobile(ctx) {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true })
    // Copy the plugin and a tiny env file it reads (machine key, api url, etc.)
    fs.copyFileSync(PLUGIN_SRC, PLUGIN_DST)
    fs.writeFileSync(path.join(PLUGIN_DIR, 'vibe-relay.env.json'), JSON.stringify({
      apiUrl: ctx.apiUrl, machineApiKey: ctx.machineApiKey,
      userId: ctx.userId, machineId: ctx.machineId,
      supabaseUrl: ctx.supabaseUrl, supabaseKey: ctx.supabaseKey,
    }, null, 2))
    fs.writeFileSync(FLAG_FILE, new Date().toISOString())
  },

  async disableMobile() {
    try { fs.unlinkSync(FLAG_FILE) } catch {}
    try { fs.unlinkSync(PLUGIN_DST) } catch {}   // or leave plugin, gate purely on FLAG_FILE
  },

  // Narrative + injection use the SDK against the local OpenCode server (§5.5)
  startNarrativeWatcher(post) { return startOpencodeEventStream(post) },
  injectPrompt(sessionId, prompt) { return opencodePrompt(sessionId, prompt) },
}
```

### 5.4 The OpenCode relay plugin

This is the OpenCode counterpart of `hook.js`. `relay-deamon1/opencode-plugin/relay.js`:

```js
// Vibe Remote — OpenCode relay plugin.
// Lives in ~/.config/opencode/plugin/. OpenCode auto-loads it at startup.
// Mirrors relay-deamon1/hook.js: gate tool calls through the phone.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

const CFG_DIR   = path.join(os.homedir(), '.config', 'opencode', 'plugin')
const FLAG_FILE = path.join(os.homedir(), '.config', 'opencode', '.vibe-mobile-on')
const env = JSON.parse(fs.readFileSync(path.join(CFG_DIR, 'vibe-relay.env.json'), 'utf8'))

// Same risk/summary helpers you already have — reuse src/parsers.js / src/risk.js logic.
function summarize(tool, args) {
  if (tool === 'bash')              return { summary: args.command, command: args.command, display_type: 'command' }
  if (tool === 'edit' || tool === 'write')
                                    return { summary: `${tool} ${args.filePath || args.path}`, file_path: args.filePath || args.path, display_type: 'edit' }
  return { summary: `${tool}`, display_type: 'unknown' }
}

async function uploadAndWait(row) {
  // POST to the VPS exactly like hook.js → src/supabase.js uploadRequest()
  const res = await fetch(`${env.apiUrl}/relay/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-machine-api-key': env.machineApiKey },
    body: JSON.stringify({ payload: row }),
  })
  if (!res.ok) throw new Error(`upload failed ${res.status}`)
  const { id } = await res.json()

  // Poll for the decision (or use Supabase Realtime like waitForDecision()).
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500))
    const s = await fetch(`${env.apiUrl}/relay/status/${id}`, {
      headers: { 'x-machine-api-key': env.machineApiKey },
    }).then(r => r.json()).catch(() => null)
    if (s?.status === 'approved') return true
    if (s?.status === 'denied')   return false
  }
  return false // timeout → deny (fail-closed) or true if you prefer fail-open
}

export const VibeRelay = async ({ project, directory }) => {
  return {
    // Gate tools — throw to deny (verified OpenCode behavior).
    'tool.execute.before': async (input, output) => {
      if (!fs.existsSync(FLAG_FILE)) return            // mobile support off → do nothing
      const GATED = new Set(['bash', 'edit', 'write', 'patch'])
      if (!GATED.has(input.tool)) return               // read-only tools pass

      const meta = summarize(input.tool, output.args || input.args || {})
      const row = {
        id: randomUUID(),
        user_id: env.userId, machine_id: env.machineId,
        session_id: input.sessionID ?? null,
        harness: 'opencode',                           // ← the key tag
        tool_name: input.tool,
        display_type: meta.display_type,
        summary: meta.summary,
        risk_level: 'medium', risk_reason: '', risk_icon: '?',
        files_affected: meta.file_path ? [meta.file_path] : [],
        command: meta.command ?? null, file_path: meta.file_path ?? null,
        raw_input: output.args ?? input.args ?? null,
        status: 'pending', created_at: new Date().toISOString(),
      }
      const approved = await uploadAndWait(row)
      if (!approved) throw new Error('Denied via Vibe Remote mobile app')
    },

    // Narrative: forward assistant text to the Terminal tab.
    event: async ({ event }) => {
      if (!fs.existsSync(FLAG_FILE)) return
      if (event.type === 'message.part.updated' && event.properties?.part?.type === 'text') {
        await fetch(`${env.apiUrl}/relay/terminal-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-machine-api-key': env.machineApiKey },
          body: JSON.stringify({
            session_id: event.properties.sessionID,
            event_type: 'output', harness: 'opencode',
            summary: String(event.properties.part.text || '').slice(0, 2000),
          }),
        }).catch(() => {})
      }
    },
  }
}
```

> **Permission hook alternative.** OpenCode also exposes a `permission.ask` hook where you set `output.status = 'allow' | 'deny' | 'ask'`. Functionally it's interchangeable with throwing from `tool.execute.before` for gating; `tool.execute.before` is the better-documented "throw to block" path, so the guide uses it. If you want the agent to keep flowing on read-only tools without prompts, gate only the `GATED` set as shown.

### 5.5 OpenCode server: narrative + prompt injection via SDK

OpenCode runs a server you can talk to with `@opencode-ai/sdk`. Install it in the daemon:

```bash
cd relay-deamon1 && npm i @opencode-ai/sdk
```

```js
// relay-deamon1/src/harness/opencodeServer.js
import { createOpencodeClient } from '@opencode-ai/sdk'

// Assumes `opencode serve` is reachable (default port). Make the port configurable.
const client = createOpencodeClient({ baseUrl: process.env.OPENCODE_URL || 'http://localhost:4096' })

// Narrative — SSE event stream (replaces transcript tailing)
export function startOpencodeEventStream(post) {
  let stop = false
  ;(async () => {
    const events = await client.event.subscribe()
    for await (const event of events.stream) {
      if (stop) break
      if (event.type === 'message.part.updated' && event.properties?.part?.type === 'text') {
        post({
          session_id: event.properties.sessionID,
          event_type: 'output', harness: 'opencode',
          summary: String(event.properties.part.text || '').slice(0, 2000),
        })
      }
    }
  })().catch(() => {})
  return () => { stop = true }
}

// Prompt injection — replaces Win32 keystroke injection entirely
export async function opencodePrompt(sessionId, prompt) {
  try {
    const id = sessionId ?? (await client.session.create({ body: { title: 'Vibe Remote' } })).id
    await client.session.prompt({
      path: { id },
      body: { parts: [{ type: 'text', text: prompt }] },
    })
    return true
  } catch { return false }
}
```

> You can stream narrative from **either** the plugin's `event` hook **or** the SDK — pick one to avoid duplicates. The SDK stream is more robust (survives plugin reloads); the plugin path needs no separate server process. Recommended: SDK stream from the heartbeat when OpenCode mobile is enabled.

### 5.6 `main.js` — generic IPC

Replace the Claude-only IPC with harness-parameterized handlers:

```js
import { getAdapter, listInstalled } from '../../relay-deamon1/src/harness/registry.js'

// List harnesses + their state for the dashboard
ipcMain.handle('harness:list', () => listInstalled())

// Toggle one harness
ipcMain.handle('harness:setMobile', async (_, { harness, enable }) => {
  const a = getAdapter(harness)
  if (!a) throw new Error(`Unknown harness: ${harness}`)
  const ctx = parseEnv(readFileSync(RELAY_ENV, 'utf8'))   // machine creds
  if (enable) await a.enableMobile({
    apiUrl: ctx.API_URL, machineApiKey: ctx.MACHINE_API_KEY, userId: ctx.USER_ID,
    machineId: ctx.MACHINE_ID, supabaseUrl: ctx.SUPABASE_URL, supabaseKey: ctx.SUPABASE_ANON_KEY,
  })
  else await a.disableMobile()
  await reportHarnessState()        // push to /harness/report so mobile sees it
  return a.isMobileEnabled()
})

async function reportHarnessState() {
  const harnesses = await listInstalled()
  const ctx = parseEnv(readFileSync(RELAY_ENV, 'utf8'))
  await fetch(`${ctx.API_URL}/harness/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-machine-api-key': ctx.MACHINE_API_KEY },
    body: JSON.stringify({ harnesses }),
  }).catch(() => {})
}
```

Keep the old `relay:getHookStatus` / `relay:setHookEnabled` as thin shims (call the `claude-code` adapter) during migration, then delete them.

Also call `reportHarnessState()` on app launch (after `startHeartbeat()`), and on a timer, so the server's `machine_harnesses` rows stay fresh.

### 5.7 Heartbeat — route by harness

`scripts/heartbeat.js` currently assumes Claude Code. Make the loops harness-aware:

1. **Prompt delivery** (`checkPendingCommands`): the mobile command now carries `harness` (see §6). Route it:
   ```js
   if (cmd.harness === 'opencode') {
     const ok = await opencodePrompt(cmd.sessionId, cmd.prompt)   // SDK — no keystrokes
     if (!ok) fileLog('opencode prompt failed')
   } else {
     // existing Claude Code path: tryInjectIntoExistingTerminal() / openNewTerminalWindow()
   }
   ```
2. **Narrative**: when the `opencode` adapter is mobile-enabled, start `startOpencodeEventStream()` once and let it run; keep `checkTranscripts()` for Claude Code. Guard each so you don't start a watcher for a harness that's off.
3. **Desired-state poll** (optional remote toggle): add a loop that GETs `/harness/desired` and calls the adapter's `enableMobile`/`disableMobile` to match what the phone asked for.

### 5.8 Dashboard UI — one toggle per harness

Replace the single "Claude Code Interception" card with a list. The card only renders harnesses that are **installed**:

```jsx
const [harnesses, setHarnesses] = useState([]);   // [{harness, displayName, installed, mobile_enabled}]

useEffect(() => { window.harness.list().then(setHarnesses); }, []);

async function toggle(h) {
  const enabled = await window.harness.setMobile({ harness: h.harness, enable: !h.mobile_enabled });
  setHarnesses(hs => hs.map(x => x.harness === h.harness ? { ...x, mobile_enabled: enabled } : x));
}

// render
<section className="card">
  <h2 className="card-title">Harness Mobile Support</h2>
  <p className="card-sub">Toggle which agents stream to your phone for approval. Each is independent.</p>
  {harnesses.filter(h => h.installed).map(h => (
    <div key={h.harness} className="toggle-row">
      <div className="toggle-info">
        <span className={`status-dot ${h.mobile_enabled ? 'on' : 'off'}`} />
        <span className="status-label">{h.displayName}: {h.mobile_enabled ? 'Mobile Mode Active' : 'Off'}</span>
      </div>
      <button className={`toggle-btn ${h.mobile_enabled ? 'toggle-on' : 'toggle-off'}`} onClick={() => toggle(h)}>
        <span className="toggle-thumb" />
      </button>
    </div>
  ))}
  {harnesses.every(h => !h.installed) && <p className="hook-hint">No supported agent CLI detected. Install Claude Code or OpenCode.</p>}
</section>
```

Expose the IPC in `preload.js`:

```js
contextBridge.exposeInMainWorld('harness', {
  list:      () => ipcRenderer.invoke('harness:list'),
  setMobile: (args) => ipcRenderer.invoke('harness:setMobile', args),
});
```

---

## 6. Mobile changes

The mobile app is already harness-agnostic for the core flow; the changes are **labeling** and (optionally) **remote toggling**.

### 6.1 Carry `harness` through types + UI

```ts
// src/types/index.ts — add to PendingRequest, AgentSession, TerminalEvent
harness?: 'claude-code' | 'opencode'
```

Show a small badge wherever a request/session is rendered (`RequestCard.tsx`, `SessionsScreen.tsx`):

```tsx
{item.harness === 'opencode' ? <Badge>OpenCode</Badge> : <Badge>Claude</Badge>}
```

### 6.2 Prompt now specifies harness

`sendPrompt` should include the session's harness so the desktop routes injection correctly. Easiest: the server already knows a session's harness (`agents.harness`), so look it up server-side in the `/mobile/prompt` handler and stamp it onto the mobile command — **no mobile change needed** beyond reading it back. If you prefer explicit: add `harness` to `sendPrompt(prompt, sessionId, harness)` and to the `/mobile/prompt` body.

### 6.3 (Optional) Remote toggle from the phone

Add to `src/api/server.ts`:

```ts
export function fetchHarnessState(machineId: string) {
  return request<{harness:string; installed:boolean; mobile_enabled:boolean; desired_enabled:boolean|null}[]>(
    `/harness/${machineId}`)   // NOTE: this route is user-authed; call via your user-auth client, not the machine-key client
}
export function desireHarness(machineId: string, harness: string, enabled: boolean) {
  return request<void>(`/harness/${machineId}/desire`, {
    method: 'POST', body: JSON.stringify({ harness, enabled }),
  })
}
```

Render a toggle per harness on the machine screen; flipping it calls `desireHarness`. The desktop's desired-state poll (§5.7.3) applies it within ~10s and reports back, so the phone reflects the real state on next `fetchHarnessState`.

> **Auth note:** `/harness/:machineId*` is **user-authed** (Supabase JWT), not machine-key authed. The mobile app currently talks to `/mobile/*` with the machine API key. For these routes, use the user's Supabase session token (the app already has it from sign-in) — or, simpler, mirror them under `/mobile/harness` behind `requireMachineAuth` since the phone is already trusted with the machine key. Pick whichever matches your existing mobile auth model; `/mobile/*` + machine key is the lower-friction choice.

---

## 7. Rollout / migration plan

Do it in this order so nothing breaks mid-way:

1. **DB migration (§3)** — additive, safe to ship first. Existing rows become `claude-code`.
2. **Server (§4)** — accept `harness`, add `/harness` routes. Old clients omit `harness` → defaulted. Backward-compatible.
3. **Desktop adapter refactor (§5.1–5.2, 5.6)** — extract Claude Code behind the adapter, keep `relay:*` IPC as shims. Ship and verify Claude Code still works *unchanged*.
4. **Desktop UI (§5.8)** — swap the single card for the per-harness list (will show only Claude Code until OpenCode lands).
5. **OpenCode adapter + plugin (§5.3–5.5, 5.7)** — add OpenCode end to end.
6. **Mobile labeling (§6.1–6.2)** — badges + harness-aware prompt routing.
7. **Optional remote toggle (§6.3)** — last, it's a nice-to-have.

Each step is independently shippable and reversible.

---

## 8. Testing checklist

**Claude Code (regression — must still pass):**
- [ ] Toggle on → `~/.claude/settings.json` gets the hook block; `claude` tool calls hit the phone.
- [ ] Approve/deny from mobile and from `! node relay.cjs 1/3` both work.
- [ ] Narrative still streams to the Terminal tab; prompt injection still lands in the terminal.
- [ ] Toggle off → hooks removed, normal CLI restored.

**OpenCode (new):**
- [ ] `opencode --version` detected → card appears.
- [ ] Toggle on → `~/.config/opencode/plugin/vibe-relay.js` + env + flag file written.
- [ ] Run `opencode`, trigger a `bash`/`edit` → request appears on phone tagged **OpenCode**; approving lets it run, denying throws in OpenCode.
- [ ] Read-only tools are not gated (no prompt spam).
- [ ] Narrative text streams to Terminal tab.
- [ ] Send a prompt from mobile → arrives in the OpenCode session via SDK (no terminal focus stealing).
- [ ] Toggle off → plugin/flag removed; OpenCode runs unintercepted.

**Isolation:**
- [ ] Claude Code ON + OpenCode OFF → only Claude intercepted, and vice-versa.
- [ ] Both ON simultaneously → requests from each show correct harness badge; approvals route to the right session.
- [ ] `machine_harnesses` rows reflect reality after each toggle and after app restart.

---

## 9. Edge cases & gotchas

- **Session ID namespaces differ.** Claude Code session IDs and OpenCode session IDs are independent ID spaces. Because every `agents` row now carries `harness`, keep `(session_id, harness)` as the mental key. If you ever see collisions, make the `agents` unique constraint `(session_id, harness)` instead of `session_id` alone — but they're UUIDs/opaque, so collisions are effectively impossible.
- **OpenCode server lifecycle.** The SDK needs a reachable `opencode serve`. Decide who starts it: either require the user to run `opencode` (which exposes the server) while mobile mode is on, or have the daemon spawn `opencode serve` on a known port and set `OPENCODE_URL`. Make the port configurable; don't hardcode `4096` if your version differs.
- **Don't double-stream narrative.** Pick the plugin `event` hook *or* the SDK stream, not both, or the Terminal tab shows every line twice.
- **Plugin auto-load = global.** A plugin in `~/.config/opencode/plugin/` loads for *every* OpenCode session on the machine. The `FLAG_FILE` gate makes "mobile off" truly inert (the hook returns immediately). That's why `disableMobile` removes the flag, not just the file.
- **Fail-open vs fail-closed.** `hook.js` honors `config.failOpen`. Mirror that choice in the OpenCode plugin's timeout branch (`uploadAndWait` returns `true`/`false`). Keep them consistent so the two harnesses behave the same when the VPS is unreachable.
- **Windows config path.** OpenCode uses `~/.config/opencode` even on Windows in current builds; confirm on the target machine with `opencode` and adjust `OC_DIR` if your install uses `%APPDATA%`.
- **Risk scoring.** The OpenCode plugin's `summarize()` is a stub — reuse your existing `src/risk.js` / `src/parsers.js` so OpenCode requests get the same risk badges as Claude Code on the phone.

---

## Sources

OpenCode extensibility details verified against the official docs and community references:

- [OpenCode — Plugins](https://opencode.ai/docs/plugins/) (plugin export signature, `tool.execute.before`, `event` hook)
- [OpenCode — Config](https://opencode.ai/docs/config/) (plugin directory `~/.config/opencode/plugin`)
- [OpenCode — SDK](https://opencode.ai/docs/sdk/) (`client.session.create/prompt`, `client.event.subscribe`)
- [Does OpenCode Support Hooks? (DEV)](https://dev.to/einarcesar/does-opencode-support-hooks-a-complete-guide-to-extensibility-k3p) (hook list, `permission.ask` allow/deny)
