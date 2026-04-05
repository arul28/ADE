# ADE Project Instructions

## About this project

- ADE is a local-first desktop application for orchestrating coding agents, missions, lanes, PR workflows, and proof/artifact capture.
- The main product lives in `apps/desktop` and is built with Electron, React, and TypeScript.
- The ADE MCP server lives in `apps/mcp-server` and shares core services with the desktop app.
- State is primarily stored under `.ade/` inside the active project, with runtime metadata in SQLite and machine-local files under `.ade/secrets`, `.ade/cache`, and `.ade/artifacts`.

## Working norms

- Preserve existing desktop app patterns before introducing new abstractions.
- Prefer fixing the underlying service or shared type rather than layering renderer-only workarounds on top.
- Keep IPC contracts, preload types, shared types, and renderer usage in sync whenever an interface changes.
- For ADE MCP changes, verify both headless MCP mode and the desktop socket-backed MCP path.
- For computer-use changes, treat policy enforcement and artifact ownership as hard requirements, not prompt guidance.

## Validation

- Desktop checks:
  - `npm --prefix apps/desktop run typecheck`
  - `npm --prefix apps/desktop run test`
  - `npm --prefix apps/desktop run build`
  - `npm --prefix apps/desktop run lint`
- MCP checks:
  - `npm --prefix apps/mcp-server run typecheck`
  - `npm --prefix apps/mcp-server run test`
  - `npm --prefix apps/mcp-server run build`
- Run the smallest relevant subset first when iterating, then finish with the broader checks that cover the touched surfaces.

## Terminology

- Use "lane" for ADE worktrees/branches.
- Use "mission" for orchestrated multi-step work.
- Use "computer use" for screenshot/video/GUI/browser proof flows.
## Style preferences

- Prefer direct, operational language over marketing phrasing.
- Keep user-facing copy concrete and stateful: say what changed, what is blocked, and what the next action is.
- Use sentence case for headings and labels unless the existing UI pattern is intentionally uppercase.

## Content boundaries

- Do not reframe ADE as a docs site, Mintlify project, or generic template app.
- Do not store secrets in plaintext project files when an encrypted store already exists.
- Do not leave policy enforcement in prompts alone when a code path can enforce it directly.

## Cursor Cloud specific instructions

### Environment overview

- **Node.js 22.x** is required (`node:sqlite` is used as the primary database engine).
- Each app under `apps/` has its own independent `node_modules` and `package-lock.json` (no npm workspaces).
- Validation commands are documented in the "Validation" section above.
- The desktop test suite (265 test files) is large; CI shards it. For local iteration, run targeted tests (e.g. `npm --prefix apps/desktop run test:unit`) or a single file rather than the full suite.

### Running the Electron desktop app on Linux

- Set `ADE_DISABLE_HARDWARE_ACCEL=1` — the VM has no real GPU, and without this the app crashes on `WebGL1 blocklisted`.
- `node-pty` ships only macOS/Windows prebuilds. After `npm install`, run `npm --prefix apps/desktop run rebuild:native` to compile `pty.node` for Electron on Linux. Then manually compile the spawn-helper: `cd apps/desktop/node_modules/node-pty && g++ -o build/Release/spawn-helper src/unix/spawn-helper.cc`.
- The dev launcher (`scripts/dev.cjs`) starts **tsup first**, waits for a stable `dist/main/main.cjs`, then starts Vite and Electron so the first load does not race a missing main bundle after `predev` clears `dist/`.
- Vite dev binds with **`server.host: true`** so both IPv4 (`127.0.0.1`) and IPv6 (`::1`) can reach the dev server on Linux VMs.
- On Linux, Electron is launched with **`--no-sandbox`** by default (needed in many containers). Set **`ADE_ELECTRON_NO_SANDBOX=0`** to skip that flag when running on a full desktop.
- Optional: capture a PNG of the Electron window via CDP: `node scripts/capture-dev-screenshot.mjs <remote-debug-port> /tmp/out.png` (requires dev server running with matching `--remote-debugging-port`).
- For a one-shot VM proof (starts dev, waits for the Vite URL, captures, tears down): `bash apps/desktop/scripts/vm-dev-screenshot.sh`.
- Alternatively, start Vite and Electron separately for more control: `npx vite --port 5173 --strictPort --force &` then `VITE_DEV_SERVER_URL=http://localhost:5173 npx electron . --no-sandbox`.
- `cr-sqlite` extension binaries are only available for macOS. On Linux the app logs `db.crsqlite_unavailable` as a warning and continues without CRDT sync — this is non-blocking for development.
- The `ADE_PROJECT_ROOT=/workspace` env var tells the main process to auto-open a project at startup. However, there is a timing race: the renderer's initial `getProject()` call may return null before the async project switch completes, causing the welcome screen to appear even though the backend loaded the project. A workaround is to open the project manually via the "Open a project" button in the top bar.
- Computer-use features (screenshot, video capture, GUI automation) are macOS-only (`screencapture`, `osascript`). On Linux these gracefully degrade — the app returns `blocked_by_capability`.
- `electron-builder` config only defines a `mac` target. Distributable Linux builds (deb/AppImage) are not configured, but dev mode works fine.
