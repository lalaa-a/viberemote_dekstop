# Route ALL OpenCode permission requests to mobile — Implemented

Companion to `ALL_TOOLS_TO_MOBILE.md` (the Claude Code fix). Same problem, different mechanism.

## The problem

With OpenCode mobile support enabled, some tools that **require a CLI accept** (`webfetch`,
`websearch`, `external_directory`, or anything the user set to `"ask"`) never reached the phone —
the approval prompt only showed in the terminal.

Why: the plugin gated tools through a **fixed list** in `tool.execute.before`:

```js
const GATED = new Set(['bash', 'edit', 'write', 'patch'])
if (!GATED.has(input.tool)) return   // everything else → OpenCode's native TUI prompt
```

That list works for the write tools because they're **`"allow"` by default** in OpenCode (no native
prompt), so the plugin's gate is their *only* prompt. But anything OpenCode itself asks about
(`permission: "ask"`) fired OpenCode's **own** permission flow, which the plugin ignored — so it
showed only in the CLI. Simply adding those tools to `GATED` wouldn't help: it would stack a *second*
(mobile) prompt on top of the CLI one, because throwing in `tool.execute.before` doesn't answer
OpenCode's permission request.

## The mechanism (from the docs / SDK)

OpenCode's real permission model:

- Default is **`"allow"`** for most tools; only `external_directory` / `doom_loop` default to `"ask"`,
  `.env` is `"deny"`. Config maps tool → `allow | ask | deny`, with a `"*"` wildcard.
- When a tool needs approval, OpenCode fires a **`permission.updated`** event carrying
  `{ id, type, sessionID, callID, title, metadata, … }`.
- You answer it with **`POST /session/{id}/permissions/{permissionID}`** body
  `{ response: "once" | "always" | "reject" }`.

So the correct interception point is the **permission event**, not the tool-execute hook — answering
it programmatically is what actually clears the terminal prompt.

## The fix — `src/harnesses/opencode/plugin/relay.js`

- **New `permission.updated` handler** in the plugin's `event` hook: routes the request to the phone
  (`uploadAndWait`) and replies via `respondPermission()` → `once` (approved) / `reject` (denied).
  This covers **every** tool OpenCode asks about — no fixed list — including future/unknown tools.
- **`respondPermission()`** helper: tries the typed client, then a direct `POST` to
  `{serverUrl}/session/{id}/permissions/{permissionID}` (root path, then `/api`) — mirrors the
  existing `replyNativeQuestion()`.
- **De-dup with `tool.execute.before`** (`_gatedByTool` / `_gatedByPerm` maps): in the default config
  the two gates never overlap (write tools are `"allow"`, so no permission event). If a user sets a
  gated write tool to `"ask"`, both would fire — so each gate stamps a map on approval and the other
  skips a call it already handled, in either order. If the tool identity can't be matched, it fails
  **toward asking on mobile** (an extra prompt), never toward a silent allow.
- The `question` permission is skipped (the existing `question.asked` flow already handles it), and
  the completion row is posted only on **denial** (on approval, `tool.execute.after` posts it).

## Deployment (so it lands without a manual toggle)

The plugin file is only copied to `~/.config/opencode/plugin/vibe-relay.js` on **enable** — an
already-enabled OpenCode would keep the old plugin. Claude auto-refreshes its `settings.json` on
launch via `refreshHookPathIfEnabled()`; OpenCode had no equivalent, so:

- **`pluginStrategy.refreshIfEnabled(ctx)`** — re-copies the plugin + env if mobile is on.
- **`opencode/provider.js`** exposes `refreshIfEnabled`.
- **`harness-cli.js` `refresh`** — re-applies install artifacts for every enabled harness (works for
  Claude too).
- **`main.js`** runs `runHarnessCli(['refresh'])` on startup (after `restore`, before `report`).

So a shipped plugin update deploys on the next app launch. (It also lands via the tray
disable-all → restore cycle on quit/relaunch.)

## Files changed

| File | Change |
|---|---|
| `src/harnesses/opencode/plugin/relay.js` | `permission.updated` handler + `respondPermission()` + two-gate de-dup. |
| `src/harness-sdk/strategies/plugin.js` | `refreshIfEnabled(ctx)` — re-copy plugin when enabled. |
| `src/harnesses/opencode/provider.js` | Expose `refreshIfEnabled`. |
| `harness-cli.js` | New `refresh` command. |
| `src/main.js` | Run `refresh` on startup. |

## Notes / limitations

- Requires the packaged `relay-deamon1` to be rebuilt/shipped; applies on the next launch.
- If OpenCode's TUI is interactive, the request may briefly appear in **both** the CLI and the phone;
  answering on the phone clears it (the plugin POSTs the response). That's already a strict
  improvement over CLI-only.
- `permission.updated` reaching the plugin's `event` hook is logged to
  `~/.config/opencode/vibe-relay-debug.log` (`permission.updated tool=… id=…`) for verification.

## To verify (after a rebuild)

1. In OpenCode, set a tool to ask (e.g. `"permission": { "webfetch": "ask" }`) or use one that
   defaults to ask, with mobile support enabled.
2. Trigger it (ask OpenCode to fetch a URL) → the approval appears **on the phone**; approve →
   it runs, deny → it's blocked, with **no** manual terminal accept.
3. `vibe-relay-debug.log` shows the `permission.updated …` line and the `permission respond POST … → 200`.
