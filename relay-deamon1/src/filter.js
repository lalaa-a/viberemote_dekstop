import { config } from './config.js'

// Returns 'allow' | 'block' | 'ask'
export function preFilter(toolName, toolInput) {

  const target = getTarget(toolName, toolInput)

  // ─── Always block list (checked first) ───────────────────────────────────
  if (config.alwaysBlock.length) {
    for (const pattern of config.alwaysBlock) {
      try {
        if (new RegExp(pattern).test(target)) {
          return { action: 'block', reason: `Matched always-block rule: ${pattern}` }
        }
      } catch {}
    }
  }

  // ─── Always allow list ────────────────────────────────────────────────────
  if (config.alwaysAllow.length) {
    for (const pattern of config.alwaysAllow) {
      try {
        if (new RegExp(pattern).test(target)) {
          return { action: 'allow', reason: `Matched always-allow rule: ${pattern}` }
        }
      } catch {}
    }
  }

  // ─── Default: ask mobile ──────────────────────────────────────────────────
  return { action: 'ask', reason: null }
}

function getTarget(toolName, toolInput) {
  if (toolName === 'Bash')      return toolInput.command || ''
  if (toolName === 'Write')     return toolInput.file_path || toolInput.path || ''
  if (toolName === 'Edit')      return toolInput.file_path || toolInput.path || ''
  if (toolName === 'Read')      return toolInput.file_path || toolInput.path || ''
  if (toolName === 'MultiEdit') {
    return (toolInput.edits || []).map(e => e.file_path || e.path || '').join('\n')
  }
  return JSON.stringify(toolInput)
}
