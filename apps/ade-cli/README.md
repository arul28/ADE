# ADE CLI

`apps/ade-cli` owns the `ade` command, the ADE brain, manual runtime entry points, and the terminal `ade code` client. The **brain** is the always-on, machine-owned ADE process for one channel; it is the source of truth for lanes, agent chats, work sessions, PR state, sync, proof artifacts, and the project catalog on a machine. Desktop ADE, `ade code`, the iOS app, and SSH-attached desktops all attach to it. A **manual runtime** is an explicit foreground execution process you start for dev/test work instead of using the automated brain service.

## Modes

The `ade` binary has three operating modes:

- **Attached brain** — the ADE brain listens on `$ADE_HOME/sock/ade.sock` (POSIX) or `\\.\pipe\ade-runtime` (Windows). All other CLI commands and clients open that local endpoint and speak ADE JSON-RPC.
- **Manual runtime** (`ade runtime run`) — a foreground execution process on an explicit endpoint. Sync is always off; use this for dev/test work when you do not want to use the automated stable/beta/alpha brain service.
- **Headless** (`--headless` or `ade code --embedded`) — the CLI builds an in-process `AdeRuntime` for one project and answers the same JSON-RPC surface directly. Used for one-shot commands and as a fallback when no machine brain is available.
- **`ade rpc --stdio`** — attaches to the local machine brain and bridges its JSON-RPC over stdio. This is the transport the desktop's remote runtime feature spawns over SSH.

Default routing for typed commands: prefer the machine brain endpoint if reachable; auto-start the brain when the endpoint does not exist; fall back to headless for commands that don't need shared live state. Add `--socket` to require a specific endpoint, or `--headless` to force in-process execution.

## Machine layout

`resolveMachineAdeLayout()` (in `src/services/projects/machineLayout.ts`) is the single source for per-machine paths. Override the root with `ADE_HOME`.

| Path | Purpose |
| --- | --- |
| `~/.ade/` | Per-machine ADE state root for the stable channel. |
| `$ADE_HOME/sock/ade.sock` | ADE brain local endpoint (POSIX). |
| `\\.\pipe\ade-runtime` | ADE runtime named-pipe endpoint (Windows). |
| `$ADE_HOME/projects.json` | Project catalog. |
| `$ADE_HOME/personal-chats/` | Machine-owned projectless chat runtime state, hidden workspace, transcripts, and attachments. |
| `~/.ade/secrets/` | Machine credential store (`credentials.safe.enc` for desktop safeStorage, `credentials.json.enc` plus `.machine-key` for headless fallback storage, per-store `*.lock` files, and the Ed25519 `machine-identity-signing.json` used by account adoption). |
| `~/.ade/bin/ade` | Bundled static runtime binary (release installs / remote uploads). |
| `~/.ade/agent-skills/` | Bundled, version-locked ADE agent skills. Desktop remote bootstrap uploads this beside the remote runtime; CLI launch then re-seeds ADE-managed skills into runtime-native home skill directories. |
| `~/.ade/runtime/<platform-arch>/` | Native node modules for that runtime binary. |
| `~/.ade/runtime/launchd.{out,err}.log` | Runtime stdout/stderr when running as a login service on macOS. |

Per-project state stays under `<project>/.ade/` and is governed by `projectConfigService` (see `docs/features/onboarding-and-settings/configuration-schema.md`). Project-scoped ADE secrets live in `<project>/.ade/secrets/project-secrets.v1.enc` and are exposed through `ade secrets` / the `project_secret` action domain.

Channel builds use parallel state roots and binary names so Stable, Beta, and Alpha can coexist:

```text
ADE.app        -> ade        -> ~/.ade        -> ade-desktop
ADE Beta.app   -> ade-beta   -> ~/.ade-beta   -> ade-desktop-beta
ADE Alpha.app  -> ade-alpha  -> ~/.ade-alpha  -> ade-desktop-alpha
```

Source dev launches use the temp dev endpoint and `ade-desktop-dev` Electron profile instead of the installed app profile.

## Install paths

Three ways to put `ade` on a machine:

1. **Standalone runtime install** — single static binary plus its native dependency archive, fetched from a GitHub release. Suitable for headless macOS/Linux servers and Windows x64 machines.

   ```bash
   curl -fsSL https://github.com/arul28/ADE/releases/latest/download/install.sh | sh
   ```

   Windows PowerShell:

   ```powershell
   irm https://github.com/arul28/ADE/releases/latest/download/install.ps1 | iex
   ```

   Environment overrides accepted by `install.sh`:

   - `ADE_VERSION=vX.Y.Z` — install a specific release tag (default `latest`).
   - `ADE_INSTALL_DIR=/custom/bin` — destination directory for the binary (default `$ADE_HOME/bin`).
   - `ADE_RELEASE_REPO=owner/repo` — fetch from a fork.
   - `ADE_HOME=/custom/.ade` — change the per-machine state root.
   - `ADE_INSTALL_NO_PROMPT=1` — skip the interactive sign-in and desktop-app offers.
   - `ADE_INSTALL_NO_PATH=1` — write `$ADE_HOME/env` but never touch a shell profile (the POSIX equivalent of `-NoPath`).

   After a successful install both scripts run `ade tools ensure` so the pinned agent CLIs (Codex, Claude Code, OpenCode) are in the shared machine cache before the first agent run rather than as a surprise multi-hundred-megabyte download. That step is non-fatal — the brain retries it in the background on every `ade serve`. Then both scripts offer to run `ade connect`, which links the machine to your ADE account, and then offer the desktop app (macOS `.zip` via `ditto`, Windows NSIS installer via a silent per-user `/S` run). Both desktop downloads are verified against the base64 SHA-512 in the electron-updater manifest (`latest-mac.yml` / `latest.yml`) — the published `SHA256SUMS` covers only the standalone runtime assets. Prompts are read from `/dev/tty` on POSIX because `curl | sh` occupies stdin; when no terminal is attached (CI, automation) both scripts skip the interactive steps and print the follow-up commands instead. `install.ps1` also accepts `-NoPrompt`.

   For an unpublished Windows proof bundle, run `install.ps1 -AssetDirectory <bundle-directory>` (or set `ADE_RELEASE_ASSET_DIR`) to install the local checksum, executable, and native archive without creating a GitHub Release.

   The POSIX script downloads `ade-<platform-arch>` to `$ADE_INSTALL_DIR/ade`; the PowerShell script downloads `ade-win32-x64.exe` to `$ADE_INSTALL_DIR\ade.exe`. Both verify the binary and matching `.native.tar.gz` against `SHA256SUMS`, extract native dependencies under `$ADE_HOME/runtime/<platform-arch>/`, run `ade --version`, and register the per-user login service. Both put `ade` on `PATH`. The PowerShell installer adds the install directory to the current user's `PATH` (idempotently, then broadcasts `WM_SETTINGCHANGE`) and tells you to open a new terminal. The POSIX installer writes `$ADE_HOME/env` — a guarded `case ":${PATH}:" in ... esac` prepend that is safe to source repeatedly — and, with consent on a tty, appends one marker-commented block (`# >>> ade >>>` / `. "$HOME/.ade/env"` / `# <<< ade <<<`) to `~/.zshrc` (zsh; `~/.zprofile` only when no `~/.zshrc` exists), `~/.bash_profile` (bash on macOS) or `~/.bashrc` (bash on Linux). It greps for the marker first, so re-running the installer — which is also the update path — never duplicates the block. fish and unrecognized shells are never edited: the installer prints `fish_add_path "<dir>"` or the source line instead, as it does with no tty or with `ADE_INSTALL_NO_PATH=1`. After a profile edit the closing output tells you to run `. "$HOME/.ade/env"` or open a new terminal. Both accept `-NoPath` / `ADE_INSTALL_NO_PATH=1`; use `-NoService` to skip startup registration.

