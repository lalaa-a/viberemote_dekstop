# relay-daemon — Production Guide

Full roadmap to ship this as a polished product: Windows tray app, iOS mobile app,
QR-based device pairing, push notifications, and a production-grade backend.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Backend — Supabase Schema & Edge Functions](#2-backend--supabase-schema--edge-functions)
3. [Supabase Free → Production (+ Alternatives)](#3-supabase-free--production--alternatives)
4. [Windows App — Electron System Tray](#4-windows-app--electron-system-tray)
5. [iOS App — React Native / Expo](#5-ios-app--react-native--expo)
6. [QR Pairing Flow — End to End](#6-qr-pairing-flow--end-to-end)
7. [Push Notifications](#7-push-notifications)
8. [Security Hardening](#8-security-hardening)
9. [Distribution & Auto-Updates](#9-distribution--auto-updates)
10. [Cost Breakdown](#10-cost-breakdown)
11. [Build Phases & Timeline](#11-build-phases--timeline)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        USER'S WINDOWS PC                             │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Electron App (System Tray)                                    │  │
│  │  ├── hook.js         ← intercepts Claude Code tool calls       │  │
│  │  ├── heartbeat.js    ← pings Supabase every 30s                │  │
│  │  ├── Tray icon       ← green=online, red=offline               │  │
│  │  └── QR window       ← shown on first launch / re-pair        │  │
│  └──────────────────────────────┬─────────────────────────────────┘  │
│                                 │ HTTPS / WebSocket                  │
└─────────────────────────────────┼────────────────────────────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │       SUPABASE (or alt)     │
                    │                             │
                    │  auth.users                 │
                    │  machines          ←────────┼── Edge Fn: register-machine
                    │  agents                     │
                    │  pending_requests  ─────────┼── Edge Fn: notify-mobile
                    │  push_tokens                │
                    │                             │
                    │  Realtime (WebSocket)        │
                    │  Edge Functions (Deno)       │
                    └──────┬───────────┬──────────┘
                           │           │
              WebSocket    │           │  HTTPS Push
              (realtime)   │           │  (APNs via Expo)
                           │           │
              ┌────────────▼─┐   ┌─────▼──────────┐
              │  iOS App     │   │  Expo Push API  │
              │  (React      │   │  (or FCM)       │
              │   Native)    │   └─────────────────┘
              │              │
              │  QR scanner  │
              │  Request list│
              │  Approve/    │
              │  Deny        │
              └──────────────┘
```

### Data flow for one approval

```
1. Claude Code fires PreToolUse hook
2. hook.js parses + risk-assesses the event
3. hook.js inserts row into pending_requests (via Edge Fn, no service key on disk)
4. Edge Fn sends push notification to user's iPhone
5. User taps notification → iOS app opens
6. iOS app shows diff / command / risk level
7. User taps Approve or Deny
8. iOS app updates pending_requests.status via Supabase SDK (RLS-protected)
9. Supabase Realtime fires UPDATE event → hook.js receives it in ~50ms
10. hook.js exits with code 0 (allow) or 2 (block)
11. Claude Code continues or stops
```

---

## 2. Backend — Supabase Schema & Edge Functions

### 2.1 Complete schema (use `database/schema.sql`)

The existing `database/schema.sql` is correct. One table is missing for production:

```sql
-- Add this to schema.sql
-- push_tokens: one row per mobile device per user
create table push_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  token       text not null unique,          -- Expo push token or APNs token
  platform    text not null default 'ios',   -- 'ios' | 'android'
  created_at  timestamptz default now(),
  last_used   timestamptz
);

create index idx_push_tokens_user on push_tokens(user_id);

alter table push_tokens enable row level security;

create policy "users own their push tokens"
  on push_tokens for all
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());
```

Also update `pending_requests` to add a `timeout` status (it's in the code's comments
but not in the schema's check constraint):

```sql
-- Safe to add to existing table
alter table pending_requests
  add constraint chk_status
  check (status in ('pending', 'approved', 'denied', 'timeout'));
```

### 2.2 Remove service key from user machines

**Current problem:** `setup.js` requires `SUPABASE_SERVICE_KEY` which is an admin-level
secret. Users should never have this.

**Fix:** Route all privileged writes through Edge Functions authenticated by user JWT.

### 2.3 Edge Function: `register-machine`

Creates `machines` row on behalf of the authenticated user. User's JWT is verified;
service key never leaves Supabase infrastructure.

```
supabase/functions/register-machine/index.ts
```

```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return new Response('Unauthorized', { status: 401 })

  // Verify user JWT with anon client
  const anon = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
  )
  const { data: { user }, error } = await anon.auth.getUser(jwt)
  if (error || !user) return new Response('Invalid token', { status: 401 })

  const { machineId, machineLabel, apiKeyHash } = await req.json()
  if (!machineId || !machineLabel || !apiKeyHash) {
    return new Response('Missing fields', { status: 400 })
  }

  // Use service client for the privileged insert
  const svc = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const { error: insertErr } = await svc.from('machines').insert({
    id:           machineId,
    user_id:      user.id,
    label:        machineLabel,
    api_key_hash: apiKeyHash,
    is_online:    true,
    last_seen:    new Date().toISOString(),
  })

  if (insertErr) {
    return new Response(
      JSON.stringify({ error: insertErr.message }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  return new Response(
    JSON.stringify({ ok: true, userId: user.id }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
```

### 2.4 Edge Function: `insert-request`

Called by the daemon instead of direct Supabase insert. Authenticates via
`MACHINE_API_KEY` — no user JWT needed at hook time.

```
supabase/functions/insert-request/index.ts
```

```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createHash } from 'https://deno.land/std/crypto/mod.ts'

Deno.serve(async (req) => {
  const apiKey    = req.headers.get('X-Machine-Key')
  const machineId = req.headers.get('X-Machine-Id')

  if (!apiKey || !machineId) return new Response('Unauthorized', { status: 401 })

  const svc = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Verify machine API key against stored hash
  const keyHash = await sha256(apiKey)
  const { data: machine } = await svc
    .from('machines')
    .select('id, user_id')
    .eq('id', machineId)
    .eq('api_key_hash', keyHash)
    .single()

  if (!machine) return new Response('Invalid machine credentials', { status: 401 })

  const row = await req.json()
  row.user_id    = machine.user_id    // enforce correct user_id server-side
  row.machine_id = machine.id

  const { data, error } = await svc
    .from('pending_requests')
    .insert(row)
    .select('id')
    .single()

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400 })

  // Fire push notification asynchronously (don't block the response)
  sendPushNotification(svc, machine.user_id, row).catch(console.error)

  return new Response(JSON.stringify({ id: data.id }), {
    headers: { 'Content-Type': 'application/json' },
  })
})

async function sha256(text: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(text)
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

async function sendPushNotification(svc: any, userId: string, row: any) {
  const { data: tokens } = await svc
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId)

  if (!tokens?.length) return

  const messages = tokens.map((t: any) => ({
    to:    t.token,
    sound: 'default',
    title: `${row.risk_icon} ${row.tool_name} — ${row.risk_level}`,
    body:  row.summary,
    data:  { requestId: row.id },
  }))

  await fetch('https://exp.host/--/api/v2/push/send', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(messages),
  })
}
```

### 2.5 Update `src/supabase.js` to use Edge Functions

Replace `uploadRequest` to call the edge function instead of direct insert:

```js
export async function uploadRequest(row) {
  const res = await fetch(`${config.supabaseUrl}/functions/v1/insert-request`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'X-Machine-Id':  config.machineId,
      'X-Machine-Key': config.machineApiKey,
    },
    body: JSON.stringify(row),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`insert-request failed: ${err}`)
  }
  return res.json()
}
```

Remove `SUPABASE_SERVICE_KEY` from `src/config.js` — it's no longer needed on the
user's machine.

### 2.6 Update RLS policies

With Edge Functions handling inserts, tighten RLS so the anon key can only
SELECT (for realtime + polling) and users can UPDATE their own requests
(approve/deny from mobile):

```sql
-- Drop old permissive policies
drop policy if exists "users own their requests" on pending_requests;
drop policy if exists "users own their machines" on machines;

-- pending_requests: SELECT and UPDATE only (inserts go via Edge Fn)
create policy "users read own requests"
  on pending_requests for select
  using (user_id = auth.uid());

create policy "users decide own requests"
  on pending_requests for update
  using  (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and status in ('approved', 'denied')  -- can only set terminal states
  );

-- machines: users can read their own; heartbeat updates go via Edge Fn
create policy "users read own machines"
  on machines for select
  using (user_id = auth.uid());
```

---

## 3. Supabase Free → Production (+ Alternatives)

### 3.1 Supabase Free plan limits

| Limit | Free | Pro ($25/mo) |
|-------|------|--------------|
| Database | 500 MB | 8 GB |
| Bandwidth | 2 GB/mo | 250 GB/mo |
| Realtime connections | 200 concurrent | 500 concurrent |
| Edge Functions | 500K calls/mo | 2M calls/mo |
| Auth users | 50,000 | 100,000 |
| Project pauses | After 1 week inactive | Never |
| Backups | None | Daily (7-day retention) |
| Custom domain | No | Yes |
| Support | Community | Email |

**Critical issue with free plan:** Projects pause after 1 week of inactivity.
This will break the daemon for any user who hasn't used it in a week.
**Upgrade to Pro before going public.**

### 3.2 When to upgrade

- **Development / testing:** Free plan is fine
- **Beta (< 50 users):** Free plan works but set up a keep-alive ping
- **Public launch:** Upgrade to Pro on day 1
- **Scale (> 1000 users):** Consider Pro + read replicas, or self-hosted

### 3.3 Upgrading Supabase

1. Go to `app.supabase.com` → your project → Settings → Billing
2. Upgrade to Pro
3. No migration needed — same project, same connection strings
4. Enable Point-in-Time Recovery (PITR) if you need it

### 3.4 Alternatives comparison

| Service | Best for | Free tier | Paid | Realtime | Auth | Notes |
|---------|----------|-----------|------|----------|------|-------|
| **Supabase Pro** | Current stack, easiest | 500MB, pauses | $25/mo | Postgres CDC | Yes | Stay here unless you have a reason to leave |
| **Firebase** | Mobile-first, Google | Generous, no pausing | Pay-as-you-go | Firestore listeners | Yes | Better mobile SDKs, FCM built-in for push |
| **PocketBase** | Self-hosting, low cost | Free (self-host) | Server cost only | SSE built-in | Yes | Single binary, SQLite, excellent for small teams |
| **Appwrite** | Open source Supabase alt | Cloud + self-host | $15+/mo cloud | Yes | Yes | More complex, less mature |
| **Neon + Ably** | Postgres + dedicated realtime | 3GB Neon, Ably free tier | $19+/mo combined | Via Ably | No (add Auth0) | More DIY, most flexible |
| **Railway** | Self-hosted Postgres | $5 credit | $5-20/mo | You build it | You build it | Full control, most complex |

### 3.5 Recommendation

**Stay on Supabase.** Here is why:

- Your existing code already uses it — zero migration cost
- Realtime CDC (Change Data Capture) on Postgres is exactly what this app needs
- Edge Functions run in the same infra as the DB — low latency for the push notification flow
- RLS handles all multi-tenant security without application code
- Auth is built in with magic links

**Only consider migrating if:**
- You hit 500+ concurrent realtime connections (very unlikely early on)
- Costs exceed $100/mo and you want to self-host PocketBase
- You need Android push (use Firebase then, FCM is free and universal)

### 3.6 Firebase as a serious alternative (if you want Android too)

Firebase has two key advantages for this use case:

1. **FCM (Firebase Cloud Messaging)** — free push notifications to both iOS and Android,
   no Expo dependency, direct APNs integration
2. **No project pausing** — Spark (free) plan never pauses

Migration cost: high. You would rewrite `src/supabase.js` to use Firebase SDK,
replace Postgres realtime with Firestore listeners, replace Supabase Auth with
Firebase Auth. Only do this if Android support is a hard requirement early.

---

## 4. Windows App — Electron System Tray

### 4.1 Why Electron

- Reuses 100% of existing Node.js daemon code
- System tray API built-in (`Tray` class)
- Can display QR code in a native window
- Auto-updater via `electron-updater`
- Ships as a standard `.exe` installer

Alternatives considered:
- **Tauri** — lighter but requires rewriting daemon in Rust or bridging
- **node-windows** — service only, no UI for QR/status
- **WPF/MAUI** — full rewrite in C#, not worth it

### 4.2 Project structure

```
relay-daemon/
├── electron/
│   ├── main.js          ← Electron main process
│   ├── preload.js       ← Context bridge for renderer
│   ├── tray.js          ← System tray logic
│   ├── qr-window.js     ← QR code popup window
│   └── icons/
│       ├── tray-online.png    (16x16, green dot)
│       ├── tray-offline.png   (16x16, red dot)
│       └── tray-pending.png   (16x16, orange dot)
├── renderer/
│   ├── qr.html          ← QR display page
│   └── qr.js            ← Renders QR using qrcode.js
├── src/                 ← existing daemon source (unchanged)
├── hook.js              ← unchanged
├── package.json         ← add Electron deps
└── forge.config.js      ← Electron Forge build config
```

### 4.3 `electron/main.js`

```js
const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path   = require('path')
const { createTray }    = require('./tray')
const { createQrWindow } = require('./qr-window')
const { fork }           = require('child_process')

let tray, qrWindow, daemonProcess

app.setLoginItemSettings({ openAtLogin: true })  // auto-start on Windows login

app.whenReady().then(async () => {
  // Hide dock icon on Windows (tray only)
  app.setAppUserModelId('com.yourname.relay-daemon')

  tray     = createTray(app, openQr)
  qrWindow = createQrWindow()

  // Start heartbeat as a child process
  daemonProcess = fork(path.join(__dirname, '../scripts/heartbeat.js'), [], {
    silent: true,
    env: { ...process.env },
  })

  // Show QR on first launch (no .env exists yet → setup mode)
  const { existsSync } = require('fs')
  const envPath = path.join(__dirname, '../.env')
  if (!existsSync(envPath)) {
    openSetup()
  }
})

function openQr() {
  qrWindow.show()
  qrWindow.focus()
}

function openSetup() {
  // Open setup flow in a BrowserWindow (magic link auth)
  const win = new BrowserWindow({
    width: 480, height: 640,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile('renderer/setup.html')
}

app.on('window-all-closed', (e) => e.preventDefault())  // keep tray alive

app.on('before-quit', () => {
  daemonProcess?.kill('SIGTERM')
})
```

### 4.4 `electron/tray.js`

```js
const { Tray, Menu, nativeImage } = require('electron')
const path = require('path')

module.exports.createTray = function(app, onShowQr) {
  const icons = {
    online:  nativeImage.createFromPath(path.join(__dirname, 'icons/tray-online.png')),
    offline: nativeImage.createFromPath(path.join(__dirname, 'icons/tray-offline.png')),
    pending: nativeImage.createFromPath(path.join(__dirname, 'icons/tray-pending.png')),
  }

  const tray = new Tray(icons.offline)
  tray.setToolTip('relay-daemon — offline')

  function setOnline()  { tray.setImage(icons.online);  tray.setToolTip('relay-daemon — online') }
  function setOffline() { tray.setImage(icons.offline); tray.setToolTip('relay-daemon — offline') }
  function setPending() { tray.setImage(icons.pending); tray.setToolTip('relay-daemon — waiting for approval') }

  const menu = Menu.buildFromTemplate([
    { label: 'relay-daemon', enabled: false },
    { type: 'separator' },
    { label: 'Show QR code (re-pair mobile)', click: onShowQr },
    { label: 'Open logs', click: () => {
      const { shell } = require('electron')
      shell.openPath('C:\\temp\\hook-debug.log')
    }},
    { type: 'separator' },
    { label: 'Enable mobile mode',  click: () => require('../relay.cjs')  },
    { label: 'Disable (CLI mode)',  click: () => require('../relay.cjs')  },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)

  // Export setters so heartbeat can update icon
  return { setOnline, setOffline, setPending }
}
```

### 4.5 QR window (`renderer/qr.html`)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Pair Mobile Device</title>
  <style>
    body { font-family: -apple-system, sans-serif; text-align: center;
           padding: 24px; background: #0f0f0f; color: #fff; }
    canvas { margin: 16px auto; display: block; }
    .label { font-size: 13px; color: #aaa; margin-top: 8px; }
    .machine { font-weight: 600; font-size: 15px; }
  </style>
</head>
<body>
  <p class="machine" id="label">Loading…</p>
  <canvas id="qr"></canvas>
  <p class="label">Open the relay app on your iPhone and scan this code</p>
  <script src="qr.js"></script>
</body>
</html>
```

```js
// renderer/qr.js
const QRCode = require('qrcode')

window.electronAPI.getQrPayload().then(payload => {
  document.getElementById('label').textContent = payload.label || 'My PC'
  QRCode.toCanvas(document.getElementById('qr'), JSON.stringify(payload), {
    width: 280, margin: 2,
    color: { dark: '#ffffff', light: '#0f0f0f' },
  })
})
```

### 4.6 `package.json` additions

```json
{
  "main": "electron/main.js",
  "scripts": {
    "electron":     "electron .",
    "electron:pack":"electron-forge make",
    "setup":        "node scripts/setup.js",
    "heartbeat":    "node scripts/heartbeat.js",
    "qr":           "node scripts/show-qr.js"
  },
  "devDependencies": {
    "@electron-forge/cli":            "^7.x",
    "@electron-forge/maker-squirrel": "^7.x",
    "@electron-forge/plugin-auto-unpack-natives": "^7.x",
    "electron": "^31.x"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.x",
    "diff":       "^5.x",
    "dotenv":     "^16.x",
    "qrcode":     "^1.x"
  }
}
```

### 4.7 Setup wizard (interactive auth inside Electron)

Replace the current CLI-only `scripts/setup.js` with a `renderer/setup.html` page
that handles the full flow visually:

1. User enters email in an HTML input
2. `supabase.auth.signInWithOtp({ email })` sends magic link
3. Show "Check your email" screen
4. Poll `supabase.auth.getSession()` every 2 seconds until user clicks link
5. On session received: generate machine creds, call `register-machine` edge function
6. Write `.env` via `ipcMain` (renderer can't write files directly)
7. Show QR code

---

## 5. iOS App — React Native / Expo

### 5.1 Why React Native / Expo

- JavaScript — overlaps with your existing skillset
- Expo handles push notifications, camera (QR scanner), and app signing
- Ships to both iOS and Android if you ever want Android
- Expo EAS Build handles App Store submission

### 5.2 Setup

```bash
npx create-expo-app relay-mobile --template blank-typescript
cd relay-mobile
npx expo install expo-camera expo-barcode-scanner
npx expo install expo-notifications
npx expo install @supabase/supabase-js
npx expo install @react-native-async-storage/async-storage
npx expo install expo-secure-store       # store connection credentials securely
```

### 5.3 App structure

```
relay-mobile/
├── app/
│   ├── (tabs)/
│   │   ├── index.tsx       ← pending requests list
│   │   └── machines.tsx    ← manage paired machines
│   ├── pair.tsx            ← QR scanner screen
│   ├── request/[id].tsx    ← request detail + approve/deny
│   └── _layout.tsx
├── lib/
│   ├── supabase.ts         ← Supabase client
│   ├── notifications.ts    ← push token registration
│   └── storage.ts          ← SecureStore wrappers
└── components/
    ├── DiffViewer.tsx
    ├── RiskBadge.tsx
    └── RequestCard.tsx
```

### 5.4 `lib/supabase.ts`

```typescript
import { createClient } from '@supabase/supabase-js'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'

// Connection details are stored after QR scan
export async function getStoredConnection() {
  const raw = await SecureStore.getItemAsync('relay_connection')
  return raw ? JSON.parse(raw) : null
}

export async function saveConnection(payload: QrPayload) {
  await SecureStore.setItemAsync('relay_connection', JSON.stringify(payload))
}

export function buildClient(url: string, anonKey: string) {
  return createClient(url, anonKey, {
    auth: {
      storage:          AsyncStorage,
      autoRefreshToken: true,
      persistSession:   true,
      detectSessionInUrl: false,
    },
  })
}

export type QrPayload = {
  v:     number
  url:   string
  anon:  string
  uid:   string
  mid:   string
  label: string
}
```

### 5.5 QR Scanner screen (`app/pair.tsx`)

```typescript
import { CameraView, useCameraPermissions } from 'expo-camera'
import { saveConnection, QrPayload } from '../lib/supabase'
import { router } from 'expo-router'

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions()
  const [scanned, setScanned] = useState(false)

  async function handleScan({ data }: { data: string }) {
    if (scanned) return
    setScanned(true)
    try {
      const payload: QrPayload = JSON.parse(data)
      if (payload.v !== 1 || !payload.url || !payload.uid || !payload.mid) {
        Alert.alert('Invalid QR', 'This is not a relay-daemon pairing code.')
        setScanned(false)
        return
      }
      await saveConnection(payload)
      router.replace('/')   // go to requests list
    } catch {
      Alert.alert('Invalid QR', 'Could not read QR code.')
      setScanned(false)
    }
  }

  if (!permission?.granted) {
    return (
      <View style={styles.container}>
        <Text>Camera permission is required to scan the QR code.</Text>
        <Button title="Grant permission" onPress={requestPermission} />
      </View>
    )
  }

  return (
    <CameraView
      style={StyleSheet.absoluteFill}
      onBarcodeScanned={handleScan}
      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
    />
  )
}
```

### 5.6 Requests list (`app/(tabs)/index.tsx`)

```typescript
import { useEffect, useState } from 'react'
import { buildClient, getStoredConnection } from '../../lib/supabase'

export default function RequestsScreen() {
  const [requests, setRequests] = useState<any[]>([])
  const [client,   setClient  ] = useState<any>(null)

  useEffect(() => {
    getStoredConnection().then(conn => {
      if (!conn) return  // not paired yet
      const sb = buildClient(conn.url, conn.anon)
      setClient(sb)

      // Initial load
      sb.from('pending_requests')
        .select('*')
        .eq('user_id', conn.uid)
        .eq('machine_id', conn.mid)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .then(({ data }) => setRequests(data || []))

      // Realtime subscription — new requests appear instantly
      const channel = sb
        .channel('requests')
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'pending_requests',
          filter: `machine_id=eq.${conn.mid}`,
        }, payload => {
          setRequests(prev => [payload.new, ...prev])
        })
        .on('postgres_changes', {
          event: 'UPDATE', schema: 'public', table: 'pending_requests',
          filter: `machine_id=eq.${conn.mid}`,
        }, payload => {
          // Remove resolved requests from the list
          if (payload.new.status !== 'pending') {
            setRequests(prev => prev.filter(r => r.id !== payload.new.id))
          }
        })
        .subscribe()

      return () => sb.removeChannel(channel)
    })
  }, [])

  return (
    <FlatList
      data={requests}
      keyExtractor={item => item.id}
      renderItem={({ item }) => <RequestCard request={item} client={client} />}
      ListEmptyComponent={<Text style={styles.empty}>No pending requests</Text>}
    />
  )
}
```

### 5.7 Approve / Deny

```typescript
// Inside RequestCard or request/[id].tsx
async function decide(status: 'approved' | 'denied') {
  const { error } = await client
    .from('pending_requests')
    .update({
      status,
      decided_by: 'mobile',
      decided_at: new Date().toISOString(),
    })
    .eq('id', request.id)
    .eq('status', 'pending')   // guard against double-tap

  if (!error) {
    // Haptic feedback
    Haptics.notificationAsync(
      status === 'approved'
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Warning,
    )
  }
}
```

---

## 6. QR Pairing Flow — End to End

### 6.1 What the QR encodes

```json
{
  "v":     1,
  "url":   "https://xxxx.supabase.co",
  "anon":  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "uid":   "550e8400-e29b-41d4-a716-446655440000",
  "mid":   "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "label": "Dev PC"
}
```

**Security note:** The anon key is safe to put in a QR code. It is public-facing by
design — Supabase RLS ensures users can only read their own data. The service key
never leaves the Supabase infrastructure (it lives in Edge Function env vars).

### 6.2 QR generation in `scripts/show-qr.js`

```js
#!/usr/bin/env node
import QRCode from 'qrcode-terminal'
import { config } from '../src/config.js'

const payload = {
  v:     1,
  url:   config.supabaseUrl,
  anon:  config.supabaseKey,
  uid:   config.userId,
  mid:   config.machineId,
  label: config.machineLabel,
}

console.log('\n  Scan this with the relay mobile app:\n')
QRCode.generate(JSON.stringify(payload), { small: true })
console.log('\n  Or run  npm run qr  anytime to show again.\n')
```

### 6.3 Re-pair flow (machine already set up, new phone)

1. User runs `npm run qr` (or right-clicks tray icon → "Show QR code")
2. QR is displayed from existing `.env` — same `uid`, `mid`, same machine row
3. New phone scans QR, saves credentials to SecureStore
4. Done — no database changes needed for re-pair

### 6.4 Multi-machine support

Each machine has its own `mid`. The iOS app stores an array of connections
in SecureStore (keyed by `mid`). The requests list has a machine picker at the top.
Each machine subscribes to its own realtime channel filtered by `machine_id`.

---

## 7. Push Notifications

### 7.1 Why push notifications are necessary

iOS background restrictions prevent keeping a WebSocket open when the app is
not in the foreground. Without push:
- User must have the app open to see requests
- Requests time out while phone is in pocket

With push:
- User gets a notification like "⚠️ rm -rf — high risk — tap to review"
- Taps → app opens to that request
- Approves or denies in 2 seconds

### 7.2 Register push token (iOS app)

```typescript
// lib/notifications.ts
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'

export async function registerPushToken(supabase: any, userId: string) {
  if (!Device.isDevice) return  // simulator

  const { status } = await Notifications.requestPermissionsAsync()
  if (status !== 'granted') return

  const { data: token } = await Notifications.getExpoPushTokenAsync({
    projectId: 'your-expo-project-id',  // from app.json
  })

  await supabase.from('push_tokens').upsert(
    { user_id: userId, token, platform: 'ios' },
    { onConflict: 'token' },
  )
}
```

Call `registerPushToken` once after the user pairs (QR scanned successfully).
Also call it on app startup to refresh an expiring token.

### 7.3 Send push from Edge Function

The `insert-request` Edge Function (section 2.4) already calls `sendPushNotification`.
This sends to Expo's Push API which forwards to APNs.

For production, use Expo's batch endpoint (up to 100 messages per request):

```typescript
// In the Edge Function
const chunks = []
for (let i = 0; i < messages.length; i += 100) {
  chunks.push(messages.slice(i, i + 100))
}
await Promise.all(chunks.map(chunk =>
  fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(chunk),
  })
))
```

### 7.4 Handle notification tap (deep link to request)

```typescript
// app/_layout.tsx
import * as Notifications from 'expo-notifications'
import { router } from 'expo-router'

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge:  true,
  }),
})

// In root layout useEffect
Notifications.addNotificationResponseReceivedListener(response => {
  const requestId = response.notification.request.content.data?.requestId
  if (requestId) router.push(`/request/${requestId}`)
})
```

---

## 8. Security Hardening

### 8.1 Never store service key on user machines (already covered in section 2)

After the Edge Function refactor, user `.env` only contains:
```
SUPABASE_URL         ← public, safe
SUPABASE_ANON_KEY    ← public, safe
MACHINE_ID           ← machine identifier only
MACHINE_API_KEY      ← secret but scoped to one machine
USER_ID              ← user identifier only
```

If a machine is compromised, rotate `MACHINE_API_KEY`, update the hash in `machines`
row, re-run setup. The attacker can only insert/query requests for that one machine.

### 8.2 Machine API key rotation

Add a button in the Electron tray menu: "Rotate machine API key"
This generates a new key, calls an edge function to update `api_key_hash`, rewrites `.env`.

### 8.3 Request expiry

The `cleanup_old_requests` function in `schema.sql` already handles this.
Also add a `timeout` status for requests that exceed `TIMEOUT_SECONDS`:

```sql
-- Add a Postgres cron job (requires pg_cron extension, available on Supabase Pro)
select cron.schedule(
  'timeout-old-requests',
  '* * * * *',   -- every minute
  $$
    update pending_requests
    set status = 'timeout'
    where status = 'pending'
      and created_at < now() - interval '10 minutes';
  $$
);
```

### 8.4 Rate limiting in Edge Functions

Add a simple per-machine rate limit in `insert-request`:

```typescript
// Check requests created in last 60 seconds
const { count } = await svc
  .from('pending_requests')
  .select('id', { count: 'exact', head: true })
  .eq('machine_id', machineId)
  .gte('created_at', new Date(Date.now() - 60_000).toISOString())

if ((count ?? 0) > 30) {
  return new Response('Rate limit exceeded', { status: 429 })
}
```

### 8.5 QR code expiry (optional, for paranoid users)

If you want the QR to expire (e.g., if screenshot leaks):

```sql
create table pairing_sessions (
  token      text primary key,
  user_id    uuid references auth.users(id) on delete cascade not null,
  machine_id uuid references machines(id)  on delete cascade not null,
  expires_at timestamptz not null,
  used       boolean default false
);
```

Instead of embedding credentials in the QR, embed `{ v: 2, token: "short-lived-token" }`.
Mobile app exchanges the token for credentials via an edge function (one-time use).
After 5 minutes, the token expires.

This is optional — the anon key in a QR is already low-risk due to RLS.

---

## 9. Distribution & Auto-Updates

### 9.1 Windows — Electron Forge + NSIS installer

```bash
npm install --save-dev @electron-forge/cli
npx electron-forge import
```

`forge.config.js`:
```js
module.exports = {
  packagerConfig: {
    name:    'relay-daemon',
    icon:    './electron/icons/app',
    asar:    true,
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name:              'relay_daemon',
        setupIcon:         './electron/icons/app.ico',
        setupExe:          'relay-daemon-setup.exe',
        authors:           'Your Name',
        description:       'Claude Code relay daemon',
      },
    },
  ],
  plugins: [
    { name: '@electron-forge/plugin-auto-unpack-natives', config: {} },
  ],
}
```

```bash
npm run electron:pack   # produces out/make/squirrel.windows/relay-daemon-setup.exe
```

Upload to GitHub Releases. Users download and run the installer.

### 9.2 Auto-updates via electron-updater

```bash
npm install electron-updater
```

In `electron/main.js`:
```js
const { autoUpdater } = require('electron-updater')

app.whenReady().then(() => {
  autoUpdater.checkForUpdatesAndNotify()
})

autoUpdater.on('update-downloaded', () => {
  tray.displayBalloon({
    title:   'relay-daemon update ready',
    content: 'Restart to apply the latest update.',
  })
})
```

Point `autoUpdater.setFeedURL` to your GitHub Releases URL.

### 9.3 iOS — Expo EAS Build + App Store

```bash
npm install -g eas-cli
eas login
eas build:configure
```

`eas.json`:
```json
{
  "build": {
    "production": {
      "ios": {
        "simulator": false,
        "distribution": "store"
      }
    },
    "preview": {
      "ios": {
        "simulator": false,
        "distribution": "internal"
      }
    }
  }
}
```

```bash
eas build --platform ios --profile preview    # TestFlight beta
eas build --platform ios --profile production # App Store
eas submit --platform ios                     # submit to App Store Connect
```

**Apple requirements:**
- Apple Developer Program: $99/year
- App Store Review: 1-3 days for first submission, faster for updates
- Privacy manifest required (Expo handles most of this automatically)

### 9.4 Distribution checklist

- [ ] Apple Developer account enrolled ($99/year)
- [ ] App ID registered in Apple Developer portal
- [ ] Push notification entitlement added to app ID
- [ ] Expo project ID set in `app.json`
- [ ] GitHub repository with releases enabled (for Electron auto-updater)
- [ ] Code signing certificate for Windows installer (optional, ~$300/year from DigiCert)
- [ ] Landing page / download page

---

## 10. Cost Breakdown

### Monthly costs at different scales

| Item | Dev | Beta (50 users) | Production (500 users) | Scale (5000 users) |
|------|-----|-----------------|------------------------|--------------------|
| Supabase | Free | **Pro $25** | Pro $25 | Pro + add-ons ~$100 |
| Expo Push | Free | Free | Free (< 1M/mo) | Free |
| Apple Developer | $99/yr | $99/yr | $99/yr | $99/yr |
| Windows signing cert | $0 | $0 | ~$300/yr | ~$300/yr |
| Domain + landing page | ~$15/yr | ~$15/yr | ~$15/yr | ~$15/yr |
| **Total/month** | **~$0** | **~$34** | **~$34** | **~$115** |

### One-time costs

| Item | Cost |
|------|------|
| Apple Developer Program | $99 |
| Windows code signing (optional) | $200-500 |
| Logo / icon design | $0-200 |

---

## 11. Build Phases & Timeline

### Phase 1 — Backend hardening (1-2 weeks)

- [ ] Add `push_tokens` table to `schema.sql`
- [ ] Write `register-machine` Edge Function
- [ ] Write `insert-request` Edge Function (with push notification call)
- [ ] Update `src/supabase.js` to call edge functions
- [ ] Remove `SUPABASE_SERVICE_KEY` from daemon config
- [ ] Tighten RLS policies
- [ ] Upgrade Supabase to Pro

### Phase 2 — Windows Electron app (2-3 weeks)

- [ ] Add Electron to project
- [ ] System tray with online/offline icons
- [ ] QR window (`renderer/qr.html`)
- [ ] Setup wizard with magic link auth (`renderer/setup.html`)
- [ ] Auto-start on Windows login
- [ ] NSIS installer via Electron Forge
- [ ] Auto-updater pointing to GitHub Releases
- [ ] Test on clean Windows machine

### Phase 3 — iOS app (3-4 weeks)

- [ ] Expo project created with TypeScript template
- [ ] QR scanner screen
- [ ] Connection stored in SecureStore
- [ ] Pending requests list with realtime subscription
- [ ] Request detail view (diff viewer, risk badge)
- [ ] Approve / Deny with haptic feedback
- [ ] Push notification registration
- [ ] Handle push notification tap (deep link)
- [ ] Multi-machine support
- [ ] TestFlight beta
- [ ] App Store submission

### Phase 4 — Polish & launch (1-2 weeks)

- [ ] Landing page with download links
- [ ] Onboarding docs
- [ ] Error tracking (Sentry for both Electron and mobile)
- [ ] Analytics (PostHog — open source, self-hostable)
- [ ] GitHub Releases with changelog
- [ ] Respond to App Store review feedback

**Total estimated timeline: 7-11 weeks** for a solo developer working part-time.

---

## Appendix: Key env vars after Phase 1

User's `.env` — no service key:
```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
MACHINE_ID=6ba7b810-9dad-11d1-80b4-00c04fd430c8
MACHINE_API_KEY=f3a9c2...
USER_ID=550e8400-e29b-41d4-a716-446655440000
MACHINE_LABEL=Dev PC
TIMEOUT_SECONDS=300
FAIL_OPEN=true
ALWAYS_ALLOW=node_modules,\.git/,dist/,\.next/
ALWAYS_BLOCK=
```

Supabase Edge Function env vars (set in Supabase dashboard → Edge Functions → Secrets):
```
SUPABASE_URL             (auto-set)
SUPABASE_ANON_KEY        (auto-set)
SUPABASE_SERVICE_ROLE_KEY (add manually)
```
