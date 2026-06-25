# Fast Mobile→Desktop Prompt Delivery — Decision & Implementation

> **Symptom:** a prompt typed on the phone takes a long time (often ~30s, sometimes
> longer) to land in the desktop CLI. Target: the prompt reaches the **existing**
> current‑CLI injector in **~1s**.
>
> This is an **ADR + implementation guide**. It picks **one** architecture, says why,
> and records the alternatives that were rejected. Companion to
> `REALTIME_TRANSPORT_DECISION.md`, `CHAT_REQUESTS_AND_LATENCY_FIX.md` (§C4b), and
> `LIVE_FEED_REALTIME_DIAGNOSIS.md`.
>
> Repos: **desktop** `D:\Projects\vRdeksMultiharness\relay-deamon1` ·
> **server** `D:\Projects\vibe_remote(serverside)` ·
> **mobile** `D:\Projects\vibe_remote(reactNative)\AgentControl`.

---

## Hard constraint (do not change)

**Prompt injection into the *current* CLI is already implemented and must stay exactly as
is.** `tryInjectIntoExistingTerminal()` in `heartbeat.js` (resolve the live `claude` /
OpenCode PID from `C:\temp\relay-pid-<sessionId>.txt`, `AttachConsole` + `WriteConsoleInput`,
clipboard‑paste fallback) is **out of scope** for this work. This design only speeds up how
fast a prompt **reaches** that injector — it does not touch the injection mechanism, its
target, or its behavior.

---

## Decision (TL;DR)

**Chosen method:**

> **Supabase Realtime `broadcast` nudge on `machine:<id>` → authenticated atomic claim
> (`GET /mobile/command/next`, server time‑gate removed) → desktop hands the prompt to the
> existing current‑CLI injector the instant the CLI is idle.**

Three moving parts, each attacking a different part of the *delivery* latency (not the
injection itself):

1. **Arrival:** push the nudge over **`broadcast`** on the daemon's *already‑open* Realtime
   socket — sub‑second, and the transport that actually works on this self‑hosted Supabase.
   **Not** `postgres_changes`, **not** a custom WS server.
2. **Timing:** the **desktop** decides when to inject — immediately if the CLI is at its
   prompt, otherwise the instant the current turn ends (Stop‑hook signal). The server's 30s
   idle timer is removed.
3. **Injection:** **unchanged.** The prompt is handed to the existing
   `tryInjectIntoExistingTerminal()` exactly as today.

**Rejected:** payload‑carrying broadcast (saves ~100ms, costs RLS exposure + loses atomic
dedupe), custom WebSocket/SSE server (redundant — we already hold a Realtime socket),
long‑poll as the *primary* path (extra server connection cost for no gain over broadcast).

**Result:** the prompt reaches the existing injector in **≤1s** (idle CLI) or **≤1s after
the current turn ends** (busy CLI); a dropped broadcast still lands in **≤3s**, never the
old 30s. Injection then proceeds as it does now.

---

## Why: where the *delivery* time goes

The path has four serial costs. Two of them are ~30s today; those are the entire problem.
Injection is deliberately left alone.

| Stage | Today | This design |
|-------|-------|-------------|
| Phone → server (`POST /mobile/prompt`, REST) | ~50–150ms | unchanged (fine) |
| Server → desktop **notify** | **up to 30s** (postgres_changes drops → 30s backstop poll) | **~sub‑second** (broadcast on a held socket) |
| Server **idle gate** before it releases the row | **up to 30s** (`last_activity > 30s`) | **0** (desktop owns timing) |
| Desktop **inject** into current CLI | existing `tryInjectIntoExistingTerminal()` | **unchanged — out of scope** |

The two 30s terms are the whole delay. Remove them and the prompt arrives at the existing
injector essentially as fast as the network allows.

---

## Options considered