2. **Desktop bundle** — every packaged ADE.app ships the CLI. macOS path:

   ```bash
   /Applications/ADE.app/Contents/Resources/ade-cli/bin/ade
   ```

   Add it to `PATH` once with the channel-specific helper:

   ```bash
   /Applications/ADE.app/Contents/Resources/ade-cli/install-path.sh
   ```

   The `install-path.sh` wrapper exposes `ade` (or `ade-beta` / `ade-alpha` from the matching `.app`). The wrapper runs the CLI under the packaged Electron runtime, so users do not need a separate Node install. The desktop General settings tab also exposes Install / Repair via `AdeCliSection` (`window.ade.adeCli.installForUser()`).

3. **Source build** — for repository development:

   ```bash
   cd apps/ade-cli
   npm run build
   npm link            # or: npm pack && npm install -g ./ade-cli-*.tgz
   ```

   Requires Node.js 22.13 or newer (the headless runtime depends on `node:sqlite` and the Cursor SDK).

## Service manager

The ADE brain runs as a per-user login service. The implementations live in `src/serviceManager/`.

| Platform | Backend | Service path |
| --- | --- | --- |
| macOS | launchd `LaunchAgent` | `~/Library/LaunchAgents/com.ade.runtime.plist` |
| Linux | `systemctl --user` | `~/.config/systemd/user/<ADE_RUNTIME_SERVICE_NAME>.service` |
| Windows | HKCU `Run` entry + PowerShell supervisor | `HKCU\...\CurrentVersion\Run` value `ADE Runtime (<channel>-<hash>)` |

The default service label is `com.ade.runtime`; channel builds override it via `ADE_PACKAGE_CHANNEL=alpha|beta` (`com.ade.runtime.alpha`, `com.ade.runtime.beta`). `ADE_RUNTIME_SERVICE_NAME` overrides the label outright. On Windows the label and current-user identity produce a channel/user-qualified Run-value name, launcher, advisory supervisor/runtime PID record, and named pipe. The Run value starts a hidden PowerShell supervisor; a successful initialized IPC response is the separate readiness record. Scheduled Tasks are legacy state that install/uninstall clean up, never the current service registration. macOS writes `launchd.{out,err}.log` under `ADE_HOME/runtime/`.

### Windows: how the always-on guarantee is actually obtained

launchd and systemd own the process they start, so on macOS and Linux "installed" and
"survives this session" are the same fact. Windows has no unelevated equivalent, and the two
halves have to be built separately.

**Login persistence** is the HKCU `Run` key. An ONLOGON scheduled task would be the closer
analogue but requires elevation — both `schtasks /Create /SC ONLOGON` and
`Register-ScheduledTask -AtLogOn` fail with *Access is denied* for a standard user.

**Session survival** is the harder half. [Job
objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): "by default
any child processes it creates using `CreateProcess` are also associated with the job", job
membership cannot be broken once assigned, and `CREATE_BREAKAWAY_FROM_JOB` fails with
`ERROR_ACCESS_DENIED` unless the job opted in with `JOB_OBJECT_LIMIT_BREAKAWAY_OK` — which the
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` jobs used by terminals, editors, CI agents and Electron do
not. So a supervisor started as an ordinary child of `ade brain start` is terminated with the
session that started it. The fix is to have something else create the process:

1. **A transient one-shot scheduled task.** The Task Scheduler service spawns the action itself,
   so the supervisor is parented to `svchost.exe` and belongs to none of our jobs. Registering a
   one-shot task does not require elevation. The task is unregistered as soon as it has started.
2. **`Win32_Process.Create` over WMI**, if task registration is unavailable or denied by policy.
   The same Microsoft page states it explicitly: "Child processes created using
   `Win32_Process.Create` are not associated with the job." The process is created by the WMI
   provider host `WmiPrvSE.exe` and ends up in no job at all. This is second rather than first
   because WMI process creation is the more commonly blocked of the two — it is a known
   lateral-movement technique and endpoint-protection rules disable it. The two failure modes are
   largely independent, which is why both are worth having.
3. **An in-session launch**, if a machine refuses both. The brain still comes up, but it is bound
   to the lifetime of the session that started it.

At sign-in none of this is needed: `explorer.exe` runs the `Run` entry and is itself job-free.

**The limitation, stated plainly.** On a machine that denies both handovers, ADE's always-on
guarantee does not hold — the brain dies when your terminal, editor or agent exits, and returns
only at your next sign-in. ADE does not hide this. The supervisor probes its own job on startup
(`QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation)`, checking for
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) and publishes the answer as `sessionBound` in its PID
record; `ade brain start` and `ade brain status` both say so in full. That is measured about the
running supervisor rather than inferred from which launch route the installer used, so a brain
that was session-bound today stops being reported that way once `explorer.exe` starts it
job-free at the next sign-in. `null` means the probe could not run and is never reported as a
guarantee either way.

Manage the service from the CLI:

```bash
ade brain start                   # enable/load the login service
ade brain stop                    # disable/unload the login service
ade brain status --text           # endpoint state, service state, sync state
ade brain update --text           # stage/apply the latest standalone brain release and restart the service
ade brain update status --text    # last headless update state
ade brain restart                 # re-exec after an app update

