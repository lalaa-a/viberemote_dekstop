# Update Implementation Plan — User Accounts + Machine↔Phone Pairing

> Source brief: [`update.md`](./update.md)
> Repos:
> - **desktop** = `D:\Projects\vRdeksMultiharness` (Electron + React, Vite, Forge)
> - **mobile**  = `D:\Projects\vibe_remote(reactNative)\AgentControl` (React Native 0.7x, RN-Navigation, Zustand, TanStack Query, MMKV, Supabase, FCM)
> - **server**  = `D:\Projects\vibe_remote(serverside)` (Express + Supabase service key, FCM admin)

---

## 1. What we're changing (plain language)

Today the **phone has no account**. It scans a desktop QR, stores that machine's
API key, and every `/mobile/*` call authenticates as the *machine*
(`x-machine-api-key`). Because the server resolves `machine.user_id`, a single
scanned QR silently unlocks the entire account's data.

We are moving to a real **user account on mobile** plus an explicit, exclusive
**machine ↔ phone pairing**:

1. **Mobile** gets **Register / Sign In** screens first (Supabase email +
   password). Nothing else is reachable until signed in.
2. The QR is **repurposed** from "log the phone in" to "**pair this machine to
   this phone**". One machine → exactly one phone. One phone → many machines.
3. **Mobile** has 3 bottom tabs: **Chats**, **Machines**, **Profile**
   (the old standalone **Requests** tab is removed — approvals already render
   inline in the Chats feed).
4. **Desktop** also keeps Register / Sign In (already present). On the machine
   screen the **QR only shows while no phone is paired**; once paired it shows
   the connected device with a **Remove** button, after which the QR returns.

### Locked decisions (from product owner)

| Topic | Decision |
|---|---|
| Pairing model | **Exclusive 1:1** — a machine pairs with one phone; a phone can pair many machines. |
| Mobile data auth | **Supabase user JWT** — `/mobile/*` switches to `requireUserAuthFast` (local HS256 verify, §4.1), scoped by `req.user.id` + paired device. |
| Existing installs | **Fresh start** — clear old QR-only credentials on upgrade; force register / sign-in. No migration path. |
| Profile tab | **Editable** — display name + avatar, change password, delete account, push toggle, app version, sign out. |

---

## 2. Architecture: before → after

### Auth model

**Before**
```
Desktop  --Supabase email/pw-->  user session  --register-->  machine (api_key_hash)
Desktop  --shows QR { machineId, apiKey, supabaseUrl, apiUrl }
Phone    --scan QR--> store machine creds --> every /mobile/* uses x-machine-api-key
                                              server resolves machine.user_id
```

**After**
```
Desktop  --Supabase email/pw-->  user session  --register-->  machine (api_key_hash)
Phone    --Supabase email/pw-->  user session  (NEW: real account on phone)
Phone    --register device--> mobile_devices row (device_id stored in MMKV)
Phone    --scan QR--> POST /machines/:id/pair { apiKey, deviceId }   (user JWT)
                       server verifies sha256(apiKey)==api_key_hash AND owner match
                       sets machines.paired_device_id (exclusive)
Phone    --every /mobile/* uses Bearer <userJWT> + x-device-id
                       server scopes to machines WHERE user_id = me AND paired_device_id = my device
Desktop  --GET /machines/:id/pairing--> shows paired device OR QR
```

Key consequence: **the phone no longer stores or needs the machine API key for
data calls.** It only needs the `apiKey` momentarily, as proof-of-scan, to call
the pair endpoint. After pairing succeeds, discard it.

### Realtime + push after the change
- `POST /mobile/realtime-token` → switch to **local JWT verify** (see §2.1), sign
  the JWT for `req.user.id` (it already supports this path via `SUPABASE_JWT_SECRET`).
- Push notifications become **device-scoped** and route only to the phone paired
  with the originating machine (see §5.4).

### 2.1 Performance budget (non-negotiable for this update)

This update moves the mobile read path off machine-key auth. Done naively it
would replace *one indexed DB lookup* with *one remote auth round-trip + two DB
queries* on the app's hottest, most-polled endpoints. The plan below is written
to **keep the new path at or below today's latency**. Three rules are baked into
every relevant section:

1. **Never validate a JWT over the network on the hot path.** `/mobile/*` and
   `realtime-token` verify the token **locally** with `SUPABASE_JWT_SECRET`
   (HS256), not via `authClient.auth.getUser()` (a GoTrue round-trip). Reserve
   the remote `getUser()` only for rare, security-critical routes (account
   delete, password change). — §2.1 / §4.1
2. **One DB round-trip per request.** Paired-machine scoping is done with a
   single join/sub-select (or a cached id-set), never a separate
   "fetch ids, then fetch data" pair. — §4.2
3. **Index every new filter column, push don't poll where possible.** Migration
   `007` indexes `paired_device_id`, `device_id`, `(user_id, paired_device_id)`;
   the desktop uses Realtime/adaptive polling, not a fixed 5s interval. — §3 / §6.1

> Quantified impact of ignoring these: each `/mobile/sessions` poll (every 30s,
> per phone) would cost a ~50–200ms GoTrue call **plus** a doubled DB round-trip.
> With local verify + single-query scoping + indexes, it costs one indexed query —
> comparable to the current machine-key path.

---

## 3. Database changes (server) — migration `007_user_accounts_pairing.sql`

Create in `vibe_remote(serverside)/migrations/007_user_accounts_pairing.sql`.
All additive; safe to run live.

