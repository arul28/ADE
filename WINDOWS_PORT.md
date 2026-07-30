# Windows port evaluation

## Executive summary

ADE does not need a ground-up Windows port. Most platform foundations already
exist: Windows named pipes, PowerShell/cmd PTYs, Git for Windows resolution,
process-tree termination, Windows native provider packages, `node-pty`, a
vendored x64 `crsqlite.dll`, NSIS packaging, CLI wrappers, and extensive
artifact validation.

The repository history confirms this. Windows foundations landed in April-May
2026 (`#186`, `#213`, and `#281`), and the release was deliberately made
macOS-only on June 12 in `#561`. However, simply uncommenting the Windows
workflow would not produce a dependable release.

Recommended direction:

- Target Windows 10/11 x64 using the existing per-user NSIS installer.
- Ship a bounded "Windows x64 preview" PR instead of promising complete
  platform parity.
- Plan on 2-4 engineer-weeks for a credible beta PR and 4-8 weeks total for
  first-class Windows GA.
- Explicitly defer Windows ARM64, Windows as a remotely installable ADE brain,
  native Windows computer use, and iOS Simulator support.

The highest risk is the packaged background brain lifecycle, not Electron
rendering or TypeScript compilation.

## Implementation status on `windows-native-build`

The code changes recommended by this evaluation are now implemented on the
working branch:

- The Windows brain runs through a per-user/channel Scheduled Task and a
  BOM-marked PowerShell launcher that restores the complete resolved runtime
  environment. Task status is locale-independent, legacy-task cleanup fails
  closed, and runtime/desktop-bridge named pipes are isolated by canonical ADE
  home, channel, and current user. Windows IPC servers explicitly retain
  Node's intended-user-only named-pipe access flags; effective cross-account
  access remains a clean-VM proof gate.
- Tracked CLI continuation uses structured command/argv/env descriptors on
  Windows for Claude, Codex, Cursor, OpenCode, and Droid. App Control likewise
  uses structured Windows launches for direct Electron/package scripts and
  platform-specific shell fallbacks. Fresh provider intent is materialized on
  the runtime that owns the lane, so a Windows renderer cannot send
  PowerShell wrappers or Windows skill paths to a pinned macOS/Linux runtime.
- The Windows x64 package contains every supported Darwin/Linux remote-runtime
  sidecar. Required `win-unpacked` package smoke validates the CLI/TUI,
  ConPTY, bundled Claude/Codex/OpenCode binaries, Cursor native helpers,
  Cursor/Droid SDK entry points, update authority, and a real `crsqlite.dll`
  CRR mutation. Installing the generated NSIS package remains a separate
  external gate.
- Required pull-request CI now builds an unsigned NSIS preview on
  `windows-latest`. Production Windows build and public release are separately
  gated; the signed path requires a pinned Authenticode identity, matching
  signer for installer and `ADE.exe`, and a trusted RFC3161 timestamp.
- The updater authority follows the repository that built the package (the
  fork default is `nsxdavid/ADE`). Windows download links and release assets
  remain disabled until the public gates are explicitly enabled.
- Windows chrome, AppUserModelID, microphone-denial guidance, sync health, and
  platform-aware copy/navigation are implemented. macOS-native Notch,
  computer-use, and iOS Simulator actions are hidden or capability-blocked
  while App Control, Browser, and proof ingestion remain available.
- The Windows developer loop now uses a per-user named pipe, invokes local
  JavaScript CLI entry points instead of fragile global `.cmd` shims, strips
  inherited runtime parent/idle shutdown controls, and waits for tsup's
  explicit successful-build signal before starting or restarting Electron.
  Runtime startup remains bounded at 30 seconds and reports an early child
  exit immediately. The launcher records whether it created the detached
  runtime and shuts down only that owned runtime when Electron exits or the
  developer interrupts the command, so a failed or closed dev session does
  not leave a polling runtime behind.
