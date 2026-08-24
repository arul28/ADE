---
name: ade-ios-simulator
description: Use this skill when you need to see an iOS or SwiftUI change actually running on a simulator — launching the app, tapping/dragging/typing in it, screenshotting or streaming the screen, inspecting on-screen elements, or rendering a SwiftUI preview through Preview Lab — via `ade ios-sim`.
---

# ADE iOS Simulator and Preview Lab

## Quick verify

The default path: check support, launch, screenshot, attach proof. Use `--socket` so CLI actions and the desktop drawer share one session.

```bash
ade --socket ios-sim status --text
ade --socket ios-sim apps --text
ade --socket ios-sim launch --target <id> --text
ade --socket ios-sim screenshot --out .ade/tmp/sim.png --text
ade --socket ios-sim proof --caption "Settings row renders" --text
```

- `status` is the gate. If `supported` is false the runtime is not a Mac — stop and say so. Every other command fails with the same macOS-only error.
- `launch` builds from your lane worktree by default. Pass `--project-root <path>` only to override.
- `launch` runs in the background: Simulator.app is not brought forward and the drawer does not take over the user's screen. Add `--foreground` when the user asked to watch it.
- `screenshot` always returns a `filePath` you can Read. `--out <path>` picks where it lands; without it the PNG goes to `<buildRoot>/.ade/cache/ios-simulator/screenshots/` and only the newest 20 survive, so `--out` anything you need to keep.
- `proof` captures a screenshot and attaches it to the proof drawer. Use it for reviewer-facing evidence, not for every check.
- `launch --follow` waits out a cold build on a real budget (17 min) and prints the full launch summary — build root, device, capabilities, prebuilt warning — when it completes. It announces the wait up front; it does not stream per-step progress.
- Release when done: `ade --socket ios-sim shutdown --text`.

## Interact

`launch` returns `capabilities` (`canTap` / `canType` / `canDrag` / `canInspect`). Check them before acting; they are false when `idb` and `idb_companion` are not installed.

```bash
ade --socket ios-sim snapshot --text
ade --socket ios-sim tap --x <x> --y <y> --text
ade --socket ios-sim type --value "text" --text
ade --socket ios-sim drag --start-x <x> --start-y <y> --end-x <x> --end-y <y> --text
ade --socket ios-sim select --x <x> --y <y> --text
```

`snapshot` returns the screenshot plus selectable elements. `select` also emits a drawer selection and feeds Preview Lab.

A drag takes 180ms unless you pass `--duration-ms`. Raise it for a slow scroll; an instant swipe reads as a flick and often does nothing.

## Drawer and live view

Only when the user should watch the app run:

```bash
ade --socket ios-sim launch --target <id> --foreground --text
ade --socket ios-sim live-start --fps 60 --text
ade --socket ios-sim stream-status --text
ade --socket ios-sim stream-stop --text
```

`live-start` and `window-start` are the same path: ADE mirrors the real Simulator.app window into the drawer. Agent launches do not open the drawer; the user gets a "Simulator running" pill with an Open action instead. Use `stream-status` to explain a blank live view.

## Preview Lab

```bash
ade --socket ios-sim preview-status --text
ade --socket ios-sim previews --source <swift-file> --text
ade --socket ios-sim preview-match --source <swift-file> --line <n> --text
ade --socket ios-sim preview-ensure --source <swift-file> --line <n> --text
ade --socket ios-sim preview-current --text
ade --socket ios-sim preview-render --source <swift-file> --index <n> --text
```

To bridge the current screen into Preview Lab, `select` a source-backed element (or pass `--source` / `--line`), then run `preview-current`. That one command resolves the best nearby preview, opens/waits for Xcode, renders through Xcode MCP, and brings the Preview drawer forward.

Use `preview-match` when you only need the target decision without rendering. The selected element's `sourceFile` / `sourceLine` bias matching; `--label` / `--component-id` only name a missing-preview suggestion. `preview-ensure` opens this lane's iOS project in Xcode and waits for MCP readiness.

Preview fixtures must not require live sync, keychain, network, push, sockets, or production databases. Add a preview only when no useful nearby one exists.

## Ownership and recovery

One chat owns a simulator session at a time. A second launch fails with `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION`, naming the owning chat and lane and how long ago it claimed. Service errors state the fact and the code only; the CLI adds the command to run next.

- Ownership auto-releases when the owning chat closes. Re-run `launch`.
- If the owner is still live and the user wants it taken over: `ade --socket ios-sim shutdown --force --text`, or `launch --force`.
- You cannot evict an owner without `--force`. Don't force it on your own initiative — ask, or wait.
- `claim --lane <lane-id>` is only for attaching an already-running session to a lane. It is not a step in a normal launch.

## Gotchas

- `IOS_SIMULATOR_TARGET_ROOT_MISMATCH` means the target id came from a different build root than the one now resolved. Re-run `ade --socket ios-sim apps --text` and use a fresh id.
- `IOS_SIMULATOR_NO_BUILDABLE_TARGET` means nothing buildable resolved under the root and you named no target, so the only candidates were preinstalled apps that would run stale code. The message lists the buildable targets when there are any. Pass `--target-id` / `--bundle-id` only if you deliberately want the installed app.
- `IOS_SIMULATOR_LAUNCH_IN_PROGRESS` means a launch is already running; the message carries its `launchId`. Wait for it — don't retry in a loop. `shutdown --force` is the escape hatch if it is genuinely wedged: it releases the launch lock as well as the session.
- `IOS_SIMULATOR_LANE_NOT_RESOLVED` means the lane you named has no worktree on this machine. It is a hard failure on purpose — the alternative is silently building the primary checkout and reporting someone else's code as verified. Pass `--project-root` with the checkout you want.
- `screenshot --out` resolves relative paths against the build root — for a lane launch that is your lane worktree, not the primary checkout. The path must stay inside that root; `../` tails and absolute paths elsewhere are rejected. The returned `filePath` is absolute either way, so Read that rather than reconstructing the path.
- `apps` drives project/scheme detection. If it does not find your app, re-run it and report the selected project, scheme, and build output — do not work around it with symlink projects, fake schemes, or repo-layout shims.
- `preview-current` / `preview-match` returning `no-context` means nothing on screen is source-backed. Run `snapshot`, `select` a source-backed element, or pass `--source` / `--line`.
- On a remote Mac runtime, control and screenshots work; the drawer live view does not — it captures a local desktop window.
- Tap/drag/type/inspect failing usually means `idb` and `idb_companion` are missing.
