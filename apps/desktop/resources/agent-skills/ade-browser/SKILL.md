---
name: ade-browser
description: Use this skill when using ADE's built-in browser pane, shared browser tabs, screenshots, page inspection, or browser context selection through `ade browser`.
---

# ADE browser

## Scope

The ADE browser is global, not lane-scoped. Use socket mode so CLI calls and the Work sidebar share the same tabs.
The Work tools attribution is claim-based: `ade browser open`, `panel`, `new-tab`, and `switch` carry `ADE_LANE_ID` / `ADE_CHAT_SESSION_ID` automatically when ADE launched the agent. If you attach to an already-open tab, run `ade --socket browser claim --lane <lane-id> --text` first so the sidebar shows the right owner lane.

## How `ade browser` reaches the desktop

The CLI does not own the browser pane. `BuiltInBrowserService` lives in Electron main because it owns a `WebContentsView`, so the runtime daemon (`ade serve`, which runs under `ELECTRON_RUN_AS_NODE=1` with no Electron APIs) can't host it directly.

Calls travel: CLI → runtime daemon (`~/.ade/sock/ade.sock`) → desktop bridge socket (`<adeHome>/sock/desktop-bridge.sock`) → real `BuiltInBrowserService` in Electron main → response back. The runtime registers a lazy JSON-RPC proxy whose allowlisted methods (`getStatus`, `showPanel`, `setBounds`, `navigate`, `createTab`, `switchTab`, `closeTab`, `reload`, `goBack`, `goForward`, `stop`, `startInspect`, `stopInspect`, `captureScreenshot`, `selectPoint`, `selectCurrent`, `clearSelection`, `claim`) forward over the bridge.

Requirement: ADE Desktop must be running with a project open. Without it, calls fail with `Desktop browser bridge not running at <path>. Open ADE Desktop with a project to enable \`ade browser\` commands.` — that's the headless case, not a bug. Other runtime domains keep working.

Override the bridge socket path with `ADE_DESKTOP_BRIDGE_SOCKET_PATH` for dev launches.

## Common commands

```bash
ade help browser
ade --socket browser panel --text
ade --socket browser claim --lane <lane-id> --text
ade --socket browser status --text
ade --socket browser open <url> --new-tab --text
ade --socket browser tabs --text
ade --socket browser switch --tab <id> --text
ade --socket browser screenshot --text
```

For inspection and chat context:

```bash
ade --socket browser inspect-start --text
ade --socket browser select-current --text
ade --socket browser clear-selection --text
```

## Gotchas

- Open localhost URLs and chat-output links in the ADE browser when the user expects them to show in the Work sidebar.
- Because tabs are global, confirm the active tab before taking a screenshot or selecting context.
- If there is no active browser panel/session, report the blocker rather than pretending to inspect the page.
