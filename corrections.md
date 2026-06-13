OpenCode now shows installed: true, version: "1.16.2". Both Claude Code and OpenCode will appear in the dashboard.

Root cause: execFile without shell: true inherits the stripped PATH from the Node/Electron process, which doesn't include %APPDATA%\npm where npm-global binaries like opencode live. The fix applies shell: true on Windows only — macOS/Linux don't need it.

What changed: one constant SHELL_OPTS in transport.js. Any future harness whose CLI is npm-installed (or anywhere outside the system PATH) will detect correctly for free — you don't need to touch the individual adapters.