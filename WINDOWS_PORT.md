# Windows port

DAEX ships a signed Windows 10/11 x64 desktop with every release. This file is
the short entry point for Windows work; the detail lives in:

- [docs/development/windows-support.md](docs/development/windows-support.md):
  what Windows supports, what it does differently from macOS (the capability
  table), the installed-host layout and troubleshooting. This is the current
  truth about Windows behavior.
- [docs/development/windows-port-lane.md](docs/development/windows-port-lane.md):
  rules for the Windows integration lane.
- [docs/development/windows-release-proof.md](docs/development/windows-release-proof.md):
  the exact-SHA release evidence contract.
- [docs/development/windows-update-timeline.md](docs/development/windows-update-timeline.md):
  the auto-update install timeline.
- [docs/playbooks/windows-signed-release.md](docs/playbooks/windows-signed-release.md):
  signing and publishing a Windows release.
- **On Windows** in [docs/development/local-development.md](docs/development/local-development.md#on-windows):
  running a dev app, profiling and benchmarking on a Windows host.
- `.agents/skills/quality/references/windows-quirks.md`: the review checklist
  for Windows-specific code.

## Scope

- Supported: the packaged Windows 10/11 x64 desktop (per-user NSIS installer,
  no administrator rights), the local Windows brain, the standalone runtime
  (`install.ps1`, `daex brain update`), Windows as an SSH-bootstrap target, phone
  pairing, App Control, the built-in browser, proof ingestion, and a per-lane
  Windows screen ([Windows Desktop](docs/features/windows-desktop/README.md)).
- Not supported: Windows ARM64, the iOS Simulator and Xcode Preview (hidden),
  Claude Code's sandbox (WSL 2 only).
- Public Windows publication is switched by the repository variable
  `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` (named for historical reasons).

## How the Windows brain runs

The brain is registered per user and per channel under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which starts a
BOM-marked PowerShell supervisor that restores the full brain environment and
restarts the brain with backoff (`apps/ade-cli/src/serviceManager/installWindows.ts`).
Install and uninstall also remove Scheduled Task registrations that early
preview builds created. The runtime and desktop-bridge named pipes
(`\\.\pipe\ade-runtime-<channel>-<hash>`, `\\.\pipe\ade-desktop-bridge-<channel>-<hash>`)
are keyed by the canonical home, the channel and the current user, so channels
and users never share a brain (`machineLayout.ts`). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) section 2.1.

## Rules learned the hard way

- **Hide every console window.** Pass `windowsHide: true` on every `spawn` /
  `spawnSync` / `execFile` that can run on Windows, including probes the app
  repeats (service status, provider, auth, usage, Git and Tailscale probes,
  workers, service install). A host was once made unusable by visible
  PowerShell console windows that piled up and outlived the Electron window.
  `windowsHide` alone is not always enough; the exact conditions are in
  `windows-quirks.md`.
- **No POSIX shell syntax in launch commands.** Provider resume and App Control
  build structured command, argv and env descriptors on Windows; intent is
  materialized on the runtime that owns the lane, so a Windows renderer never
  sends PowerShell to a macOS or Linux brain.
- **Port 8787 may be taken** (Tailscale and other services use it). The sync
  host falls back within 8787–8999 and rejects a stale lock whose PID was
  reused by another executable.
- **A Windows-host local test run is not authoritative.** The full suites still
  have Windows-host baseline failures in POSIX-only fixtures, Unix-socket
  browser tests, `chmod` assertions and some SQLite teardown races. Compare
  against that baseline before calling a local run red; CI's
  `windows-foundation` job is the Windows gate.
