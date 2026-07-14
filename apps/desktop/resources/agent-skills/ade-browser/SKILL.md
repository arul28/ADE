---
name: ade-browser
description: Use this skill when using ADE's built-in browser pane, shared browser tabs, screenshots, page inspection, or browser context selection through `ade browser`.
---

# ADE browser

## Scope

The ADE browser uses one persistent, machine-global authentication profile per ADE installation/channel. Cookies, cache, local storage, IndexedDB, service workers, and normal authenticated session state are shared across ADE projects. Visible tabs are not global: each ADE window/project keeps an independent tab collection, and personal chat keeps a separate personal collection. Use socket mode so CLI calls route to the correct project collection; the bridge carries the runtime project root for tab routing, never for storage partitioning.
If a task needs any browser behavior — opening a URL, checking localhost, clicking, filling a form, logging in, screenshotting, inspecting DOM, or verifying a page — use `ade --socket browser ...` before trying an external browser/tool.
Within a project, attribution is per tab and per chat agent. `ade browser open`, `new-tab`, `claim`, browser sessions, and agent page actions carry `ADE_LANE_ID` / `ADE_CHAT_SESSION_ID` automatically when ADE launched the agent, and each `BuiltInBrowserTab` reports `ownerLaneId`, `ownerChatSessionId`, `ownerClaimedAt`, and `ownerLeaseExpiresAt`. `ade browser panel` and plain `ade browser switch` are passive view operations, so they must not claim or block the Browser view just because another lane owns the active tab. If you attach to an already-open tab, run `ade --socket browser claim --tab <tab-id> --lane <lane-id> --text` first so the tab strip shows the right owner lane.

## How `ade browser` reaches the desktop

The CLI does not own the browser pane. `BuiltInBrowserService` lives in Electron main because it owns a `WebContentsView`, so the runtime daemon (`ade serve`, which runs under `ELECTRON_RUN_AS_NODE=1` with no Electron APIs) can't host it directly.

Calls travel: CLI → runtime daemon (`~/.ade/sock/ade.sock`) → desktop bridge socket (`<adeHome>/sock/desktop-bridge.sock`) → real `BuiltInBrowserService` in Electron main → response back. ADE gives each launched chat an opaque, in-memory browser actor capability bound to that chat's lane and tab collection. The runtime strips caller-supplied routing and carries the capability over its independently authenticated bridge; Electron validates it in the same process that issued it, restores only the bound ownership/scope, and forces `force: false`. An unbound shell, a copied project, or a caller claiming CTO role cannot use the global browser profile. Global profile diagnostics and permission administration remain trusted-renderer-only and are never forwarded over the agent bridge.

Requirement: ADE Desktop must be running with a project open. Without it, calls fail with `Desktop browser bridge not running at <path>. Open ADE Desktop with a project to enable \`ade browser\` commands.` — that's the headless case, not a bug. Other runtime domains keep working.

Override the bridge socket path with `ADE_DESKTOP_BRIDGE_SOCKET_PATH` for dev launches.

## Common commands

