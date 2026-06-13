import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, createWriteStream } from 'node:fs';
import os from 'node:os';
import started from 'electron-squirrel-startup';

if (started) app.quit();

// In dev: __dirname = .vite/build/ → go up two levels to project root
// In production: relay-deamon1 is in resources/ via extraResource
const RELAY_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'relay-deamon1')
  : path.join(__dirname, '..', '..', 'relay-deamon1');

// Machine credentials live in the STABLE userData dir (%APPDATA%\my-app), NOT in
// the versioned app resources — otherwise every reinstall / Squirrel update wipes
// them (forge postPackage strips the bundled .env), forcing a re-registration and
// a fresh API key on each update. userData survives reinstalls.
const RELAY_ENV       = path.join(app.getPath('userData'), 'machine.env');
const LEGACY_RELAY_ENV = path.join(RELAY_ROOT, '.env');   // pre-1.2 location, for migration
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const ALLOW_ALL_FILE  = 'C:\\temp\\relay-allow-all.txt';

// One-time migration: if the old bundled .env exists but the stable one doesn't,
// move the machine identity to userData so we never re-register on this machine.
function migrateMachineEnv() {
  try {
    if (!existsSync(RELAY_ENV) && existsSync(LEGACY_RELAY_ENV)) {
      mkdirSync(path.dirname(RELAY_ENV), { recursive: true });
      writeFileSync(RELAY_ENV, readFileSync(LEGACY_RELAY_ENV, 'utf8'), 'utf8');
      console.log('[machine-env] migrated credentials to', RELAY_ENV);
    }
  } catch (err) {
    console.error('[machine-env] migration failed:', err.message);
  }
}

// ── Harness platform bridge ───────────────────────────────────────────────────
// All multi-harness logic lives in the daemon (relay-deamon1) behind a small CLI
// so the registry never has to be bundled into the Vite build. main.js shells out
// to it — the same pattern already used for the heartbeat. See
// HARNESS_PLATFORM_ARCHITECTURE.md and relay-deamon1/harness-cli.js.
const HARNESS_CLI = path.join(RELAY_ROOT, 'harness-cli.js');
let harnessDesiredTimer = null;

function runHarnessCli(args) {
  return new Promise((resolve, reject) => {
    execFile('node', [HARNESS_CLI, ...args],
      { cwd: RELAY_ROOT, windowsHide: true, timeout: 30000, env: { ...process.env, VIBE_MACHINE_ENV: RELAY_ENV } },
      (err, stdout) => {
        const text = (stdout || '').toString().trim();
        if (!text) return reject(err || new Error('harness-cli produced no output'));
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error('harness-cli bad output: ' + text.slice(0, 300))); }
      });
  });
}

// Built at runtime so the hook command always uses the current absolute path
function buildHookBlock() {
  const wrap = (name) => `node "${path.join(RELAY_ROOT, name)}"`;
  return {
    PreToolUse: [{
      matcher: 'Bash|Write|Edit|MultiEdit|Read',
      hooks: [{ type: 'command', command: wrap('hook-wrapper.cjs') }],
    }],
    PostToolUse: [{
      matcher: 'Bash|Write|Edit|MultiEdit|Read',
      hooks: [{ type: 'command', command: wrap('postHook-wrapper.cjs') }],
    }],
    Notification: [{
      hooks: [{ type: 'command', command: wrap('notifyHook-wrapper.cjs') }],
    }],
    Stop: [{
      hooks: [{ type: 'command', command: wrap('stopHook-wrapper.cjs') }],
    }],
  };
}

