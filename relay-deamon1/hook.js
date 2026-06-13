/**
 * relay-daemon/hook.js
 *
 * Runs only when mobile mode is active (relay.cjs mobile enables the hook).
 * In CLI mode the hook doesn't exist in settings.json, so this never runs.
 *
 * stdin  → JSON event from Claude Code
 * stderr → shown in Claude Code's hook panel
 * exit 0 → allow  |  exit 2 → block
 *
 * Respond from mobile app, or as fallback from terminal:
 *   ! node relay.cjs 1   (Yes)
 *   ! node relay.cjs 3   (No)
 */

import { randomUUID }                                        from 'crypto'
import { appendFileSync, mkdirSync, existsSync,
         unlinkSync, writeFileSync, readFileSync }           from 'fs'
import { execFileSync }                                      from 'child_process'
import { join }                                              from 'path'
import { fileURLToPath }                                     from 'url'
import { dirname }                                           from 'path'
import { config }                                            from './src/config.js'
import { parseEvent }                                        from './src/parsers.js'
import { preFilter }                                         from './src/filter.js'
import { uploadRequest, waitForDecision, markDecided,
         agentPing, postTerminalEvent }                       from './src/supabase.js'
import { logger }                                            from './src/logger.js'

const __dir     = dirname(fileURLToPath(import.meta.url))
const relayPath = join(__dir, 'relay.cjs').replace(/\\/g, '/')

const PENDING_DIR      = 'C:\\temp\\relay-pending'
const CURRENT_FILE     = 'C:\\temp\\relay-current.txt'
const ALLOW_ALL_FILE   = 'C:\\temp\\relay-allow-all.txt'
const TRANSCRIPT_DIR   = 'C:\\temp\\transcript-paths'

// Record this session's transcript path so heartbeat.js can tail it for narrative output.
// Touched on every hook fire, so heartbeat can age out sessions where interception is off
// (the mapping file's mtime stops updating).
function recordTranscriptPath(sessionId, transcriptPath) {
  if (!sessionId || !transcriptPath) return
  try {
    mkdirSync(TRANSCRIPT_DIR, { recursive: true })
    writeFileSync(join(TRANSCRIPT_DIR, `${sessionId}.path`), transcriptPath, 'utf8')
  } catch (err) {
    debugLog(`recordTranscriptPath failed: ${err.message}`)
  }
}

