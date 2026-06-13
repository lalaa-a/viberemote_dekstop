# Vibe Remote — Distribution Security Guide

This guide covers what you must fix before distributing the desktop app publicly.
Skip nothing in **Phase 1** — it is a hard requirement. Phase 2 is the long-term hardening.

---

## The Problem

Electron apps package all source code into `resources/app.asar`. Anyone can crack it open in seconds:

```
npx asar extract resources/app.asar ./extracted
```

Your current `src/lib/supabase.js` contains:

```js
const SUPABASE_SERVICE_KEY = 'eyJ...'; // ← full admin key, bypasses ALL RLS
```

**What an attacker can do with your service key:**
- Read, write, or delete every row in every table across every user
- Enumerate all user accounts
- Approve or deny anyone's Claude Code requests
- Drain or corrupt your entire database

The anon key is also hardcoded but that is intentional and safe — it is designed to be public. The service key is not.

---

## What Is Safe to Expose

| Credential | Safe in app? | Why |
|---|---|---|
| `SUPABASE_URL` | ✅ Yes | Public endpoint, no auth |
| `SUPABASE_ANON_KEY` | ✅ Yes | Designed for client-side use; RLS controls what it can do |
| `SUPABASE_SERVICE_KEY` | ❌ Never | Bypasses all RLS; server-only |
| Per-machine `MACHINE_API_KEY` | ✅ Yes (in local `.env` only) | Scoped to one machine, hashed in DB |

---

## Phase 1 — Required Before Distribution

### Step 1: Enable RLS on your tables

Run this in **Supabase → SQL Editor**:

```sql
-- Enable RLS (if not already on)
ALTER TABLE machines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_requests ENABLE ROW LEVEL SECURITY;

-- machines: authenticated users manage only their own machines
CREATE POLICY "insert_own_machine" ON machines
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "select_own_machines" ON machines
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "update_own_machines" ON machines
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "delete_own_machines" ON machines
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- pending_requests: users see and act on only their own requests
CREATE POLICY "select_own_requests" ON pending_requests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "update_own_requests" ON pending_requests
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- agents: users see only their own sessions
CREATE POLICY "select_own_agents" ON agents
  FOR SELECT TO authenticated
  USING (machine_id IN (
    SELECT id FROM machines WHERE user_id = auth.uid()
  ));
```

> **Test:** In Supabase Table Editor, switch to the anon role and confirm you can only see rows belonging to the signed-in user.

---

### Step 2: Remove the service key from `src/lib/supabase.js`

Replace the file with:

```js
// src/lib/supabase.js
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL    = 'https://YOUR_PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...anon...';

// Single client — anon key only. RLS on the database controls access.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```

No `serviceClient`. No `SUPABASE_SERVICE_KEY`. Never again in the renderer.

---

### Step 3: Fix machine registration in `Dashboard.jsx`

After Step 1 (RLS policies), the regular `supabase` client can insert a machine because the user is authenticated and `user_id = auth.uid()` is satisfied.

Change `Dashboard.jsx`:

```js
// BEFORE (uses service key — bypasses RLS)
import { supabase, serviceClient, SUPABASE_URL_EXPORT, SUPABASE_ANON_KEY_EXPORT, SUPABASE_SERVICE_KEY_EXPORT } from '../lib/supabase.js';
// ...
const { error: dbErr } = await serviceClient.from('machines').insert({ ... });

// AFTER (uses anon key + auth session — respects RLS)
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/supabase.js';
// ...
const { error: dbErr } = await supabase.from('machines').insert({ ... });
```

Also fix `writeMachineConfig` — **do not write the service key into the `.env`**:

```js
await window.relay.writeMachineConfig({
  SUPABASE_URL:      SUPABASE_URL,
  SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
  // SUPABASE_SERVICE_KEY: ← remove this line entirely
  MACHINE_ID:        machineId,
  MACHINE_LABEL:     machineLabel,
  MACHINE_API_KEY:   rawKey,
  USER_ID:           session.user.id,
  TIMEOUT_SECONDS:   '300',
  FAIL_OPEN:         'true',
  ALWAYS_ALLOW:      'node_modules,\\.git/,dist/,\\.next/',
  ALWAYS_BLOCK:      '',
});
```

---

### Step 4: Fix the relay daemon to not need the service key

The relay daemon (`relay-deamon1/hook.js`, `relay-deamon1/relay.cjs`) currently uses the service key for two things:

1. **Uploading pending requests** (hook.js → `supabase.js`)
2. **Updating request status** (relay.cjs)

Both must be replaced with **Supabase Edge Functions** that authenticate using the machine's API key. See Phase 2 for the full implementation.

**Temporary workaround** (if you need to ship before Phase 2):
- Keep the service key in the relay daemon's *server-side `.env`* only (the `.env` that lives in `relay-deamon1/` on the developer's own machine)
- Never bundle that `.env` in the installer (already handled by the `postPackage` hook)
- The generated `.env` on user machines should **not** contain the service key — only `SUPABASE_ANON_KEY` and the machine credentials

This means the relay daemon on user machines will need the Edge Function from Phase 2 to work.

---

### Step 5: Rebuild and verify

```bash
npm run make
```

Then extract and audit the output:

```bash
npx asar extract "out\VibeRemote-win32-x64\resources\app.asar" extracted-app
grep -r "service_role" extracted-app/
# Must return nothing
grep -r "SUPABASE_SERVICE_KEY" extracted-app/
# Must return nothing
```

