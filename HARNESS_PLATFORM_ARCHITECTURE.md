# Scalable Multi-Harness Architecture — the Harness Provider SDK

**Companion to `MULTI_HARNESS_GUIDE.md`.** That guide shows *concretely* how to add OpenCode next to Claude Code. **This** document defines the **framework** so that every future harness — Gemini CLI, Pi, Aider, Cursor CLI, whatever ships next — plugs in as a **self-contained module** with **zero changes to the core, the server, or the mobile app**, and **without ever touching the working Claude Code path**.

The hard requirement that drives the whole design:

> **Different harnesses expose completely different control surfaces.** Claude Code has settings-file hooks. OpenCode has a JS plugin runtime + SDK. Gemini CLI / Pi may have *neither*. The architecture must therefore be **mechanism-agnostic** — interception is a pluggable strategy, not a baked-in assumption.

---

## 1. Why a second document

| `MULTI_HARNESS_GUIDE.md` | `HARNESS_PLATFORM_ARCHITECTURE.md` (this) |
|---|---|
| "Add OpenCode, step by step" | "Make adding *any* harness a drop-in module" |
| Two concrete adapters | A **Provider SDK** + reusable **strategies** |
| Assumes hook/plugin exists | Handles harnesses with **no hooks** (PTY proxy, MCP gateway, API mediator) |
| Touches core files | New harness = **new folder, no core edits** |

If you only read one: read the first to ship OpenCode. Read this before you add harness #3, because doing #3 the ad-hoc way is where the code rots.

---

## 2. Design principles

1. **Capability-based, not mechanism-based.** A provider *declares what it can do* (gate tools? stream narrative? inject prompts? list sessions?). The app, server, and phone adapt to declared capabilities and **degrade gracefully** when something is absent. A harness that can only mirror output read-only is still a first-class citizen.
2. **Mechanism is a strategy, swappable per harness.** Interception (the act of pausing a tool call for approval) is provided by one of a small set of **reusable strategies**. A new harness picks an existing strategy or contributes a new one — it never reinvents transport, schema, or UI.
3. **Adapter isolation.** Adapters depend **only** on the Harness SDK contract, never on each other, never on Electron/React. Deleting an adapter folder removes that harness cleanly.
4. **Canonical schema at the boundary.** Every adapter, regardless of mechanism, emits the **same** normalized `RelayRequest` / `NarrativeEvent` shapes. Downstream (server, DB, mobile) never learns a harness's private format.
5. **Claude Code is the reference adapter and is conformance-locked.** A test suite asserts its behavior so any refactor that would break it fails CI. (§9)
6. **Discovery over registration.** Adapters are auto-discovered from a folder (and optionally from npm packages). Adding one doesn't mean editing a central `switch`.
7. **Version-negotiated.** Each provider declares the SDK version it targets; the loader refuses or shims incompatible ones instead of crashing.

---

## 3. The interception taxonomy (the heart of the design)

Every harness falls into one of these control surfaces. Pick the strategy by answering questions top-to-bottom:

```
Does the harness let you run code on each tool call?
├── YES, via a settings/hooks file (exit-code gate) ........ SettingsHookStrategy   (Claude Code)
├── YES, via a plugin runtime (async throw to deny) ........ PluginStrategy         (OpenCode)
├── YES, but only through MCP tool permissions ............. McpGatewayStrategy     (any MCP host)
└── NO native hook of any kind
    ├── It speaks a controllable API / headless server ..... ApiMediatorStrategy    (SDK-driven)
    └── It's an interactive CLI we can only wrap ........... PtyProxyStrategy       (Gemini CLI, Pi, generic)
```

### Strategy ↔ harness matrix

