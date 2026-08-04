# Windows Quirks

The Windows failure modes ADE has actually hit, with the in-repo fix for each.
Referenced by `/quality`, `/test`, `/ship`, `/audit`, `/plan`, `/finalize`, and
`/optimize` so the list lives in one place.

Use it two ways: while writing new code, to pick the right primitive the first
time; while reviewing, to check the diff against the class. Every entry is
**quirk → failure → what to do instead**. Named helpers are the canonical
answer — a hand-rolled equivalent in a new file is a finding.

Background: `WINDOWS_PORT.md` (root), `docs/development/windows-support.md`,
`docs/development/windows-port-lane.md`,
`docs/development/windows-release-proof.md`.

---

## 1. Paths are case-insensitive; `===` and `startsWith` are not

**Failure.** `path.resolve` returns `C:\Users\...` while an external tool wrote
`c:\users\...` into its own state file, and the two never compare equal — a lock
is skipped, a legacy file is not deleted, a workspace lookup misses. Separately,
a bare `startsWith` says `C:\project-old` lives inside `C:\project`.

**Do instead.** Main process: `pathKey` / `pathComparisonKey` / `pathsEqual` /
`isPathInside` from `apps/desktop/src/main/services/shared/pathCompare.ts`.
Renderer: `normalizePathForComparison` / `arePathsEqual` /
`isPathEqualOrDescendant` from `apps/desktop/src/renderer/lib/pathUtils.ts` — it
keys folding off the path *shape*, because the renderer has no reliable
platform. Folding applies on `win32` and `darwin`; Linux stays case-sensitive,
so never lowercase unconditionally.

`apps/ade-cli/src/services/credentials/credentialStore.ts` still compares with
`path.resolve(left) === path.resolve(right)`; ade-cli does not import
`pathCompare`. Do not copy that shape into new CLI code.

## 2. Separators, drive letters, UNC roots

**Failure.** Mixed `/` and `\` in one string, `/C:/...` arriving from URL-ish
sources, `..` escaping a `//server/share` root, and 8.3 short names or junction
casing making two spellings of one directory.