```sql
-- Migration 007 — mobile user accounts + exclusive machine↔device pairing

-- 1. Mobile devices (one row per installed phone, owned by a user)
create table if not exists mobile_devices (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users(id) on delete cascade,
  device_name  text        not null default 'Phone',
  platform     text        not null default 'android',
  push_token   text,                       -- current FCM token (nullable)
  created_at   timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);
create index if not exists idx_mobile_devices_user on mobile_devices(user_id);

-- 2. Exclusive pairing: a machine points at AT MOST one device
alter table machines
  add column if not exists paired_device_id uuid
    references mobile_devices(id) on delete set null,
  add column if not exists paired_at timestamptz;

-- NOTE on cardinality: machines.paired_device_id is already 1 machine → 1 device
-- by column design. We deliberately do NOT add a unique index on it, because one
-- device may pair MANY machines (the same device_id appears on many machine rows).
-- A unique index would wrongly force one-device-to-one-machine.

-- PERFORMANCE indexes — FKs do not auto-create indexes in Postgres, and these are
-- the exact columns the new hot-path queries filter on. Without them the scoping
-- query and push lookup become sequential scans that degrade as tables grow.
create index if not exists idx_machines_user_paired
  on machines(user_id, paired_device_id);          -- pairedMachineIds() scoping (§4.2)
create index if not exists idx_machines_paired_device
  on machines(paired_device_id)
  where paired_device_id is not null;              -- notifyMachine() reverse lookup (§4.4)

-- 3. Profile fields (display name / avatar) — store in a profiles table
create table if not exists profiles (
  id           uuid        primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url   text,
  updated_at   timestamptz not null default now()
);
alter table profiles enable row level security;
drop policy if exists "self profile rw" on profiles;
create policy "self profile rw" on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- 4. Push tokens become device-scoped.
-- Existing push_tokens is keyed by machine_id; we add device_id and stop
-- requiring machine_id (notifications route via machine.paired_device_id).
alter table push_tokens
  add column if not exists device_id uuid references mobile_devices(id) on delete cascade;
alter table push_tokens alter column machine_id drop not null;  -- if currently NOT NULL

create index if not exists idx_push_tokens_device
  on push_tokens(device_id);                       -- notifyMachine() token fetch (§4.4)
```

> **Index checklist** (all created above — verify they exist after applying):
> `idx_mobile_devices_user`, `idx_machines_user_paired`,
> `idx_machines_paired_device`, `idx_push_tokens_device`. These are what keep the
> performance budget in §2.1 (rule 3) honest.

> **Apply** (same pattern as migration 003 per `newlyAdded.md`):
> ```bash
> docker exec -i supabase-db-1 psql -U postgres -d postgres \
>   < /path/to/migrations/007_user_accounts_pairing.sql
> pm2 restart all
> ```

### Pairing invariants enforced in code (not just schema)
- `machines.paired_device_id` is the single source of truth: `null` = unpaired
  (desktop shows QR), set = paired (desktop shows device).
- Pair endpoint rejects if already paired to a *different* device (409).
- Pairing the *same* device again is idempotent → "already connected" notice.

---

## 4. Server changes (`vibe_remote(serverside)/src`)

### 4.1 `middleware/auth.js` — fast local JWT verify (performance-critical)

The existing `requireUserAuth` calls `authClient.auth.getUser(token)` — a network
round-trip to Supabase GoTrue on **every** request. That is fine for the rare
routes it guards today, but it is **not acceptable on the `/mobile/*` hot path**
(the phone polls these on 30s intervals). Add a local verifier that checks the
JWT signature with the symmetric secret already used to *sign* tokens in
`mobile.js`'s `realtime-token` route (`SUPABASE_JWT_SECRET`):

```js
import jwt from 'jsonwebtoken'   // already a dependency (used in mobile.js)

// HOT PATH: verify the Supabase access token locally — no network call.
// Use this on /mobile/* and all high-frequency authenticated routes.
export function requireUserAuthFast(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' })
  }
  try {
    const claims = jwt.verify(header.slice(7), process.env.SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'],
    })
    req.user = { id: claims.sub, email: claims.email }   // shape matches requireUserAuth
    return next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// Resolve the calling device from the header set by the phone after it registers.
export function attachDevice(req, _res, next) {
  req.deviceId = req.headers['x-device-id'] || null
  next()
}
```

> ⚠️ **`x-device-id` is required for scoping.** Exclusive pairing scopes reads to
> `paired_device_id = req.deviceId`. If the header is missing, do **not** run
> `.eq('paired_device_id', null)` (that matches nothing / behaves oddly in
> PostgREST) — instead short-circuit: a `/mobile/*` read with no `x-device-id`
> should return an empty result (or `400`), never the unscoped account data.

**Which middleware where:**
- `/mobile/*`, `/harness/:machineId` (mobile reads), `/machines/:id/pairing`
  (desktop poll), `/machines/mine` → **`requireUserAuthFast`** + `attachDevice`.
- `/profile/password`, `DELETE /profile`, `DELETE /machines/devices/:id`,
  pairing writes → keep the existing remote **`requireUserAuth`** (rare,
  security-sensitive; the extra GoTrue check is worth it there).
- `requireMachineAuth` (relay daemon) — unchanged.

