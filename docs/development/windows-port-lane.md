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
| **Background brain** | `installWindows.ts` installs a per-user/channel `ONLOGON` Scheduled Task. A BOM-marked PowerShell launcher restores the full resolved brain env (`ELECTRON_RUN_AS_NODE`, `NODE_PATH`, ADE paths/channel/role), preserves CRT argv quoting, and runs hidden. Status reads `Get-ScheduledTask` objects, so it is locale-independent; install/uninstall removes the exact legacy `ADE Runtime` task and fails closed on cleanup errors. |
| **Child processes** | `processExecution` — `cmd`/`bat` via `ComSpec`, `windowsVerbatimArguments`, `taskkill` for trees. Both `resolveWindowsCmdInvocation` (argv form) and `resolveWindowsCmdLineInvocation` (pre-built command-string form) wrap a single outer `cmd.exe /d /s /c "…"` so embedded `&&` chains don't break out of quoting. Long-running children that previously called `child.kill("SIGKILL")` (git, automation runs) now route through `terminateProcessTree` so taskkill cleans up Windows process groups. |
| **PATH for CLIs** | `augmentProcessPathWithShellAndKnownCliDirs` has an explicit `win32` path (no POSIX `sh -ic`). |
| **PTY/providers** | `ptyService` picks no-profile PowerShell / `cmd.exe` for clean shells. Fresh provider intent is materialized on the lane-owning runtime, preventing a Windows client from sending its shell or skill paths to macOS/Linux. Tracked continuation consumes structured `{ command, args, env }` descriptors on Windows; OpenCode replay keeps permission policy in env, while Droid uses an explicit PowerShell wrapper with BOM-free UTF-8 temporary settings. |
| **App Control** | Recognized direct Electron and package-script launches become structured Windows command/argv/env/cwd descriptors. Shell fallbacks emit PowerShell/cmd syntax instead of POSIX `PATH=...:$PATH`; macOS/Linux shell behavior remains unchanged. |
| **Renderer paths** | `pathUtils` — drive letters, `\`, UNC, comparison helpers for workspace UI. |
| **Native + sync** | `vendor/crsqlite/win32-x64`, `node-pty` Windows prebuild, packaged runtime hooks. The required `win-unpacked` smoke loads `crsqlite.dll`, marks a table CRR, writes a row, and requires a `crsql_changes` record. Runtime capability is exposed as `crdtSyncAvailable`; Connections blocks pairing and shows reinstall/restart guidance if unavailable. |
| **Desktop UX** | Windows uses a hidden title bar with native window overlay/caption controls and an explicit AppUserModelID. iOS Simulator and macOS Attention Notch controls are hidden; persisted iOS sidebar state falls back to Git. App Control, built-in Browser, and proof ingestion remain available. Visible local-machine/Finder/Command-key copy is platform-neutral or platform-aware. |
| **Installers** | `ade-cli-windows-wrapper.cmd`, `ade-cli-install-path.cmd` (updates the user `Environment\Path` registry value and broadcasts `WM_SETTINGCHANGE`), `npm run dist:win` for unsigned pull-request previews, and `npm run dist:win:signed` for production. Windows packages carry all Darwin/Linux remote-runtime sidecars. Electron-builder owns `app-update.yml`; CI binds it to `${{ github.repository }}` and package smoke verifies the authority. |
| **CI/release** | `ci.yml` has a required `windows-latest` package job that builds and smokes an unsigned preview. `release-core.yml` enables the signed job only with `ADE_WINDOWS_SIGNED_BUILD_ENABLED=1`; it requires Authenticode credentials plus a pinned subject/thumbprint, requires a trusted RFC3161 timestamp and one signer for installer + app, and fails closed. Draft release upload additionally requires `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1`; a skipped Windows job does not block macOS release publication. |
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
- **Releases** — pull-request CI may publish an unsigned Windows preview artifact for internal testing. When `ADE_WINDOWS_SIGNED_BUILD_ENABLED=1`, `release-core.yml` fails closed unless the `exe` and packaged app are Authenticode signed, timestamped, share one certificate, and match `WINDOWS_SIGNING_EXPECTED_SUBJECT` or `WINDOWS_SIGNING_EXPECTED_THUMBPRINT`; otherwise the Windows job is skipped without blocking the macOS release. SmartScreen reputation remains a release-engineering concern, not only app code.
- **Standalone Windows brain operations** — `ade brain update` remains
  macOS/Linux-only because a remotely installable Windows brain is deferred.
  `ade doctor` installed-desktop discovery and a reliable Scheduled Task main
  PID are follow-up operational parity work. Scheduled Task replacement is
  retry-safe but not transactional: a create/start failure after removing an
  existing task can leave the brain stopped until installation is retried.
- **Docs in `AGENTS.md`** still emphasize macOS Codex/Computer Use; Windows developers should use this file + `docs/ARCHITECTURE.md` for WSL/VM dev notes if applicable.

## External proof gates before public availability

The implementation and automated contract tests do not replace installed-host
verification. Complete these before enabling the public website/release flags:

1. **Clean standard-user hosts** — install/uninstall/reinstall on Windows 10
   22H2 and Windows 11 x64 with no global Node; verify first launch, Start Menu
   relaunch, logoff/logon brain recovery, and no orphaned legacy task/launcher.
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
6. **Signed update** — install signed N, update to N+1, relaunch, verify the
   Scheduled Task uses the new runtime and data is preserved, then reject a
   tampered or wrong-publisher artifact. Provision signing credentials and
   monitor SmartScreen reputation.
7. **Public gates** — only after the signed update proof passes, enable
   `ADE_WINDOWS_SIGNED_BUILD_ENABLED=1`,
   `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1`, and website build flag
   `VITE_ADE_WINDOWS_DOWNLOAD_ENABLED=1`.

## Suggested validation commands (from repo root)

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run test:win:release-contract
npm --prefix apps/desktop run test -- --run src/main/windowAppearance.test.ts src/main/services/transcription/microphoneAccess.test.ts src/main/services/appControl/appControlService.test.ts src/main/services/pty/ptyService.test.ts src/main/services/updates/autoUpdateService.test.ts
npm --prefix apps/ade-cli run test -- --run src/serviceManager/common.test.ts src/services/projects/machineLayout.test.ts src/services/sync/syncHostSingleton.test.ts
npm --prefix apps/desktop run build
```

For a full desktop gate before merging this lane: follow `AGENTS.md` (typecheck, test, build, lint) with emphasis on the touched areas above.