| Option | Arrival latency | Verdict |
|--------|-----------------|---------|
| **A. `postgres_changes` nudge** (current) | 0–30s (silently drops here) | ❌ Proven unreliable on this self‑hosted Supabase + RLS (`LIVE_FEED_REALTIME_DIAGNOSIS.md`). |
| **B. `broadcast` nudge + authenticated claim** | sub‑second + ~100ms claim | ✅ **CHOSEN.** Reuses the open socket, RLS‑independent, preserves atomic dedupe + auth on the claim, and feeds the **existing** injector untouched. |
| **C. `broadcast` carrying the prompt payload** | sub‑second, no claim RTT | ❌ Rejected: broadcast topics aren't RLS‑guarded (prompt text leaks to any subscriber of `machine:<id>`), and you lose the DB's atomic "mark‑delivered" dedupe (double‑inject risk). Saves only ~100ms. |
| **D. HTTP long‑poll on `command/next`** | sub‑second | ❌ As *primary*: holds a server connection per machine and needs server‑side wakeup for no win over B. ✅ Kept as the **offline‑socket fallback** only. |
| **E. Custom WebSocket/SSE server** | sub‑second | ❌ Redundant — the daemon already holds a Supabase Realtime socket. `REALTIME_TRANSPORT_DECISION.md`: don't build this until Realtime quotas bind. |

**Senior rationale for B over C:** C's only edge is shaving one ~100ms claim round‑trip,
and it pays for that with RLS exposure of the user's prompt text and the loss of atomic
dedupe. B keeps the authenticated, idempotent claim — the one piece of real logic worth
keeping — and spends effort on transport reliability and delivery timing instead.

---

## Chosen architecture

```
Phone                Server (VPS)                    Desktop daemon
─────────────────────────────────────────────────────────────────────────────
type prompt
  │ POST /mobile/prompt
  ├────────────▶ INSERT mobile_commands (pending)
  │                   └─ broadcastMachine(id,'command_available',{sessionId})
  │                            │  (Realtime BROADCAST on machine:<id>)
  │                            ▼
  │                   daemon: on 'command_available' → drainQueue(sessionId)
  │                            │
  │   GET /mobile/command/next │   (no time gate; atomic mark 'delivered')
  │   ◀────────────────────────┤
  │   returns row if no pending approval
  │                            ▼
  │                   if CLI idle → tryInjectIntoExistingTerminal()  (UNCHANGED)
  │                   else defer → on Stop/turn-end (relay-ready flag) → drainQueue → inject
```

### 1. Broadcast nudge (server + desktop)

**Server — `src/routes/mobile.js`, `POST /mobile/prompt`** (after a successful insert):

```js
broadcastMachine(machineId, 'command_available', { sessionId })   // fire-and-forget
```

`broadcastMachine` + the `machine:<id>` topic already exist (harness toggles use them,
`src/realtime.js`). Broadcast skips table RLS / replica identity, so it delivers where
`postgres_changes` drops.

**Desktop — `relay-deamon1/scripts/heartbeat.js`**:

```js
function subscribeCommandNudge() {
  supabase
    .channel(`machine:${config.machineId}`)
    .on('broadcast', { event: 'command_available' }, ({ payload }) => {
      fileLog('command_available — draining')
      drainQueue(payload?.sessionId)
    })
    .subscribe((s) => { if (s === 'SUBSCRIBED') fileLog('command nudge subscribed (broadcast)') })
}
```

### 2. Remove the server's 30s idle gate

**Server — `GET /mobile/command/next`:** keep the **no‑pending‑approvals** guard and the
**atomic mark‑delivered**, but delete the `last_activity > 30s` predicate. Inject timing
moves to the desktop (step 3), which is the only place that truly knows the terminal is at
its prompt.

### 3. Desktop owns inject timing (idle‑gated, Stop‑triggered) — feeds the existing injector

```js
const idle = new Map()   // sessionId → true(idle)|false(busy)

async function drainQueue(sessionId) {
  const cmd = await getNextCommand()                 // server ungated now
  if (!cmd?.prompt) return
  const ready = injectable(cmd.harness) && isSessionProcessAlive(cmd.sessionId)
                && idle.get(cmd.sessionId) !== false
  if (!ready) return                                 // busy → wait for the turn-end flag
  idle.set(cmd.sessionId, false)
  await tryInjectIntoExistingTerminal(cmd.sessionId, cmd.prompt)   // EXISTING injector, unchanged
}
```

Turn‑end signal — `relay-deamon1/stopHook.js` (Claude) and the OpenCode plugin `relay.js`
`event` hook (on part `time.end`):

```js
// stopHook.js — after posting the 'stop' event
try { writeFileSync(`C:\\temp\\relay-ready-${event.session_id}.flag`, '1') } catch {}
```

