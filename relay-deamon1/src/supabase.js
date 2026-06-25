import { createClient } from '@supabase/supabase-js'
import { config }        from './config.js'

// Anon client — used only for Realtime subscriptions (read-only)
export const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth:     { persistSession: false },
  realtime: { params: { eventsPerSecond: 10 } },
})

// ── VPS API helpers ───────────────────────────────────────────────────────────
// All writes go through the VPS backend. The service key never lives on this machine.

async function apiPost(path, body) {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type':       'application/json',
      'x-machine-api-key':  config.machineApiKey,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.status)
    throw new Error(`VPS ${path} failed: ${text}`)
  }
  return res.json()
}

async function apiGet(path) {
  const res = await fetch(`${config.apiUrl}${path}`, {
    headers: { 'x-machine-api-key': config.machineApiKey },
  })
  if (!res.ok) return null
  return res.json()
}

// ── Upsert agent/session row ──────────────────────────────────────────────────
export async function agentPing(sessionId, cwd, toolName) {
  return apiPost('/relay/agent-ping', { sessionId, cwd, toolName })
}

// ── Fetch next pending mobile command (idle-gated on server) ─────────────────
// Pass a sessionId to scope the claim to that session — the desktop does this when it
// knows that CLI is idle. command/next atomically marks the row delivered, so we must
// only claim what we can inject right now. See FAST_PROMPT_DELIVERY_DESIGN.md.
export async function getNextCommand(sessionId) {
  const qs = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
  return apiGet(`/mobile/command/next${qs}`)
}

// ── File tree ─────────────────────────────────────────────────────────────────
export async function getPendingFsRequest() {
  return apiGet('/machines/fs/pending')
}

export async function respondFsRequest(requestId, treeOrError) {
  return apiPost('/machines/fs/respond', { requestId, ...treeOrError })
}

// ── Upload a pending request row ──────────────────────────────────────────────
export async function uploadRequest(row) {
  return apiPost('/relay/upload', { payload: row })
}

// ── Mark a request decided — used when PC terminal responds first ─────────────
export async function markDecided(requestId, status, decidedBy = null) {
  return apiPost('/relay/decide', { requestId, decision: status })
}

// ── Update machine heartbeat ──────────────────────────────────────────────────
export async function heartbeat() {
  return apiPost('/machines/heartbeat', {})
}

// ── Report which session CLIs are still alive on this machine ─────────────────
export async function reportSessionsAlive(aliveSessionIds) {
  return apiPost('/relay/sessions-alive', { aliveSessionIds })
}

// ── Mark machine offline (called on clean shutdown) ───────────────────────────
export async function markOffline() {
  return apiPost('/machines/offline', {})
}

// ── Post a terminal lifecycle event (tool_start/tool_end/notification/stop) ──
export async function postTerminalEvent({ session_id, event_type, tool_name, summary, detail, status }) {
  return apiPost('/relay/terminal-event', { session_id, event_type, tool_name, summary, detail, status })
}

// ── Block until someone approves / denies, or timeout ────────────────────────
// Returns { decision: 'approved'|'denied'|'timeout', decidedBy: 'pc'|'mobile'|null }
//
// Realtime is the fast path. Polling runs in parallel as a guaranteed fallback
// because Supabase Realtime can silently drop events (RLS on anon key, replication
// not enabled on the table, transient WebSocket issues) without ever emitting
// CHANNEL_ERROR — meaning the old "poll only on error" approach never triggered.
export function waitForDecision(requestId) {
  return new Promise((resolve) => {
    let settled    = false
    let pollInterval = null

    function finish(decision, decidedBy = null) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(pollInterval)
      try { channel.unsubscribe() } catch {}
      resolve({ decision, decidedBy })
    }

    const timer = setTimeout(() => finish('timeout', null), config.timeoutMs)

    // Realtime — fast path, fires immediately when the event is delivered
    const channel = supabase
      .channel('decision:' + requestId)
      .on(
        'postgres_changes',
        {
          event:  'UPDATE',
          schema: 'public',
          table:  'pending_requests',
          filter: `id=eq.${requestId}`,
        },
        (payload) => {
          const status    = payload.new?.status
          const decidedBy = payload.new?.decided_by || 'mobile'
          if (status === 'approved' || status === 'denied') {
            finish(status, decidedBy)
          }
        },
      )
      .subscribe()

    // Polling — reconnect backstop only. Realtime above is the primary path and
    // lands the decision in <1s on a healthy socket; this 25s poll just covers a
    // silently-dropped WebSocket. (Was 3s — that hammered the API for no benefit
    // while Realtime was working.)
    pollInterval = setInterval(async () => {
      try {
        const res = await fetch(
          `${config.apiUrl}/relay/status/${requestId}`,
          { headers: { 'x-machine-api-key': config.machineApiKey } }
        )
        if (!res.ok) return
        const data = await res.json()
        if (data?.status === 'approved' || data?.status === 'denied') {
          finish(data.status, data.decided_by || 'mobile')
        }
      } catch {}
    }, 25_000)
  })
}

// ── Block until the user picks an option for a question request, or timeout ───
// Sibling to waitForDecision, for kind='question' rows. Resolves when the row's
// status flips to 'answered' (carrying selected_options), or when the PC terminal
// drops a local signal file (relay.cjs answer <n>). Returns:
//   { selected_options: [...] }  — the picked option(s)
//   { timeout: true }            — no answer within config.timeoutMs
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs'
import { join }                                            from 'path'

const QUESTION_PENDING_DIR = 'C:\\temp\\relay-pending'

export function waitForAnswer(requestId) {
  return new Promise((resolve) => {
    let settled = false, pollInterval = null, filePoll = null
    const answerFile = join(QUESTION_PENDING_DIR, `${requestId}.answer.json`)

    function finish(payload) {
      if (settled) return
      settled = true
      clearTimeout(timer); clearInterval(pollInterval); clearInterval(filePoll)
      try { channel.unsubscribe() } catch {}
      try { unlinkSync(answerFile) } catch {}
      resolve(payload)
    }

    const timer = setTimeout(() => finish({ timeout: true }), config.timeoutMs)

    // Realtime — fast path: the row flips to status='answered'.
    const channel = supabase
      .channel('decision:' + requestId)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'pending_requests', filter: `id=eq.${requestId}` },
        (payload) => {
          if (payload.new?.status === 'answered') {
            finish({ selected_options: payload.new.selected_options })
          }
        })
      .subscribe()

    // Backstop poll — covers a silently-dropped WebSocket. /relay/status now
    // returns selected_options (server migration 011 + route change).
    pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${config.apiUrl}/relay/status/${requestId}`,
          { headers: { 'x-machine-api-key': config.machineApiKey } })
        if (!res.ok) return
        const data = await res.json()
        if (data?.status === 'answered') finish({ selected_options: data.selected_options })
      } catch {}
    }, 25_000)

    // Local terminal fallback — relay.cjs writes {id}.answer.json (selected_options).
    try {
      mkdirSync(QUESTION_PENDING_DIR, { recursive: true })
      filePoll = setInterval(() => {
        try {
          if (!existsSync(answerFile)) return
          const parsed = JSON.parse(readFileSync(answerFile, 'utf8'))
          finish({ selected_options: parsed.selected_options ?? parsed })
        } catch {}
      }, 150)
    } catch {}
  })
}
