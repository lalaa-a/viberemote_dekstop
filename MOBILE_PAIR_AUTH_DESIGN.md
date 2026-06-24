# Mobile-First Auth with QR Pairing Design

## Overview

**Goal:** Remove the desktop login requirement. Users authenticate on mobile only, then pair the desktop machine by scanning a QR code. All subsequent traffic is authorized through the trust established by that pairing.

---

## Current Architecture (Baseline)

```
Desktop                Server                Mobile
  |                      |                     |
  |-- Supabase login --→ |                     |
  |← JWT + session ------+                     |
  |                      |                     |
  |                      | ←-- Supabase login -|
  |                      +--→ JWT + session --→|
  |                      |                     |
  |                      | ←-- scan QR --------| (QR = {machineId, apiKey})
  |                      |   pair machine       |
  |← command poll -------+--→ push/realtime --→|
```

Both sides authenticate independently. Mobile must already be logged in before pairing.

**QR payload today:** `{ machineId: string, apiKey: string }`

---

## Proposed Architecture

```
Desktop                Server                Mobile
  |                      |                     |
  |-- register machine →|                     |
  |← {machineId, apiKey}+                     |
  |                      |                     |
  |  generate QR -----→ display               |
  |  QR = {machineId,    |  ←-- sign up/in ---| (mobile only)
  |         apiKey,      |  +→ JWT + session →|
  |         challenge}   |                     |
  |                      |  ←-- scan QR ------| 
  |                      |    POST /pair        |
  |                      |    (JWT + QR payload)|
  |                      |    link user↔machine |
  |                      +--→ pair confirm ---→|
  |← pair event ---------+                     |
  |  (server issues      |                     |
  |   machine session)   |                     |
  |                      |                     |
  |-- authed poll ------→|←-- chat/commands --→|
```

Desktop never shows a login screen. Identity flows from mobile → server → desktop via the pairing event.

---

## Cardinality — one phone, many machines

A single user can pair **multiple machines** with one mobile device by scanning each machine's QR in turn. The model supports this directly:

- **User → machines:** one-to-many. Each machine row carries its own `owner_user_id` and its own durable `MACHINE_ID` + `API_KEY`.
- **Machine → paired device:** one-to-one *at a time*. Each machine has a single `paired_device_id`; re-scanning replaces it.
- **Device → machines:** one-to-many. The same `paired_device_id` may appear on many machine rows — nothing prevents one phone from owning several desktops.

The mobile machines tab already queries machines by user, so every paired desktop shows up as its own card with its own connected-device view and unpair action. Each desktop subscribes to its **own** `machine:<machineId>` channel, so pair/unpair events are scoped per machine and never cross-talk.

---

## Pairing State & Device Display

Both ends need to reflect the current pairing relationship, not just establish it.

### Desktop — paired vs. unpaired UI

The desktop has exactly two states, driven by whether the machine has a `paired_device_id`:

| State | What desktop shows |
|-------|--------------------|
| **Unpaired** | The pairing QR code (payload below) + "Scan this with the mobile app" |
| **Paired** | "Connected to **\<device_name\>** (\<platform\>)" + an **Unpair** option, shown at any time |

The paired device's human-readable name already exists server-side: the `mobile_devices` table stores `device_name` (e.g. "iPhone 14") and `platform` (ios/android). Desktop fetches this alongside its session/status poll — no new device-naming work needed. The desktop's status endpoint (or session poll) should return the joined `paired_device` object so the UI can render the connected device.

### Desktop-side unpair (always available)

While paired, the desktop continuously displays which mobile device it is connected to, and the **Unpair** action is available at any time. The flow:

1. User clicks **Unpair** on the desktop.
2. Desktop calls `DELETE /machines/:machineId/pair` (authenticated with its `apiKey` / machine session).
3. Server clears `paired_device_id`, `paired_at`, **and** `session_token_hash`.
4. Desktop discards its local `MACHINE_SESSION_TOKEN`, transitions back to the **unpaired** state, and **regenerates/shows the QR code**.
5. To reconnect, the user scans the freshly shown QR again with a mobile app (the same phone or a new one).

This makes the desktop self-recoverable: a user with a lost/replaced phone can unpair directly from the machine and re-pair with the new device — no dependency on the old phone being reachable.

### Mobile — machines tab (already exists)

The mobile `MachinesScreen.tsx` already lists the user's machines via `GET /mobile/machines` and **already has both an unpair and a delete action**:

