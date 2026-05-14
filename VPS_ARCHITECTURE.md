# Vibe Remote — VPS Backend Architecture Guide

## Is a DigitalOcean VPS Worth It?

**Yes.** It solves every security problem from `DISTRIBUTION_SECURITY.md` cleanly:

- The Supabase service key never leaves the server. Ever.
- The desktop app and mobile app only know the VPS API URL and the Supabase anon key.
- Machine registration, request upload, and decision updates go through your API — not directly to Supabase.
- You control rate limiting, logging, and abuse prevention.

**With the GitHub Student Pack ($200 DigitalOcean credit):**

| Droplet | RAM | Cost | Credit lasts |
|---|---|---|---|
| Basic (recommended) | 1 GB | $6/mo | ~33 months |
| Standard | 2 GB | $12/mo | ~16 months |
| Comfortable | 4 GB | $24/mo | ~8 months |

The $6/month droplet runs Node.js comfortably for this workload. Your credit easily covers the entire student year with room to spare.

---

## How the Architecture Changes

### Before (current — insecure for distribution)

```
Desktop App ──── service key ────────────────► Supabase DB
Mobile App  ──── anon key + RLS ─────────────► Supabase DB
Relay Daemon ─── service key (in .env) ──────► Supabase DB
```

The service key is in the Electron app source, extractable by anyone.

### After (VPS backend — production grade)

```
Desktop App ──── anon key (auth only) ───────► Supabase Auth
Desktop App ──── JWT + machine creds ────────► VPS API ──► Supabase DB (service key on VPS)
Mobile App  ──── anon key (auth only) ───────► Supabase Auth
Mobile App  ──── JWT ────────────────────────► VPS API ──► Supabase DB
Relay Daemon ─── machine API key ────────────► VPS API ──► Supabase DB

Realtime decisions (still direct, anon key is fine):
Mobile App  ─────────────────────────────────► Supabase Realtime (read decisions)
Relay Daemon ────────────────────────────────► Supabase Realtime (watch for approval)
```

**What stays in the apps:** Supabase URL, anon key, VPS API URL  
**What moves to VPS:** Supabase service key, all DB write logic  
**What stays direct to Supabase:** Auth (sign up/in), Realtime subscriptions (read-only, anon key + RLS)

---

## VPS Backend — What to Build

A simple Node.js + Express API. Suggested structure:

```
vibe-remote-server/
├── src/
│   ├── index.js          # Express app, routes
│   ├── supabase.js       # Service client (service key here only)
│   ├── auth.js           # JWT verification middleware
│   ├── routes/
│   │   ├── machines.js   # POST /machines/register
│   │   ├── relay.js      # POST /relay/upload, POST /relay/decide
│   │   └── heartbeat.js  # POST /machines/heartbeat
│   └── lib/
│       └── crypto.js     # SHA-256 helper
├── .env                  # SUPABASE_SERVICE_KEY lives here only
├── package.json
└── ecosystem.config.js   # PM2 process manager config
```

### `.env` on the VPS (never leave the server)

```env
SUPABASE_URL=https://yourproject.supabase.co
SUPABASE_SERVICE_KEY=eyJ...your_service_key...
PORT=3000
```

### `src/supabase.js`

```js
import { createClient } from '@supabase/supabase-js';

// This file only exists on the VPS — service key never in any app
export const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);
```

### `src/auth.js` — Verify Supabase JWT from apps

```js
import { createClient } from '@supabase/supabase-js';

// Anon client to verify user JWTs
const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export async function requireUserAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  const { data: { user }, error } = await authClient.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}

export async function requireMachineAuth(req, res, next) {
  const apiKey = req.headers['x-machine-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing machine API key' });

  const hash = await sha256(apiKey);
  const { data: machine } = await db
    .from('machines')
    .select('id, user_id, label')
    .eq('api_key_hash', hash)
    .single();

  if (!machine) return res.status(401).json({ error: 'Invalid machine API key' });

  req.machine = machine;
  next();
}
```

### `src/routes/machines.js` — Machine registration

```js
import { Router } from 'express';
import { db } from '../supabase.js';
import { requireUserAuth } from '../auth.js';

const router = Router();

// POST /machines/register
// Called by desktop app on first run (after user signs in)
// Body: { machineId, machineLabel, apiKeyHash }
router.post('/register', requireUserAuth, async (req, res) => {
  const { machineId, machineLabel, apiKeyHash } = req.body;

  if (!machineId || !machineLabel || !apiKeyHash) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const { error } = await db.from('machines').insert({
    id: machineId,
    user_id: req.user.id,
    label: machineLabel,
    api_key_hash: apiKeyHash,
    is_online: true,
    last_seen: new Date().toISOString(),
  });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true, machineId });
});

export default router;
```

