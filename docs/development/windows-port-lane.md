# Windows port lane (desktop)

This worktree/branch exists to keep **ADE desktop** fully usable on **Windows** while `main` adds product features. Treat it as the integration lane for the Windows build: rebase it onto the latest `main` regularly, then run Windows-focused validation before shipping Windows installers.

## Current implementation boundary

The Windows x64 implementation is now wired end to end in source and CI:
local runtime service, user/channel-isolated named pipes, ConPTY/provider
resume, App Control launch, Windows chrome/capability gating, packaged
CR-SQLite proof, NSIS packaging, updater authority, and fail-closed signed
release gates. The pull-request build is intentionally an **unsigned internal
preview**. Public availability remains disabled until the external clean-VM
proof gates below pass.

Windows 10/11 x64 is the supported target. Windows ARM64, Windows as an
SSH-bootstrap remote brain target, native Windows OS computer use, and iOS
Simulator remain separate follow-ups.

## Keep this branch current with `main`

From this repo:

```bash
git fetch origin main
git rev-list --left-right --count HEAD...origin/main
```

- You want `0` commits on the right (nothing on `main` you do not have). If the second number is non-zero, rebase: `git rebase origin/main` and resolve conflicts (favor up-to-date main behavior, then re-apply Windows-specific fixes).

`origin/main` at the last lane update: **`677abd72`** (`docs: clarify shipLane token-idle waits`).

## Already in this branch (do not re-implement)

These are the foundations that should stay merged from this lane (see also `docs/ARCHITECTURE.md` §2.1 / §14.x):

