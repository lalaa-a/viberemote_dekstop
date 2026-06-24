# Mobile Question Picker — Implementation Record

> What was actually built to let a harness's multiple-choice question (Claude Code's
> `AskUserQuestion`) appear on the mobile app, be answered remotely, and flow back into the
> running harness. Implements [`MOBILE_QUESTION_PICKER_DESIGN.md`](./MOBILE_QUESTION_PICKER_DESIGN.md).

**Status:** ✅ Implemented across all three tiers. Desktop JS syntax-checks, server routes
syntax-check, mobile changed files typecheck clean (tsc 5.3.3).

**Date:** 2026-06-23

---

## 1. How it works (one paragraph)

`AskUserQuestion` is a tool, so Claude Code fires the **PreToolUse hook** for it. The relay daemon
intercepts it *before* the native terminal picker renders, uploads the question + options as a
`pending_requests` row with `kind='question'`, and blocks. The mobile app renders a `QuestionCard`
(radio / checkbox / "Other"), the user picks and submits, the server stores `selected_options` and
flips `status='answered'`, and the desktop hook — woken by Supabase Realtime — resolves by
`exit 2` with the chosen option(s) encoded in the block reason. Claude reads that as the answer and
continues; the picker never renders on the desktop. The entire existing upload → Realtime → decide
pipeline is reused; only a new request *kind* and an *answer* payload were added.

```
Claude Code → PreToolUse hook (kind=question) → /relay/upload → Supabase
   ↑ exit 2 w/ answer in reason                                    ↓ Realtime INSERT
   hook ← waitForAnswer ← Realtime UPDATE ← /mobile/answer ← QuestionCard (mobile)
```

---

## 2. Files changed / added

### Server — `D:\Projects\vibe_remote(serverside)`

| File | Change |
|---|---|
| `migrations\011_question_requests.sql` | **NEW.** Adds `kind`, `question`, `selected_options` columns to `pending_requests`; widens `set_decided_at` trigger and `cleanup_old_requests()` to include `'answered'`. |
| `src\routes\mobile.js` | **NEW** `POST /mobile/answer` (stores `selected_options`, flips `status='answered'`, mirrors `/decide` guards). Added `'answered'` to the `/mobile/history` status filter. |
| `src\routes\relay.js` | `/relay/upload` FCM title branches on `kind` ("Claude is asking a question"). `/relay/status/:id` now selects `selected_options`. **NEW** `POST /relay/answer` (PC-terminal answer path, machine-auth, mirrors `/relay/decide`). |

> Note: a stray duplicate `migrations\009_question_requests.sql` (from an earlier draft, colliding
> with `009_realtime_agents.sql`) was **removed**; the migration lives at **011**.

### Desktop relay daemon — `D:\Projects\vRdeksMultiharness\relay-deamon1`

| File | Change |
|---|---|
| `src\harnesses\claude-code\provider.js` | PreToolUse matcher now includes `AskUserQuestion` (Electron-toggle install path). |
| `relay.cjs` | HOOK_BLOCK PreToolUse matcher includes `AskUserQuestion`. **NEW** `answer <n>` verb — terminal fallback that writes the local signal file and posts to `/relay/answer`. |
| `hook.js` | **Fixed a broken duplicate import** that re-declared `uploadRequest` (a `SyntaxError`) and imported a non-existent `waitForMarked`; collapsed to one import with `waitForAnswer`. `handleQuestion()` now also persists the options to `C:\temp\relay-current-question.json` so the terminal `answer <n>` verb can map index → label. (`handleQuestion` / `formatAnswerReason` / the `tool_name==='AskUserQuestion'` branch were already present.) |
| `src\supabase.js` | **NEW** `waitForAnswer(requestId)` — Realtime (`status='answered'`) primary, 25 s `/relay/status` poll backstop, 150 ms local-file (`{id}.answer.json`) signal for the terminal path. |

### Mobile — `D:\Projects\vibe_remote(reactNative)\AgentControl`

| File | Change |
|---|---|
| `src\types\index.ts` | Added `'answered'` to `RequestStatus`; new `RequestKind`, `QuestionOption`, `QuestionSpec`, `SelectedAnswer`; extended `PendingRequest` with `kind`, `question`, `selected_options`. |
| `src\api\server.ts` | **NEW** `answerRequest(requestId, answers)` → `POST /mobile/answer`. Imports `SelectedAnswer`. |
| `src\hooks\useRequests.ts` | **NEW** `useAnswerRequest()` mutation — optimistic, reuses `patchPendingInFeeds` so the card locks to `answered` instantly. |
| `src\components\QuestionCard.tsx` | **NEW.** Renders header + question; radios (single) / checkboxes (multi); an "Other…" free-text row; Submit (disabled until complete); read-only "Answered" state showing the chosen option(s). Themed with the app's design tokens. |
| `src\screens\Sessions\ChatScreen.tsx` | Local `FeedRow` renders `QuestionCard` when `item.req.kind === 'question'`; wired `useAnswerRequest` + `handleAnswer`, passed `onAnswer` through `renderItem`. |
| `src\screens\Requests\RequestDetailScreen.tsx` | Question requests (e.g. opened from a push deep-link) render the `QuestionCard` instead of the approve/deny layout; `handleAnswer` submits and navigates back. |

