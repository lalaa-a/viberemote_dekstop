# Changes Made — User Accounts + Machine↔Phone Pairing

## Server (`vibe_remote(serverside)`)

### New files
- **`migrations/007_user_accounts_pairing.sql`** — Adds `mobile_devices` table, `paired_device_id` + `paired_at` columns on `machines`, `profiles` table, device-scoped `push_tokens.device_id` column, four performance indexes, `machine_push_tokens()` SQL RPC, and Realtime/RLS prerequisites for the `machines` table.

- **`src/routes/profile.js`** — New profile router mounted at `/profile`:
  - `GET /profile` — read email + display name + avatar (fast auth)
  - `PATCH /profile` — update display name / avatar (fast auth)
  - `POST /profile/password` — change password (remote auth)
  - `DELETE /profile` — delete account and all data (remote auth)

### Modified files

**`src/middleware/auth.js`**
- Added `requireUserAuthFast` — verifies Supabase JWT locally with `SUPABASE_JWT_SECRET` (HS256, no network call). Used on all hot-path routes.
- Added `attachDevice` — reads `x-device-id` header into `req.deviceId`.

**`src/routes/mobile.js`** — full rewrite
- All routes now use `requireUserAuthFast` + `attachDevice` instead of `requireMachineAuth`.
- Paired-machine scoping via Pattern A (`!inner` join on `machines`) or Pattern B (in-process 60s cache `pairedMachineIds()`).
- Per-router user-keyed rate limiter (300/min by user ID) applied after auth.
- `GET /mobile/machine` replaced with `GET /mobile/me`.
- `POST /mobile/realtime-token` now signs JWT for `req.user.id` (not machine user).
- `GET /mobile/machines` returns inline `connection: 'this'|'other'|'none'` — no N+1 per-card calls.
- `POST /mobile/push-token` now upserts by `device_id` instead of `machine_id`.
- `POST /mobile/decide` uses cached `pairedMachineIds` + `.in()` (PostgREST UPDATE cannot join).
- `GET /mobile/command/next` removed — moved to `index.js` under machine auth.
- Exported `pairedMachineIds()` and `bustPairCache()` for use by `machines.js`.

**`src/routes/machines.js`**
- Added `POST /machines/devices` — register phone, returns `deviceId`.
- Added `GET /machines/devices` — list user's devices.
- Added `DELETE /machines/devices/:id` — unregister device, busts pair cache.
- Added `POST /machines/:id/pair` — pair machine to device; verifies API key hash; optimistic lock (`.is('paired_device_id', null)`) prevents race condition; 409 if already paired elsewhere.
- Added `DELETE /machines/:id/pair` — unpair machine, busts pair cache.
- Added `GET /machines/:id/pairing` — desktop polls this; returns `{ paired, device, paired_at }`.
- `GET /machines/mine` now returns `connection` + pairing fields inline; switched to `requireUserAuthFast`.

**`src/routes/harness.js`**
- `GET /harness/:machineId` switched from `requireUserAuth` to `requireUserAuthFast` (polled every 30s by the Machines tab — was a hot-path remote round-trip).

**`src/notify.js`**
- Added `notifyMachine(machineId, ...)` — resolves push tokens via `machine_push_tokens()` RPC (one indexed query, device-scoped).
- Kept `notifyUser` for any broadcast use-cases.
- Extracted shared `sendToTokens()` helper used by both.

**`src/routes/relay.js`**
- Upload handler: `notifyUser(req.machine.user_id, …)` → `notifyMachine(req.machine.id, …)`.

**`src/index.js`**
- `GET /mobile/command/next` extracted into a separate `commandRouter` mounted at `/mobile/command` **before** the mobileRouter — keeps machine-key auth for the relay daemon without touching the user-auth middleware.
- Mounted `profileRouter` at `/profile`.

---

## Mobile (`vibe_remote(reactNative)/AgentControl/src`)

### New files
- **`api/device.ts`** — MMKV persistence for `deviceId` (`getDeviceId`, `saveDeviceId`, `clearDeviceId`).
- **`screens/Auth/SignInScreen.tsx`** — Email + password sign-in via `supabase.auth.signInWithPassword`.
- **`screens/Auth/SignUpScreen.tsx`** — Email + password registration; shows "check your email" on success.
- **`screens/Profile/ProfileScreen.tsx`** — Editable display name, change password, delete account, sign out.

### Modified files