function debugLog(msg) {
  try {
    mkdirSync('C:\\temp', { recursive: true })
    appendFileSync('C:\\temp\\hook-debug.log', `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

// ── Resolve the real, long-lived `claude` process PID ─────────────────────────
// process.ppid is a transient shell that Claude Code spawns per hook and which
// dies the moment the hook finishes — so the heartbeat can't use it later.
// We walk the full process tree NOW, while every ancestor is still alive, and
// find the actual `claude` process by matching its command line.
function findClaudePid() {
  const psScript = `
$startPid = ${process.pid}
$all = @{}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $all[[int]$_.ProcessId] = $_ }
$result = 0
$cur = $all[[int]$startPid]
$guard = 0
while ($cur -and $guard -lt 30) {
  $guard++
  $cl = $cur.CommandLine
  if ($cl -and ($cl -match 'claude') -and ($cl -notmatch 'hook-wrapper') -and ($cl -notmatch 'heartbeat') -and ($cl -notmatch 'relay-deamon')) {
    $result = $cur.ProcessId
    break
  }
  $pp = $cur.ParentProcessId
  if (-not $pp) { break }
  $cur = $all[[int]$pp]
}
Write-Output $result
`.trim()
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { timeout: 10000, windowsHide: true }
    ).toString().trim()
    const pid = parseInt(out, 10)
    return (pid && !Number.isNaN(pid)) ? pid : null
  } catch (err) {
    debugLog(`findClaudePid failed: ${err.message}`)
    return null
  }
}

// Resolve and cache the claude PID for a session. The process-tree walk is
// expensive (spawns PowerShell) so it runs only once per session — later hooks
// reuse the cached PID as long as that process is still alive.
function storeClaudePid(sessionId) {
  if (!sessionId) return
  try {
    mkdirSync('C:\\temp', { recursive: true })
    const pidFile = `C:\\temp\\relay-pid-${sessionId}.txt`

    if (existsSync(pidFile)) {
      const stored = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (stored && !Number.isNaN(stored)) {
        try { process.kill(stored, 0); return }              // still alive — keep it
        catch (e) { if (e.code === 'EPERM') return }         // alive (no perms) — keep it
      }
    }

    const claudePid = findClaudePid()
    if (claudePid) {
      writeFileSync(pidFile, String(claudePid))
      debugLog(`resolved claude pid for session: ${claudePid}`)
    } else {
      debugLog('could not resolve claude pid')
    }
  } catch (err) {
    debugLog(`storeClaudePid failed: ${err.message}`)
  }
}

// ── Read stdin ────────────────────────────────────────────────────────────────
function readStdinWithTimeout(ms) {
  return new Promise((resolve) => {
    const chunks = []
    let settled  = false
    function finish() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString().trim())
    }
    const timer = setTimeout(finish, ms)
    process.stdin.on('data',  chunk => chunks.push(chunk))
    process.stdin.on('end',   finish)
    process.stdin.on('error', finish)
    if (process.stdin.isTTY) finish()
  })
}

// ── Race: Supabase realtime (mobile) vs local file signal (CLI fallback) ──────
function raceDecision(requestId) {
  const approvedFile = join(PENDING_DIR, `${requestId}.approved`)
  const deniedFile   = join(PENDING_DIR, `${requestId}.denied`)
  return new Promise((resolve) => {
    let settled = false, poll = null
    function finish(decision, decidedBy) {
      if (settled) return
      settled = true
      clearInterval(poll)
      try { unlinkSync(approvedFile) } catch {}
      try { unlinkSync(deniedFile)   } catch {}
      resolve({ decision, decidedBy })
    }
    // Mobile — Supabase Realtime (handles timeout internally)
    waitForDecision(requestId).then(({ decision, decidedBy }) => finish(decision, decidedBy))
    // CLI fallback — poll signal file every 150 ms
    try {
      mkdirSync(PENDING_DIR, { recursive: true })
      poll = setInterval(() => {
        try {
          if (existsSync(approvedFile)) { finish('approved', 'pc'); return }
          if (existsSync(deniedFile))   { finish('denied',   'pc'); return }
        } catch {}
      }, 150)
    } catch {}
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  debugLog('hook started')

  const raw    = await readStdinWithTimeout(3000)
  const source = raw || process.env.CLAUDE_HOOK_INPUT || ''

  let event
  try {
    event = JSON.parse(source)
  } catch (err) {
    debugLog(`JSON parse failed: ${err.message}`)
    hardExit(config.failOpen ? 0 : 2, 'Could not parse hook event')
    return
  }

  debugLog(`tool: ${event.tool_name}`)
  logger.info('Hook fired', { tool: event.tool_name, session: event.session_id })

  // Cache the real claude PID so the heartbeat can inject mobile prompts into
  // this exact terminal. Runs the expensive process-tree walk only once per session.
  storeClaudePid(event.session_id)

  // Record the transcript path so heartbeat can tail it for narrative output
  recordTranscriptPath(event.session_id, event.transcript_path)

  // Pre-filter
  const { action: filterAction, reason: filterReason } = preFilter(event.tool_name, event.tool_input || {})
  if (filterAction === 'allow') { process.exit(0); return }
  if (filterAction === 'block') { hardExit(2, filterReason); return }

  // Allow-all fast path
  if (existsSync(ALLOW_ALL_FILE)) {
    debugLog('allow-all active — auto-approved')
    process.exit(0)
    return
  }

  // Parse into display payload
  let parsed
  try {
    parsed = parseEvent(event)
  } catch (err) {
    parsed = {
      tool_name: event.tool_name, session_id: event.session_id,
      display_type: 'unknown', summary: `${event.tool_name} — parse error`,
      risk: { level: 'medium', reason: 'Could not parse payload', icon: '?' },
      files_affected: [], diff: null, raw_input: event.tool_input,
    }
  }

  // Upsert agent row — keeps last_activity_at and cwd fresh for sessions view
  try {
    await agentPing(
      event.session_id,
      parsed.working_dir ?? process.cwd(),
      event.tool_name,
    )
  } catch (err) {
    debugLog(`agent-ping failed: ${err.message}`)
  }

  const requestId = randomUUID()

  // Store current ID so relay.cjs 1/2/3 needs no UUID
  try {
    mkdirSync('C:\\temp', { recursive: true })
    writeFileSync(CURRENT_FILE, requestId, 'utf8')
  } catch {}

  // Upload to Supabase for mobile
  const row = {
    id: requestId, user_id: config.userId, machine_id: config.machineId,
    session_id:     parsed.session_id     || null,
    tool_name:      parsed.tool_name,
    display_type:   parsed.display_type,
    summary:        parsed.summary,
    risk_level:     parsed.risk.level,
    risk_reason:    parsed.risk.reason,
    risk_icon:      parsed.risk.icon,
    files_affected: parsed.files_affected || [],
    diff:           parsed.diff           || null,
    command:        parsed.command        || null,
    file_path:      parsed.file_path      || null,
    new_content:    parsed.new_content    || null,
    old_content:    parsed.old_content    || null,
    raw_input:      parsed.raw_input      || null,
    status: 'pending', created_at: new Date().toISOString(),
  }

  try {
    await uploadRequest(row)
    debugLog(`uploaded — id: ${requestId}`)
    logger.info('Request uploaded', { id: requestId, tool: parsed.tool_name })
  } catch (err) {
    debugLog(`upload failed: ${err.message}`)
    hardExit(config.failOpen ? 0 : 2, 'Supabase unreachable')
    return
  }

  // Fire-and-forget — lets mobile show "pending approval" before the user decides
  postTerminalEvent({
    session_id: event.session_id,
    event_type: 'tool_start',
    tool_name:  parsed.tool_name,
    summary:    parsed.summary,
    detail:     null,
    status:     null,
  }).catch(() => {})

  // Show prompt — mobile primary, CLI as fallback
  process.stderr.write(
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `  RELAY  ${parsed.tool_name}  ${parsed.risk.icon} ${parsed.risk.level}\n` +
    `  ${parsed.summary}\n` +
    `\n` +
    `  → Sent to mobile app for approval\n` +
    `    Or respond from terminal:\n` +
    `      ! node ${relayPath} 1   (Yes)\n` +
    `      ! node ${relayPath} 3   (No)\n` +
    `\n` +
    `  Disable interception:  ! node ${relayPath} cli\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`
  )

  logger.info('Waiting for decision', { id: requestId, timeout: config.timeoutMs })

  let decision, decidedBy
  try {
    ;({ decision, decidedBy } = await raceDecision(requestId))
  } catch (err) {
    debugLog(`raceDecision error: ${err.message}`)
    hardExit(config.failOpen ? 0 : 2, 'Decision wait failed')
    return
  }

  if (decidedBy === 'pc') {
    try { await markDecided(requestId, decision, 'pc') } catch {}
  }

  debugLog(`decision: ${decision}  by: ${decidedBy}`)
  logger.info('Decision received', { id: requestId, decision, decidedBy })

  if (decision === 'approved') {
    process.exit(0)
  } else {
    hardExit(2, decision === 'timeout'
      ? `No response within ${config.timeoutMs / 1000}s`
      : decidedBy === 'pc' ? 'Denied from terminal' : 'Denied via mobile app')
  }
}

function hardExit(code, reason) {
  if (code !== 0 && reason) process.stderr.write(JSON.stringify({ decision: reason }) + '\n')
  process.exit(code)
}

main().catch(err => {
  try {
    mkdirSync('C:\\temp', { recursive: true })
    appendFileSync('C:\\temp\\hook-debug.log', `[${new Date().toISOString()}] CRASH: ${err.message}\n${err.stack}\n`)
  } catch {}
  process.exit(0)
})