# Compatibility wrappers (same backend):
ade runtime install-service
ade runtime uninstall-service
ade runtime service-status --text
ade runtime status --text

# Phone pairing:
ade brain pin generate
ade brain pin set 123456
ade brain pin clear
```

The service manager builds the launch command from the current `ade` binary path so the installed service launches the same ADE channel that ran the install. Release installs use `$ADE_HOME/bin/ade` (`ade.exe` on Windows), which lets `ade brain update` stage the next release under `$ADE_HOME/runtime/updates/`, verify downloaded assets against `SHA256SUMS`, atomically promote the binary/native deps, and restart the login service without the desktop app being open. On Windows, update stops the existing process before replacing the executable, restores the previous executable, native tree, and service if promotion fails, and delegates staging cleanup until the running helper exits so Windows file locks do not retain update payloads. Failed compensation reports and preserves the exact recovery files instead of silently discarding the rollback error. After a packaged desktop update, ADE also refreshes this service so the brain re-execs the updated bundled CLI instead of leaving clients attached to an older build hash.

## Internal process command

To make your own runtime, run `ade runtime run` on an explicit endpoint. Sync is always off so the manual runtime cannot claim brain authority; use a separate `ADE_HOME` when you also want full machine-state isolation.

```bash
ADE_HOME=/tmp/ade-dev-runtime ade runtime run --socket /tmp/ade-dev-runtime.sock
ade --socket /tmp/ade-dev-runtime.sock projects list --text
ade code --socket /tmp/ade-dev-runtime.sock
```

## Brain lifecycle

Prefer `ade brain start`, `ade brain stop`, `ade brain status`, and `ade brain restart` for user-facing lifecycle control. Use `ade brain pin ...` for phone pairing:

```bash
ade brain status --text            # endpoint state, service state, sync state
ade brain restart                  # refresh the login service after an update
ade brain pin generate             # generate a phone pairing PIN
ade brain pin set 123456
ade brain pin clear
```

Older `ade runtime ...` and `ade sync pin ...` command aliases remain available for scripts, but docs and examples use the brain vocabulary.

## Project registry

The ADE brain owns a per-machine project catalog at `$ADE_HOME/projects.json` (`ProjectRegistry` in `src/services/projects/projectRegistry.ts`). A project record carries a stable `projectId` (`project_<sha256(rootPath)[..24]>`), root path, display name, `addedAt`, `lastOpenedAt`, and the resolved git origin URL. Each record also has a `catalogVisibility` (`recent` vs `system`) and a `registrationSource`: explicit commands (`ade projects add`, `ade init`) register as `recent`/`cli-explicit`, while runtime auto-registration (an agent attaching to run a project-scoped command) registers as `system`/`runtime-auto` so it does not surface as a recent project. `ade projects list --text` shows a `visibility` column so all rows, including `system` ones, are visible to the operator.

Manage the registry through typed CLI commands:

```bash
ade projects list --text
ade projects add /path/to/project
ade projects remove project_abc123…
ade projects touch project_abc123…
ade init                           # adds the cwd as a project
ade init /path/to/project          # adds an explicit path
```

…or call the same JSON-RPC methods directly:

```text
projects.list   { } -> ProjectRecord[]   # each record also carries a host-resolved icon
projects.add    { rootPath } -> ProjectRecord
projects.remove { projectId } -> { removed }
projects.touch  { projectId } -> ProjectRecord
```

`projects.list` stamps each returned record with an `icon: { dataUrl, sourcePath, mimeType }` resolved on the host (`resolveRemoteProjectIcon` in `src/services/projects/projectIconResolver.ts`) — a best-effort, electron-free icon lookup (`.ade/ade.yaml` override, conventional icon/logo files, `index.html` `<link rel="icon">`, capped at 2 MB) so a desktop connected over the remote runtime can show the real project logo in its tab instead of a blank folder. A per-project resolution failure degrades to a null icon and never breaks the list.

Adding a project creates `<rootPath>/.ade/` if needed but does not run any heavy onboarding. The first project-scoped JSON-RPC call lazily builds an `AdeRuntime` for that root via `ProjectScopeRegistry`.

## RPC surface

The runtime exposes two layers of JSON-RPC methods (`src/multiProjectRpcServer.ts`):

**Runtime-scoped** — no `projectId` required:

```text
ade/initialize   ade/initialized   ping   shutdown   exit
runtime/info     machineInfo.get
account.call     attention.call
projects.list    projects.add      projects.remove   projects.touch
projects.browseDirectories         projects.getDetail
projects.getWorkSummary            projects.getDefaultParentDir
projects.getHandoffStoragePreflight
projects.create  projects.clone    projects.listMyGitHubRepos
personalChats.call                 personalChats.streamEvents
runtimeEvents.subscribe   runtimeEvents.unsubscribe
sync.getStatus            sync.refreshDiscovery
sync.listDevices          sync.updateLocalDevice
sync.connectToBrain       sync.disconnectFromBrain
sync.forgetDevice
sync.getTransferReadiness sync.transferBrainToLocal
sync.getPin   sync.setPin   sync.clearPin
sync.setActiveLanePresence
sync.getCloudRelayStatus
sync.getRequireDpop       sync.setRequireDpop
sync.authorizeSshPairing
```

`account.call` owns machine-scoped account status, login, token, and machine
directory operations. Prefer the typed `ade login`, `ade auth status`,
`ade account token create`, `ade machines list`, and `ade machines connect`
commands; they select the CTO role where credential-bearing operations require
it and keep account-machine pairing on the DPoP-bound runtime path.

`attention.call` is the CTO-gated account-wide Activity surface backing `ade
code`'s `/activity` pane (`getSnapshot`, `getMachineSnapshot`, `acknowledge`,
`reportPresence`, `getPreferences`, `putPreferences`). `attention` stays as the
frozen wire identifier for the method, the action domain, and the item ids even
though the product surface is now called Activity. Agents on a desktop endpoint
reach the same operations through `ade actions run attention.<action>`.

`runtimeEvents.subscribe` returns `eventEpoch`, `nextCursor`, `hasMore`, `gap`, and `oldestCursor`; when `gap` is true, the caller's cursor predates the retained buffer and it should refresh state before resuming from `oldestCursor` / `nextCursor`.

`personalChats.call` dispatches the machine action registry advertised as
`capabilities.personalChats` during initialization. It owns chats outside every
project and includes lifecycle, model, input/approval, attachment, and personal
terminal actions. Typed CLI commands use `ade chat … --personal`; use
`ade chat actions --personal` and `ade chat action --personal <action>
--input-json '{...}'` for the complete low-level registry. These commands require
the machine brain (which can run headlessly without desktop UI) and also work
through the `ade rpc --stdio` transport used by remote desktops. The one-shot
global `--headless` mode is not supported because its in-process runtime exits
with the command.

**Project-scoped** — every other request must carry `params.projectId`. `ade/actions/call` (and the legacy ADE action / tool catalog underneath it) is dispatched into the per-project `ProjectScope` returned by `ProjectScopeRegistry.get(projectId)`.

`ade/initialize` advertises `runtimeInfo.multiProject: true` and `capabilities.projects: true`. Clients use that to switch between sending `projectId` per request (multi-project runtime) and the legacy per-process binding (embedded runtime). Sync is owned by the sync service for the most-recently-opened registered project; `ProjectScopeRegistry.ensureSyncHost` refreshes the active sync project when projects are added or removed.

The `sync.connectToBrain`, `sync.disconnectFromBrain`, and `sync.transferBrainToLocal` RPC names are legacy wire identifiers. New prose should call this runtime connection, disconnection, and sync authority transfer.

## Credentials

`src/services/credentials/credentialStore.ts` owns the machine-scoped credential store under `~/.ade/secrets/`:

- Desktop uses `ElectronSafeStorageCredentialStore`, which encrypts `credentials.safe.enc` with Electron `safeStorage` and migrates legacy file-encrypted stores on first read.
- Headless CLI fallback uses `EncryptedFileCredentialStore`, which keeps `credentials.json.enc` encrypted with AES-256-GCM and serializes read-modify-write access with `credentials.json.enc.lock`.
- Secret directories are created with mode `0700`; credential blobs, lock files, and legacy machine keys are written with mode `0600`.
- Account-machine adoption uses a long-lived Ed25519 identity in `machine-identity-signing.json`. The file is created atomically with mode `0600`; only its raw 32-byte public key is published to the account directory.

`ade login`, `ade logout`, and `ade auth status` operate on the daemon-owned ADE
account session in that store. Installed ADE uses the production Clerk
application and production account directory without project configuration;
the ADE repository's development Clerk secrets select the isolated development
tenant during source work. `ade machines list` reads the matching authenticated
account directory; signed-out users get a local-first message and existing
local, PIN, explicit-address, and saved SSH paths remain available. Machine keys
and device IDs are stable selectors. A display name is accepted only when it is
unambiguous; otherwise the command prints the matching stable machine keys.
Directory presence is a short-lived hint: a machine with a directory-verified
relay endpoint remains connectable after its most recent heartbeat expires.
Machines without a verified route remain listed but unavailable.
When a directory row contains `pubkey: "ed25519:<raw-base64>"`, account
adoption verifies the host signature and seals the bearer, DPoP proof, and
returned paired secret over verified LAN, tailnet, or relay routes. Rows
without a published key retain the legacy WSS-relay-only account path.
Targets and paired credentials created through `ade machines connect` belong to
that account and are removed on sign-out or account switch. Direct PIN, SSH, and
explicit-address pairings remain local and are not converted into account-owned
records when the user later signs in.

## `ade code`

`ade code` launches the terminal-native ADE Work chat (Ink + React, in `src/tuiClient/`). Default behavior:

```bash
ade code                           # attach to the machine brain, auto-spawn it if missing
ade code --embedded                # force the in-process embedded runtime
ade code --print-state             # smoke-test the connection and exit
ade code remote --target mac --project ADE
                                   # attach to a saved paired or SSH remote machine
