---
name: ade-macos-vm
description: Use this skill when starting, inspecting, guiding, screenshotting, selecting, clicking, typing, or troubleshooting ADE's singleton macOS VM through `ade macos-vm`.
---

# ADE macOS VM

## Start

ADE manages a **singleton** Apple silicon macOS VM: one VM per ADE install,
with at most one VM-backed lane attached to it at a time. Onboarding runs
**once**; subsequent VM lanes mount into the existing VM without
re-downloading the restore image or repeating Setup Assistant.

A "VM lane" is a lane with `runtimePlacement === "macos-vm"`. **Detaching** a
VM lane atomically converts it to a normal local lane (its
`runtimePlacement` flips to `"local"`); the detach is **irreversible from
that lane** — to get a VM lane back, create a new one through the dialog.

The desktop surface is the dedicated `/vm` tab; `/macos-vm` redirects there.
Check status first, because host/provider readiness blocks VM lane creation
when Lume is not installed.
ADE prefers Cua's signed Lume app bundle at
`~/.local/share/lume/lume.app/Contents/MacOS/lume`; unsigned Homebrew shims
are rejected because Apple Virtualization and VM networking entitlements are
required for reliable visible/control sessions.
The VM tab starts new VMs from a cached Apple Sequoia restore image by
default instead of relying on Cua's bundled unattended OCR preset. Treat
Setup Assistant as a visible control flow in ADE/Screen Sharing unless the
caller explicitly asks for an unattended preset.
ADE applies the VM record display size before every `lume run`, opens the
embedded console with managed VNC credentials, and reuses exactly one
existing macOS Screen Sharing connection for the VM's VNC port instead of
spawning duplicate viewer windows. When the VNC port changes or duplicate
helpers are already attached, ADE closes the `Virtualization` helpers before
opening one current hidden helper. On the tested signed-Lume/Sequoia path,
Lume's `--no-display` mode avoided the external viewer but returned blank
direct-VNC frames; the stable product path is to keep the current Screen
Sharing helper attached, minimize that helper window, and present ADE's
embedded VM console as the user-facing surface.

```bash
ade help macos-vm
ade --socket macos-vm status --text
ade --socket macos-vm start --lane <lane> --create --text
ade --socket macos-vm guide --lane <lane> --text
```

## Phase model

Onboarding advances through a fixed 10-phase model. `status --text` prints
the current phase as `phase N/10 · <label>`. Phases monotonically advance;
the active phase is the lowest-numbered one not yet completed.

| #  | Key                 | Label                    |
|----|---------------------|--------------------------|
| 1  | `lane_attached`     | Lane attached            |
| 2  | `download_image`    | Download restore image   |
| 3  | `create_vm`         | Create VM                |
| 4  | `install_macos`     | Install macOS            |
| 5  | `boot`              | Boot                     |
| 6  | `first_boot_setup`  | First-boot setup         |
| 7  | `remote_login`      | Enable Remote Login      |
| 8  | `save_credentials`  | Save credentials         |
| 9  | `install_runtime`   | Install agent runtime    |
| 10 | `ready`             | Ready for VM lanes       |

Phase 9 explicitly installs **ade-runtime inside the guest** over SSH after
credentials are saved in phase 8. Until phase 10 is reached the VM is not
usable for VM lanes; the gate flips on the `runtime_ready` guest readiness
state.

## Lifecycle commands

```bash
ade --socket macos-vm status --text
ade --socket macos-vm status --lane <lane> --text
ade --socket macos-vm restart --vm-name <name> --text
ade --socket macos-vm restart --lane <lane> --force --text
ade --socket macos-vm wipe --force --text
ade --socket macos-vm install-runtime --vm-name <name> --text
ade --socket macos-vm set-credentials --vm-name <name> --username ade
ade --socket macos-vm set-credentials --vm-name <name> --username ade --password-stdin
```

- `restart` composes a stop → wait → start without touching the disk and
  emits restart-phase events. Use `--force` to treat in-flight ops as
  cancellable.
- `wipe` destroys the VM disk and removes the cached IPSW; the next
  VM-lane creation triggers full re-onboarding. Without `--force`, the CLI
  prints a warning and requires typing `yes` on stdin before continuing.
- `install-runtime` scp's the bootstrap script and runs it over SSH inside
  the guest; it advances the VM to `runtime_ready`.
- `set-credentials` saves the guest username + password in the macOS
  Keychain (via `keytar`, keyed by VM name). The password is **never echoed
  to the terminal**: the CLI prompts silently unless `--password-stdin` is
  set, in which case it reads the raw password from stdin.

## Interact

```bash
ade --socket macos-vm screenshot --lane <lane> --text
ade --socket macos-vm select --lane <lane> --x <x> --y <y> --text
ade --socket macos-vm click --lane <lane> <x> <y>
ade --socket macos-vm type --lane <lane> --value "text"
```

Click/select coordinates are window-relative by default.

## Gotchas

- Keep code edits under the guest shared path described by `guide`
  (`/Volumes/My Shared Files` by default).
- Confirm provider readiness from `status` before promising VM interaction.
- Check the provider detail path in `status`; it should point at the signed
  Cua app bundle unless `ADE_LUME_PATH` intentionally overrides it.
- If `externalVncClientHidden` is true, Screen Sharing may still be
  connected in the background to keep Lume frames visible; do not treat
  that minimized helper as the primary user surface.
- Fresh IPSW-created VMs stop at Setup Assistant. `status` reports this as
  `phase 6/10 · First-boot setup`; drive Setup Assistant through the VM tab
  console, then enable Remote Login (`sudo systemsetup -setremotelogin
  on`), then save credentials.
- `phase 10/10 · Ready for VM lanes` (equivalently
  `guestReadiness.state = runtime_ready`) is the handoff point for in-guest
  coding — earlier phases do not yet have an ade-runtime to talk to.
- Detaching a VM lane (lane → local) is irreversible from that lane. The
  share is marked `stale` and silently cleaned up on the next `restart` or
  `wipe`; create a new VM lane to attach again.
- `wipe` while a VM lane is attached auto-detaches the lane to local
  before destroying the disk.
- If the VM is missing or blocked, report the exact status and next action.