**Do instead.** Normalize `/` → `\` before resolving (`pathCompare.ts` does).
Use `isWindowsDrivePath`, `isWindowsUncPath`, `isWindowsAbsolutePath`, and
`splitNormalizedPath` from `renderer/lib/pathUtils.ts` — `splitNormalizedPath`
treats a UNC share as an indivisible root. For a path that must match what the
OS reports, use `canonicalWindowsPath()` in
`apps/ade-cli/src/services/projects/machineLayout.ts` (walks to the deepest
existing ancestor via `fs.realpathSync.native`, then re-joins the tail).

## 3. `taskkill` exit 0 does not prove a kill; process trees leak

**Failure.** Windows has no process groups — `process.kill(-pid)` does not
exist, and `child.kill()` is `TerminateProcess` on the leader alone, so
descendants survive. `taskkill` without `/F` asks each window to close, so a
windowless console process reports exit 128 ("no running instance") while its
children run on. Exit 0 means the kill was *dispatched*. Windows also recycles
PIDs fast, so a late `taskkill /T /F` can hit an unrelated process.

**Do instead.** Route every long-lived child through `terminateProcessTree` /
`killWindowsProcessTree` in
`apps/desktop/src/main/services/shared/processExecution.ts`, or
`signalChildProcessTree` / `terminateChildProcessTree` in
`services/shared/utils.ts`. On Windows both run `taskkill /T /F` **and**
`child.kill()`, and both refuse a child that already reported a non-null
`exitCode` / `signalCode` — that check is the PID-reuse guard, not an
optimization, so pass the live child object, not a `{ pid }` snapshot. A handle
missing those fields is treated as *not tracked* and is still killed: reading an
absent field as "already exited" would silently leak the whole tree, which is
the worse of the two failures. You lose the PID-reuse protection, not the kill.
`signalChildProcessTree` applies the guard on
every platform; `terminateProcessTree` applies it on the win32 branch, where the
`taskkill` hazard lives. For ConPTY, kill the tree *before* node-pty kills the
leader (`services/pty/ptyService.ts`); afterwards `taskkill /PID <leader> /T`
can no longer discover the orphans.

Related: pass `windowsHide: true` on **every** `spawn` / `spawnSync` /
`execFile`, including short status polls. Omitting it caused the host-loss
incident in `WINDOWS_PORT.md` — visible PowerShell console windows piling up and
outliving the Electron window. Resolve system tools by absolute System32 path
via `apps/ade-cli/src/lib/trustedWindowsTools.ts` (`powershell`, `reg`,
`schtasks`, `taskkill`) so a poisoned PATH cannot hijack the kill.

## 4. No `LSEnvironment` equivalent — an installed app inherits nothing

**Failure.** macOS injects `ADE_PACKAGE_CHANNEL`, `ADE_DESKTOP_APP_NAME`, and
`ADE_HOME` through `LSEnvironment` in Info.plist (`scripts/package-channel.mjs`).
Windows has no such hook. The original startup registration serialized only
exe + args and dropped `ELECTRON_RUN_AS_NODE=1` — and because the same `ADE.exe`
is both GUI and CLI on Windows, losing that variable silently reopened the GUI
instead of starting the CLI brain.

**Do instead.** Env for the installed app is carried by the generated PowerShell
launcher: `renderWindowsServiceLauncher()` in
`apps/ade-cli/src/serviceManager/windowsSupervisor.ts` emits one
`[System.Environment]::SetEnvironmentVariable(...,'Process')` per variable
through `powerShellSingleQuotedLiteral()`; `serviceManager/installWindows.ts`
writes it (UTF-8 BOM required, mode `0o600`) and registers it under the HKCU
`Run` key. Any new variable the installed app depends on must be added there,
not assumed.

For `PATH`, use `augmentProcessPathWithShellAndKnownCliDirs()` in
`apps/desktop/src/main/services/ai/cliExecutableResolver.ts` — it skips the
POSIX `sh -ic` login-shell probe on Windows and unions the known bin dirs
(`%APPDATA%\npm`, WinGet Links, chocolatey, scoop shims, `~/.local/bin`, volta,
pnpm, bun, asdf, mise). **Never read or write `env.PATH` directly:** Windows may
present `Path` while your code writes `PATH`, leaving two live keys. Use
`getPathEnvKey` / `getPathEnvValue` / `setPathEnvValue` from the same file.

## 5. Named pipes, not Unix sockets — and pipe names are a global namespace

**Failure.** The pipe name was once derived from `path.basename(adeHome)`, so
the default `.ade` gave every Windows user on the machine the same global pipe
name; Windows also matches pipe names case-insensitively, so every spelling
collapses to one endpoint. Node's `readableAll` / `writableAll` default to
false, but a refactor can silently opt into a pipe any local user can read.

**Do instead.** Build endpoints with `machineLayout.ts`: `\\.\pipe\<prefix>-
<channelLabel>-<hash>` where the hash is
`sha256(canonicalAdeDir \0 channelIdentity \0 windowsUserIdentity)` — the POSIX
branch uses `<adeDir>/sock/ade.sock` instead. Listen through
`apps/ade-cli/src/services/runtime/localIpcListenOptions.ts`, which spells
`readableAll: false, writableAll: false` explicitly. New IPC endpoints must be
scoped by ADE home, channel/service, and user identity, or Stable and Beta
collide and a second account can reach the first account's runtime.

## 6. Open files cannot be deleted or renamed

**Failure.** Deleting a file on Windows only unlinks the name once every handle
closes. A concurrent `open(lockPath, "wx")` against a delete-pending name fails
with `EPERM`, `EACCES`, or `EBUSY` instead of `EEXIST` — treat those as fatal
and every concurrent credential write becomes a coin flip. Directories are
worse: an SDK holding `state/index.db` open makes `fs.rmSync` fail outright, and
a leaked child process holding a temp tree open starves later test suites.

**Do instead.** Lock contention checks must accept `EPERM|EACCES|EBUSY` on
`win32` — see `isLockContention()` in
`apps/ade-cli/src/services/credentials/credentialStore.ts` and
`isSocketSpawnLockContention` in `services/runtime/socketSpawnLock.ts`.
Directory removal needs bounded retries (`removeCursorSdkRuntimePath()` in
`apps/desktop/src/main/services/chat/cursorSdkPool.ts` retries `fs.rmSync` 40×
at 250 ms). Anything that opens a file another process may delete needs the
handle closed on every path, including error paths.

## 7. No Keychain — DPAPI and `safeStorage`

**Failure.** macOS Keychain code paths are `darwin`-gated; a new secret stored
"the usual way" simply has nowhere to live on Windows.

**Do instead.** In Electron, use `safeStorage` (`ElectronSafeStorageCredentialStore`
in `credentialStore.ts`; `main.ts` checks `safeStorage.isEncryptionAvailable()`
and reports "unlock the OS credential store" rather than falling back). Headless
CLI uses DPAPI via
`apps/ade-cli/src/services/credentials/windowsDpapiMaterial.ts` —
`ProtectedData::Protect(..., CurrentUser)` through a PowerShell 5.1 subprocess,
key stored as `.credential-key.dpapi` with flag `wx`, mode `0o600`. Two
non-obvious constraints there: PowerShell is resolved through
`\\?\GLOBALROOT\SystemRoot\System32\...` so a poisoned `SystemRoot` cannot
redirect it, and the timeout is 30 s because the budget is PowerShell cold start
plus Defender on-access scanning, not DPAPI itself. Never fall back to the
legacy AES file store on a decrypt failure. Keep the internal `this-mac`
identifier — it is a persistence invariant, not user-facing copy.

## 8. PowerShell and `cmd.exe` quote differently, and `%` cannot be escaped

**Failure.** `%VAR%` inside a `cmd.exe` command line expands and **cannot be
escaped** — doubling (`%%`) is a batch-*file* rule, not a command-line rule, and
caret escaping also fails, so `"100% done"` and `"%USERPROFILE%"` both corrupt.
PowerShell-style single quotes are not recognized by Windows' CRT argv rules, so
a POSIX-shaped line like `PATH=<dir>:$PATH` typed into PowerShell is simply
wrong. npm writes a `.ps1` shim next to every `.cmd`, and `.ps1` can be neither
spawned directly nor run by `cmd`.

**Do instead.** Use the canonical helpers in
`apps/desktop/src/main/services/shared/processExecution.ts`:
`shouldUseWindowsCmdWrapper` (wrap for `""`, `.cmd`, `.bat`),
`resolveWindowsCmdLineInvocation` (ComSpec + `/d /s /c` +
`windowsVerbatimArguments: true`), and `resolveWindowsPowerShellInvocation`
(`-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, where
`-File` keeps the remaining arguments literal). `quoteWindowsCmdArg` is **not**
a general escaping primitive — it leaves `| & < > ! ^` inert only because the
result is embedded in a correctly delimited `cmd.exe /d /s /c "…"`. Text
carrying `%VAR%` must go through stdin instead. For user-visible shell lines,
use the per-shell quoting in
`apps/desktop/src/main/services/appControl/appControlLaunchCommand.ts`
(`quotePowerShellLiteral` vs `quoteCmdSetValue`; `cd /d` + `set "PATH=…"` vs
`Set-Location -LiteralPath` + `$env:PATH`). Never replace structured argv with
a shell string.

