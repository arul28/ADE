# Windows desktop: implementation map and smoke checklist

DAEX ships a signed Windows 10/11 x64 desktop with every release. This file maps
the Windows-specific foundations (so nobody re-implements them) and lists what
to smoke-test on Windows after a change. User-facing gaps and troubleshooting
are in [windows-support.md](./windows-support.md); release procedure is in
[Windows signed release](../playbooks/windows-signed-release.md).

Out of scope: Windows ARM64, the iOS Simulator, and WSL, ARM64 or Windows Server
as SSH-bootstrap targets.

## Foundations (do not re-implement)

| Area | What exists |
| --- | --- |
| **CLI and desktop IPC** | Runtime and desktop-bridge named pipes are hashed from the canonical home, channel/service identity and the owning account (see windows-support.md). Stable, Alpha and separate Windows accounts never share endpoints. Servers use intended-user-only pipe flags. |
| **Background brain** | `apps/ade-cli/src/serviceManager/installWindows.ts` owns a per-user, per-channel `HKCU\...\Run` entry and a hidden PowerShell supervisor (`windowsSupervisor.ts`) that verifies process identity and pipe readiness, restarts crashes with bounded backoff, and runs the wedge watchdog. Scheduled Tasks are legacy cleanup only. |
| **Child processes** | `apps/desktop/src/main/services/shared/processExecution.ts`: `cmd`/`bat` via `ComSpec`, `windowsVerbatimArguments`. `resolveWindowsCmdInvocation` (argv) and `resolveWindowsCmdLineInvocation` (command string) wrap one outer `cmd.exe /d /s /c "..."` so embedded `&&` chains stay quoted. Tree kills go through `terminateProcessTree` (taskkill on Windows, the process group on POSIX). Do not "fix" a POSIX path back to signalling a single pid: the Claude subprocess reaper spawns `detached` and signals the group so its MCP children die too. |
| **PATH for CLIs** | `augmentProcessPathWithShellAndKnownCliDirs` has an explicit `win32` path (no POSIX `sh -ic`). |
| **PTY and providers** | `ptyService` supports Windows PowerShell 5.1, PowerShell 7, cmd and Git Bash with no profile. Provider launch and resume materialize command, argv, environment and recovery metadata on the lane-owning runtime, with ConPTY resize, cancellation and descendant cleanup. |
| **App Control** | Direct Electron and package-script launches become structured Windows command/argv/env/cwd descriptors; shell fallbacks emit PowerShell/cmd syntax. |
| **Renderer paths** | `pathUtils`: drive letters, `\`, UNC, comparison helpers. |
| **Native and sync** | `apps/desktop/vendor/crsqlite/win32-x64`, the `node-pty` Windows prebuild, packaged runtime hooks. The `win-unpacked` smoke loads `crsqlite.dll`, marks a table CRR, writes a row and requires a `crsql_changes` record. `crdtSyncAvailable` false blocks pairing with reinstall guidance. |
| **Desktop UX** | Hidden title bar with native caption controls and an explicit AppUserModelID. iOS Simulator controls are hidden. |
| **Installers** | The assisted NSIS installer is per-user and never elevates. Its custom step repairs the channel-aware CLI shim, user `PATH` and brain startup entry (`apps/desktop/build/installer.nsh`, `apps/desktop/scripts/windows-install-setup.ps1`); uninstall removes only state it owns. Windows packages carry the Darwin/Linux remote-runtime sidecars. CI binds `app-update.yml` to `${{ github.repository }}`. |
| **Standalone brain** | Releases build `ade-win32-x64.exe` plus a native archive, checksummed with the other runtime artifacts. `install.ps1` stages, verifies, installs PATH and service, and rolls back on failure. `daex brain update` stops the running executable before replacing it and restores on failure. |
| **Remote SSH runtime** | Windows 10 22H2 and Windows 11 x64 are SSH-bootstrap targets through Windows OpenSSH Server: encoded PowerShell plus JSON stdin, verified SFTP uploads, then the channel's named-pipe runtime through `daex rpc --stdio`. |
| **Windows OS control** | Windows Desktop (`daex screen`): a private RDP child session per PC plus a consent-gated shared seat, driven by `ade-desktop-driver.exe` (UI Automation, `SendInput`, `PostMessage`, PrintWindow/BitBlt). See [Windows Desktop](../features/windows-desktop/README.md). |
| **CI and release** | `ci.yml`'s `windows-foundation` matrix (every push to main; on a PR only with the `windows` label) runs the native filesystem, process, IPC, SQLite and capability tests. `release-core.yml` signs the installer, packaged app and standalone runtime on Azure Artifact Signing behind `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED`. |
| **Tailscale** | `resolveTailscaleCliPath` (`apps/ade-cli/src/services/sync/`): Program Files, then `PATH`, or `ADE_TAILSCALE_CLI`. |

The local computer-use fallback (screenshot, video, Apple GUI) stays macOS-only;
other platforms report `blocked_by_capability`.

## Smoke-test on Windows after a change

Run these in a Windows dev or packaged build when a change touches paths,
shells, processes or IPC:

1. **Lanes and git:** worktrees, rebase and merge-conflict flows, lane git
   actions.
2. **Terminals:** new sessions, WebGL to DOM fallback, resume, resize, parked
   runtimes (ConPTY behaves differently).
3. **Work grid and chat:** keyboard shortcuts (non-Mac defaults in
   `shared/keybindings.ts`) and split panes.
4. **Sync and pairing:** WebSocket and CR-SQLite load, pairing PIN, Tailscale.
5. **Agent CLIs:** Codex and Claude spawns and the `gh` token fallback find tools
   on a typical Windows `PATH` (relaunch from the Start Menu after `PATH`
   changes).
6. **Process cleanup:** worker cleanup goes through `terminateProcessTree`.

For a full installed-host pass (clean standard-user hosts, channel and user
isolation, the provider/PTY matrix, firewall, DPI and multi-monitor, signed N to
N+1 update), use the scenario inventory in
[windows-release-proof.md](./windows-release-proof.md).

## Validation commands (from repo root)

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run test:win:release-contract
npm --prefix apps/desktop run test -- --run src/main/services/transcription/microphoneAccess.test.ts src/main/services/appControl/appControlService.test.ts src/main/services/pty/ptyService.test.ts src/main/services/updates/autoUpdateService.test.ts src/main/services/shared/treeWatcher.test.ts src/main/services/ai/cliExecutableResolver.test.ts
npm --prefix apps/ade-cli run test -- --run src/serviceManager/common.test.ts src/services/projects/machineLayout.test.ts src/services/sync/syncHostSingleton.test.ts
```

Follow "Running checks" in `AGENTS.md`: one check pass at the end, not after each
edit.
