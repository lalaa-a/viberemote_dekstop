/**
 * PtyProxyStrategy — the UNIVERSAL FALLBACK for interactive CLIs that expose no
 * hook or plugin system (Gemini CLI, Pi, etc.).
 *
 * Wrap the real CLI in a pseudo-terminal, stream stdout as narrative, detect
 * approval prompts via a per-harness `grammar`, pause, ask the phone, then write
 * the answer keystroke back into the PTY.
 *
 * SECURITY: pattern matching is best-effort, so this strategy fails CLOSED — on
 * timeout/uncertainty it sends the DENY key, never approve. Surfaced to the UI via
 * capabilities.approvalMechanism === 'pty-proxy'.
 *
 * NOTE: requires the optional `node-pty` dependency. It is loaded lazily so that
 * harnesses NOT using this strategy (Claude Code, OpenCode) never need it
 * installed. If node-pty is absent, spawn() throws a clear, actionable error.
 */
import { uploadRequest, pollDecision, postNarrative } from '../transport.js'
import { normalizeRequest, validateRequest, normalizeNarrative } from '../schema.js'

async function loadPty() {
  try {
    const mod = await import('node-pty')
    return mod.default ?? mod
  } catch {
    throw new Error(
      'PtyProxyStrategy requires the "node-pty" package. Run `npm i node-pty` in relay-deamon1.'
    )
  }
}

/**
 * @param {object}   cfg
 * @param {string}   cfg.harnessId
 * @param {string}   cfg.command           CLI to wrap, e.g. 'gemini'
 * @param {string[]} [cfg.args=[]]
 * @param {object}   cfg.grammar           { detect(buffer) -> {matched, summary, command?, answers:{approve, deny}} | null }
 * @param {Function} [cfg.mapPromptToRequest] (hit) -> partial RelayRequest
 * @param {boolean}  [cfg.failOpen=false]  PTY defaults fail-CLOSED
 */
export function ptyProxyStrategy(cfg) {
  const {
    harnessId, command, args = [], grammar,
    mapPromptToRequest = defaultMap, failOpen = false,
  } = cfg

  return {
    /**
     * Launch the wrapped CLI. Returns a handle for prompt injection + teardown.
     * The desktop's `vibe run <harness>` shim (or the dashboard) calls this.
     */
    async spawn(cwd, { sessionId = null } = {}) {
      const pty = await loadPty()
      const term = pty.spawn(command, args, {
        name: 'xterm-color', cols: 120, rows: 30, cwd, env: process.env,
      })

      let buf = ''
      let gating = false

      term.onData(async (chunk) => {
        process.stdout.write(chunk)                       // user still sees their terminal
        postNarrative(normalizeNarrative({
          session_id: sessionId, harness: harnessId, event_type: 'output',
          summary: String(chunk).slice(0, 2000),
        })).catch(() => {})

        if (gating) return
        buf += chunk
        if (buf.length > 8000) buf = buf.slice(-8000)      // bound the scan window

        const hit = grammar?.detect?.(buf)
        if (hit?.matched) {
          gating = true
          buf = ''
          try {
            const row = normalizeRequest({
              ...mapPromptToRequest(hit), harness: harnessId, session_id: sessionId,
            })
            validateRequest(row)
            const id = await uploadRequest(row)
            const decision = await pollDecision(id, { failOpen })   // fail-closed by default
            term.write(decision === 'approved' ? hit.answers.approve : hit.answers.deny)
          } catch (err) {
            term.write(hit.answers.deny)                   // any error → deny
            postNarrative(normalizeNarrative({
              session_id: sessionId, harness: harnessId, event_type: 'output',
              summary: `[vibe] approval error, denied: ${err.message}`,
            })).catch(() => {})
          } finally {
            gating = false
          }
        }
      })

      return {
        inject: (text) => term.write(text.endsWith('\r') ? text : text + '\r'),
        write:  (data) => term.write(data),
        stop:   () => { try { term.kill() } catch {} },
        pid:    term.pid,
      }
    },
  }
}

function defaultMap(hit) {
  return {
    tool_name: 'bash',
    display_type: 'command',
    summary: hit.summary || 'command',
    command: hit.command || hit.summary || null,
    risk: { level: 'medium', reason: 'pattern-detected command', icon: '🔶' },
  }
}
