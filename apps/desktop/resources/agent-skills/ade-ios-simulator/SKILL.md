---
name: ade-ios-simulator
description: Use this skill when you need to see an iOS or SwiftUI change actually running on a simulator — launching the app, opening a device, driving it by element query, screenshotting or streaming the screen, capturing proof, or rendering a SwiftUI preview through Preview Lab — via `ade ios-sim`.
---

# ADE iOS Simulator and Preview Lab

## Quick verify

Check support, get a device, act, prove. Use `--socket` so CLI actions and the desktop drawer share one session.

```bash
ade --socket ios-sim status --text
ade --socket ios-sim apps --text
ade --socket ios-sim launch --target <id> --text
ade --socket ios-sim proof-bundle --caption "Settings row renders" --text
```

- `status` is the gate. If `supported` is false the runtime is not a Mac — stop and say so. Do not probe further: the commands that touch a real simulator fail with the macOS-only error, and the rest answer with inert results that look like success.
- `launch` builds your lane worktree, installs it, and starts it. `open-device` boots a simulator with no app and builds nothing — use it to drive an app that is already installed.
- `launch` runs in the background. Add `--foreground` when the user asked to watch it.
- `launch --follow` waits out a cold build on a real budget (17 min) and prints the launch summary. It does not stream per-step progress.
- `screenshot --out <path>` returns a `filePath` you can Read. Without `--out` the PNG goes to `<buildRoot>/.ade/cache/ios-simulator/screenshots/` and only the newest 20 survive.
- `proof-bundle` writes the screenshot plus the machine, device, build root, on-screen elements, and recent log rows. Use it for reviewer-facing evidence. `proof` still files a lone screenshot in the proof drawer.
- Release when done: `ade --socket ios-sim shutdown --text` for an app session, `close-device` for a device session.

## Read the current state

One command answers "what is going on with the simulator drawer".

```bash
ade --socket ios-sim status --text
```

It reports, in one payload:

- `supported` and `tools` — whether this machine can run a simulator at all, and which of `xcrun`, `xcodebuild`, `idb` and `idb_companion` are present.
- `activeDevice` — the device every other command defaults to.
- `activeSession` — the app session: bundle id, app name, build root, lane, and the chat that owns it. Null means no app is running.
- `deviceSession` — a booted simulator with no app, and the chat that owns it. Null means nobody opened one.
- `stream` — the live view: `running`, `backend`, `fps`, `bitrateKbps`, and `lastError`. It never carries the stream address or its token.

Read the ownership fields before you act. When `chatSessionId` names another chat, that chat owns the session: `claim` takes it deliberately, and every other command drives whatever is running.

Add `ade --socket ios-sim log --text` when you need what the app and ADE have been doing, and `ade --socket ios-sim snapshot --text` when you need what is on screen.

## Show the user the drawer

Agent commands do not open the drawer. The user gets a "Simulator running" pill with an Open action instead, so an agent working in the background never steals the screen.

Open it deliberately when the user asked to watch:

```bash
ade --socket ios-sim launch --target <id> --open-drawer --text
```

## Launch a named app

`apps` lists every launchable target with its id, name, bundle id, and whether it is buildable or only installed.

```bash
ade --socket ios-sim apps --text
ade --socket ios-sim launch --target <id> --text          # by target id
ade --socket ios-sim launch --bundle-id com.acme.app --text  # an installed app
ade --socket ios-sim launch --scheme MyApp --no-build --text # skip the build
```

Prefer `--target`. A bundle id alone finds only an app that is already installed, so it starts whatever binary is on the device rather than your lane's code.

## Drive the app

Name elements, not pixels. A coordinate tap is a guess that the layout did not move, and the guess fails silently: the tap lands on whatever moved into that rectangle.

```bash
ade --socket ios-sim snapshot --text
ade --socket ios-sim tap-element --label "Sign in" --text
ade --socket ios-sim fill-element --identifier email-field --value ada@example.com --text
ade --socket ios-sim wait-for-element --label Welcome --timeout-ms 8000 --text
ade --socket ios-sim assert-visible --label Welcome --text
```

- Run `snapshot` first. It returns every element with a `ref`, a label, a role, and a source file.
- Query with `--ref`, `--identifier`, `--label`, `--text`, `--role`, and `--index`. Every result reports `matchCount`, so an ambiguous query is visible instead of silent.
- A `ref` names its own tier. `id:` and `component:` survive a re-render. `label:` changes when the copy changes. `pos:` survives nothing — read it as "this element carries no identity" and ask for an accessibility identifier.
- `wait-for-element` replaces a sleep. Add `--gone` to wait for a disappearance.
- `assert-visible` is the last step, so the result states what was proven.
- Fall back to a coordinate tap only when no query matches: `tap --x --y`, `drag --start-x --start-y --end-x --end-y`, `type --value`, `select --x --y`. A drag takes 180ms unless you pass `--duration-ms`; raise it for a slow scroll.

`launch` returns `capabilities` (`canTap` / `canType` / `canDrag` / `canInspect`). Tap, type, drag, and every element action need both `idb` and `idb_companion`. Snapshots still work with `xcrun` alone.

## Device tools

```bash
ade --socket ios-sim appearance dark --text
ade --socket ios-sim content-size accessibility-extra-large --text
ade --socket ios-sim accessibility reduce-motion on --text
ade --socket ios-sim location 37.7749 -122.4194 --text
ade --socket ios-sim permission grant photos --bundle-id <id> --text
ade --socket ios-sim push --bundle-id <id> --title Hi --body "You have mail" --text
ade --socket ios-sim open-url myapp://settings --text
ade --socket ios-sim status-bar --time 9:41 --wifi-bars 3 --battery-level 100 --text
ade --socket ios-sim relaunch --bundle-id <id> --text
ade --socket ios-sim terminate --bundle-id <id> --text
ade --socket ios-sim uninstall --bundle-id <id> --text
ade --socket ios-sim app-state --bundle-id <id> --text
ade --socket ios-sim settings --text
```