ade code remote --target mac --route tailscale --project ADE
                                   # require a paired Tailscale path; auto also tries LAN then Relay
ade code remote session --target mac --project ADE --session chat-1
                                   # open a remote chat or provider CLI terminal session
ade login                          # sign in to the optional shared machine account
ade machines list --text          # list account machines, including offline state
ade machines rename <machine-key> "Build Mac"
                                   # set the account-wide display name
ade machines rename <machine-key> --clear
                                   # clear it and use the reported hostname
ade machines connect <machine-key> --project ADE
                                   # pair if needed, then open ADE Code on that machine
ade --socket /path/to/ade.sock code   # attach to a specific local endpoint
ade --project-root /repo code      # bind to a specific project root
```

`ade code remote` reads the same saved remote-machine registry as desktop ADE,
then uses the target's declared transport. Paired targets connect through the
DPoP-bound sync runtime bridge; SSH targets start `ade rpc --stdio` over a
validated SSH route. Relay routes are available only while both machines are
signed into the same ADE account; direct LAN and tailnet routes remain usable
signed out. Interactive launches always show the machine picker, even when
only one target is saved; scripts can continue selecting a single saved target
implicitly or pass `--target`. Paired targets use LAN → Tailscale → Relay
failover by default. `--route lan`, `--route tailscale`, and `--route relay`
constrain the connection to one path and never silently downgrade to SSH.
Account-created targets are paired-only, are removed when their
account signs out or switches, and fail closed instead of falling back to SSH
or a plaintext address. Legacy account machines
that desktop ADE saved as uncredentialed SSH targets are adopted into the same
paired store before launch; if the account directory cannot verify that legacy
shape, ADE fails closed instead of attempting SSH. Explicit SSH targets keep
their saved host alias so OpenSSH can apply its `Host`-scoped user, identity,
agent, and proxy settings
while ADE changes only the concrete route. Route/runtime probing shares one
bounded, cancellable connection deadline and reports the attempted failures.
After a true SSH connection initializes, desktop ADE runs the internal
`ade sync pair-device --json-stdin` command on that exact selected channel home
to exchange the controller's DPoP identity for a normal paired-machine secret.
The JSON request is bounded and never appears in argv. A packaged Beta runtime
that uploads successfully but cannot initialize does not end the attempt: ADE
probes Stable and the other channel homes, retains the first compatible home,
and uses that same home for `pair-device` and all follow-up commands.
The launcher bridges the selected transport back into the normal TUI with
`--remote`, `--remote-label`, `--require-socket`, remote project roots, and an
optional `--session` hint. Use `--list-targets`, `--list-projects`, and
`--list-sessions` for non-interactive discovery.

**Browser mirror (dev):** from the repo root, `npm run dev:code:web` runs **one** `ade code` in a **single PTY** and mirrors that TTY to the browser (xterm). Use Cursor’s browser tools against that page like any other local URL. This is not the same as running `ade code` in a terminal app **and** in the browser at once—that would be two separate processes.

See `docs/features/ade-code/README.md` for the full attach/embedded handshake, slash command catalog, and right-pane drawers.

## `ade rpc --stdio`

`ade rpc --stdio` attaches to the local machine brain (auto-spawning it if needed) and bridges its JSON-RPC over stdio. The remote-runtime path on the desktop runs `ade rpc --stdio` over an SSH `exec` channel; see `docs/features/remote-runtime/internal-architecture.md` for the protocol shape and bootstrap sequence.

## `ade desktop`

`ade desktop` opens the installed ADE app from the terminal. On macOS it runs `open -a "ADE"` (or `ADE Beta` / `ADE Alpha` based on `ADE_PACKAGE_CHANNEL` / `ADE_DESKTOP_APP_NAME`). The desktop attaches to the same machine brain; if the brain is not running, the desktop spawns and waits for it via `LocalRuntimeConnectionPool`.

## CLI surface (selected)

```bash
ade desktop
ade brain status --text
ade brain start
ade brain stop
ade brain restart
ade connect                               # account + login service + account-directory row, idempotent
ade connect --status --text               # report the three steps without changing anything
ade connect --headless                    # force the copy-paste device flow
ade connect --no-login --no-service       # opt out of either half
ade login                                 # loopback OAuth, or device flow on SSH/headless hosts
ade login --headless                      # print verification URL + user code
ade auth status --text                    # account identity + loopback/device/env-token source
ade account token create --text           # print a self-contained durable ADE_ACCOUNT_TOKEN once
ade logout
ade machines list --text
ade machines connect <machine-key> --project ADE
ade machines hop <device-id> --session chat-1
ade doctor --json
ade doctor --online --text                        # also check the latest desktop release over the network
ade tools status --text                           # pinned agent CLIs: installed version + entry path per tool, plus the machine tools root
ade tools ensure --text                           # fetch whatever this build pins and is missing (no names = all); streams progress to stderr
ade tools ensure codex --text                     # one tool; an unknown name is a usage error listing the pinned set
ade tools gc --dry-run --text                     # drop cached versions this build no longer pins (keeps the newest superseded one)
ade projects list --text
ade projects inspect /path/to/checkout --json   # classify a path (repo root vs linked/ADE-managed worktree) and find its owning project + existing lane
ade init
ade lanes list --text                             # every git worktree of the project is a lane: this reconciles against git on each call, adopting worktrees made outside ADE and dropping lanes whose worktree is gone from git and disk. There is no attach/adopt step
ade lanes import --branch feature/login --text    # lane for an existing branch, checked out in a new managed worktree; refuses when that branch is already checked out (that worktree is already a lane)
ade lanes create "fix-checkout-flow" --parent main
ade lanes create "fix-login" --base origin/main   # omit --base to branch from the configured new-lane base (remote-first by default)
ade lanes child --lane lane-parent --name fix-followup            # child lane carries the parent's unmerged work; a base-less `ade lanes create`/`--auto-create-lane` from a lane with commits not yet on main prints a non-blocking stderr nudge to use this instead
ade lanes create "lin-123" --linear-issue-json '{"id":"...","identifier":"LIN-123","title":"...","projectId":"...","projectSlug":"...","teamId":"...","teamKey":"...","stateId":"...","stateName":"Todo","stateType":"unstarted","priority":2,"priorityLabel":"high","labels":[],"assigneeId":null,"assigneeName":null,"createdAt":"...","updatedAt":"..."}'
ade lane drift --lane lane-id --text              # did someone `git checkout` inside the worktree? compares live HEAD to the lane's recorded branch
ade lane drift resolve --lane lane-id --switch-back        # put the worktree back on the lane's branch (refuses on a dirty tree)
ade lane drift resolve --lane lane-id --keep-head          # re-point the lane (and its name) at the live HEAD branch
ade lane drift resolve --lane lane-id --keep-head --expected-head hotfix-auth --force   # --expected-head guards a stale read; --force acknowledges active work
ade lanes reparent lane-child --parent lane-parent --stack-base-branch main
ade lanes reclaim-preview lane-id --text                   # show reclaimable space and anything that needs review
ade lanes archive-and-reclaim lane-id --confirm RECLAIM    # preserve lane history/branch/chat; remove ADE-managed local files
ade lanes unarchive lane-id                                # restore the lane; recreate its managed worktree when needed
ade lanes delete lane-id --force --delete-branch
ade lanes create-from-linear --issue-id ENG-431 --start-chat --provider codex --model <model> --no-parent
ade lanes batch-create-from-linear --linear-issues-json '[{"id":"...","identifier":"ENG-431"},{"id":"...","identifier":"ENG-440"}]'
ade chat attach-linear-issue <session> --issue-id ENG-431
ade chat create --from-linear-issue ENG-431 --no-parent
ade chat list --personal --text
ade chat create --personal --provider codex --model openai/gpt-5.5 --prompt "Plan a trip"
ade chat steer personal-session-id --personal --text "focus on the tradeoffs"
ade chat interrupt personal-session-id --personal --keep-queue
ade chat restore-queue personal-session-id recovery-id --personal
ade chat actions --personal --text
ade chat action --personal modelCatalog --input-json '{"mode":"cached"}' --json
ade linear attach --this-session --issue-id ENG-431   # attach to the current CLI session ($ADE_CHAT_SESSION_ID)
ade linear comment "Pushed a fix; CI running"          # write back through the attached runtime
ade linear set-state ENG-431 <state-id>
ade --role cto linear quick-view --text
ade --role cto linear search-issues --query "auth" --state-type started,unstarted --first 50
ade --role cto linear issue-comments --issue-id <linear-issue-uuid>
ade git commit --lane lane-id
ade git push --lane lane-id
ade git pull --lane lane-id --rebase
ade git undo --lane lane-id
ade git redo --lane lane-id
ade git tag abc123 --name v1.0.0 --lane lane-id
ade git reset abc123 --soft --lane lane-id
ade git is-reachable abc123 --lane lane-id
ade git branches --lane lane-id --text
ade git user-identity --lane lane-id --text
ade history list --lane lane-id --status succeeded --text
ade history show --id operation-id --text
ade history commits --lane lane-id --text
ade history export --lane lane-id --out history.json
ade diff patch --lane lane-id --path src/file.ts --text
ade search "login redirect" --text                          # active-project search plus bounded chat hits from every registered project
ade search "flaky test" --kind chat,terminal --lane fix-login --text  # exit 1 when nothing matches
ade search --status --text                                  # index doc counts, backfill state, index path
ade prs create --lane lane-id --base main --title "Fix checkout flow" --text  # prints GitHub + ADE PR URLs
ade prs create --lane lane-id --base main --close-linear-issue-on-merge
ade prs list-open --text
ade prs github-snapshot --include-external-closed --history-page-limit 4
ade prs github-snapshot --include-state-counts --no-revalidate
ade prs checks pr-id --text                                 # header carries the canonical rollup (checksStatus/checksCounts); "not run" means nothing verified the commit, whatever the rows say
ade prs comments pr-id --text
ade shell start --lane lane-id -- npm test
ade terminal list --lane lane-id --text
ade terminal resume --terminal session-id --text
ade new chat --mode chat --lane lane-id --provider codex --model openai/gpt-5.6-sol --no-parent --reasoning-effort xhigh --no-fast --permissions full-auto --prompt "fix failing tests"
ade new chat --mode cli --lane lane-id --provider codex --model openai/gpt-5.6-sol --no-parent --reasoning-effort xhigh --no-fast --permissions full-auto --prompt "fix failing tests"
ade new chat --mode chat --lane auto --lane-name fix-checkout-flow --no-parent --prompt "fix failing tests"
ade new chat --mode chat --lane lane-id --type subagent --prompt "repro the flake"   # required for parented spawns; use subagent for any result the parent will join/read/review, peer only for fire-and-forget work
ade new chat --mode cli --lane lane-id --provider codex --type peer --parent chat-session-id --prompt "review the diff"   # agent-provider CLI sessions record spawn lineage without becoming attached terminals; shell sessions do not record lineage
ade chat list --lane lane-id --include-automation --no-archived --text
ade chat create --lane lane-id --provider codex --model openai/gpt-5.6-sol --no-parent --permissions full-auto --print-config --json
ade chat create --lane lane-id --provider codex --no-parent   # tracked agent shells inherit $ADE_CHAT_SESSION_ID; parented launches must add --type subagent|peer, while --no-parent deliberately opts out
ade chat read session-id --limit 20 --max-chars 8000 --text
ade chat read session-id --page --cursor 4096 --limit 20 --max-chars 8000 --text
ade chat message session-id --kind auto --text "status/context"
ade chat steer session-id --text "active-turn context"
ade chat note "testing desktop auth fallback"               # update Work status (aim for 6 words or fewer; truncated past 72 characters); add --session <id> to target explicitly
ade chat ask "Which account should I use?"                 # escalate a blocking question; add --session <id> to target explicitly
ade session show session-id --text                          # settle/snooze state, and why a snoozed row came back
ade session snooze session-id --for 1h                      # 30m|1h|4h|1d|1.5h; a bare number means minutes; relative durations cap at 30d
ade session snooze session-id --until 2026-07-26T18:00:00Z  # explicit ISO-8601 deadline (must be in the future)
ade session snooze session-id --until-asked                 # open-ended, matching the desktop/iOS "Until I'm asked" preset: only a hand-raise brings it back
ade session wake session-id --reason manual                 # timer|needs_you|error|turn_complete|manual
ade session clear-woke session-id                           # drop the "woke early" marker after visiting the row
ade session actions --text                                  # raw session service actions
ade chat schedules session-id --pause              # pause this agent session's durable wakeups/cron/loops (omit flag to inspect, --resume to re-arm)
ade chat scheduled-work list [session-id] --all     # list durable jobs; --all includes recent terminal history
ade chat scheduled-work create --in 12m --prompt "Check CI and report" --reason "CI check" --session session-id              # safest one-shot form; omit --session inside the bound agent
ade chat scheduled-work create --at "2026-07-23T01:05:00-04:00" --prompt "Check CI and report"                           # absolute one-shot; explicit offset or Z required
ade chat scheduled-work create --cron "9,29,49 * * * *" --prompt "Check CI and report" --once                         # five-field cron uses the ADE brain machine's local timezone
ade chat scheduled-work cancel session-id job-id    # cancel one job; Claude-native jobs request CronDelete in the owning chat
ade chat wait session-id --for idle --timeout-ms 600000
ade chat recover session-id --turn turn-id --action nudge        # provider-neutral wait | nudge | retry | resume; falls back for older Codex brains
ade chat resolve-unprocessed session-id --steer steer-id --action run-next  # durable/idempotent; action is run-next | dismiss
ade chat handoff session-id --model openai/gpt-5.6-sol --note "focus on tests"   # brief handoff; add --target-lane <lane-id> to hand off into another lane
ade chat fork session-id --model openai/gpt-5.6-sol              # fork provider history (claude/codex/opencode/droid); stays in source lane
ade chat models --provider codex --json                          # model order + supported reasoning tiers
ade code
ade code --embedded
ade tests run --lane lane-id --suite unit --wait
ade proof list --arg ownerKind=chat --arg ownerId=session-id
ade proof attach shots/result.png --caption "Checkout complete"
ade proof rm artifact-id
ade proof broken --text                              # list missing/unimported proof records
ade proof recover artifact-id                       # re-import when the original capture still exists
ade proof prune                                      # preview broken records; does not delete
ade proof prune --broken                             # delete every broken proof record
ade proof actions --text                             # full computer_use_artifacts action inventory
ade ios-sim devices --text
ade --socket ios-sim apps --text
ade --socket ios-sim launch --target target-id --text
ade --socket ios-sim preview-match --source apps/ios/ADE/Views/Home.swift --line 42 --text
ade --socket ios-sim preview-ensure --source apps/ios/ADE/Views/Home.swift --line 42 --text
ade --socket ios-sim preview-current --text
ade --socket ios-sim preview-render --source apps/ios/ADE/Views/Home.swift --index 0 --text
ade --socket app-control launch --command "npm run dev" --text
ade --socket app-control focus --text
ade --socket app-control minimize --text
ade --socket browser open http://localhost:5173 --new-tab --text  # ADE-launched chat/terminal capability required
ade --socket browser authorize --tab tab-id --text                # native human grant for the current agent + origin
ade --socket update status --text
ade --socket update check --text
ade --socket update install --text
ade sync security status --text                    # machine sync security posture (require-DPoP)
ade sync security require-dpop on                  # reject paired hellos from devices without a Secure Enclave key
ade sync web --text                                # print the browser web-client pairing link + code (app.ade-app.dev)
ade sync web --open                                # also open the pairing link in the default browser
ade sync web --no-clipboard                        # print only; don't copy the link to the clipboard
ade secrets list --text
ade secrets get STRIPE_API_KEY --text
ade secrets set STRIPE_API_KEY --value sk_...
printf %s "$TOKEN" | ade secrets set TOKEN --stdin
ade secrets set TOKEN --value-file token.txt
ade secrets delete STRIPE_API_KEY
ade usage snapshot --text
ade --role cto usage refresh --text                # live Claude/Codex quota only
ade --role cto usage refresh --history --text      # local provider history + costs
ade usage budget get --text
ade usage budget set --from-file budget.json
ade usage budget check --provider claude --scope global
ade usage budget cumulative --scope global --text
ade storage snapshot --text                          # categorized ADE disk usage + free space (mirrors the desktop storage dashboard)
ade storage snapshot --refresh --text                # force a fresh scan instead of the cached snapshot
ade storage compress --text                          # losslessly compress old chat/terminal history
ade --role cto storage maintenance --text            # run the policy-driven ledger maintenance sweep now (CTO)
ade storage actions --text                           # raw storage service actions (cleanupPreview/cleanup live here)
ade actions list --domain chat --text
ade --role cto actions list --domain attention --text # discover account-wide Activity actions (domain name is a frozen wire identifier)
ade --role cto actions run attention.getSnapshot --input-json '{"since":0}' --json
ade actions run git.stageFile --arg laneId=lane-id --arg path=src/index.ts
ade actions run pty.resumeSession --arg sessionId=session-id
ade actions run external-sessions.list --input-json '{"scope":"project","limit":20}' --text   # claude/codex/cursor/droid/opencode sessions on this machine; discovery that cannot run — `opencode` is not installed, say — fails the call when that provider is the only one asked for, rather than reporting an empty list; in a multi-provider scan it is skipped and logged
ade actions run external-sessions.import --input-json '{"provider":"codex","sessionId":"thread-id","laneId":"lane-1","target":"cli","mode":"resume"}' --text
ade cursor cloud agents list --text
ade cursor cloud agents create --repo https://github.com/owner/repo --prompt "fix flaky test" --auto-pr
ade --role cto github app-auth login              # device-flow authorize the machine ADE GitHub App (headless/brain)
ade github app-auth status --text                 # show whether a GitHub App user token is stored (login, expiry)
ade --role cto github app-auth clear              # remove the stored GitHub App authorization
ade actions run github.getStatus --input-json '{"forceRefresh":true}' --text # show active read/write sources and cooldowns
ade open ade://lane/<lane-uuid>
ade open --linear-issue ADE-123 --branch arul/ade-123-fix
ade link lane <lane-uuid>
ade link file src/index.ts --line 42 --lane <lane-uuid>
ade link commit abc1234 --lane <lane-uuid> --no-envelope
ade link artifact proof-artifact-id
ade link branch owner/repo my-branch --pr 42
ade link pr owner/repo 42 --ade
ade link lane <lane-uuid> --web                     # hosted web-client URL form (app.ade-app.dev/open), mutually exclusive with --ade
ade link linear-issue ADE-123 --branch arul/ade-123-fix
ade linear install
ade skill list --text
ade skill show ade-browser --text
```

GitHub reads try credentials in environment → ADE GitHub App → GitHub CLI →
stored PAT order. Writes skip the read-only GitHub App. `github.getStatus`
reports the active read/write sources, per-credential failure/cooldown state,
fallback details, and any background-refresh pause without exposing tokens.

`ade tools` is deliberately not backed by a service action. The pinned-tool cache
is a property of the machine's filesystem, not of a project runtime, so the
command calls `src/services/tools/` in-process and works on a headless box with
no desktop and no brain running. The desktop's `agentToolsCacheService` is the
same module behind an IPC snapshot feed for onboarding; there is nothing for
`ade actions run` to reach that `ade tools status|ensure|gc` does not already
cover.

Use typed commands first. They validate common arguments and provide stable JSON fields or readable text summaries. Use `ade help <command> <subcommand>` for exact flags, `ade actions list --text` to discover the full service-backed action catalog, and `ade actions run <domain.action>` only when there is no typed command for the workflow yet. For stored project credentials, prefer `ade secrets`; `list` is metadata-only and `get --text` prints the secret value, so agents should read only the named secret the user asked for and avoid logging it.

Output modes are explicit: `--text` for human-readable summaries, `--json` (default for piped output) for stable JSON, and `--pretty` for pretty-printed JSON.

`--socket` requires a specific ADE local endpoint and fails fast when it is missing. Without `--socket`, the CLI auto-attaches to the brain when reachable and falls back to headless for commands that can run that way.

## ADE account auth and `ade doctor`

`ade connect` is the one command that puts a machine on an account. It runs
three idempotent steps and reports each as a checklist line on stderr, keeping
stdout the structured payload (JSON by default, a one-line summary under
`--text`):

1. **account** — reuse a valid session, else delegate to the same `ade login`
   implementation, so the loopback-vs-device decision lives in exactly one place.
2. **service** — install and start this platform's login service when it is not
   already running (launchd / systemd user service / Windows per-user startup
   entry). A refusal caused by running inside the very brain it would replace is
   not treated as a failure.
3. **machine** — wait for this machine's row to reach the account directory.

Step 3 is a wait rather than a write, and that distinction matters: the row is
created by the brain's account-machine publisher, which POSTs to
`/account/machines/register` on sign-in and then every 30s, gated on the brain
holding the machine's sync-host lease and having an active host snapshot. No
one-shot CLI publish exists, so `ade connect` makes the preconditions true and
then polls `listMachines` for its own `machineKey` (from
`~/.ade/secrets/sync-cloud-relay.json`) until a bounded deadline. Because the
publisher lives in the brain, **the brain must keep running for the machine to
stay reachable** — which is what the service step guarantees. The directory
also marks a machine `online` only within a 90s `last_seen_at` window.

ADE accounts are optional; local `ade code`, project, lane, and PIN workflows
remain available while signed out. `ade login` uses Clerk OAuth with a local
loopback callback when a browser is available. `--headless`, SSH sessions, and
display-less Linux hosts use the account-directory device bridge instead: the
CLI prints a verification URL and short code that can be completed in any
browser. If opening the loopback URL fails, the CLI falls back to the same
device flow.

For non-interactive agents and CI, create a durable credential once on
an interactive machine with `ade account token create`, store it in a secret
manager, and expose it as `ADE_ACCOUNT_TOKEN` to the ADE brain/runtime. Newly
provisioned tokens carry the refresh credential plus its public OAuth issuer and
client id in a versioned secret envelope, so the agent/CI host needs no local
Clerk configuration. Raw access tokens are used until their reported JWT expiry.
Legacy opaque refresh tokens still work when local `CLERK_ISSUER` and
`CLERK_OAUTH_CLIENT_ID` are configured; recreate them with the command above to
remove that dependency. ADE never logs this environment value.

Provider credentials, GitHub tokens, Linear tokens, and computer-use policy
remain separate and are read from ADE project settings and their existing
secure stores.

`ade doctor` inspects the installed app and machine-brain health and prints one
status row (`ok` / `warn` / `fail`) per check. It exits non-zero when any row is
`fail`. The rows are:

- **App** — the installed ADE desktop version (read from the `.app` bundle on disk) against the latest known version. Latest-known comes from the on-disk `update-status.json` by default; pass `--online` to also fetch the latest release from GitHub (short timeout, best-effort). `warn` when the install is behind or missing.
- **Brain** — whether the machine brain responds on its socket, plus its version, pid, and uptime. `fail` when it is not responding or when its build identity does not match the expected runtime for this CLI/role.
- **Wedge history** — the last brain-loop watchdog wedge that was recovered (blocking command and how long it blocked), read from the runtime dir or the brain's reported `lastWedge`. `warn` when the most recent wedge is within the last 24h.
- **Sync port** — the sync host port the brain bound. `ok` on the default port, `warn` when bound elsewhere (with the base-port holders it found), `fail` when the brain is up but reported no port.
- **Publish health** — account-directory publish state from the brain's sync route health. `ok` when a publish succeeded recently, `fail` when it has been failing for ≥2 min, otherwise `warn`, with the slowest publish leg annotated.
- **Relay** — relay route health as already computed by the brain. `ok` when the relay control is connected, the bridge is validated, and the end-to-end round-trip is verified; `fail` when the route is not fully validated; `warn` when relay is disabled or route health is unavailable. When another ADE process on this machine has claimed the relay slot, the brain deliberately stops redialing and this row reports that suppression ahead of any lower-level close error, so the detail names the fix (quit the rival process) instead of the symptom. `ade sync status --text` shows the same reason on its `relay` line, plus a `relay failing since` row for how long the current outage has run.
- **Account** — whether this machine's brain is signed in to an ADE account (and the credential source), read via the brain's `account.call status`. `warn` when signed out or unavailable.

Default doctor does not call provider, GitHub, or Linear networks — it talks only
to the local brain over its socket, and never prints secret values. The one
optional network touch is the `--online` desktop-release lookup above.

Agents starting an unfamiliar ADE session should begin with:

```bash
ade doctor --json
ade actions list --text
```

…then prefer typed commands such as `ade lanes list --text`, `ade files read <path> --text`, `ade prs checks <pr> --text`, or `ade tests runs --json`. Use `ade actions run …` as the broad escape hatch.

## Repo development

The installed `ade` command is the production CLI. Repository development uses root npm scripts so the command always runs the CLI and desktop code from this checkout, not whichever `ade` happens to be first on `PATH`.

```bash
npm run setup
npm run dev:desktop
npm run dev:code
npm run dev:runtime
npm run dev:stop
```

The dev scripts run the same ADE runtime from source against a temporary endpoint so a packaged ADE on the same machine is not affected:

```text
/tmp/ade-runtime-dev.sock
```

From an ADE lane checkout under `.ade/worktrees/`, the dev scripts keep using
that lane's source code, but default the ADE project root back to the primary
checkout. `npm run dev:code` also passes the lane checkout as the workspace root
so initial lane selection matches `ade code` launched directly from the lane.

Full matrix:

```bash
npm run dev:desktop          # desktop only; dev endpoint; desktop may auto-create runtime
npm run dev:desktop:attach   # desktop only; fail unless dev runtime is already running
npm run dev:desktop:clean    # desktop only; clear Vite cache before launch
npm run dev:code             # terminal TUI only; starts dev runtime if missing
npm run dev:code:attach      # terminal TUI only; fail unless dev runtime is already running
npm run dev:runtime          # runtime only in the foreground
npm run dev:all              # start shared dev runtime, then use attach commands in separate terminals
npm run dev:stop             # stop the dev runtime
npm stop dev                 # same as dev:stop
```

Local packaged builds are separate from dev-mode scripts:

```bash
npm run package:alpha        # current checkout -> ADE Alpha.app, ade-alpha, ~/.ade-alpha
npm run package:beta         # origin/main -> ADE Beta.app, ade-beta, ~/.ade-beta
```

Use these when you want a production-shaped local app without going through the GitHub release workflow. Alpha builds from the current checkout under `apps/desktop/release-alpha`; beta fetches `origin/main`, fast-forwards the local `main` checkout when possible, and writes artifacts under `apps/desktop/release-beta`. Use the dev scripts when you want Vite/Electron live reload, the temp dev endpoint, and the dev-only Electron profile. Local channel packages include the current machine's runtime binary. GitHub release builds use and validate the full cross-platform runtime artifact set.

## Automations

Automation rules are managed with `ade automations <subcommand>`. Run `ade help automations` for the full flag reference. The lane-mode flags layer on top of `--from-file` / `--stdin` / `--text` for `create` and `update`:

```bash
# Open a fresh lane for every new GitHub issue, naming it from the issue number + title.
ade automations example > rule.json
ade automations create --from-file rule.json \
  --lane-mode create --lane-name-preset issue-num-title

# Reuse an existing lane instead.
ade automations create --from-file rule.json --lane-mode reuse --lane lane-42

# Custom template (only valid with --lane-name-preset custom).
ade automations create --from-file rule.json \
  --lane-mode create --lane-name-preset custom \
  --lane-name-template "{{trigger.issue.author}}/{{trigger.issue.title}}"

# Filter run history by status.
ade automations runs --rule rule-1 --status failed
ade automations run-show <runId> --text

# Linear webhook ingress (setup/teardown are CTO-only).
ade automations linear-ingress status --text
ade --role cto automations linear-ingress connect
ade automations linear-ingress poll --text
ade --role cto automations linear-ingress disconnect

# Scheduled lane cleanups (from delete-lane actions with afterMinutes).
ade automations cleanups list --text
ade automations cleanups cancel <cleanupId>
```

The standalone `create-lane` action is deprecated. By default the CLI auto-migrates a rule whose first action is `create-lane` into `execution.laneMode: "create"` and carries the template forward. Pass `--allow-legacy` on `create` / `update` to opt out of the migration.