```bash
ade help browser
ade --socket browser panel --text
ade --socket browser status --text
ade --socket browser tabs --text
ade --socket browser authorize --tab <id> --text
ade --socket browser open <url> --text
ade --socket browser open <url> --panel --text
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

- Default agent workflow for browser tasks: run `ade --socket browser tabs --text`; reuse a tab/session already owned by your current `ADE_CHAT_SESSION_ID`. Plain `ade --socket browser open <url> --text` reuses your owned tab and only creates one when none exists, without revealing the Browser panel; use `--panel` only when the user should see it and `--new-tab` only when the task truly needs another tab. Then run `ade --socket browser session start --tab <tab-id> --text` and use `--browser-session <session-id>` for repeated actions.
- Open localhost URLs and chat-output links in the ADE browser when the user expects them to show in the Work sidebar.
- Project-scoped CLI bridge calls require the target project to have an ADE window or project tab open. ADE-launched personal chats retain their validated `tabCollection: "personal"` scope instead of falling back to the source window's project tabs.
- Agent-facing tab actions run in the background when possible. Passing `--tab <id>` or `--browser-session <id>` targets hidden/non-active tabs directly; when ADE launched the agent and no tab is passed, browser actions prefer the tab owned by the current `ADE_CHAT_SESSION_ID` before falling back to the active visible tab. Inspect mode is still a visible-tab interaction.
- For repeated agent work, start a browser session with `ade --socket browser session start --tab <id> --text`, then use either `--browser-session <session-id>` on observe/click/fill/clear-field/press/wait/trace/proof/screenshot/reload/back/forward/stop/select or the shorthand `ade --socket browser session <action> <session-id> ...`. The session is a lightweight pointer to one tab plus owner/last observation/last trace metadata; it ends explicitly with `browser session end <id>` or automatically when the tab closes.
- Browser click/select/scroll coordinates are viewport coordinates. Prefer `click --selector`, `click --text-match`, `click --test-id`, `click --element <n>`, or `click --handle <ref>` from the current DOM list when available; ADE scrolls located elements into view before dispatching the click.
- Use `wait`, `fill`, `clear-field`, and `press` for Playwright-like agent actions. These commands focus located elements and reject disabled targets; `wait` can target selectors/text/test ids, URL substrings, or load state. `wait --network-idle` waits for `document.readyState === "complete"`, no pending browser requests, and a quiet window controlled by `--network-idle-ms` (default 500).
- Prefer `observe --map --text` before precise work. The text output gives numbered elements plus `handle` values; use `--handle` for the next click/fill/press/wait so ADE does not have to infer from brittle coordinates.
- Lane/chat-owned browser tabs are leased. ADE injects the launched agent's browser actor capability plus `ADE_LANE_ID` and `ADE_CHAT_SESSION_ID` into status, session, observation, screenshot, trace, navigation-control, selection, and page-action calls. A bound agent cannot impersonate another owner or use `--force`; recovery takeovers and global administration stay on trusted human renderer paths. Passive panel reveal stays usable without claiming the active tab.
- A global authenticated profile is a security boundary. Every non-local origin, and any local origin with an allowed privileged permission, requires a native human grant per chat/lane before an agent can inspect or control it. Use `browser authorize` when a synchronous status/session command asks for approval; navigation commands request the same approval directly. Grants are memory-only and disappear on ADE restart. Agent-triggered cross-origin navigation and redirects are stopped at the boundary; approved normal navigations may continue, while approved redirects require retrying the initiating action so ADE never blindly replays a redirected request. Sensitive popups are blocked until the agent navigates there explicitly and the human approves.
- Browser tab URLs and the active index restore from a bounded machine-local store. Agent leases, lightweight browser sessions, and session-cookie values are never synthesized or restored by that store, so a restarted agent must claim a tab again and sites retain control over logout/expiry semantics.
- ADE migrates unexpired persistent cookies once from this release channel's old project-derived browser profiles. Global-profile cookies win conflicts and session cookies are intentionally not copied. The old profile directories remain on disk because Chromium local storage, IndexedDB, service workers, and WebAuthn credentials cannot be merged safely across partitions.
- Site permissions are deny-by-default and scoped to the requesting origin, embedding origin, and device type where relevant. Native prompts default to Block. Global profile cookie-domain diagnostics and remembered-permission administration are trusted-renderer-only; agent and unbound CLI calls are rejected.
- Humans can open the Browser toolbar's **Profile** panel to inspect non-secret global cookie/cache/flush health and remove one or all remembered permission decisions. This renderer path is intentionally unavailable through `ade browser` automation.
- HTTP/proxy authentication and client-certificate selection always happen in separate human-only ADE prompts. Agents cannot fill those prompts through `ade browser`; after a human authenticates, the site is treated as a sensitive origin under the same per-chat approval boundary.
- `observe` and post-action observations save a screenshot plus a bounded DOM element list, console diagnostics, failed-network diagnostics, and pending request count by default. Add `--map` to write a numbered visual element map image, then use the listed `handle` values with `click`/`fill`/`clear-field`/`press`/`wait`. Handles can replay into same-origin iframes and open shadow roots when the saved element included frame/shadow context. Use `--fast` on actions when the page does not need the default settle delay.
- Use `ade --socket browser trace --tab <id> --text` when an action gets stuck. The trace is a bounded per-tab action log with before/after URL, target metadata, observation id, duration, and errors. Fill/type traces record text length rather than typed text.
- Project browser observations are scratch files under `.ade/cache/browser-observations/`; personal-tab observations use the current ADE channel's machine-local `browser-observations/personal/` scratch root. Both prune aggressively to the latest 3 observations per tab by default. Use `--no-dom` for image-only scratch captures and proof commands only for reviewer-facing evidence.
- Use `ade --socket browser proof --tab <id> --caption "..."` or `ade --socket browser proof --browser-session <id> --caption "..."` to promote a fresh browser observation into the durable proof drawer.
- Signed packaged macOS builds embed ADE's Developer ID provisioning profile and enable Electron's Touch ID WebAuthn authenticator with the matching keychain access-group entitlement; source builds require `ADE_ENABLE_TOUCH_ID_WEBAUTHN=1` for explicit testing, and `ADE_ENABLE_TOUCH_ID_WEBAUTHN=0` disables it. These credentials are device-bound to the Mac's Secure Enclave and the global Electron browser session; they are not iCloud-synced passkeys. ADE does not claim Apple Passwords extension support.
- If there is no active browser panel/session, report the blocker rather than pretending to inspect the page.