If either command returns results, you have a leak. Do not distribute until clean.

---

## Phase 2 — Full Hardening (Edge Functions)

This replaces the service key in the relay daemon with machine-API-key-authenticated edge functions. Users' machines never need the service key at all.

### Architecture after Phase 2

```
hook.js  ──POST /relay-upload──►  Edge Function  ──service key──► Supabase DB
relay.cjs ─POST /relay-decide──►  Edge Function  ──service key──► Supabase DB
```

The service key lives only inside Supabase's own servers, never on user machines.

---

### Create Edge Function: `relay-upload`

In **Supabase → Edge Functions → New Function** named `relay-upload`:

```typescript
// supabase/functions/relay-upload/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
)

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const { machine_api_key, payload } = await req.json()
  if (!machine_api_key) return new Response('Missing machine_api_key', { status: 401 })

  // Verify the machine API key
  const keyHash = await hashHex(machine_api_key)
  const { data: machine, error: machineErr } = await supabase
    .from('machines')
    .select('id, user_id')
    .eq('api_key_hash', keyHash)
    .single()

  if (machineErr || !machine) return new Response('Invalid API key', { status: 401 })

  // Insert the pending request
  const { data, error } = await supabase
    .from('pending_requests')
    .insert({ ...payload, machine_id: machine.id, user_id: machine.user_id })
    .select('id')
    .single()

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 })

  return new Response(JSON.stringify({ id: data.id }), {
    headers: { 'Content-Type': 'application/json' },
  })
})

async function hashHex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}
```

---

### Create Edge Function: `relay-decide`

```typescript
// supabase/functions/relay-decide/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
)

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const { machine_api_key, request_id, decision } = await req.json()
  if (!machine_api_key || !request_id || !decision) {
    return new Response('Missing fields', { status: 400 })
  }
  if (!['approved', 'denied'].includes(decision)) {
    return new Response('Invalid decision', { status: 400 })
  }

  // Verify the machine API key
  const keyHash = await hashHex(machine_api_key)
  const { data: machine } = await supabase
    .from('machines')
    .select('id')
    .eq('api_key_hash', keyHash)
    .single()

  if (!machine) return new Response('Invalid API key', { status: 401 })

  // Update only the request that belongs to this machine
  const { error } = await supabase
    .from('pending_requests')
    .update({ status: decision, decided_at: new Date().toISOString(), decided_by: 'pc' })
    .eq('id', request_id)
    .eq('machine_id', machine.id)
    .eq('status', 'pending')

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 })

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})

async function hashHex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}
```

---

### Update relay daemon to call edge functions

In `relay-deamon1/src/supabase.js`, replace the `uploadRequest` and `updateDecision` functions:

```js
const EDGE_BASE = `${config.supabaseUrl}/functions/v1`

export async function uploadRequest(row) {
  const res = await fetch(`${EDGE_BASE}/relay-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': config.supabaseKey },
    body: JSON.stringify({ machine_api_key: config.machineApiKey, payload: row }),
  })
  if (!res.ok) throw new Error(`Upload failed: ${await res.text()}`)
  return res.json()
}

export async function updateDecision(requestId, status) {
  const res = await fetch(`${EDGE_BASE}/relay-decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': config.supabaseKey },
    body: JSON.stringify({ machine_api_key: config.machineApiKey, request_id: requestId, decision: status }),
  })
  if (!res.ok) throw new Error(`Decision update failed: ${await res.text()}`)
}
```

After this change, `SUPABASE_SERVICE_KEY` is no longer read or needed by the relay daemon. Remove it from `relay-deamon1/src/config.js`.

---

### Also create: `relay-heartbeat` Edge Function

For the machine heartbeat (`scripts/heartbeat.js`), same pattern — authenticate with `machine_api_key`, update `machines.last_seen` and `is_online` server-side.

---

## Pre-Distribution Checklist

Before every public release, run through this:

- [ ] `grep -r "service_role" out/` returns nothing
- [ ] `grep -r "SUPABASE_SERVICE_KEY" out/` returns nothing
- [ ] RLS is enabled on `machines`, `agents`, `pending_requests`
- [ ] All RLS policies tested with a non-admin user account
- [ ] `relay-deamon1/.env` is absent from the installer (verify with `postPackage` hook log)
- [ ] Edge Functions deployed and tested end-to-end
- [ ] Fresh install test: new account on a clean machine registers correctly
- [ ] Rotate the service key after Phase 2 is live (invalidates any previously leaked copies)

---

## Key Rotation

If your service key was already distributed (e.g. in a previous build), rotate it immediately:

1. Supabase Dashboard → Project Settings → API → Roll service role key
2. Update all server-side uses (Edge Functions environment variables)
3. The old key is invalid the moment you roll it

The anon key does **not** need rotation — it is safe to expose.

---

## Summary Table

| Location | Before | After Phase 1 | After Phase 2 |
|---|---|---|---|
| `src/lib/supabase.js` | URL + anon + **service** | URL + anon only | URL + anon only |
| Machine `.env` (generated) | URL + anon + **service** + machine creds | URL + anon + machine creds | URL + anon + machine creds |
| relay daemon DB writes | Direct with service key | Direct with service key (temp) | Edge Function + machine API key |
| Supabase RLS | Off / bypassed | On, policies enforced | On, policies enforced |
| Service key location | Hardcoded in app + every `.env` | Nowhere in app | Supabase servers only |