| Harness | Native control surface | Strategy | Approvals | Narrative | Inject prompt |
|---|---|---|---|---|---|
| **Claude Code** | `settings.json` hooks | `SettingsHookStrategy` | exit-code gate | tail JSONL transcript | resume + keystroke / *(or future API)* |
| **OpenCode** | JS plugin + SDK server | `PluginStrategy` | `throw` in `tool.execute.before` | SDK SSE stream | `session.prompt()` |
| **MCP-capable host** | MCP permission protocol | `McpGatewayStrategy` | interpose MCP server | MCP notifications | MCP `prompts`/tool call |
| **Gemini CLI** | *(no documented hooks)* | `PtyProxyStrategy` | parse prompt → write key | stream stdout | write stdin |
| **Pi** | *(treat as opaque CLI)* | `PtyProxyStrategy` or `ApiMediatorStrategy` | parse / API | stdout / API | stdin / API |

> **The payoff of modularity:** if Gemini CLI later ships a real hook/extension system, you write a `GeminiHookStrategy`, change **one line** in the Gemini adapter to use it, and delete the brittle prompt-grammar — **nothing else in the platform changes.** That swap-ability is the entire point.

`PtyProxyStrategy` is the **universal fallback**: any interactive CLI can be wrapped. It's less elegant than a real hook, but it guarantees you can onboard a harness that gives you nothing.

---

## 4. The Harness Provider SDK contract

Create an internal package the adapters compile against. Nothing else in the codebase imports adapter internals.

```
relay-deamon1/
  src/
    harness-sdk/                 ← the contract + shared machinery (stable API)
      index.js                   ← re-exports types, strategies, helpers
      types.d.ts                 ← HarnessProvider, capabilities, canonical schemas
      schema.js                  ← normalize/validate RelayRequest & NarrativeEvent
      transport.js               ← upload(), waitForDecision(), postNarrative() (reused by ALL)
      risk.js, parsers.js        ← shared scoring (moved from src/, harness-neutral core)
      strategies/
        settingsHook.js
        plugin.js
        mcpGateway.js
        ptyProxy.js
        apiMediator.js
        null.js
      scaffold.js                ← `npm run new-harness <id>` generator
    harnesses/                   ← ONE folder per harness, auto-discovered
      claude-code/
        provider.js
        manifest.json
      opencode/
        provider.js
        plugin/relay.js
        manifest.json
      gemini-cli/                ← added later, no core change
        provider.js
        grammar.js               ← prompt-detection rules (PtyProxy)
        manifest.json
    registry.js                  ← globs src/harnesses/*, validates, exposes getAdapter()
```

### 4.1 The provider interface

```ts
// harness-sdk/types.d.ts
export interface HarnessManifest {
  id: string;                         // 'claude-code' | 'opencode' | 'gemini-cli' | ...
  displayName: string;
  version: string;                    // adapter version
  sdkVersion: string;                 // Harness SDK contract it targets, e.g. '^1.0.0'
  capabilities: HarnessCapabilities;
}

export interface HarnessCapabilities {
  approvals:   boolean;   // can pause tool calls for mobile approval
  narrative:   boolean;   // can stream the agent's reasoning text
  injection:   boolean;   // can receive a prompt from mobile mid-session
  fileTree:    boolean;   // can serve a file browser
  sessionList: boolean;   // can enumerate active sessions
  // declares HOW approvals work so the UI can warn (e.g. PTY parsing is best-effort)
  approvalMechanism: 'hook' | 'plugin' | 'mcp' | 'pty-proxy' | 'api' | 'none';
}

export interface HarnessProvider {
  manifest: HarnessManifest;

  // Detection
  detect(): Promise<{ installed: boolean; version?: string }>;

  // Mobile-support lifecycle (idempotent, must be safe to call repeatedly)
  mobile: {
    enable(ctx: MachineCtx): Promise<void>;
    disable(): Promise<void>;
    status(): Promise<{ enabled: boolean }>;
  };

  // Runtime pieces — each is OPTIONAL and present only if the matching capability is true.
  interceptor?: Interceptor;   // approvals
  narrator?:    Narrator;      // narrative
  injector?:    Injector;      // injection
  fsProvider?:  FsProvider;    // fileTree
  sessions?:    SessionLister; // sessionList
}
```