## 9. Executable resolution goes through `PATHEXT`, not the execute bit

**Failure.** An extension-less file is not executable on Windows and `chmod` is
a no-op, so POSIX-shaped provider discovery and test fixtures find nothing.

**Do instead.** Split `env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"` on `;` and try each
case variant — see `apps/desktop/src/main/services/cli/adeCliService.ts`.
Discovery uses `where.exe` on Windows where POSIX uses `command -v`. Test
fixtures must create real `.cmd`/`.exe` names rather than `chmod +x` a bare
file.

## 10. Capability gates name the capability, never the product

**Failure.** A gate written as "unsupported on Windows" removes far more than
the thing that actually cannot work, and users lose features that were fine.

**Do instead.** Gate the exact capability with a stated reason.
`apps/desktop/src/main/services/computerUse/localComputerUse.ts` reports
`blocked_by_capability` for screenshot, video recording, app launch, GUI
interaction, and environment info — while App Control and proof-file ingestion
stay available and tested. Renderer gates are equally narrow
(`supportsIosSimulatorPlatform`, `supportsNativeNotchPlatform` in
`renderer/lib/platform.ts`); the iOS Simulator pane is *hidden* on Windows and a
test pins that. Note the arch trap in the same file: `navigator.platform`
reports `Win32` on Windows-on-ARM too, so architecture must come from the
preload bridge (`rendererRuntimeTarget()`), which is what
`isCursorProviderSupported` depends on.

When a capability genuinely cannot work on Windows, that is not a silent gate —
it is the parity decision described in `/quality`'s Windows parity rules: state
the capability and the OS-level reason, say whether macOS/Linux keep it, and
have the human choose hide / disable-with-reason / remove.

---

## Smaller traps worth knowing

- **Port 8787 is often taken by Tailscale** on Windows; the projectless brain
  falls back across 8787–8999.
- **PID reuse** is fast. A recorded PID alone is not identity — record process
  start time too (`apps/ade-cli/src/services/sync/syncHostSingleton.ts`).
- **PowerShell launcher files need a UTF-8 BOM** or PowerShell 5.1 mis-decodes
  non-ASCII content.
- **`ps` does not exist.** Resource sampling returns `unsupported-platform` on
  Windows (`services/pty/resourceUsageSampling.ts`) rather than spawning.
- **Release gates are fail-closed:** `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` and
  `VITE_ADE_WINDOWS_DOWNLOAD_ENABLED`.
- **The full local suite is not clean on a Windows host.** POSIX-only fixtures,
  Unix-socket browser tests, `chmod` assertions, and some SQLite teardown races
  fail there by design; only the focused Windows suites are signal-bearing
  (`WINDOWS_PORT.md`).