- Set the status bar to 9:41 with full bars before a screenshot, so the shot stays stable between runs.
- `relaunch` restarts the installed binary. It does not build. Use `launch` when the point is to see a code change.
- `uninstall` removes the container, which is how you prove a first-run flow. It is guarded, like the event log: pass `--chat-session <id>` to name yourself, or `--force` to take it from another chat. The other device tools are not guarded, in line with `tap` and `type`.
- `location --clear` and `status-bar --clear` drop an override.
- `settings` reads appearance, content size, and accessibility back from the device. It cannot read a location or a status bar back — those report what ADE last set, and reset when the runtime restarts.

Read the device log around an action:

```bash
ade --socket ios-sim log-start --bundle-id <id> --text
ade --socket ios-sim log --since <cursor> --limit 100 --text
ade --socket ios-sim log-stop --text
```

One list holds the app's own `os_log` rows and ADE's own actions in order. Pass the returned `cursor` back as `--since` to read only new rows.

`--bundle-id` is required. `log stream` reads the whole device, so a run with no app scope returns every other app's rows and the system's. There is one log process per host as well, so `log-start` and `log-stop` refuse a chat that does not own the device session — pass `--chat-session <id>` to name yourself, or `--force` to take the log.

## Live view

Only when the user should watch the app run:

```bash
ade --socket ios-sim live-start --fps 60 --text
ade --socket ios-sim stream-start --backend idb-h264 --scale-factor 0.5 --text
ade --socket ios-sim stream-status --text
ade --socket ios-sim stream-stop --text
```

`simulator-window-capture` is the default and the cheapest path. It captures the real Simulator.app window on this Mac, so it needs the Screen Recording grant and a visible window. `idb-h264` encodes on the machine that owns the simulator and needs neither. Use `idb-h264` when the runtime is a remote Mac. Agent launches do not open the drawer; the user gets a "Simulator running" pill with an Open action. Use `stream-status` to explain a blank live view. It reports the backend, the codec, fps and bitrate, but never the stream URL or its token: only `stream-start` returns those, and the token stops working when the stream ends.

## Preview Lab

```bash
ade --socket ios-sim preview-status --text
ade --socket ios-sim previews --source <swift-file> --text
ade --socket ios-sim preview-match --source <swift-file> --line <n> --text
ade --socket ios-sim preview-ensure --source <swift-file> --line <n> --text
ade --socket ios-sim preview-current --text
ade --socket ios-sim preview-render --source <swift-file> --index <n> --text
```

To bridge the current screen into Preview Lab, `select` a source-backed element (or pass `--source` / `--line`), then run `preview-current`. That one command resolves the best nearby preview, opens or waits for Xcode, and renders through Xcode MCP.

Use `preview-match` when you only need the target decision without rendering. Preview fixtures must not require live sync, keychain, network, push, sockets, or production databases. Add a preview only when no useful nearby one exists.

## Ownership and recovery

One chat owns a simulator session at a time. A second launch fails with `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION`, naming the owning chat, the lane, and how long ago it claimed.

- Ownership releases automatically only when the owning chat is deleted or archived. Closing it does not free the simulator.
- The guard is cooperative, not a lock. `shutdown --force`, `shutdown --ignore-ownership`, `launch --force`, `claim --ignore-ownership`, and passing the owner's own chat session id all get through. So the restraint is yours to keep: ask before you evict another chat.
- Waiting only pays off if the owner is actively finishing. An idle chat holds the session indefinitely, so do not sit in a retry loop.
- `claim --lane <lane-id>` attaches an already-running session to a lane. It is not a step in a normal launch, and it is a takeover when another chat owns the session.
- `close-device` releases a device session. ADE never shuts down a device it did not boot; pass `--shutdown` to shut one down anyway.

## Gotchas

- `IOS_SIMULATOR_TARGET_ROOT_MISMATCH` means the target id came from a different build root. Re-run `ade --socket ios-sim apps --text` and use a fresh id.
- `IOS_SIMULATOR_NO_BUILDABLE_TARGET` means nothing buildable resolved under the root and you named no target, so the only candidates would run stale code. Pass `--target-id` / `--bundle-id` only if you deliberately want the installed app.
- `IOS_SIMULATOR_LAUNCH_IN_PROGRESS` means a launch is already running. Wait for it. `shutdown --force` is the escape hatch if it is genuinely wedged.
- `IOS_SIMULATOR_LANE_NOT_RESOLVED` means the lane has no worktree on this machine. It is a hard failure on purpose: the alternative is building the primary checkout and reporting someone else's code as verified. Pass `--project-root`.
- `screenshot --out` and `proof-bundle --out` resolve relative paths against the build root, and the path must stay inside it. The returned path is absolute; Read that rather than rebuilding it.
- `apps` drives project and scheme detection. If it does not find your app, re-run it and report the selected project, scheme, and build output. Do not work around it with symlink projects, fake schemes, or repo-layout shims.
- `preview-current` / `preview-match` returning `no-context` means nothing on screen is source-backed. Run `snapshot`, `select` a source-backed element, or pass `--source` / `--line`.
- `--text` reads two ways. A bare `--text` is ADE's output mode. `--text <value>` is the element query's substring match; write `--text-match <value>` when you want no ambiguity.