The runtime pieces are tiny, single-purpose contracts — this is what makes capabilities composable:

```ts
export interface Interceptor {
  // Long-running; calls back for each tool the harness attempts.
  // The strategy implementation handles the harness-specific gate.
  start(handlers: {
    onRequest: (req: RelayRequest) => Promise<'approved' | 'denied'>;
  }): Promise<Stop>;
}

export interface Narrator {
  start(emit: (e: NarrativeEvent) => void): Promise<Stop>;
}

export interface Injector {
  deliver(sessionId: string | null, prompt: string, cwd: string): Promise<boolean>;
}

export interface FsProvider   { tree(sessionId: string | null, path: string): Promise<FsNode[]>; }
export interface SessionLister{ list(): Promise<AgentSession[]>; }

type Stop = () => void;
```

### 4.2 Canonical schemas (the universal boundary)

Every adapter — hook, plugin, or PTY — produces exactly these. `schema.js` validates on the way out so a buggy adapter can't poison the pipeline.

```ts
export interface RelayRequest {
  id: string;
  harness: string;                    // ← stamped by the registry, adapters don't set it wrong
  session_id: string | null;
  tool_name: string;                  // normalized: 'bash' | 'edit' | 'write' | 'read' | ...
  display_type: 'command' | 'edit' | 'read' | 'unknown';
  summary: string;
  risk: { level: 'low'|'medium'|'high'; reason: string; icon: string };
  files_affected: string[];
  command?: string; file_path?: string;
  old_content?: string; new_content?: string;
  raw_input?: unknown;                // the harness's original payload, untouched
}

export interface NarrativeEvent {
  session_id: string;
  harness: string;
  event_type: 'output' | 'tool_start' | 'tool_end' | 'notify' | 'stop';
  summary?: string; tool_name?: string; detail?: string; status?: string;
}
```

> **Tool-name normalization is mandatory.** Claude Code calls it `Bash`; OpenCode calls it `bash`; Gemini might call it `run_shell_command`. Each adapter maps its native tool names to the canonical set in `RelayRequest.tool_name`, keeping the original in `raw_input`. The phone and risk engine only ever see canonical names.

---

## 5. Reusable interception strategies

Strategies are the shared machinery adapters compose. An adapter is usually ~50 lines: "detect the CLI, configure a strategy, map tool names."

### 5.1 `SettingsHookStrategy` (Claude Code)

Wraps the existing `settings.json` hook + `hook.js` exit-code gate. The adapter just supplies: which file, the hook block, the tool matchers, and a parser. **The existing `hook.js`/wrappers stay exactly as they are** — this strategy is a thin orchestrator around them.

```js
// harness-sdk/strategies/settingsHook.js  (sketch)
export function settingsHookStrategy({ settingsFile, buildHookBlock, allowList }) {
  return {
    async enable() { /* write hook block + permissions.allow (existing main.js logic) */ },
    async disable() { /* remove them (existing logic) */ },
    async status() { /* read settings, check PreToolUse present */ },
    // approvals are delivered by the hook scripts themselves via transport.js
  }
}
```

### 5.2 `PluginStrategy` (OpenCode)

Installs a plugin file + env into the harness's plugin dir, gates by a flag file, uses the harness SDK/event stream. Exactly the OpenCode mechanism from `MULTI_HARNESS_GUIDE.md §5.3–5.5`, generalized so other plugin-capable harnesses reuse it.

```js
export function pluginStrategy({ pluginDir, pluginSrc, flagFile }) {
  return {
    async enable(ctx) { /* copy plugin, write env json, touch flagFile */ },
    async disable()   { /* rm flagFile (+ optionally plugin) */ },
    async status()    { /* exists(plugin) && exists(flag) */ },
  }
}
```

### 5.3 `McpGatewayStrategy` (any MCP-capable host)

Many agents (and more every month) accept **MCP servers** and route tool permissions through them. Here the strategy **registers a Vibe Remote MCP server** in the harness's MCP config. That MCP server is the gate: when the agent asks to run a tool, the MCP permission flow calls out to the phone.

