# Stop Button — Design & Implementation Plan

> Goal: when a harness (Claude Code / OpenCode / Gemini CLI) is actively working on a turn, the paired phone should be able to interrupt it — a "Stop" button in the chat compose bar, visible whenever the session is `active`. While that turn is running, sending a *new* prompt from the phone is blocked outright (server-rejected, not silently queued) — Stop is the only mobile action available until the turn ends or is interrupted.

This complements `ARCHITECTURE.md` §5.4 (prompt injection). Read that section first — Stop reuses the same broadcast+poll transport pattern, but with an important twist called out in §1 below.

**Non-goal — this does not kill the CLI process.** It interrupts the *current turn only*, exactly like pressing `Esc` yourself in Claude Code's interactive REPL: the CLI process stays alive, its session/context is untouched, and the user (or the phone) can immediately send another prompt into the same still-open session. Concretely:
- Claude Code: sends a bare `ESC` keystroke into the terminal — same as a manual Esc press.
- OpenCode: calls the SDK's `session.abort()` — aborts the in-flight generation on that session; the OpenCode server process and any other sessions keep running.
- Gemini CLI: writes `\x1b` (ESC) into the PTY. `ptyProxyStrategy` also exposes a `stop()` method that does `term.kill()` (full process teardown, used when the interceptor itself shuts down) — the Stop button must **never** call that; it only ever calls `term.write('\x1b')`. §3.5 below is written to make sure the two aren't conflated.

---

## 0. Current state (what exists today)

- `mobile_commands` + `POST /mobile/prompt` + `GET /mobile/command/next` deliver a **queued prompt** to an **idle** session. Delivery is deliberately gated on `isBusy(sessionId)` (`relay-deamon1/scripts/heartbeat.js:131-134`) — the whole design assumes it must never interrupt a live turn.
- `DELETE /mobile/prompt/:id` ("cancel") only cancels a prompt still sitting in the queue (`status='cancelled'`, `mobile.js:533-544`) — it does **not** touch a turn that's already running. There is currently **no way to interrupt an in-flight turn** anywhere in the system.
- `isActive` on mobile (`ChatScreen.tsx:322`) is `liveStatus === 'active'`, where `liveStatus` comes from `agents.status`, computed server-side by `deriveStatus(last_activity_at)` (`utils.js:19-25`): active if updated <30s ago, idle <10min, else finished. **There is no persistent "a turn is running" flag anywhere — it's purely a recency heuristic.** The Stop button's visibility will ride on this same signal; the interrupt mechanism itself doesn't depend on it being exact.
- OpenCode's SDK (`relay-deamon1/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts:82-84`) already exposes `session.abort()` — this is the clean path for that harness, no keystroke hack needed.
- Claude Code has no API of any kind reachable from the daemon — the only lever is the same OS-level keystroke injection heartbeat.js already uses for prompt delivery (`tryInjectIntoExistingTerminal`, `heartbeat.js:203-374`), just sending a different key.
- Gemini CLI runs inside a `node-pty` pseudo-terminal owned by `ptyProxyStrategy.spawn()` (`relay-deamon1/src/harness-sdk/strategies/ptyProxy.js`) — but that PTY handle lives inside the **`vibe run gemini-cli` process**, a separate OS process from `heartbeat.js`. Heartbeat cannot reach into it directly.

## 1. The core design wrinkle

Every existing "deliver something to a session" path in this system (prompt injection) is built around **never acting while busy**. Stop is the exact opposite: **it only matters while busy**, and must bypass every busy-gate that exists. So Stop is *not* a new `kind` on `mobile_commands` — it needs its own table and its own delivery path that ignores `isBusy`/idle-gating entirely.

The three harnesses also need three genuinely different mechanisms, so there's no single "interrupt" primitive — the design adds a per-harness dispatch, mirroring how the harness-sdk already has an `injector` capability per adapter:

