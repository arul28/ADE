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
| **CLI ↔ desktop IPC** | Windows named-pipe path next to the Unix socket model (`adeMcpIpc.*`). |
| **Child processes** | `processExecution` — `cmd`/`bat` via `ComSpec`, `windowsVerbatimArguments`, `taskkill` for trees. |
| **PATH for CLIs** | `augmentProcessPathWithShellAndKnownCliDirs` has an explicit `win32` path (no POSIX `sh -ic`). |
| **PTY** | `ptyService` picks `powershell.exe` / `cmd.exe` on Windows. |
| **Renderer paths** | `pathUtils` — drive letters, `\`, UNC, comparison helpers for workspace UI. |
| **Native** | `vendor/crsqlite/win32-x64`, `node-pty` Windows prebuild, packaged runtime hooks. |
| **Installers** | `ade-cli-windows-wrapper.cmd`, `npm run dist:win`, `release-core.yml` `build-win-release` job. |
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
- **Releases** — `release-core.yml` builds a Windows `exe`; Authenticode signing is supported when credentials are configured, but unsigned Windows release artifacts are allowed for now. SmartScreen reputation is still a release-engineering concern, not only app code.
- **Docs in `AGENTS.md`** still emphasize macOS Codex/Computer Use; Windows developers should use this file + `docs/ARCHITECTURE.md` for WSL/VM dev notes if applicable.

## Engineering backlog (complete the “parity” bar)

Do these to move from “runs on Windows” to “first-class for Windows users”:

1. **Rebase hygiene** — whenever `main` adds desktop surfaces, re-run the smoke list above; add Vitest cases under `pathUtils` / `processExecution` if new path or spawn patterns appear.
2. **Non-default Tailscale installs** — if the binary is not under standard `Program Files` locations and not on `PATH`, set `ADE_TAILSCALE_CLI` to the full `tailscale.exe` path.
3. **Code signing reputation** — wire Authenticode credentials in CI when ready and monitor SmartScreen reputation; keep `latest.yml` + `exe.blockmap` flow as today.
4. **Download + updates** — ensure the web download page and auto-update story include Windows; verify `autoUpdateService` for Windows channel if applicable.

## Suggested validation commands (from repo root)

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run test -- --run apps/desktop/src/renderer/lib/pathUtils.test.ts apps/desktop/src/main/services/shared/processExecution.test.ts
npm --prefix apps/desktop run build
```

For a full desktop gate before merging this lane: follow `AGENTS.md` (typecheck, test, build, lint) with emphasis on the touched areas above.
