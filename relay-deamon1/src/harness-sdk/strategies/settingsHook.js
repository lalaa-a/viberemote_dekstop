/**
 * SettingsHookStrategy — for harnesses that gate tools via a JSON settings file
 * and exit-code hook scripts (Claude Code).
 *
 * This strategy only owns install/remove/status of the hook block. The per-tool
 * approval runtime stays in the proven external scripts (hook.js + *-wrapper.cjs),
 * which talk to the VPS via transport on their own — exactly as before. That is
 * why the Claude Code adapter declares approvalMechanism: 'hook' (out-of-process).
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'

/**
 * @param {object} cfg
 * @param {string}   cfg.settingsFile  absolute path to e.g. ~/.claude/settings.json
 * @param {Function} cfg.buildHookBlock () => hooks object written under settings.hooks
 * @param {string[]} cfg.allowList      permissions.allow entries to add in mobile mode
 * @param {string}   [cfg.allowAllFile] optional temp flag file cleared on disable
 */
export function settingsHookStrategy(cfg) {
  const { settingsFile, buildHookBlock, allowList = [], allowAllFile } = cfg

  const read = () => {
    try { return JSON.parse(readFileSync(settingsFile, 'utf8')) } catch { return {} }
  }
  const write = (o) => writeFileSync(settingsFile, JSON.stringify(o, null, 2) + '\n', 'utf8')

  return {
    async enable() {
      const s = read()
      s.hooks = buildHookBlock()
      if (allowList.length) {
        s.permissions ??= {}
        s.permissions.allow ??= []
        for (const t of allowList) if (!s.permissions.allow.includes(t)) s.permissions.allow.push(t)
      }
      write(s)
    },

    async disable() {
      const s = read()
      delete s.hooks
      if (s.permissions?.allow) {
        s.permissions.allow = s.permissions.allow.filter((t) => !allowList.includes(t))
        if (!s.permissions.allow.length) delete s.permissions.allow
        if (s.permissions && !Object.keys(s.permissions).length) delete s.permissions
      }
      write(s)
      if (allowAllFile) { try { unlinkSync(allowAllFile) } catch {} }
    },

    async status() {
      const s = read()
      return { enabled: !!(s.hooks && s.hooks.PreToolUse) }
    },

    /**
     * Re-write the hook block in place if it is currently enabled. Used after an
     * install-path change (Squirrel version dir) so the wrapper paths stay valid.
     */
    async refreshIfEnabled() {
      const s = read()
      if (s.hooks?.PreToolUse) { await this.enable() }
    },
  }
}
