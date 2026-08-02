# Windows support and troubleshooting

ADE supports the packaged Windows 10/11 x64 desktop preview. Windows ARM64,
Windows as an SSH-bootstrap runtime target, native Windows OS computer use, and
iOS Simulator remain out of scope. App Control over CDP, the built-in Browser,
proof-file ingestion, phone pairing, and the local Windows brain are supported
within the preview boundary.

Public Windows installers remain disabled until the exact-SHA release proof in
[`windows-release-proof.md`](./windows-release-proof.md) passes.

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
