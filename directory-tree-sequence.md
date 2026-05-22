# Directory tree request flow

This document describes how a directory tree request is handled and returned to the requester.

## Scope
This flow is based on code in this repo:
- relay-deamon1/scripts/heartbeat.js
- relay-deamon1/src/supabase.js
- src/main.js

The creation of the request on the mobile/server side is not in this repo, so those steps are described at a high level.

## Sequence (function calls)
1) Desktop app keeps the relay daemon running
   - src/main.js: startHeartbeat() spawns relay-deamon1/scripts/heartbeat.js
   - The heartbeat process runs for the lifetime of the desktop app

2) Heartbeat loop polls for pending file-tree requests
   - relay-deamon1/scripts/heartbeat.js: setInterval(checkFsRequests, 5000)
   - checkFsRequests() calls getPendingFsRequest()

3) Pending request fetch
   - relay-deamon1/src/supabase.js: getPendingFsRequest()
   - getPendingFsRequest() -> apiGet('/machines/fs/pending')
   - apiGet() -> fetch(config.apiUrl + '/machines/fs/pending')

4) Tree extraction (filesystem walk)
   - relay-deamon1/scripts/heartbeat.js: buildTree(absoluteRoot, requestedPath, baseCwd, maxDepth)
   - checkFsRequests() picks:
     - root = pending.sessionCwd ?? process.cwd()
     - requestedPath = pending.path ?? '.'
     - maxDepth = 4
   - buildTree() does:
     - fullPath = path.resolve(absoluteRoot, requestedPath)
     - Guard: if (!fullPath.startsWith(baseCwd)) throw 'Path traversal blocked'
     - entries = fs.readdirSync(fullPath, { withFileTypes: true })
     - filter out SKIP_DIRS and hidden entries (names starting with '.')
     - sort directories first, then alphabetical
     - recurse into subdirectories until depth == maxDepth
     - for files, add size via fs.statSync()

5) Response upload (back to the other side)
   - relay-deamon1/scripts/heartbeat.js: respondFsRequest(pending.id, { tree })
   - relay-deamon1/src/supabase.js: respondFsRequest()
   - respondFsRequest() -> apiPost('/machines/fs/respond', { requestId, tree })
   - apiPost() -> fetch(config.apiUrl + '/machines/fs/respond')
   - If tree build fails: respondFsRequest(pending.id, { error: err.message })

## Response shape (summary)
Each node is emitted as:
- Directory: { name, path, type: 'dir', children }
- File:      { name, path, type: 'file', size }

Note: children is null when depth limit is reached so the mobile side can request deeper nodes later.

## Notes
- Polling interval: 5 seconds
- Depth limit: 4
- Hidden files/dirs are excluded
- Skip dirs: node_modules, .git, dist, .next, __pycache__, .venv, build
- Security: path traversal is blocked by enforcing fullPath starts with baseCwd
