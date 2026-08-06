# Windows support and troubleshooting

ADE supports the packaged Windows 10/11 x64 desktop, shipped as a public beta.
Windows ARM64, native Windows OS computer use, and iOS Simulator remain out of
scope. App Control over CDP, the built-in Browser, proof-file ingestion, phone
pairing, the local Windows brain, and Windows as an SSH-bootstrap runtime target
are supported.

Public Windows installers ship. v1.2.52 was the first signed public release;
downloads are served from `https://ade-app.dev/download/windows` and the
PowerShell installer from `https://ade-app.dev/install.ps1`. The exact-SHA proof
in [`windows-release-proof.md`](./windows-release-proof.md) remains a standing
regression check rather than a precondition.

## What Windows gets instead

Every capability below behaves differently on Windows than on macOS. The list is
exhaustive by intent: if a Windows user notices something missing or weaker and
it is not named here, treat that as a bug, not a known gap.

Three outcomes are possible, and they are not interchangeable. **Degraded** means
the capability works with a stated cost. **Blocked** means the capability is
absent and the surface says so. **Unavailable** means the OS offers no route at
all and the surface does not exist.

| Capability | Outcome | What Windows does | Why |
| --- | --- | --- | --- |
| Native OS computer use — screenshot, video, GUI automation | Blocked | App Control over CDP, the built-in Browser, and proof-file ingestion all work. Only OS-level capture is gated. | Backed by `screencapture` and `osascript`. The Windows equivalent is Windows.Graphics.Capture plus UI Automation, which is a separate project. |
| iOS Simulator drawer, Xcode Preview | Unavailable | Hidden. | Requires macOS and Xcode. |
| Native Notch | Unavailable | Hidden. | macOS window-server feature with no counterpart. |
| Claude Code background-job reattach | Degraded | Each follow-up prompt respawns the CLI instead of replying into the live background job. Turns are slower and in-flight context is lost. | Claude Code ships no `control.sock` on Windows, and `os.userInfo().uid` is `-1`, so there is nothing to attach to. |
| Graceful brain shutdown | Degraded | ADE asks the brain to shut down over its own RPC channel and force-terminates only after the grace window. | Windows has no deliverable `SIGTERM`; `process.kill` is `TerminateProcess`, which no handler can intercept. |
| Orphan agent recovery | Degraded | Recovery uses the on-disk PID registry and a listening-port scan. | Windows cannot read another process's environment, so the macOS `ps -wwE` environment-tag pass has no equivalent. The port half is implemented. |
| Claude Code sandbox permission modes | Blocked | Permission modes themselves work; the sandbox does not. | Vendor limitation — Claude Code sandboxing is WSL-2 only. Not an ADE gap. |
| Credential storage at rest | Degraded | DPAPI through Electron `safeStorage`. | No Keychain. DPAPI is user-scoped rather than per-item ACL'd, so it is a weaker boundary than a Keychain item. |
| Remote runtime bootstrap from a locally built channel | Blocked | A local `package:beta` build sets `ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY=1` and ships no Darwin/Linux sidecars, so it cannot drive a remote macOS or Linux runtime. CI-built installers are unaffected. | Darwin binaries cannot be produced on a Windows host. |
| Windows as an SSH-bootstrap runtime target | Supported | Windows 10 22H2 (build 19045) and Windows 11 x64 can be bootstrapped over Windows OpenSSH Server. | Requires PowerShell 5.1 or newer and the built-in `tar.exe`. WSL, ARM64, and Windows Server remain unsupported as targets. |
| Windows ARM64 | Unavailable | x64 only. The Cursor provider is additionally gated on ARM64 even under emulation. | Native and provider payloads are incomplete; `@cursor/sdk` publishes no `win32-arm64` package. |
| Cross-channel phone-sync launch gate | Degraded | The launch gate answers from the sync-host lock file alone. A brain that was hard-killed and left a stale lock is not detected, so two channels can briefly both hold phone sync. `ade serve` still runs the full scan when it starts a brain. | The listener scan is a full-machine `Get-NetTCPConnection` + `Get-CimInstance` PowerShell query. It runs before any window exists, so on every launch it would block first paint — the cost `lsof` does not carry on macOS. |
| Symlink-dependent operations | Degraded | Junctions are used where possible. Operations that need a real symlink require Developer Mode or an elevated shell. | Windows restricts symlink creation to administrators unless Developer Mode is on. |

Two things that are **not** downgrades, recorded here because they are commonly
assumed to be:

- Cursor runs natively on Windows x64. The onboarding flow installs it with
  `irm 'https://cursor.com/install?win32=true' | iex`; there is no WSL
  requirement.