```js
export function mcpGatewayStrategy({ mcpConfigPath, serverEntry }) {
  return {
    async enable(ctx) { /* add { "vibe-relay": { command: serverEntry } } to mcp config */ },
    async disable()   { /* remove that entry */ },
    async status()    { /* entry present? */ },
  }
}
```

This is attractive because **one MCP server can serve many MCP-capable harnesses** — write it once, reuse across all of them.

### 5.4 `PtyProxyStrategy` (Gemini CLI, Pi, any interactive CLI — the universal fallback)

When a harness offers **no programmatic control**, wrap it in a pseudo-terminal. This is the most involved strategy, which is why it's shared infrastructure rather than per-adapter code.

**How it works:**
1. The user runs the harness **through a Vibe shim** instead of directly — e.g. the desktop registers a wrapper command `vibe run gemini …`, or the dashboard launches it. The shim spawns the real CLI inside `node-pty`.
2. All PTY output is streamed as `NarrativeEvent`s (narrative for free).
3. A per-harness **prompt grammar** (regexes) detects approval prompts in the stream. On a match, the proxy:
   - extracts a summary (the command/file from the captured lines),
   - uploads a `RelayRequest`, **pauses forwarding**, awaits the phone decision,
   - writes the corresponding keystroke (`y`/`n`/arrow+enter) back into the PTY.
4. Prompt injection = write text + Enter to PTY stdin.

```js
// harness-sdk/strategies/ptyProxy.js  (sketch)
import pty from 'node-pty'

export function ptyProxyStrategy({ command, args, grammar, mapPromptToRequest }) {
  // grammar: { detect(buffer) -> {matched, summary, answers:{approve, deny}} | null }
  return {
    spawn(cwd, { onNarrative, onRequest }) {
      const term = pty.spawn(command, args, { cwd, cols: 120, rows: 30 })
      let buf = ''
      term.onData(async chunk => {
        process.stdout.write(chunk)                 // user still sees their terminal
        onNarrative({ event_type: 'output', summary: chunk })
        buf += chunk
        const hit = grammar.detect(buf)
        if (hit?.matched) {
          buf = ''
          const req = mapPromptToRequest(hit)        // → canonical RelayRequest
          const decision = await onRequest(req)      // upload + wait (transport.js)
          term.write(decision === 'approved' ? hit.answers.approve : hit.answers.deny)
        }
      })
      return {
        inject: (text) => term.write(text + '\r'),   // prompt injection
        stop:   () => term.kill(),
      }
    },
    // enable/disable here just register/unregister the `vibe run` shim
    async enable() {/* install shim / mark active */},
    async disable() {/* remove shim */},
    async status() {/* shim active? */},
  }
}
```

**The only per-harness work is `grammar.js`** — describe what that CLI's approval prompt looks like and which keys answer it. Example skeleton for Gemini CLI:

```js
// harnesses/gemini-cli/grammar.js  (ILLUSTRATIVE — derive real patterns empirically)
export const grammar = {
  detect(buffer) {
    // e.g. Gemini shows: "Allow execution of 'rm -rf build'? [y/N]"
    const m = buffer.match(/Allow execution of [`'"]?(.+?)[`'"]?\?\s*\[y\/N\]/i)
    if (!m) return null
    return {
      matched: true,
      summary: m[1],
      answers: { approve: 'y\r', deny: 'n\r' },
    }
  },
}
```

> **Security: PTY parsing is best-effort, so fail closed.** If the decision times out or the grammar is uncertain, send the *deny* key, never the approve key. Surface `approvalMechanism: 'pty-proxy'` to the UI so the user knows this harness's gating is pattern-based, not guaranteed like a real hook. Pin the harness version per grammar; a CLI cosmetic change can shift a prompt string.

### 5.5 `ApiMediatorStrategy` (headless / server-driven)

If a harness can run as a server or be driven entirely by an SDK (no interactive TUI), mediate everything through its API: subscribe to its tool/permission events for approvals, its message stream for narrative, and its prompt endpoint for injection. OpenCode could *also* be run this way; Pi may fit here if it exposes an API.

### 5.6 `NullStrategy` (read-only mirror)

For a harness you can observe but not gate (e.g., you can tail its logs but not block it). `capabilities.approvals = false`. The phone shows activity and narrative but no approve/deny buttons. Still useful, and proves the capability-degradation path works.

---

## 6. Registry, discovery & version negotiation

### 6.1 Auto-discovery

```js
// src/registry.js
import { readdirSync } from 'fs'
import { join } from 'path'
import { validateProvider } from './harness-sdk/index.js'