| Harness | Mechanism | Where it runs | Reachable from heartbeat.js? |
|---|---|---|---|
| **claude-code** | Send `ESC` keystroke into the live console (same PID + `WriteConsoleInput`/clipboard-paste machinery as prompt injection, but a bare key, no text/Enter) | OS-level, targeting the CLI's own terminal window | Yes — heartbeat already resolves the PID for injection |
| **opencode** | `client.session.abort({ path: { id: sessionId } })` via the already-loaded `@opencode-ai/sdk` client | HTTP call to OpenCode's local server (`localhost:4096`) | Yes — in-daemon, no keystrokes |
| **gemini-cli** | Write `\x1b` (ESC) directly into the PTY the wrapper process owns | Inside the separate `vibe run gemini-cli` process | **No** — that process needs its own lightweight poll loop to learn a stop was requested |

---

## 2. Server (`vibe_remote(serverside)`)

### 2.1 New migration — `migrations/012_stop_requests.sql`

```sql
-- One row per stop request. Separate from mobile_commands because delivery
-- semantics are opposite: mobile_commands waits for idle, stop_requests must
-- be delivered precisely while busy and ignores every busy-gate.
CREATE TABLE IF NOT EXISTS "public"."stop_requests" (
    "id"          uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "session_id"  text NOT NULL,
    "machine_id"  uuid NOT NULL REFERENCES "public"."machines"("id") ON DELETE CASCADE,
    "user_id"     uuid NOT NULL,
    "status"      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
    "created_at"  timestamptz NOT NULL DEFAULT now(),
    "delivered_at" timestamptz
);

CREATE INDEX "idx_stop_requests_machine_pending"
  ON "public"."stop_requests" ("machine_id", "status");

ALTER TABLE "public"."stop_requests" ENABLE ROW LEVEL SECURITY;

-- Machine reads/updates its own rows (machine-key auth bypasses RLS via service role,
-- same pattern as agents/pending_requests — no policy needed beyond ownership sanity).
GRANT ALL ON TABLE "public"."stop_requests" TO "service_role";
```

No realtime publication entry needed — delivery is broadcast (unauthenticated, stateless) not `postgres_changes`; the table exists purely as the durable backstop + audit trail, same role `mobile_commands` plays for prompts.

### 2.2 New endpoint — `src/routes/mobile.js` (add near the existing prompt-injection section, ~line 428)

```js
// POST /mobile/sessions/:sessionId/stop — interrupt an active turn
router.post('/sessions/:sessionId/stop', async (req, res) => {
  const { sessionId } = req.params

  const ids = req.deviceId ? await pairedMachineIds(req.user.id, req.deviceId) : []
  const { data: agent } = await db
    .from('agents')
    .select('machine_id, cli_alive, harness')
    .eq('session_id', sessionId)
    .single()

  if (!agent || (ids.length && !ids.includes(agent.machine_id))) {
    return res.status(403).json({ error: 'Session not found or access denied' })
  }
  if (agent.cli_alive === false) {
    return res.status(409).json({ error: 'CLI closed', code: 'cli_closed' })
  }

  const { data, error } = await db
    .from('stop_requests')
    .insert({ session_id: sessionId, machine_id: agent.machine_id, user_id: req.user.id })
    .select('id')
    .single()

  if (error) {
    console.error('[mobile/stop]', error.message)
    return res.status(500).json({ error: 'Failed to queue stop request' })
  }

  // Same fast-path used for prompt delivery — wakes heartbeat.js in ~1s.
  // Payload carries harness so heartbeat can dispatch without an extra round trip.
  broadcastMachine(agent.machine_id, 'stop_requested', { sessionId, harness: agent.harness })

  res.json({ id: data.id })
})
```

Mirrors `POST /mobile/prompt`'s access checks (`mobile.js:438-473`) exactly, minus the `harness_disabled` check — a harness with mobile support off never got a prompt injected in the first place, but if a turn is already running (started from the desktop directly), Stop should still work, so don't gate on `mobile_enabled`.

