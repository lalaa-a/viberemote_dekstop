# Pairing Troubleshooting — "Loading pairing state…" / 403 / 404

This document explains the chain of problems we hit while bringing up the new
**user-accounts + machine↔phone pairing** feature, what caused each one, and how
each was fixed. Read it top-to-bottom — the bugs were uncovered in this order,
and each fix revealed the next problem underneath.

---

## TL;DR

Pairing only works when **three things belong to the same Supabase user account**:

1. The **machine** row in the database (`machines.user_id`)
2. The account the **desktop app** is signed into
3. The account the **mobile app** is signed into

Every error below was ultimately a violation of that rule, plus some stale
local/cached state that made the violation hard to see.

---

## The data model (why "same account" matters)

```
auth.users ──┬── machines           (machines.user_id  → auth.users.id)
             └── mobile_devices      (mobile_devices.user_id → auth.users.id)

machines.paired_device_id → mobile_devices.id   (the actual pairing link)
```

The pairing endpoint on the server does an **ownership check** before it will
report or change anything:

```js
// GET /machines/:machineId/pairing
const { data: m } = await db.from('machines').select('user_id, ...').eq('id', machineId).single()

if (!m)                         return res.status(404)  // machine doesn't exist
if (m.user_id !== req.user.id)  return res.status(403)  // machine owned by someone else
```

- `req.user.id` comes from the **JWT of whoever is logged in** (desktop or mobile).
- `m.user_id` is **who owns the machine** in the DB.

So a `403` literally means *"this machine exists, but the account you're logged
in as is not its owner."* A `404` means *"no such machine."*

---

## Problem 1 — Mobile: `Invalid or expired token`

### Symptom
```
[FCM] Failed to register push token: Invalid or expired token
```
Every authenticated request from the mobile app was rejected by the server.

### Cause
The server verifies the user's JWT **locally** for hot-path routes
(`requireUserAuthFast`), using the project's symmetric signing secret:

```js
jwt.verify(token, process.env.SUPABASE_JWT_SECRET, { algorithms: ['HS256'] })
```

The mobile app's `.env` pointed at a **completely different Supabase project**
than the server:

| App            | Supabase URL                          | JWT signing secret |
|----------------|---------------------------------------|--------------------|
| Desktop + Server | `https://database.insight25.lk` (self-hosted) | `Wu2NA+…` |
| **Mobile (wrong)** | `https://mfddppnjxknjipxfiwzh.supabase.co` (hosted) | *different secret* |

The mobile signed in against the **hosted** project, so its tokens were signed
with the hosted project's secret. The server tried to verify them with the
**self-hosted** secret — they could never match → `Invalid or expired token`.

### Fix
- Repointed mobile `.env` `SUPABASE_URL` / `SUPABASE_ANON_KEY` to the same
  self-hosted instance the desktop and server use (`database.insight25.lk`).
- Added a one-time guard in `src/api/supabase.ts`: if the stored Supabase URL
  changed since last launch, wipe the cached auth session so the old project's
  tokens don't linger.

---

## Problem 2 — Mobile: `x-device-id header required`

### Symptom
```
[FCM] Failed to register push token: x-device-id header required
```
Auth now passed (good — Problem 1 was fixed), but `POST /mobile/push-token`
needs the phone's device id, and it wasn't being sent.

### Cause
A **startup race condition**:

- `usePushNotifications` fires early (deep in the component tree) and tries to
  register the FCM push token immediately.
- `DeviceBootstrap` is what registers the phone as a device and stores the
  `deviceId` — but it hadn't finished yet.
- So the push-token request went out with **no `x-device-id`** header.

### Fix
- `savePushToken()` now caches the token in `_pendingPushToken` if no `deviceId`
  exists yet, instead of firing a doomed request.
- `DeviceBootstrap` calls `flushPushToken()` **after** the `deviceId` is set,
  sending the cached token at the right time.
- On later launches the `deviceId` is already in MMKV, so the token registers
  directly with no waiting.

---

## Problem 3 — Desktop: stuck on "Loading pairing state…"

### Symptom
The desktop "Mobile Connection" card showed *"Loading pairing state…"* forever
and never displayed the QR code.

### Cause
`loadPairing()` **silently swallowed errors**. If the pairing request failed for
any reason, `pairing` stayed `null`, and `null` renders as the loading text. The
UI had no way to recover or show what went wrong.

### Fix
`loadPairing()` now, on any failure:
- Falls back to `{ paired: false }` so the **QR code shows** instead of freezing.
- Records the error (`_error`) and renders it **in the card** as a red line, so
  the real status code + message is visible without opening devtools.

This didn't fix the *underlying* failure — it made it **visible**, which exposed
Problems 4 and 5.

---

