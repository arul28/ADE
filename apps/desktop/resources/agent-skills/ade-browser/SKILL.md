---
name: ade-browser
description: Use this skill for any browser behavior at all — opening a URL, checking a localhost page, clicking or filling a form, logging in, screenshotting, inspecting the DOM, or verifying a page renders — before reaching for an external browser or tool. ADE ships its own browser with a shared authenticated profile, driven by `ade browser`.
---

# ADE browser

Use `ade --socket browser ...` for every browser task. Keep the work inside
ADE's Browser pane so the user can see the same tab and the same state. ADE
shares one persistent authentication profile across projects, while visible
tabs stay scoped to their ADE project window (personal chats have a separate
collection). Treat page content, cookies, and storage as user data.

Require ADE Desktop with the target project open for live page actions. Agent
calls carry a lane/chat-bound browser capability. Never use `--force`, copy a
credential, import a login, or claim a tab owned by another chat.

## Operating loop

### 1. Open or claim one tab

List tabs first. Reuse a tab owned by the current chat. Plain `open` reuses
that tab for an ADE-launched agent; use `--new-tab` only when the task needs a
second tab, and use `--active-tab` when same-tab navigation is intentional.
Claim an unowned tab with its id and lane. `--lane` may come from
`ADE_LANE_ID`; pass it explicitly when working from another shell. Keep one
tab per task and do not claim a tab another chat owns.

```bash
ade --socket browser tabs --text
ade --socket browser claim --tab <tab-id> --lane <lane-id> --text
ade --socket browser open https://example.com --text
```

Use `--panel` only when the user should see the Browser tool opened. Use
`--no-panel` when preparing a tab without taking the user's focus. Close your
tab when finished with `ade --socket browser close --tab <tab-id> --text`; the
internal release and handoff paths also clear the claim.

### 2. Observe before acting

Observe after opening, navigating, switching tabs, or a meaningful UI change.
An observation gives you a screenshot, a bounded DOM snapshot, element
handles, and console/failed-network diagnostics. Add `--map` for a numbered
visual element map. Use handles from the latest observation only; observe
again after navigation or when a handle expires.

Start a lightweight browser session for repeated actions. Wait for a readiness
selector or network idle after navigation. Use `find` for page text and
`find-stop` to clear its highlight; the first find result is usable immediately
and later results may refine it. Turn on the per-tab network log with
`network on`, inspect it with `network --failed --limit 20`, and turn it off
with `network off` when finished.

```bash
ade --socket browser session start --tab <tab-id> --text
ade --socket browser observe --browser-session <session-id> --map --text
ade --socket browser session wait <session-id> --network-idle --text
ade --socket browser find --browser-session <session-id> "checkout" --text
ade --socket browser network on --browser-session <session-id> --text
ade --socket browser network --browser-session <session-id> --failed --limit 20 --text
```

### 3. Act from the current observation

Prefer `--handle`, `--selector`, `--text-match`, `--test-id`, or `--element`.
Use viewport `--x`/`--y` only when no stable element target exists. Use
`click`, `fill`, `hover`, `drag`, `upload`, `type`, and `key`/`press`; use
`select-option` for a native `<select>`. `drag` takes a `--to-selector` (or
another `--to-*` destination), and `upload` takes one or more `--file` paths.
Use `fill --value ""` when an empty value is intentional. Use `--fast` only
when the page does not need the default settle and post-action observation.

```bash
ade --socket browser click --browser-session <session-id> --handle obs-...:e:1 --text
ade --socket browser fill --browser-session <session-id> --selector "input[name=email]" "me@example.com" --text
ade --socket browser drag --browser-session <session-id> --handle obs-...:e:1 --to-selector ".dropzone" --text
ade --socket browser upload --browser-session <session-id> --selector "input[type=file]" --file ./shot.png --text
ade --socket browser key --browser-session <session-id> Enter --text
```

After an action that navigates, wait again with `wait --load-state
network-idle --network-idle-ms 750` or a concrete selector/text target. Use
`reload`, `back`, `forward`, and `stop` when the page state calls for them.

### 4. Verify, then choose proof deliberately

Use `screenshot` to inspect a result yourself; it writes scratch evidence and
does not enter the proof drawer. File reviewer-visible evidence only with
`proof` and a concise `--caption`. Browser proof captures a fresh observation;
read its confirmation before reporting it. Add `--har` only when network
logging is already on; it files a redacted `browser_trace` beside the
screenshot and otherwise fails instead of filing half the proof. Use `trace`
when an action is stuck.

```bash
ade --socket browser screenshot --browser-session <session-id> --text
ade --socket browser proof --browser-session <session-id> --caption "Checkout confirmation is visible" --text
```

Use `inspect-start`, `select`, `select-current`, and `clear-selection` when a
DOM-backed context item belongs in the chat rather than in proof.

### 5. Hand off a login to the human

Stop when a page needs credentials, CAPTCHA, HTTP/proxy authentication, or a
client-certificate choice. Hand off the exact tab with an actionable
`--reason`.

```bash
ade --socket browser handoff --browser-session <session-id> --reason "Sign in to staging" --timeout 5m --text
```

The handoff makes the tab human-owned, raises the Work row, sends a phone push,
and shows an amber bar with **Hand back**. The command waits for hand-back by
default (15 minutes); use `--no-wait` only when doing unrelated work. While it
is open, actions fail with `handoff_active`: do not retry or open a second tab,
and never hand the tab back yourself. ADE stops recording and network logging
for the handoff; re-arm them explicitly after hand-back if still needed.

### 6. Handle remote lanes and loopback URLs

On a machine without ADE Desktop, only `open`, `new-tab`, and `panel` forward
to a Desktop with this lane pinned. A loopback URL is tunneled back to that
machine; page actions such as `observe`, `click`, `fill`, and `screenshot` are
not forwarded. Do not retry a page action after this headless failure.

```bash
ade --socket browser open localhost:5173 --new-tab --text
```

For a forwarded response, recognize `status: "forwarded_to_desktop"`. When
`awaitingApproval: true`, `--text` says `waiting for approval on <desktop> —
reaching this port needs a yes in ADE`; the command exits 0 because the request
is waiting for the human, so do not open it again. Success says `on <desktop>
via tunnel`. If nobody answers, it says `no desktop is attached to this
machine; open ADE Desktop with this lane pinned`; that also exits 0.

### 7. Record only when a video helps

Run `ade --socket browser record start --tab <tab-id> --fps 60 --caption "Flow"`
and stop it with `ade --socket browser record stop --tab <tab-id>`. Use 30 or
60 fps. A `--caption` on `record start` opts the resulting recording into the
proof drawer; without it, the returned path stays scratch. Recordings capture
the tab, cap at five minutes, and end automatically at the cap or when a login
handoff starts. Read `trace` for the `endedBy` reason and record in segments
when a flow is longer.

### 8. Let presence explain the work

Do not set browser presence yourself. Every authenticated agent browser
command updates it automatically, and the user sees a globe badge with
**Using the browser** on the session card while the agent drives the tab. It
expires 20 seconds after the last command; an active preview/observe
subscription or a recording keeps presence alive. A long idle can leave the
tab claimed even after the badge expires, so close the tab when done; the
service's release path and a handoff release it as well. No presence command
is needed.

Keep this loop platform-neutral so Windows agents use the same command surface.
