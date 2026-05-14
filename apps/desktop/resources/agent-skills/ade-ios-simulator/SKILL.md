---
name: ade-ios-simulator
description: Use this skill when working with ADE iOS Simulator, Preview Lab, SwiftUI preview rendering, simulator screenshots, taps, streams, or iOS drawer context via `ade ios-sim`.
---

# ADE iOS Simulator and Preview Lab

## Start here

Use socket mode so CLI actions and the desktop drawer share one simulator session:

```bash
ade --socket ios-sim status --text
ade --socket ios-sim devices --text
ade --socket ios-sim apps --text
ade help ios-sim launch
```

Launch with a target from `apps`:

```bash
ade --socket ios-sim launch --target <id> --text
```

## Inspect and interact

Capture current screen/context before acting:

```bash
ade --socket ios-sim snapshot --text
ade --socket ios-sim elements --text
ade --socket ios-sim select --x <x> --y <y> --text
```

Interact with the running app:

```bash
ade --socket ios-sim tap --x <x> --y <y> --text
ade --socket ios-sim drag --start-x <x> --start-y <y> --end-x <x> --end-y <y> --text
ade --socket ios-sim type --value "text" --text
```

## Streams

Use `stream-status` to explain the active backend, latency, fallback reason, and blockers:

```bash
ade --socket ios-sim window-start --fps 60 --text
ade --socket ios-sim live-start --fps 30 --text
ade --socket ios-sim stream-status --text
ade --socket ios-sim stream-stop --text
```

Low idle fps is normal on `iosurface-indigo` because frames are event-driven when the simulator is still.

## Preview Lab

For SwiftUI preview work:

```bash
ade --socket ios-sim preview-status --text
ade --socket ios-sim previews --source <swift-file> --text
ade --socket ios-sim preview-render --source <swift-file> --index <n> --text
```

Add a preview only when no useful nearby preview already exists. Preview fixtures must not require live sync, keychain, network, push, sockets, or production databases.

## Gotchas

- Do not create symlink projects, fake schemes, or repo-layout shims as the first fix for app detection. Re-run `ade --socket ios-sim apps --text` and report the selected project, scheme, and build output.
- If no simulator/session/snapshot exists, report the exact blocker instead of guessing the screen.
- When you own the simulator session and the task no longer needs it, run `ade --socket ios-sim shutdown --text`.

