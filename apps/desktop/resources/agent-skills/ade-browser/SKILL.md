---
name: ade-browser
description: Use this skill when using ADE's built-in browser pane, shared browser tabs, screenshots, page inspection, or browser context selection through `ade browser`.
---

# ADE browser

## Scope

The ADE browser is project-profile scoped, not lane-scoped. Desktop renderer calls use the active project root to choose a persistent browser profile, so cookies, local storage, cache, and WebAuthn session metadata are shared across ADE browser tabs for that project and isolated from other projects. Use socket mode so CLI calls and the Work sidebar share live browser state for the same project; bridge calls carry the runtime project root and must not fall back to another active project.
If a task needs any browser behavior — opening a URL, checking localhost, clicking, filling a form, logging in, screenshotting, inspecting DOM, or verifying a page — use `ade --socket browser ...` before trying an external browser/tool.
Within a project, attribution is per tab and per chat agent. `ade browser open`, `new-tab`, `claim`, browser sessions, and agent page actions carry `ADE_LANE_ID` / `ADE_CHAT_SESSION_ID` automatically when ADE launched the agent, and each `BuiltInBrowserTab` reports `ownerLaneId`, `ownerChatSessionId`, `ownerClaimedAt`, and `ownerLeaseExpiresAt`. `ade browser panel` and plain `ade browser switch` are passive view operations, so they must not claim or block the Browser view just because another lane owns the active tab. If you attach to an already-open tab, run `ade --socket browser claim --tab <tab-id> --lane <lane-id> --text` first so the tab strip shows the right owner lane.

## How `ade browser` reaches the desktop

The CLI does not own the browser pane. `BuiltInBrowserService` lives in Electron main because it owns a `WebContentsView`, so the runtime daemon (`ade serve`, which runs under `ELECTRON_RUN_AS_NODE=1` with no Electron APIs) can't host it directly.

Calls travel: CLI → runtime daemon (`~/.ade/sock/ade.sock`) → desktop bridge socket (`<adeHome>/sock/desktop-bridge.sock`) → real `BuiltInBrowserService` in Electron main → response back. The runtime registers a lazy JSON-RPC proxy whose allowlisted methods (`getStatus`, `showPanel`, `setBounds`, `navigate`, `createTab`, `switchTab`, `closeTab`, `reload`, `goBack`, `goForward`, `stop`, `startSession`, `listSessions`, `endSession`, `observe`, `getTrace`, `click`, `typeText`, `dispatchKey`, `scroll`, `fill`, `clear`, `wait`, `startInspect`, `stopInspect`, `captureScreenshot`, `selectPoint`, `selectCurrent`, `clearSelection`, `claim`) forward over the bridge.

Requirement: ADE Desktop must be running with a project open. Without it, calls fail with `Desktop browser bridge not running at <path>. Open ADE Desktop with a project to enable \`ade browser\` commands.` — that's the headless case, not a bug. Other runtime domains keep working.

Override the bridge socket path with `ADE_DESKTOP_BRIDGE_SOCKET_PATH` for dev launches.

## Common commands

```bash
ade help browser
ade --socket browser panel --text
ade --socket browser status --text
ade --socket browser tabs --text
ade --socket browser open <url> --new-tab --text
ade --socket browser session start --tab <id> --text
ade --socket browser sessions --text
ade --socket browser observe --browser-session <session-id> --map --text
ade --socket browser click --browser-session <session-id> --handle obs-...:e:1 --fast --text
ade --socket browser session click <session-id> --handle obs-...:e:1 --fast --text
ade --socket browser session wait <session-id> --network-idle --text
ade --socket browser session trace <session-id> --text
ade --socket browser session proof <session-id> --caption "Verified" --text
ade --socket browser session end <session-id> --text
ade --socket browser observe --tab <id> --text
ade --socket browser observe --tab <id> --map --text
ade --socket browser trace --tab <id> --text
ade --socket browser click --tab <id> --x 120 --y 420 --text
ade --socket browser click --tab <id> --selector "button[type=submit]" --text
ade --socket browser click --tab <id> --text-match "Sign in" --text
ade --socket browser click --tab <id> --handle obs-...:e:1 --fast --text
ade --socket browser wait --tab <id> --selector ".ready" --text
ade --socket browser wait --tab <id> --load-state network-idle --network-idle-ms 750 --text
ade --socket browser fill --tab <id> --selector "input[name=email]" "me@example.com" --text
ade --socket browser fill --tab <id> --handle obs-...:e:2 --value "" --text
ade --socket browser clear-field --tab <id> --selector "input[name=q]" --text
ade --socket browser press --tab <id> --selector "input[name=q]" Enter --text
ade --socket browser proof --tab <id> --caption "Verified" --text
ade --socket browser type --tab <id> "hello" --text
ade --socket browser key --tab <id> Enter --text
ade --socket browser scroll --tab <id> --dy 700 --text
ade --socket browser screenshot --tab <id> --text
ade --socket browser reload --tab <id> --text
```