### 2.2b Block sending a new prompt while the agent is busy — `POST /mobile/prompt`

**Today this doesn't block at all.** `POST /mobile/prompt` (`mobile.js:431-508`) queues into `mobile_commands` regardless of session state — if the agent is mid-turn, the prompt just sits there and `heartbeat.js`'s `isBusy()` gate (`heartbeat.js:131-134`) silently delays delivery until the turn ends. Nothing today stops the mobile UI from composing and sending while `isActive`, and the compose bar's `canType`/`canSend` (`ChatScreen.tsx:362-363`) don't check activity state either — so right now a user can type a new prompt mid-turn and it just disappears into the queue with no feedback.

The requirement is stronger than "delay it": **while a turn is running, the phone should not be able to send a prompt at all** — the only mobile action available during an active turn is Stop (§4.2). This is enforced in two layers, same defense-in-depth pattern as the existing `cli_alive`/`mobile_enabled` checks in this same handler:

**Server-side (primary)** — reject outright instead of silently queuing. Add right after the existing `harness_disabled` check in `POST /mobile/prompt` (`mobile.js:456-473`):

```js
    // Block sending into a session that's mid-turn — the only mobile action while
    // busy is Stop (POST /mobile/sessions/:id/stop), not queuing a follow-up prompt.
    // Reuses the same recency heuristic already exposed to mobile as agents.status.
    if (deriveStatus(agent.last_activity_at) === 'active') {
      return res.status(409).json({
        error: 'Agent is currently working — stop it or wait before sending a new prompt',
        code:  'session_busy',
      })
    }
```

(`deriveStatus` is already imported from `../utils.js` in this file for other routes — reuse it here rather than re-deriving.) This removes the "silently queued until idle" behavior for prompts *sent while already busy*; a prompt can still be queued in the narrow window where it's sent right as the session goes idle (a normal race, not a new one — `heartbeat.js`'s `isBusy` gate remains as-is as the existing backstop for that window, see §0).

**Mobile-side (UX)** — the compose bar shouldn't even offer the option; the Stop branch added in §4.2 already replaces the entire input row whenever `isActive` is true, so there's no text field to type into in the first place. As defense-in-depth (in case of a stale `isActive` render or a screen that still shows the input momentarily), also tighten the derived flags in `ChatScreen.tsx:362-363`:

```ts
const canType  = liveOnline && pendingCount === 0 && !cliClosed && !harnessOff && !isActive
const canSend  = prompt.trim().length > 0 && !sendPmt.isPending && canType
```

If a `POST /mobile/prompt` call somehow still lands while busy (race, or a future non-UI client), `useSendPrompt`'s `mutateAsync` throws with `code: 'session_busy'` from the server — `handleSend`'s existing `catch` block in `ChatScreen.tsx:356-358` already surfaces `err.message` via `Alert.alert`, so no new error handling is needed there.

### 2.3 New endpoint — `src/routes/relay.js` (machine-authed, polling backstop)

```js
// GET /relay/stop-requests — poll backstop for the broadcast above.
// Called by heartbeat.js (claude-code/opencode) and by the gemini-cli PTY
// wrapper process (which can't receive heartbeat's in-process broadcast handler).
router.get('/stop-requests', requireMachineAuth, async (req, res) => {
  const { session } = req.query
  let q = db.from('stop_requests')
    .select('id, session_id')
    .eq('machine_id', req.machine.id)
    .eq('status', 'pending')
  if (session) q = q.eq('session_id', session)

  const { data, error } = await q
  if (error) return res.status(500).json({ error: error.message })

  res.json({ requests: data ?? [] })
})

// POST /relay/stop-ack — mark stop request(s) delivered, so they stop showing in polls.
router.post('/stop-ack', requireMachineAuth, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : []
  if (!ids.length) return res.json({ ok: true })

  await db.from('stop_requests')
    .update({ status: 'delivered', delivered_at: new Date().toISOString() })
    .in('id', ids)
    .eq('machine_id', req.machine.id)

  res.json({ ok: true })
})
```