---

## 3. Data model

`pending_requests` gains three columns (migration 011):

| Column | Type | Meaning |
|---|---|---|
| `kind` | `text` default `'approval'`, check `('approval','question')` | discriminator |
| `question` | `jsonb` | `{ questions: [ { header, question, multiSelect, options:[{label,description}] } ] }` |
| `selected_options` | `jsonb` | answer: `[ { question_index, selected:[{index,label}], custom_text? } ]` |

`status` gains the value `'answered'` (the column is plain `text` — no constraint change). The
Realtime publication and `get_session_feed` RPC (which projects `to_jsonb(r.*)`) needed **no**
change — the new columns ride along automatically.

---

## 4. Message flow / schemas

**Question upload** (daemon → server → mobile): a normal `pending_requests` row plus
`kind:'question'`, `question:{questions:[…]}`, `risk_icon:'❓'`, `status:'pending'`.

**Answer** (mobile → `POST /mobile/answer`):
```json
{ "requestId": "uuid",
  "answers": [ { "question_index": 0, "selected": [ { "index": 1, "label": "PostgreSQL" } ] } ] }
```

**Answered row** (server → desktop via Realtime UPDATE / `/relay/status`): `status:'answered'`,
`decided_by:'mobile'`, `selected_options:[…]`.

**Block reason fed to Claude** (daemon → harness, stderr):
```json
{ "decision": "[Answered remotely via mobile] Q: \"…\" → The user selected: \"PostgreSQL\". Proceed with this choice and do NOT call AskUserQuestion again for this question." }
```

---

## 5. Two manual steps before it works end-to-end

1. **Apply the migration** — run `migrations/011_question_requests.sql` against Supabase (additive, safe).
2. **Re-enable mobile mode** — `! node relay.cjs mobile` (or the desktop toggle) so the updated matcher
   (`…|AskUserQuestion`) is written into `~/.claude/settings.json`. The source files already include it,
   but the on-disk `settings.json` won't until re-applied.

---

## 6. Edge cases covered

- **Multi-select** — checkbox UI; `selected` carries >1 option; block reason lists all labels.
- **"Other" / free text** — the "Other…" row populates `custom_text`; reason includes `(custom answer: …)`.
- **Multiple questions in one call** — `questions` is an array; the card requires every question answered before Submit enables.
- **Timeout** — `waitForAnswer` resolves `{timeout:true}` → hook blocks with "please answer in the terminal" (never auto-picks).
- **Server unreachable at upload** — hook `exit 0` so the native picker renders; the user isn't stuck.
- **Double answer (phone vs terminal)** — the `status='pending'` + `kind='question'` guards on the UPDATE make the first write win; the second is a 409.
- **Composer gating** — a pending question is a `pending` row, so the existing `pending_count` logic already locks the composer until it's answered.
- **App backgrounded** — FCM push "Claude is asking a question"; tapping deep-links to the request, now rendered as a `QuestionCard`.

---

## 7. Terminal fallback

Parity with the approve/deny escape hatch. The hook prints:

```
! node relay.cjs answer 1   (pick option 1)
```

`relay.cjs answer <n>` reads `C:\temp\relay-current-question.json` (written by `handleQuestion`),
maps the 1-based index → option label, writes `C:\temp\relay-pending\{id}.answer.json` (the hook's
150 ms file-poll picks it up), and posts to `/relay/answer` so the mobile feed reflects it.

---

## 8. Verification done

- `node --check` on `hook.js`, `src/supabase.js`, `relay.cjs`, `provider.js` (desktop) — **pass**.
- `node --check` on `src/routes/mobile.js`, `src/routes/relay.js` (server) — **pass**.
- `tsc --noEmit` (project tsc 5.3.3) on the 6 changed/new mobile files — **pass** (0 errors).
  - Note: the project's `tsconfig.json` sets `ignoreDeprecations:"6.0"` (invalid for its own tsc) and
    its `include` list omits `src/hooks`/`src/screens/Sessions` — the team relies on Metro/Babel, not
    `tsc`, so a temporary corrected config was used for the check and then removed.

## 9. Smoke test

In a paired Claude Code session with mobile mode on, ask Claude to use its question tool
("ask me whether to use Redis or PostgreSQL via AskUserQuestion"). Expect:

1. A `QuestionCard` streams into the mobile chat feed (composer locks).
2. Tap an option → **Submit** → the card flips to read-only "✓ You chose: …".
3. Claude continues in the terminal having taken your choice — the native picker never renders.

Other harnesses: Gemini (PTY numbered-menu grammar) and OpenCode (no structured ask tool) are
out of scope for this pass — see the design doc §3.2–3.3.
