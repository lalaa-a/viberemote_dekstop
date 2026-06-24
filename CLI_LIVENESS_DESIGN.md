# How Mobile Knows the Desktop CLI Is Alive

This document traces the full liveness-detection chain — from a running Claude Code
process on the desktop to the green/grey dot the mobile user sees in the Machines tab.
Every file reference points at the actual code so you can follow along.

---

## Two Independent Signals

There are two separate liveness questions, and the system tracks them with different
mechanisms:

| Question | Signal | Field | Polling frequency |
|---|---|---|---|
| Is the **machine** (the desktop app + relay daemon) running? | Heartbeat POST | `machines.is_online` + `last_seen` | 30 s |
| Is the **CLI process** (Claude Code / OpenCode / Gemini) still open? | PID-file check | `agents.cli_alive` | 15 s |

Mobile reads both on every `/mobile/machines` (30 s) and `/mobile/sessions` (10 s) poll.

---

## Part 1 — Machine-Level Liveness

### 1a. The heartbeat (desktop → server, every 30 s)

`relay-deamon1/scripts/heartbeat.js` runs a `setInterval(tick, 30_000)` loop. On every
tick it calls:

```js
// relay-deamon1/src/supabase.js  line 67
export async function heartbeat() {
  return apiPost('/machines/heartbeat', {})
}
```

That goes to:

```js
// vibe_remote(serverside)/src/routes/machines.js  line 57
router.post('/heartbeat', requireMachineAuth, async (req, res) => {
  await db.from('machines')
    .update({ is_online: true, last_seen: new Date().toISOString() })
    .eq('id', req.machine.id)
  res.json({ ok: true })
})
```

Every 30 seconds, `machines.last_seen` gets a fresh timestamp and `is_online` is
set to `true`.

### 1b. Clean shutdown

On `SIGINT`/`SIGTERM` the heartbeat runs:

```js
// heartbeat.js  line 554
async function shutdown() {
  await markOffline()    // POST /machines/offline → is_online = false
  process.exit(0)
}
```

This gives instant offline feedback. If the process is killed hard (power loss, crash)
the timestamp goes stale instead.

### 1c. How the server computes `is_online` for mobile

The server does **not** trust the stored `is_online` boolean. It re-derives it from
`last_seen` at query time with a 90-second window:

```js
// vibe_remote(serverside)/src/routes/mobile.js  line 300
is_online: m.last_seen
  ? (now - new Date(m.last_seen).getTime()) < ONLINE_THRESHOLD_MS   // 90_000
  : false,
```

Same window in `GET /machines/mine`:

```js
// machines.js  line 407
is_online: m.last_seen
  ? (now - new Date(m.last_seen).getTime()) < 90_000
  : false,
```

So if the daemon crashes without sending `/offline`, the machine goes dark on mobile
within 90 seconds of the last heartbeat.

### 1d. What mobile shows

`MachinesScreen` polls `GET /mobile/machines` every 30 seconds:

```tsx
// MachinesScreen.tsx  line 159
useQuery({ queryKey: ['machines'], queryFn: fetchMachines, refetchInterval: 30_000 })
```

Each card renders:

```tsx
// MachinesScreen.tsx  line 96
<View style={[styles.statusDot, { backgroundColor: isOnline ? Colors.success : Colors.borderHairline }]} />
// and the ONLINE / OFFLINE pill
<Text style={[styles.statusText, { color: isOnline ? Colors.successDark : Colors.textTertiary }]}>
  {isOnline ? 'ONLINE' : 'OFFLINE'}
</Text>
```

The harness toggle is disabled when the machine is offline:

```tsx
// MachinesScreen.tsx  line 55
enabled: isOnline,    // HarnessPanel query is skipped when false
// toggle button:
disabled={toggle.isPending || !isOnline}
```

---

## Part 2 — CLI Process Liveness

The machine being "online" just means the Electron app and relay daemon are running.
That doesn't tell you whether the Claude Code window the user has open is still
accepting prompts. That's tracked separately.

### 2a. How the PID file gets written

Every harness strategy writes its PID to `C:\temp\relay-pid-<sessionId>.txt` while
it's running. For Claude Code the hook wrapper does this; for OpenCode the plugin
does the same. This file exists **only while the CLI is open**.

