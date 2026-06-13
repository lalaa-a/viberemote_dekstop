/**
 * Vibe Remote — OpenCode relay plugin.
 *
 * Installed into ~/.config/opencode/plugin/vibe-relay.js — OpenCode auto-loads it.
 * Three responsibilities:
 *   1. Gate gated tool calls through the phone (tool.execute.before → approve/deny)
 *   2. Stream reasoning text to the phone as terminal_events (event hook)
 *   3. Post tool_start / tool_end events so activity bubbles appear in the chat
 *
 * The SDK event stream in the daemon (opencode/provider.js narrator) was the original
 * narrative path, but it is never started because the heartbeat only handles Claude
 * Code. Emitting narrative directly from the plugin is simpler and self-contained.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

const PLUGIN_DIR = path.join(os.homedir(), '.config', 'opencode', 'plugin')
const FLAG_FILE  = path.join(os.homedir(), '.config', 'opencode', '.vibe-mobile-on')
const ENV_FILE   = path.join(PLUGIN_DIR, 'vibe-relay.env.json')

function env() {
  try { return JSON.parse(fs.readFileSync(ENV_FILE, 'utf8')) } catch { return {} }
}

// Map OpenCode tool names → canonical schema + a short summary.
function summarize(tool, args = {}) {
  switch (tool) {
    case 'bash':
      return { tool_name: 'bash', display_type: 'command', command: args.command || '',
               summary: (args.command || '').slice(0, 120) }
    case 'edit':
      return { tool_name: 'edit', display_type: 'edit', file_path: args.filePath || args.path || '',
               summary: `Edit ${args.filePath || args.path || ''}` }
    case 'write':
      return { tool_name: 'write', display_type: 'write', file_path: args.filePath || args.path || '',
               summary: `Write ${args.filePath || args.path || ''}` }
    case 'patch':
      return { tool_name: 'patch', display_type: 'edit', summary: 'Apply patch' }
    default:
      return { tool_name: 'unknown', display_type: 'unknown', summary: tool }
  }
}

async function uploadAndWait(e, row) {
  const res = await fetch(`${e.apiUrl}/relay/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-machine-api-key': e.machineApiKey },
    body: JSON.stringify({ payload: row }),
  })
  if (!res.ok) throw new Error(`upload failed ${res.status}`)
  const { id } = await res.json()

  const deadline = Date.now() + (e.timeoutMs || 300000)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const s = await fetch(`${e.apiUrl}/relay/status/${id}`, {
      headers: { 'x-machine-api-key': e.machineApiKey },
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (s?.status === 'approved') return true
    if (s?.status === 'denied')   return false
  }
  return e.failOpen !== false   // honor the machine's fail-open/closed policy
}

const GATED = new Set(['bash', 'edit', 'write', 'patch'])

// Track which sessions we've already pinged so we only do it once per session
// rather than on every tool call (the ping is just to register the agent row).
const _pingedSessions = new Set()

async function agentPing(e, sessionID, cwd) {
  if (!sessionID || _pingedSessions.has(sessionID)) return
  _pingedSessions.add(sessionID)
  try {
    await fetch(`${e.apiUrl}/relay/agent-ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-machine-api-key': e.machineApiKey },
      body: JSON.stringify({ sessionId: sessionID, cwd: cwd ?? null, harness: 'opencode' }),
    })
  } catch { /* non-fatal — session just won't appear in the list */ }
}

// ── Debug log (helps diagnose why narrative may not appear) ───────────────────
const DEBUG_LOG = path.join(os.homedir(), '.config', 'opencode', 'vibe-relay-debug.log')
function dbg(msg) {
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch {}
}

// ── Record this OpenCode process's PID so the heartbeat can inject prompts into
// THIS terminal (same scheme Claude's hook.js uses). OpenCode is a single binary
// that owns the console, so process.pid is exactly the process to target. The
// heartbeat reads C:\temp\relay-pid-<sessionId>.txt and keystroke-injects there.
const PID_DIR = 'C:\\temp'
const _pidWritten = new Set()
function recordPid(sessionId) {
  if (!sessionId || process.platform !== 'win32' || _pidWritten.has(sessionId)) return
  _pidWritten.add(sessionId)
  try {
    fs.mkdirSync(PID_DIR, { recursive: true })
    fs.writeFileSync(path.join(PID_DIR, `relay-pid-${sessionId}.txt`), String(process.pid))
    dbg(`recorded pid ${process.pid} for session ${sessionId}`)
  } catch (err) {
    dbg(`recordPid failed: ${err.message}`)
  }
}

// Remove the PID files for sessions this process recorded — called on dispose
// (OpenCode shutting down) so the heartbeat sees the CLI as closed and resumes
// future prompts in a fresh window instead of injecting into a dead terminal.
function clearPids() {
  for (const sessionId of _pidWritten) {
    try { fs.unlinkSync(path.join(PID_DIR, `relay-pid-${sessionId}.txt`)) } catch {}
  }
  dbg(`cleared ${_pidWritten.size} pid file(s) on dispose`)
}