## Problem 4 — Desktop: `403: Forbidden`

### Symptom
```
Pairing check failed — 403: Forbidden
```

### Cause — multi-account drift
Testing over time had created several accounts, and they got tangled:

| User ID     | Email                          | Owned                              |
|-------------|--------------------------------|------------------------------------|
| `19e07e46`  | lalinda.ravishan@aiesec.net    | desktop machine **"leeshar"**      |
| `c11bb202`  | akila2001a@gmail.com           | old machine "LAPTOP-UFROM0H1"      |
| `3727947d`  | lwravishan@gmail.com           | the mobile device **"Phone"**      |
| `c6103250`  | *(deleted user)*               | stale ref in `relay-deamon1/.env`  |

The machine "leeshar" was owned by **lalinda**, but the desktop was logged in as
a **different** account → `m.user_id !== req.user.id` → `403`.

On top of that, the **mobile** was logged in as **lwravishan** — a *third*
account — so even fixing the desktop wouldn't let it pair with a machine owned by
lalinda.

> ### ⚠️ Important nuance: local config ≠ login
> The desktop reads its machine identity from
> `%APPDATA%/my-app/machine.env` (see `RELAY_ENV` in `src/main.js`). That file
> stores a `USER_ID` written **at registration time**. But authorization is based
> on the **live Supabase session** (whoever is signed in *right now*), **not** the
> `USER_ID` text in the file. So the file can say one user while the app is logged
> in as another — exactly the trap we fell into.

### Fix (at the time)
Reassigned the machine "leeshar" to the chosen account (`lwravishan`, which the
mobile already used) directly in the DB, and updated the local `machine.env`
`USER_ID` to match. The remaining step was to ensure the **desktop signs in as
the same account**.

---

## Problem 5 — Desktop: `404: Machine not found` (after wiping the DB)

### Symptom
```
Pairing check failed — 404: Machine not found
```
This appeared right after **all database tables were emptied**.

### Cause
Two layers of stale state:

1. **DB wipe removed the machine** (and *every* user except
   `tecadonsolutions@gmail.com`). So the machine the desktop was asking about no
   longer existed → `404`.
2. **The desktop kept the old `machine.env`.** Its `initMachine()` logic only
   registers a new machine when **no local config exists** — see the comment at
   `src/main.js:25`. Because a stale `MACHINE_ID` was still on disk, the desktop
   kept polling a **deleted** machine instead of registering a fresh one.

There's also a hidden hazard after wiping `auth.users`: the apps may still hold
**cached sessions for now-deleted users**. Those JWTs still pass the local
signature check (`requireUserAuthFast`), but any operation that hits **remote**
auth or a foreign key to `auth.users` (device/machine registration) will fail,
because the user genuinely no longer exists.

### Fix
- Deleted the stale desktop `machine.env` so `initMachine()` registers a fresh
  machine on next launch.
- Reset procedure (below) to get desktop + mobile onto one real account.

---

## The clean reset procedure

Everything must end up under **one account that actually exists** in
`auth.users`. After the wipe, only `tecadonsolutions@gmail.com` survived — use
that on both apps, or sign up a brand-new account and use it on both.

### Desktop
1. If signed in as a deleted/other user → **Sign Out**.
2. **Sign in / sign up** as the chosen account.
3. **Reload** (`Ctrl+R`). With `machine.env` deleted, the desktop auto-registers
   a fresh machine under this account and shows the **QR code**.

### Mobile
1. **Sign out** (Profile tab) to clear any session for a deleted user. If
   sign-out misbehaves, clear app data / reinstall.
2. **Sign in / sign up** as the **same account** used on the desktop.
3. The app auto-registers a fresh device.

### Pair
- Mobile → **Machines tab → Connect** → scan the desktop QR.
- Machine owner == desktop login == mobile login → pairing succeeds, and the
  desktop card flips to "connected phone".

---

## Mental checklist for "pairing won't work"

1. **Same Supabase project everywhere?** Desktop `.env`, mobile `.env`, and
   server `.env` must share the same `SUPABASE_URL` and JWT secret.
   *(Problem 1)*
2. **Both apps signed into the same account?** Check the email in each app.
   *(Problems 4 & 5)*
3. **Does the machine exist in the DB and is it owned by that account?**
   `403` = wrong owner, `404` = doesn't exist. *(Problems 4 & 5)*
4. **Any stale local state?**
   - Desktop machine identity: `%APPDATA%/my-app/machine.env`
   - Mobile cached session / deviceId: MMKV stores
   Delete/clear these if they reference deleted or mismatched accounts.
   *(Problems 2 & 5)*
5. **Did you wipe `auth.users`?** Then every cached session is for a ghost user.
   Sign out + sign in fresh on both apps. *(Problem 5)*
