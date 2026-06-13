/**
 * relay-daemon/stopHook.js
 *
 * Claude Code Stop hook — fires when Claude finishes a task.
 * The `result` field contains Claude's own summary of what it did.
 *
 * stdin shape: { session_id, stop_reason?, result? }
 */

import { postTerminalEvent } from './src/supabase.js'
import { mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

const TRANSCRIPT_DIR = 'C:\\temp\\transcript-paths'

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

  const summary = event.result
    ? String(event.result).slice(0, 300)
    : 'Task finished'

  await postTerminalEvent({
    session_id: event.session_id,
    event_type: 'stop',
    tool_name:  null,
    summary,
    detail:     null,
    status:     'success',
  }).catch(() => {})

  // Session ended — drop the transcript mapping so heartbeat stops tailing it
  if (event.session_id) {
    try { unlinkSync(join(TRANSCRIPT_DIR, `${event.session_id}.path`)) } catch {}
  }

  process.exit(0)
}

main().catch(() => process.exit(0))
