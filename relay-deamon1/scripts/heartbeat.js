#!/usr/bin/env node
/**
 * Keep this running in a separate terminal (or as a launchd/systemd service).
 *
 *   node scripts/heartbeat.js
 *
 * Runs three loops:
 *   30s — machine heartbeat (keeps is_online fresh)
 *   10s — prompt delivery   (spawns claude --resume when session is idle)
 *    5s — file tree          (responds to fs_requests from mobile)
 */

import { spawn }                  from 'child_process'
import fs                         from 'fs'
import path                       from 'path'
import os                         from 'os'
import { heartbeat, markOffline, getNextCommand, getPendingFsRequest, respondFsRequest, postTerminalEvent, reportSessionsAlive } from '../src/supabase.js'
import { config }                 from '../src/config.js'
import { logger }                 from '../src/logger.js'

// Append a line to C:\temp\heartbeat.log — always works regardless of how
// this process was started (manual terminal or spawned from Electron)
function fileLog(msg) {
  try {
    fs.mkdirSync('C:\\temp', { recursive: true })
    fs.appendFileSync('C:\\temp\\heartbeat.log', `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

// ── Machine heartbeat (30s) ───────────────────────────────────────────────────

async function tick() {
  try {
    await heartbeat()
    logger.debug('Heartbeat sent', { machine: config.machineId })
  } catch (err) {
    logger.warn('Heartbeat failed', { err: err.message })
  }
  // Keep the OpenCode plugin's credentials in sync with the current machine key.
  syncOpencodePluginEnv()
}

// ── Keep the OpenCode plugin env in sync with the live machine key ────────────
// The OpenCode plugin reads its credentials from a SEPARATE JSON file that only
// gets rewritten when mobile support is toggled. If the machine re-registers (new
// API key in .env), that copy goes stale and every plugin request 401s. The
// heartbeat already holds the current valid key (config), so we rewrite the
// plugin env from it whenever the plugin is installed — making it self-heal.
const OC_PLUGIN_DIR = path.join(os.homedir(), '.config', 'opencode', 'plugin')
const OC_PLUGIN_JS  = path.join(OC_PLUGIN_DIR, 'vibe-relay.js')
const OC_ENV_FILE   = path.join(OC_PLUGIN_DIR, 'vibe-relay.env.json')

function syncOpencodePluginEnv() {
  try {
    if (!fs.existsSync(OC_PLUGIN_JS)) return   // OpenCode plugin not installed
    const next = JSON.stringify({
      apiUrl:        config.apiUrl,
      machineApiKey: config.machineApiKey,
      userId:        config.userId,
      machineId:     config.machineId,
      supabaseUrl:   config.supabaseUrl,
      supabaseKey:   config.supabaseKey,
      timeoutMs:     config.timeoutMs,
      failOpen:      config.failOpen,
    }, null, 2)
    let current = null
    try { current = fs.readFileSync(OC_ENV_FILE, 'utf8') } catch {}
    if (current !== next) {
      fs.writeFileSync(OC_ENV_FILE, next)
      fileLog('synced OpenCode plugin env with current machine key')
    }
  } catch (err) {
    fileLog(`syncOpencodePluginEnv failed: ${err.message}`)
  }
}

// ── Prompt delivery (10s) ─────────────────────────────────────────────────────
// Server only returns a command when pending_count === 0 AND last_activity > 30s ago,
// so we never interrupt an active session.

// Is the harness CLI for this session STILL OPEN?
// Both Claude (hook.js) and OpenCode (relay plugin) write the live console PID to
// C:\temp\relay-pid-<sessionId>.txt while running. We verify that PID is alive:
//   • alive  → the CLI window is still open → inject the prompt into it
//   • dead/missing → the user closed the CLI → resume the session in a new window
// `session.kill(pid, 0)` throws ESRCH if the process is gone, EPERM if it is alive
// but owned by another user (still "alive" for our purposes).
function isSessionProcessAlive(sessionId) {
  if (!sessionId || process.platform !== 'win32') return false
  const pidFile = `C:\\temp\\relay-pid-${sessionId}.txt`
  try {
    if (!fs.existsSync(pidFile)) return false
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
    if (!pid || Number.isNaN(pid)) return false
    try { process.kill(pid, 0); return true }
    catch (e) { return e.code === 'EPERM' }
  } catch { return false }
}

async function checkPendingCommands() {
  try {
    const cmd = await getNextCommand()
    if (!cmd?.prompt) return

    const harness = cmd.harness || 'claude-code'
    fileLog(`prompt received — sessionId=${cmd.sessionId} harness=${harness}`)
    logger.info('Delivering prompt', { sessionId: cmd.sessionId, harness })

    // ── CLI still open → inject into that exact terminal ──────────────────────
    // Only Claude/OpenCode run an injectable interactive console (Gemini uses the
    // PTY-proxy model). We require the PID to be alive so we never inject into a
    // closed/stale terminal — and we NEVER spawn a new window for a closed CLI
    // (resuming one unattended is dangerous; the mobile app blocks that case).
    const injectable = harness === 'claude-code' || harness === 'opencode'

    if (injectable && isSessionProcessAlive(cmd.sessionId)) {
      const injected = await tryInjectIntoExistingTerminal(cmd.sessionId, cmd.prompt)
      if (injected) {
        fileLog(`prompt injected into existing ${harness} terminal`)
        return
      }
      fileLog(`live PID but injection failed for ${harness} — dropping prompt`)
    } else {
      // CLI was closed (or non-injectable). Drop the prompt and tell the user via
      // a notification event instead of silently launching a new agent.
      fileLog(`CLI closed for session ${cmd.sessionId} (${harness}) — prompt not delivered`)
    }

    postTerminalEvent({
      session_id: cmd.sessionId,
      event_type: 'notification',
      tool_name:  null,
      summary:    'Prompt not delivered — the CLI for this session is closed. Start the agent again to continue.',
      detail:     null,
      status:     null,
    }).catch(() => {})
  } catch (err) {
    fileLog(`checkPendingCommands error: ${err.message}`)
    logger.warn('checkPendingCommands failed', { err: err.message })
  }
}

// Build the CLI command (with the prompt in PowerShell var $p, or shell var) for
// the given harness. The prompt itself is passed via a variable, never inlined,
// so quotes/newlines in it can't break the command.
function harnessRunCommand(harness, sessionId, promptVar) {
  if (harness === 'opencode') {
    const sess = sessionId ? `--session "${sessionId}"` : ''
    return `opencode run ${sess} ${promptVar}`
  }
  if (harness === 'gemini-cli') {
    // Gemini has no resume-by-id; -p runs a one-shot prompt in the cwd.
    return `gemini -p ${promptVar}`
  }
  // claude-code (default)
  const sess = sessionId ? `--resume "${sessionId}"` : ''
  return `claude ${sess} -p ${promptVar}`
}

// ── Inject prompt into the already-open Claude terminal ───────────────────────
// Two methods, tried in order:
//   1. WriteConsoleInput  — writes raw KEY_EVENT records into the console input
//      buffer Claude is reading from. Works for traditional console hosts.
//   2. Clipboard + focus + paste shortcut — fallback for ConPTY-based terminals
//      (Windows Terminal). Uses Ctrl+Shift+V because that's WT's default paste.
//
// All steps log to C:\temp\inject-log.txt so the user can see exactly which
// stage succeeded or failed.
async function tryInjectIntoExistingTerminal(sessionId, prompt) {
  if (process.platform !== 'win32' || !sessionId) return false

  const pidFile = `C:\\temp\\relay-pid-${sessionId}.txt`
  if (!fs.existsSync(pidFile)) {
    fileLog(`no PID file for session ${sessionId}`)
    return false
  }

  const claudePid = parseInt(fs.readFileSync(pidFile, 'utf8').trim())
  if (!claudePid || isNaN(claudePid)) {
    fileLog(`invalid PID in file: ${claudePid}`)
    return false
  }

  const tmpDir    = process.env.TEMP || 'C:\\temp'
  const tmpScript = path.join(tmpDir, `inject-${Date.now()}.ps1`)

  // The PS1 script is built as a JS template literal. Note:
  //   ${jsVar}   → JavaScript interpolation (resolved by Node)
  //   $psVar     → PowerShell variable, passed through verbatim
  //   $($expr)   → PowerShell expression substitution, passed through verbatim
  //   \\         → single backslash in the output file (for path escaping in C#)
  const ps1 = `
$log = "C:\\temp\\inject-log.txt"
function L([string]$m) {
    try { Add-Content -Path $log -Value ((Get-Date).ToString("HH:mm:ss") + " " + $m) } catch {}
}

L "=== injection start ===  claudePid=${claudePid}  session=${sessionId}"

$prompt = @'
${prompt}
'@

# C# helper — WriteConsoleInput + window operations + VkKeyScan
try {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class Inj {
    [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)]
    public struct IR {
        [FieldOffset(0)] public ushort T;
        [FieldOffset(4)] public KER K;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct KER {
        public int    Down;
        public ushort Rep;
        public ushort Vk;
        public ushort Sc;
        public char   U;
        public uint   Ctrl;
    }
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr GetStdHandle(int h);
    [DllImport("kernel32.dll",SetLastError=true)] public static extern bool WriteConsoleInput(IntPtr h, IR[] b, uint n, out uint w);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public static int Write(uint pid, string text) {
        FreeConsole();
        if (!AttachConsole(pid)) return 1000 + Marshal.GetLastWin32Error();
        IntPtr h = GetStdHandle(-10);
        if (h == IntPtr.Zero || h == new IntPtr(-1)) { FreeConsole(); return 2000; }
        var list = new List<IR>();
        foreach (char c in text) {
            short vks = VkKeyScan(c);
            ushort vk = (ushort)(vks & 0xFF);
            var d = new IR(); d.T = 1; d.K = new KER { Down=1, Rep=1, Vk=vk, U=c }; list.Add(d);
            var u = new IR(); u.T = 1; u.K = new KER { Down=0, Rep=1, Vk=vk, U=c }; list.Add(u);
        }
        // Enter (VK_RETURN = 0x0D)
        var ed = new IR(); ed.T = 1; ed.K = new KER { Down=1, Rep=1, Vk=0x0D, U='\\r' }; list.Add(ed);
        var eu = new IR(); eu.T = 1; eu.K = new KER { Down=0, Rep=1, Vk=0x0D, U='\\r' }; list.Add(eu);
        var arr = list.ToArray();
        uint written;
        bool ok = WriteConsoleInput(h, arr, (uint)arr.Length, out written);
        int err = Marshal.GetLastWin32Error();
        FreeConsole();
        if (!ok) return 3000 + err;
        return (int)written;
    }
}
"@
} catch {
    L "Add-Type failed: $_"
    exit 99
}

# ─── Method 1: WriteConsoleInput ────────────────────────────────────────────
L "trying WriteConsoleInput..."
$wc = [Inj]::Write(${claudePid}, $prompt)
L "WriteConsoleInput returned $wc  (positive = records written, 1xxx = AttachConsole err, 2xxx = GetStdHandle err, 3xxx = WriteConsoleInput err)"

if ($wc -gt 0 -and $wc -lt 1000) {
    L "SUCCESS via WriteConsoleInput ($wc records)"
    exit 0
}

# ─── Method 2: Clipboard + window focus + paste shortcut ────────────────────
L "WriteConsoleInput did not write, falling back to clipboard+paste"
try { Set-Clipboard -Value $prompt; L "clipboard set ($($prompt.Length) chars)" } catch { L "Set-Clipboard error: $_" }

# Walk up the process tree from claude's PID until we hit a process with a visible window
$walk = ""
$p = Get-Process -Id ${claudePid} -EA SilentlyContinue
$win = $null
while ($p) {
    $walk += "$($p.Name)[$($p.Id)] hwnd=$($p.MainWindowHandle.ToInt64()) -> "
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $win = $p; break }
    $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -EA 0).ParentProcessId
    if (-not $parent -or $parent -eq 0) { break }
    $p = Get-Process -Id $parent -EA SilentlyContinue
}
L "process walk: $walk"

if ($null -eq $win) { L "FAILED: no terminal window found in process tree"; exit 1 }
L "terminal window: $($win.Name)  PID=$($win.Id)  hwnd=$($win.MainWindowHandle.ToInt64())"

[void][Inj]::ShowWindow($win.MainWindowHandle, 9)   # SW_RESTORE
[void][Inj]::SetForegroundWindow($win.MainWindowHandle)
Start-Sleep -Milliseconds 600
$fg = [Inj]::GetForegroundWindow()
L "after focus: foreground hwnd=$($fg.ToInt64()) target=$($win.MainWindowHandle.ToInt64())"

Add-Type -AssemblyName System.Windows.Forms

# Windows Terminal uses Ctrl+Shift+V; legacy CMD/PowerShell uses Ctrl+V
$shortcut = '^v'
if ($win.Name -match 'WindowsTerminal') { $shortcut = '^+v' }
L "sending paste shortcut: $shortcut"
[System.Windows.Forms.SendKeys]::SendWait($shortcut)
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

L "SUCCESS via clipboard paste"
exit 0
`.trim()

  fs.writeFileSync(tmpScript, ps1, 'utf8')
  fileLog(`injection script written: ${tmpScript}  claudePid=${claudePid}`)

  return new Promise((resolve) => {
    const child = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', tmpScript], {
      stdio: 'ignore',
      shell: false,
    })
    child.on('close', code => {
      fileLog(`injection exit code=${code}  (see C:\\temp\\inject-log.txt for details)`)
      resolve(code === 0)
    })
    child.on('error', err => {
      fileLog(`injection spawn error: ${err.message}`)
      resolve(false)
    })
  })
}

// ── Open a new visible terminal window running the harness with the prompt ────
function openNewTerminalWindow(cmd, spawnCwd, harness = 'claude-code') {
  if (process.platform === 'win32') {
    const tmpDir    = process.env.TEMP || 'C:\\temp'
    const tmpScript = path.join(tmpDir, `vibe-relay-${Date.now()}.ps1`)
    // Prompt goes into the PowerShell here-string $p; the run command references $p
    const runCmd = harnessRunCommand(harness, cmd.sessionId, '$p')
    fs.writeFileSync(
      tmpScript,
      [`$p = @'`, cmd.prompt, `'@`, runCmd].join('\r\n'),
      'utf8'
    )
    const escaped = tmpScript.replace(/"/g, '\\"')
    const shellCmd = `start "Vibe Remote — ${harness}" powershell -NoExit -ExecutionPolicy Bypass -File "${escaped}"`
    fileLog(`new window (${harness}): ${runCmd}`)
    const child = spawn(shellCmd, [], {
      cwd: spawnCwd, stdio: 'ignore', env: { ...process.env }, detached: true, shell: true,
    })
    child.unref()
  } else {
    const escapedPrompt = cmd.prompt.replace(/'/g, "'\\''")
    // Pass the prompt as a single-quoted positional/arg per harness
    const runCmd = harness === 'opencode'
      ? (cmd.sessionId ? `opencode run --session '${cmd.sessionId}' '${escapedPrompt}'` : `opencode run '${escapedPrompt}'`)
      : harness === 'gemini-cli'
      ? `gemini -p '${escapedPrompt}'`
      : (cmd.sessionId ? `claude --resume '${cmd.sessionId}' -p '${escapedPrompt}'` : `claude -p '${escapedPrompt}'`)
    const termCmd = process.platform === 'darwin'
      ? `open -a Terminal -n --args zsh -c '${runCmd}; exec zsh'`
      : `x-terminal-emulator -e bash -c '${runCmd}; exec bash'`
    fileLog(`new window (${harness}): ${runCmd}`)
    const child = spawn(termCmd, [], {
      cwd: spawnCwd, stdio: 'ignore', env: { ...process.env }, detached: true, shell: true,
    })
    child.unref()
  }
}

// ── File tree (5s) ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv', 'build'])

function buildTree(absoluteRoot, requestedPath, baseCwd, maxDepth, depth = 0) {
  const fullPath = path.resolve(absoluteRoot, requestedPath)

  // Security: never escape the session's cwd
  if (!fullPath.startsWith(baseCwd)) throw new Error('Path traversal blocked')

  const entries = fs.readdirSync(fullPath, { withFileTypes: true })
    .filter(e => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  return entries.map(entry => {
    const childRelPath = path.join(requestedPath, entry.name)
    if (entry.isDirectory()) {
      return {
        name:     entry.name,
        path:     childRelPath,
        type:     'dir',
        // null = has children but not loaded yet — mobile requests lazily
        children: depth < maxDepth
          ? buildTree(absoluteRoot, childRelPath, baseCwd, maxDepth, depth + 1)
          : null,
      }
    }
    const stat = fs.statSync(path.join(fullPath, entry.name))
    return { name: entry.name, path: childRelPath, type: 'file', size: stat.size }
  })
}

async function checkFsRequests() {
  try {
    const pending = await getPendingFsRequest()
    if (!pending?.id) return

    logger.info('Serving fs request', { id: pending.id, path: pending.path })

    try {
      const root = pending.sessionCwd ?? process.cwd()
      const tree = buildTree(root, pending.path ?? '.', root, 4)
      await respondFsRequest(pending.id, { tree })
    } catch (err) {
      await respondFsRequest(pending.id, { error: err.message })
    }
  } catch (err) {
    logger.warn('checkFsRequests failed', { err: err.message })
  }
}

// ── Transcript watcher (3s) ───────────────────────────────────────────────────
// Claude Code writes a JSONL transcript for each session at
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// Each hook fire updates C:\temp\transcript-paths\<session-id>.path with the path,
// so we know which transcripts belong to active interception sessions on this machine.
//
// Each loop tick: read new bytes from each known transcript, parse complete JSON lines,
// forward any assistant `text` content blocks (Claude's narrative reasoning between tool
// calls) as `output` terminal_events. Tool uses/results are skipped — hooks already capture
// those. Output is what the user sees Claude "monologuing" in their CLI between tool calls.

const TRANSCRIPT_MAPPING_DIR = 'C:\\temp\\transcript-paths'
const STALE_MAPPING_MS       = 5 * 60 * 1000           // mappings older than 5m → assume hook is off
const transcriptPositions    = new Map()               // sessionId → byte offset

function listTranscriptMappings() {
  try {
    return fs.readdirSync(TRANSCRIPT_MAPPING_DIR)
      .filter(f => f.endsWith('.path'))
      .map(f => ({ sessionId: f.replace(/\.path$/, ''), file: path.join(TRANSCRIPT_MAPPING_DIR, f) }))
  } catch {
    return []
  }
}

async function tailOneTranscript(sessionId, mappingFile) {
  // Skip mappings whose file hasn't been touched recently — interception is likely off
  let mappingStat
  try { mappingStat = fs.statSync(mappingFile) } catch { return }
  if (Date.now() - mappingStat.mtimeMs > STALE_MAPPING_MS) return

  let transcriptPath
  try { transcriptPath = fs.readFileSync(mappingFile, 'utf8').trim() } catch { return }
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return

  let stat
  try { stat = fs.statSync(transcriptPath) } catch { return }

  // First time we see this session — skip existing history, start tailing from end
  if (!transcriptPositions.has(sessionId)) {
    transcriptPositions.set(sessionId, stat.size)
    return
  }

  const lastPos = transcriptPositions.get(sessionId)
  if (stat.size <= lastPos) return

  // Read only the new bytes since lastPos
  let chunk
  try {
    const fd = fs.openSync(transcriptPath, 'r')
    chunk = Buffer.alloc(stat.size - lastPos)
    fs.readSync(fd, chunk, 0, chunk.length, lastPos)
    fs.closeSync(fd)
  } catch (err) {
    fileLog(`transcript read ${sessionId} failed: ${err.message}`)
    return
  }

  // Only process complete lines — a partial trailing line waits for the next tick
  const text         = chunk.toString('utf8')
  const lastNewline  = text.lastIndexOf('\n')
  if (lastNewline < 0) return
  transcriptPositions.set(sessionId, lastPos + lastNewline + 1)

  const lines = text.slice(0, lastNewline).split('\n').filter(l => l.trim())
  for (const line of lines) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }

    // Only forward assistant narrative text — tool_use/tool_result are already covered by hooks
    if (entry.type !== 'assistant' || !entry.message?.content) continue
    const blocks = Array.isArray(entry.message.content) ? entry.message.content : []
    for (const block of blocks) {
      if (block.type !== 'text') continue
      const t = (block.text || '').trim()
      if (!t) continue
      postTerminalEvent({
        session_id: sessionId,
        event_type: 'output',
        tool_name:  null,
        summary:    t.slice(0, 2000),
        detail:     null,
        status:     null,
      }).catch(() => {})
    }
  }
}

async function checkTranscripts() {
  for (const { sessionId, file } of listTranscriptMappings()) {
    await tailOneTranscript(sessionId, file)
  }
}

// ── Session liveness (15s) ────────────────────────────────────────────────────
// Enumerate the per-session PID files (relay-pid-<sessionId>.txt) written by each
// harness while running, check which processes are still alive, and report the
// live set to the server. The server marks every other agent on this machine
// cli_alive=false so the mobile app can block prompting a closed CLI.
async function reportSessionLiveness() {
  if (process.platform !== 'win32') return
  const dir = 'C:\\temp'
  let files
  try { files = fs.readdirSync(dir) } catch { return }

  const alive = []
  for (const f of files) {
    const m = /^relay-pid-(.+)\.txt$/.exec(f)
    if (!m) continue
    const sessionId = m[1]
    if (isSessionProcessAlive(sessionId)) {
      alive.push(sessionId)
    } else {
      // Process is gone — drop the stale PID file so it doesn't accumulate.
      try { fs.unlinkSync(path.join(dir, f)) } catch {}
    }
  }

  try {
    await reportSessionsAlive(alive)
    logger.debug('Reported session liveness', { alive: alive.length })
  } catch (err) {
    logger.warn('reportSessionLiveness failed', { err: err.message })
  }
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

async function shutdown() {
  try { await markOffline() } catch {}
  logger.info('Machine marked offline')
  process.exit(0)
}

process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)

// ── Start ─────────────────────────────────────────────────────────────────────

logger.info('Heartbeat started', { machine: config.machineId })

syncOpencodePluginEnv()   // sync immediately on launch
tick()
reportSessionLiveness()
setInterval(tick,                  30_000)
setInterval(checkPendingCommands,  10_000)
setInterval(checkFsRequests,        5_000)
setInterval(checkTranscripts,       3_000)
setInterval(reportSessionLiveness, 15_000)