Add both to `transport.js` on the daemon side (§3.1).

### 2.4 Mobile REST surface — `src/api/server.ts`

```ts
// ── Stop ─────────────────────────────────────────────────────────────────────
export function stopSession(sessionId: string): Promise<{ id: string }> {
  return request<{ id: string }>(`/mobile/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
  })
}
```

---

## 3. Desktop (`vRdeksMultiharness/relay-deamon1`)

### 3.1 Transport — `src/harness-sdk/transport.js`

Add two calls alongside the existing `uploadRequest`/`pollDecision`/etc.:

```js
export async function pollStopRequests(sessionId) {
  const { data } = await http.get('/relay/stop-requests', { params: { session: sessionId } })
  return data.requests ?? []
}

export async function ackStopRequests(ids) {
  if (!ids.length) return
  await http.post('/relay/stop-ack', { ids })
}
```

(Match whatever HTTP client wrapper `transport.js` already uses for `x-machine-api-key` auth — same pattern as every other call in that file.)

### 3.2 OpenCode adapter — `src/harnesses/opencode/provider.js`

Add an `interrupter` alongside the existing `injector` (line ~90-104):

```js
  // Interrupt an in-flight turn via SDK — no keystroke hack needed.
  interrupter: {
    async send(sessionId) {
      const c = await client()
      if (!c || !sessionId) return false
      try {
        await c.session.abort({ path: { id: sessionId } })
        return true
      } catch (err) {
        console.warn('[opencode] abort failed:', err.message)
        return false
      }
    },
  },