const dir = join(__dirname, 'harnesses')
const providers = new Map()

for (const id of readdirSync(dir)) {
  try {
    const mod = await import(join(dir, id, 'provider.js'))
    const p = mod.default
    validateProvider(p)                      // checks manifest + sdkVersion + capability/impl agreement
    providers.set(p.manifest.id, p)
  } catch (e) {
    console.warn(`[registry] skipped harness "${id}": ${e.message}`)   // one bad adapter never breaks the rest
  }
}

export const getAdapter   = (id) => providers.get(id) || null
export const allAdapters  = () => [...providers.values()]
```

`validateProvider` enforces the **capability/implementation contract**: if `capabilities.approvals === true`, an `interceptor` must exist; if `narrative === true`, a `narrator` must exist; etc. This catches "declared but not implemented" at load time, not in production.

### 6.2 Third-party harnesses (optional, for true open extensibility)

Because discovery is folder/manifest based, you can later allow **npm-published** harness adapters (`vibe-harness-aider`, etc.): install into a user plugins dir, the registry globs that dir too. The `sdkVersion` field gates compatibility. You get an ecosystem without shipping every adapter in-app.

### 6.3 Version negotiation

- Provider declares `sdkVersion: '^1.2.0'`.
- Loader compares against the SDK's current version; **major mismatch → skip with a clear log**; minor/patch → load.
- New optional capabilities are additive: an old adapter simply doesn't set them, and the UI hides those features. No forced lockstep upgrades.

---

## 7. Worked example — adding **Gemini CLI** with zero core changes

This is the whole point: a new harness is a folder.

```bash
cd relay-deamon1
npm run new-harness gemini-cli        # scaffold.js stamps the folder from a template
```

Then fill in three files:

**`src/harnesses/gemini-cli/manifest.json`**
```json
{
  "id": "gemini-cli",
  "displayName": "Gemini CLI",
  "version": "0.1.0",
  "sdkVersion": "^1.0.0",
  "capabilities": {
    "approvals": true, "narrative": true, "injection": true,
    "fileTree": false, "sessionList": false,
    "approvalMechanism": "pty-proxy"
  }
}
```

**`src/harnesses/gemini-cli/grammar.js`** — the only harness-specific logic (the approval-prompt rules, §5.4).

**`src/harnesses/gemini-cli/provider.js`**
```js
import manifest from './manifest.json' assert { type: 'json' }
import { ptyProxyStrategy, transport, normalizeRequest } from '../../harness-sdk/index.js'
import { grammar } from './grammar.js'

const strategy = ptyProxyStrategy({
  command: 'gemini', args: [],
  grammar,
  mapPromptToRequest: (hit) => normalizeRequest({
    tool_name: 'bash', display_type: 'command',
    summary: hit.summary, command: hit.summary,
    risk: { level: 'medium', reason: 'shell command', icon: '?' },
  }),
})