// ── Shared terminal-event helper ──────────────────────────────────────────────
async function postTerminalEvent(e, payload) {
  if (!e.apiUrl) { dbg('postTerminalEvent skipped — no apiUrl'); return }
  try {
    const res = await fetch(`${e.apiUrl}/relay/terminal-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-machine-api-key': e.machineApiKey },
      body: JSON.stringify({ ...payload, harness: 'opencode' }),
    })
    dbg(`POST terminal-event ${payload.event_type} session=${payload.session_id} → ${res.status}`)
  } catch (err) {
    dbg(`POST terminal-event FAILED: ${err.message}`)
  }
}

// Track text/reasoning parts we've already posted (keyed by part id) so the
// per-token streaming updates don't create a flood of duplicate rows.
const _postedParts = new Set()

export const VibeRelay = async ({ project, directory } = {}) => {
  dbg(`plugin loaded — flag=${fs.existsSync(FLAG_FILE)} dir=${directory ?? '?'}`)
  return {
    // ── 0. Cleanup on OpenCode shutdown ───────────────────────────────────────
    // Removes this session's PID file so the heartbeat treats the CLI as closed
    // and resumes future prompts in a new window rather than a dead terminal.
    dispose: async () => { clearPids() },

    // ── 1. Tool gating ────────────────────────────────────────────────────────
    'tool.execute.before': async (input, output) => {
      if (!fs.existsSync(FLAG_FILE)) return
      if (!GATED.has(input.tool)) return

      const e = env()
      if (!e.apiUrl) return

      recordPid(input.sessionID)
      agentPing(e, input.sessionID, directory ?? null)

      const args = (output && output.args) || input.args || {}
      const meta = summarize(input.tool, args)

      postTerminalEvent(e, {
        session_id: input.sessionID ?? null,
        event_type: 'tool_start',
        tool_name:  meta.tool_name,
        summary:    meta.summary,
      })

      const row = {
        id: randomUUID(),
        harness: 'opencode',
        user_id: e.userId, machine_id: e.machineId,
        session_id: input.sessionID ?? null,
        tool_name: meta.tool_name,
        display_type: meta.display_type,
        summary: meta.summary,
        risk_level: 'medium', risk_reason: 'OpenCode tool call', risk_icon: '🔶',
        files_affected: meta.file_path ? [meta.file_path] : [],
        command: meta.command ?? null,
        file_path: meta.file_path ?? null,
        raw_input: args,
        status: 'pending', created_at: new Date().toISOString(),
      }

      const approved = await uploadAndWait(e, row)
      if (!approved) throw new Error('Denied via Vibe Remote mobile app')
    },

    // ── 2. Tool completion ────────────────────────────────────────────────────
    'tool.execute.after': async (input, output) => {
      if (!fs.existsSync(FLAG_FILE)) return
      const e = env()
      postTerminalEvent(e, {
        session_id: input.sessionID ?? null,
        event_type: 'tool_end',
        tool_name:  input.tool,
        summary:    output?.title || `${input.tool} completed`,
        status:     'success',
      })
    },

    // ── 3. Narrative — reasoning + response text ─────────────────────────────
    // event.properties.part is a Part; sessionID lives on the PART (not on
    // event.properties). Text streams token-by-token via repeated
    // message.part.updated; we post only once the part finishes (time.end set)
    // so each reasoning/response block becomes one chat bubble.
    event: async ({ event }) => {
      if (!fs.existsSync(FLAG_FILE)) return
      if (!event || event.type !== 'message.part.updated') return

      const part = event.properties?.part
      if (!part) return
      if (part.type !== 'text' && part.type !== 'reasoning') return
      if (part.synthetic) return                       // skip auto-generated parts

      // Only emit once the streaming part has completed.
      if (!part.time || part.time.end == null) return
      if (_postedParts.has(part.id)) return
      _postedParts.add(part.id)

      const text = String(part.text || '').trim()
      if (!text) return

      const e = env()
      if (!e.apiUrl) return

      // Register the session here too, so tool-less conversation turns (pure text
      // responses with no gated tool) still appear in the phone's chat list, and
      // record the PID so prompts can be injected into this terminal.
      recordPid(part.sessionID)
      agentPing(e, part.sessionID, directory ?? null)

      dbg(`narrative part ${part.type} id=${part.id} session=${part.sessionID} len=${text.length}`)
      postTerminalEvent(e, {
        session_id: part.sessionID ?? null,          // ← CORRECT: sessionID is on the part
        event_type: 'output',
        tool_name:  part.type === 'reasoning' ? 'reasoning' : null,
        summary:    text.slice(0, 4000),
      })
    },
  }
}