```

### 3.3 Claude Code — `heartbeat.js` new function `sendInterruptKey()`

Add next to `tryInjectIntoExistingTerminal` (`heartbeat.js:203`). Reuses the exact same PID-resolution and `Inj` C# helper type, but sends a single `VK_ESCAPE` (0x1B) key event instead of a typed string + Enter, and the clipboard-paste fallback sends `{ESC}` via `SendKeys` instead of pasting text:

```js
async function sendInterruptKey(sessionId) {
  if (process.platform !== 'win32' || !sessionId) return false

  const pidFile = `C:\\temp\\relay-pid-${sessionId}.txt`
  if (!fs.existsSync(pidFile)) { fileLog(`no PID file for session ${sessionId} (interrupt)`); return false }
  const claudePid = parseInt(fs.readFileSync(pidFile, 'utf8').trim())
  if (!claudePid || isNaN(claudePid)) return false

  const tmpDir    = process.env.TEMP || 'C:\\temp'
  const tmpScript = path.join(tmpDir, `interrupt-${Date.now()}.ps1`)

  // Same Inj type as tryInjectIntoExistingTerminal, but WriteKey sends one VK
  // code directly (no VkKeyScan char mapping — ESC isn't a printable char).
  const ps1 = `
$log = "C:\\temp\\inject-log.txt"
function L([string]$m) { try { Add-Content -Path $log -Value ((Get-Date).ToString("HH:mm:ss") + " [interrupt] " + $m) } catch {} }
L "=== interrupt start === claudePid=${claudePid} session=${sessionId}"

try {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class InjKey {
    [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)]
    public struct IR { [FieldOffset(0)] public ushort T; [FieldOffset(4)] public KER K; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct KER { public int Down; public ushort Rep; public ushort Vk; public ushort Sc; public char U; public uint Ctrl; }
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr GetStdHandle(int h);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] public static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sec, uint d, uint f, IntPtr t);
    [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll",SetLastError=true)] public static extern bool WriteConsoleInput(IntPtr h, IR[] b, uint n, out uint w);
    public static int WriteVk(uint pid, ushort vk) {
        FreeConsole();
        if (!AttachConsole(pid)) return 1000 + Marshal.GetLastWin32Error();
        IntPtr h = CreateFileW("CONIN$", 0x80000000u | 0x40000000u, 0x1u | 0x2u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);
        if (h == IntPtr.Zero || h == new IntPtr(-1)) h = GetStdHandle(-10);
        if (h == IntPtr.Zero || h == new IntPtr(-1)) { FreeConsole(); return 2000; }
        var d = new IR(); d.T = 1; d.K = new KER { Down=1, Rep=1, Vk=vk };
        var u = new IR(); u.T = 1; u.K = new KER { Down=0, Rep=1, Vk=vk };
        var arr = new IR[] { d, u };
        uint written;
        bool ok = WriteConsoleInput(h, arr, (uint)arr.Length, out written);
        int err = Marshal.GetLastWin32Error();
        CloseHandle(h); FreeConsole();
        return ok ? (int)written : 3000 + err;
    }
}
"@
} catch { L "Add-Type failed: $_"; exit 99 }

# VK_ESCAPE = 0x1B
$wc = [InjKey]::WriteVk(${claudePid}, 0x1B)
L "WriteConsoleInput(ESC) returned $wc"
if ($wc -gt 0 -and $wc -lt 1000) { L "SUCCESS via WriteConsoleInput"; exit 0 }

# Fallback: focus + SendKeys ESC (no clipboard — nothing to paste)
L "falling back to SendKeys ESC"
$p = Get-Process -Id ${claudePid} -EA SilentlyContinue
$win = $null
while ($p) {
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $win = $p; break }
    $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -EA 0).ParentProcessId
    if (-not $parent -or $parent -eq 0) { break }
    $p = Get-Process -Id $parent -EA SilentlyContinue
}
if ($null -eq $win) { L "FAILED: no terminal window found"; exit 1 }
Add-Type -AssemblyName System.Windows.Forms
[void][Inj]::SetForegroundWindow($win.MainWindowHandle)
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
L "SUCCESS via SendKeys ESC"
exit 0
`.trim()

  fs.writeFileSync(tmpScript, ps1, 'utf8')
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', tmpScript], { stdio: 'ignore', shell: false })
    child.on('close', code => { fileLog(`interrupt exit code=${code}`); resolve(code === 0) })
    child.on('error', err => { fileLog(`interrupt spawn error: ${err.message}`); resolve(false) })
  })
}
```

> `ShowWindow`/`GetForegroundWindow` P/Invokes already exist on the `Inj` type from `tryInjectIntoExistingTerminal`'s script — reuse that type instead of redefining if both scripts end up sharing a `.ps1` helper module; kept duplicated above for clarity but worth deduping during implementation (see checklist).

### 3.4 heartbeat.js — dispatch + subscription wiring

**Subscribe to the new broadcast event** — extend the existing channel subscription in `subscribeCommandNudge()` (`heartbeat.js:602-630`) with a second `.on('broadcast', ...)` on the *same* channel object (one channel per machine already open, no new connection):

```js
    supabase
      .channel(`machine:${config.machineId}`)
      .on('broadcast', { event: 'command_available' }, ({ payload }) => { /* existing */ })
      .on('postgres_changes', { /* existing */ })
      // NEW: interrupt an in-flight turn — bypasses every busy-gate on purpose.
      .on('broadcast', { event: 'stop_requested' }, ({ payload }) => {
        fileLog(`stop_requested broadcast — session=${payload?.sessionId} harness=${payload?.harness}`)
        handleStopRequest(payload?.sessionId, payload?.harness)
      })
      .subscribe(...)
```

**Dispatch function**, new, near `drainQueue`:

```js
import { getAdapter } from '../src/registry.js'
import { pollStopRequests, ackStopRequests } from '../src/harness-sdk/transport.js'

