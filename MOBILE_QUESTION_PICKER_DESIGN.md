# Mobile Multiple-Choice Questions — Design & Implementation Guide

> How to surface a harness's **"pick one of these options"** prompt (Claude Code's
> `AskUserQuestion` tool, Gemini's interactive menus, etc.) on the mobile app, let the
> user choose an option remotely, and feed that choice back into the running harness.

This document is a companion to [`SYSTEM_FLOW.md`](./SYSTEM_FLOW.md). Read sections 4–6 of
that file first — this feature reuses the exact same request → mobile → decision pipeline,
just with a new *kind* of request whose "decision" is a chosen option instead of approve/deny.

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [Why This Is Different From Approve/Deny](#2-why-this-is-different-from-approvedeny)
3. [The Interception Mechanism (per harness)](#3-the-interception-mechanism-per-harness)
4. [End-to-End Flow](#4-end-to-end-flow)
5. [Data Model Changes](#5-data-model-changes)
6. [Desktop (relay-daemon1) Changes](#6-desktop-relay-daemon1-changes)
7. [Server (vibe_remote serverside) Changes](#7-server-vibe_remote-serverside-changes)
8. [Mobile (AgentControl) Changes](#8-mobile-agentcontrol-changes)
9. [Message Schemas](#9-message-schemas)
10. [Edge Cases](#10-edge-cases)
11. [Terminal Fallback](#11-terminal-fallback)
12. [Phased Rollout & File Checklist](#12-phased-rollout--file-checklist)

---

## 1. The Problem

Modern harnesses don't only ask "may I run this tool?" — they also ask **decision questions**
with a fixed set of choices. The canonical example is Claude Code's built-in `AskUserQuestion`
tool, whose input looks like:

```jsonc
{
  "questions": [
    {
      "question": "Which database should we use for the cache layer?",
      "header": "Database",
      "multiSelect": false,
      "options": [
        { "label": "Redis",      "description": "In-memory, fastest, needs a separate service" },
        { "label": "PostgreSQL", "description": "Already in the stack, durable" },
        { "label": "SQLite",     "description": "Zero-ops, single-node only" }
      ]
    }
  ]
}
```

On the desktop this renders an interactive arrow-key picker in the terminal. A remote user on
their phone never sees it and the agent stalls. We want the question (and its options) to appear
as a card in the mobile chat feed, let the user tap an option, and have the harness continue with
that choice — exactly the remote-control promise the rest of the system already delivers.

---

## 2. Why This Is Different From Approve/Deny

The existing approval flow (SYSTEM_FLOW §4–5) has a **binary** outcome: the hook exits `0` (allow)
or `2` (block). The mobile app sends `decision: "approved" | "denied"` and the desktop hook
translates that to an exit code.

A multiple-choice question needs to carry **structured data back into the harness** — *which* option
the user picked, possibly *several* options (multiSelect), possibly a *free-text* "Other" answer.
A bare exit code can't express that. So we need:

| Concern | Approval flow | Question flow (new) |
|---|---|---|
| Outcome | `approved` / `denied` | one or more selected option indices (+ optional free text) |
| Hook resolution | `exit 0` / `exit 2` | `exit 2` with the **answer encoded in the block reason** (Claude Code) — see §3 |
| Mobile UI | Allow / Deny buttons | radio (single) / checkbox (multi) list + optional "Other" input + Submit |
| DB representation | `status` column | `status='answered'` + new `selected_options` jsonb |

The good news: **everything else is reused** — the same `pending_requests` table, the same
`/relay/upload`, the same Supabase Realtime `decision:{id}` channel, the same feed RPC, the same
FCM push. We add a discriminator column (`kind`) and a payload column (`question` / `selected_options`).

---

## 3. The Interception Mechanism (per harness)

### 3.1 Claude Code — "intercept-and-answer-via-block" (primary)

Claude Code fires the **PreToolUse hook** for any tool whose name matches the configured matcher.
`AskUserQuestion` is a tool, so we simply add it to the matcher and branch inside `hook.js`.

The subtle part is *how the hook returns the answer*. A PreToolUse hook can only `exit 0` (allow)
or `exit 2` (block) — it cannot synthesise the tool's *result*. But Claude Code feeds the hook's
**stderr text back to the model as the reason the call was blocked**, and the model uses that text
to decide what to do next. So the mechanism is:

1. Intercept `AskUserQuestion` in the PreToolUse hook (before the picker renders).
2. Upload the question + options to the server (a `pending_requests` row with `kind='question'`).
3. Block waiting for the mobile user's selection.
4. When the selection arrives, **`exit 2`** and write a precisely-worded reason to stderr, e.g.:

   ```json
   { "decision": "[Answered remotely via mobile] Q: \"Which database should we use for the cache layer?\" → The user selected: \"PostgreSQL\" (Already in the stack, durable). Proceed with this choice and do NOT call AskUserQuestion again for this question." }
   ```

Because the hook blocks the tool *before* it renders, the native terminal picker never appears and
never waits for a local keypress. Claude reads the reason as the user's answer and continues. This
is the cleanest fit for the existing architecture — it's the same "block with a reason" path
`hook.js` already uses (`hardExit(2, reason)`), only the reason now carries the chosen option.

> **Why block instead of allow?** If we `exit 0`, the `AskUserQuestion` tool actually executes and
> renders the interactive picker in the desktop terminal, which then blocks on a local keypress —
> defeating the remote flow. Blocking with the answer in the reason is what makes the model proceed
> without ever rendering the picker.

**Fallback B (keystroke injection):** if a future Claude Code version stops honouring block-reasons
for `AskUserQuestion`, we can instead `exit 0` (let the picker render) and have the heartbeat inject
the selection keystrokes (arrow-down ×N + Enter, or the option number) using the **same
`WriteConsoleInput` machinery already in `heartbeat.js`** (`tryInjectIntoExistingTerminal`). This is
how Gemini is handled (below) and is the more fragile path, so it's the backup, not the default.

### 3.2 Gemini CLI — PTY grammar (already the model)

Gemini renders multiple-choice menus in its PTY. The existing `gemini-cli/grammar.js` already
detects yes/no prompts and writes keystrokes to the PTY. Extend its `PATTERNS` to recognise numbered
option menus, upload them as a `question` request, and write the chosen option's number/arrow keys
back to the PTY on answer. Same upload + answer plumbing; only the detection + injection differ.

### 3.3 OpenCode — deferred

OpenCode has no structured "ask the user a choice" tool today. If/when it gains one, intercept it in
the existing `tool.execute.before` plugin hook and resolve it via the SDK the same way prompts are
injected. Out of scope for v1.

The rest of this document focuses on **Claude Code**, the path that delivers the feature now.

---

## 4. End-to-End Flow

```
Claude Code            relay daemon (hook.js)      Server (VPS)            Mobile App
──────────────────────────────────────────────────────────────────────────────────────
Claude calls
AskUserQuestion
     │
     ├─ PreToolUse hook fires (stdin = { tool_name:"AskUserQuestion",
     │                                   tool_input:{ questions:[…] }, … })
     │                    │
     │            branch: tool === "AskUserQuestion"
     │            parse questions → options
     │                    │
     │            POST /relay/upload  (kind:"question", question:{…}) ─▶ INSERT pending_requests
     │                    │                                                  │ kind='question'
     │                    │                                            FCM push ("Claude is asking…") ─▶ 🔔
     │                    │                                            Realtime INSERT ───────────────▶ QuestionCard appears
     │            waitForAnswer(requestId)                                   │                              │
     │                    │                                                  │                       user taps "PostgreSQL"
     │                    │                                                  │◀── POST /mobile/answer ──────┘
     │                    │                                            UPDATE status='answered',
     │                    │                                                  selected_options=[…]
     │                    │◀──── Realtime UPDATE (decision:{id}) ─────────────┘
     │            exit 2 + reason:"…selected PostgreSQL…"
     │◀───────────────────┘
     │
Claude reads the block reason as the answer and continues
     │
     └─ (optional) PostToolUse / narrative continues as normal
```

This mirrors SYSTEM_FLOW §12.1 (tool approval happy path) one-for-one. The only new pieces are the
`kind='question'` branch on the daemon, the `/mobile/answer` endpoint, and the `QuestionCard` UI.

---

## 5. Data Model Changes

**Directory:** `D:\Projects\vibe_remote(serverside)\migrations\`
**New file:** `009_question_requests.sql`

A single migration extends `pending_requests` (reuse, don't fork). I verified against
`supabase/schema.sql`: `status` is a plain `text` column with no CHECK constraint, so adding
`'answered'` needs **no** constraint surgery. Two maintenance functions reference the status set,
though, and must learn about `'answered'`:
- `set_decided_at` trigger (`schema.sql:83`) — only stamps `decided_at` for `approved/denied/timeout`.
- `cleanup_old_requests` (`schema.sql:69`) — only purges `approved/denied/timeout`, so answered rows
  would accumulate forever.

```sql
-- 009_question_requests.sql
-- Additive and safe to run on a live DB.

-- ── New columns on pending_requests ───────────────────────────────────────────
-- Discriminator: existing rows are tool approvals; new rows can be questions.
alter table public.pending_requests
  add column if not exists kind text not null default 'approval'
  check (kind in ('approval', 'question'));

-- The question payload (mirrors Claude Code's AskUserQuestion tool_input.questions).
-- Shape: { questions: [ { header, question, multiSelect, options:[{label,description}] } ] }
alter table public.pending_requests
  add column if not exists question jsonb;

-- The answer the user picked. One entry per question:
-- [ { question_index, selected: [ {index, label} ], custom_text? } ]
alter table public.pending_requests
  add column if not exists selected_options jsonb;

-- ── Teach the trigger to stamp decided_at on 'answered' too ────────────────────
create or replace function public.set_decided_at()
returns trigger language plpgsql as $$
begin
  if new.status <> old.status
     and new.status in ('approved', 'denied', 'timeout', 'answered') then
    new.decided_at := now();
  end if;
  return new;
end;
$$;

-- ── Let cleanup purge answered question rows like any other decided row ─────────
create or replace function public.cleanup_old_requests()
returns void language sql as $$
  delete from public.pending_requests
   where status in ('approved', 'denied', 'timeout', 'answered')
     and created_at < now() - interval '7 days';
$$;
-- NOTE: copy the exact body/interval from your current cleanup_old_requests in
-- schema.sql (schema.sql:69) and only widen the status IN (...) list — don't
-- guess the retention window.
```

**Realtime:** `pending_requests` is already in the `supabase_realtime` publication
(`schema.sql:438`) — the desktop hook's `decision:{id}` channel and the mobile feed both subscribe
to it today, so the new columns ride along on the same INSERT/UPDATE events. **No publication change.**

**Feed RPC:** verified — `006_session_feed_view.sql` projects `to_jsonb(r.*)`, so `kind`, `question`,
and `selected_options` are included in the feed `payload` automatically. **No RPC change.**

---

## 6. Desktop (relay-daemon1) Changes

### 6.1 Register the hook matcher (two files)

`AskUserQuestion` must be in the **PreToolUse** matcher so the hook fires for it. The matcher string
is defined in **two** places that both write `~/.claude/settings.json` — the Electron toggle path and
the manual terminal path. Update **both** (only the `PreToolUse` entry — `AskUserQuestion` has no
post-tool phase):

**File 1 — `D:\Projects\vRdeksMultiharness\relay-deamon1\src\harnesses\claude-code\provider.js:31`**
```js
// buildHookBlock() — PreToolUse entry
PreToolUse: [{
  matcher: 'Bash|Write|Edit|MultiEdit|Read|AskUserQuestion',   // ← add |AskUserQuestion
  hooks: [{ type: 'command', command: wrap('hook-wrapper.cjs') }],
}],
```

**File 2 — `D:\Projects\vRdeksMultiharness\relay-deamon1\relay.cjs:30`** (HOOK_BLOCK)
```js
PreToolUse: [{
  matcher: 'Bash|Write|Edit|MultiEdit|Read|AskUserQuestion',   // ← add |AskUserQuestion
  hooks: [{ type: 'command', command: `node "${path.join(__dirname, 'hook-wrapper.cjs')}"` }],
}],
```

> **Do NOT** add `AskUserQuestion(*)` to `HOOK_TOOLS_ALLOW` — that list suppresses Claude's own
> permission prompt for permission-gated tools. `AskUserQuestion` isn't permission-gated; the
> PreToolUse hook fires and blocks it regardless. Leave `HOOK_TOOLS_ALLOW` unchanged.
>
> No new hook script is needed — we branch inside the existing `hook.js`. After changing the matcher,
> re-enable mobile mode (`! node relay.cjs mobile`, or the desktop toggle) so the new matcher is
> written into `settings.json`.

### 6.2 Branch in `hook.js`

First add `waitForAnswer` to the existing import from `./src/supabase.js` (`hook.js:26-27`):

```js
import { uploadRequest, waitForDecision, waitForAnswer, markDecided,
         agentPing, postTerminalEvent } from './src/supabase.js'
```

Then, right after the event is parsed and the PID/transcript are recorded (`hook.js:197`), branch
before the normal approval path:

```js
// hook.js — after storeClaudePid / recordTranscriptPath, before preFilter
if (event.tool_name === 'AskUserQuestion') {
  await handleQuestion(event)   // never returns — exits the process
  return
}
```

Add a `handleQuestion` function. It reuses `uploadRequest`, `agentPing`, and a **new**
`waitForAnswer` (§6.3):

```js
// hook.js — new function
async function handleQuestion(event) {
  const questions = event.tool_input?.questions
  if (!Array.isArray(questions) || questions.length === 0) {
    // Nothing to ask — let Claude's native tool handle it.
    process.exit(0); return
  }

  // Keep the session row fresh (same as the approval path).
  try {
    await agentPing(event.session_id, event.cwd ?? process.cwd(), 'AskUserQuestion')
  } catch {}

  const requestId = randomUUID()
  try {
    mkdirSync('C:\\temp', { recursive: true })
    writeFileSync(CURRENT_FILE, requestId, 'utf8')   // lets relay.cjs answer by index
  } catch {}

  const row = {
    id:         requestId,
    user_id:    config.userId,
    machine_id: config.machineId,
    session_id: event.session_id || null,
    harness:    'claude-code',
    kind:       'question',                       // ← discriminator
    tool_name:  'AskUserQuestion',
    display_type: 'question',
    // A readable summary for the feed/notification (first question's header + text)
    summary:    questions[0].header
                  ? `${questions[0].header}: ${questions[0].question}`
                  : questions[0].question,
    risk_level: 'low',
    risk_reason:'Claude is asking you to choose',
    risk_icon:  '❓',
    files_affected: [],
    question:   { questions },                    // ← full structured payload
    status:     'pending',
    created_at: new Date().toISOString(),
  }

  try {
    await uploadRequest(row)
  } catch (err) {
    debugLog(`question upload failed: ${err.message}`)
    // Can't reach the server — fall back to the native picker so the user isn't stuck.
    process.exit(0); return
  }

  // Mirror the approval path's "tool_start" so mobile shows activity immediately.
  postTerminalEvent({
    session_id: event.session_id, event_type: 'tool_start',
    tool_name: 'AskUserQuestion', summary: row.summary, detail: null, status: null,
  }).catch(() => {})

  process.stderr.write(
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `  RELAY  ❓ Claude is asking a question\n` +
    `  ${row.summary}\n` +
    `  → Sent to mobile app. Or answer from terminal:\n` +
    `      ! node ${relayPath} answer 1   (pick option 1)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`
  )

  // Block until the user answers (mobile) or the terminal supplies an index.
  let answer
  try {
    answer = await waitForAnswer(requestId)   // { selected_options } | { timeout:true }
  } catch (err) {
    debugLog(`waitForAnswer error: ${err.message}`)
    process.exit(config.failOpen ? 0 : 2); return
  }

  if (answer?.timeout) {
    // No answer in time → let the native picker take over rather than guess.
    hardExit(2, 'No answer within the time limit — please answer in the terminal.')
    return
  }

  // Turn the structured selection into a natural-language block reason Claude can act on.
  hardExit(2, formatAnswerReason(questions, answer.selected_options))
}

// Build the deny reason that carries the chosen option(s) back to the model.
function formatAnswerReason(questions, selected_options) {
  const parts = (selected_options || []).map(ans => {
    const q = questions[ans.question_index] ?? questions[0]
    const labels = (ans.selected || []).map(s => `"${s.label}"`).join(', ')
    const custom = ans.custom_text ? ` (custom answer: "${ans.custom_text}")` : ''
    return `Q: "${q.question}" → The user selected: ${labels || ans.custom_text}${custom}.`
  })
  return `[Answered remotely via mobile] ${parts.join(' ')} ` +
         `Proceed with this choice and do NOT call AskUserQuestion again for this question.`
}
```

`hardExit(2, reason)` already writes `JSON.stringify({ decision: reason })` to stderr — exactly the
shape Claude Code reads back as the block reason. No change to `hardExit` needed.

### 6.3 `waitForAnswer` in `src/supabase.js`

Add a sibling to `waitForDecision` that resolves on `status='answered'` and returns the picked
options. Same Realtime-primary / poll-backstop structure:

```js
// src/supabase.js
export function waitForAnswer(requestId) {
  return new Promise((resolve) => {
    let settled = false, pollInterval = null
    function finish(payload) {
      if (settled) return
      settled = true
      clearTimeout(timer); clearInterval(pollInterval)
      try { channel.unsubscribe() } catch {}
      resolve(payload)
    }
    const timer = setTimeout(() => finish({ timeout: true }), config.timeoutMs)

    const channel = supabase
      .channel('decision:' + requestId)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'pending_requests', filter: `id=eq.${requestId}` },
        (payload) => {
          if (payload.new?.status === 'answered') {
            finish({ selected_options: payload.new.selected_options })
          }
        })
      .subscribe()

    // Backstop poll (Realtime can silently drop) — reuse the status endpoint, which
    // must also return selected_options (see §7.3).
    pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${config.apiUrl}/relay/status/${requestId}`,
          { headers: { 'x-machine-api-key': config.machineApiKey } })
        if (!res.ok) return
        const data = await res.json()
        if (data?.status === 'answered') finish({ selected_options: data.selected_options })
      } catch {}
    }, 25_000)
  })
}
```

Also add a local-file answer path for the terminal fallback (§11): the CLI writes
`C:\temp\relay-pending\{id}.answer.json` containing the `selected_options`; `waitForAnswer` can poll
for that file the same way `raceDecision` polls for `.approved`/`.denied`.

### 6.4 No heartbeat change (primary path)

Because Claude Code resolves via the hook's block-reason, **no keystroke injection is needed** for the
primary path. The heartbeat only changes if you implement Fallback B (§3.1) or Gemini (§3.2).

---

## 7. Server (vibe_remote serverside) Changes

All paths under **`D:\Projects\vibe_remote(serverside)\src\routes\`**.

### 7.1 `/relay/upload` — pass-through (almost free)

**File: `src\routes\relay.js`** — the upload route already does `.insert({ ...payload, … })`
(`relay.js:99-111`), so `kind`, `question`, and `selected_options` flow through once the columns
exist. One touch — branch the FCM title (`relay.js:124`):

```js
// relay.js — POST /relay/upload, when building the FCM notification
notifyMachine(req.machine.id, {
  title: payload.kind === 'question'
    ? 'Claude is asking a question'
    : `${payload.tool_name} needs approval`,
  body:  payload.summary ?? 'A request is waiting',
  requestId: data.id,
})
```

### 7.2 `POST /mobile/answer` — new endpoint

**File: `src\routes\mobile.js`** — add after the existing `/decide` handler (`mobile.js:305`).
Modelled exactly on `/mobile/decide`; it inherits the same `requireUserAuthFast + attachDevice +
mobileLimiter` middleware from `router.use(...)` at the top of the file (`mobile.js:23`):

```js
// POST /mobile/answer — submit the chosen option(s) for a question request
router.post('/answer', async (req, res) => {
  const { requestId, answers } = req.body
  // answers: [ { question_index, selected:[{index,label}], custom_text? } ]

  if (!requestId || !Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ error: 'requestId and answers are required' })
  }
  if (!req.deviceId) {
    return res.status(400).json({ error: 'x-device-id header required' })
  }

  const ids = await pairedMachineIds(req.user.id, req.deviceId)
  if (!ids.length) return res.status(404).json({ error: 'No paired machines' })

  const { data: updated, error } = await db
    .from('pending_requests')
    .update({
      status:           'answered',
      selected_options: answers,
      decided_at:       new Date().toISOString(),
      decided_by:       'mobile',
    })
    .eq('id', requestId)
    .in('machine_id', ids)
    .eq('kind', 'question')
    .eq('status', 'pending')
    .select('agent_id, session_id')
    .single()

  if (error && error.code !== 'PGRST116') {
    console.error('[mobile/answer]', error.message)
    return res.status(500).json({ error: 'Failed to save answer' })
  }
  if (!updated) return res.status(409).json({ error: 'Already answered or not found' })

  res.json({ ok: true })
  syncAgentPendingCount(updated.agent_id).catch(() => {})
  broadcastSession(updated.session_id, 'feed')
})
```

### 7.3 `/relay/status/:requestId` — include the answer

**File: `src\routes\relay.js`** (`relay.js:211`). The desktop `waitForAnswer` poll backstop reads
this. Add `selected_options` to its `select` and return it:

```js
// relay.js — GET /relay/status/:requestId
const { data } = await db
  .from('pending_requests')
  .select('status, decided_by, selected_options')   // ← add selected_options
  .eq('id', req.params.requestId)
  .eq('machine_id', req.machine.id)
  .single()
res.json(data ?? { status: 'pending' })
```

### 7.4 (Optional) `/relay/answer` for terminal fallback

If you want the desktop terminal to answer questions (§11), add a machine-auth `POST /relay/answer`
mirroring `/relay/decide` that sets `status='answered'` + `selected_options`. Otherwise the local
signal file (§6.3) handles the terminal path without a server round-trip and the mobile UI patches
itself on the next poll.

---

## 8. Mobile (AgentControl) Changes

All paths under **`D:\Projects\vibe_remote(reactNative)\AgentControl\src\`**.

> **Important discovery:** the chat does **not** use the shared `components/RequestCard.tsx`. The
> request card *in the feed* is a **local** component defined inside
> `screens/Sessions/ChatScreen.tsx` (`ChatScreen.tsx:119`), rendered by the local `FeedRow`
> memo (`ChatScreen.tsx:257`). So the QuestionCard branch goes in `ChatScreen.tsx`, not in the
> shared component. (The shared `components/RequestCard.tsx` is only used by `RequestDetailScreen`.)

### 8.1 Types — `types\index.ts`

Add the question types, extend `PendingRequest` (after its existing fields, `index.ts:65-91`), and
add `'answered'` to the status union (`index.ts:5-11`):

```ts
// types/index.ts
export type RequestKind = 'approval' | 'question'

export interface QuestionOption { label: string; description?: string }
export interface QuestionSpec {
  header?:      string
  question:     string
  multiSelect?: boolean
  options:      QuestionOption[]
}
export interface SelectedAnswer {
  question_index: number
  selected:       { index: number; label: string }[]
  custom_text?:   string
}

export type RequestStatus =
  | 'pending' | 'approved' | 'denied' | 'timeout' | 'cli_pending'
  | 'answered'                                   // ← add

export interface PendingRequest {
  // …all existing fields stay…
  kind?:             RequestKind                 // undefined ⇒ treat as 'approval'
  question?:         { questions: QuestionSpec[] } | null
  selected_options?: SelectedAnswer[] | null
}
```

### 8.2 API — `api\server.ts`

Add next to `decideRequest` (`server.ts:112`), using the same `request<T>` helper:

```ts
// api/server.ts
import type { /* …, */ SelectedAnswer } from '../types'

export function answerRequest(requestId: string, answers: SelectedAnswer[]): Promise<void> {
  return request<void>('/mobile/answer', {
    method: 'POST',
    body:   JSON.stringify({ requestId, answers }),
  })
}
```

### 8.3 Answer mutation — `hooks\useRequests.ts`

Add alongside `useDecideRequest` (`useRequests.ts:43`). It reuses the file's existing
`patchPendingInFeeds` helper (`useRequests.ts:26`) so the card locks instantly, then the Realtime
UPDATE converges with no flicker:

```ts
// hooks/useRequests.ts
import { fetchRequestById, decideRequest, answerRequest } from '../api/server'
import type { PendingRequest, SelectedAnswer, FeedPage, FeedRow } from '../types'

export function useAnswerRequest() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: ({ id, answers }: { id: string; answers: SelectedAnswer[] }) =>
      answerRequest(id, answers),

    onMutate: async ({ id, answers }) => {
      await qc.cancelQueries({ queryKey: ['feed'] })
      const patch: Partial<PendingRequest> = {
        status:           'answered',
        decided_by:       'mobile',
        decided_at:       new Date().toISOString(),
        selected_options: answers,
      }
      const prevFeeds = qc.getQueriesData<InfiniteData<FeedPage>>({ queryKey: ['feed'] })
      qc.setQueriesData<InfiniteData<FeedPage>>(
        { queryKey: ['feed'] },
        old => patchPendingInFeeds(old, id, patch),
      )
      qc.setQueryData<PendingRequest>(['requests', id], old => (old ? { ...old, ...patch } : old))
      return { prevFeeds }
    },
    onError:  (_e, _v, ctx) => ctx?.prevFeeds?.forEach(([k, d]) => qc.setQueryData(k, d)),
    onSettled:(_d, _e, v)   => qc.invalidateQueries({ queryKey: ['requests', v.id] }),
  })
}
```

### 8.4 `QuestionCard` component — new file `components\QuestionCard.tsx`

A self-contained card the chat renders for question rows. Single-select → radios; multiSelect →
checkboxes; an "Other…" row → free text; locks to a read-only "Answered" state once
`status === 'answered'`. (Style it to match the local cards in `ChatScreen.tsx`.)

```tsx
// components/QuestionCard.tsx
import React, { useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet } from 'react-native'
import type { PendingRequest, SelectedAnswer } from '../types'

interface Props {
  request:  PendingRequest
  onSubmit: (answers: SelectedAnswer[]) => void
}

export function QuestionCard({ request, onSubmit }: Props) {
  const questions = request.question?.questions ?? []
  const answered  = request.status === 'answered'

  // chosen[qIndex] = Set of option indices; custom[qIndex] = free-text "Other"
  const [chosen, setChosen] = useState<Record<number, Set<number>>>({})
  const [custom, setCustom] = useState<Record<number, string>>({})

  function pick(qi: number, oi: number, multi: boolean) {
    setChosen(prev => {
      const set = new Set(multi ? prev[qi] ?? [] : [])
      if (set.has(oi)) set.delete(oi); else set.add(oi)
      return { ...prev, [qi]: set }
    })
  }

  function submit() {
    const answers: SelectedAnswer[] = questions.map((q, qi) => ({
      question_index: qi,
      selected: [...(chosen[qi] ?? [])].map(oi => ({ index: oi, label: q.options[oi].label })),
      custom_text: custom[qi]?.trim() || undefined,
    }))
    // require every question to have a selection or custom text
    const complete = answers.every(a => a.selected.length > 0 || a.custom_text)
    if (complete) onSubmit(answers)
  }

  // ── Answered (read-only) ──────────────────────────────────────────────────
  if (answered) {
    return (
      <View style={styles.card}>
        {(request.selected_options ?? []).map((ans, i) => {
          const q = questions[ans.question_index] ?? questions[i]
          const text = ans.selected.map(s => s.label).join(', ') || ans.custom_text
          return (
            <View key={i} style={styles.block}>
              <Text style={styles.header}>{q?.header ?? 'Question'}</Text>
              <Text style={styles.question}>{q?.question}</Text>
              <Text style={styles.answered}>✓ You chose: {text}</Text>
            </View>
          )
        })}
      </View>
    )
  }

  // ── Interactive ───────────────────────────────────────────────────────────
  return (
    <View style={styles.card}>
      {questions.map((q, qi) => {
        const multi = !!q.multiSelect
        return (
          <View key={qi} style={styles.block}>
            {q.header ? <Text style={styles.header}>{q.header}</Text> : null}
            <Text style={styles.question}>{q.question}</Text>
            {q.options.map((opt, oi) => {
              const on = chosen[qi]?.has(oi)
              return (
                <TouchableOpacity key={oi} style={[styles.option, on && styles.optionOn]}
                  onPress={() => pick(qi, oi, multi)} activeOpacity={0.7}>
                  <Text style={styles.mark}>{multi ? (on ? '☑' : '☐') : (on ? '◉' : '○')}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.optLabel}>{opt.label}</Text>
                    {opt.description ? <Text style={styles.optDesc}>{opt.description}</Text> : null}
                  </View>
                </TouchableOpacity>
              )
            })}
            <TextInput
              style={styles.other}
              placeholder="Other… (type a custom answer)"
              value={custom[qi] ?? ''}
              onChangeText={t => setCustom(p => ({ ...p, [qi]: t }))}
            />
          </View>
        )
      })}
      <TouchableOpacity style={styles.submit} onPress={submit} activeOpacity={0.85}>
        <Text style={styles.submitText}>Submit answer</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  card:      { marginHorizontal: 20, marginVertical: 6, padding: 16, borderRadius: 14,
               borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)', backgroundColor: '#fff', gap: 10 },
  block:     { gap: 6 },
  header:    { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', color: '#888' },
  question:  { fontSize: 15, fontWeight: '500', color: '#222' },
  option:    { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12,
               borderRadius: 10, borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  optionOn:  { borderColor: '#5B8DEF', backgroundColor: 'rgba(91,141,239,0.08)' },
  mark:      { fontSize: 18, color: '#5B8DEF' },
  optLabel:  { fontSize: 14, fontWeight: '500', color: '#222' },
  optDesc:   { fontSize: 12, color: '#888', marginTop: 2 },
  other:     { borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)', borderRadius: 10,
               paddingHorizontal: 12, paddingVertical: 8, fontSize: 13 },
  submit:    { backgroundColor: '#5B8DEF', borderRadius: 10, padding: 12, alignItems: 'center' },
  submitText:{ color: '#fff', fontWeight: '600', fontSize: 14 },
  answered:  { fontSize: 13, color: '#2E7D32', fontWeight: '600', marginTop: 4 },
})
```

### 8.5 Render the QuestionCard — `screens\Sessions\ChatScreen.tsx`

Branch inside the local `FeedRow` memo (`ChatScreen.tsx:257-276`). No `ChatItem` union change is
needed — `item.req` already carries the new `kind` field:

```tsx
// ChatScreen.tsx — imports
import { QuestionCard } from '../../components/QuestionCard'
import { useAnswerRequest } from '../../hooks/useRequests'

// FeedRow (add onAnswer to its props), inside the memo body, replace the final return:
if (item.kind === 'output')   return <OutputBubble  event={item.event} />
if (item.kind === 'activity') return <ActivityBubble event={item.event} />
if (item.kind === 'sent')     return <SentBubble    cmd={item.cmd} />
if (item.kind === 'notify')   return <NotifyRow     event={item.event} />
if (item.kind === 'stop')     return <StopRow       event={item.event} />
// request row — questions render the QuestionCard, approvals the existing card
if (item.req.kind === 'question') {
  return <QuestionCard request={item.req} onSubmit={(answers) => onAnswer(item.req.id, answers)} />
}
return (
  <RequestCard
    req={item.req}
    onApprove={() => onApprove(item.req.id)}
    onDeny={()    => onDeny(item.req.id)}
    onOpen={()    => onOpen(item.req.id)}
  />
)
```

Wire the mutation in the `ChatScreen` body (near `decide`, `ChatScreen.tsx:286` / handlers
`:353-355`), and pass `onAnswer` through `renderItem` (`:359`) into `FeedRow`:

```tsx
// ChatScreen.tsx — inside ChatScreen()
const answer = useAnswerRequest()
const handleAnswer = useCallback(
  (id: string, answers: SelectedAnswer[]) => answer.mutate({ id, answers }),
  [answer],
)
// add handleAnswer to renderItem's useCallback deps and pass onAnswer={handleAnswer} to <FeedRow/>
```

### 8.6 Realtime, composer gating, pending-count — no change

Verified against `useChatFeed.ts`:
- The feed already subscribes to `pending_requests` **INSERT** (`useChatFeed.ts:132`) and **UPDATE**
  (`:141`) for the session and appends/patches from the payload — the question card and its answered
  state stream in live on the existing channel.
- `pendingCount` (`ChatScreen.tsx:347`) counts `kind === 'request' && req.status === 'pending'`, and a
  question is `pending` until answered — so the **composer is already locked** while a question is
  open. Optionally soften the lock copy to read "Answer the pending question first" when the pending
  row is a question.

### 8.7 Push notification copy — `hooks\usePushNotifications.ts`

Verified: notifications are **data-only**; the handler reads `remoteMessage.data.title`
(`usePushNotifications.ts:83`) which the server now sets to "Claude is asking a question" (§7.1) —
**no client change required** for the banner text. The deep-link tap navigates to `RequestDetail`
(`:104-111`); for v1 that screen can keep showing the raw payload, or (optional polish) branch
`RequestDetailScreen` on `kind === 'question'` to render the `QuestionCard` there too.

---

## 9. Message Schemas

### 9.1 Question request (daemon → server → mobile)

```jsonc
{
  "id": "uuid",
  "kind": "question",
  "harness": "claude-code",
  "tool_name": "AskUserQuestion",
  "display_type": "question",
  "summary": "Database: Which database should we use for the cache layer?",
  "risk_level": "low",
  "risk_icon": "❓",
  "question": {
    "questions": [
      {
        "header": "Database",
        "question": "Which database should we use for the cache layer?",
        "multiSelect": false,
        "options": [
          { "label": "Redis",      "description": "In-memory, fastest, needs a separate service" },
          { "label": "PostgreSQL", "description": "Already in the stack, durable" },
          { "label": "SQLite",     "description": "Zero-ops, single-node only" }
        ]
      }
    ]
  },
  "status": "pending",
  "created_at": "2026-06-23T12:00:00.000Z"
}
```

### 9.2 Answer (mobile → server)

```jsonc
// POST /mobile/answer
{
  "requestId": "uuid",
  "answers": [
    {
      "question_index": 0,
      "selected": [ { "index": 1, "label": "PostgreSQL" } ],
      "custom_text": null
    }
  ]
}
```

### 9.3 Answered row (server → desktop via Realtime UPDATE / status poll)

```jsonc
{
  "id": "uuid",
  "kind": "question",
  "status": "answered",
  "decided_by": "mobile",
  "decided_at": "2026-06-23T12:00:07.000Z",
  "selected_options": [
    { "question_index": 0, "selected": [ { "index": 1, "label": "PostgreSQL" } ] }
  ]
}
```

### 9.4 Block reason fed back to Claude Code (daemon → harness, stderr)

```json
{ "decision": "[Answered remotely via mobile] Q: \"Which database should we use for the cache layer?\" → The user selected: \"PostgreSQL\". Proceed with this choice and do NOT call AskUserQuestion again for this question." }
```

---

## 10. Edge Cases

| Case | Handling |
|---|---|
| **Multi-select** (`multiSelect: true`) | Checkbox UI; `selected` is an array of >1 option. The block reason lists all chosen labels. |
| **"Other" / free text** | "Other…" row → `custom_text`, empty `selected`. Block reason includes `(custom answer: "…")`. Claude's tool natively allows this, so it's expected. |
| **Multiple questions in one call** | `questions` is an array; render each as its own section; `answers` has one entry per question. Submit only when every question is answered. (v1 can require all-or-nothing.) |
| **Timeout** (no answer in `config.timeoutMs`) | `waitForAnswer` resolves `{timeout:true}` → `hardExit(2, "No answer within the time limit — please answer in the terminal.")`. Claude re-asks or the user answers locally. Do **not** auto-pick a default. |
| **Server unreachable at upload** | `exit 0` → native picker renders so the desktop user isn't stuck. |
| **Double answer (phone + terminal race)** | The `.eq('status','pending')` guard on the UPDATE makes the first write win; the second is a 409, exactly like `/mobile/decide`. |
| **Answered while app backgrounded** | FCM push ("Claude is asking a question"); tapping opens the chat where the QuestionCard is live. |
| **Question on a non-Claude harness** | Gemini via PTY grammar (§3.2); OpenCode deferred (§3.3). Mobile UI is harness-agnostic — it only reads `question`/`selected_options`. |

---

## 11. Terminal Fallback

Keep parity with the approval flow's `! node relay.cjs 1/3` escape hatch so the desktop user can
answer without the phone:

1. `hook.js` already wrote the request id to `C:\temp\relay-current.txt`.
2. Extend `relay.cjs` (and/or `decide.cjs`) with an `answer <n>` verb: it reads the current request,
   maps `n` to the option index, and either:
   - writes `C:\temp\relay-pending\{id}.answer.json` = `{ selected_options:[…] }` (local signal that
     `waitForAnswer`'s file-poll picks up in ~150 ms), **and**
   - optionally POSTs `/relay/answer` (§7.4) so the mobile feed reflects the answer.
3. `waitForAnswer` finishes on whichever path resolves first — identical to `raceDecision`.

Show the option list in the stderr panel (§6.2) so the user knows which number maps to which option.

---

## 12. Phased Rollout & File Checklist

Repo roots:
`SRV = D:\Projects\vibe_remote(serverside)` ·
`DSK = D:\Projects\vRdeksMultiharness\relay-deamon1` ·
`MOB = D:\Projects\vibe_remote(reactNative)\AgentControl`

**Phase 1 — DB & server (no behaviour change yet)**
- [ ] `SRV\migrations\009_question_requests.sql` — add `kind`, `question`, `selected_options`; widen
      `set_decided_at` + `cleanup_old_requests` to include `'answered'`. (status is plain text — no
      constraint edit; RPC uses `to_jsonb` — no RPC edit.)
- [ ] `SRV\src\routes\mobile.js` — add `POST /mobile/answer` (after `/decide`, ~`:305`).
- [ ] `SRV\src\routes\relay.js` — branch FCM title on `kind` (`:124`); add `selected_options` to the
      `/relay/status/:requestId` select (`:211`).

**Phase 2 — Desktop interception**
- [ ] `DSK\src\harnesses\claude-code\provider.js:31` — add `|AskUserQuestion` to the PreToolUse matcher.
- [ ] `DSK\relay.cjs:30` — add `|AskUserQuestion` to the HOOK_BLOCK PreToolUse matcher.
- [ ] `DSK\hook.js` — branch on `tool_name === 'AskUserQuestion'`; add `handleQuestion` +
      `formatAnswerReason` (§6.2).
- [ ] `DSK\src\supabase.js` — add `waitForAnswer` (Realtime + poll + optional local-file signal) (§6.3).
- [ ] Re-enable mobile mode (`! node relay.cjs mobile` or desktop toggle) so the new matcher lands in
      `~/.claude/settings.json`.

**Phase 3 — Mobile UI**
- [ ] `MOB\src\types\index.ts` — `RequestKind`, `QuestionSpec`, `SelectedAnswer`; extend
      `PendingRequest`; add `'answered'` to `RequestStatus`.
- [ ] `MOB\src\api\server.ts` — `answerRequest`.
- [ ] `MOB\src\components\QuestionCard.tsx` — **new** (radio/checkbox/other/submit + answered state).
- [ ] `MOB\src\hooks\useRequests.ts` — `useAnswerRequest` mutation.
- [ ] `MOB\src\screens\Sessions\ChatScreen.tsx` — render `QuestionCard` in the local `FeedRow`
      (`:257`) when `item.req.kind === 'question'`; wire `useAnswerRequest` + `handleAnswer` + pass
      `onAnswer` through `renderItem`.
- [ ] (Optional) soften composer lock copy for questions; branch `RequestDetailScreen` for question kind.

**Phase 4 — Fallbacks & other harnesses (optional)**
- [ ] `DSK\relay.cjs` — `answer <n>` verb writing `C:\temp\relay-pending\{id}.answer.json` + optional
      `POST /relay/answer`.
- [ ] `SRV\src\routes\relay.js` — `POST /relay/answer` (machine-auth, mirrors `/relay/decide`) if doing
      the server-side terminal path.
- [ ] `DSK\src\harnesses\gemini-cli\grammar.js` — detect numbered menus; inject the chosen option via
      the PTY on answer.

**Smoke test (Phase 1–3):** in a paired Claude Code session, ask Claude something that triggers
`AskUserQuestion` (e.g. "ask me whether to use Redis or PostgreSQL via the question tool"). Confirm:
a QuestionCard appears in the mobile feed → tapping an option + Submit → the card locks "Answered by
you" → Claude continues in the terminal having taken your choice, without the native picker ever
rendering.

---

*Companion to SYSTEM_FLOW.md. Targets relay-daemon1 (desktop), vibe_remote(serverside), and
AgentControl (React Native). Mechanism verified against the existing hook/upload/decide/Realtime
pipeline as of 2026-06-23.*
