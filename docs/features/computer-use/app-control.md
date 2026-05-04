# App Control

App Control is ADE's bridge for driving developer-owned app sessions from inside a chat. The first supported `AppControlAppKind` is `electron`: ADE launches (or connects to) an Electron renderer that exposes a Chrome DevTools Protocol port, captures screenshots and DOM elements, resolves elements back to their source files, and lets the user attach screenshot-backed UI context to a chat as `AppControlContextItem`s.

App Control is intentionally a *bridge*. Other automation stacks — Playwright, agent-browser, browser-use, Claude's `computer_use` — can attach to the same Electron app and continue to be useful. ADE's job is to keep the launch state, the visible launch terminal, screenshots, DOM/selector packets, source candidates, and chat-attached context coherent across those tools.

## Source file map

### Service (apps/desktop/src/main/services/appControl/)

- `appControlService.ts` — the broker. Resolves launch parameters, runs the Electron app inside a chat-owned PTY (so the user sees stdout/stderr), polls the CDP HTTP endpoint for ready targets, attaches a long-lived `CdpClient` WebSocket, and exposes the high-level operations consumed via IPC and the ADE CLI:
  - lifecycle: `getStatus`, `launch` / `launchInTerminal`, `connect`, `stop`, `dispose`, `listTargets`, `attachToTarget`
  - capture: `screenshot`, `getSnapshot` (screenshot + DOM elements), `getViewportScale`
  - context: `inspectPoint`, `selectPoint` — produce an `AppControlContextItem` from page coordinates with element + source-file matches
  - input: `click`, `typeText`, `scroll`, `dispatchKey`
  - launch terminal passthrough: `readTerminal`, `writeTerminal`, `signalTerminal`
  - screencast frames stream out via the `onEvent` channel (`type: "frame"`)
- `appControlService.test.ts` — service tests.

### Shared types

- `apps/desktop/src/shared/types/appControl.ts` — the type contract:
  - identity: `AppControlAppKind`, `AppControlProvider` (`cdp` | `os-accessibility` | `computer-use` | `external`), `AppControlSession` (status: `starting` | `running` | `connected` | `stopping` | `exited` | `stopped` | `failed`). Sessions carry both `projectRoot` and `laneId` so the renderer can detect when an active App Control session is attached to a different lane than the active Work / chat lane and surface a mismatch warning. `AppControlConnectArgs` accepts an optional `laneId`; `connect()` resolves the final lane id through the same `resolveLaneId` strategy as `launch()` and `launchInTerminal()` (caller-supplied id wins; otherwise `chatSessionId` resolves it).
  - capture: `AppControlScreenshot`, `AppControlScreen`, `AppControlElement`, `AppControlFrame`, `AppControlSnapshot`, `AppControlSnapshotProvider`, `AppControlScreencastFrame`.
  - context: `AppControlContextItem` (`kind: "app_control_element"`), `AppControlSourceMatch`, `AppControlInspectResult`, `AppControlSelectResult`.
  - inputs: `AppControlLaunchArgs`, `AppControlConnectArgs`, `AppControlStopArgs`, `AppControlClickArgs`, `AppControlTypeTextArgs`, `AppControlInspectPointArgs`.
  - eventing: `AppControlEventPayload` union (`session-started`, `session-updated`, `session-stopped`, `selection`, `frame`).
  - `AppControlStatus` reports `platform`, `supported`, the active session, and per-provider availability.

### IPC (apps/desktop/src/shared/ipc.ts)

Channels live under `ade.appControl.*`:

- `ade.appControl.getStatus`
- `ade.appControl.launch` / `ade.appControl.launchInTerminal`
- `ade.appControl.connect`
- `ade.appControl.stop`
- `ade.appControl.screenshot`
- `ade.appControl.getSnapshot`
- `ade.appControl.inspectPoint` / `ade.appControl.selectPoint`
- `ade.appControl.click` / `ade.appControl.typeText` / `ade.appControl.scroll` / `ade.appControl.dispatchKey`
- `ade.appControl.listTargets` / `ade.appControl.attachToTarget`
- `ade.appControl.event` (push channel; carries `AppControlEventPayload`, including screencast frames)