| Area | What shipped |
| --- | --- |
| **CLI ↔ desktop IPC** | Runtime and desktop-bridge named pipes are hashed from canonical `ADE_HOME`, channel/service identity, and current-user identity (SID when available). Stable/Beta/Alpha and separate Windows accounts do not share endpoints. Servers explicitly use intended-user-only Node pipe flags; effective second-account denial remains a clean-VM gate. |
| **Background brain** | `installWindows.ts` owns a per-user, per-channel `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run` entry. A BOM-marked PowerShell supervisor restores the resolved brain environment, verifies process identity and runtime readiness on the expected named pipe, restarts crashes with bounded backoff, and records actionable diagnostics. Scheduled Tasks are legacy cleanup only. |
| **Child processes** | `processExecution` — `cmd`/`bat` via `ComSpec`, `windowsVerbatimArguments`, `taskkill` for trees. Both `resolveWindowsCmdInvocation` (argv form) and `resolveWindowsCmdLineInvocation` (pre-built command-string form) wrap a single outer `cmd.exe /d /s /c "…"` so embedded `&&` chains don't break out of quoting. Long-running children that previously called `child.kill("SIGKILL")` (git, automation runs) now route through `terminateProcessTree` so taskkill cleans up Windows process groups. |
| **PATH for CLIs** | `augmentProcessPathWithShellAndKnownCliDirs` has an explicit `win32` path (no POSIX `sh -ic`). |
| **PTY/providers** | `ptyService` supports no-profile Windows PowerShell 5.1/7, cmd, and Git Bash. Provider launch/resume materializes structured command, argv, environment, and recovery metadata on the lane-owning runtime, with ConPTY resize, cancellation, and descendant cleanup. |
| **App Control** | Recognized direct Electron and package-script launches become structured Windows command/argv/env/cwd descriptors. Shell fallbacks emit PowerShell/cmd syntax instead of POSIX environment syntax; macOS/Linux behavior remains unchanged. |
| **Renderer paths** | `pathUtils` — drive letters, `\`, UNC, comparison helpers for workspace UI. |
| **Native + sync** | `vendor/crsqlite/win32-x64`, `node-pty` Windows prebuild, packaged runtime hooks. The required `win-unpacked` smoke loads `crsqlite.dll`, marks a table CRR, writes a row, and requires a `crsql_changes` record. Runtime capability is exposed as `crdtSyncAvailable`; Connections blocks pairing and shows reinstall/restart guidance if unavailable. |
| **Desktop UX** | Windows uses a hidden title bar with native window overlay/caption controls and an explicit AppUserModelID. iOS Simulator and macOS Attention Notch controls are hidden; persisted iOS sidebar state falls back to Git. App Control, built-in Browser, and proof ingestion remain available. Visible local-machine/Finder/Command-key copy is platform-neutral or platform-aware. |
| **Installers** | The assisted NSIS installer is explicitly per-user and non-elevating. Its custom install step repairs the channel-aware CLI shim, current-user `PATH`, and brain startup registration; uninstall removes only the terminal shim, PATH/protocol/association/startup state owned by that installation. Stable/Beta/Alpha use distinct executable, app, and shim names. Windows packages carry all Darwin/Linux remote-runtime sidecars. Electron-builder owns `app-update.yml`; CI binds it to `${{ github.repository }}` and package smoke verifies the authority. |
| **Standalone brain** | Releases build `ade-win32-x64.exe` plus a native dependency archive and checksum them with all other runtime artifacts. `install.ps1` stages and verifies both, installs the current-user PATH/service, and rolls back on failure. `ade brain start/status/doctor/update` support Windows; self-update stops the running executable before replacement and restores the previous runtime/service on failure. |
| **Remote SSH runtime** | Windows 10 22H2 and Windows 11 x64 are native SSH-bootstrap targets through Windows OpenSSH Server. Bootstrap uses encoded PowerShell plus JSON stdin, verified SFTP uploads for `ade-win32-x64.exe`, native dependencies, the PTY worker, and agent skills, then launches the channel-specific named-pipe runtime through `ade rpc --stdio`. PowerShell 5.1+ and `tar.exe` are prerequisites; WSL, ARM64, and Windows Server remain excluded from Windows v1. |
| **CI/release** | `ci.yml` has a required `windows-latest` package job that builds and smokes an unsigned preview, including installed-product lifecycle checks. With publication disabled, `release-core.yml` uses only the canonical `WINDOWS_*` signing contract to build one signed proof artifact containing the desktop and standalone runtime, requires a trusted RFC3161 timestamp and pinned identity, and fails closed. Public release retrieves that immutable artifact and verifies its run id, manifest digest, tag, exact source SHA, checksums, and installed-update approval rather than rebuilding. Disabled Windows publication never blocks the macOS release path. |
| **Sync / Tailscale** | `resolveTailscaleCliPath` (shared): macOS bundle, Windows `Program Files`\\Tailscale, then `PATH`. |

## Mainline feature areas to smoke-test on Windows after each rebase

Recent `main` work that is **not** inherently macOS-only but can surface path/shell/IPC issues on Windows. After pulling `main`, run through these in a **Windows** dev or packaged build:

1. **Lanes + git** — worktrees, rebase/merge conflict flows, `LaneGitActionsPane` actions (Rebase tab rename + routing landed in #180: confirm deep links and navigation from lane views).
2. **Terminals** — new tab/session flows, WebGL → DOM fallback, session resume, resize/fit, parked runtimes (covered by `TerminalView` but behavior differs on ConPTY).
3. **Work grid + chat** — #181 layout changes; check keyboard shortcuts and split panes.
4. **Multi-model + identity** — multi-model prompt lanes (#184), single desktop device id / identity policy; confirm settings and session startup do not assume Unix paths.
5. **Sync / pairing** — iOS-style sync still targets a desktop **host**; on Windows, verify WebSocket + cr-sqlite load and that pairing PIN flows work. Tailscale: `resolveTailscaleCliPath` checks default `Program Files` installs, then `tailscale` on `PATH`, or `ADE_TAILSCALE_CLI` for custom paths.
6. **Usage / agent CLIs** — Codex/Claude spawns and `gh` token fallback: confirm packaged app finds tools on a typical Windows `PATH` (relaunch from Start Menu after `PATH` changes).
7. **Finalize** — `/finalize` phase 3j-style worker cleanup should use shared process termination (`terminateProcessTree` / Windows branch).

## Intentionally not Windows-complete (product reality)

- **Local computer use** (screenshot, video, Apple GUI automation) remains **macOS-first**; other platforms are `blocked_by_capability` by design — do not block the Windows port on this.
- **Windows OS control** — App Control/CDP and proof ingestion work; native
  Windows Graphics Capture/UI Automation is not implemented.
- **iOS Simulator / Attention Notch** — hidden on Windows by capability. These
  remain macOS-only product surfaces.
- **Releases** — pull-request CI may publish an unsigned Windows preview artifact for internal testing. Release builds fail unless the installer, packaged app, and standalone runtime are Authenticode signed, timestamped, and match the pinned publisher subject; the installer and packaged app must also share one certificate. Signing runs on Azure Artifact Signing, whose certificate rotates daily, so the pin is the certificate Subject and thumbprint pinning is refused outright. Windows builds fresh on the release tag behind the single `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` gate; disabled Windows publication does not block the macOS release path. SmartScreen reputation remains a release-engineering concern, not only app code.
- **Windows as an SSH-bootstrap target** — local standalone install and `ade brain update` are implemented, and desktop remote bootstrap now detects and uploads native Windows targets alongside macOS/Linux. A Windows client can bootstrap those targets and reports actionable OpenSSH Client prerequisite diagnostics. HKCU startup-entry replacement is retry-safe but not transactional; Scheduled Tasks are legacy cleanup only.
- **Docs in `AGENTS.md`** still emphasize macOS Codex/Computer Use; Windows developers should use this file + `docs/ARCHITECTURE.md` for WSL/VM dev notes if applicable.

## External proof gates before public availability

The implementation and automated contract tests do not replace installed-host
verification. Complete these before enabling the public website/release flags:

1. **Clean standard-user hosts** — install/uninstall/reinstall on Windows 10
   22H2 and Windows 11 x64 with no global Node; verify first launch, Start Menu
   relaunch, repair, `ade brain start/status/doctor/update`, logoff/logon brain
   recovery, deep links/file associations, and no orphaned legacy task/launcher.
2. **Channel/user isolation** — run Stable and Beta side by side and verify
   separate HKCU Run values, ADE homes, runtime/desktop-bridge pipes, and project state;
   repeat with a second Windows account.
3. **Provider/PTY matrix** — fresh launch and resume for Claude, Codex, Cursor,
   Droid, and OpenCode in PowerShell 5.1, PowerShell 7, cmd, and Git Bash, including Unicode and paths or
   prompts containing spaces, quotes, `$`, `%`, `&`, and backticks. Exercise
   authenticated/unauthenticated state, resize, Ctrl+C, cancellation, child-tree cleanup, crash restore, recovery metadata/instructions, and redaction.
4. **Sync and firewall** — pair a physical iPhone, prove bidirectional CRR
   changes, verify Windows Defender Firewall behavior on LAN, then exercise
   Tailscale/Relay fallback. For a non-default Tailscale install, set
   `ADE_TAILSCALE_CLI` explicitly.
5. **Remote/runtime and UI** — bootstrap supported macOS/Linux remote runtimes
   from the Windows package; exercise lanes/git/files/browser/App Control,
   deep links, file associations, DPI 100–200%, Snap Layouts, multiple
   monitors, high contrast, and keyboard navigation.
6. **Signed installer** — verify the installer and installed app use the approved
   publisher, then install, relaunch, log off/on, uninstall, and reinstall.
   Provision signing credentials and monitor SmartScreen reputation. Before publication, use two unpublished signed versions to prove N to N+1 update, timestamp/signature validation, tamper rejection, desktop relaunch, brain recovery, and data preservation.
7. **Proof and public gates** — run `prepare-release.yml` with `windows_proof=true` to produce a non-publishing signed build and its evidence bundle while `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` is unset or `0` and `VITE_ADE_WINDOWS_DOWNLOAD_ENABLED` is unset or `0`. Complete the exact-SHA inventory, including the private signed N to N+1 update and standalone runtime. That sweep is the recommended pre-enablement validation, not a pipeline gate: once `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1`, every tag builds and publishes Windows on its own. Inspect the assembled unpublished draft before publication. Enable the website only after that same release is public and verified.

The machine-readable scenario inventory and evidence rules are in
[Windows release proof](./windows-release-proof.md). The complete maintainer
procedure is [Windows signed release and publication](../playbooks/windows-signed-release.md),
and installed-host diagnosis is in [Windows support](./windows-support.md).

## Suggested validation commands (from repo root)

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run test:win:release-contract
npm --prefix apps/desktop run test -- --run src/main/windowAppearance.test.ts src/main/services/transcription/microphoneAccess.test.ts src/main/services/appControl/appControlService.test.ts src/main/services/pty/ptyService.test.ts src/main/services/updates/autoUpdateService.test.ts
npm --prefix apps/ade-cli run test -- --run src/serviceManager/common.test.ts src/services/projects/machineLayout.test.ts src/services/sync/syncHostSingleton.test.ts
npm --prefix apps/desktop run build
```

For a full desktop gate before merging this lane: follow `AGENTS.md` (typecheck, test, build, lint) with emphasis on the touched areas above.