**`store/useAppStore.ts`**
- Removed `credentials: MachineCredentials`.
- Added `session: Session | null` and `deviceId: string | null`.

**`hooks/useAuth.ts`** — rewritten
- Subscribes to `supabase.auth.onAuthStateChange`; keeps store in sync.
- Exposes `session`, `user`, `loading`, `signIn`, `signUp`, `signOut`, `resetPassword`.
- Calls `clearRealtimeClient()` on sign-out and `TOKEN_REFRESHED`.

**`api/server.ts`** — rewritten
- Reads access token from in-memory Zustand store (sync, no `await getSession()` stampede).
- Sends `Authorization: Bearer <token>` + `x-device-id` on every request.
- Removed all machine-key (`x-machine-api-key`) code.
- Removed `getCredentials / saveCredentials / clearCredentials / MachineCredentials / verifyCredentials`.
- Added `registerDevice`, `pairMachine`, `unpairMachine`.
- Added `fetchProfile`, `updateProfile`, `changePassword`, `deleteAccount`.
- Added `deleteMachine`, `unpairMachine`.
- Legacy `machine-credentials` MMKV store is wiped on import (fresh-start).

**`api/realtime.ts`** — rewritten
- Gates on `session` (not machine credentials).
- Fetches realtime token with user JWT header.
- Uses `Config.API_URL` / `Config.SUPABASE_URL` instead of `creds.*`.

**`api/machines.ts`**
- Updated re-exports to include `deleteMachine` and `unpairMachine`.

**`hooks/usePushNotifications.ts`**
- `registerPushToken` now sends `deviceId` in the payload (device-scoped).
- `navigateToRequest` navigates to `ChatsTab → RequestDetail` (Requests tab removed).

**`types/index.ts`**
- `RootStackParamList`: `SignIn` → `Auth | App | QRScan`.
- `TabParamList`: removed `RequestsTab`, added `ProfileTab`; order is `ChatsTab | MachinesTab | ProfileTab`.
- Added `AuthStackParamList: { SignIn, SignUp }`.
- Added `MobileDevice` interface.
- Added `Profile` interface.
- `Machine`: added `paired_device_id`, `paired_at`, `connection`, `paired_device` fields.
- `QRPayload`: removed `supabaseUrl` / `apiUrl` (no longer needed for auth).

**`navigation/RootNavigator.tsx`** — rewritten
- Auth gate: `session` → `AppNavigator` / `AuthNavigator` (was `credentials` → App / QRScanScreen).
- `AuthNavigator`: SignIn + SignUp stack.
- Tabs reordered: **Chats → Machines → Profile** (Requests tab removed).
- `QRScan` screen registered as a root-level modal (navigated to from Machines tab).
- `DeviceBootstrap` component: after first sign-in, registers the device if no `deviceId` in MMKV.
- Badge only on ChatsTab (pending approvals).

**`screens/Auth/QRScanScreen.tsx`** — repurposed
- Removed: `saveCredentials`, `verifyCredentials`, `setCredentials` flow.
- Now calls `pairMachine(machineId, apiKey, deviceId)`.
- Handles: `200 ok` → toast + goBack; `alreadyPaired` → toast "Already connected"; `409 paired_elsewhere` → alert.

**`screens/Sessions/SessionsScreen.tsx`**
- Added horizontal `MachineChips` filter row under the header.
- Chips come from `GET /mobile/machines`; selecting one sets `selectedMachineId` in store.
- Session list is client-side filtered by `selectedMachineId`.

**`screens/Machines/MachinesScreen.tsx`** — rewritten
- Header "Disconnect" button replaced with "Connect" (Scan QR) button.
- Per-card `connection` indicator: shows paired-to-this / paired-elsewhere / none.
- **Disconnect** action per card (`DELETE /machines/:id/pair`).
- **Delete** action per card (`DELETE /machines/:id`).
- Sign-out moved to Profile tab.

---

## Desktop (`vRdeksMultiharness/src`)

**`src/components/Dashboard.jsx`**
- "Mobile Connection" card replaced with pairing-aware UI.
- Adaptive poll: 4s while unpaired (QR visible), 60s once paired.
- **Unpaired** → shows existing `<QRCodeSVG>` unchanged.
- **Paired** → hides QR, shows device name + platform + connected date + **Remove device** button.
- Removing a device immediately sets local state to unpaired (QR returns) and resumes fast polling.