export default {
  manifest,
  detect: async () => {
    try { await transport.exec('gemini', ['--version']); return { installed: true } }
    catch { return { installed: false } }
  },
  mobile: strategy,                                   // enable/disable/status (shim registration)
  interceptor: { start: strategy.asInterceptor },     // approvals via PTY parse
  narrator:    { start: strategy.asNarrator },        // stdout stream
  injector:    { deliver: strategy.asInjector },      // PTY stdin
}
```

Done. The registry discovers it, the dashboard shows a "Gemini CLI" toggle **only if `detect()` says installed**, the phone shows requests tagged `gemini-cli` with a "pattern-based gating" hint, and **not one line of Claude Code, OpenCode, server, or mobile core changed.**

**Adding Pi** is the same recipe: if Pi has an API → `ApiMediatorStrategy`; if it's a bare CLI → `PtyProxyStrategy` + a `grammar.js`. The decision is §3's matrix.

---

## 8. Capability propagation to server & mobile

The server and mobile stay **100% harness-agnostic** — they react to declared capabilities, never to harness IDs.

### 8.1 Server

Extend `machine_harnesses` (from `MULTI_HARNESS_GUIDE.md §3`) with a capabilities column:

```sql
alter table machine_harnesses
  add column if not exists capabilities jsonb not null default '{}'::jsonb,
  add column if not exists version text,
  add column if not exists display_name text;
```

The desktop's `/harness/report` (already defined in the first guide) now also sends each provider's `manifest.capabilities`, `version`, and `displayName`. No new endpoints. The server stores and relays them verbatim.

### 8.2 Mobile renders by capability, not by name

```tsx
// The phone asks: what can THIS harness do? and renders accordingly.
const caps = harness.capabilities

{caps.approvals  && <ApproveDenyButtons request={req} />}
{caps.narrative  && <TerminalTab sessionId={sid} />}
{caps.injection  && <PromptComposer sessionId={sid} />}
{caps.fileTree   && <FileBrowserTab sessionId={sid} />}
{caps.approvalMechanism === 'pty-proxy' &&
  <Hint>Approvals for {harness.displayName} are pattern-based — verify on screen.</Hint>}