```js
// heartbeat.js — 1s watcher: a turn just ended → drain immediately
function checkReadyFlags() {
  for (const f of fs.readdirSync('C:\\temp')) {
    const m = /^relay-ready-(.+)\.flag$/.exec(f); if (!m) continue
    try { fs.unlinkSync(`C:\\temp\\${f}`) } catch {}
    idle.set(m[1], true); drainQueue(m[1])
  }
}
setInterval(checkReadyFlags, 1000)
```

> This is just deciding **when** to call the existing injector. The call into
> `tryInjectIntoExistingTerminal()` — same PID resolution, same `WriteConsoleInput`, same
> current‑CLI target — is not modified.

### 4. Fallbacks (no extra latency in the happy path)

- **Socket down:** if the Realtime channel isn't `SUBSCRIBED`, issue a single **long‑poll**
  `GET /mobile/command/next?wait=25` so a prompt still lands sub‑second without the socket.
- **Belt‑and‑suspenders poll:** `setInterval(drainQueue, 3000)` (was `30_000`) — cheap, only
  acts when a row exists; covers a missed broadcast in ≤3s.

---

## Latency budget (time to reach the existing injector)

| Scenario | Today | This design |
|----------|-------|-------------|
| CLI idle, prompt sent | up to 30s + up to 30s | **≤1s** |
| CLI busy, sent mid‑turn | ≥30s after turn | **≤1s after turn ends** |
| Broadcast dropped | 30s | **≤3s** (retry) / sub‑second (long‑poll fallback) |
| Injection itself | existing mechanism | **unchanged** |

---

## File checklist

**Server — `D:\Projects\vibe_remote(serverside)`**
- [ ] `src/routes/mobile.js` — `POST /mobile/prompt`: `broadcastMachine(machineId,'command_available',{sessionId})` after insert.
- [ ] `GET /mobile/command/next` — drop the `last_activity > 30s` predicate; keep no‑pending‑approvals guard + atomic mark‑delivered; add optional `?wait=` long‑poll (fallback).

**Desktop — `D:\Projects\vRdeksMultiharness\relay-deamon1`**
- [ ] `scripts/heartbeat.js` — broadcast `subscribeCommandNudge()`; `idle` map; `checkReadyFlags()` (1s); rename `checkPendingCommands`→`drainQueue` with the idle guard; backstop `30_000`→`3_000`. **Leave `tryInjectIntoExistingTerminal()` untouched.**
- [ ] `stopHook.js` — write `relay-ready-<sessionId>.flag` after the `'stop'` event.
- [ ] `src/harnesses/opencode/plugin/relay.js` — emit the same ready flag on assistant part `time.end`.

**Mobile —** no change (the `SentBubble` pending→delivered tick just flips sooner).

---

## How to verify

1. **Idle send:** CLI at its prompt → send from phone → it injects (via the existing path) in **≤1s**; `heartbeat.log` shows `command_available — draining` immediately.
2. **Busy send:** start a long turn → send mid‑turn → injects within **~1s of turn end**; confirm `relay-ready-<id>.flag` appears and is consumed.
3. **Dropped broadcast:** kill the socket briefly → still lands ≤3s (retry) or sub‑second (long‑poll).
4. **No double‑inject:** atomic mark‑delivered prevents the broadcast and retry paths both claiming a row.
5. **Injection unchanged:** `inject-log.txt` shows the same `tryInjectIntoExistingTerminal()` behavior as before — only sooner.
6. **OpenCode parity:** repeat 1–2 in an OpenCode session.

---

## Rollout order

1. **Broadcast nudge** (server emit + desktop listen) — kills the first 30s. No behavior risk.
2. **Drop the server idle gate _together with_ the desktop idle/Stop logic** — never ship one without the other, or you risk handing a prompt to the injector mid‑turn.
3. **3s retry backstop + long‑poll fallback** — replaces the 30s poll.

> Do not split step 2. Removing the server time gate without the desktop idle guard could
> call the injector while the CLI is mid‑turn. The desktop Stop‑flag logic is what makes
> ungating safe. The injector itself is unchanged throughout.

---

---

## Implementation status (2026-06-24)