- Windows background probes and worker processes are created with hidden
  console windows. This includes the Scheduled Task status query that the
  desktop polls every two seconds, provider/auth/usage/Git/Tailscale probes,
  runtime and PTY workers, and service install/uninstall operations. The Unix
  `ps` resource sampler now reports `unsupported-platform` on Windows without
  launching a process. These protections address a host-loss incident where
  visible PowerShell console windows were repeatedly created and continued
  after the Electron window closed.
- Windows sync-host startup now rejects stale lock files when the recorded PID
  has been reused by a different executable and records process start time for
  future locks. The projectless brain uses the same 8787-8999 fallback range
  as project-scoped sync instead of waiting forever on 8787. This matters on
  Windows hosts where Tailscale or another local service already owns 8787.

No source blocker is currently known for the bounded Windows x64 desktop
preview. The remaining release work is external proof: clean standard-user
Windows 10/11 install/logoff/reboot/uninstall,
Stable+Beta and two-user isolation, physical-iPhone CRR/firewall testing,
provider/PTY special-character coverage, supported macOS/Linux remote
bootstrap, and a signed installed N → N+1 update/relaunch/background-brain
recovery test. Do not enable `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1` or
`VITE_ADE_WINDOWS_DOWNLOAD_ENABLED=1` before those checks pass.

Four source follow-ups are explicitly outside this preview boundary:
`ade brain update` continues to reject Windows because Windows as a standalone
remote brain is deferred; `ade doctor` does not yet discover an installed
Windows desktop version; and the Scheduled Task manager does not expose a
reliable service-main PID, so singleton ownership relies on the other
same-user/channel guards. Scheduled Task replacement is also retry-safe but
not transactional: a create/start failure after removing an existing task can
leave the brain stopped until installation is retried. None is required to
install and run the local Windows desktop preview, but each should be resolved
before calling Windows a first-class remote-brain/operations platform.

## Current readiness

| Area | Current state | Required work |
| --- | --- | --- |
| Electron/NSIS packaging | Required unsigned PR package job and signed release path are implemented | Clean-VM installer proof |
| Native dependencies | `win-unpacked` smoke loads ConPTY/provider payloads and performs a real `crsqlite.dll` CRR mutation | Repeat from an installed signed build |
| Projects, lanes, Git, files | Windows-aware paths, Git, and junction code exist | Clean-VM functional testing |
| Terminal/PTY | Structured Windows launch/resume, runtime-host materialization, and taskkill cleanup are implemented | Installed provider/ConPTY matrix |
| Background brain | Per-user/channel Scheduled Task launcher is implemented | Logoff/reboot/update/uninstall proof |
| Updater | Fork authority and fail-closed signing/publication gates are implemented | Signed N-to-N+1 installed test |
| Windows developer loop | Per-user runtime pipe, successful-build-gated Electron launch, hidden background probes, and owned-runtime cleanup are implemented and host-tested | Repeat from a clean clone |
| Sync/iPhone pairing | Intended to work | CRR roundtrip and firewall testing |
| Built-in browser/proof ingest | Mostly platform-neutral | Windows Hello, download, and security testing |
| Native computer use | macOS-only by design; capability-gated on Windows | Separate native Windows project |
| iOS Simulator/Xcode Preview | macOS-only and hidden on Windows | No Windows work required |
| Windows remote brain host | Explicitly rejected | Separate project |
| Windows ARM64 | Native payloads incomplete | Separate project |