### `src/routes/relay.js` — Relay daemon endpoints

```js
import { Router } from 'express';
import { db } from '../supabase.js';
import { requireMachineAuth } from '../auth.js';

const router = Router();

// POST /relay/upload
// Called by hook.js when Claude Code fires a tool-use event
router.post('/upload', requireMachineAuth, async (req, res) => {
  const { payload } = req.body;

  const { data, error } = await db
    .from('pending_requests')
    .insert({
      ...payload,
      machine_id: req.machine.id,
      user_id: req.machine.user_id,
    })
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ id: data.id });
});

// POST /relay/decide
// Called by relay.cjs when the PC approves/denies via terminal
router.post('/decide', requireMachineAuth, async (req, res) => {
  const { requestId, decision } = req.body;

  if (!['approved', 'denied'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision' });
  }

  const { error } = await db
    .from('pending_requests')
    .update({
      status: decision,
      decided_at: new Date().toISOString(),
      decided_by: 'pc',
    })
    .eq('id', requestId)
    .eq('machine_id', req.machine.id)
    .eq('status', 'pending');

  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true });
});

// POST /relay/heartbeat
// Called periodically by heartbeat.js to update machine online status
router.post('/heartbeat', requireMachineAuth, async (req, res) => {
  await db
    .from('machines')
    .update({ is_online: true, last_seen: new Date().toISOString() })
    .eq('id', req.machine.id);

  res.json({ ok: true });
});

export default router;
```

### `src/index.js`

```js
import express from 'express';
import machinesRouter from './routes/machines.js';
import relayRouter from './routes/relay.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use('/machines', machinesRouter);
app.use('/relay', relayRouter);

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => {
  console.log(`Vibe Remote API running on port ${process.env.PORT || 3000}`);
});
```

---

## What Changes in the Desktop App

### 1. `src/lib/supabase.js` — Keep only anon client

```js
// Only anon key + URL. No service key. No serviceClient.
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL      = 'https://yourproject.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...anon...';
export const API_URL           = 'https://your-vps-ip-or-domain.com'; // your VPS

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```

### 2. `src/components/Dashboard.jsx` — Call VPS instead of Supabase directly

```js
// registerMachine uses VPS API — no service key needed in the app
async function registerMachine() {
  const machineId   = crypto.randomUUID();
  const rawKey      = crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'');
  const apiKeyHash  = await sha256hex(rawKey);
  const machineLabel = await window.relay.getHostname();

  // Get the current user's JWT to prove identity to the VPS
  const { data: { session } } = await supabase.auth.getSession();

  const res = await fetch(`${API_URL}/machines/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ machineId, machineLabel, apiKeyHash }),
  });

  if (!res.ok) throw new Error('Machine registration failed: ' + await res.text());

  await window.relay.writeMachineConfig({
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    API_URL,              // relay daemon calls VPS, not Supabase directly
    MACHINE_ID:     machineId,
    MACHINE_LABEL:  machineLabel,
    MACHINE_API_KEY: rawKey,
    USER_ID:        session.user.id,
    TIMEOUT_SECONDS: '300',
    FAIL_OPEN:       'true',
    ALWAYS_ALLOW:    'node_modules,\\.git/,dist/,\\.next/',
    ALWAYS_BLOCK:    '',
  });

  setMachineConfig({ machineId, machineLabel, machineApiKey: rawKey, supabaseUrl: SUPABASE_URL });
}
```

### 3. Machine's generated `.env` — what it looks like after VPS setup

```env
SUPABASE_URL=https://yourproject.supabase.co
SUPABASE_ANON_KEY=eyJ...anon_key...
API_URL=https://your-vps-domain.com
MACHINE_ID=<generated-uuid>
MACHINE_LABEL=DESKTOP-ABC123
MACHINE_API_KEY=<generated-64-char-hex>
USER_ID=<supabase-user-uuid>
TIMEOUT_SECONDS=300
FAIL_OPEN=true
ALWAYS_ALLOW=node_modules,\.git/,dist/,\.next/
ALWAYS_BLOCK=
```

No service key. Ever.

---

## What Changes in the Relay Daemon

### `relay-deamon1/src/supabase.js` — Call VPS for writes, keep Realtime direct

```js
// Writes → VPS API (no service key needed)
// Realtime subscription → Supabase direct (anon key + RLS is fine for reading)

