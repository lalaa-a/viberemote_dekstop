/**
 * relay-daemon/postHook.js
 *
 * Claude Code PostToolUse hook — fires after every tool call completes.
 * Sends a terminal_event so the mobile app can show the result.
 *
 * Must exit 0 — PostToolUse hooks must never block.
 *
 * stdin shape:
 *   { session_id, tool_name, tool_input, tool_response }
 *   tool_response for Bash: { output, error, exit_code, interrupted }
 *   tool_response for file tools: { success } or { error }
 */

import { postTerminalEvent } from './src/supabase.js'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const TRANSCRIPT_DIR = 'C:\\temp\\transcript-paths'
function recordTranscriptPath(sessionId, transcriptPath) {
  if (!sessionId || !transcriptPath) return
  try {
    mkdirSync(TRANSCRIPT_DIR, { recursive: true })
    writeFileSync(join(TRANSCRIPT_DIR, `${sessionId}.path`), transcriptPath, 'utf8')
  } catch {}
}

function readStdin(ms) {
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
    process.stdin.on('data',  c => chunks.push(c))
    process.stdin.on('end',   finish)
    process.stdin.on('error', finish)
    if (process.stdin.isTTY) finish()
  })
}

async function main() {
  const raw = await readStdin(3000)
  let event
  try { event = JSON.parse(raw) } catch { process.exit(0) }

  const { session_id, tool_name, tool_input, tool_response, transcript_path } = event
  recordTranscriptPath(session_id, transcript_path)

  const isError = (tool_response?.exit_code > 0) || !!tool_response?.error

  let summary = ''
  let detail  = null

  if (tool_name === 'Bash') {
    const cmd = (tool_input?.command || '').slice(0, 80)
    summary   = `Bash: ${cmd}`
    const out = tool_response?.output || tool_response?.error || ''
    if (out.trim()) detail = out.slice(0, 500)
  } else if (tool_name === 'Read') {
    summary = `Read ${tool_input?.file_path || ''}`
  } else if (tool_name === 'Write') {
    summary = `Write ${tool_input?.file_path || ''}`
  } else if (tool_name === 'Edit') {
    summary = `Edit ${tool_input?.file_path || ''}`
  } else if (tool_name === 'MultiEdit') {
    const count = (tool_input?.edits || []).length
    summary = `MultiEdit ${count} file${count !== 1 ? 's' : ''}`
  } else {
    summary = tool_name || 'Unknown tool'
  }

  await postTerminalEvent({
    session_id,
    event_type: 'tool_end',
    tool_name:  tool_name ?? null,
    summary,
    detail,
    status: isError ? 'error' : 'success',
  }).catch(() => {})

  process.exit(0)
}

main().catch(() => process.exit(0))