async function handleStopRequest(sessionId, harness) {
  if (!sessionId) return
  try {
    if (harness === 'opencode') {
      const adapter = await getAdapter('opencode')
      const ok = await adapter?.interrupter?.send?.(sessionId)
      fileLog(`opencode abort(${sessionId}) → ${ok}`)
    } else if (harness === 'gemini-cli') {
      // Handled by the vibe-run-gemini-cli process itself (§3.5) — heartbeat has
      // no reachable handle into that process. Nothing to do here.
      fileLog(`gemini-cli stop request for ${sessionId} — handled by PTY wrapper process`)
    } else {
      // claude-code (default) — only mechanism is the OS-level keystroke.
      if (isSessionProcessAlive(sessionId)) {
        const ok = await sendInterruptKey(sessionId)
        fileLog(`claude-code interrupt(${sessionId}) → ${ok}`)
      }
    }
  } finally {
    // Don't leave a stale busy flag if the interrupt causes an unusual exit path;
    // the Stop hook will also clear this naturally once Claude Code processes ESC.
    clearBusy(sessionId)
  }
}
```

**Polling backstop**, alongside the existing `drainBackstop`/`checkReadyFlags` intervals (`heartbeat.js:670-696`):

```js
async function checkStopRequests() {
  // Unscoped: covers every live session on this machine in one call.
  const pending = await pollStopRequests().catch(() => [])
  if (!pending.length) return
  for (const r of pending) await handleStopRequest(r.session_id, r.harness)
  await ackStopRequests(pending.map(r => r.id)).catch(() => {})
}
...
setInterval(checkStopRequests, 5_000)   // backstop only — broadcast is primary
```

(`pollStopRequests()` without a `sessionId` arg — the `GET /relay/stop-requests` endpoint already supports an unscoped call, matching the `session` query param being optional in §2.3. Note the endpoint's response doesn't currently include `harness`; either join `agents` server-side to return it, or have `handleStopRequest` fall back to a `getAdapter` lookup by session when `harness` is unknown — simplest is to have §2.3's query join `agents(harness)` and return `harness` per row.)

### 3.5 Gemini CLI — `src/harness-sdk/strategies/ptyProxy.js`

The wrapper process (`vibe run gemini-cli`) is the only thing holding the live PTY, so it needs its own poll loop inside `spawn()`. Add near the existing `term.onData` handler (ptyProxy.js:60-93):

```js
import { pollStopRequests, ackStopRequests } from '../transport.js'

// ... inside spawn(cwd, { sessionId } = {}), after `const term = pty.spawn(...)`:

let stopPollTimer = null
if (sessionId) {
  stopPollTimer = setInterval(async () => {
    try {
      const pending = await pollStopRequests(sessionId)
      if (!pending.length) return
      term.write('\x1b')   // ESC — Gemini CLI's interactive-mode cancel key
      await ackStopRequests(pending.map(r => r.id))
      postNarrative(normalizeNarrative({
        session_id: sessionId, harness: harnessId, event_type: 'notification',
        summary: 'Stopped from mobile',
      })).catch(() => {})
    } catch {}
  }, 1500)
}
```

Clear the timer in the returned handle's `stop()`:

```js
      return {
        inject: (text) => term.write(text.endsWith('\r') ? text : text + '\r'),
        write:  (data) => term.write(data),
        stop:   () => { try { term.kill() } catch {}; if (stopPollTimer) clearInterval(stopPollTimer) },
        pid:    term.pid,
      }
```

> **Known limitation to verify manually**: if ESC arrives while the grammar-based approval gate (`gating = true`, ptyProxy.js:58) is displaying an approval prompt, it may dismiss that UI rather than cancel generation, depending on the exact Gemini CLI version's key handling. Worth an explicit manual test (see §5) before shipping; if it's a problem, gate `stopPollTimer`'s write behind `if (!gating)`.

---

## 4. Mobile (`AgentControl`)

### 4.1 `src/hooks/useSessions.ts` — add a mutation

```ts
import { stopSession } from '../api/server'

export function useStopSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => stopSession(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })
}
```

### 4.2 `src/screens/Sessions/ChatScreen.tsx` — Stop button in the compose bar

The compose bar already switches its content based on state (`cliClosed` → closed note, `harnessOff` → off note, `pendingCount > 0` → pending note, else → input row; `ChatScreen.tsx:484-539`). Add a new branch **before** the input-row fallback, for `isActive && pendingCount === 0`:

```tsx
const stopSession = useStopSession()
const [stopping, setStopping] = useState(false)

