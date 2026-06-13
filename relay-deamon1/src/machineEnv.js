/**
 * machineEnv.js — resolves WHERE the machine credentials (.env) live.
 *
 * The credentials must survive app reinstalls and Squirrel version updates. The
 * bundled `relay-deamon1/.env` does NOT: forge's postPackage strips it, and every
 * (re)install replaces the whole versioned app dir. So machine identity is stored
 * in Electron's userData dir (%APPDATA%\my-app on Windows), which Squirrel never
 * touches. Losing it was forcing a re-registration (reclaim) — and a new API key —
 * on every reinstall, which broke the OpenCode plugin's copied key.
 *
 * Resolution order:
 *   1. $VIBE_MACHINE_ENV         — explicit path passed by main.js to spawned procs
 *   2. <userData>/machine.env    — the stable location (survives reinstalls)
 *   3. relay-deamon1/.env        — legacy/bundled fallback (first run, pre-migration)
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dir = path.dirname(fileURLToPath(import.meta.url))

// relay-deamon1/.env — src/ is one level under the daemon root
const LEGACY_ENV = path.join(__dir, '..', '.env')

// Electron userData dir. app.getName() === 'my-app' (package.json productName),
// so userData === %APPDATA%\my-app on Windows. Keep in sync if productName changes.
const APP_NAME = 'my-app'
export const STABLE_MACHINE_ENV = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', APP_NAME, 'machine.env')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', APP_NAME, 'machine.env')
    : path.join(os.homedir(), '.config', APP_NAME, 'machine.env')

export function machineEnvFile() {
  if (process.env.VIBE_MACHINE_ENV) return process.env.VIBE_MACHINE_ENV
  if (fs.existsSync(STABLE_MACHINE_ENV)) return STABLE_MACHINE_ENV
  return LEGACY_ENV
}
