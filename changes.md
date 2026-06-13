Everything looks correct. Here's a summary of all changes made:

  ---
  Desktop changes — done

  src/supabase.js — 4 new exports

  - apiGet(path) — private GET helper (mirrors existing apiPost)
  - agentPing(sessionId, cwd, toolName) → POST /relay/agent-ping
  - getNextCommand() → GET /mobile/command/next
  - getPendingFsRequest() → GET /machines/fs/pending
  - respondFsRequest(requestId, treeOrError) → POST /machines/fs/respond

  hook.js — agent-ping on every tool call

  After parsing the event, before uploading the request row, it now calls agentPing to upsert the session into the agents table and keep last_activity_at fresh. Failures are silently logged — they
  never block a tool call.

  scripts/heartbeat.js — two new loops added

  ┌──────────────────────┬──────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │         Loop         │ Interval │                                                                       What it does                                                                       │
  ├──────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Machine heartbeat    │ 30s      │ unchanged                                                                                                                                                │
  ├──────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ checkPendingCommands │ 10s      │ Calls /mobile/command/next; if server returns a prompt (only when Claude is idle), spawns claude --resume <sessionId> -p "prompt" in the session's cwd   │
  ├──────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ checkFsRequests      │ 5s       │ Calls /machines/fs/pending; if a request exists, runs buildTree (depth 4, skips node_modules/.git/etc, path-traversal blocked) and posts the result back │
  └──────────────────────┴──────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  ---
  
  Next step is Step 2+4 on the server — POST /relay/agent-ping and GET /mobile/sessions endpoints (plus the pending_count bookkeeping on /relay/upload and /mobile/decide). Ready when you are.