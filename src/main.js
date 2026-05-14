import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import started from 'electron-squirrel-startup';

if (started) app.quit();

// In dev: __dirname = .vite/build/ → go up two levels to project root
// In production: relay-deamon1 is in resources/ via extraResource
const RELAY_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'relay-deamon1')
  : path.join(__dirname, '..', '..', 'relay-deamon1');

const RELAY_ENV = path.join(RELAY_ROOT, '.env');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const ALLOW_ALL_FILE = 'C:\\temp\\relay-allow-all.txt';

// Built at runtime so the hook command always uses the current absolute path
function buildHookBlock() {
  const hookCmd = `node "${path.join(RELAY_ROOT, 'hook-wrapper.cjs')}"`;
  return {
    PreToolUse: [{
      matcher: 'Bash|Write|Edit|MultiEdit',
      hooks: [{ type: 'command', command: hookCmd }],
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

// If the hook is already enabled, refresh its command path to the current install location.
// This fixes the path after a Squirrel version-directory change (app-1.0.0 → app-1.0.1).
function refreshHookPathIfEnabled() {
  const settings = readSettings();
  if (settings.hooks?.PreToolUse) {
    settings.hooks = buildHookBlock();
    writeSettings(settings);
  }
}

// ── Relay IPC ─────────────────────────────────────────────────────────────────
ipcMain.handle('relay:getMachineConfig', () => {
  if (!existsSync(RELAY_ENV)) return null;
  const env = parseEnv(readFileSync(RELAY_ENV, 'utf8'));
  if (!env.MACHINE_ID) return null;
  return {
    machineId: env.MACHINE_ID,
    machineLabel: env.MACHINE_LABEL || '',
    machineApiKey: env.MACHINE_API_KEY || '',
    userId: env.USER_ID || '',
    supabaseUrl: env.SUPABASE_URL || '',
  };
});

ipcMain.handle('relay:writeMachineConfig', (_, vars) => {
  let existing = {};
  if (existsSync(RELAY_ENV)) {
    existing = parseEnv(readFileSync(RELAY_ENV, 'utf8'));
  }
  const merged = { ...existing, ...vars };
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  writeFileSync(RELAY_ENV, lines.join('\n') + '\n', 'utf8');
});

ipcMain.handle('relay:getHookStatus', () => {
  const s = readSettings();
  return !!(s.hooks && s.hooks.PreToolUse);
});

ipcMain.handle('relay:setHookEnabled', (_, enable) => {
  const settings = readSettings();
  if (enable) {
    settings.hooks = buildHookBlock();
  } else {
    delete settings.hooks;
    try { unlinkSync(ALLOW_ALL_FILE); } catch {}
  }
  writeSettings(settings);
  return true;
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
  refreshHookPathIfEnabled();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