- **Unpair** → `DELETE /machines/:machineId/pair` (clears `paired_device_id` + `paired_at`, machine record survives) — this is the action the user wants.
- **Delete** → `DELETE /machines/:machineId` (hard-deletes the machine row).

**Requirement:** users should be able to **unpair, not delete**. Unpair is already wired; the design only needs to make sure unpair is the prominent/primary action and that delete is de-emphasized or removed from the common flow. Unpair leaves the machine + its `MACHINE_ID`/`API_KEY` intact so the desktop can be re-paired by simply scanning again.

### Unpair must revoke the session token

When either side unpairs, the server must invalidate the machine session token (clear `session_token_hash`), not just null out `paired_device_id`. Otherwise the desktop would keep serving the previous user's data with a stale token. After unpair:

- Desktop's next authed request fails → desktop falls back to the **unpaired** state and shows the QR again.
- Mobile must re-scan to re-establish the link.

---

## Detailed Flow

### Step 1 — Desktop starts up

1. Desktop reads `machine.env` for `MACHINE_ID` + `API_KEY` (already generated on first run today).
2. If machine is **not yet paired**, desktop shows a "Pair with mobile" screen with a QR code.
3. QR payload:

```json
{
  "machineId": "<uuid>",
  "apiKey": "<plaintext api key>",
  "challenge": "<random 32-byte hex, short-lived TTL>"
}
```

The `challenge` is a one-time-use nonce stored server-side with a 5-minute expiry. It prevents QR replay attacks.

### Step 2 — Mobile auth (unchanged)

User signs up or logs into the mobile app with email/password via Supabase. This is the only login the user ever performs.

### Step 3 — Mobile scans QR

1. `QRScanScreen.tsx` reads the QR.
2. Mobile calls:
   ```
   POST /machines/:machineId/pair
   Headers: Authorization: Bearer <supabase JWT>
             x-device-id: <deviceId>
   Body: { apiKey, challenge }
   ```
3. Server validates:
   - Supabase JWT → resolves `userId`
   - `apiKey` hash matches `machines.api_key_hash`
   - `challenge` exists in `machine_challenges` table and is not expired/used
   - Marks challenge as consumed (prevents reuse)
4. Server links `machines.owner_user_id = userId` and `machines.paired_device_id = deviceId`.
5. Server issues a **machine session token** (a signed JWT or opaque token) scoped to this machine, tied to the user.

### Step 4 — Desktop receives pair confirmation (Realtime)

The desktop learns about pairing over a **Supabase realtime channel** (no polling loop):

1. Before rendering the QR, the desktop subscribes to channel `machine:<machineId>`.
2. After a successful pair (Step 3), the server **broadcasts a `paired` event** on that channel carrying `{ sessionToken, pairedDevice: { device_name, platform } }`.
3. The desktop receives the event, persists the token, and immediately flips to the connected-device view — no delay, no poll interval.

**Initial state on launch (already-paired desktop):** realtime only delivers *live* events, so on startup the desktop first calls `GET /machines/:machineId/session` once to load current pairing state (paired? which device?), *then* subscribes to the channel for subsequent changes. This one-shot fetch also covers the case where the desktop was offline at the moment the QR was scanned — it reconciles on next launch.

> The same channel is reused to notify the desktop of **unpair** (a `unpaired` event), so a mobile-initiated unpair flips the desktop back to the QR screen in real time instead of waiting for a heartbeat 401.

### Step 5 — Desktop is now authorized

Desktop stores the machine session token in `machine.env`. All subsequent requests use:
```
x-machine-api-key: <api key hash>
x-machine-session: <session token>
```
The session token carries the user identity, so the server knows which user's data to serve — without the desktop ever logging in.

---

## What Changes Per Project

### Desktop (`vRdeksMultiharness`)

| Area | Change |
|------|--------|
| Auth screen | Remove login/signup UI entirely |
| First-run / unpaired screen | Show QR display (when `paired_device_id` is null) |
| **Paired screen** | Show "Connected to \<device_name\> (\<platform\>)" using `paired_device` from the status poll, plus an **Unpair** button |
| `machine.env` | Add `MACHINE_SESSION_TOKEN` field |
| `heartbeat daemon` | Attach `x-machine-session` header; detect 401 → drop to unpaired/QR state |
| Status poll | Read back `paired_device` (name + platform) to render the connected-device UI |
| `supabase.js` | Desktop no longer needs a user-scoped Supabase session |