Implemented across desktop + server; mobile unchanged. Injection
(`tryInjectIntoExistingTerminal`) left untouched as required.

**Server — `D:\Projects\vibe_remote(serverside)`**
- `src/routes/mobile.js` — `POST /mobile/prompt` now fires `broadcastMachine(targetMachineId, 'command_available', { sessionId })`.
- `src/index.js` — `GET /mobile/command/next` honours `?session=<id>` and skips the 30s `last_activity` gate for scoped claims (unscoped backstop keeps it).

**Desktop — `D:\Projects\vRdeksMultiharness\relay-deamon1`** (synced into the live `app-1.3.0` install)
- `src/supabase.js` — `getNextCommand(sessionId)` adds `?session=`.
- `scripts/heartbeat.js` — busy/idle flag helpers; `subscribeCommandNudge()` now listens to the `machine:<id>` **broadcast** `command_available` (postgres_changes kept secondary); `checkPendingCommands`→`drainQueue(sessionId)` with the busy-gate + `markBusy` on inject; `checkReadyFlags()` (1s turn-end watcher); `drainBackstop()` (3s, scoped per live session so it never claim-drops).
- `hook.js` — writes `relay-busy-<session>.flag` on each tool fire.
- `stopHook.js` — clears the busy flag and drops `relay-ready-<session>.flag` on turn end.
- `src/harnesses/opencode/plugin/relay.js` — `markBusyOC` on tool-execute/narrative; `readyOC` on `session.idle` (synced into `PLUGIN_SRC` + `PLUGIN_DST`).

**To activate:** deploy the server; restart the desktop heartbeat daemon (and OpenCode for the plugin). Hooks pick up changes automatically. The desktop changes are backward-compatible with the old server (it ignores `?session` and no broadcast fires → falls back to the faster 3s backstop), so the full speedup lands once the server is deployed.

**Backward-compat / safety:** every claim that isn't gated by the desktop busy-flag is gated by the server's legacy 30s timer, so removing the gate can't cause a mid-turn inject; a stale busy flag self-heals after its TTL.

### Fixes after first live test (2026-06-24)

First test surfaced two real bugs plus one injection-layer root cause:

1. **5-minute lockout (regression):** `markBusy` on inject relied on the Stop hook to clear it. When an injected prompt silently failed to start a turn, no Stop fired, so the busy flag blocked the session for the full 5-min TTL. **Fix:** `BUSY_TTL_MS` 5 min → **60 s** (active turns stay busy via the per-tool-call refresh; only a failed/stuck inject ages out).
2. **Injection hit the wrong window (root cause of "2nd prompt delivered but didn't run"):** `WriteConsoleInput` failed with `3006` (`ERROR_INVALID_HANDLE`) because `GetStdHandle(STD_INPUT)` is redirected under ConPTY / Windows Terminal, forcing the clipboard-paste fallback, which resolved `WindowsTerminal.exe`'s `MainWindowHandle` — the wrong window when more than one terminal window exists (observed: hwnd 393318 → 66774 → 655558 for the same Claude PID). **Fix:** open the real console input via `CreateFile("CONIN$")` after `AttachConsole` (kept `GetStdHandle` as fallback, so it can only improve). This makes the existing `WriteConsoleInput` path work and removes the window-focus dependency entirely — injection mechanism/approach unchanged.
3. **OpenCode questions:** the `askUserQuestion` tool works end-to-end when the model calls it (verified: `execute CALLED → question answered`). In the failing session the model just didn't call the tool (answered in prose) — model-adoption, not a bug. Added `session.idle` logging to confirm the OpenCode turn-end signal clears its busy flag.

---

*Grounded in `relay-deamon1/scripts/heartbeat.js` (subscribeCommandNudge / checkPendingCommands / tryInjectIntoExistingTerminal / 30s backstop), `relay-deamon1/src/supabase.js` (getNextCommand), `stopHook.js`, the OpenCode plugin `relay.js`, and `SYSTEM_FLOW.md:501‑508` (server idle gate). Transport follows `LIVE_FEED_REALTIME_DIAGNOSIS.md` (broadcast over postgres_changes) and `REALTIME_TRANSPORT_DECISION.md` (Option A; no custom WS). Injection mechanism intentionally left unchanged. Decision recorded 2026-06-24.*