`registerIpc.ts` rate-limits launch/snapshot/click/type calls and validates argument shapes via `appControlRecord`. Heavy operations (`launch`, `getSnapshot`, `inspectPoint`, `selectPoint`, `screenshot`, `connect`, `stop`, `click`, `typeText`) bypass the global 30 s IPC timeout — CDP screenshot/screencast operations can legitimately exceed it.

The companion **chat terminal** surface lives at `ade.terminal.*` and shares the same backend as PTY:

- `ade.terminal.list` — list chat-attached terminals (filterable by `chatSessionId` / `laneId`).
- `ade.terminal.read` — read scrollback by `terminalId` *or* by `chatSessionId` (resolves to the chat's active terminal).
- `ade.terminal.write` / `ade.terminal.signal` — send input or `SIGINT` / `SIGTERM` / `SIGKILL`.
- `ade.terminal.activeForChat` — fetch the currently active terminal for a chat.

### Preload bridge

- `apps/desktop/src/preload/preload.ts` exposes `window.ade.appControl` (matching the IPC list above plus an `onEvent` subscription) and `window.ade.terminal` (`list`, `read`, `write`, `signal`, `activeForChat`).
- `apps/desktop/src/preload/global.d.ts` carries the renderer-facing typings.

### Renderer

- `apps/desktop/src/renderer/components/chat/ChatAppControlPanel.tsx` — the App Control panel. Two mount points:
  - Under `AgentChatPane`'s in-chat drawer (chat-scoped, `sessionId` set, persisted under `sessionStorage["ade.chat.appControlPanel.chat:<sessionId>"]`).
  - Inside the Work right-edge sidebar's `app-control` tab (`apps/desktop/src/renderer/components/terminals/WorkSidebar.tsx`, lane-scoped, `sessionId={null}` + `laneId` set, persisted under `sessionStorage["ade.chat.appControlPanel.lane:<laneId>:<projectRoot>"]`).

  Two modes:
  - **Control** — shows live screencast frames, Run-tab style launch/connect controls, click/type input, and quick actions for `terminal write` (answer a prompt) and `terminal signal` (interrupt).
  - **Inspect** — overlays a hit-test crosshair on the screenshot. Hovering inspects an element via `inspectPoint`; clicking commits via `selectPoint`, producing an `AppControlContextItem` that the chat composer attaches as a context chip plus an attachment.

  Connect / launch calls forward the resolved `laneId` so the resulting `AppControlSession` records its launching lane.
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` mounts the chat-scoped panel, owns `appControlContextItems`, and renders App Control chips alongside file attachments. The pane polls `ade.appControl.getStatus` to gate the header toggle on platform support. When mounted as a Work tile (`hideLaneToolDrawers={true}`) the in-chat App Control drawer toggle is suppressed because the Work sidebar owns that drawer at lane scope; selections from the sidebar still flow into the chat composer through the `ade:agent-chat:add-app-control-context` window event.
- `apps/desktop/src/renderer/components/terminals/WorkSidebar.tsx` mounts the lane-scoped panel under the `app-control` tab and runs its own `AppControlSession` subscription. When the active session's `laneId` differs from the sidebar's active lane it shows a `WarningBanner` ("App Control is attached to a different lane…"); the user can still control the existing session, but selections will not attach to the active lane's chat until the tool session is relaunched against the matching lane.
- `apps/desktop/src/renderer/components/chat/ChatTerminalDrawer.tsx` reads `AppControlSession` to decorate the App Control launch terminal tab with a status tone (`active` / `warn` / `error`).

### ADE CLI

`apps/ade-cli/src/cli.ts` registers two new top-level command groups:

- `ade app-control <sub>`:
  - `status`, `actions` (list every callable `app_control` action)
  - `launch`, `connect`, `stop`
  - `screenshot`, `snapshot`, `inspect`, `select`
  - `click`, `type`, `scroll`, `key`
  - `targets`, `attach`
  - `logs`, `terminal write`, `terminal signal` — operate on the active App Control launch terminal
- `ade terminal <sub>`: `list`, `active`, `read`, `write`, `signal` — control the in-chat terminal owned by a chat session.

`apps/ade-cli/src/bootstrap.ts` constructs an `AppControlService` for headless mode using the same `resolveLaneId` strategy as the desktop main process.

The agent guidance string in `apps/desktop/src/shared/adeCliGuidance.ts` (`ADE_CLI_AGENT_GUIDANCE` + `ADE_CLI_INLINE_GUIDANCE`) tells agents to prefer desktop socket mode, how to launch by reusing a Run-tab process command + cwd, and how to read scrollback via `app-control logs` or fall back to `terminal read --chat-session "$ADE_CHAT_SESSION_ID"`.

### Action registry

`apps/desktop/src/main/services/adeActions/registry.ts` adds two domains:

- `app_control` — every public method on `AppControlService` (`getStatus`, `launch`, `launchInTerminal`, `connect`, `stop`, `screenshot`, `getSnapshot`, `inspectPoint`, `selectPoint`, `click`, `typeText`, `readTerminal`, `writeTerminal`, `signalTerminal`).
- `terminal` — `list`, `read`, `write`, `signal`, `activeForChat` against `ptyService` so headless agents can control chat-owned terminals.

## Launch and connect flow

`launch(args)` is the primary entry point.

1. **Argument resolution.** `appKind` defaults to `"electron"`. `cwd` is normalized against the resolved `projectRoot` and rejected if it escapes the lane worktree (`ensureCwdInsideRoot`). `cdpPort` is allocated via `findFreePort()` when not supplied. `ADE_APP_CONTROL_CDP_PORT` and `ADE_APP_CONTROL_DEBUG_FLAGS` are computed and either:
   - substituted into a literal `{ADE_APP_CONTROL_DEBUG_FLAGS}` placeholder in the command, or
   - injected when the command looks like a package script (`npm`/`pnpm`/`yarn`/`bun run dev`) by rewriting it to `--inspect`/`--remote-debugging-port` flags, or
   - appended directly when the command looks like a `npx electron`/`electron` invocation, or
   - exported via the spawned shell's environment for any other custom launcher (custom launchers are expected to forward one of those env vars to `--remote-debugging-port`).
2. **Visible chat terminal.** Instead of spawning a hidden child process, the service runs the resolved command through the chat-owned PTY (`ptyService.create(...)` with `chatSessionId`). The user sees the stdout/stderr in the chat terminal drawer, and the App Control session records the resulting `terminalSessionId` + `terminalPtyId`.
3. **CDP discovery.** `listCdpTargets(port)` polls `http://127.0.0.1:<port>/json` every 500 ms. A health-check timer keeps polling at 2 s once a target is selected. `pickCdpTarget` prefers `page` > `webview` > anything with a non-`devtools://` URL.
4. **Attach.** `CdpClient.connect(webSocketDebuggerUrl)` opens the long-lived WebSocket. The session transitions `starting` → `running` → `connected` and `cdpEndpoint` / `cdpTargetId` are filled in. `Page.startScreencast` is enabled lazily so the renderer panel can paint frames.
5. **Health.** If the WebSocket drops, the session moves back to `running` (terminal still alive) or `failed` (terminal exited). `lastError` carries the last CDP failure for the renderer to display.

`connect(args)` is the same flow without the launch step — useful when an agent already has an Electron app running with `--remote-debugging-port=<port>`.

`stop({ force })` closes the CDP socket, signals the launch terminal (`SIGINT` then `SIGKILL` on `force`), drops cached frames, and emits `session-stopped`. `dispose()` is the shutdown path.

## Snapshot and source matching

`getSnapshot()` runs in two parts inside the renderer process:

1. **DOM collector** (`cdpDomSnapshotScript`) walks the document, ranks elements by interactivity, captures `tagName`, ARIA `role`, computed `label`, value, a stable `selector` (id → testid → tag.class), `data-testid` / `data-test` / `data-qa`, geometry (logical + pixel `frame`), and a small `metadata` bag (text, ARIA bits, common React-DevTools markers like `data-component`, `data-source-file`, `data-source-line`). Up to `MAX_DOM_ELEMENTS = 450` entries are returned, and a separate hit-test resolves the element under `(x, y)` via `cdpPointSnapshotScript`.
2. **Source matching** runs in the main process. `collectSourceFiles(projectRoot)` indexes a capped list of `.ts`/`.tsx`/`.js`/`.jsx`/`.html`/`.css` files (skipping `.git`, `.ade`, `node_modules`, `dist`, etc.) and `findSourceMatches` searches for the element's `data-component`, `data-testid`, `id`, label text, or selector tokens. Matches are returned as `AppControlSourceMatch[]` with `confidence: "exact" | "candidate"` and a small snippet.

`inspectPoint({ x, y })` returns an `AppControlInspectResult` with the hit element, all surrounding elements (via `nearbyElements`), and the source candidates — without committing anything to chat. `selectPoint()` is the same call but produces a final `AppControlContextItem` (with `provider`, `componentId`, `sourceFile`, `sourceLine`, `metadata`, `screenshotDataUrl`, `selectedAt`) ready to attach to the active chat composer. Both calls fall back to a `coordinate-fallback` provider when the DOM hit-test misses (e.g. inside an `<iframe>` ADE cannot reach).

## Input

- `click({ x, y, scale })` runs `dispatchDomClick` first (a synthetic `MouseEvent` walk inside the page) and falls back to CDP `Input.dispatchMouseEvent` when DOM dispatch reports `ok: false`. This keeps modern React click handlers happy without losing the ability to drive native `<select>` dropdowns and Electron menubar items.
- `typeText({ text })` calls `Input.insertText`. `dispatchKey({ type, key, code, text, modifiers })` is the lower-level escape hatch for shortcuts and special keys.
- `scroll({ x, y, deltaX, deltaY })` is `Input.dispatchMouseEvent` with `type: "mouseWheel"`.
- All input calls go through a single shared `CdpClient` (`withCdp`) so the WebSocket isn't reopened per click; this measurably reduces input latency.

## Chat-owned terminal model

The App Control launch terminal is a regular ADE chat terminal — it inserts a `terminal_sessions` row and routes through `ptyService`. To make these terminals first-class for chat agents, the branch widens the schema and PTY service:

- `terminal_sessions` gains a `chat_session_id` column (nullable, indexed). Set when a PTY is created with `chatSessionId` in `PtyCreateArgs`.
- `ptyService` keeps two in-memory maps: `terminalChatSessions` (terminalId → chatSessionId) and `activeTerminalByChatSession`. Disposing a chat terminal automatically promotes the most recently created sibling so `terminal.read --chat-session <id>` always resolves a sensible target.
- New service methods (also exposed as ADE actions): `listTerminals`, `readTerminal`, `writeTerminal`, `signalTerminal`, `activeForChat`. They accept either an explicit `terminalId`/`ptyId` or a `chatSessionId` (which resolves to the chat's active terminal).

`agentChatService` populates `ADE_CHAT_SESSION_ID`, `ADE_LANE_ID`, `ADE_PROJECT_ROOT`, and `ADE_WORKSPACE_ROOT` in the agent runtime environment (`buildAgentRuntimeEnv`), so an in-chat Claude/Codex agent can call `ade --socket app-control logs` or `ade --socket terminal read --chat-session "$ADE_CHAT_SESSION_ID" --text` without resolving the chat ID itself.

## Provider model

`AppControlStatus.providers` reports availability per `AppControlProvider`:

- `cdp` — Chrome DevTools Protocol against an Electron renderer. Fully supported; this is what `launch` / `connect` drive.
- `os-accessibility` — placeholder for future macOS AX-based control of non-Electron apps. Currently `available: false`.
- `computer-use` — placeholder for delegating to Claude `computer_use` / Ghost OS-style backends.
- `external` — when an external automation tool (Playwright, agent-browser) holds the connection.

Only one App Control session is active per project at a time. Re-launching/connecting with `force: true` cleans up the previous session first.

## Cross-links

- [`README.md`](./README.md) — the proof-artifact broker; App Control sits next to it but does not write to `computer_use_artifacts`.
- [`../chat/composer-and-ui.md`](../chat/composer-and-ui.md) — composer chip rendering for `AppControlContextItem`s.
- [`../terminals-and-sessions/README.md`](../terminals-and-sessions/README.md) — `chat_session_id` column and the new `ade.terminal.*` IPC surface.
- [`../agents/tool-registration.md`](../agents/tool-registration.md) — how `ADE_CHAT_SESSION_ID` reaches the agent runtime and how `app_control` / `terminal` ADE CLI domains are exposed.