export async function uploadRequest(row) {
  const res = await fetch(`${config.apiUrl}/relay/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-machine-api-key': config.machineApiKey,
    },
    body: JSON.stringify({ payload: row }),
  });
  if (!res.ok) throw new Error(`Upload failed: ${await res.text()}`);
  return (await res.json()).id;
}

// Realtime subscription stays the same — uses anon key, watches for decision
// on the specific request ID (RLS allows reading own machine's requests)
export function waitForDecision(requestId) {
  // ... existing realtime code, unchanged
}
```

### `relay-deamon1/relay.cjs` — Decide via VPS

```js
// Replace the Supabase update call with:
async function sendDecision(requestId, status) {
  const res = await fetch(`${process.env.API_URL}/relay/decide`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-machine-api-key': process.env.MACHINE_API_KEY,
    },
    body: JSON.stringify({ requestId, decision: status }),
  });
  if (!res.ok) console.error('Decision update failed:', await res.text());
}
```

---

## What Changes in the Mobile App

The mobile app currently reads decisions via Supabase Realtime (which is fine — anon key + RLS). The only change needed is machine registration confirmation and reading pending requests.

If mobile currently calls Supabase directly with the anon key to **read** pending_requests:
- **This stays the same** — anon key + RLS (`user_id = auth.uid()`) is safe and correct.

If mobile calls Supabase to **approve/deny** (update pending_requests):
- Change to call VPS `/relay/decide` with the user's JWT instead.
- Or keep it as Supabase direct — an authenticated user updating their own requests is fine with proper RLS.

---

## VPS Setup on DigitalOcean (Step by Step)

### 1. Create the droplet

- Image: **Ubuntu 24.04 LTS**
- Size: **Basic, $6/month** (1 GB RAM, 1 vCPU)
- Region: closest to your users
- Authentication: SSH key (not password)

### 2. Install Node.js and PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 3. Deploy the backend

```bash
git clone https://github.com/yourusername/vibe-remote-server.git
cd vibe-remote-server
npm install

# Create .env with your secrets
nano .env
# Paste: SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY, PORT=3000

pm2 start src/index.js --name vibe-remote-api
pm2 save
pm2 startup   # auto-restart on reboot
```

### 4. Set up HTTPS with Caddy (recommended — free auto SSL)

```bash
sudo apt install -y caddy

# /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile
```

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

Your API is now at `https://your-domain.com` with auto-renewing SSL. No certificate management needed.

### 5. Point a domain (optional but recommended)

Use a cheap domain or a free subdomain. DigitalOcean's managed DNS is free with your droplet.

If you don't have a domain yet, you can use the droplet's IP directly for testing, but HTTPS requires a domain.

---

## Supabase Realtime — Does It Still Work?

Yes. Realtime is read-only from the app's perspective:

- **relay hook** watches for a decision on a specific `pending_requests` row → anon key + RLS allows this
- **mobile app** subscribes to new pending requests for the user → anon key + RLS allows this

The only thing you need is a proper RLS `SELECT` policy on `pending_requests`:

```sql
-- Users can read their own pending requests (for Realtime to work)
CREATE POLICY "select_own_requests" ON pending_requests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Machines need to read their own requests too (for relay hook Realtime)
-- Machines authenticate as Supabase auth users — see note below
```

**Note on machine Realtime auth:** The relay hook is not a signed-in Supabase user, so it can't use `auth.uid()` for RLS. Two options:
1. **Easiest:** Keep Realtime as-is and poll the VPS API for decisions instead (simpler, no Realtime complexity)
2. **Cleaner:** During machine registration, the VPS creates a Supabase Auth user account for the machine (`machine-{id}@internal`) and returns a session token. The hook uses this token for Realtime auth.

For v1, polling the VPS every 500ms for a decision is simpler and still fast enough.

---

## Security Comparison

| | Current (no VPS) | With VPS |
|---|---|---|
| Service key location | Hardcoded in .exe | VPS only, never in any app |
| Machine .env | Has service key | Anon key + machine creds only |
| Anyone can extract secrets | Yes (asar crack) | Nothing to extract |
| DB admin access if app is leaked | Full access | None |
| Cost | Free | $6/month ($200 credit covers it) |
| Complexity | Low | Medium |
| Production grade | No | Yes |

---

## Is It Worth It?

**Yes, if you're distributing publicly.** The $6/month droplet is covered by your student credit for years. The alternative — shipping the service key inside the app — gives any user full admin access to your entire database including all other users' data.

If you want to delay the VPS, the minimum viable safe approach before Phase 2 (VPS) is ready:
- Apply all the **Phase 1 RLS fixes** from `DISTRIBUTION_SECURITY.md`
- Ship without the relay daemon's Supabase write access (users manage decisions only through the mobile app's direct Supabase call — which is safe with RLS)
- Add VPS when ready without changing anything visible to users

But for a complete, production-grade system: VPS is the right call.