For inspection and chat context:

```bash
ade --socket browser inspect-start --text
ade --socket browser select --tab <id> --x 120 --y 420 --text
ade --socket browser select-current --text
ade --socket browser clear-selection --text
```

## Gotchas

- Default agent workflow for browser tasks: run `ade --socket browser tabs --text`; reuse only a tab/session already owned by your current `ADE_CHAT_SESSION_ID`; otherwise open a fresh owned tab with `ade --socket browser open <url> --new-tab --text`, then `ade --socket browser session start --tab <tab-id> --text` and use `--browser-session <session-id>` for repeated actions.
- Open localhost URLs and chat-output links in the ADE browser when the user expects them to show in the Work sidebar.
- Because CLI bridge calls are project-scoped, confirm the target project has an ADE window or project tab open before taking a screenshot or selecting context.
- Agent-facing tab actions can target hidden or non-active tabs by passing `--tab <id>` to observe/click/type/key/scroll/screenshot/select/reload/back/forward/stop. Inspect mode is still a visible-tab interaction.
- For repeated agent work, start a browser session with `ade --socket browser session start --tab <id> --text`, then use either `--browser-session <session-id>` on observe/click/fill/clear-field/press/wait/trace/proof/screenshot/reload/back/forward/stop/select or the shorthand `ade --socket browser session <action> <session-id> ...`. The session is a lightweight pointer to one tab plus owner/last observation/last trace metadata; it ends explicitly with `browser session end <id>` or automatically when the tab closes.
- Browser click/select/scroll coordinates are viewport coordinates. Prefer `click --selector`, `click --text-match`, `click --test-id`, `click --element <n>`, or `click --handle <ref>` from the current DOM list when available; ADE scrolls located elements into view before dispatching the click.
- Use `wait`, `fill`, `clear-field`, and `press` for Playwright-like agent actions. These commands focus located elements and reject disabled targets; `wait` can target selectors/text/test ids, URL substrings, or load state. `wait --network-idle` waits for `document.readyState === "complete"`, no pending browser requests, and a quiet window controlled by `--network-idle-ms` (default 500).
- Prefer `observe --map --text` before precise work. The text output gives numbered elements plus `handle` values; use `--handle` for the next click/fill/press/wait so ADE does not have to infer from brittle coordinates.
- Lane/chat-owned browser tabs are leased. ADE-launched agents pass `ADE_LANE_ID` and `ADE_CHAT_SESSION_ID` automatically for tab creation, explicit claims, sessions, and page actions; another lane or another chat in the same lane must use `--force` to take over a still-leased tab. Passive panel reveal and plain tab switching are view operations and should stay usable across lanes. Manual calls without a lane remain allowed for local recovery.
- `observe` and post-action observations save a screenshot plus a bounded DOM element list, console diagnostics, failed-network diagnostics, and pending request count by default. Add `--map` to write a numbered visual element map image, then use the listed `handle` values with `click`/`fill`/`clear-field`/`press`/`wait`. Handles can replay into same-origin iframes and open shadow roots when the saved element included frame/shadow context. Use `--fast` on actions when the page does not need the default settle delay.
- Use `ade --socket browser trace --tab <id> --text` when an action gets stuck. The trace is a bounded per-tab action log with before/after URL, target metadata, observation id, duration, and errors. Fill/type traces record text length rather than typed text.
- Browser observations are scratch files under `.ade/cache/browser-observations/` and prune aggressively to the latest 3 observations per tab by default. Use `--no-dom` for image-only scratch captures and proof commands only for reviewer-facing evidence.
- Use `ade --socket browser proof --tab <id> --caption "..."` or `ade --socket browser proof --browser-session <id> --caption "..."` to promote a fresh browser observation into the durable proof drawer.
- macOS packaged builds configure Touch ID WebAuthn for ADE browser passkeys; unsigned/dev builds can opt in with `ADE_ENABLE_TOUCH_ID_WEBAUTHN=1`.
- If there is no active browser panel/session, report the blocker rather than pretending to inspect the page.