- Reduced-motion preferences are honored. Chromium maps
  `prefers-reduced-motion` to Settings → Accessibility → Visual effects →
  Animation effects, so no macOS-only API is involved.

## Background brain on Windows

The current Windows supervisor is **not a Scheduled Task**. `ade brain start`
installs a per-user, per-channel `REG_SZ` value under:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
```

The value starts a hidden, UTF-8-with-BOM PowerShell launcher under the
channel's ADE home. That launcher restores the complete resolved brain
environment, starts the packaged ADE runtime, and writes an advisory JSON record
containing supervisor and runtime process ids. Status validates that the
recorded supervisor is a PowerShell process whose command line names the exact
launcher before treating it as ADE-owned.

Release proof records these as separate bounded signals, not one inferred
"service is running" claim:

- a redacted process record that the channel-qualified HKCU Run value exists;
- a redacted process record derived from `<launcher>.pid.json`, with proof-local
  aliases for both `supervisorPid` and `runtimePid` rather than numeric PIDs;
- a redacted IPC readiness record showing that a client completed initialize on
  the channel's runtime endpoint after startup or recovery; and
- a bounded startup/recovery log extract correlated by a proof-local alias.

The launcher's wait is sliced, not unbounded. Every 15 s it reads the brain's
heartbeat file (`<ADE home>\runtime\heartbeat.json`) and, if the beat is older
than 90 s **and** belongs to the child it started, stops that child and lets its
own restart path take over. This is the Windows half of the cross-platform wedge
watchdog — macOS uses a separate `com.ade.watchdog` launch agent because launchd
has no loop to fold the check into. An absent, unreadable, or foreign heartbeat
is never read as a wedge, so the guard cannot fire on a brain it does not own.

The PID JSON is advisory ownership evidence. It is not a readiness file, and an
ONLOGON Scheduled Task is not a current supervisor or readiness mechanism.
The Run entry re-establishes the supervisor at the next user logon; the launcher
waits for the runtime and then exits with it. For an in-session runtime crash,
prove crash detection and recovery through the supported `ade brain start` or
repair path rather than claiming that the launcher contains an automatic
restart loop.

Stable, Beta, Alpha, and custom service labels get separate value names,
launchers, ADE homes, and named pipes. Installation and uninstall also query and
remove exact Scheduled Task names created by older preview builds. A Scheduled
Task found during migration is legacy residue; it is not the active supervisor
contract.

The current-user startup key requires no administrator access. Do not move the
entry to HKLM, request elevation merely to start ADE at login, or tell users to
repair the current service in Task Scheduler.

## First diagnostic pass

Run these from a newly opened PowerShell or cmd window so it sees the current
user PATH:

```powershell
ade brain status --text
ade doctor --json
ade runtime service-status --text
```

Before sharing output, remove user paths, repository names, machine/device ids,
account details, IPs, URLs with query strings, and any credential-shaped value.
Prefer reporting the status/error code and ADE version. Do not attach the whole
ADE home or a raw database.

## Brain is installed but not running

1. Confirm the channel-qualified value exists under the current user's Run key.
   Do not paste its command because it contains local installation paths.
2. Run `ade brain start`, then `ade brain status --text`.
3. Confirm the PID record exists under the channel ADE home's `runtime/`
   directory and that the supervisor/runtime are live. Report proof-local PID
   aliases rather than raw command lines.
4. If status says the startup entry exists but the supervisor is not running,
   run `ade brain stop` followed by `ade brain start` to rewrite the launcher and
   entry.
5. If an old `ADE Runtime` Scheduled Task remains, normal install/uninstall
   should remove it. A cleanup failure is fail-closed; capture only its bounded
   error text and retry from the same user account.

If a logoff or reboot was part of the failure, verify both process recovery and
an initialized client call. A process in Task Manager alone does not prove that
the named pipe is healthy.

## Desktop cannot attach to the local brain

- Confirm desktop and CLI are the same channel. Stable and Beta intentionally
  use different ADE homes and pipe names.
- Close only the affected channel, restart its brain, then relaunch that channel.
- A second Windows account must not be able to use the first account's pipe.
  Access denial is expected isolation, not a reason to weaken named-pipe ACLs.
- Do not publish a full named-pipe path in support artifacts. Record a channel
  alias and the initialize result.
- If the desktop reports a packaged/runtime build mismatch, reinstall the same
  signed version before changing local state.

## Phone, Relay, or Tailscale cannot connect

- `crdtSyncAvailable` must be true. If it is false, reinstall/restart the
  packaged app; Windows pairing is blocked rather than silently running without
  CRR support.
- LAN requires the approved Windows Defender Firewall path and a reachable sync
  listener. Record the route kind and coarse outcome, never IPs or pairing data.
- Tailscale resolution checks the normal Program Files installation, then PATH.
  Use `ADE_TAILSCALE_CLI` only for a non-default install.
- Relay is available only while the Windows brain has a current ADE account
  lease and owns the machine-wide sync-host lease. There is no separate Relay
  toggle.
- A connected Relay control is not sufficient; directory publication requires
  the end-to-end self-probe to pass.
- On a physical iPhone, verify both the visible connection and a bidirectional
  synthetic CRR row roundtrip. Do not treat "Connected" as complete sync proof.

## Provider or terminal launch fails

- Reproduce as four separately labelled cases: Windows PowerShell 5.1,
  PowerShell 7, cmd, and Git Bash. A generic `powershell` result does not prove
  either PowerShell version, and cmd results do not stand in for Git Bash.
- For each of Claude, Codex, Cursor, OpenCode, and Droid, test authenticated and
  unauthenticated states, fresh launch, and tracked resume separately. Resume
  bugs often bypass the fresh structured command path.
- Use a disposable path/prompt containing Unicode, spaces, quotes, dollar and
  percent signs, ampersands, and backticks.
- Exercise ConPTY resize, Ctrl+C, explicit cancellation, descendant cleanup,
  and crash restore. Do not use a successful terminal close as the only
  process-cleanup signal.
- Confirm interrupted sessions expose bounded recovery metadata and actionable
  recovery instructions. Redact prompts, transcripts, command arguments,
  account identifiers, and paths independently for every provider.
- Provider credentials are machine-local. Never copy a credential store into an
  evidence bundle or across a cross-machine handoff.

## Standalone brain or installation is damaged

- Exercise the standalone `ade-win32-x64` install independently of the desktop:
  `ade brain start`, `ade brain status --text`, `ade doctor --json`, and the
  supported update command must all operate from the standalone payload.
- A Windows client may bootstrap supported macOS/Linux runtimes. Verify the
  OpenSSH client prerequisite first and require a bounded actionable error when
  it is absent. This does not make Windows an SSH-bootstrap *target*.
- Windows standalone install and `ade brain update` are implemented, but the
  exact-SHA proof must re-hash `ade-win32-x64.exe`, its native archive,
  `install.ps1`, and `SHA256SUMS` from the immutable proof run. Missing or
  mismatched evidence is a public-release blocker; do not relabel it as a pass
  or substitute a manual binary copy.
- Repair a partial launcher/runtime installation with the product's bounded
  repair path before testing reinstall or uninstall. Repair must preserve
  projects and user state; reinstall and uninstall remain separate scenarios
  with their own ownership checks.

## Update does not land

- Confirm `latest.yml`, installer, and blockmap match the manifest hashes and
  the installed app's update authority is the repository that built it.
- Preserve the first verified cached download after a lost handoff; ADE clears
  the cache after a second failure for the same target.
- A checksum, signature, publisher-pin, or timestamp failure must clear unsafe
  cache data and must not replace the running app.
- Verify the relaunch version, project data, and HKCU supervisor after update.
  References to "Scheduled Task repair" are stale; only legacy-task cleanup is
  expected.

## Uninstall leaves residue

The uninstaller owns only its channel's background service, launcher/PID record,
terminal shim, and the matching user PATH entry. It should not delete projects,
another ADE channel, or unrelated PATH entries.

Check, using redacted aliases:

- the channel's HKCU Run value is absent;
- its supervisor/runtime process tree is stopped;
- its launcher and PID record are absent;
- exact legacy Scheduled Task names are absent;
- the installer-owned shim and PATH component are absent; and
- other channels and project data remain.

If cleanup fails, leave the product state intact and report the bounded cleanup
error. Do not manually delete broad ADE homes as a support shortcut.

## Support bundle boundary

A safe support bundle may contain the proof manifest, the relevant scenario
entries, small redacted event extracts, synthetic DB query results, proof-local
process/IPC/network summaries, and cropped screenshots. It must not contain:

- `.ade/secrets`, credential stores, tokens, pairing PINs, DPoP material, or
  signing files;
- raw `.db`, WAL, or SHM files;
- full logs or environment blocks;
- home paths, account or computer names, email addresses, IPs, or device ids;
- chat transcripts, source files, private repository names, or artifact bytes
  unrelated to the reproduction; or
- raw certificate subjects or certificate files. Store only approved digests
  needed to compare identity.

Validate release evidence with `windows-proof-manifest.mjs` before attaching it
to a support or release record.