<HarnessBadge id={harness.id} name={harness.displayName} />   // generic, data-driven
```

Add a small **harness registry on the client too** — but only for *cosmetics* (icon, color per id), with a sensible default so an unknown harness still renders. The functional behavior is entirely capability-driven, so a brand-new harness works on an un-updated phone.

---

## 9. Keeping Claude Code intact — conformance lock

The existing implementation must never regress. Two safeguards:

1. **Claude Code is the reference adapter** built on `SettingsHookStrategy` that *wraps the current `hook.js`, wrappers, and heartbeat transcript/injection code unchanged.* The refactor is "move orchestration behind the interface," not "rewrite the runtime."

2. **A conformance test suite** that any adapter (Claude Code included) must pass, run in CI:

```js
// test/harness-conformance.test.js  (run for every registered provider)
for (const p of allAdapters()) {
  test(`${p.manifest.id}: manifest valid`,            () => validateProvider(p))
  test(`${p.manifest.id}: capabilities ↔ impls`,      () => assertCapabilityImpls(p))
  test(`${p.manifest.id}: enable→status→disable`,     async () => { /* idempotent round-trip on a temp HOME */ })
  test(`${p.manifest.id}: emits canonical RelayRequest`, () => assertSchema(p.sampleRequest))
  if (p.manifest.id === 'claude-code') {
    test('claude-code: writes exact legacy hook block', () => assertLegacyHookShape())
    test('claude-code: settings restored on disable',   () => assertNoResidue())
  }
}
```

The Claude-Code-specific assertions pin the literal `settings.json` shape your users already depend on. If a future change alters it, CI fails before shipping. **That is what lets you evolve the platform fearlessly.**

---

## 10. Lifecycle, failure modes & security

- **Idempotency.** `enable`/`disable` must be safe to call repeatedly and must converge — the desktop calls them on toggle, on launch reconcile, and on desired-state apply.
- **Reconcile on launch.** On startup the daemon: detects installed harnesses → reads each `status()` → reports to `/harness/report`. The DB always reflects reality, even after a crash.
- **Fail-closed gating.** Hook/plugin strategies honor `config.failOpen`. **PTY/grammar strategies should default fail-*closed*** (deny on timeout/uncertainty) because a missed approve is annoying but a wrongful approve is dangerous. Make this explicit per strategy and surface it via `approvalMechanism`.
- **One bad adapter can't sink the app.** Registry load, narrative watchers, and interceptors are each wrapped so a throwing adapter is logged and skipped, never fatal.
- **No narrative double-emit.** A harness must pick a single narrative source (plugin event *or* SDK stream *or* PTY stdout). The `Narrator` contract is singular by design.
- **Secrets stay server-side.** Adapters only ever hold the **machine API key** (already on the machine) and talk to the VPS; the Supabase **service key** never reaches an adapter, same as today.
- **Per-harness session namespacing.** Treat `(harness, session_id)` as the key everywhere (DB already gets a `harness` column in the first guide).

---

## 11. Directory layout & rollout

**Rollout order (each step reversible, Claude Code never breaks):**

1. Land `harness-sdk/` (contract + `transport.js` + `schema.js` + moved `risk.js`/`parsers.js`) — pure addition.
2. Add `SettingsHookStrategy` and migrate Claude Code to the **reference adapter**; ship behind the same toggle; **conformance tests green**. Users see no change.
3. Add the registry + capability-driven `/harness/report`; desktop UI lists harnesses (just Claude Code so far).
4. Land `PluginStrategy` + OpenCode adapter (this is exactly `MULTI_HARNESS_GUIDE.md`, now expressed as a strategy).
5. Land `PtyProxyStrategy` + `scaffold.js`. Add **Gemini CLI** as the first PTY harness — proves the no-hook path end to end.
6. Capability-driven mobile rendering (§8.2).
7. (Optional) `McpGatewayStrategy`, `ApiMediatorStrategy`, npm third-party adapters.

**Definition of done for *any* new harness:**

- [ ] `manifest.json` with honest `capabilities` + `approvalMechanism`.
- [ ] `provider.js` ≤ ~80 lines, composing a shared strategy.
- [ ] Tool names normalized to the canonical set.
- [ ] `detect()` correct (installed vs not).
- [ ] `enable→status→disable` idempotent round-trip passes conformance.
- [ ] Emits valid canonical `RelayRequest` / `NarrativeEvent` (schema-validated).
- [ ] Fail-closed behavior verified for PTY/grammar strategies.
- [ ] Phone shows only the capabilities the harness actually has.
- [ ] **Claude Code conformance suite still green.**
- [ ] Zero edits to: server core, mobile core, other adapters.

---

## 12. Summary

- **Capabilities, not mechanisms**, are the contract. Harnesses declare what they can do; the platform adapts.
- **Interception is a swappable strategy** — `SettingsHook`, `Plugin`, `McpGateway`, `PtyProxy`, `ApiMediator`, `Null` — so even a harness with *no* hooks (Gemini CLI, Pi) onboards via the PTY fallback, and upgrades to a better strategy later without ripple.
- **Adapters are isolated, auto-discovered folders** depending only on the **Harness SDK**, emitting one **canonical schema**.
- **Claude Code is conformance-locked**, so the platform grows without ever risking the working path.
- Server and mobile stay **harness-agnostic forever** — they key off `harness` + `capabilities`, never off a hardcoded list.

Add harness #5 by writing a folder. That's the goal, and this is the structure that gets you there.

---

## Sources

- [OpenCode — Plugins](https://opencode.ai/docs/plugins/) · [SDK](https://opencode.ai/docs/sdk/) · [Config](https://opencode.ai/docs/config/) — plugin/SDK strategy details.
- [Does OpenCode Support Hooks? (DEV)](https://dev.to/einarcesar/does-opencode-support-hooks-a-complete-guide-to-extensibility-k3p) — hook/permission model.
- Mechanism taxonomy (hook / plugin / MCP / PTY-proxy / API) is derived from the control surfaces these CLIs expose; PTY-proxy grammars for Gemini CLI / Pi must be derived empirically against the installed version.
