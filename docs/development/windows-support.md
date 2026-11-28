# Windows support and troubleshooting

DAEX supports the packaged Windows 10/11 x64 desktop. Windows ARM64 and the iOS
Simulator are out of scope. App Control over CDP, the built-in browser,
proof-file ingestion, phone pairing, the local Windows brain, Windows as an
SSH-bootstrap runtime target, and a per-lane Windows screen
([Windows Desktop](../features/windows-desktop/README.md)) are supported.

Signed public Windows installers ship with every release. Downloads are served
from the website's `/download/windows` page and the PowerShell installer from
`https://ade-app.dev/install.ps1`. The exact-SHA proof in
[windows-release-proof.md](./windows-release-proof.md) is a standing regression
check, not a precondition.

The CLI is `daex` (`ade` still works). Internal names keep the old spelling:
`ADE_*` variables, `~/.ade`, the `ADE Runtime (...)` Run value, the `ade-runtime-*`
pipes, `ade-win32-x64.exe` and the `%LOCALAPPDATA%\Programs\ADE` install folder.

Running a dev app, profiling a running brain, or benchmarking on a Windows host:
see **On Windows** in [local-development.md](local-development.md#on-windows).

## What Windows gets instead

Every capability below behaves differently on Windows than on macOS. The list is
exhaustive by intent: if a Windows user notices something missing or weaker that
is not named here, treat it as a bug. **Degraded** means it works with a stated
cost. **Blocked** means it is absent and the surface says so. **Unavailable**
means the OS offers no route and the surface does not exist.

| Capability | Outcome | What Windows does | Why |
| --- | --- | --- | --- |
| Native OS computer use (screenshot, video, GUI automation) | Degraded | [Windows Desktop](../features/windows-desktop/README.md) gives each lane a Windows screen through `daex screen`: a private Remote Desktop child session after a one-time admin setup, or the user's main desktop when they tap Allow in the chat. Codex Computer Use and Ghost OS stay macOS-only. | The private seat needs the setup, the brain in the console session, an unlocked PC and one lane at a time; the shared seat takes the user's foreground. |
| Desktop app started as administrator | Degraded | Agents get no built-in browser, App Control recording or demo videos while it runs; the app docks a warning banner. | Windows refuses the medium-integrity brain access to the elevated app's desktop-bridge pipe. Quit and open it normally. |
| iOS Simulator drawer, Xcode Preview | Unavailable | Hidden. | Requires macOS and Xcode. |
| Claude Code background-job reattach | Supported | DAEX resolves the daemon at `\\.\pipe\cc-daemon-<nonce>-control`, reading the nonce from `<Claude config dir>/daemon/pipe.key`. No key or no answer resolves to nothing. Verified against a stand-in pipe server, not a live Claude daemon. | Claude Code publishes a named pipe on Windows instead of a socket file. |
| Auto-update install time | Degraded | Installing an update takes about 42-44 s, not the under 10 s macOS needs. See [windows-update-timeline.md](./windows-update-timeline.md). | NSIS extraction of about 800 MB (2,900 files) is nearly all of it. |
| Graceful brain shutdown | Degraded | DAEX asks the brain to shut down over its RPC channel and force-terminates only after the grace window. | Windows has no deliverable `SIGTERM`. |
| Orphan agent recovery | Degraded | Uses the on-disk PID registry and a listening-port scan. | Windows cannot read another process's environment. |
| Open files of another process | Degraded | With Sysinternals `handle.exe` on PATH, DAEX lists files a provider CLI has open. Without it, Claude `--session-id` assignment and transcript capture still identify DAEX-owned sessions; mtime is only a last resort. | No `lsof`; `openfiles /query` needs a global audit flag. |
| Claude Code sandbox permission modes | Blocked | Permission modes work; the sandbox does not. | Claude Code sandboxing is WSL-2 only. |
| Credential storage at rest | Degraded | DPAPI through Electron `safeStorage`. | DPAPI is user-scoped, a weaker boundary than a Keychain item. |
| Remote runtime bootstrap from a local channel build | Blocked | A local `package:alpha` build sets `ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY=1` and ships no Darwin/Linux sidecars. CI-built installers are unaffected. | Darwin binaries cannot be built on Windows. |
| Windows as an SSH-bootstrap runtime target | Supported | Windows 10 22H2 and Windows 11 x64 over Windows OpenSSH Server. | Needs PowerShell 5.1+ and `tar.exe`. WSL, ARM64 and Windows Server are not targets. |
| Windows ARM64 | Unavailable | x64 only. Cursor is also gated on ARM64. | Native and provider payloads are incomplete; `@cursor/sdk` has no `win32-arm64` package. |
| Cross-channel phone-sync launch gate | Degraded | The launch gate answers from the sync-host lock file instead of a listener scan. A brain that holds phone sync without a usable lock file is not seen at launch, so two channels can briefly both hold it. `daex serve` still runs the full scan. | The scan is a full-machine PowerShell query that would block first paint. |
| Symlink-dependent operations | Degraded | Junctions where possible; a real symlink needs Developer Mode or an elevated shell. | Windows restricts symlink creation. |
| Moving a project to another folder or drive | Blocked | Settings > General has no Project location card on Windows, and the move preflight refuses ("Moving a project is only available on macOS for now."). | The move uses macOS `ditto`, `df`, `diskutil` and `lsof`. |
| Keep awake with the lid closed | Blocked | The Keep awake picker has no lid-closed level. "While I'm away" stops idle sleep, not the lid. | No `pmset disablesleep` equivalent. |

Not downgrades, though often assumed to be:

- Git costs one process start per command. DAEX runs the real
  `<Git>\<build>\bin\git.exe` directly, not the `cmd\git.exe` launcher
  (`runGit`). A brain started from Git Bash (`MSYSTEM` set) keeps the launcher,
  so measure git costs from PowerShell or the installed app.
- Cursor runs natively on Windows x64; onboarding installs it with
  `irm 'https://cursor.com/install?win32=true' | iex`.
- Reduced motion is honored (Settings > Accessibility > Visual effects >
  Animation effects).

## Background brain on Windows

The supervisor is **not a Scheduled Task**. `daex brain start` installs a
per-user, per-channel `REG_SZ` value under:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
```

Code: `apps/ade-cli/src/serviceManager/installWindows.ts` and
`windowsSupervisor.ts`.

- The value starts a hidden, UTF-8-with-BOM PowerShell launcher under the
  channel's home through `conhost.exe --headless` (resolved from System32).
  Started bare, `powershell.exe` gets a visible Windows Terminal window that
  takes the foreground. A headless conhost exits when its stdin reads EOF, so it
  only works where it gets no standard input (a task, the Run key, WMI); a Node
  `spawn` with `stdio: "ignore"` hands it `NUL` and fails.
- The launcher restores the resolved brain environment, starts the packaged
  runtime, and writes an advisory `<launcher>.pid.json` with supervisor and
  runtime pids. Status treats a supervisor as DAEX-owned only if it is a
  PowerShell process whose command line names the exact launcher.
- The Run value's name is `ADE Runtime (<channel>-<hash>)`, hashed from the
  channel and the user's **SID**, never `USERDOMAIN` (which is `WORKGROUP` over
  SSH). Install, repair and uninstall delete every other value for this channel
  or launcher. Without a readable SID it falls back to the bare account name.
- The pipe names (`\\.\pipe\ade-runtime-<channel>-<hash>`,
  `ade-desktop-bridge-...`) hash the home, the channel and the profile folder of
  the account that owns the process (`os.userInfo()`), so a desktop logon, an
  SSH session, a task and `runas` compute one name. A brain also listens on the
  names an older build could have derived (`USERDOMAIN\USERNAME` variants), a
  client with no explicit socket picks the listening name from the pipe listing,
  and a brain refuses to start while any of those names is taken or
  `<home>/brains` records a live brain of this channel on another pipe.
  `daex brain status` says when the brain answers on an older name.

One supervisor and one brain run per user and channel, whatever the number of
logon sessions. Before starting a supervisor the launcher:

1. **Reads the session**, comparing `WTSGetActiveConsoleSessionId()` with its
   own session id. If the API cannot answer, it logs and exits.
2. **Outside the console session, honours a Windows Desktop launch request**
   (`<home>\windows-desktop\child-launch.json`): when it parses, `expiresAt` is
   in the future, and `driverPath` exists and ends in `ade-desktop-driver.exe`,
   the launcher starts the driver hidden with its arguments and exits without
   starting a brain. Otherwise it goes on.
3. **Takes a cross-session mutex**, `Global\ade-supervisor-<launcher-hash>-<SID>`.
   An existing owner in any session makes the newcomer exit 0; a mutex failure
   exits 1.

So the brain runs in whichever session first starts a supervisor: usually the
console, but it can be a Remote Desktop session, and a host with no console
session (`0xFFFFFFFF`: Windows Sandbox, headless VMs) also runs one. A brain
outside the console keeps running while Remote Desktop is disconnected and ends
only when that session signs out; the Run value, the desktop's service install
or `daex brain start` restarts it later. Windows Desktop private screens need the
brain in the console session; `daex doctor` shows which session it is in.

The `child-launch.json` branch is a fallback: for each private start the driver
also registers a per-user logon task, `ADE private screen <home hash>`, that runs
the driver's child mode about two seconds into the sign-in through
`conhost.exe --headless`. Its trigger expires after three minutes and the driver
deletes it once the child connects.

`daex brain start` hands the launcher to a one-shot Scheduled Task (or WMI
`Win32_Process.Create` when refused) so it escapes the caller's job object. The
task runs at priority 4 (an ordinary app's), not Task Scheduler's default 7,
which would start the brain with low memory and I/O priority and let Windows
page it out first under memory pressure.

Install and repair treat the PID record as advisory: they enumerate live
supervisors by command line in every session of the user and stop them all before
starting the replacement. A brain that exits with `socket_owned_by_other` makes
the supervisor log and exit instead of restarting forever.

**Never stop the brain from inside it.** An install that would replace the
brain, and every uninstall, first refuses when the command runs inside a process
it would stop (the recorded brain or supervisor, any supervisor of this launcher
and its children, or a stale channel brain it would reap). An agent's shell is
the brain's child, so otherwise `daex brain stop` or `restart` from a chat ends
every chat on the machine. The refusal carries `selfMutationBlocked` (or
`selfMutationUnconfirmed` when it could not tell) and names the
`ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION=1` override that DAEX's update helpers
set. The update's removal preflight (`checkWindowsServiceRemovable`) decides the
same way. "Inside" is read from the Windows parent chain; when the chain ends in
an MSYS or Cygwin `bin` folder (Git Bash's `exec` shims break it), the check asks
that install's `ps.exe -W`. When neither answers, it refuses.

**Wedge watchdog.** Every 15 s the launcher reads the brain's heartbeat
(`<home>\runtime\heartbeat.json`); macOS uses the separate `com.ade.watchdog`
launch agent instead. An absent, unreadable or foreign heartbeat is never a
wedge. A kill needs all three:

1. the beat is older than 90 s and belongs to the launcher's child;
2. the supervisor was awake to watch it go stale: when the gap since its
   previous poll is at least `max(90 s, 3 x 15 s)` and the beat's age fits inside
   that gap plus the staleness window, it logs `machine slept` and clears any
   strike (modern standby suspends supervisor and brain together);
3. a previous poll already saw this same beat (matched on its timestamp), so two
   consecutive stale polls are needed.

macOS applies the same rules in `evaluateBrainHeartbeat`, with the suspend floor
`max(staleMs, 3 x the checker's interval)` (`brainWatcherSuspendFloorMs`): 90 s
on Windows, 180 s on macOS. `ADE_BRAIN_HEARTBEAT_STALE_MS` overrides the 90 s
threshold on both (a positive integer, never below 30 s); the Windows supervisor
reads it once at start.

Release proof records separate bounded signals: the Run value exists, a
redacted record from `<launcher>.pid.json` with proof-local pid aliases, an IPC
readiness record (a client completed initialize on the channel's endpoint), and a
correlated startup log extract. The Run entry re-establishes the supervisor at
the next logon; for an in-session crash, prove recovery through `daex brain
start` or repair.

Stable, Alpha and custom service labels get separate value names, launchers,
homes and pipes. Scheduled Tasks from older preview builds are legacy residue
that install and uninstall remove by exact name. The current-user key needs no
administrator access: never move it to HKLM, request elevation to start at login,
or tell users to repair the service in Task Scheduler.

## First diagnostic pass

From a new PowerShell or cmd window (so it sees the current user PATH):

```powershell
daex brain status --text
daex doctor --json
daex runtime service-status --text
```

`daex report-issue` produces the same redacted report as the desktop's report
dialog. It reads local files only and never starts or contacts the brain, so it
works where DAEX will not come up. `--send` sends it privately; `--open` after a
send opens a public GitHub issue that holds only the reference, the version and
the OS. `redactDiagnosticText` strips paths, account and host names, addresses
and credential-shaped values; secrets, environment blocks and pairing PINs are
never collected. See
[storage and recovery](../features/storage-and-recovery/README.md#diagnostic-reports-the-report-dialog).

Before sharing anything assembled by hand, remove user paths, repository names,
machine and device ids, account details, IPs, URLs with query strings and
credential-shaped values. Never attach the whole home or a raw database.

## Brain is installed but not running

First rule out a brain that is still starting. An install that reports
`starting` left a live child that did not answer on the pipe within
`WINDOWS_HANDOVER_TIMEOUT_MS` (15 s). The supervisor owns it, and restarting only
resets its clock. `daex connect` says "the background service is still
starting", and the desktop shows `brain_starting` with no Repair and reopens the
project once the pipe answers. Give it `RUNTIME_SERVICE_YOUNG_BRAIN_MS` (120 s).
If it really is stuck:

1. Confirm the channel's value exists under the current user's Run key (do not
   paste its command: it has local paths).
2. Run `daex brain start`, then `daex brain status --text`.
3. Confirm the PID record exists under the channel home's `runtime/` folder and
   that supervisor and runtime are live.
4. If the startup entry exists but no supervisor runs, `daex brain stop` then
   `daex brain start` rewrites launcher and entry.
5. An old `ADE Runtime` Scheduled Task is removed by install/uninstall; a cleanup
   failure is fail-closed, so capture its error and retry as the same user.

A process in Task Manager does not prove the pipe is healthy: verify an
initialized client call.

## Desktop cannot attach to the local brain

- Desktop and CLI must be the same channel; Stable and Alpha use different homes
  and pipes.
- Close only the affected channel, restart its brain, relaunch that channel.
- A second Windows account must not reach the first account's pipe; access
  denial is expected isolation.
- On a packaged/runtime build mismatch, reinstall the same signed version before
  changing local state.

## Phone, Relay or Tailscale cannot connect

- `crdtSyncAvailable` must be true; otherwise reinstall/restart (pairing is
  blocked without CR-SQLite).
- LAN needs the Windows Defender Firewall rule (`apps/desktop/scripts/windows-firewall-rules.ps1`)
  and a reachable sync listener (ports 8787-8999).
- Tailscale resolution checks Program Files, then PATH; `ADE_TAILSCALE_CLI` is for
  a non-default install.
- Relay works only while the brain has a current account lease and owns the
  machine-wide sync-host lease, and directory publication needs the end-to-end
  self-probe to pass.
- On a physical iPhone, verify a bidirectional CRR row roundtrip, not just
  "Connected".

## Provider or terminal launch fails

- Reproduce as four labelled cases: Windows PowerShell 5.1, PowerShell 7, cmd
  and Git Bash.
- For each provider, test authenticated and unauthenticated states, fresh launch
  and tracked resume separately (resume bugs often bypass the fresh launch path).
- Use a disposable path and prompt with Unicode, spaces, quotes, `$`, `%`, `&`
  and backticks.
- Exercise ConPTY resize, Ctrl+C, cancellation, descendant cleanup and crash
  restore.
- Provider credentials are machine-local; never copy a credential store into
  evidence or across machines.
- The shared credential store (`credentials.json.enc`) is sealed with the bare
  machine key on every platform, never DPAPI or keychain material, because the
  desktop app, the brain and the CLI all read it. A DPAPI helper timeout must
  degrade to an "unreadable, may be recoverable" report, never end the brain.
  Single-writer secrets that want OS protection go in the Electron safeStorage
  store (`credentials.safe.enc`), which only the desktop reads.

## Standalone brain or installation is damaged

- The standalone `ade-win32-x64.exe` install must work without the desktop:
  `daex brain start`, `daex brain status --text`, `daex doctor --json` and
  `daex brain update`.
- A Windows client can bootstrap macOS and Linux runtimes; check the OpenSSH
  Client prerequisite first.
- The service-removal check must pass from Electron main:
  `resolveAdeServeCommand()` describes `ADE.exe <resources>\ade-cli\cli.cjs serve`,
  and `readRecordedBrain` also accepts the command in the launcher script. A
  machine stuck on an update recovers with `daex brain update`, whose
  `--apply-staged` step installs the desktop app (sha512 and Authenticode signer
  checked, service restored on failure). See
  [Desktop auto-update](../features/onboarding-and-settings/desktop-auto-update.md).
- `install.ps1` stages everything under the home, never `%TEMP%` (which may be on
  another volume, and which AppLocker and EDR often block): `<runtime dir>.new` /
  `.previous` beside the runtime, `ade.new.exe` / `ade.bak.exe` beside `ade.exe`.
  Every promotion is a same-directory rename, and the preflight runs the new
  binary against the staged runtime. A failed install says whether the existing
  install was untouched or rolled back; if the rollback failed, the named recovery
  copies are the only copy, so keep them.
- Repair a partial install with the product's repair path before testing
  reinstall or uninstall; repair keeps projects and user state.

## Update does not land

- `latest.yml`, the installer and the blockmap must match the manifest hashes,
  and the installed app's update authority must be the repository that built it.
- DAEX keeps the first verified cached download after a lost handoff and clears
  the cache after a second failure for the same target.
- A checksum, signature, publisher-pin or timestamp failure clears unsafe cache
  data and never replaces the running app.
- After an update, verify the relaunch version, project data and the HKCU
  supervisor.

## Uninstall leaves residue

The uninstaller owns only its channel's service, launcher and PID record,
terminal shim and the matching user PATH entry. Check that the channel's Run
value, supervisor/runtime tree, launcher, PID record, legacy task names, shim and
PATH entry are gone, and that other channels and project data remain. Never
delete whole homes as a support shortcut.

## Support bundle boundary

A safe bundle may contain the proof manifest, the relevant scenario entries,
small redacted event extracts, synthetic DB query results, proof-local
process/IPC/network summaries and cropped screenshots. It must not contain:

- `.ade/secrets`, credential stores, tokens, pairing PINs, DPoP material or
  signing files;
- raw `.db`, WAL or SHM files;
- full logs or environment blocks;
- home paths, account or computer names, emails, IPs or device ids;
- transcripts, source files, private repository names or unrelated artifact
  bytes;
- raw certificate subjects or files (only approved digests).

Validate release evidence with `apps/desktop/scripts/windows-proof-manifest.mjs`
before attaching it to a support or release record.
