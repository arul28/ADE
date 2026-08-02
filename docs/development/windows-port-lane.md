# Windows port lane (desktop)

This worktree/branch exists to keep **ADE desktop** fully usable on **Windows** while `main` adds product features. Treat it as the integration lane for the Windows build: rebase it onto the latest `main` regularly, then run Windows-focused validation before shipping Windows installers.

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
| **CI/release** | `ci.yml` has a required `windows-latest` package job that builds and smokes an unsigned preview, including fresh install, repair, reinstall, PATH/startup/deep-link/file-association ownership, and uninstall. `release-core.yml` enables the signed job only with `ADE_WINDOWS_SIGNED_BUILD_ENABLED=1`; the Windows signing-secret contract is exactly `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`, `WINDOWS_SIGNING_EXPECTED_SUBJECT`, and `WINDOWS_SIGNING_EXPECTED_THUMBPRINT`, with a trusted RFC3161 timestamp and the approved identity required for the installer, installed app, and standalone runtime (thumbprint equality is enforced whenever a thumbprint is configured). The non-publishing run retains a checksum-covered standalone proof bundle for offline clean-host installation. While public Windows publication is disabled, a failed or skipped signed Windows test build cannot block the existing macOS release. Public Windows assets additionally require both `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1` and `ADE_WINDOWS_INSTALLED_UPDATE_PROOF_APPROVED=1`; the latter attests to the mandatory clean-host, two-unpublished-version signed N-to-N+1 updater proof. |
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
- **Releases** — pull-request CI may publish an unsigned Windows preview artifact for internal testing. With `ADE_WINDOWS_SIGNED_BUILD_ENABLED=1`, `release-core.yml` fails the Windows jobs unless the installer, packaged app, and standalone runtime are Authenticode signed, timestamped, and match `WINDOWS_SIGNING_EXPECTED_SUBJECT` or `WINDOWS_SIGNING_EXPECTED_THUMBPRINT`; the installer and packaged app must also share one certificate. That test job cannot block macOS publication while public Windows publication is disabled. SmartScreen reputation remains a release-engineering concern, not only app code.
- **Docs in `AGENTS.md`** still emphasize macOS Codex/Computer Use; Windows developers should use this file + `docs/ARCHITECTURE.md` for WSL/VM dev notes if applicable.

## Engineering backlog (complete the “parity” bar)

Do these to move from “runs on Windows” to “first-class for Windows users”:

1. **Clean standard-user hosts** — install/uninstall/reinstall on Windows 10
   22H2 and Windows 11 x64 with no global Node; verify first launch, Start Menu
   relaunch, repair, `ade brain start/status/doctor/update`, logoff/logon brain
   recovery, deep links/file associations, and no orphaned legacy task/launcher.
2. **Channel/user isolation** — run Stable and Beta side by side and verify
   separate tasks, ADE homes, runtime/desktop-bridge pipes, and project state;
   repeat with a second Windows account.
3. **Provider/PTY matrix** — fresh launch and resume for Claude, Codex, Cursor,
   Droid, and OpenCode in PowerShell and cmd, including Unicode and paths or
   prompts containing spaces, quotes, `$`, `%`, `&`, and backticks. Exercise
   resize, Ctrl+C, cancellation, and child-tree cleanup.
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
   Provision signing credentials and monitor SmartScreen reputation. Before
   publication, use two unpublished signed versions to prove N to N+1 update,
   timestamp/signature validation, tamper rejection, desktop relaunch and brain
   recovery, and data preservation.
7. **Public gates** — enable `ADE_WINDOWS_SIGNED_BUILD_ENABLED=1` to produce
   signed test builds. Keep `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=0` and the website
   flag disabled until the signed installer, signed standalone runtime, and
   mandatory two-version update proof pass. The PowerShell installer, Windows
   runtime executable, and native archive remain outside release drafts until
   the public-release and installed-update-proof gates are both enabled. Only
   then may a maintainer enable public release and website flags.

The cumulative release-proof layer adds the complete Windows signed-release
and publication procedure before this stack can be considered ready.

## Suggested validation commands (from repo root)

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run test -- --run apps/desktop/src/renderer/lib/pathUtils.test.ts apps/desktop/src/main/services/shared/processExecution.test.ts
npm --prefix apps/desktop run build
```

For a full desktop gate before merging this lane: follow `AGENTS.md` (typecheck, test, build, lint) with emphasis on the touched areas above.