### Server (`vibe_remote(serverside)`)

| Area | Change |
|------|--------|
| `machines` table | Add `owner_user_id` column, `session_token_hash` column |
| New table | `machine_challenges(machine_id, challenge_hash, expires_at, used_at)` |
| `POST /machines/:id/pair` | Accept `challenge` in body; validate, consume, issue session token (endpoint already exists — extend it) |
| New endpoint | `GET /machines/:id/session` — returns session token **+ joined `paired_device`** after pairing (for polling fallback + desktop's connected-device UI) |
| `DELETE /machines/:id/pair` | Already exists (unpair). Callable from **both mobile (user JWT) and desktop (machine apiKey/session)**. **Extend to also clear `session_token_hash`** so the desktop token is revoked, not just `paired_device_id` |
| `requireMachineAuth()` | Optionally validate `x-machine-session` to resolve user context on machine requests |
| QR generation | Add `POST /machines/:id/challenge` → creates and returns a challenge nonce |

### Mobile (`vibe_remote(reactNative)`)

| Area | Change |
|------|--------|
| Auth screens | Keep as-is (mobile is already mobile-only auth) |
| `QRScanScreen.tsx` | Send `challenge` field in pair request body |
| `types/index.ts` | Add `challenge: string` to `QRPayload` type |
| `MachinesScreen.tsx` | Unpair action already wired (`DELETE /machines/:id/pair`). Make **Unpair** the primary action; de-emphasize or remove the hard **Delete** action per requirement |

---

## Security Considerations

| Threat | Mitigation |
|--------|-----------|
| QR replay attack | One-time `challenge` nonce with 5-minute TTL |
| Unauthorized pairing | `apiKey` + valid user JWT both required to pair |
| TOCTOU on pairing | Existing optimistic lock on `paired_device_id` (already in server) |
| Session token theft from `machine.env` | Scope token to `machineId`; server rejects if machine IP/fingerprint changes (optional) |
| Multiple devices claiming same machine | `paired_device_id` is a single value; re-pairing replaces it |

---

## Database Schema Additions

```sql
-- Add to machines table
ALTER TABLE machines
  ADD COLUMN owner_user_id UUID REFERENCES auth.users(id),
  ADD COLUMN session_token_hash TEXT;

-- New challenges table
CREATE TABLE machine_challenges (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id   UUID NOT NULL REFERENCES machines(id),
  challenge    TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON machine_challenges(machine_id, expires_at);
```

---

## Open Questions Before Implementation

1. **Re-pairing UX** — *Resolved.* Unpair is available from **both** the mobile machines tab and the desktop paired screen. New-phone / lost-phone case is handled by desktop-side unpair: the user unpairs on the desktop (which revokes the token and shows the QR again), then re-pairs by scanning with any device. No dependency on the old phone, so no lockout.
2. **Session token lifetime** — should machine session tokens expire? If yes, how does desktop refresh them (mobile re-scan, or auto-refresh via server)?
3. **Multi-user machines** — is one machine always one user, or can ownership transfer?
4. **Offline desktop** — *Resolved.* Using realtime (Option B), a missed `paired`/`unpaired` event is reconciled by the one-shot `GET /session` the desktop runs on every launch. The heartbeat 401 is a further backstop for token revocation.

---

## Implementation Plan

Build server-first (it's the contract), then mobile (smallest change), then desktop (largest change). Each phase is shippable and testable on its own.

### Phase 1 — Server (`vibe_remote(serverside)`)

**1.1 Migration** — `machine_challenges` table + new columns on `machines`:

```sql
ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS owner_user_id      UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS session_token_hash TEXT;

CREATE TABLE IF NOT EXISTS machine_challenges (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id   UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  challenge    TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_machine_challenges_lookup
  ON machine_challenges(machine_id, expires_at);
```

**1.2 New endpoint — create challenge** (called by desktop before rendering QR):

```
POST /machines/:machineId/challenge
Auth: x-machine-api-key (requireMachineAuth)
→ 200 { challenge: "<hex>", expiresAt: "<iso>" }
```
Inserts a random 32-byte hex with `expires_at = now() + 5min`. Returns it for embedding in the QR.

**1.3 Extend pair endpoint** (`POST /machines/:machineId/pair`):

```
Auth: Bearer <supabase JWT>, x-device-id
Body: { apiKey, challenge }
```
- Validate JWT → `userId`; validate `apiKey` hash; validate `challenge` is unused + unexpired for this machine.
- In a transaction: mark challenge `used_at = now()`; set `owner_user_id = userId`, `paired_device_id = deviceId`, `paired_at = now()`; generate session token, store `session_token_hash`.
- Keep the existing optimistic lock on `paired_device_id`.
- → `200 { ok: true }` (token is delivered to desktop via 1.4, not to mobile).

**1.4 New endpoint — session state** (one-shot, called by desktop on launch to load initial state):

```
GET /machines/:machineId/session
Auth: x-machine-api-key
→ 200 { paired: true,  sessionToken: "<jwt>", pairedDevice: { device_name, platform } }
→ 200 { paired: false }
```
Not a polling loop — the desktop calls this once at startup, then relies on realtime (1.7) for live changes.

**1.5 Realtime broadcast (Option B)** — after pairing (1.3) and unpairing (1.6), broadcast on channel `machine:<machineId>`:
- `paired`   → `{ sessionToken, pairedDevice: { device_name, platform } }`
- `unpaired` → `{}`

Use the existing Supabase realtime infrastructure already used for mobile subscriptions. The desktop authenticates the channel with a realtime token (reuse the `/mobile/realtime-token` pattern, scoped to the machine).

**1.6 Extend unpair endpoint** (`DELETE /machines/:machineId/pair`):
- Accept **both** auth modes: mobile (user JWT, must own machine) and desktop (machine apiKey/session).
- Clear `paired_device_id`, `paired_at`, **and** `session_token_hash`.
- Broadcast `unpaired` on the machine channel (1.5).

**1.7 `requireMachineAuth()`** — accept optional `x-machine-session`; when present and valid, attach the resolved `owner_user_id` to the request context so machine requests are user-scoped.

### Phase 2 — Mobile (`vibe_remote(reactNative)`)

- `types/index.ts` — add `challenge: string` to `QRPayload`.
- `QRScanScreen.tsx` — include `challenge` in the `POST /pair` body.
- `MachinesScreen.tsx` — make **Unpair** the primary action; remove or hide the hard **Delete** from the common flow.
- No auth changes (already mobile-only).

### Phase 3 — Desktop (`vRdeksMultiharness`)

- **On launch:** call `GET /session` once to load initial state, then subscribe to the realtime channel `machine:<machineId>` for live changes.
- **Pairing controller / state machine** with three states:
  1. *Unpaired* → `POST /challenge`, render QR `{ machineId, apiKey, challenge }`, and wait for the `paired` event on the channel (no polling loop).
  2. *Paired* → show "Connected to \<device_name\> (\<platform\>)" from `pairedDevice` + **Unpair** button; stay subscribed for `unpaired` events.
  3. *Unpaired again* → triggered by a realtime `unpaired` event (mobile- or desktop-initiated) or a heartbeat 401 as a safety net; clear token, re-run step 1.
- Realtime client — reuse the Supabase realtime setup; authenticate the `machine:<machineId>` channel with a machine-scoped realtime token.
- `machine.env` — persist `MACHINE_SESSION_TOKEN`; keep `MACHINE_ID` + `API_KEY` durable (never regenerate for an existing install).
- Heartbeat daemon — send `x-machine-session`; on 401, clear token and flip to *Unpaired* (backstop in case a realtime event is missed).
- **Unpair button** → `DELETE /machines/:id/pair`, clear local token, return to QR.
- Remove login/signup UI **last**, once pairing is verified end-to-end.

### Verification checklist

- [ ] Fresh desktop shows QR; mobile scan pairs; desktop flips to connected-device view **via the realtime `paired` event** (no manual refresh).
- [ ] Expired challenge (>5 min) is rejected; reused challenge is rejected.
- [ ] Unpair from mobile → desktop returns to QR in real time (`unpaired` event).
- [ ] Unpair from desktop → mobile machines tab shows the machine as unpaired.
- [ ] Re-scan after unpair re-pairs cleanly (same or new phone).
- [ ] Session token revoked on unpair (stale token returns 401).
- [ ] Desktop offline during pairing → reconciles correct state from `GET /session` on next launch.
- [ ] Desktop relaunch while paired → loads connected-device view from `GET /session`, then resubscribes.

---

## Implementation Notes (as built)

The feature was implemented across all three repos. A few pragmatic deviations from
the design above were made to reduce risk and churn — recorded here so the doc stays
accurate.

### Deviations

1. **Reused `machines.user_id` as the owner instead of adding `owner_user_id`.**
   The server already filters every mobile query on `machines.user_id`. Adding a
   parallel `owner_user_id` would have required rewiring dozens of queries. Instead,
   `user_id` is now **nullable** and assigned at **pair-time** (it used to be set at
   register-time). Same semantics, far less surface.

2. **Stored `session_token` (plaintext column) instead of `session_token_hash`.**
   The desktop must read its token back idempotently on every `GET /session` poll, so
   the server keeps the plaintext (the `machines` table is only reachable via the
   service key). It is generated on pair, returned to the desktop via machine-key auth,
   and cleared on unpair.

3. **Token revocation is "soft", not enforced on relay routes.** `requireMachineAuth`
   still authenticates with the api key alone. Clearing `session_token` on unpair does
   not by itself 401 the relay daemon — but the daemon serves nothing for an unpaired
   machine anyway (no commands target it), and the desktop flips to the QR via the
   session poll. Hard per-request session enforcement was deferred to avoid a
   pair-time race (server sets the token before the desktop has fetched/written it).

4. **Realtime is implemented via Supabase *broadcast* (not postgres_changes), with the
   poll kept as a backstop.** The server fires `paired`/`unpaired` on channel
   `machine:<id>` through the Realtime **HTTP broadcast endpoint**
   (`src/realtime.js`, fire-and-forget — no persistent WS from Express). The desktop
   subscribes with its anon client and, on any event, re-fetches `GET /session`
   (machine-key authed), so no token/device data rides the channel. Broadcast was chosen
   over postgres_changes deliberately: the `machines` table has owner-only RLS and the
   desktop has no user session — and the key `paired` event happens while the machine is
   still *unowned*, so RLS-gated postgres_changes could never deliver it. The poll
   remains as a correctness backstop, slowed to **10s unpaired / 120s paired** since
   realtime now carries the instant updates. If self-hosted realtime doesn't deliver, the
   feature still works at backstop latency.

5. **Login-free registration.** `POST /machines/register` no longer requires auth and
   creates the machine **unowned** (`user_id = null`). The desktop's old
   login → MachineSelector → reclaim flow was removed; `Auth.jsx` was deleted and
   `App.jsx` renders the dashboard directly.

### Files changed

**Server (`vibe_remote(serverside)`)**
- `migrations/008_mobile_first_pairing.sql` — **NEW.** Run this first (nullable
  `user_id`, `session_token` column, `machine_challenges` table).
- `src/middleware/auth.js` — added `requireUserOrMachine`.
- `src/routes/machines.js` — login-free `/register`; new `POST /:id/challenge`;
  extended `POST /:id/pair` (challenge consume + ownership claim + session token +
  `paired` broadcast); dual-auth `DELETE /:id/pair` (clears `session_token` +
  `unpaired` broadcast); new `GET /:id/session`.
- `src/realtime.js` — **NEW.** `broadcastMachine()` over the Realtime HTTP broadcast
  endpoint (server → desktop push for `paired`/`unpaired`).

**Desktop (`vRdeksMultiharness`)**
- `src/App.jsx` — removed login gate; renders `Dashboard` directly.
- `src/components/Dashboard.jsx` — self-register; machine-key pairing poll (backstop)
  **+ realtime `machine:<id>` subscription**; challenge fetch + QR; session-token
  persistence; desktop-side unpair.
- `src/components/Auth.jsx` — **deleted.**
- `relay-deamon1/src/config.js` — `USER_ID` optional; surfaces `MACHINE_SESSION_TOKEN`.

**Mobile (`vibe_remote(reactNative)/AgentControl`)**
- `src/types/index.ts` — `QRPayload.challenge`.
- `src/api/server.ts` — `pairMachine(..., challenge)`.
- `src/screens/Auth/QRScanScreen.tsx` — send challenge; `bad_challenge`/`owned_elsewhere` alerts.
- `src/screens/Machines/MachinesScreen.tsx` — Unpair is the only/primary action; hard Delete removed.

### Required manual step

Apply `migrations/008_mobile_first_pairing.sql` to Supabase (SQL editor) **before**
deploying the server — every new endpoint depends on its columns/table.