> **HS256 confirmed for this project:** `gen-keys.js` signs the anon/service keys
> with a symmetric `JWT_SECRET` via `jwt.sign` (HS256) — i.e. this is the
> self-hosted/legacy setup where GoTrue issues HS256 user tokens signed with that
> same secret. So local `jwt.verify(token, SECRET, {algorithms:['HS256']})` is
> valid. **The one thing to confirm:** `process.env.SUPABASE_JWT_SECRET` equals
> GoTrue's `GOTRUE_JWT_SECRET` (the value in `gen-keys.js`). If the project is
> ever migrated to asymmetric (RS256/ES256) signing keys, switch this verifier to
> the JWKS public key — `jwt.verify` with the HS256 secret would then reject all
> tokens.

### 4.2 `routes/mobile.js` — flip auth + scope to paired machines (single round-trip)
Replace `requireMachineAuth` with `requireUserAuthFast` (+ `attachDevice`) on
every route, and replace the "resolve `req.machine`" pattern with paired-machine
scoping. **The naive version does two DB round-trips per request** (fetch ids,
then fetch data). Avoid that — use **one** of the two patterns below.

**Pattern A (preferred) — push the scope into the data query as a join/sub-select,
so it stays one round-trip:**
```js
// e.g. GET /mobile/sessions — no separate id lookup
const { data: agents } = await db
  .from('agents')
  .select('*, machines!inner(id, label, last_seen, user_id, paired_device_id)')
  .eq('machines.user_id', req.user.id)
  .eq('machines.paired_device_id', req.deviceId)   // exclusive-pairing scope
  .order('last_activity_at', { ascending: false, nullsFirst: false })
```
The `!inner` join filters by machine ownership + pairing in the same statement;
`idx_machines_user_paired` makes it index-only.

**Pattern B (where a join is awkward, e.g. the feed RPC) — cache the id-set:**
```js
const _pairCache = new Map()   // `${userId}:${deviceId}` -> { ids, exp }
export async function pairedMachineIds(userId, deviceId) {
  const key = `${userId}:${deviceId}`
  const hit = _pairCache.get(key)
  if (hit && hit.exp > Date.now()) return hit.ids      // no DB hit on cache hit
  let q = db.from('machines').select('id').eq('user_id', userId)
  if (deviceId) q = q.eq('paired_device_id', deviceId)
  const { data } = await q
  const ids = (data ?? []).map(m => m.id)
  _pairCache.set(key, { ids, exp: Date.now() + 60_000 })  // pairings change rarely → 60s TTL
  return ids
}
// Invalidate on pair/unpair/device-delete: _pairCache.delete(`${userId}:${deviceId}`)
```
Pairings change only on explicit pair/unpair, so a 60s TTL removes the second
round-trip from virtually every request while staying fresh enough. **Bust the
cache** in the pair/unpair/device-delete handlers (§4.3).

Route-by-route:
- `GET /mobile/machine` (verify) → **remove** (machine-key concept gone) OR
  repurpose to `GET /mobile/me`.
- `POST /mobile/realtime-token` → `requireUserAuthFast`; sign JWT for `req.user.id`.
- `GET /mobile/sessions` → **Pattern A** join (hottest endpoint — keep it 1 query).
- `GET /mobile/sessions/:id/requests`, `.../feed` → Pattern A where possible; the
  `get_session_feed` RPC already takes `p_user_id` — keep passing `req.user.id`
  and have the RPC also filter by the paired device (**add a `p_device_id` arg —
  this is a function migration that redefines `get_session_feed`, fold it into
  `007` or a `008`**) so scoping stays inside the single RPC call rather than a
  pre-query.
- `GET /mobile/requests`, `/requests/:id`, `/history` → Pattern A join on
  `machines` (these were keyed off `req.machine.id`; now they span the phone's
  paired machines, or accept `?machineId=` to filter to one chip).
- `POST /mobile/decide` → **PostgREST UPDATEs cannot join**, so you can't filter
  the update by an embedded `machines` resource. Use Pattern B: get the cached
  `pairedMachineIds(...)` and add `.in('machine_id', ids)` to the existing
  `update().eq('id', requestId).eq('status','pending')` chain. On a cache hit this
  adds no round-trip. (The route already fetches `agent_id` first — you can also
  assert ownership on that read.)
- `GET /mobile/machines` → list **paired** machines (Chats filter chips use this);
  return `connection` inline (§5.4) so the Machines tab needs no per-card call.
- `POST /mobile/push-token` → upsert into `push_tokens` keyed by `device_id`
  (and update `mobile_devices.push_token`).
- `POST /mobile/prompt`, `/prompts`, `/prompt/:id`, `/fs/*`, `/terminal` →
  swap `req.machine.user_id` → `req.user.id`; verify target session's machine via
  the join (Pattern A) or cached `pairedMachineIds` (Pattern B).
- `GET /mobile/command/next` → **stays `requireMachineAuth`** (the relay daemon
  calls this with the machine key; do not change it).

> ⚠️ Audit every `req.machine.*` reference in `mobile.js` — there are ~20.
> All become `req.user.id` + paired-machine scoping (one round-trip), except
> `command/next`.

### 4.3 `routes/machines.js` — new pairing + device + profile endpoints
Auth split for performance: **reads** that the apps poll
(`GET /machines/:id/pairing`, `GET /machines/devices`) use `requireUserAuthFast`;
**writes** (pair/unpair, device delete) use the remote `requireUserAuth` (rare,
and they mutate the security boundary).