### 2b. The heartbeat reads every PID file every 15 s

```js
// heartbeat.js  line 525
async function reportSessionLiveness() {
  const files = fs.readdirSync('C:\\temp')
  const alive = []
  for (const f of files) {
    const m = /^relay-pid-(.+)\.txt$/.exec(f)
    if (!m) continue
    const sessionId = m[1]
    if (isSessionProcessAlive(sessionId)) {
      alive.push(sessionId)
    } else {
      // Dead PID → remove the stale file
      fs.unlinkSync(path.join('C:\\temp', f))
    }
  }
  await reportSessionsAlive(alive)
}

setInterval(reportSessionLiveness, 15_000)
```

`isSessionProcessAlive()` reads the PID file and calls `process.kill(pid, 0)` — a
zero-signal probe that throws `ESRCH` if the process is gone or `EPERM` if it's alive
but owned by another user (still counts as alive).

### 2c. The server marks every other session dead

```js
// relay-deamon1/src/supabase.js  line 72
export async function reportSessionsAlive(aliveSessionIds) {
  return apiPost('/relay/sessions-alive', { aliveSessionIds })
}
```

The `/relay/sessions-alive` endpoint updates `agents.cli_alive`:
- Rows whose `session_id` is in `aliveSessionIds` → `cli_alive = true`
- All other rows for this machine → `cli_alive = false`

This is a bulk update so a CLI that was alive last tick but closed between ticks
gets marked dead within 15 seconds.

### 2d. Mobile reads `cli_alive` from `/mobile/sessions`

```js
// mobile.js  line 93
cli_alive: agent.cli_alive !== false,
```

The sessions list response includes `cli_alive` for every session. Mobile uses this
in two places:

**Block prompt sending:** if the user tries to send a prompt to a closed CLI:

```js
// mobile.js — POST /mobile/prompt
if (agent.cli_alive === false) {
  return res.status(409).json({ error: 'CLI closed', code: 'cli_closed' })
}
```

### 2d-bis. Second prompt gate — harness mobile support must be ON

A live CLI is necessary but not sufficient. The user must also have toggled **mobile
support for that harness** on in the desktop app. If the chat is a Claude Code session
but Claude mobile support was never switched on (or was switched off), the desktop never
installed the hooks that inject prompts — so a queued prompt would silently go nowhere.
`POST /mobile/prompt` therefore also checks `machine_harnesses.mobile_enabled`:

```js
// mobile.js — POST /mobile/prompt
const harness = agent.harness ?? 'claude-code'
const { data: hRow } = await db
  .from('machine_harnesses')
  .select('mobile_enabled')
  .eq('machine_id', agent.machine_id)
  .eq('harness', harness)
  .maybeSingle()

if (!hRow?.mobile_enabled) {
  return res.status(409).json({
    error: `Mobile support for ${harness} is turned off on the desktop`,
    code:  'harness_disabled',
  })
}
```

So the full set of conditions to send a prompt is: **machine online** AND **CLI alive**
AND **harness mobile support enabled** AND **no approvals pending**.

`GET /mobile/sessions` also returns `harness_enabled` per session (computed from the
same `machine_harnesses.mobile_enabled`) so the mobile composer can disable itself
proactively — the user sees a "Mobile support is off" note instead of an input box,
rather than only finding out after tapping send.

**Propagation is realtime, not poll-only.** The desktop calls `POST /harness/report`
the instant a harness is toggled (`harness-cli.js`), and that endpoint fires
`broadcastMachine(machineId, 'harness')`. The phone subscribes to the `machine:<id>`
broadcast channel (`useMachineChannel`) and invalidates its `harnesses` / `machines` /
`sessions` queries on that event, so the Machines tab and chat composer update within
a second instead of waiting up to 30s for the next poll. The polls remain as the
backstop if a broadcast is ever missed.

**Heartbeat loop:** `useSessions` polls every 10 s:

```ts
// useSessions.ts  line 14
refetchInterval: 10_000,
```

So within 10 s of the mobile app polling after the desktop marks the CLI dead, the
UI can reflect that the CLI is closed.

### 2e. What the user sees when the CLI closes