async function handleStop() {
  setStopping(true)
  try {
    await stopSession.mutateAsync(sessionId)
  } catch (err: any) {
    Alert.alert('Failed to stop', err.message ?? 'Please try again')
  } finally {
    // Clears itself once the feed shows the turn actually ended (stop event /
    // isActive flips false) — this local flag just covers the round-trip latency.
    setTimeout(() => setStopping(false), 4000)
  }
}
```

```tsx
          ) : pendingCount > 0 ? (
            /* existing pendingNote block, unchanged */
          ) : isActive ? (
            <View style={styles.stopRow}>
              <View style={styles.stopStatus}>
                <ActivityIndicator size="small" color={DarkColors.online} />
                <Text style={styles.stopStatusText}>Agent is working…</Text>
              </View>
              <TouchableOpacity
                style={[styles.stopBtn, stopping && styles.stopBtnDisabled]}
                onPress={handleStop}
                disabled={stopping || stopSession.isPending}
                activeOpacity={0.8}
              >
                {stopping || stopSession.isPending
                  ? <ActivityIndicator size="small" color="#FFFFFF" />
                  : <Ionicons name="stop" size={16} color="#FFFFFF" />
                }
                <Text style={styles.stopBtnText}>Stop</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.inputRow}>
              {/* existing input row, unchanged */}
            </View>
          )}