```js
// Register / upsert this phone as a device
POST   /machines/devices            { deviceName, platform } -> { deviceId }
GET    /machines/devices            -> [ { id, device_name, platform, last_active_at } ]
DELETE /machines/devices/:deviceId  -> { ok }   // also nulls any machines paired to it

// Pairing (exclusive 1:1)
POST   /machines/:machineId/pair    { apiKey, deviceId } -> 200 | 409(already paired)
DELETE /machines/:machineId/pair    -> { ok }   // unpair (mobile OR desktop)
GET    /machines/:machineId/pairing -> { paired: bool, device?: {...}, paired_at } // desktop polls
```

`POST /:machineId/pair` logic:
```js
const { apiKey, deviceId } = req.body
const { data: m } = await db.from('machines')
  .select('id, user_id, api_key_hash, paired_device_id')
  .eq('id', machineId).single()
if (!m || m.user_id !== req.user.id) return res.status(404)...
if (sha256(apiKey) !== m.api_key_hash) return res.status(403).json({ error: 'QR does not match this machine' })
if (m.paired_device_id && m.paired_device_id !== deviceId)
  return res.status(409).json({ error: 'Machine already paired to another device', code: 'paired_elsewhere' })
if (m.paired_device_id === deviceId)
  return res.json({ ok: true, alreadyPaired: true })   // notify "already connected"
// Guarded update = optimistic lock: only claim if still unpaired. Prevents a
// TOCTOU race where two phones scan the same QR simultaneously.
const { data: claimed } = await db.from('machines')
  .update({ paired_device_id: deviceId, paired_at: new Date().toISOString() })
  .eq('id', machineId).is('paired_device_id', null)
  .select('id').maybeSingle()
if (!claimed) return res.status(409).json({ error: 'Machine already paired to another device', code: 'paired_elsewhere' })
_pairCache.delete(`${req.user.id}:${deviceId}`)        // bust §4.2 cache
res.json({ ok: true })
```
`DELETE /:machineId/pair` and `DELETE /machines/devices/:id` must likewise bust
the `_pairCache` entry for the affected `(user, device)` so scoping reflects the
change immediately.

Keep existing `/machines/register`, `/mine`, `/:id/reclaim`, `DELETE /:id`,
heartbeat/offline, `fs/*` as-is. `DELETE /:machineId` already exists for the
Machines-tab delete action.

Add profile routes (or a new `routes/profile.js` mounted at `/profile`):
```js
GET    /profile            -> { email, display_name, avatar_url }
PATCH  /profile            { display_name?, avatar_url? } -> { ok }
POST   /profile/password   { newPassword } -> { ok }   // via supabase admin or client
DELETE /profile            -> { ok }   // admin.deleteUser(req.user.id) + cascade
```

### 4.4 `notify.js` — route pushes to the paired phone only
`notifyUser(userId, ...)` currently blasts every token for the user. Change the
caller (`/relay/upload`) to pass the originating `machineId`, and resolve the
token from the machine's paired device:

Resolve the paired device's token in **one** query. ⚠️ A PostgREST embedded join
**won't work here**: `push_tokens → machines` would join on the legacy
`push_tokens.machine_id` FK, not on `device_id = machines.paired_device_id`
(PostgREST can't express that correlated condition inline). Use a small **RPC**
(add to migration `007`) so the correlated join happens server-side in one
statement, backed by `idx_machines_paired_device` + `idx_push_tokens_device`:
```sql
create or replace function machine_push_tokens(p_machine_id uuid)
returns table(token text) language sql stable as $$
  select pt.token
  from machines m
  join push_tokens pt on pt.device_id = m.paired_device_id
  where m.id = p_machine_id and m.paired_device_id is not null
$$;
```
```js
export async function notifyMachine(machineId, { title, body, requestId }) {
  const { data: rows } = await db.rpc('machine_push_tokens', { p_machine_id: machineId })
  if (!rows?.length) return                    // no phone paired → nothing to send
  // ...existing sendEachForMulticast logic + stale-token cleanup...
}
```
The point: **do not** do a machine lookup then a separate token lookup on every
approval request.

In `routes/relay.js` the upload handler currently calls
`notifyUser(req.machine.user_id, {...})` — change it to
`notifyMachine(req.machine.id, {...})` (`req.machine.id` is already in scope).
It's fire-and-forget (never blocks the upload response). Keep `notifyUser` only if
some broadcast path still needs it.

### 4.5 `index.js` — mount + rate-limiter tuning
- Mount `profileRouter` if you split it out: `app.use('/profile', profileRouter)`.
- **Rate limiter (perf/availability):** the current global limiter is
  `max: 120/min` **keyed by IP**. After this update a single NAT (home/office)
  can host a desktop pairing poll **plus** several phones polling sessions /
  machines / feed, brushing 120/min and triggering `429`s that the app retries —
  compounding load. Two cheap fixes:
  1. **Key authenticated routes by user id, not IP.** ⚠️ The current global
     `app.use(limiter)` runs **before** any auth middleware, so `req.user` is
     undefined inside its `keyGenerator` — keying on `req.user?.id` there would
     silently always fall back to IP. To key by user you must apply a *separate*
     limiter **after** `requireUserAuthFast`, i.e. mounted on the `/mobile`
     router (and other authed routers) rather than globally:
     ```js
     // inside mobileRouter, after requireUserAuthFast has set req.user
     const mobileLimiter = rateLimit({
       windowMs: 60_000, max: 300,
       keyGenerator: (req) => req.user?.id ?? req.ip,
     })
     ```
     Keep the global IP limiter for unauthenticated surface.
  2. Raise `max` for authenticated `/mobile/*` (e.g. 300/min) while keeping the
     strict `registerLimiter` (5/min) on registration. Most of the volume is
     removed anyway once §6.1 stops the always-on 5s desktop poll.
- Ensure the client honors `429` with backoff (TanStack Query is already
  configured `retry: 2, retryDelay: 1000` — confirm it backs off rather than
  hammering).

### 4.6 `routes/harness.js` — switch mobile reads to fast auth
The mobile Machines tab polls `GET /harness/:machineId` every 30s
(`MachinesScreen` `refetchInterval: 30_000`, enabled while online) and
`POST /harness/:machineId/desire` on toggle. Both currently use the remote
`requireUserAuth`. Switch **`GET /harness/:machineId`** to `requireUserAuthFast`
(it's the polled hot path); `POST .../desire` (rare, user action) can stay remote
or also go fast. The two machine-key routes (`/report`, `/desired`) are unchanged.
The in-handler ownership check (`machine.user_id !== req.user.id`) stays as-is.

---

## 5. Mobile changes (`vibe_remote(reactNative)/AgentControl/src`)

### 5.1 Auth flow — real Supabase account, gate the app
- **`hooks/useAuth.ts`** — rewrite to use the existing `supabase` client
  (`api/supabase.ts`) instead of machine credentials:
  ```ts
  // subscribe to supabase.auth, expose: session, user, loading, signIn, signUp,
  // signOut, resetPassword. Replace getCredentials()/clearCredentials() usage.
  ```
- **`store/useAppStore.ts`** — remove `credentials` (MachineCredentials). Add:
  ```ts
  session: Session | null
  deviceId: string | null          // persisted in MMKV after device registration
  selectedMachineId: string | null // already exists — drives Chats filter chips
  ```
- **`api/supabase.ts`** — already configured with MMKV persistence; no change.
- **New screens** under `screens/Auth/`:
  - `SignInScreen.tsx` — email + password → `supabase.auth.signInWithPassword`.
  - `SignUpScreen.tsx` — email + password → `supabase.auth.signUp` (show
    "check your email" like the desktop `Auth.jsx`).
  - Keep `QRScanScreen.tsx` but **repurpose** (see 5.4) — it's no longer the
    auth gate.
- **`navigation/RootNavigator.tsx`** — change the guard:
  ```tsx
  const { session, loading } = useAuth()
  if (loading) return null
  return session
    ? <RootStack.Screen name="App" component={AppNavigator} />
    : <RootStack.Screen name="Auth" component={AuthNavigator} />   // SignIn/SignUp stack
  ```

### 5.2 Device registration (run once after first sign-in)
On first authenticated launch with no `deviceId` in MMKV:
```ts
// POST /machines/devices { deviceName: <model>, platform } -> { deviceId }
// store deviceId in MMKV + useAppStore; send as x-device-id on all calls.
```
Add `getDeviceId()/saveDeviceId()` to a small `api/device.ts`. Device name from
`react-native-device-info` (already a likely dep) or a default.

### 5.3 API layer — switch transport to user JWT + device header
Rewrite `api/server.ts`'s `request()` helper. **Read the access token from the
in-memory session** the store already maintains via `onAuthStateChange` (§5.1) —
do **not** `await supabase.auth.getSession()` on every request. `getSession()` is
async, can trigger a token refresh, and when the app fans out several queries on
focus it can stampede refreshes; reading the cached token avoids all of that:
```ts
function authHeaders(): Record<string,string> {
  const token = useAppStore.getState().session?.access_token   // in-memory, sync
  if (!token) throw new Error('Not authenticated')
  const h: Record<string,string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
  const deviceId = getDeviceId()                                // MMKV, sync
  if (deviceId) h['x-device-id'] = deviceId
  return h
}
```
supabase-js still refreshes the token in the background (`autoRefreshToken: true`)
and pushes the new one into the store through `onAuthStateChange` — so the cached
token stays current without a per-request call. (On a rare 401 from an
expired-but-not-yet-refreshed token, let the query retry; the refreshed token
will be in the store by then.)
- Remove `getCredentials/saveCredentials/clearCredentials/MachineCredentials`
  and the `x-machine-api-key` path.
- `verifyCredentials()` → delete (replaced by pairing).
- Add: `registerDevice()`, `pairMachine(machineId, apiKey, deviceId)`,
  `unpairMachine(machineId)`, `fetchProfile()`, `updateProfile()`,
  `changePassword()`, `deleteAccount()`.
- `api/realtime.ts` — **not "otherwise unchanged"**: it currently reads
  `getCredentials()` and uses `creds.apiUrl` / `creds.supabaseUrl` and
  `creds.apiKey`, all of which are being removed. Rewrite it to:
  - gate on the Supabase **session** (not `creds`): `if (!session) return null`;
  - call `${Config.API_URL}/mobile/realtime-token` with the **user JWT** header
    (`Authorization: Bearer …`), not `x-machine-api-key`;
  - build the client with `Config.SUPABASE_URL` instead of `creds.supabaseUrl`.
  - **Tie `clearRealtimeClient()` to `onAuthStateChange`** (sign-out and
    `TOKEN_REFRESHED`) so the socket re-auths cleanly instead of going stale and
    forcing reconnect storms. Reuse the app's access token if the Realtime server
    accepts it, rather than minting a second token.

### 5.4 Tabs — Chats / Machines / Profile
Edit `navigation/RootNavigator.tsx` `TAB_META` and `AppNavigator`:
- Remove `RequestsTab` (and its stack). Keep `ChatsTab`, add `ProfileTab`.
- Order: **Chats, Machines, Profile**.
- Badges: keep the Chats pending badge; drop the Requests badge.

**Tab 1 — Chats** (`screens/Sessions/SessionsScreen.tsx`)
- Add a horizontal **machine filter-chip row** under the header. Chips come from
  `GET /mobile/machines` (paired machines). Chip "All" + one per machine.
  Selecting a chip sets `selectedMachineId` (store) and filters the session list
  (`sessions.filter(s => !sel || s.machine_id === sel)`).
- The chat itself (`ChatScreen.tsx`) and inline approval cards
  (`RequestCard.tsx`, the feed via `useChatFeed`) are unchanged — approvals stay
  interactive in the conversation. This satisfies "approval request cards just
  like now" and "switch between sessions of the machines".

**Tab 2 — Machines** (`screens/Machines/MachinesScreen.tsx`)
- Data source unchanged (`/machines/mine` via user JWT, already works).
- Add per-card **connection state**: paired-to-this-device / paired-elsewhere /
  unpaired. **Return this inline on the list response — do not fetch pairing
  per card** (that would make the Machines tab N+1). Extend the `/machines/mine`
  query to `select` `paired_device_id`, `paired_at`, and a left-join to
  `mobile_devices` for the device name, then compute `connection` server-side by
  comparing `paired_device_id` to the request's `x-device-id`:
  `'this' | 'other' | 'none'`. One query renders the whole list.
- Add a **"Scan QR to connect"** button → navigates to the repurposed
  `QRScanScreen` as a modal. On scan:
  - parse `{ machineId, apiKey }`, call `pairMachine(machineId, apiKey, deviceId)`.
  - `200` → toast "Connected", refetch machines.
  - `409 paired_elsewhere` → alert "Already connected to another phone."
  - `alreadyPaired` → toast "Already connected to this phone." (the
    "if machine already registered it should notify too" requirement).
- Add **Delete machine** (`DELETE /machines/:id`) and **Disconnect**
  (`DELETE /machines/:id/pair`) actions per card.
- Replace the current header "Disconnect = signOut" with proper sign-out moved
  to Profile.

**Tab 3 — Profile** (`screens/Profile/ProfileScreen.tsx`, NEW)
- Editable display name + avatar (`PATCH /profile`; avatar upload to Supabase
  Storage, store only `avatar_url`). **Perf:** resize/compress the image on-device
  before upload, serve via a CDN/public URL with long `cache-control`, and cache
  with the RN image lib. Keep `avatar_url` out of any frequently-polled payload
  (it lives on `profiles`, fetched once — never bundle avatars into the sessions
  or machines poll responses).
- Change password (`POST /profile/password`).
- Delete account (`DELETE /profile`, with confirm).
- Push-notifications toggle (drives FCM permission + token registration).
- App version (`react-native-device-info` / package.json).
- **Sign out** (`supabase.auth.signOut()` + clear deviceId? keep deviceId so the
  same phone keeps its pairings on re-login — clear only on delete account).

### 5.5 `QRScanScreen.tsx` — repurpose
- Remove `saveCredentials` / `setCredentials` / `verifyCredentials` flow.
- On scan, call `pairMachine(...)`, show success/duplicate/elsewhere states,
  then `navigation.goBack()` to the Machines tab.
- Camera UI / brackets stay.

### 5.6 Types (`types/index.ts`)
- `RootStackParamList`: `Auth | App` (drop `SignIn`).
- `TabParamList`: `ChatsTab | MachinesTab | ProfileTab` (drop `RequestsTab`).
- Add `MobileDevice`, `Profile`, and `pairing` fields on `Machine`
  (`paired_device_id`, `paired_at`, `connection: 'this' | 'other' | 'none'`).
- Remove `QRPayload`'s auth role note; keep the shape for the scanner.

### 5.7 Push (`hooks/usePushNotifications.ts`)
- `registerPushToken` now posts `{ token, platform, deviceId }`; server upserts
  by `device_id`. Navigation-on-tap unchanged, but route to the Chats tab feed
  (Requests tab is gone) — update `navigateToRequest` to open the relevant
  session chat (`ChatsTab → Chat`) or a request-detail screen reachable from it.

### 5.8 Fresh-start cleanup (decision: wipe old creds)
On first launch of the new build, clear the legacy MMKV `machine-credentials`
store so stale QR-only creds don't linger:
```ts
// one-time migration guard in app bootstrap
createMMKV({ id: 'machine-credentials' }).clearAll()
```

---

## 6. Desktop changes (`vRdeksMultiharness/src`)

The desktop already has Register / Sign In (`components/Auth.jsx`, gated in
`App.jsx`) and machine registration/selector (`Dashboard.jsx`,
`MachineSelector.jsx`). Only the **Mobile Connection** card changes.

### 6.1 `components/Dashboard.jsx` — conditional QR / paired-device card
Replace the static "Mobile Connection" `<section>` (currently always renders the
QR) with pairing-aware UI:

**Do not poll every 5s forever.** Pairing changes in exactly one moment — right
after the QR is shown, while waiting for a phone to scan. An always-on 5s poll is
12 req/min per open desktop, indefinitely, each now also doing auth work. Use
**Realtime (preferred)** or **adaptive polling**.

> ⚠️ **Realtime prerequisites** — the desktop reads machines via the server
> (service key) today, so the `machines` table almost certainly has **neither**
> (a) membership in the `supabase_realtime` publication, nor (b) an RLS `SELECT`
> policy letting the owner's user client see its own row. Both are required for
> `postgres_changes` to deliver. Add to migration `007` if you go this route:
> ```sql
> alter publication supabase_realtime add table machines;
> alter table machines enable row level security;
> create policy "owner reads own machines" on machines
>   for select using (user_id = auth.uid());
> ```
> If you don't want to expose `machines` over Realtime/RLS, **use the adaptive
> polling fallback below** — it needs no schema changes.

*Preferred — Supabase Realtime subscription on the machine row (push, zero idle cost):*
```jsx
const [pairing, setPairing] = useState(null) // { paired, device, paired_at }
useEffect(() => {
  if (!machineConfig?.machineId) return
  loadPairing()  // one fetch for initial state
  const ch = supabase
    .channel(`machine:${machineConfig.machineId}`)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'machines',
      filter: `id=eq.${machineConfig.machineId}`,
    }, () => loadPairing())   // re-fetch only when paired_device_id actually changes
    .subscribe()
  return () => supabase.removeChannel(ch)
}, [machineConfig?.machineId])
```

*Fallback — adaptive polling (fast only while unpaired/QR visible, then idle):*
```jsx
useEffect(() => {
  if (!machineConfig?.machineId) return
  let stop = false
  const tick = async () => {
    if (stop) return
    await loadPairing()
    // fast (4s) only while no phone is paired; slow (60s) once connected
    const delay = pairingRef.current?.paired ? 60_000 : 4_000
    timer.current = setTimeout(tick, delay)
  }
  tick(); return () => { stop = true; clearTimeout(timer.current) }
}, [machineConfig?.machineId])
```
After **Remove device**, set local state to unpaired so the next tick (or the
Realtime event) resumes the fast cadence and the QR returns immediately.

Render:
- `pairing?.paired` **false/null** → show the existing `<QRCodeSVG>` (unchanged
  `qrData`) with copy text "Scan with the Vibe Remote app to connect a phone."
- `pairing?.paired` **true** → hide QR, show a **device card**: device name,
  platform, "Connected · paired {relativeTime(paired_at)}", and a **Remove
  device** button:
  ```js
  async function removeDevice() {
    const { data:{ session:s } } = await supabase.auth.getSession()
    await fetch(`${API_URL}/machines/${machineConfig.machineId}/pair`,
      { method:'DELETE', headers:{ Authorization:`Bearer ${s.access_token}` } })
    setPairing({ paired:false })   // QR returns immediately; poll confirms
  }
  ```

This satisfies: *"QR should only show when the machine is not connected … if
connected, that device should show … remove the connected mobile … when removed
the QR again should show."*

### 6.2 No change needed
- `Auth.jsx`, `App.jsx`, `MachineSelector.jsx`, registration/reclaim flow, the
  relay daemon, `preload.js` (`window.relay` / `window.harness`) — all stay.
  The QR payload generation (`qrData`) is unchanged; the desktop only gates its
  *visibility* on pairing state now.

---

## 7. Cross-repo contract summary (new/changed endpoints)

Auth column: **fast** = `requireUserAuthFast` (local HS256 verify, hot path);
**remote** = `requireUserAuth` (GoTrue `getUser`, rare/security-sensitive).

| Method | Path | Auth | Used by | Notes |
|---|---|---|---|---|
| POST | `/machines/devices` | remote | mobile | register phone → `deviceId` |
| GET | `/machines/devices` | fast | mobile/profile | list this user's devices |
| DELETE | `/machines/devices/:id` | remote | mobile | unregister device, null pairings, bust cache |
| POST | `/machines/:id/pair` | remote | mobile (QR) | `{apiKey, deviceId}`; optimistic lock; 409 if paired elsewhere |
| DELETE | `/machines/:id/pair` | remote | mobile + desktop | unpair, bust cache |
| GET | `/machines/:id/pairing` | fast | desktop | drives QR vs device card (Realtime-backed) |
| GET / PATCH | `/profile` | fast / remote | mobile | read fast; PATCH may use fast |
| POST | `/profile/password` | remote | mobile | change password |
| DELETE | `/profile` | remote | mobile | delete account |
| ALL | `/mobile/*` (except `command/next`) | **fast** (was machine key) | mobile | + `x-device-id`, single-query paired scope |
| POST | `/mobile/realtime-token` | **fast** | mobile | sign JWT for `req.user.id` |
| POST | `/mobile/push-token` | fast | mobile | now `device_id`-scoped |

---

## 8. Build / rollout order (do server → mobile → desktop)

1. **Server**
   1. Write & apply migration `007` — **including the four indexes** (§3).
   2. Add `requireUserAuthFast` (local JWT verify) to `middleware/auth.js`;
      confirm `SUPABASE_JWT_SECRET` is set (§4.1).
   3. Add device + pairing + profile routes (`machines.js` / new `profile.js`),
      with the guarded-update optimistic lock + `_pairCache` busting (§4.3).
   4. Flip `/mobile/*` to `requireUserAuthFast` + `attachDevice` + **single-query**
      paired-machine scoping (Pattern A join / Pattern B cache). **Audit every
      `req.machine` reference.**
   5. Update `notify.js` → `notifyMachine` (single join/RPC); update `relay.js`
      upload caller. Tune the rate limiter to key by user id (§4.5).
   6. `pm2 restart all`; smoke-test with a manual JWT. **Verify with `EXPLAIN`
      that the scoping + push queries hit the new indexes** (not seq scans).
2. **Mobile**
   1. Rewrite `useAuth` + store (session/deviceId); add Auth stack (SignIn/SignUp).
   2. Rewrite `api/server.ts` transport (in-memory token + `x-device-id`); add
      device/pair/profile calls; fix `api/realtime.ts` (clear on auth change).
   3. Rework tabs: remove Requests, add Profile; add Chats machine-chip filter
      (client-side filter over the already-fetched paired sessions).
   4. Repurpose `QRScanScreen` to pairing; build Profile screen; wire push token
      to device.
   5. One-time wipe of legacy `machine-credentials` MMKV.
3. **Desktop**
   1. Replace the always-on QR poll with Realtime/adaptive pairing state, plus the
      conditional QR/device card in `Dashboard.jsx` (§6.1).

> Because mobile uses **fresh start**, ship mobile + server together; the old
> app version stops working once `/mobile/*` requires a user JWT.

---

## 9. Risks / things to verify

- **`/mobile/*` auth audit**: `mobile.js` has ~20 `req.machine.*` references.
  Missing one = a route that 500s or leaks/scopes wrong. Grep
  `req\.machine` across `src/routes/mobile.js` before shipping.
- **`command/next` must stay machine-key auth** — it's called by the relay
  daemon (`relay-deamon1/scripts/heartbeat.js`), not the phone. Don't flip it.
- **Realtime token**: ensure `SUPABASE_JWT_SECRET` path is used; the magic-link
  fallback signs for the *machine's* user — now should sign for `req.user.id`.
- **Push routing**: confirm `push_tokens` rows get `device_id` populated, and
  `notifyMachine` resolves via `machines.paired_device_id`. A machine with no
  paired phone should silently send nothing (not error).
- **Pairing race**: handled by the guarded `.is('paired_device_id', null)`
  optimistic update in §4.3 — verify both racing phones don't both get `200`.
- **Account delete cascade**: `mobile_devices`, `machines.paired_device_id`,
  `push_tokens`, `profiles` all cascade/null on `auth.users` delete — verify FKs.
- **Avatar storage**: decide Supabase Storage bucket vs external URL before
  building the Profile avatar uploader (out of scope to pick here).

### 9.1 Performance acceptance checks (must pass before shipping)
- **No remote `getUser()` on the hot path**: grep `getUser(` — it must appear
  only in `requireUserAuth` (used by the rare write routes), never on `/mobile/*`.
- **One DB round-trip per `/mobile` read**: log/inspect query counts for
  `GET /mobile/sessions` — exactly one statement (Pattern A) or one + a cache hit
  (Pattern B), never two queries.
- **Indexes used**: `EXPLAIN (ANALYZE)` the scoping join and `notifyMachine`
  query — confirm index scans on `idx_machines_user_paired` /
  `idx_machines_paired_device` / `idx_push_tokens_device`, no seq scans.
- **No idle desktop polling**: with a machine paired, confirm the desktop makes
  ≤1 pairing request/min (Realtime) or the slow 60s cadence (adaptive), not 12/min.
- **No per-request `getSession()` on mobile**: grep `getSession(` in
  `api/server.ts` — the transport reads the in-memory store token instead.
- **Machines tab is not N+1**: opening it issues one `/machines/mine` request,
  not one-per-card pairing fetches.

---

## 10. File-by-file change checklist

**server** (`vibe_remote(serverside)`)
- [ ] `migrations/007_user_accounts_pairing.sql` (new) — **incl. 4 indexes (§3)**
- [ ] `src/middleware/auth.js` (`requireUserAuthFast` local JWT verify + `attachDevice`)
- [ ] `src/routes/mobile.js` (flip to fast auth, **single-query** paired scoping)
- [ ] `src/routes/machines.js` (devices + pair w/ optimistic lock + cache bust + pairing + delete)
- [ ] `src/routes/profile.js` (new) + mount in `src/index.js`
- [ ] `src/routes/harness.js` (`GET /:machineId` → fast auth — polled hot path)
- [ ] `src/notify.js` (`notifyMachine` via `machine_push_tokens` RPC) + `src/routes/relay.js` caller (`req.machine.id`)
- [ ] `src/index.js` (per-router user-keyed limiter *after* auth; keep global IP limiter)

**mobile** (`vibe_remote(reactNative)/AgentControl/src`)
- [ ] `hooks/useAuth.ts` (Supabase session)
- [ ] `store/useAppStore.ts` (session/deviceId)
- [ ] `api/server.ts` (in-memory-token transport + pair/device/profile calls)
- [ ] `api/device.ts` (new — deviceId persistence)
- [ ] `api/realtime.ts` (JWT token fetch + clear on auth change)
- [ ] `navigation/RootNavigator.tsx` (Auth gate, tabs Chats/Machines/Profile)
- [ ] `screens/Auth/SignInScreen.tsx`, `SignUpScreen.tsx` (new)
- [ ] `screens/Auth/QRScanScreen.tsx` (repurpose → pairing)
- [ ] `screens/Sessions/SessionsScreen.tsx` (machine filter chips)
- [ ] `screens/Machines/MachinesScreen.tsx` (connect/disconnect/delete)
- [ ] `screens/Profile/ProfileScreen.tsx` (new)
- [ ] `hooks/usePushNotifications.ts` (device-scoped token + nav target)
- [ ] `types/index.ts` (nav params, MobileDevice, Profile, pairing fields)
- [ ] app bootstrap (one-time legacy MMKV wipe)

**desktop** (`vRdeksMultiharness/src`)
- [ ] `components/Dashboard.jsx` (Realtime/adaptive pairing state + conditional QR / device card — no always-on 5s poll)
```