The mobile app receives `cli_alive: false` on the next `/mobile/sessions` poll.
When that session is focused and the user tries to send a prompt, the server returns
`409 cli_closed`. The app shows an error message.

The heartbeat also posts a human-readable notification event when it detects a prompt
was queued for a closed CLI:

```js
// heartbeat.js  line 130
postTerminalEvent({
  session_id: cmd.sessionId,
  event_type: 'notification',
  summary:    'Prompt not delivered — the CLI for this session is closed. Start the agent again to continue.',
})
```

This appears in the session's terminal feed on mobile.

---

## Part 3 — The Full Stack, End to End

```
┌─────────────────────────────────────────────────────┐
│ Desktop (Electron + relay daemon)                   │
│                                                     │
│  heartbeat.js                                       │
│  ├── every 30s  → POST /machines/heartbeat          │
│  │               → machines.last_seen = now()       │
│  │                                                  │
│  ├── every 15s  → scan C:\temp\relay-pid-*.txt      │
│  │               → process.kill(pid, 0) probe       │
│  │               → POST /relay/sessions-alive       │
│  │               → agents.cli_alive = true/false    │
│  │                                                  │
│  └── on SIGINT  → POST /machines/offline            │
│                  → machines.is_online = false       │
│                                                     │
│  Claude Code / hook-wrapper.cjs                     │
│  └── on launch  → writes C:\temp\relay-pid-<id>.txt │
│                  → removed on exit                  │
└─────────────────────────────────────────────────────┘
                         │
                         │ HTTPS  (x-machine-api-key)
                         ▼
┌─────────────────────────────────────────────────────┐
│ VPS  (Express + Supabase)                           │
│                                                     │
│  machines.last_seen    → computed is_online (90s)   │
│  agents.cli_alive      → set by sessions-alive      │
└─────────────────────────────────────────────────────┘
                         │
                         │ HTTPS  (Bearer JWT)
                         ▼
┌─────────────────────────────────────────────────────┐
│ Mobile (React Native)                               │
│                                                     │
│  GET /mobile/machines   every 30s                   │
│  └── is_online  → green/grey dot + ONLINE pill      │
│                                                     │
│  GET /mobile/sessions   every 10s                   │
│  └── cli_alive  → blocks "Send prompt" if false     │
│                  → shows "CLI closed" notification  │
└─────────────────────────────────────────────────────┘
```

---

## Timing Summary

| Scenario | Max mobile lag |
|---|---|
| Daemon starts → mobile sees ONLINE | ≤ 30 s (first heartbeat) + 30 s (next poll) ≈ 60 s worst case |
| Daemon crashes (no SIGINT) → mobile sees OFFLINE | 90 s stale window + 30 s poll = 120 s worst case |
| Daemon sends `/offline` (clean exit) → mobile sees OFFLINE | ≤ 30 s poll |
| CLI opens → mobile can send prompt | ≤ 15 s liveness report + 10 s sessions poll = 25 s |
| CLI closes → mobile blocks prompt | ≤ 15 s liveness report + 10 s sessions poll = 25 s |
| CLI closes mid-prompt → server blocks it | ≤ 15 s (next liveness cycle) |

---

## Key Source Files

| Role | File |
|---|---|
| Heartbeat loop + PID probe | `relay-deamon1/scripts/heartbeat.js` |
| VPS API helpers (heartbeat, markOffline, reportSessionsAlive) | `relay-deamon1/src/supabase.js` |
| `POST /machines/heartbeat` + `POST /machines/offline` | `vibe_remote(serverside)/src/routes/machines.js` |
| `POST /relay/sessions-alive` (marks `cli_alive`) | `vibe_remote(serverside)/src/routes/relay.js` |
| `GET /mobile/machines` (computes `is_online` from `last_seen`) | `vibe_remote(serverside)/src/routes/mobile.js` |
| `GET /mobile/sessions` (returns `cli_alive`) | `vibe_remote(serverside)/src/routes/mobile.js` |
| Mobile machine list + status display | `AgentControl/src/screens/Machines/MachinesScreen.tsx` |
| Mobile sessions poll hook | `AgentControl/src/hooks/useSessions.ts` |