```

Add matching styles (`stopRow`, `stopStatus`, `stopStatusText`, `stopBtn`, `stopBtnDisabled`, `stopBtnText`) following the visual language already established by `closedNote`/`harnessOffNote`/`pendingNote` (icon + text row, `DarkColors.danger` or a dedicated warning tone for the button background).

Also update the derived flags right above (`ChatScreen.tsx:362-363`) so sending is blocked at the state level too, not just by which branch happens to render (see §2.2b for the matching server-side reject):

```ts
const canType  = liveOnline && pendingCount === 0 && !cliClosed && !harnessOff && !isActive
const canSend  = prompt.trim().length > 0 && !sendPmt.isPending && canType
```

**Why gate on `isActive` and not something more precise**: there's no persistent "turn in flight" flag anywhere in the system (see §0) — `isActive` (last activity <30s) is the same heuristic the "Active" status pill already uses, so the Stop button simply appears/disappears in sync with that pill. This means there's a ~30s tail after a turn actually ends where Stop could still show (harmless — see §3.4, aborting an idle session is a no-op) and, conversely, Stop won't appear until the first tool call/narrative event lands (typically sub-second after the user's own prompt was sent). Acceptable for v1; tightening this would require a real "turn started" server-side flag, out of scope here.

**Interaction with pending approvals**: when `pendingCount > 0`, the pending-approval note already takes over the compose bar (existing `else if` branch) before the new `isActive` branch is reached — so Stop is correctly hidden while an approval/question card is blocking the turn (there's nothing actively "running" to interrupt in that state; the right action there is Approve/Deny, not Stop).

---

## 5. Manual test plan (no meaningful unit-test surface — this is OS/process glue)

1. **Claude Code**: send a prompt that takes >10s (e.g. "list every file in this repo one at a time with a 1s pause" or similar), tap Stop from mobile mid-turn. Verify: ESC lands in the terminal, Claude halts the turn, `stopHook.js` fires, chat feed shows the turn ended, a new prompt can be sent immediately after (busy flag cleared).
2. **OpenCode**: same scenario, verify `session.abort()` actually halts generation (check OpenCode's own terminal/logs for confirmation), verify the plugin's `session.idle`/turn-end path still fires afterward so busy state clears.
3. **Gemini CLI**: verify the PTY receives ESC and generation stops; separately verify the grammar-based approval flow still works normally afterward (confirm the interrupt poll loop didn't leave `gating` in a bad state).
4. **Visibility**: confirm Stop is hidden when idle/finished, hidden while a request is pending, hidden when CLI is closed or harness mobile-support is off, and appears within ~1 poll cycle of a turn starting.
5. **Race**: tap Stop right as a turn naturally finishes — confirm it's a harmless no-op on all three harnesses (no crash, no stuck busy flag).
6. **Non-Windows**: confirm OpenCode's Stop still works on macOS/Linux builds (SDK-based, platform-independent) and confirm Claude Code's Stop is a documented no-op there (same platform gap prompt-injection already has, per `ARCHITECTURE.md` §2.6/§6).

---

## 6. Implementation checklist

**Server** (`vibe_remote(serverside)`)
- [x] `migrations/012_stop_requests.sql` — new table + index (§2.1). Also stores `harness` directly on the row (captured at insert time) so `GET /relay/stop-requests` never needs to join `agents`.
- [x] `src/routes/mobile.js` — `POST /mobile/sessions/:sessionId/stop` (§2.2)
- [x] `src/routes/mobile.js` — `POST /mobile/prompt` gains a `session_busy` 409 reject when `deriveStatus(agent.last_activity_at) === 'active'` (§2.2b). Also had to add `last_activity_at` to that handler's existing `agents` select, since it wasn't previously selected.
- [x] `src/routes/relay.js` — `GET /relay/stop-requests`, `POST /relay/stop-ack` (§2.3)

**Desktop** (`vRdeksMultiharness/relay-deamon1`)
- [x] `src/supabase.js` — `pollStopRequests()`, `ackStopRequests()` (used by `heartbeat.js`, which already imports its VPS calls from this file rather than `harness-sdk/transport.js`)
- [x] `src/harness-sdk/transport.js` + `src/harness-sdk/index.js` — same two functions, exported for `ptyProxy.js` (§3.1)
- [x] `src/harnesses/opencode/provider.js` — `interrupter.send()` via SDK `session.abort()` (§3.2)
- [x] `scripts/heartbeat.js` — `sendInterruptKey()`, `handleStopRequest()`, `stop_requested` broadcast subscription, `checkStopRequests()` polling interval (§3.3–3.4). Fixed a bug in this doc's original snippet: the `SendKeys` fallback referenced a P/Invoke type named `Inj`, but the script only defined `InjKey` — the shipped version defines `SetForegroundWindow`/`ShowWindow` on `InjKey` itself so the fallback path actually compiles.
- [x] `src/harness-sdk/strategies/ptyProxy.js` — stop-poll timer inside `spawn()`, cleared in `stop()`; also skips writing ESC while `gating` is true, per the §3.5 known-limitation note (chose the safer default proactively since it can't be manually verified against a live Gemini CLI session right now)

**Mobile** (`AgentControl`)
- [x] `src/api/server.ts` — `stopSession()` (§2.4)
- [x] `src/hooks/useSessions.ts` — `useStopSession()` (§4.1)
- [x] `src/screens/Sessions/ChatScreen.tsx` — Stop UI branch in the compose bar + styles (§4.2). Styles named `workingRow`/`workingStatus`/`workingStatusText`/`stopBtn*` rather than `stopRow`/`stopText` as originally sketched — those names were already taken by the existing feed's turn-ended divider row.
- [x] `src/screens/Sessions/ChatScreen.tsx` — `canType`/`canSend` gain `&& !isActive` (§2.2b, §4.2)

**Verification**
- [x] Syntax-checked every edited file (`node --check` on the desktop/server JS; structural read-through + `tsc` sanity pass on the mobile TS/TSX — a pre-existing `tsconfig.json` flag mismatch blocks a full project type-check in this environment, unrelated to these changes)
- [ ] Manual E2E per harness per §5, on the actual Windows desktop build and a real OpenCode/Gemini CLI session — **not yet done**, needs a live run through all three harnesses
