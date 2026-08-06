---
name: ade-ios-simulator
description: Use this skill when you need to see an iOS or SwiftUI change actually running on a simulator — launching the app, tapping/dragging/typing in it, screenshotting or streaming the screen, inspecting on-screen elements, or rendering a SwiftUI preview through Preview Lab — via `ade ios-sim`.
---

# ADE iOS Simulator and Preview Lab

## Start here

Use `--socket` so CLI actions and the desktop drawer share one simulator session (the general rule is in the **ade-cli-control-plane** skill):

```bash
ade --socket ios-sim status --text
ade --socket ios-sim claim --lane <lane-id> --text
ade --socket ios-sim devices --text
ade --socket ios-sim apps --text
ade help ios-sim launch
```

Launch with a target from `apps`:

```bash
ade --socket ios-sim launch --target <id> --text
```

`launch` and `claim` carry lane/session ownership; see "Owning a drawer surface" in the **ade-cli-control-plane** skill for when `claim` is required.

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

Use `stream-status` to explain the active Simulator.app live view and blockers:

```bash
ade --socket ios-sim window-start --fps 60 --text
ade --socket ios-sim live-start --fps 60 --text
ade --socket ios-sim stream-status --text
ade --socket ios-sim stream-stop --text
```

`window-start` and `live-start` use the same primary path: ADE opens the user's running Simulator.app window, parks it under the owning ADE window, and mirrors it into the drawer. If tap/drag/type/inspect actions fail, check that `idb` and `idb_companion` are installed.

## Preview Lab

For SwiftUI preview work:

```bash
ade --socket ios-sim preview-status --text
ade --socket ios-sim previews --source <swift-file> --text
ade --socket ios-sim preview-match --source <swift-file> --line <n> --text
ade --socket ios-sim preview-ensure --source <swift-file> --line <n> --text
ade --socket ios-sim preview-current --text
ade --socket ios-sim preview-render --source <swift-file> --index <n> --text
```

To bridge the current simulator screen into Preview Lab, first select a source-backed element (`ade --socket ios-sim select --x <x> --y <y> --text`) or pass an explicit `--source` / `--line`, then run `ade --socket ios-sim preview-current --text`. That one command resolves the best nearby preview, opens/waits for Xcode when needed, renders through Xcode MCP, and brings the ADE Preview drawer forward.

Use `preview-match` when you only need the target decision without rendering. The selected simulator element's `sourceFile` and optional `sourceLine` bias matching; `--label` / `--component-id` are only hints for naming a missing-preview suggestion. Use `preview-ensure` when Xcode Preview Lab is not ready; it opens this lane's iOS project in Xcode and waits for MCP readiness.

Preview Lab fixtures must not require live sync, keychain, network, push, sockets, or production databases — add or refine a preview only when no useful nearby preview exists.

## Gotchas

- `apps` drives project/scheme detection. If it does not find your app, re-run `ade --socket ios-sim apps --text` and report the selected project, scheme, and build output rather than working around it with symlink projects, fake schemes, or repo-layout shims.
- `preview-current` / `preview-match` returning `no-context` means nothing on screen is source-backed. Run `ade --socket ios-sim snapshot --text` and select a source-backed element, or pass an explicit `--source` / `--line`.
- When you own the simulator session and the task no longer needs it, run `ade --socket ios-sim shutdown --text`.