function parseEnv(raw) {
  const env = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

function readSettings() {
  try { return JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch { return {}; }
}

function writeSettings(obj) {
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// Tools whose interactive prompts are suppressed when mobile mode is active.
// The hook is the sole gatekeeper — it exits 0 (allow) or 2 (deny).
// Without this, Claude Code's own "Allow? [y/n]" prompt appears alongside the
// hook and keeps waiting for keyboard input even after mobile approves.
const HOOK_TOOLS_ALLOW = ['Bash(*)', 'Write(*)', 'Edit(*)', 'MultiEdit(*)', 'Read(*)'];

function applyMobilePermissions(settings) {
  if (!settings.permissions)       settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];
  for (const tool of HOOK_TOOLS_ALLOW) {
    if (!settings.permissions.allow.includes(tool)) {
      settings.permissions.allow.push(tool);
    }
  }
}

function removeMobilePermissions(settings) {
  if (!settings.permissions?.allow) return;
  settings.permissions.allow = settings.permissions.allow.filter(
    t => !HOOK_TOOLS_ALLOW.includes(t)
  );
  if (!settings.permissions.allow.length)        delete settings.permissions.allow;
  if (!Object.keys(settings.permissions).length) delete settings.permissions;
}

// If the hook is already enabled, refresh its command path to the current install location.
// This fixes the path after a Squirrel version-directory change (app-1.0.0 → app-1.0.1).
// Also ensures permissions.allow is in sync so the double-approval bug stays fixed.
function refreshHookPathIfEnabled() {
  const settings = readSettings();
  if (settings.hooks?.PreToolUse) {
    settings.hooks = buildHookBlock();
    applyMobilePermissions(settings);
    writeSettings(settings);
  }
}

// ── Heartbeat auto-management ─────────────────────────────────────────────────
// The heartbeat is a long-running Node process that:
//   • pings /machines/heartbeat every 30s (keeps machine online)
//   • polls /mobile/command/next every 10s (delivers mobile prompts to claude)
//   • polls /machines/fs/pending every 5s  (serves file-tree requests)
// It must run as long as the desktop app is open.

let heartbeatProc  = null;
let heartbeatAlive = true;   // set false on app quit to stop restart loop

function startHeartbeat() {
  // Only start if the machine is configured (relay .env exists with credentials)
  if (!existsSync(RELAY_ENV)) return;
  if (heartbeatProc) return;

  const script = path.join(RELAY_ROOT, 'scripts', 'heartbeat.js');
  if (!existsSync(script)) return;

  // Pipe all heartbeat output to a log file — critical for debugging
  // because the logger writes to stderr which is normally invisible from Electron
  try { mkdirSync('C:\\temp', { recursive: true }); } catch {}
  const logStream = createWriteStream('C:\\temp\\heartbeat.log', { flags: 'a' });
  logStream.write(`\n--- heartbeat started ${new Date().toISOString()} ---\n`);

  heartbeatProc = spawn('node', [script], {
    cwd:   RELAY_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env:   { ...process.env, VIBE_MACHINE_ENV: RELAY_ENV },
  });

  heartbeatProc.stdout.pipe(logStream);
  heartbeatProc.stderr.pipe(logStream);

  heartbeatProc.on('error', (err) => {
    console.error('[heartbeat] spawn error:', err.message);
    logStream.write(`[ERROR] spawn failed: ${err.message}\n`);
    heartbeatProc = null;
  });

  heartbeatProc.on('exit', (code) => {
    console.log(`[heartbeat] exited (code ${code})`);
    heartbeatProc = null;
    // Auto-restart after 5s unless the app is quitting
    if (heartbeatAlive) {
      setTimeout(startHeartbeat, 5000);
    }
  });

  console.log('[heartbeat] started');
}

function stopHeartbeat() {
  heartbeatAlive = false;
  if (heartbeatProc) {
    heartbeatProc.kill();
    heartbeatProc = null;
  }
}

// ── Relay IPC ─────────────────────────────────────────────────────────────────
ipcMain.handle('relay:getMachineConfig', () => {
  if (!existsSync(RELAY_ENV)) return null;
  const env = parseEnv(readFileSync(RELAY_ENV, 'utf8'));
  if (!env.MACHINE_ID) return null;
  return {
    machineId:     env.MACHINE_ID,
    machineLabel:  env.MACHINE_LABEL  || '',
    machineApiKey: env.MACHINE_API_KEY || '',
    userId:        env.USER_ID         || '',
    supabaseUrl:   env.SUPABASE_URL    || '',
  };
});

ipcMain.handle('relay:writeMachineConfig', (_, vars) => {
  let existing = {};
  if (existsSync(RELAY_ENV)) {
    existing = parseEnv(readFileSync(RELAY_ENV, 'utf8'));
  }
  const merged = { ...existing, ...vars };
  const lines  = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  writeFileSync(RELAY_ENV, lines.join('\n') + '\n', 'utf8');

  // Machine was just registered for the first time — start the heartbeat now
  startHeartbeat();
});

ipcMain.handle('relay:getHookStatus', () => {
  const s = readSettings();
  return !!(s.hooks && s.hooks.PreToolUse);
});

ipcMain.handle('relay:setHookEnabled', (_, enable) => {
  const settings = readSettings();
  if (enable) {
    settings.hooks = buildHookBlock();
    applyMobilePermissions(settings);
  } else {
    delete settings.hooks;
    removeMobilePermissions(settings);
    try { unlinkSync(ALLOW_ALL_FILE); } catch {}
  }
  writeSettings(settings);
  return true;
});

// ── Harness IPC (multi-harness) ───────────────────────────────────────────────
// These supersede the single relay:getHookStatus/setHookEnabled toggle above,
// which is kept as a backward-compatible shim for the Claude-Code-only path.
ipcMain.handle('harness:list', async () => {
  try {
    const r = await runHarnessCli(['list']);
    return r.harnesses || [];
  } catch (err) {
    console.error('[harness:list]', err.message);
    return [];
  }
});

ipcMain.handle('harness:setMobile', async (_, { harness, enable }) => {
  const r = await runHarnessCli([enable ? 'enable' : 'disable', harness]);
  if (!r.ok) throw new Error(r.error || 'Harness toggle failed');
  return r.mobile_enabled;
});

// ── System IPC ────────────────────────────────────────────────────────────────
ipcMain.handle('system:getHostname', () => os.hostname());

// ── Window control IPC ────────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
ipcMain.on('window:maximize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('window:close', () => BrowserWindow.getFocusedWindow()?.close());

ipcMain.handle('window:isMaximized', () => {
  return BrowserWindow.getFocusedWindow()?.isMaximized() ?? false;
});

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 550,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0a0b10',
  });

  mainWindow.on('maximize', () =>
    mainWindow.webContents.send('window:maximizeChange', true)
  );
  mainWindow.on('unmaximize', () =>
    mainWindow.webContents.send('window:maximizeChange', false)
  );

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
};

app.whenReady().then(() => {
  migrateMachineEnv();        // ← move credentials to userData before anything reads them
  refreshHookPathIfEnabled();
  startHeartbeat();           // ← auto-start on launch if .env already exists

  // Publish this machine's harness inventory to the VPS so the phone sees which
  // harnesses exist and their mobile state. Safe no-op if the machine isn't
  // registered yet (CLI swallows the offline error).
  if (existsSync(RELAY_ENV)) {
    runHarnessCli(['report']).catch(() => {});
    // Apply any phone-requested toggles every 15s (optional remote control).
    harnessDesiredTimer = setInterval(() => {
      runHarnessCli(['apply-desired']).catch(() => {});
    }, 15000);
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  stopHeartbeat();
  if (harnessDesiredTimer) { clearInterval(harnessDesiredTimer); harnessDesiredTimer = null; }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
