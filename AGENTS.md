# ADE Project Instructions

## About this project

- ADE is a local-first desktop application for orchestrating coding agents, missions, lanes, PR workflows, and proof/artifact capture.
- The main product lives in `apps/desktop` and is built with Electron, React, and TypeScript.
- The ADE CLI lives in `apps/ade-cli` and shares core services with the desktop app.
- State is primarily stored under `.ade/` inside the active project, with runtime metadata in SQLite and machine-local files under `.ade/secrets`, `.ade/cache`, and `.ade/artifacts`.

## Working norms

- Preserve existing desktop app patterns before introducing new abstractions.
- Prefer fixing the underlying service or shared type rather than layering renderer-only workarounds on top.
- Keep IPC contracts, preload types, shared types, and renderer usage in sync whenever an interface changes.
- For ADE CLI changes, verify both headless mode and the desktop socket-backed ADE RPC path.
- For computer-use changes, treat policy enforcement and artifact ownership as hard requirements, not prompt guidance.

## Validation

- Desktop checks:
  - `npm --prefix apps/desktop run typecheck`
  - `npm --prefix apps/desktop run test`
  - `npm --prefix apps/desktop run build`
  - `npm --prefix apps/desktop run lint`
- ADE CLI checks:
  - `npm --prefix apps/ade-cli run typecheck`
  - `npm --prefix apps/ade-cli run test`
  - `npm --prefix apps/ade-cli run build`
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

### Inspecting the local Electron desktop app with Codex Computer Use on macOS

- To inspect ADE desktop parity locally with Codex Computer Use, launch the dev app from the worktree with `npm run dev` in `apps/desktop`.
- Treat the Electron process spawned by that command as the source of truth, even if the window title or bundle branding says "ADE". In Codex Computer Use, call `list_apps` / `get_app_state` and prefer the `Electron` app entry (`App=com.github.Electron`) over the installed `ADE` app entry (`App=com.ade.desktop`).
- Confirm the Codex Computer Use app state shows an ADE window whose HTML content URL contains `localhost:5173`. That is the local dev Electron surface.
- The first `Electron` window exposed to Codex Computer Use may be DevTools (`Developer Tools - http://localhost:5173/`). Press `Cmd+\`` in the `Electron` app to cycle to the main ADE window before interacting with the app.
- On first launch, the dev app may open to `localhost:5173/#/project` with no project selected. Open the recent `ADE /Users/admin/Projects/ADE` project inside that dev window before comparing desktop parity.
- Do not use Safari as the desktop parity reference. ADE desktop parity should be checked against the Electron app surface unless the task explicitly asks for renderer-only Vite behavior.
- Keep the dev terminal logs visible while inspecting. Useful confirmation lines include `dev launcher using http://localhost:5173`, `DevTools listening on ws://127.0.0.1:9222`, `window.loading_url`, and `renderer.route_change`.

### Pairing the iOS simulator with the desktop dev app on macOS

- When the user wants the ADE iOS app paired to desktop, run the desktop dev app from the active lane's `apps/desktop`, but set `ADE_PROJECT_ROOT` to the ADE project root the phone should sync with. For this local setup, that is commonly `ADE_PROJECT_ROOT=/Users/arul/ADE npm run dev`, even when the code under test is in `/Users/arul/ADE/.ade/worktrees/...`.
- Do not interact with an already-open Xcode GUI window unless the user explicitly says it is the ADE iOS project. Other projects may be open. Prefer `xcodebuild` and `xcrun simctl` for building, installing, launching, and inspecting the simulator.
- The desktop sync PIN can be read or configured through the dev Electron preload once the `localhost:5173` page is running. Use the CDP endpoint printed by the dev app (`http://127.0.0.1:9222/json/list`) and evaluate `window.ade.sync.getStatus()` to verify `pairingPinConfigured`, `pairingPin`, the sync port, and `connectedPeers`.
- A successful simulator pairing is not just the Settings screen showing "Connected". Also verify desktop `connectedPeers > 0`, inspect the simulator database under `xcrun simctl get_app_container <UDID> com.ade.ios data`, and check recent simulator logs for `incoming message failed`, `FOREIGN KEY`, or changeset errors.
- If pairing reaches WebSocket but the phone reports `FOREIGN KEY constraint failed` while applying `changeset_batch`, treat it as an iOS sync/materialization bug until disproven. Desktop CRR tables may not enforce the same foreign keys as the iOS SQLite schema, so valid remote CRDT batches can arrive in an order that local foreign-key checks reject.

### Running the Electron desktop app on Linux

- Set `ADE_DISABLE_HARDWARE_ACCEL=1` — the VM has no real GPU, and without this the app crashes on `WebGL1 blocklisted`.
- `node-pty` ships only macOS/Windows prebuilds. After `npm install`, run `npm --prefix apps/desktop run rebuild:native` to compile `pty.node` for Electron on Linux. Then manually compile the spawn-helper: `cd apps/desktop/node_modules/node-pty && g++ -o build/Release/spawn-helper src/unix/spawn-helper.cc`.
- The `npm run dev` script has a race condition: `predev` clears `dist/`, then tsup + Electron start in parallel, so the first Electron launch fails with "Cannot find module main.cjs" and auto-restarts. To avoid this, pre-build first (`npm run build`) then run the dev launcher directly: `node scripts/normalize-runtime-binaries.cjs && node scripts/ensure-electron.cjs && node scripts/dev.cjs`.
- Alternatively, start Vite and Electron separately for more control: `npx vite --port 5173 --strictPort --force &` then `VITE_DEV_SERVER_URL=http://localhost:5173 npx electron . --no-sandbox`.
- `cr-sqlite` extension binaries are only available for macOS. On Linux the app logs `db.crsqlite_unavailable` as a warning and continues without CRDT sync — this is non-blocking for development.
- The `ADE_PROJECT_ROOT=/workspace` env var tells the main process to auto-open a project at startup. However, there is a timing race: the renderer's initial `getProject()` call may return null before the async project switch completes, causing the welcome screen to appear even though the backend loaded the project. A workaround is to open the project manually via the "Open a project" button in the top bar.
- Computer-use features (screenshot, video capture, GUI automation) are macOS-only (`screencapture`, `osascript`). On Linux these gracefully degrade — the app returns `blocked_by_capability`.
- `electron-builder` config only defines a `mac` target. Distributable Linux builds (deb/AppImage) are not configured, but dev mode works fine.
