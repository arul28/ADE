---
name: ade-macos-vm
description: Use this skill when starting, inspecting, guiding, screenshotting, selecting, clicking, typing, or troubleshooting ADE lane-tied macOS VMs through `ade macos-vm`.
---

# ADE macOS VM

## Start

macOS VMs are lane-tied agent workspaces.

```bash
ade help macos-vm
ade --socket macos-vm status --lane <lane> --text
ade --socket macos-vm start --lane <lane> --create --text
ade --socket macos-vm guide --lane <lane> --text
```

## Interact

```bash
ade --socket macos-vm screenshot --lane <lane> --text
ade --socket macos-vm select --lane <lane> --x <x> --y <y> --text
ade --socket macos-vm click --lane <lane> <x> <y>
ade --socket macos-vm type --lane <lane> --value "text"
```

Click/select coordinates are window-relative by default.

## Gotchas

- Keep code edits under the guest shared path described by `guide`.
- Confirm provider readiness from `status` before promising VM interaction.
- If the VM is missing or blocked, report the exact status and next action.