The repository's own
[Windows port document](docs/development/windows-port-lane.md#already-in-this-branch-do-not-re-implement)
accurately lists the foundations, but its release claims are stale.

## Original release-blocking findings

The sections below preserve the static-evaluation rationale that shaped the
implementation. Each release-blocking source finding below has an
implementation on this branch; effective named-pipe access, clean-VM
Scheduled Task behavior, and signed-update behavior still require the
external proof gates above.

### 1. The scheduled background brain drops required environment variables

This is the most serious defect.

The service command carries `ELECTRON_RUN_AS_NODE=1`, `NODE_PATH`, channel, ADE
home, and runtime configuration in
[`common.ts`](apps/ade-cli/src/serviceManager/common.ts). However,
`renderWindowsCommand()` serializes only the executable and arguments.

The resulting task registers roughly:

```text
ADE.exe cli.cjs serve
```

without `ELECTRON_RUN_AS_NODE=1`. On a clean machine this can reopen the
Electron GUI instead of starting the CLI brain. Because ADE expects the service
to own the primary runtime pipe, this can leave the desktop without its normal
synchronized runtime.

The PR should install a dedicated service launcher or safely serialize all
required environment variables, then prove install, start, logoff/logon,
update, and uninstall on a clean machine without Node installed.

### 2. Scheduled tasks are not channel- or locale-safe

[`installWindows.ts`](apps/ade-cli/src/serviceManager/installWindows.ts) uses
the fixed name `ADE Runtime` for Stable, Beta, and Alpha, even though service
identities and ADE homes are channel-specific. Installing one channel can
overwrite another.

The status parser also searches for the English field `Status:`. It will
misreport task state on localized Windows installations.

Required changes:

- Use channel-qualified and preferably per-user task names.
- Query status through locale-independent Task Scheduler APIs, XML, or
  PowerShell objects.
- Add tests for local, Microsoft, and domain accounts.
- Explicitly document that the task runs only while the user is signed in,
  because `/IT` is currently used.

### 3. The Windows package cannot satisfy its own validator

The Windows validator requires Darwin and Linux x64/arm64 remote-runtime
sidecars in
[`validate-win-artifacts.mjs`](apps/desktop/scripts/validate-win-artifacts.mjs),
but [`package.json`](apps/desktop/package.json) copies only the Darwin
artifacts.

A re-enabled `dist:win` should therefore fail post-package validation.

The product decision is either:

- Include all four sidecar pairs so Windows can bootstrap existing macOS/Linux
  remote runtimes; or
- Reduce the Windows remote-bootstrap contract, gate the feature, and update
  the validator accordingly.

Including everything is simpler for a first preview but increases installer
size. On-demand, checksummed sidecar downloads would be cleaner later.

### 4. Provider resume and App Control commands still contain POSIX syntax

Fresh provider launches are mostly structured and Windows-aware. Resume and
fallback paths frequently generate shell strings instead.

Examples include OpenCode environment assignments and Droid resume commands in
[`cliLaunch.ts`](apps/desktop/src/shared/cliLaunch.ts). App Control's
package-script rewrite emits `PATH=<dir>:$PATH` and POSIX quoting in
[`appControlLaunchCommand.ts`](apps/desktop/src/main/services/appControl/appControlLaunchCommand.ts),
even though the command is later typed into PowerShell or cmd.

These paths will fail with some configurations and paths containing spaces,
quotes, `$`, `%`, `&`, or backticks.

The durable fix is a structured invocation contract:

```ts
{
  command,
  args,
  env,
  displayCommand,
}
```

Shell text should remain only for commands that genuinely require a shell,
with separate PowerShell and cmd quoting.

### 5. Windows named-pipe identity is not sufficiently isolated

The machine pipe name is derived only from the basename of ADE home in
[`machineLayout.ts`](apps/ade-cli/src/services/projects/machineLayout.ts). The
default `.ade` therefore produces the same global named-pipe name for every
Windows user.

The PR should derive pipe names from the canonical ADE home, channel, and
current user SID/hash, and verify that the pipe ACL is limited to the intended
user. Test two Windows users and Stable/Beta side by side.

### 6. Release and update configuration is disabled or points at upstream

The Windows build, download, validation, and upload blocks are commented out
in [`.github/workflows/release-core.yml`](.github/workflows/release-core.yml).
There is also no Windows runner in normal PR CI.

More importantly for this fork, the packaged updater is hardcoded to
`arul28/ADE` in:

- [`apps/desktop/package.json`](apps/desktop/package.json)
- [`apps/desktop/resources/app-update.yml`](apps/desktop/resources/app-update.yml)
- [`autoUpdateService.ts`](apps/desktop/src/main/services/updates/autoUpdateService.ts)

A Windows build published by `nsxdavid/ADE` would check upstream for updates,
where the corresponding Windows artifacts do not exist.

The distribution repository should be build metadata generated from
`github.repository`. The production `setFeedURL` override should be removed or
centralized. Electron-builder recommends using its generated `app-update.yml`;
its NSIS target already supports Windows auto-update and `latest.yml`
metadata. See the
[electron-builder auto-update documentation](https://www.electron.build/docs/features/auto-update/).

### 7. Public signing currently fails open

The existing configuration supports Authenticode, but missing secrets result
in an unsigned installer. The validator only checks signatures when an opt-in
flag is set.

Recommended policy:

- PR CI may build an unsigned artifact.
- Release CI must fail if signing is unavailable.
- Verify the installer and installed `ADE.exe`, publisher identity, and RFC
  3161 timestamp.
- Publish the installer, blockmap, and `latest.yml` atomically.
- Use Microsoft Artifact Signing or a stable organizational Authenticode
  certificate.

Electron-builder exposes `forceCodeSigning` specifically to prevent silently
unsigned production builds. See the
[electron-builder signing documentation](https://www.electron.build/docs/features/code-signing/).

Signing will not automatically eliminate every early SmartScreen prompt.
Microsoft notes that even valid OV/EV-signed applications can be classified as
unrecognized until publisher/file reputation develops; unsigned releases must
rebuild reputation for every version. See
[Microsoft's SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

## Product and UX work

The build PR should also include a focused platform pass:

- Make the Windows title bar explicit.
  [`main.ts`](apps/desktop/src/main/main.ts) unconditionally uses
  `hiddenInset`, macOS traffic-light positioning, and a renderer header with
  80 px of left padding. Verify caption buttons, dragging, double-click
  maximize, Snap Layouts, and DPI scaling.
- Hide or clearly disable iOS Simulator, Xcode Preview, native Notch, and local
  OS computer-use actions.
- Keep browser/App Control capture and proof-file ingestion enabled where
  supported.
- Replace visible "This Mac", "Reveal in Finder", `Command` key, and macOS
  Keychain wording with platform-aware labels. Preserve the internal
  `this-mac` identifier because it is a protocol/persistence invariant.
- Update the website.
  [`DownloadPage.tsx`](apps/web/src/app/pages/DownloadPage.tsx) currently says
  Windows installers are not published.
- Add Windows-specific microphone denial guidance; the current flow treats
  non-macOS access as automatically granted.
- Add a Windows sync-health surface. A missing or unloadable `crsqlite.dll`
  currently degrades sync primarily through logs.
- Test Windows Defender Firewall behavior for LAN phone pairing and provide
  actionable relay/Tailscale guidance.
- Add `setAppUserModelId` if packaged toast identity proves unreliable.

The supported OS floor should be Windows 10/11 x64. ADE uses Electron 41,
while Electron 23 and newer require Windows 10 or later. See
[Electron platform support](https://www.electronjs.org/docs/latest/breaking-changes).

## Recommended PR boundary

A reviewable first submission should be titled along the lines of
"Add Windows x64 preview build" and contain the following work.

### 1. Runtime correctness

- Fix the scheduled-task environment, channel naming, and locale-safe status.
- Use user/channel-scoped named pipes.
- Introduce structured provider resume commands.
- Fix App Control's Windows launch handling.
- Generate sync singleton recovery commands that do not suggest `launchctl`
  or `/bin/kill`.

### 2. Packaging and CI

- Resolve the remote-sidecar mismatch.
- Add `windows-latest` PR packaging and smoke validation.
- Load `crsqlite.dll` and perform a minimal CRR operation during packaged
  smoke.
- Probe the bundled CLI/TUI, PTY, and provider executables.
- Keep the target x64-only.

### 3. Release and updates

- Parameterize the fork's release authority.
- Restore the release/publish workflow.
- Fail closed on production signing.
- Add installed N-to-N+1 signed-update testing.

### 4. Platform UX and documentation

- Add an explicit Windows title bar and capability-driven navigation.
- Use neutral copy and platform-aware shortcuts.
- Add Windows download and analytics links.
- Correct stale architecture and Windows-port documentation.

Public download enablement should remain gated until the signed update test
passes. If certificate provisioning is not ready, the PR can still produce an
unsigned internal CI artifact while leaving public publishing disabled.

## Merge gates

At minimum:

- Test Windows 10 22H2 and Windows 11 x64 clean standard-user VMs.
- Install without Node or administrator rights.
- Verify first launch, app restart, logoff/logon, and uninstall/reinstall.
- Install Stable and Beta simultaneously.
- Open/create a project; create/delete a lane; exercise worktree, junction,
  commit, rebase, and conflict flows.
- Exercise PowerShell and cmd PTYs: Unicode, resize, Ctrl+C, cancellation, and
  child-tree cleanup.
- Test fresh launch and resume for Claude, Codex, Cursor, Droid, and OpenCode.
- Test paths and prompts containing spaces, Unicode, quotes, `$`, `%`, and
  `&`.
- Load packaged `crsqlite.dll` and complete a bidirectional Windows
  desktop-to-physical-iPhone CRR sync.
- Use the Windows desktop to control an existing macOS/Linux remote runtime.
- Exercise the built-in browser, downloads, proof ingest, and App Control CDP
  capture.
- Complete a signed NSIS N-to-N+1 update, including cache/retry/relaunch,
  scheduled-task repair, and data preservation.
- Test `ade://` cold/hot deep links, file associations, the PATH wrapper, and
  uninstall cleanup.
- Test DPI at 100/125/150/200 percent, multiple monitors, Snap Layouts, high
  contrast, and keyboard navigation.
- Reject a tampered or incorrectly signed update.

## Explicit follow-ups

These should not block the first Windows desktop build:

- Windows as a remotely installable ADE brain: an additional 2-4 weeks.
- Native Windows computer use using Windows Graphics Capture/UI Automation:
  approximately 6-12 or more weeks.
- Windows ARM64: approximately 2-4 weeks after all native/provider payloads
  are available.
- Windows resource telemetry and general orphan-agent recovery.

## Effort and confidence

- Credible internal/beta x64 PR: 2-4 engineer-weeks.
- First-class Windows x64 GA: 4-8 engineer-weeks total, plus signing-account
  lead time and dedicated QA.
- Largest uncertainty: installed, signed runtime behavior across clean Windows
  hosts and updates.

The initial assessment was a read-only static evaluation. Implementation and
targeted automated validation have since been completed on this branch.
A full local NSIS package still requires the CI-produced Darwin/Linux runtime
sidecars; the required Windows CI job materializes them before packaging.
No claim is made here that the external clean-VM or signed N → N+1 release
gates have passed.

## Automated validation observed

The source implementation was validated on Windows with:

- A bounded no-GUI lifecycle proof that started an isolated hidden runtime
  while this host's Tailscale service owned port 8787, connected over its
  named pipe, requested graceful shutdown, and confirmed that the pipe was
  released.
- Desktop typecheck, lint, build, documentation validation, web typecheck and
  build.
- The required Windows release contract, updater, packaging-smoke,
  CR-SQLite, ConPTY, App Control, microphone, window-chrome, preload, sync UI,
  provider-launch, and platform-copy focused suites.
- ADE CLI typecheck/build, 328 CLI tests, 59 service-manager tests, and 1,045
  TUI tests.
- `git diff --check`.

The legacy full test suites still contain Windows-host baseline failures in
POSIX-only fixtures, Unix-socket browser tests, chmod assertions, and several
SQLite teardown races. Focused Windows production-path tests are green, but
those baseline failures should be cleaned up in follow-up work so the entire
local suite is signal-bearing on Windows.
