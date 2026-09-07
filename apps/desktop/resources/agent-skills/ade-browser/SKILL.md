---
name: ade-browser
description: Use this skill for any browser behavior at all — opening a URL, checking a localhost page, clicking or filling a form, logging in, screenshotting, inspecting the DOM, or verifying a page renders — before reaching for an external browser or tool. ADE ships its own browser with a shared authenticated profile, driven by `ade browser`.
---

# ADE browser

## Scope

The ADE browser uses one persistent, machine-global authentication profile per ADE installation/channel. Cookies, cache, local storage, IndexedDB, service workers, and normal authenticated session state are shared across ADE projects. Visible tabs are not global: each ADE window/project keeps an independent tab collection, and personal chat keeps a separate personal collection. Use socket mode so CLI calls route to the correct project collection; the bridge carries the runtime project root for tab routing, never for storage partitioning.
If a task needs any browser behavior — opening a URL, checking localhost, clicking, filling a form, logging in, screenshotting, inspecting DOM, or verifying a page — use `ade --socket browser ...` before trying an external browser/tool.
Within a project, attribution is per tab and per chat agent: `ade browser open`, `new-tab`, `claim`, browser sessions, and agent page actions all carry lane/session ownership (see "Owning a drawer surface" in the **ade-cli-control-plane** skill), and each `BuiltInBrowserTab` reports `ownerLaneId`, `ownerChatSessionId`, `ownerClaimedAt`, and `ownerLeaseExpiresAt`. The browser-specific claim form is `ade --socket browser claim --tab <tab-id> --lane <lane-id> --text`. `ade browser panel` and plain `ade browser switch` are passive view operations, so they must not claim or block the Browser view just because another lane owns the active tab.

## How `ade browser` reaches the desktop

The CLI does not own the browser pane. `BuiltInBrowserService` lives in Electron main because it owns a `WebContentsView`, so the runtime daemon (`ade serve`, which runs under `ELECTRON_RUN_AS_NODE=1` with no Electron APIs) can't host it directly.

Calls travel: CLI → runtime daemon (`~/.ade/sock/ade.sock`) → desktop bridge socket (`<adeHome>/sock/desktop-bridge.sock`) → real `BuiltInBrowserService` in Electron main → response back. ADE gives each launched chat an opaque browser actor capability bound to that chat's lane and tab collection. Electron mints it, because Electron is the only process that can validate it: the capability registry is in-memory in Electron main, so when the daemon builds an agent's environment it asks the desktop for the token over the same bridge (`built_in_browser.issueActorCapability`, revoked through `built_in_browser.revokeActorCapability` when the chat ends). With no desktop running the daemon omits the token entirely. The runtime strips caller-supplied routing and carries the capability over its independently authenticated bridge; Electron validates it against the registry that issued it, restores only the bound ownership/scope, and forces `force: false`. An unbound shell, a copied project, or a caller claiming CTO role cannot use the global browser profile. Global profile diagnostics and permission administration remain trusted-renderer-only and are never forwarded over the agent bridge.

Requirement: ADE Desktop must be running with a project open. Without it, calls fail with `No ADE Desktop browser is attached to this machine (bridge socket <path> is not listening)…` — that's the headless case, not a bug. Other runtime domains keep working.

## Headless machines: `open` forwards, everything else does not

`ade browser open <url>` (and `new-tab` / `panel`) is the one exception on a machine with no desktop attached — a box running only `ade serve`. Instead of failing, the daemon publishes the URL to any ADE Desktop that has this lane pinned and answers:

```json
{ "status": "forwarded_to_desktop", "requestId": "bbr-…", "acknowledged": true, "desktopLabel": "This computer" }
```

`--text` renders that as `opened: on <desktop> via tunnel`, or `no desktop is attached to this machine; open ADE Desktop with this lane pinned` when nobody answered inside 5 seconds. The desktop reaches this machine's `localhost` through a TCP port-forward, so `ade browser open http://localhost:5173` shows the human YOUR dev server, labelled with this machine's name — you do not need to make anything publicly reachable.

Two consequences to plan around:

- The first time you name a port the human has not approved on this machine, an approval bar appears in their browser pane ("Agent wants to reach port 5173 on <machine>"). Until they answer, nothing loads; a denial comes back as `acknowledged: false` with a reason. Ask for the ports you actually need, once.
- `observe`, `click`, `fill`, `screenshot`, `wait`, and every other page action still fail on a headless machine: they act on a live tab in a browser that is not here. Use them from a chat whose desktop is attached. Do not retry them in a loop after `forwarded_to_desktop`.

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
ade --socket browser hover --tab <id> --selector ".menu" --text
ade --socket browser drag --tab <id> --handle obs-...:e:1 --to-selector ".dropzone" --text
ade --socket browser select-option --tab <id> --selector "select#plan" --value pro --text
ade --socket browser upload --tab <id> --selector "input[type=file]" --file ./shot.png --text
```

Viewport, page search, DevTools, network and recording:

```bash
ade --socket browser emulate --tab <id> --device iphone-17-pro --text
ade --socket browser emulate --tab <id> --width 1024 --height 768 --scale 2 --mobile --text
ade --socket browser emulate --tab <id> --off --text
ade --socket browser open localhost:5173 --device ipad --text
ade --socket browser zoom --tab <id> --factor 1.25 --text
ade --socket browser zoom --tab <id> --reset --text
ade --socket browser find --tab <id> "checkout" --text
ade --socket browser find-stop --tab <id> --text
ade --socket browser devtools --tab <id> --mode bottom --text
ade --socket browser devtools --tab <id> --close --text
ade --socket browser network on --tab <id> --text
ade --socket browser network --tab <id> --failed --limit 20 --text
ade --socket browser network off --tab <id> --text
ade --socket browser har --tab <id> --text
ade --socket browser record start --tab <id> --fps 60 --caption "Checkout flow" --text
ade --socket browser record stop --tab <id> --text
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
- Lane/chat-owned browser tabs are leased. ADE injects the launched agent's browser actor capability plus `ADE_LANE_ID` and `ADE_CHAT_SESSION_ID` into status, session, observation, screenshot, trace, navigation-control, selection, and page-action calls. A bound agent cannot impersonate another owner or use `--force`; recovery takeovers and global administration stay on trusted human renderer paths. Passive panel reveal stays usable without claiming the active tab.
- A global authenticated profile is a security boundary. Every non-local origin, and any local origin with an allowed privileged permission, requires a native human grant per chat/lane before an agent can inspect or control it. Use `browser authorize` when a synchronous status/session command asks for approval; navigation commands request the same approval directly. Grants are memory-only and disappear on ADE restart. Agent-triggered cross-origin navigation and redirects are stopped at the boundary; approved normal navigations may continue, while approved redirects require retrying the initiating action so ADE never blindly replays a redirected request. Sensitive popups are blocked until the agent navigates there explicitly and the human approves.
- Browser tab URLs and the active index restore from a bounded machine-local store. Agent leases, lightweight browser sessions, and session-cookie values are never synthesized or restored by that store, so a restarted agent must claim a tab again and sites retain control over logout/expiry semantics.
- ADE migrates unexpired persistent cookies once from this release channel's old project-derived browser profiles. Global-profile cookies win conflicts and session cookies are intentionally not copied. The old profile directories remain on disk because Chromium local storage, IndexedDB, service workers, and WebAuthn credentials cannot be merged safely across partitions.
- Site permissions are deny-by-default and scoped to the requesting origin, embedding origin, and device type where relevant. Native prompts default to Block. Global profile cookie-domain diagnostics and remembered-permission administration are trusted-renderer-only; agent and unbound CLI calls are rejected.
- Humans can open the Browser toolbar's **Profile** panel to inspect non-secret global cookie/cache/flush health and remove one or all remembered permission decisions. This renderer path is intentionally unavailable through `ade browser` automation.
- **Login import is human-only and has no `ade browser` command.** A human can import cookies from Chrome/Chromium/Brave/Edge/Arc/Vivaldi/Opera/Helium, Firefox, and Safari into the shared profile, choosing which domains to bring over. It is a trusted-renderer IPC path only: an agent that could import cookies could hand itself any identity on the machine, so there is nothing to call here. On Windows only Firefox and Helium can be imported — Chrome's app-bound encryption blocks every other Chromium fork — and Safari import needs Full Disk Access. If a site needs a login you do not have, ask the human to sign in or run the import; do not try to reach the source browser's files yourself.
- HTTP/proxy authentication and client-certificate selection always happen in separate human-only ADE prompts. Agents cannot fill those prompts through `ade browser`; after a human authenticates, the site is treated as a sensitive origin under the same per-chat approval boundary.
- `observe` and post-action observations save a screenshot plus a bounded DOM element list, console diagnostics, failed-network diagnostics, and pending request count by default. Add `--map` to write a numbered visual element map image, then use the listed `handle` values with `click`/`fill`/`clear-field`/`press`/`wait`. Handles can replay into same-origin iframes and open shadow roots when the saved element included frame/shadow context. Use `--fast` on actions when the page does not need the default settle delay.
- Page actions beyond click/type: `hover` moves the mouse over a located element (CSS `:hover`, tooltips, hover menus), `drag` presses at a source and releases at a destination (`--to-selector`/`--to-text-match`/`--to-test-id`/`--to-element`/`--to-handle`/`--to-x --to-y`, optional `--steps`), `select-option` picks a `<select>` option by `--value`, `--option-label`, or `--option-index`, and `upload` sets an `<input type=file>` via `--file` (repeatable) or trailing paths. All four take the same `--tab`/`--browser-session`, `--selector`/`--handle`/`--text-match`, and `--fast` flags as `click`, scroll the target into view, reject disabled targets, record a trace entry, and return the post-action observation. Note `select` stays the DOM-point selection command; the option picker is `select-option`.
- `upload` only accepts paths inside the project worktree, `<project>/.ade/tmp`, ADE's browser scratch root, and the OS temp dir. Anything else — including `..` escapes — is rejected before the page sees a path, because a file input hands the file to whatever site the tab is on.
- `emulate` sets a device override per tab via CDP (`Emulation.setDeviceMetricsOverride`, plus touch emulation and a user-agent override for mobile presets). Presets: `desktop`, `iphone-17`, `iphone-17-pro`, `iphone-17-pro-max`, `ipad`, `pixel`, `responsive`. `--device desktop` and `--off` both clear the override; an unknown preset is an error rather than a silent no-op. `--width/--height` (with optional `--scale`, `--mobile`) sets a custom responsive size, clamped to 64-10000px and 0.25-5x. `ade browser open <url> --device <preset>` navigates and then applies the preset to that tab. The preset persists on the tab and is reported in `browser tabs` as `emulation`.
- `zoom` is `webContents.setZoomFactor`, clamped to 0.25-5 and stored per tab as `zoomFactor`. Chromium tracks zoom per origin, so ADE re-applies the tab's factor after a navigation; `--reset` returns it to 1.
- `find` runs Chromium's own find-in-page and resolves with `matches` and `activeMatchOrdinal`; the same counts stream on the browser event bus as `found-in-page` so the toolbar can show `3/12`. Use `--match-case`, `--backward`, and `--next` (advance within the current search). `find-stop` clears the highlight.
- `devtools` opens or closes the tab's DevTools (`--mode right|bottom|detach`, default `right`; `--close` to close) and reports `devToolsOpen` in tab state. It is primarily a human affordance: agent-bound calls are allowed but write a trace entry and a `built_in_browser.devtools_toggled` log line with the calling lane/chat. **DevTools and ADE's CDP debugger cannot own the same tab**, so ADE refuses to open DevTools while that tab is network-logging, and network logging fails to start while DevTools is open — stop one before starting the other.
- The always-on failure list is unchanged. `network on --tab <id>` additionally starts a full per-tab request log (CDP `Network.*`, ring buffer of 500) with method, URL, status, mime, resource type, protocol, cache flag, sizes, timings, and headers. `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie` values are replaced with a redaction marker before anything is stored, so a network log never leaks the shared profile's live session. Read it with `network --tab <id> [--failed] [--filter <text>] [--limit <n>]`, and `har --tab <id>` writes a HAR 1.2 file (same redaction) into the tab's observation scratch directory. While logging is on, observations carry a `diagnostics.networkLog` block with the recorded count and the last 10 entries.
- `record start --tab <id> [--fps 30|60] [--caption "..."]` records the tab. ADE captures through Chromium itself: a hidden ADE-owned page calls `getDisplayMedia()` and Electron's display-media handler answers it with *that tab's* frame, then `MediaRecorder` encodes to MP4 (H.264) where available and WebM otherwise. No native dependencies and no screen-recording permission prompt, because it captures the tab rather than the screen. `record stop --tab <id>` returns `{ path, durationMs, fps, frameCount, format }`; `frameCount` is derived from the negotiated frame rate. **A proof-drawer entry is filed only when `record start` was given a `--caption`** — otherwise the file stays scratch and only its path comes back. One recording per tab; a tab close ends it. `browser tabs` reports `recording: { startedAt, fps }` while it runs, and the event bus emits `recording` events for a REC pill.
- Use `ade --socket browser trace --tab <id> --text` when an action gets stuck. The trace is a bounded per-tab action log with before/after URL, target metadata, observation id, duration, and errors. Fill/type traces record text length rather than typed text.
- Project browser observations are scratch files under `.ade/cache/browser-observations/`; personal-tab observations use the current ADE channel's machine-local `browser-observations/personal/` scratch root. Both prune aggressively to the latest 3 observations per tab by default. Use `--no-dom` for image-only scratch captures and proof commands only for reviewer-facing evidence.
- Use `ade --socket browser proof --tab <id> --caption "..."` or `ade --socket browser proof --browser-session <id> --caption "..."` to promote a fresh browser observation into the durable proof drawer.
- Signed packaged macOS builds embed ADE's Developer ID provisioning profile and enable Electron's Touch ID WebAuthn authenticator with the matching keychain access-group entitlement; source builds require `ADE_ENABLE_TOUCH_ID_WEBAUTHN=1` for explicit testing, and `ADE_ENABLE_TOUCH_ID_WEBAUTHN=0` disables it. These credentials are device-bound to the Mac's Secure Enclave and the global Electron browser session; they are not iCloud-synced passkeys. ADE does not claim Apple Passwords extension support.
