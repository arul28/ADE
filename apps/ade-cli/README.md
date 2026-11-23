# ADE CLI

`apps/ade-cli` owns the `ade` command, the ADE brain and the manual runtime entry points.

- The **brain** is the always-on, machine-owned ADE process for one channel. It is the source of truth on a machine for lanes, agent chats, work sessions, PR state, sync, proof and the project catalog. Desktop ADE, the web client, the iOS app and SSH-attached desktops attach to it.
- A **manual runtime** is a foreground process you start for dev and test work instead of the brain service.

## Modes

- **Attached brain.** The brain listens on `$ADE_HOME/sock/ade.sock` (POSIX) or `\\.\pipe\ade-runtime` (Windows). Other commands and clients open that endpoint and speak ADE JSON-RPC.
- **Manual runtime** (`ade runtime run`). A foreground process on an explicit endpoint, with sync always off. `--profile embedded` runs it as a guest of an external embedder (`@ade-dev/sdk`); see [Internal process command](#internal-process-command).
- **Headless** (`--headless`). The CLI builds an in-process `AdeRuntime` for one project and answers the same JSON-RPC directly: for one-shot commands, and as a fallback when no brain is available.
- **`ade rpc --stdio`.** Attaches to the local brain and bridges its JSON-RPC over stdio; the desktop's remote runtime runs it over SSH.

Default routing: use the brain endpoint when it answers, start the brain when the endpoint does not exist, and fall back to headless for commands that need no shared live state. `--socket` requires one endpoint and fails fast when it is missing; `--headless` forces in-process execution.

## Machine layout

`resolveMachineAdeLayout()` (`src/services/projects/machineLayout.ts`) is the one source for per-machine paths. `ADE_HOME` overrides the root.

| Path | Purpose |
| --- | --- |
| `~/.ade/` | Per-machine ADE state root for the stable channel. |
| `$ADE_HOME/sock/ade.sock` | ADE brain local endpoint (POSIX). |
| `\\.\pipe\ade-runtime` | ADE runtime named-pipe endpoint (Windows). |
| `$ADE_HOME/projects.json` | Project catalog. |
| `$ADE_HOME/personal-chats/` | Machine-owned projectless chat runtime state, hidden workspace, transcripts, and attachments. |
| `~/.ade/secrets/` | Machine credential store (`credentials.safe.enc` for desktop safeStorage, `credentials.json.enc` plus `.machine-key` for headless fallback storage, per-store `*.lock` files, and the Ed25519 `machine-identity-signing.json` used by account adoption). |
| `$ADE_HOME/account-settings.json` | Machine cache for account-scoped settings; settings survive sign-out. |
| `$ADE_HOME/account-vault.json.enc` | Encrypted machine cache for account-scoped credentials; the cache is purged on deliberate sign-out. |
| `~/.ade/bin/ade` | Bundled static runtime binary (release installs / remote uploads). |
| `~/.ade/agent-skills/` | Bundled, version-locked ADE agent skills. Desktop remote bootstrap uploads this beside the remote runtime; CLI launch then re-seeds ADE-managed skills into runtime-native home skill directories. |
| `~/.ade/runtime/<platform-arch>/` | Native node modules for that runtime binary. |
| `~/.ade/cache/desktop/` | Partially downloaded desktop installer, kept between `ade setup` runs so an interrupted 1 GB download resumes. Deleted once the install succeeds. |
| `~/.ade/runtime/launchd.{out,err}.log` | Runtime stdout/stderr when running as a login service on macOS. |

Per-project state stays under `<project>/.ade/` (`projectConfigService`; see `docs/features/onboarding-and-settings/configuration-schema.md`). A project's secrets live in Passwords & Secrets (the account vault, plus "this computer only" secrets in the machine's encrypted cache): those for every project, then the project's own. `ade secrets` and the `project_secret` action domain are the project's view. An old `.ade/secrets/project-secrets.v1.enc` moves in the first time the project opens.

Channels use parallel state roots and binary names, so Stable, Beta and Alpha can coexist:

```text
ADE.app        -> ade        -> ~/.ade        -> ade-desktop
ADE Beta.app   -> ade-beta   -> ~/.ade-beta   -> ade-desktop-beta
ADE Alpha.app  -> ade-alpha  -> ~/.ade-alpha  -> ade-desktop-alpha
```

Source dev launches use the temp dev endpoint and the `ade-desktop-dev` Electron profile.

## Install paths

1. **Standalone runtime install**: one static binary plus its native archive from a GitHub release, for headless macOS/Linux servers and Windows x64.

   ```bash
   curl -fsSL https://github.com/arul28/ADE/releases/latest/download/install.sh | sh
   ```

   ```powershell
   irm https://github.com/arul28/ADE/releases/latest/download/install.ps1 | iex
   ```

   `install.sh` accepts `ADE_VERSION=vX.Y.Z` (default `latest`), `ADE_INSTALL_DIR` (default `$ADE_HOME/bin`), `ADE_RELEASE_REPO=owner/repo`, `ADE_HOME`, `ADE_INSTALL_NO_PROMPT=1` (no sign-in or desktop offers) and `ADE_INSTALL_NO_PATH=1` (write `$ADE_HOME/env`, edit no profile). For an unpublished Windows proof bundle, run `install.ps1 -AssetDirectory <dir>` (or `ADE_RELEASE_ASSET_DIR`).

   - Both scripts download the binary (`ade-<platform-arch>` → `$ADE_INSTALL_DIR/ade`, `ade-win32-x64.exe` → `ade.exe`), verify it and its `.native.tar.gz` against `SHA256SUMS`, extract native deps under `$ADE_HOME/runtime/<platform-arch>/`, run `ade --version`, and register the login service with `ade brain start`.
   - Register with `ade brain start`, never `ade serve --install-service`: only `ade brain start` pins the default role to `cto`, which `ade connect` and the desktop need. `serve --install-service` lands on `agent`, and sign-in fails.
   - PATH: the PowerShell script adds the folder to the user `PATH` (idempotent, then `WM_SETTINGCHANGE`). The POSIX script writes `$ADE_HOME/env` (a guarded prepend) and, with consent on a tty, one marker block (`# >>> ade >>>` … `# <<< ade <<<`) in `~/.zshrc` (`~/.zprofile` only when no `~/.zshrc`), `~/.bash_profile` (bash on macOS) or `~/.bashrc` (Linux). It checks the marker first, so a re-run (also the update path) never duplicates it. fish and unknown shells are never edited; the script prints the line to add. `-NoPath` / `ADE_INSTALL_NO_PATH=1` skip PATH, `-NoService` skips the service.
   - Then both hand off to `ade setup --continue …` with what they did, so one TypeScript flow finishes on both platforms.

   `ade setup`:

   - Downloads the pinned agent CLIs this machine shows signs of using (a login file, a token, or the vendor CLI on the PATH) into the machine cache. This is not fatal: the brain retries on every `ade serve`, and other pins download on first use. ADE always runs its own pinned copies, never a CLI on the PATH.
   - Handles the account: a linked machine gets keep / switch / skip.
   - Installs the desktop app (macOS `.zip` via `ditto`, Windows NSIS `/S` per-user), verified against the base64 SHA-512 in `latest-mac.yml` / `latest.yml` (`SHA256SUMS` covers only the runtime assets). The download resumes with a Range request, is skipped when that version is installed, and the app starts detached.
   - Ends with a check (brain reachable, machine linked) and a summary. A failed step prints its fix inline and under "What's left". Prompts read `/dev/tty` on POSIX; with no terminal both scripts pass `--no-prompt` and print the follow-up commands (`install.ps1 -NoPrompt` too). Re-run `ade setup` at any time.

2. **Desktop bundle**: every packaged app ships the CLI at `/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade`. Run `…/ade-cli/install-path.sh` once to put `ade` (or `ade-beta` / `ade-alpha`) on `PATH`; the wrapper runs the CLI under the packaged Electron, so no separate Node is needed. Settings › General has Install / Repair (`AdeCliSection`, `window.ade.adeCli.installForUser()`).

3. **Source build**: `cd apps/ade-cli && npm run build && npm link` (or `npm pack` and a global install). It needs Node.js 22.19 or newer (the headless runtime embeds the Node that Pi's SDK worker uses).

## Service manager

The brain runs as a per-user login service (`src/serviceManager/`).

| Platform | Backend | Service path |
| --- | --- | --- |
| macOS | launchd `LaunchAgent` | `~/Library/LaunchAgents/com.ade.runtime.plist` |
| Linux | `systemctl --user` | `~/.config/systemd/user/<ADE_RUNTIME_SERVICE_NAME>.service` |
| Windows | HKCU `Run` entry + PowerShell supervisor | `HKCU\...\CurrentVersion\Run` value `ADE Runtime (<channel>-<hash>)` |

- The label is `com.ade.runtime`; `ADE_PACKAGE_CHANNEL=alpha|beta` gives `com.ade.runtime.alpha` / `.beta`, and `ADE_RUNTIME_SERVICE_NAME` overrides it.
- On Windows the label and user give a qualified Run-value name, launcher, PID record and named pipe. The Run value starts a hidden PowerShell supervisor; an initialized IPC response is the readiness record. Scheduled Tasks are legacy state that install and uninstall clean up.
- macOS writes `launchd.{out,err}.log` under `ADE_HOME/runtime/`.

### Windows: how the always-on guarantee is actually obtained

Windows has no unelevated service that both starts at login and survives the session that started it, so ADE builds the two halves apart.

- **Login persistence** is the HKCU `Run` key. An ONLOGON scheduled task needs elevation (`schtasks /Create /SC ONLOGON` and `Register-ScheduledTask -AtLogOn` give *Access is denied*).
- **Session survival.** A child process joins its parent's [job object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), and the `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` jobs of terminals, editors, CI agents and Electron do not allow breakaway. So a supervisor started as a plain child of `ade brain start` dies with that session. Something else must create it, in this order:
  1. **A transient one-shot scheduled task** (no elevation). Task Scheduler starts the supervisor under `svchost.exe`, outside our jobs; the task is removed once it starts.
  2. **`Win32_Process.Create` over WMI** when task registration is refused. `WmiPrvSE.exe` creates the process in no job. It is second because endpoint protection blocks WMI process creation more often.
  3. **An in-session launch** when both are refused: the brain runs, but only for that session.
- At sign-in `explorer.exe` (job-free) runs the `Run` entry, so none of this is needed.

**The limitation.** When a machine refuses both handovers, the brain dies when the terminal, editor or agent that started it exits, and returns at the next sign-in. The supervisor probes its own job on startup (`QueryInformationJobObject`, checking `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) and writes `sessionBound` in its PID record; `ade brain start` and `ade brain status` say so. It describes the running supervisor, so it clears once `explorer.exe` starts it at the next sign-in. `null` means the probe could not run.

`ade brain update` follows the machine's update track (`~/.ade/update-track.json`): on Beta, "latest" is the Beta feed's build, never Stable (and the reverse). A `--version` is used as given. When the saved track and the running build's track differ (an unfinished switch), "latest" is refused; finish the switch in Settings › About or pass `--version`.

The service runs the `ade` binary that installed it, so it stays on that channel. Release installs use `$ADE_HOME/bin/ade` (`ade.exe`), so `ade brain update` can stage the next release under `$ADE_HOME/runtime/updates/`, verify it against `SHA256SUMS`, promote the binary and native deps atomically, and restart the service with the desktop closed.

- On Windows, update stops the process before it replaces the executable, restores the old executable, native tree and service when promotion fails, and leaves staging cleanup until the helper exits (file locks). A failed rollback keeps the recovery files and reports them.
- After a packaged desktop update, ADE refreshes the service, so the brain re-execs the updated bundled CLI.

## Internal process command

`ade runtime run` starts your own runtime on an explicit endpoint. Sync is always off, so it cannot claim brain authority; use a separate `ADE_HOME` for full isolation.

```bash
ADE_HOME=/tmp/ade-dev-runtime ade runtime run --socket /tmp/ade-dev-runtime.sock
ade --socket /tmp/ade-dev-runtime.sock projects list --text
```

`--profile embedded` (the only value; anything else is a usage error) makes the runtime a guest in an external embedder's process, which is what `@ade-dev/sdk` starts. The machine chat scope is personal chats only, with no automations and sync off, and machine update and power controls are withheld: a guest must never restart its host's ADE. Project scopes still build on demand. With `ADE_EMBEDDED_PARENT_PID` set to the host pid, the runtime stops when that process dies without unwinding; without it, it logs `runtime.embedded_parent_watchdog_absent` and runs on.

```bash
ADE_HOME=/tmp/ade-embedded ADE_EMBEDDED_PARENT_PID=$$ \
  ade runtime run --socket /tmp/ade-embedded.sock --profile embedded
```

## Brain lifecycle

```bash
ade brain start                    # enable/load the login service
ade brain stop                     # disable/unload the login service
ade brain status --text            # endpoint, service, sync, project-host readiness
ade brain status --scan-listeners  # plus a native port scan for an orphaned sync listener
ade brain restart                  # re-exec after an app update
ade brain update --text            # stage/apply the latest standalone brain and restart (macOS also moves the ADE app to that version)
ade brain update status --text     # last headless update state
ade brain repair-credentials       # fix a credential store the brain cannot read
ade brain pin generate | set 123456 | clear   # phone pairing PIN
```

The `ade runtime install-service`, `uninstall-service`, `service-status` and `status` aliases stay for scripts. `ade runtime watchdog-check --text` is the external liveness check: it reads the heartbeat and stops a wedged brain.

- **`projectHost`** in `ade brain status` is the readiness snapshot the phone's "Fix connection" card reads (`sync.diagnoseHost`), so both name the same blocking runtime in the same words. `state` is `ready`, `starting`, `conflict` or `unavailable`; a `conflict` names the owner, its lane, whether a paired device may stop it, and the pid, port, socket and command line. It is a file read of the sync-host lock, so it needs no brain. The `listener` fallback (a hard-killed ADE that left a port bound) needs `--scan-listeners`, because it runs `lsof` (POSIX) or `Get-NetTCPConnection` (Windows).
- No `ade` command stops the blocking runtime: `ade brain restart` re-execs this machine's brain, and `ade serve` / `ade brain start` print the conflict's `quitCommand` when they refuse to start. The one-tap stop is only for a remote device with no terminal.
- **`starting: true`** in `ade brain status` / `ade runtime status` means the service and process say the brain is coming up. Wait; a restart only starts its clock over. `ade brain restart` reports that `starting` message instead of "restarted." until the socket is bound.
- `ade brain repair-credentials` never contacts the brain, because the state it repairs is the one that stops the brain from starting. `ade doctor` reads the same state from disk.

## Project registry

The brain owns the machine's project catalog at `$ADE_HOME/projects.json` (`ProjectRegistry`, `src/services/projects/projectRegistry.ts`). A record has a stable `projectId` (`project_<sha256(rootPath)[..24]>`), root path, display name, `addedAt`, `lastOpenedAt`, the git origin URL, a `catalogVisibility` and a `registrationSource`. `ade projects add` and `ade init` register `recent`/`cli-explicit`; a runtime auto-registration (an agent running a project command) registers `system`/`runtime-auto`, which is not a recent project. `ade projects list --text` shows a `visibility` column.

```bash
ade projects list --text           # hides projects whose folder is gone; --include-missing shows them
ade projects add /path/to/project
ade projects clone owner/repo      # clone with this computer's GitHub sign-in, then register it
ade projects clone <url> --path '~/work' --machine "Mac Studio"   # on another computer; quote ~ so your shell leaves it for that computer
ade projects prune --dry-run       # registry entries whose folder is gone (never folders)
ade projects remove project_abc123…
ade projects touch project_abc123…
ade projects retry project_abc123…   # or a path: open again a project refused as too slow (project_folder_too_slow)
ade init                           # adds the cwd as a project
ade init /path/to/project          # adds an explicit path
```

- A folder on a drive that is not connected (an unplugged `/Volumes/…` disk, a missing drive letter or share, an unmounted `/mnt` point) is unknown, never gone, so `prune` keeps it.
- `projects clone` without `--path` clones beside the other projects; a `--path` for another computer must be absolute there (a leading `~` is that computer's home).
- `ade projects remove` removes only the entry. Deleting the folder is the person's act: the desktop **Remove project** dialog calls `projects.inspectRemoval` (changed files, unpushed commits, stashes, what runs), then `projects.removeCopy` with `deleteFolder` and the `stateToken` it saw. `projects.removeCopy` refuses agents and any role below cto, so no `ade` command wraps it.
- A project with a git origin shows the account's shared name and icon (`project.name` / `project.icon` under `repo:<origin>` in account settings, or `.ade/project-record.json` with sync off) on every machine.

```text
projects.list   { } -> ProjectRecord[]   # each record also carries a host-resolved icon
projects.add    { rootPath } -> ProjectRecord
projects.remove { projectId } -> { removed }
projects.touch  { projectId } -> ProjectRecord
projects.retryOpen { projectId | rootPath } -> { projectId, displayName, rootPath, wasBlocked, strikesCleared }
projects.checkOpen { projectId | rootPath } -> { ok: true }   # or the project_folder_too_slow error
```

**Too-slow folders.** A project whose open froze the brain until the freeze guard killed it (a folder on a drive too slow for its database) gets a strike in `$ADE_HOME/runtime/project-open-strikes.json`; the guard's breadcrumb names the projects that were opening (`openingProjects`). Two strikes within 15 minutes and every open of that project fails at once with `project_folder_too_slow`. The refusal lasts 15 minutes and doubles on each new refusal (up to 24 hours); a successful open or `ade projects retry` resets it. `projects.checkOpen` (follows a moved id; the desktop sends the path) throws the same refusal for a client about to read the folder. Log events: `project.open_freeze_killed`, `project.open_blocked`, `brain.project_open_stalled`.

**Icons.** `projects.list` adds `icon: { dataUrl, sourcePath, mimeType }` resolved on the host (`resolveRemoteProjectIcon`, `src/services/projects/projectIconResolver.ts`): a `.ade/local.yaml` override, conventional icon/logo files, or the `index.html` icon link, capped at 2 MB. A failure gives a null icon and is remembered for 60 s, so later lists skip the 750 ms icon budget.

Adding a project creates `<rootPath>/.ade/` and runs no onboarding. The first project-scoped call builds its `AdeRuntime` through `ProjectScopeRegistry`.

## RPC surface

The runtime has two layers of JSON-RPC methods (`src/multiProjectRpcServer.ts`).

**Runtime-scoped** (no `projectId`):

```text
ade/initialize   ade/initialized   ping   shutdown   exit
runtime/info     machineInfo.get   machine.updateAndRestart
runtime.activitySummary            runtime.updateImpact
account.call     attention.call
projects.list    projects.add      projects.remove   projects.touch
projects.inspectRemoval            projects.removeCopy
projects.retryOpen projects.checkOpen
projects.browseDirectories         projects.getDetail
projects.getWorkSummary            projects.getDefaultParentDir
projects.getHandoffStoragePreflight
projects.create  projects.clone    projects.listMyGitHubRepos
personalChats.call                 personalChats.streamEvents
runtimeEvents.subscribe   runtimeEvents.unsubscribe
runtimeEvents.setPtyDataFilter
sync.getStatus            sync.refreshDiscovery
sync.listDevices          sync.updateLocalDevice
sync.connectToBrain       sync.disconnectFromBrain
sync.forgetDevice
sync.getTransferReadiness sync.transferBrainToLocal
sync.getPin   sync.setPin   sync.generatePin   sync.clearPin
sync.getRuntimeName       sync.setRuntimeName       sync.clearRuntimeName
sync.setActiveLanePresence
sync.getCloudRelayStatus
sync.getRequireDpop       sync.setRequireDpop
sync.authorizeSshPairing
```

- **`account.call`**: account status, login, token and the machine directory (`listMachines`, `pairMachine`, `renameMachine`, `deleteMachine`, `repairMachinePairing`). Prefer the typed `ade login`, `ade auth status`, `ade account token create` and `ade machines …` commands; they pick the CTO role where needed and keep pairing on the DPoP-bound path. Every machine-directory action is CTO-only. `deleteMachine` is for people only: it refuses an agent identity and needs `confirmation: "REMOVE"` (`ade machines remove --confirm REMOVE`).
- **`runtime.updateImpact`**: what a restart would stop: the chats mid-turn (name and project) and counts of open agent CLI sessions and terminals, across every booted project and the personal runtime. It never boots a project. CTO-gated, because it names every running chat; clients show it before an update.
- **`machine.updateAndRestart`**: the host half of "Update & restart". With this machine's desktop open, it asks that app to install its update (`app_update.install`), because an open app owns the brain. Otherwise it applies a newer build for this channel and restarts the service. It reports each step and its route, is CTO-gated and always user-started. On the machine, `ade brain update` is the typed equivalent; the RPC is for a remote client (the desktop's remote-machine card).
- The pairing and PIN methods answer on a machine with no project: `ade sync status`, `ade brain pin …`, `ade sync devices`, `ade sync refresh` and `ade sync security …` work there. `sync.listDevices` is empty and the runtime name null, because both are per-project.
- **`attention.call`**: the CTO-gated account-wide Activity surface behind `ade code`'s `/activity` (`getSnapshot`, `getMachineSnapshot`, `acknowledge`, `reportPresence`, `getPreferences`, `putPreferences`). `attention` is the frozen wire name; agents use `ade actions run attention.<action>`.
- **`runtimeEvents.subscribe`** returns `eventEpoch`, `nextCursor`, `hasMore`, `gap` and `oldestCursor`. With `gap: true` the cursor is older than the buffer: refresh state, then resume. Every drain (`stream_events`, `personalChats.streamEvents`, both subscribe replays) stops at `limit` events or about 1 MiB and returns at least one event; `hasMore: true` means drain again from `nextCursor`. `category` takes `REMOTE_RUNTIME_EVENT_CATEGORIES` (`orchestrator`, `dag_mutation`, `runtime`, `pty`).
- **`personalChats.subscribeEvents` / `unsubscribeEvents`** are machine RPC methods, not `personalChats.call` actions, so `ade chat action --personal` refuses them. They push `runtime/event` (`scope: "personal"`, `projectId: null`) to a held connection; the CLI polls instead. `capabilities.personalChats` advertises `pushEvents` and `mcpServers` (absent on older runtimes).
- **`personalChats.call`** dispatches the machine action registry (`capabilities.personalChats`): chats outside every project, with lifecycle, model, input, approval, attachment and terminal actions. Use `ade chat … --personal`, `ade chat actions --personal` and `ade chat action --personal <action> --input-json '{...}'`. They need the brain (or `ade rpc --stdio`); `--headless` is not supported because its runtime exits with the command. `create` takes caller `mcpServers` and a tristate `strictMcpConfig` through `--arg-json mcpServers=...` / `--arg strictMcpConfig=<bool>` (no typed flags). Branch on the session's `mcpCapability.level` (only `"enforced"` means the caller's servers are the whole tool surface), never on its presence.

**Project-scoped**: every other request carries `params.projectId`. `ade/actions/call` goes to the `ProjectScope` from `ProjectScopeRegistry.get(projectId)`.

- `ade/initialize` advertises `runtimeInfo.multiProject: true` and `capabilities.projects: true`, so clients send `projectId` per request instead of the per-process binding (embedded runtime).
- The sync service serves the most recently opened project; `ProjectScopeRegistry.ensureSyncHost` updates it when projects change.
- `sync.connectToBrain`, `sync.disconnectFromBrain` and `sync.transferBrainToLocal` are legacy wire names; prose says runtime connection, disconnection and sync authority transfer.
- `sync.disconnectFromBrain` needs the project (`params.projectId`, or the `params.projectRoot` of a registered project), disconnects only that one, never falls back to another, and refuses a project that is not loaded.

## Credentials

`src/services/credentials/credentialStore.ts` owns the store under `~/.ade/secrets/`:

- Desktop: `ElectronSafeStorageCredentialStore` encrypts `credentials.safe.enc` with Electron `safeStorage` and migrates legacy file stores on first read.
- Headless fallback: `EncryptedFileCredentialStore` keeps `credentials.json.enc` (AES-256-GCM) and serializes writes with `credentials.json.enc.lock`.
- Folders are mode `0700`; blobs, locks and legacy machine keys `0600`.
- Account-machine adoption uses a long-lived Ed25519 identity, `machine-identity-signing.json` (atomic, `0600`); only its raw 32-byte public key is published.

**Sign-in.** `ade login`, `ade logout` and `ade auth status` act on the daemon-owned account session. Installed ADE uses the production Clerk app and account directory; the repo's development Clerk secrets select the development tenant. With production Clerk, `ade login` opens ADE Web's sign-in (`https://app.ade-app.dev/sign-in?continue=<authorize URL>`), which goes on to the loopback callback. After `ade logout` the next sign-in asks for an account.

**Machines.**

- `ade machines list` reads the account directory. Signed out, local, PIN, explicit-address and saved SSH paths still work. Machine keys and device ids are stable selectors; a display name works only when it is unambiguous (otherwise the command prints the matching machine keys).
- A removed machine is left out of the list. On the removed computer, `ade auth status` still says "Signed in" plus the removal date and `ade machines reconnect` (JSON `thisComputerRefusal`: `code`, `revokedAt`, `recoveryGaveUpAt`; null when accepted or unreadable). `ade sync status --text` shows the `this computer`, `auto repair stopped` and `reconnect with` rows, and `ade doctor` **Publish health** names the same. `ade machines reconnect --text` prints one sentence, as the desktop Reconnect button does.
- Presence is a short-lived hint: a machine with a verified relay endpoint stays connectable after its heartbeat expires; one with no verified route is listed but unavailable.
- A row with `pubkey: "ed25519:<raw-base64>"` makes adoption verify the host signature and seal the bearer, DPoP proof and paired secret over verified LAN, tailnet or relay routes. Rows without a key keep the WSS-relay-only path.
- Targets and credentials made by `ade machines connect` belong to the account and leave on sign-out or switch. PIN, SSH and explicit-address pairings stay local.

## `ade machines connect`

```bash
ade login                          # sign in to the shared ADE account
ade machines list --text           # dial status, presence (Connected/Online/Asleep/Offline) and battery or wall power
ade machines rename <machine-key> "Build Mac"   # account-wide name; --clear falls back to the hostname
ade machines remove <machine-key> --confirm REMOVE   # revoke a machine and clear the Activity it published
ade machines reconnect             # re-pair THIS machine after it was removed, and lift the push gate
ade machines connect <machine-key|device-id|name>   # pair and save the account machine on this install
```

`ade machines connect` pairs the machine when needed, saves it so ADE desktop and the web client can open it, and prints the result. It opens no terminal UI.

- Paired targets use the DPoP-bound sync bridge with LAN → Tailscale → Relay failover. Relay needs both machines signed into the same account; LAN and tailnet work signed out.
- Account-created targets are paired-only, leave on sign-out or switch, and fail closed: no fall back to SSH or a plaintext address. Legacy account machines saved as uncredentialed SSH targets are adopted into the paired store; one the directory cannot verify fails closed.
- SSH targets start `ade rpc --stdio` over a validated route and keep their host alias, so OpenSSH applies its `Host` settings. Route and runtime probes share one cancellable deadline and report each failure.
- After an SSH connection initializes, the desktop runs `ade sync pair-device --json-stdin` on that channel home to trade the controller's DPoP identity for a paired-machine secret (bounded JSON, never in argv). If an uploaded Beta runtime cannot initialize, ADE probes Stable and the other homes and keeps the first compatible one for `pair-device` and later commands.

## `ade rpc --stdio`

`ade rpc --stdio` attaches to the local brain (starting it when needed) and bridges its JSON-RPC over stdio. The desktop's remote runtime runs it over an SSH `exec` channel; see `docs/features/remote-runtime/internal-architecture.md`.

## `ade desktop`

`ade desktop` opens the installed app (`open -a "ADE"`, or `ADE Beta` / `ADE Alpha` from `ADE_PACKAGE_CHANNEL` / `ADE_DESKTOP_APP_NAME`). The desktop attaches to the same brain and starts it when needed (`LocalRuntimeConnectionPool`).

## CLI surface (selected)

```bash
ade desktop
ade brain update --text                   # update this machine's brain and restart it (same action as the desktop "Update & restart")
ade runtime watchdog-check --text         # what the watchdog agent runs on a timer: stop a brain that stopped responding
ade sync status --text                    # works with no registered project: this machine's own pairing and route state
ade brain pin generate --text             # pair a phone with a machine that has never opened a project
ade connect                               # account + login service + account-directory row, idempotent
ade connect --status --text               # report the three steps without changing anything
ade connect --headless                    # sign in from another device: QR code, link, and code
ade connect --no-login --no-service       # opt out of either half
ade setup                                 # finish/redo install setup: pinned agent CLIs this machine uses, account, desktop app, verification, summary
ade setup --no-desktop --no-prompt        # non-interactive; skips the ~1 GB desktop download
ade login                                 # browser here, plus a QR code + link + code to finish on another device
ade login --headless                      # open no browser here: QR code + verification URL + user code only
ade auth status --text                    # account identity + loopback/device/env-token source
ade account token create --text           # print a self-contained durable ADE_ACCOUNT_TOKEN once
ade logout
ade mcp status --text                     # ADE MCP: on/off, the server URL AI apps add, connections
ade mcp on | off                          # let AI apps (claude.ai, ChatGPT, Cursor) use this computer, or stop
ade mcp token create --label Grok --read-only --text     # a bearer token for header-based apps (shown once); --read-only or --full-access is required
ade mcp scope <connection-id> read|write  # change one app's or token's access
ade mcp remove <connection-id>            # disconnect an app or revoke a token
ade mcp activity --text                   # what connected apps ran here
ade mcp servers --text                    # the MCP servers your agents get, where each is on, which values are set
ade mcp servers add notion --reason "…"   # MCP server card in the chat; the person approves it, then presses Refresh chat
ade mcp servers remove stripe             # a card asks the person; on yes the server and its saved values leave the account
ade doctor --json
ade doctor --online --text                        # also check the latest desktop release over the network
ade report-issue --text                           # print a redacted diagnostic report (local files only; no brain needed)
ade report-issue --send                           # also send the same redacted report to the ADE team privately and print its reference id
ade report-issue --send --open                    # then open a public GitHub issue that holds only that reference, the version and the OS
ade triage                                        # build a redacted context.md + repair playbook and hand them to the first agent ADE has downloaded
ade triage --provider codex                       # pick the agent (claude | codex | cursor-agent | opencode | droid | muse)
ade triage --agent --json                         # launch nothing: print contextPath, playbookPath, playbookSource, suggestedPrompt, detected agents
ade reset --all --dry-run --text                  # list everything a hard reset would remove, changing nothing
ade reset --all                                   # remove everything ADE put on this computer (asks you to type RESET first)
ade tools status --text                           # pinned agent CLIs: installed version + entry path per tool, plus the machine tools root
ade tools ensure --text                           # fetch the pinned tools this machine shows signs of using (the rest are listed as skipped); streams progress to stderr
ade tools ensure --all --text                     # fetch every tool this build pins (well over 1 GB)
ade tools ensure codex --text                     # one tool; an unknown name is a usage error listing the pinned set
ade tools gc --dry-run --text                     # drop cached versions this build no longer pins (keeps the newest superseded one)
ade providers opencode accounts list --text       # OpenCode logins saved on this machine
ade providers opencode accounts activate --id <id> --text
ade providers opencode accounts rename --id <id> --label Work --text
ade providers opencode accounts remove --id <id> --text
ade scene preview /tmp/chart.html --text         # render a scene the way a chat will: screenshot path, timings, problems
cat draft.md | ade scene preview - --theme light  # a fence or a bare body on stdin; --width sets the frame width (default 720)

ade projects inspect /path/to/checkout --json   # classify a path (repo root vs linked/ADE-managed worktree) and find its owning project + existing lane
ade lanes list --text                             # every git worktree of the project is a lane: this reconciles against git on each call, adopting worktrees made outside ADE and dropping lanes whose worktree is gone from git and disk. There is no attach/adopt step
ade lanes create --name fix-login --text            # branch from the project's pattern (ade/fix-login by default)
ade lanes create --name fix-login --branch-name JIRA-123-fix-login   # name the branch yourself; a taken name (any case) is refused
ade lanes create --name followup --from feature/login --on local
ade lanes create --name followup --from feature/login --on uncommitted # copies changes
ade lanes create --name login --existing-branch feature/login
ade lanes defaults --text
ade lanes defaults set --from primary --on local
ade lanes defaults set --from develop --on remote           # a named branch; falls back to the default branch if it is deleted
ade lanes defaults set --branch-pattern "{user}/{slug}"     # new branch names: "ade/{slug}" (default), "{user}/{slug}", "{slug}" (no prefix)
ade lanes create --linear-issue-json '{"id":"...","identifier":"ENG-431"}' --start-chat --provider codex --model <model>
ade lanes create --linear-issues-json '[{"id":"...","identifier":"ENG-431"},{"id":"...","identifier":"ENG-440"}]'
ade lane drift --lane lane-id --text              # did someone `git checkout` inside the worktree? compares live HEAD to the lane's recorded branch
ade lane drift resolve --lane lane-id --switch-back        # put the worktree back on the lane's branch (refuses on a dirty tree)
ade lane drift resolve --lane lane-id --keep-head          # re-point the lane (and its name) at the live HEAD branch
ade lane drift resolve --lane lane-id --keep-head --expected-head hotfix-auth --force   # --expected-head guards a stale read; --force acknowledges active work
ade lanes create --machine cloud --size medium --name fix-login   # the lane alone, on its own new ADE Cloud computer (small, medium, large, xlarge); asks first; prints the launch id on stderr
ade lanes rename lane-id --name "OAuth refactor"            # rename the lane; its branch keeps its name
ade lanes reclaim-preview lane-id --text                   # show reclaimable space and anything that needs review
ade lanes archive lane-id                                  # archive, and bring down the Docker services the lane's env init started (best-effort; a failed teardown still archives)
ade lanes archive-and-reclaim lane-id --confirm RECLAIM    # preserve lane history/branch/chat; remove ADE-managed local files
ade lanes unarchive lane-id                                # restore the lane; recreate its managed worktree when needed. A recreated worktree re-runs the whole env init before returning; a plain unarchive returns immediately and restarts Docker in the background, so don't assume services are up when the command exits
ade lanes action initEnv --arg laneId=lane-id              # re-run the full env init (env files, copies, deps, mounts, setup script, docker)
ade lanes delete lane-id --force --delete-branch
ade lanes deleted list --text                              # lanes whose unsaved work a delete kept, for 30 days
ade lanes deleted restore <id>                             # bring one back with its uncommitted files; never pushes
ade lanes share --lane lane-id --text                      # the lane's shares: person, state, preset, risk, end, made by
ade lanes share --lane lane-id --add guest@example.com --ends 1w   # a Watch share (see, never act); the only kind the CLI, an agent or ADE MCP can make, at most 5 an hour
ade lanes share --lane lane-id --remove guest@example.com  # stop a share of this lane (or pass its grant id)
ade chat update [<session>] --title "Fix login" --tag review-ready   # also --model, --effort, --permissions, --fast/--ultrafast; defaults to $ADE_CHAT_SESSION_ID
ade chat attach-linear-issue <session> --issue-id ENG-431
ade chat create --from-linear-issue ENG-431
ade chat list --personal --text
ade chat create --personal --provider codex --model openai/gpt-5.5 --prompt "Plan a trip"
ade chat create --personal --provider claude --model anthropic/claude-opus-5 --arg-json mcpServers='{"docs":{"type":"http","url":"https://mcp.example/mcp"}}' --arg strictMcpConfig=false
ade chat steer personal-session-id --personal --text "focus on the tradeoffs"   # add --dispatch inline|interrupt for atomic active-turn delivery
ade chat interrupt personal-session-id --personal --keep-queue
ade chat restore-queue personal-session-id recovery-id --personal
ade chat note --personal --session personal-session-id "Drafting the email"   # also ask / activity <value|clear>; from inside a personal chat (ADE_CHAT_SCOPE=personal) the flags are implied
ade chat create --personal --provider codex --model openai/gpt-5.5 --arg personalProfile=embedded   # SDK-host surface instead of the assistant default
ade chat interrupt <session> --stop-children                 # also stop the chats it spawned
ade chat restart [<session>] [--stop | --after-turn]         # fresh provider process, conversation kept; no session = your own chat, once this turn ends
ade chat wait <a> <b> --async [--any]                        # durable: wake me when all (or any) are idle
ade chat waits --text                                        # list waits; ade chat wait --cancel <id>
ade chat wait --background --job <id>                        # wake me when my background job ends
ade chat events <id> --since <cursor> --json                 # turn starts/ends, input needed, errors since a cursor; answers at once
ade chat notify <id> --url https://… --token-stdin           # POST there when it goes idle, needs input or fails (--list, --cancel)
ade chat send <B> --after <A> "start the review"             # send B this once A is idle
ade prs watch <pr> | ade prs ship <pr> | ade prs unwatch <pr>  # PR Watch / Ship for the calling chat
ade chat actions --personal --text
ade chat action --personal modelCatalog --input-json '{"mode":"cached"}' --json
ade issue list --tracker jira --scope PROJ --text     # tracker-neutral issue reads and writes for Linear, GitHub, or Jira
ade issue view PROJ-123 --text
ade jira status --text
ade jira connect --site https://acme.atlassian.net --email dev@example.com --token-stdin < jira-token.txt
ade jira list --project PROJ --state open --text
ade jira issue PROJ-123 --text
ade jira transition PROJ-123 --to Done
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
ade search "login redirect" --text                          # active-project search plus bounded chat hits from every registered project (read from each project's index file; no project is loaded)
ade search "flaky test" --kind chat,terminal --lane fix-login --text  # exit 1 when nothing matches
ade search --status --text                                  # index doc counts, backfill state, index path
ade prs create --lane lane-id --base main --title "Fix checkout flow" --text  # prints GitHub + ADE PR URLs
ade prs create --lane lane-id --base main --close-linear-issue-on-merge
ade prs create --lane lane-id --base main --allow-dirty   # open it even with uncommitted files; the PR has the lane's commits only
ade prs create --lane lane-id --title "Fix checkout flow" --body-file pr.md --text  # uploads proof the text cites; prints what a reader will miss
ade prs body 123 --body-file pr.md --text                                        # replace the PR text; same upload and notes
ade prs list-open --text
ade prs github-snapshot --include-external-closed --history-page-limit 4
ade prs github-snapshot --include-state-counts --no-revalidate
ade prs checks pr-id --text                                 # header carries the canonical rollup (checksStatus/checksCounts); "not run" means nothing verified the commit, whatever the rows say
ade prs comments pr-id --text
ade prs land pr-id --method squash                          # merges and KEEPS the head branch on the remote
ade prs land pr-id --method squash --delete-remote-branch   # opt in to deleting the head branch after the merge
ade prs close pr-id                                         # close on GitHub; the branch is kept and `ade prs reopen pr-id` undoes it
ade prs draft pr-id                                         # convert an open PR back to a draft; `ade prs ready pr-id` marks it ready for review
ade prs auto-merge pr-id on --method squash                 # arm GitHub auto-merge (squash by default); `ade prs auto-merge pr-id off` disarms it
ade prs assignees pr-id --add alice --remove bob            # add/remove GitHub assignees; anyone not named is kept
ade prs cleanup-branch pr-id --delete-remote-branch         # delete a merged/closed PR's branch (local too, unless --keep-local)
ade prs land 'gh:owner/repo#42' --method squash             # id form for a PR ADE has no row for; quote it, '#' starts a shell comment
                                                            # works for land/close/reopen/cleanup-branch/checks/comments/review; threads and deployments still need an ADE row
ade shell start --lane lane-id -- npm test
ade shell start --machine windows --wait -- bash ./scripts/check.sh   # run once in this chat's work copy on another machine; put every step in one call
ade shell start --machine windows --code as-is -- git status       # use the work copy there as it is now (--code fresh throws away changes made there first)
ade shell start --machine windows --no-code --wait -- nvidia-smi   # no code needed: an empty folder there, removed after
ade files push --machine windows ./build/app.apk dist/app.apk      # copy one file into this chat's work copy there (chunked, sha256-checked, 256 MiB max)
ade files pull --machine windows logs/run.log ./run.log            # copy one file back from that work copy
ade devices --text                                                 # every device this chat can use (ios, android, screen, app), on every machine, as <kind>@<machine|here>
ade devices use ios@"Mac mini"                                      # keep this chat's iPhone on that machine; device commands follow it as --machine does (use ios@here to undo)
ade devices current                                                # this chat's choice per kind
ade devices use ios@cloud                                          # the ADE Cloud iPhone (any machine; when the account has it), then ade apple … drives it
ade terminal list --lane lane-id --text
ade terminal resume --terminal session-id --text
ade new chat --mode chat --lane lane-id --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --no-fast --permissions full-auto --prompt "fix failing tests"
ade new chat --mode cli --lane lane-id --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --no-fast --permissions full-auto --prompt "fix failing tests"
ade new chat --mode chat --lane auto --lane-name fix-checkout-flow --prompt "fix failing tests"
ade new chat --mode chat --lane lane-id --prompt-file brief.md   # a long or multi-line first message from a file, or stdin with -
ade new chat --mode chat --lane lane-id --prompt "repro the flake"   # from an agent: a subagent that reports back (the default); --no-report for no report
ade new chat --mode cli --lane lane-id --provider codex --no-report --parent chat-session-id --prompt "review the diff"   # agent-provider CLI sessions record spawn lineage without becoming attached terminals and show in the parent as a subagent card that closes when the CLI exits (use --mode chat for per-turn reports); shell sessions do not record lineage
ade chat list --lane lane-id --include-automation --no-archived --text
ade chat create --lane lane-id --provider codex --model openai/gpt-5.6-sol --permissions full-auto --print-config --json
ade chat create --lane lane-id --provider codex --model openai/gpt-6.1-sol --ultrafast   # Fast at Codex's Ultrafast tier, on accounts whose Codex catalog offers it (also on `new chat` and `chat handoff`)
ade chat create --lane lane-id --provider codex --no-parent   # a separate top-level chat; only when the user asks for one
ade chat launch "fix the flaky test" --provider codex --model openai/gpt-5.6-sol --wait --text   # new-lane chat owned by the brain (chat.startLaunch): fetch base, check out worktree, default lane template, then create the chat + send; --wait polls chat.getLaunch (exit 0 completed / 1 failed, cancelled, or timed out)
ade chat launches --text                                     # chat.listLaunches: launches running or recently finished on the brain
ade chat launch-status launch-id --text                      # chat.getLaunch (exit 1 when unknown or expired); `ade chat launch-cancel launch-id` = chat.cancelLaunch (deletes the chat, lane, and branch)
ade actions run chat.retryLaunch --input-json '{"launchId":"launch-id"}'   # also startLaunchNow / queueLaunchMessage / completeLaunchClient (client-side CLI-launch handshake)
ade chat read session-id --limit 20 --max-chars 8000 --text
ade chat read session-id --page --cursor 4096 --limit 20 --max-chars 8000 --text
ade chat status session-id --text                            # live turn phase (exit 0 running or waiting on background work / 1 idle / 2 blocked; `phase` in --json says `waiting`); adds a `resume` line while a usage limit is live and a `pending` line while an effort/fast-mode change waits for background work
ade chat resume-now session-id --text                        # alias `resume`: send the usage-limit continue prompt now instead of waiting for the reset
ade chat switch-account session-id --account work --text     # move a Claude/Codex chat to another account; same thread; refused while a turn runs
                                                             # exit 1 when the host refuses (no live usage limit, or a resume already in flight); --json carries { ok, reason, message }
ade actions run chat.updateSession --input-json '{"sessionId":"session-id","autoContinueAtUsageLimit":true}'   # the desktop pill's "Turn on" / "Try again": re-arm auto-resume after it was paused or opted out (false turns it off)
ade chat message session-id --kind auto --text-file - <<'EOF'  # long or multi-line text from a file or stdin; also --text-file on send, steer and side, and --prompt-file on create. On Windows `ade.cmd` cuts an argument at its first line break, so never pass multi-line text as an argument
status/context
EOF
ade chat message session-id --kind auto --text "status/context"
ade chat steer session-id --text "active-turn context"
ade chat steer session-id --text "active-turn context" --dispatch interrupt   # atomic active-turn delivery: inline | interrupt; omit to stage for the next turn (Claude and Cursor take both; a Cursor cloud run declines inline and stages)
ade chat note "testing desktop auth fallback"               # update Work status (aim for 6 words or fewer; truncated past 72 characters); add --session <id> to target explicitly
ade chat ask "Which account should I use?"                 # escalate a blocking question; add --session <id> to target explicitly
ade chat pending session-id --text                         # questions/approvals the chat is blocked on, with options and the respond command
ade chat respond session-id --option 2                     # answer its pending question (--text, --answer <q>=<v>, --item <id>; --approve/--deny for approvals)
ade chat archive session-id                                # hide a chat from lists; `ade chat unarchive session-id` brings it back (chat.archiveSession)
ade chat activity testing                                  # set one fixed detail: planning|implementing|testing|reviewing|debugging|monitoring; `clear` removes it; add --session <id> to target explicitly
ade session show session-id --text                          # status/activity detail + elapsed, live agent pids, settle/snooze state, and why a snoozed row came back
ade --role cto session move session-id --to done             # file the row under a Work-board column: needs-you|working|done ('needs_you' spelling also accepted)
                                                            # CTO-only, like every other settle-column writer: a move tells the agent the USER moved it, so a session-bound agent must not move its own card
                                                            # 'waiting' is refused — a row sits there because it is snoozed or its PR is mid-CI, so it is derived, never a target
                                                            # reversible for 5s via: ade --role cto actions run session.undoBoardMove --input-json '{"sessionId":"...","moveId":"..."}'
ade session snooze session-id --for 1h                      # 30m|1h|4h|1d|1.5h; a bare number means minutes; relative durations cap at 30d
ade session snooze session-id --until 2026-07-26T18:00:00Z  # explicit ISO-8601 deadline (must be in the future)
ade session snooze session-id --until-asked                 # open-ended, matching the desktop/iOS "Until I'm asked" preset: only a hand-raise brings it back
ade session wake session-id --reason manual                 # timer|needs_you|error|turn_complete|manual
ade session clear-woke session-id                           # drop the "woke early" marker after visiting the row
ade session actions --text                                  # raw session service actions
ade chat scheduled-work pause session-id          # pause this agent session's durable wakeups/cron/loops (status to inspect, resume to re-arm)
ade chat scheduled-work list [session-id] --all     # list durable jobs; --all includes recent terminal history
                                                   # a row ADE armed itself carries source:"auto_resume_limit"; user- and agent-created rows carry no source
ade chat scheduled-work create --in 12m --prompt "Check CI and report" --reason "CI check" --session session-id              # safest one-shot form; omit --session inside the bound agent
ade chat scheduled-work create --at "2026-07-23T01:05:00-04:00" --prompt "Check CI and report"                           # absolute one-shot; explicit offset or Z required
ade chat scheduled-work create --cron "9,29,49 * * * *" --prompt "Check CI and report" --once                         # five-field cron uses the ADE brain machine's local timezone
ade chat scheduled-work cancel session-id job-id    # cancel one job (owning chat first; or --session/--id; inside the chat, just the job id); Claude-native jobs request CronDelete
ade chat wait session-id --for idle --timeout-ms 600000
ade chat recover session-id --turn turn-id --action nudge        # provider-neutral wait | nudge | retry | resume; falls back for older Codex brains
ade chat resolve-unprocessed session-id --steer steer-id --action run-next  # durable/idempotent; action is run-next | dismiss
ade chat demote [session-id]                                     # take over a subagent: its reports to its parent stop; defaults to $ADE_CHAT_SESSION_ID
ade chat promote [session-id]                                    # make the chat report back to its parent again
ade chat set-parent <session-id> --parent <chat> [--no-report]  # relink a chat to a new parent (reports go there next turn)
ade chat set-parent <session-id> --no-parent                     # detach a chat from its parent
ade chat keep-reporting [session-id]                             # dismiss the takeover prompt without changing the report channel
ade chat handoff session-id --model openai/gpt-5.6-sol --note "focus on tests"   # brief handoff; add --target-lane <lane-id> to hand off into another lane
ade chat handoff session-id --to "Mac mini" --model <model> --prompt "next step"   # move the chat to another machine (--to names the destination; --machine is its alias); --fork, --include-changes, --clone, --when-turn-ends
ade chat handoff session-id --options --json                     # where the chat can go, and the blockers with fixes; also --cancel, --retry
ade chat fork session-id --model openai/gpt-5.6-sol              # fork provider history natively (claude/codex/opencode/droid/copilot/muse/pi/kimi); cursor has no fork surface so ADE replays the transcript into a fresh agent; stays in source lane
ade chat fork session-id --model openai/gpt-5.6-sol --through-turn turn-id   # keep only the turns through a finished turn (Codex, Copilot and Pi cut natively; others replay the kept turns)
ade chat side session-id "why Redis?"                             # ask the chat's read-only side chat (opens it when there is none); it sends to the main chat only when asked
ade chat side session-id --end                                    # end (delete) the chat's side chat
ade chat models --provider codex --json                          # model order + supported reasoning tiers
ade tests run --lane lane-id --suite unit --wait
ade proof list --arg ownerKind=chat --arg ownerId=session-id
ade proof attach shots/result.png --caption "Checkout complete"
                                                      # every filing command prints a `cite:` snippet for the agent's answer
ade proof publish --pr 123 --heading "Proof" --note "Checkout flow" artifact-id [artifact-id ...]
ade proof publish --pr 123 --in-body                                             # upload the proof the PR text cites, in place
                                                      # one PR comment; gh 2.99+ --attach uploads the chosen proof, then a github_pr link is added
ade proof publish --pr 123 --replace artifact-id    # post the new proof comment, then delete this account's earlier ADE proof comments
ade proof review artifact-id --text                  # contact sheet of a video (or the picture) plus findings, before a person sees it
ade proof review --chat <chat-id> --text             # that chat's newest video (else its newest proof)
ade proof review artifact-id --from 12 --to 18 --text # a closer look at part of the video
ade proof rm artifact-id
ade proof broken --text                              # list missing/unimported proof records
ade proof recover artifact-id                       # re-import when the original capture still exists
ade proof prune                                      # preview broken records; does not delete
ade proof prune --broken                             # delete every broken proof record
ade proof actions --text                             # full computer_use_artifacts action inventory
```

The device and app commands have their own docs; `ade help <command>` lists every flag:

| Commands | Doc |
| --- | --- |
| `ade ios-sim …`, `ade apple …` (simulators, live view, per-lane device, iPhone Duo, device log, semantic actions) | [Apple device](../../docs/features/apple-device/README.md) |
| `ade android …` (one emulator per lane, previews, instrumentation tests, SDK images) | [Android device](../../docs/features/android-device/README.md) |
| `ade mac-desktop …`, `ade screen …` (the lane's own desktop) | [Mac desktop](../../docs/features/mac-desktop/README.md), [Windows desktop](../../docs/features/windows-desktop/README.md) |
| `ade app-control …` | [App Control](../../docs/features/computer-use/app-control.md) |
| `ade browser …`, `ade work-tools …` | [Chat](../../docs/features/chat/README.md), [Computer use](../../docs/features/computer-use/README.md) |

```bash
ade --socket update status --text
ade --socket update check --text
ade --socket update install --text
ade sync security status --text                    # machine sync security posture (require-DPoP)
ade sync security require-dpop on                  # reject paired hellos from devices without a Secure Enclave key
ade sync web --text                                # print the browser web-client pairing link + code (app.ade-app.dev)
ade sync web --open                                # also open the pairing link in the default browser
ade sync web --no-clipboard                        # print only; don't copy the link to the clipboard
ade secrets list --text
ade secrets exec -- npm run deploy                 # run a command with the secrets in its env, output masked
ade secrets set STRIPE_API_KEY --value sk_...      # this project, on every computer
ade secrets set LOCAL_TOKEN --value local-value --storage device   # this computer only
printf %s "$TOKEN" | ade secrets set TOKEN --stdin
ade secrets set TOKEN --value-file token.txt
ade secrets delete STRIPE_API_KEY
ade secrets request WEBHOOK_SECRET --reason "Signs deliveries" --generate  # private secret card in the chat; prints the outcome, never the value
ade integrations status --text                    # GitHub, Linear, Jira: connected here or not, and as whom; never a credential
ade integrations connect linear --reason "…"      # connect card in the chat (browser sign-in or key); saved for the project on your machines, prints the outcome
ade cloud status --text                         # the whole ADE Cloud account in one read: can a new lane start (the reason when not), plan, hours, disk, computers, each lane, sizes, default size, agent limits; `ade cloud` alone is the same
ade chat create --machine cloud --size medium --prompt "…"  # a new lane on its own new ADE Cloud computer (small, medium, large, xlarge; default small); asks first; prints the launch id on stderr
ade chat create --machine cloud --launch-id <id> --prompt "…"  # the same id again: follows that launch, or goes on from its failed step, never a second computer
ade chat launch-status <id> --machine cloud        # an ADE Cloud lane launch: stages, the computer, the approval link while the join waits
ade chat launch-cancel <id> --machine cloud        # stop it before the chat starts and delete its computer
ade cloud work-state --json                       # ADE Cloud: the lanes of this cloud computer with uncommitted or unpushed work; pushes nothing
ade cloud push-work --check --json                # the same check; without --check it commits and pushes every lane (ADE's server runs it before a free)
ade cloud recommend --need "a hosted Postgres"   # ADE Cloud Free: a Sponsored pick from Gravity's Index for a real need; a chat gets a card that installs nothing, a CLI gets text to repeat once as "Sponsored:"
ade cloud resize --request --size large --reason "…"  # ask the person to change this computer's size: a card in the chat, nothing changes; an agent with nobody there cannot resize
ade cloud resize --free 8 --reason "…"            # grow the disk of the ADE Cloud computer this runs on to fit 8 GB more free (or --disk <GB>): up to its size's disk maximum with no card; restarts the computer, and the chat continues after it
ade cloud prepare-stop --json                     # ADE Cloud, run by the server before a stop: interrupts running turns and CLIs, saves the chats, then copies and Git summaries; prints interruptedChats, interruptedClis, stillRunning, chatsUploaded, chatsNotUploaded, sessionsSaved, gitSaved, timedOut
ade cloud prepare-stop --for-delete --json        # ADE Cloud, before a server delete: the same, and new turns, terminals and remote work are refused until the delete (or 10 minutes); --chats-only (the person's Sleep) skips the copies and lane backups
ade cloud unfreeze --json                         # ADE Cloud, run by the server when it keeps a computer it prepared for a delete: new work is allowed again
ade cloud save-for-rest --capsules --json         # ADE Cloud, run by the server's idle cleanup: saves shell and CLI copies, Git summaries, subagent copies and event wakes; --capsules adds the fork capsules a continue needs; prints ok, capsules, sessions, git, skipped, and error when the time ran out
ade cloud messages drain --json                   # ADE Cloud, run by the server after a wake: sends the messages queued for this computer's chats and CLIs, in order, each once
ade usage snapshot --text                          # live quota headroom per window, the account it belongs to, and the provider limits link
ade usage stats --range 7d --text                  # tokens, cost, and activity for a range
ade usage stats --scope account --text             # merged across every machine on the account
ade usage stats --scope project --range 30d --text
ade usage stats --scope account --force --text     # skip the account fan-out rate floor (explicit refresh)
ade usage stats --since 2026-08-01T00:00:00Z --until 2026-08-08T00:00:00Z --text
ade usage turns --days 14 --text                   # per-turn ledger (action usage.getTurnUsageSummary): cost and cache by provider, account, model, plus quota burn rates
ade usage turns --group-by provider --recent 20 --text  # group by provider (default provider_account_model); add this project's 20 newest turns
ade router routes --provider codex --limit 20 --text  # rated routes (harness × model × effort) with score, cost, and who bills it
ade router pick "fix the parser bug" --provider codex --model gpt-6-sol --kind light_edit --text  # dry-run the route the router would pick for one task
ade router shadow --days 7 --text                     # what the shadow router would have changed for recent subagents (changes no turn)
ade router efficiency --days 7 --text                 # what it would have saved across every chat thread (turn-ledger replay) and subagent, at list prices
ade router refresh --text                             # fetch the newest model registry (signed-in accounts)
ade --role cto usage refresh --text                # live Claude/Codex quota only (same snapshot layout as `usage snapshot`)
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
ade archive list --text                              # archived lanes, chats, and shells, newest first (archived rows are hidden from chat/terminal lists unless --include-archived)
ade archive list --kind chat --older-than 14 --text  # archived chats from 14+ days ago
ade archive summary --text                           # counts per kind and what is 14+ days old
ade --role cto archive restore chat:<id> lane:<id>   # unarchive items (CTO); deleting lives in Project → Storage & cleanup → Archive
ade chat list --include-archived --text              # archived chats too
ade terminal list --chat-session <session-id> --include-archived --text  # archived shells too
ade actions list --domain chat --text
ade actions describe chat.respondToInput --text   # one action: access, description, documented input fields, example
ade actions run account_settings.list --args-list-json '["all"]' --text
ade actions run account_settings.set --args-list-json '["all","appearance.theme","dark"]' --text
ade actions run account_vault.list --args-list-json '["all"]' --text
ade --role cto actions run account_vault.get --args-list-json '["all","provider_api_key","openai"]' --text
ade --role cto actions list --domain attention --text # discover account-wide Activity actions (domain name is a frozen wire identifier)
ade --role cto actions run attention.getSnapshot --input-json '{"since":0}' --json
ade actions run git.stageFile --arg laneId=lane-id --arg path=src/index.ts
ade actions run pty.resumeSession --arg sessionId=session-id
ade actions run external-sessions.list --input-json '{"scope":"project","limit":20}' --text   # claude/codex/cursor/droid/opencode/pi/qwen/kimi/grok/copilot sessions on this machine; discovery that cannot run — `opencode` is not installed, say — fails the call when that provider is the only one asked for, rather than reporting an empty list; in a multi-provider scan it is skipped and logged
ade actions run external-sessions.import --input-json '{"provider":"codex","sessionId":"thread-id","laneId":"lane-1","target":"cli","mode":"resume"}' --text
ade actions run external-sessions.getDetail --input-json '{"provider":"claude","sessionId":"session-id"}' --text   # one session's preview page; pass olderCursor back as before for the previous page
ade actions run ai.getProviderContextInventory --input-json '{"provider":"claude"}' --json   # what a new chat on that provider gets before the first message: items, sizes, files and the measured total (a provider page's Initial context window)
ade actions run ai.piLoginProviders --text                 # Pi providers that can be signed into, with the auth methods each accepts and whether it is already configured
ade --role cto actions run ai.piLoginStart --input-json '{"providerId":"anthropic"}' --json   # blocks until the human finishes Pi's own OAuth/device-code flow
ade actions call stream_events --arg category=runtime --json                                 # drain piAuthStatus prompts/notices raised by an in-flight sign-in
ade --role cto actions run ai.piLoginSubmit --input-json "$(jq -n --arg v "$PI_API_KEY" '{providerId:"anthropic",requestId:"req-1",value:$v}')"  # answer a prompt; keep the value out of argv and shell history
ade --role cto actions run ai.piLoginCancel --input-json '{"providerId":"anthropic"}'
ade --role cto actions run cto_state.refreshContext --json          # give the CTO a fresh provider thread (CTO-only; the conversation, notes and open work carry over)
ade --role cto actions run cto_memory.updateNotes --input-json '{"scope":"project","text":"- Deploys go through the release lane"}' --json
ade --role cto actions run cto_memory.updateOpenWork --input-json '{"op":"add","text":"Land the login fix"}' --json
ade actions run chat.setScheduledWorkItemPaused --input-json '{"sessionId":"chat-123","scheduleId":"cron-abc","paused":true}' --text
ade actions run chat.runScheduledWorkNow --input-json '{"sessionId":"chat-123","scheduleId":"cron-abc"}' --text
ade --role cto actions run computer_use_artifacts.ingestSceneSnapshot --input-json '{"path":".../.ade/artifacts/computer-use/scene.png"}' --json
ade cursor cloud agents list --text
ade cursor cloud agents list --archived --limit 100 --text
ade cursor cloud agents create --repo https://github.com/owner/repo --prompt "fix flaky test" --auto-pr
ade cursor cloud agents resume --agent bc-... --prompt "address the review comments"
ade cursor cloud agents archive --agent bc-...
ade cursor cloud agents unarchive --agent bc-...
ade cursor cloud runs list --agent bc-... --text
ade cursor cloud artifacts list --agent bc-... --text
ade cursor cloud artifacts download --agent bc-... --path dist/report.zip --out ./report.zip
ade cursor cloud repos list --text
ade cursor cloud models list --text
ade cursor cloud me --text
ade --role cto github app-auth login              # device-flow authorize the machine ADE GitHub App (headless/brain)
ade github app-auth status --text                 # show the GitHub App credential state, login, expiry, and any renewal failure
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
ade skill list --text                               # project, personal and ADE skills, each labelled with its source
ade skill show ade-browser --text
ade help --json                                     # the command catalog as JSON (only this scope's commands under ADE MCP)
```

### GitHub

- `github app-auth status` answers "re-authorize, or wait?" from `credentialState` alone, never `expiresAt` (a token lives 8 hours and renews on use). `"blocked"` means ADE paused its refresh retries until `refreshBlockedUntil` after a transient failure (`lastRefreshError`): wait. Only `"needs_reauth"` and `"missing"` need `app-auth login`.
- Reads try environment → ADE GitHub App → GitHub CLI → stored PAT. Writes skip the read-only GitHub App. `github.getStatus` reports the read and write sources, failures, cooldowns, fallbacks and any refresh pause, never a token.
- `authFailure.kind: "service_unavailable"` means GitHub returned 5xx: do not re-auth or rotate a token. Then (and for an unclassified failure) `github.getStatus` asks githubstatus.com and adds `serviceHealth` (`indicator`, `affected`, `incidentUrl`) when a surface ADE uses is confirmed down. Its absence never means the failure is local; do not branch on it.

### Commands with no typed form

- **Pi sign-in** (like OpenCode's `ai.opencodeOAuth*`). `ai.piLoginStart` blocks until a person finishes Pi's browser or device-code flow; a prompt it raises is answered by a second call, `ai.piLoginSubmit`, with the `requestId` from the `piAuthStatus` runtime event. So it needs two processes plus an event drain, against a running brain or desktop socket (a headless second process cannot see the first's sign-in).
  - Start, submit and cancel are CTO-only (`--role cto`); `ai.piLoginProviders` is not.
  - `ai.piLoginStart` has its own 11-minute transport floor (the desktop's budget); a larger `--timeout-ms` still applies.
  - `ai.piLoginSubmit`'s `value` can be an API key: build `--input-json` from an environment variable, and never echo the result.
- **Provider keys** are not project secrets, so `ade secrets` does not cover them. `ai.storeApiKey` / `ai.deleteApiKey` / `ai.listApiKeys` act on the project's store (`<project>/.ade/secrets`). The writers are CTO-only; the list is not (it names providers, never keys). Build `--input-json` from an environment variable and never log the result.
- **`computer_use_artifacts.ingestSceneSnapshot`** is not a second `ade proof attach`. It is CTO-only, takes no bytes, and accepts only a path inside the project's `.ade/artifacts/computer-use`: it lets the desktop's Proof button file bytes it already wrote when the broker runs in the runtime. Agents use `ade proof attach` and `ingest_computer_use_artifacts`, which check owner claims and the import root.
- **CTO state.** There is no `ade cto`; use `ade actions run`.
  - `cto_state.refreshContext` (CTO-only) gives the CTO a fresh provider thread: the chat stays, and the thread gets the doctrine, notes, open work, live project state and last 40 messages. A CTO mid-turn refreshes when the turn ends.
  - `cto_memory.updateNotes` replaces one notes file (`project`: `.ade/cto/MEMORY.md`, 4096 bytes; `user`: notes about the person for every project on this machine, 2048 bytes) and refuses text over the cap. `cto_memory.updateOpenWork` adds, completes, reopens or removes one item. `getSnapshot` and `recordDiscovery` are open to every role; writes are CTO-only.
  - `cto_state.dismissOnboarding` and `resetOnboarding` do not exist (an unknown-action error); `getOnboardingState` and `completeOnboardingStep` do.
- **`ade tools`** is not a service action: the pinned-tool cache belongs to the machine's file system, so the command calls `src/services/tools/` in-process and works with no desktop or brain. The desktop's `agentToolsCacheService` is the same module behind an IPC feed for onboarding.

### Browser, App Control and Work tools scoping

- **`ade browser`** needs no token: any process on this machine may use it, like `ade mac-desktop`. From a chat, the runtime tags each call with the chat and its lane (or the personal tab collection), so the chat owns the tabs it opens and a `--lane` is dropped. From a plain terminal, `--lane` is kept and the call owns no tab. `--force` is reserved and refused, and calls from another machine's brain are refused. With no ADE window here, `open` / `new-tab` / `panel` go to a desktop that has the lane pinned.
- **The browser where the user sits.** When the user drives the chat from another computer, page commands (`open`, `observe`, `click`, `fill`, `text`, `claim`, …) run in the ADE browser of the desktop that sent the chat its last message, and the first `--text` line says so (`browser: on <machine>, the computer the user sits at`). If that desktop does not take the command within 4 s, it runs here and says so. `--here` picks this machine; `upload`, `har` and `record` need it, because their file is here. See `docs/features/remote-runtime/README.md`.
- **`ade browser attach` / `detach`** and the page commands of a chat attached to the user's own browser never reach ADE's browser, so the runtime checks them itself: the caller must be a live chat of this project and may name only its own chat (`docs/features/computer-use/README.md`, "Attach to the user's own browser").
- **`ade app-control`** has no special scoping branch. A machine has one active App Control session; `--lane` / `--chat-session` (or `ade app-control claim`) attribute it to the caller so the Work row, trace and proof land on the right lane. `--force` replaces the session and is open to agents.
- Browser profile diagnostics, saved site permissions and login import (cookies from Chrome, Safari or Firefox) have no CLI by design: they stay in the trusted renderer with a person present, and the daemon and the desktop bridge refuse them.
- **`ade work-tools`** reads the pane; it does not drive it. `work_tools.setActiveTool` is for user clients only (the renderer publishing what it has open for phones and the web client). An agent that wants a pane opens the tool (`ade browser panel`).

### Conventions

- Use typed commands first; they validate arguments and give stable JSON or readable text. `ade help <command> <subcommand>` gives exact flags, `ade actions list --text` the action catalog, and `ade actions run <domain.action>` the escape hatch.
- User-only domains, such as `lane_share` (sharing a lane with another account), are left out of `ade actions list` and refused by `ade actions run`: only the desktop app with no agent identity reaches them.
- For stored project credentials, use `ade secrets`. Account-linked projects default to account storage; `--storage account|device` chooses. `list` is metadata only (with each secret's location); `get --text` prints the value. Agents read only the secret the user named and never log it.
- Output: `--text` for people, `--json` (default when piped) for stable JSON, `--pretty` for indented JSON.

## ADE account auth and `ade doctor`

`ade connect` is the one command that puts a machine on an account. It runs three idempotent steps, prints each as a checklist line on stderr, and keeps stdout for the payload (JSON, or one line with `--text`):

1. **account**: reuse a valid session, else run the `ade login` code, so the loopback-or-device choice lives in one place.
2. **service**: install and start the login service when it is not running. A refusal because it runs inside the brain it would replace is not a failure.
3. **machine**: wait for this machine's row in the account directory.

Step 3 waits, it does not write. The brain's account-machine publisher posts to `/account/machines/register` on sign-in and every 30 s, while the brain holds the sync-host lease and has an active host snapshot. So `ade connect` makes those conditions true and polls `listMachines` for its own `machineKey` (from `~/.ade/secrets/sync-cloud-relay.json`) until a deadline. **The brain must keep running for the machine to stay reachable**, which the service step gives. The directory marks a machine `online` only within 90 s of `last_seen_at`.

- An account is needed only for shared account features; local CLI, project, lane and PIN work stays available signed out.
- `ade login` uses Clerk OAuth with a loopback callback when a browser is available. `--headless`, SSH sessions and display-less Linux use the device bridge (a URL and short code for any browser); a failed loopback open falls back to it.
- **Agents and CI**: run `ade account token create` once on an interactive machine, keep the result in a secret manager, and give it to the brain as `ADE_ACCOUNT_TOKEN`. New tokens carry the refresh credential plus the OAuth issuer and client id, so the host needs no Clerk configuration. Raw access tokens work until their JWT expiry. Old opaque refresh tokens need local `CLERK_ISSUER` and `CLERK_OAUTH_CLIENT_ID`; recreate them to drop that. ADE never logs the value.
- Provider API keys and Linear OAuth credentials can follow the account through the encrypted account vault, and secrets through Passwords & Secrets; device-only values stay in the machine stores. GitHub tokens and computer-use policy stay in their own stores.

`ade doctor` prints one row (`ok` / `warn` / `fail`) per check and exits non-zero when any row is `fail`:

- **App** — the installed ADE desktop version (read from the `.app` bundle on disk) against the latest build on its track. With `--online` (short timeout, best-effort), latest comes from the Beta feed for a Beta install and from the latest GitHub release otherwise. Without it, or when that read fails, the on-disk `update-status.json` (the last `ade brain update`) counts only while it is newer than the installed app and on the same track. `warn` when the install is behind or missing.
- **Brain** — whether the machine brain responds on its socket, plus its version, pid, and uptime. `fail` when it is not responding or when its build identity does not match the expected runtime for this CLI/role. A brain that is not answering *yet* is reported as `warn` (`starting`) rather than `fail`: when the login service is registered and the brain process behind it is alive and younger than the young-brain window (`RUNTIME_SERVICE_YOUNG_BRAIN_MS`, 2 min), it is still coming up — first launch, cold disk, large project database — and restarting it would only reset its clock. This is the CLI's read of the same `brain_starting` state the desktop recovery screen shows; `ade runtime status` and `ade brain status` report it as a `starting: true` field with the same wording. Nothing to repair: keep waiting for the endpoint.
- **Standalone ade** — shown only when `$ADE_HOME/bin/ade` (`ade.exe` on Windows) exists: its `--version` against the running brain's. `warn` when they differ, naming `ade brain update` (or deleting the file) first, since the ADE app updates without this file and an `ade` older than 1.2.126 never warns that it differs; `warn` too when it does not report a version. `ok` when they match or no brain is running.
- **Wedge history** — the last wedge that was recovered, read from the runtime dir or the brain's reported `lastWedge`. `warn` when the most recent wedge is within the last 24h. Two things write that record: the in-process loop watchdog (reported as the blocking command and how long it blocked) and the external watchdog (`ade runtime watchdog-check`), which stops a brain whose heartbeat has gone stale and is reported as how long the brain went without a beat. A brain that is wedged right now shows up as a failing **Brain** row; the heartbeat itself has no separate row because a stale heartbeat plus a live brain is exactly what the watchdog converts into a restart within a minute.
- **Sync port** — the sync host port the brain bound. `ok` on the default port, `warn` when bound elsewhere (with the base-port holders it found), `fail` when the brain is up but reported no port.
- **Publish health** — account-directory publish state from the brain's sync route health. `ok` when a publish succeeded recently, `fail` when it has been failing for ≥2 min, otherwise `warn`, with the slowest publish leg annotated. When the directory refuses this computer (`machine_revoked` or `pairing_authentication_required`), the detail gives the removal date, says when the automatic repair stopped, and names `ade machines reconnect`.
- **Relay** — relay route health as already computed by the brain. `ok` when the relay control is connected, the bridge is validated, and the end-to-end round-trip is verified; `fail` when the route is not fully validated; `warn` when relay is disabled or route health is unavailable. When another ADE process on this machine has claimed the relay slot, the brain deliberately stops redialing and this row reports that suppression ahead of any lower-level close error, so the detail names the fix (quit the rival process) instead of the symptom. `ade sync status --text` shows the same reason on its `relay` line, plus a `relay failing since` row for how long the current outage has run.
- **Account** — whether this machine's brain is signed in to an ADE account (and the credential source), read via the brain's `account.call status`. `warn` when signed out or unavailable.
- **Credentials** — whether the shared credential store (`$ADE_HOME/secrets/credentials.json.enc`) can be read, and whether an unreadable one was set aside earlier. `fail` when it cannot be read, naming the next step: a store sealed with a key this process cannot obtain is unlocked by opening the ADE app on this computer, while anything else needs a fresh sign-in. `warn` when a quarantined file is still waiting to be restored. Unlike every other row, this one is read **straight from disk** rather than through the brain — the failure it exists for is a brain that cannot start, so a check that needed a running brain would be silent exactly when it matters. It is non-creating: it never mints a machine key or OS key material, so running the diagnostic cannot change the state it reports. `ade brain repair-credentials` acts on the same reading.
- **Storage** — where this machine's ADE home and its most recently opened project actually live, and whether their bytes are on the disk. `fail` when a root cannot be read at all, or when sampled files are not downloaded *and* this computer's background service is not allowed to download them; `warn` when files are not downloaded but the service may fetch them, or when a root sits on cloud storage that the service may not download from. Both facts come from a bounded `fs` walk (at most 120 files, 24 directories, and 250 ms per root) plus one read of the installed launch agent, so this row — like **Credentials** — works on the machine where the brain will not start. That is the point of it: an evicted iCloud Drive project read by a background service macOS will not let hydrate returns `EDEADLK` ("Unknown system error -11") and leaves every other row green. The remedy the row names, `ade runtime install-service`, rewrites the launch agent with the `MaterializeDatalessFiles` key. The row reports locations and counts only, never a path or a file name. `ade report-issue` prints the same facts in full under "Storage environment".
- **Diagnostics sharing** — whether ADE may send a redacted diagnostic report by itself when something fails, and how much of today's ceiling has been spent (`on · 1 of 3 automatic reports sent today` / `off`). Read straight from the ledger both senders account against (`$ADE_HOME/secrets/diagnostics-autosend.json`), which is why the count covers the whole computer rather than one process. Always `ok`: it is a preference, not a health check. An absent or unreadable ledger reports the default the next auto-send would act on — on, nothing spent. The setting itself is toggled in the desktop app; there is no CLI flag for it.

Default doctor calls no provider, GitHub or Linear network. **Brain**, **Sync port**, **Publish health**, **Relay** and **Account** come from the brain's socket. **App**, **Wedge history**, **Credentials**, **Storage** and **Diagnostics sharing** read local files, so they answer while the brain is down (Wedge history reads the on-disk breadcrumb first). No row prints a secret or a project path. `--online` is the one network read.

### `ade report-issue`

When a row fails and the checks do not explain it, `ade doctor --text` points at `ade report-issue`, the headless form of the desktop's "Report this error to ADE…" dialog. It reads only local files and never contacts the brain, so it works where ADE will not start and on Windows. It prints a redacted report. Do not post the report on a public page; send it with `--send`.

- `--json` returns `{ installId, report, reportPath?, sent?, issueUrl?, opened? }`. `issueUrl` (only after a successful `--send`) is a public GitHub issue with only the reference, version, channel and OS family; `opened` says whether `--open` opened it.
- `--send` is the only part that leaves the machine, and it is opt-in. It uploads the same redacted report over HTTPS and prints the reference id. It reads the account session and directory origin from local files; a signed-in machine attaches its token, a signed-out one uploads anonymously with the install id.
- A failed or rate-limited send changes neither the report nor the exit code; it prints one line. With `--json`, `sent` is present only when asked: `{ ok: true, reference }` or `{ ok: false, reason }`.

### `ade triage`

`doctor` names the failed check, `report-issue` makes a report, and `triage` hands the repair to a coding agent.

- It runs the doctor checks and the redacted collection, writes them as `context.md` in a fresh temp folder (`ade-triage-<timestamp>-<random>/`) with a repair playbook, and launches the first agent whose ADE-pinned copy is on disk: `claude`, `codex`, `cursor-agent`, `opencode`, `droid`, `muse`, in that order.
- It never uses the PATH and never starts a download. Each agent runs by absolute path with its leading args (Cursor: bundled Node + `index.js` + `--disable-auto-update`; Muse: `--contributor-mode off`) and self-update env, and inherits stdio. Triage prints both paths on stderr, prints nothing on stdout, and exits with the agent's code.
- `--provider <name>` picks one; a provider with no copy prints its pinned state ("ADE is downloading …", "ADE has not downloaded … for this machine yet.", "Couldn't download …", "… is not available on this machine"). OpenCode starts bare (its positional argument is a folder) and the prompt is printed to paste.
- The playbook is `docs/triage/PLAYBOOK.md`: safety rules first (read-only diagnosis before changes, never delete under `.ade/` or `$ADE_HOME`, never kill by name or pattern, ask before destructive steps), then a failure class per doctor row with the read-only command to run. It is fetched from `main` each run (3 s timeout), else the local copy, else a built-in one; `playbookSource` (`remote` / `local`) and `playbookOrigin` say which. `ADE_TRIAGE_NO_FETCH=1` skips the fetch; `ADE_TRIAGE_PLAYBOOK=<path>` overrides the local copy.
- `ade triage --agent` launches nothing: it prints `mode`, `contextPath`, `playbookPath`, `playbookSource`, `playbookOrigin`, `suggestedPrompt`, the detected agents and a `message`, and exits 0. It is for an agent already running (a Work chat triaging its own machine); a machine with no downloaded agent gets the same payload. Branch on `mode`, not the exit code: `agent`, `no-provider`, or `launch` (an agent ran; nothing on stdout, the agent's exit code).
- The context file uses the redaction of `ade report-issue`, holds no credentials, and is written to a temp folder, not the project.

There is no `ade recovery diagnose` / `repair`: those are Electron-main IPC (`ade.recovery.*`) on the desktop's connection pool. Use `ade doctor`, `ade brain restart` and `ade brain repair-credentials`.

Agents in an unfamiliar ADE session start with:

```bash
ade doctor --json
ade actions list --text
```

Then prefer typed commands (`ade lanes list --text`, `ade files read <path> --text`, `ade prs checks <pr> --text`, `ade tests runs --json`), with `ade actions run …` as the escape hatch.

## Repo development

The installed `ade` command is the production CLI. Repository development uses root npm scripts so the command always runs the CLI and desktop code from this checkout, not whichever `ade` happens to be first on `PATH`.

```bash
npm run setup
npm run dev:desktop
npm run dev:runtime
npm run dev:stop
```

The dev scripts run the same ADE runtime from source against a temporary endpoint so a packaged ADE on the same machine is not affected:

```text
/tmp/ade-runtime-dev.sock
```

From an ADE lane checkout under `.ade/worktrees/`, the dev scripts keep using
that lane's source code, but default the ADE project root back to the primary
checkout.

Full matrix:

```bash
npm run dev:desktop          # desktop only; dev endpoint; desktop may auto-create runtime
npm run dev:desktop:attach   # desktop only; fail unless dev runtime is already running
npm run dev:desktop:clean    # desktop only; clear Vite cache before launch
npm run dev:runtime          # runtime only in the foreground
npm run dev:all              # start shared dev runtime, then run `npm run dev:desktop:attach`
npm run dev:stop             # stop the dev runtime
npm stop dev                 # same as dev:stop
```

Local packaged builds are separate from dev-mode scripts:

```bash
npm run package:alpha        # current checkout -> ADE Alpha.app, ade-alpha, ~/.ade-alpha
```

Use it when you want a production-shaped local app without going through the GitHub release workflow. Alpha builds from the current checkout under `apps/desktop/release-alpha`. Beta is not a local build: it is an update track of the normal install, built from `main` by `.github/workflows/beta.yml`. Use the dev scripts when you want Vite/Electron live reload, the temp dev endpoint, and the dev-only Electron profile. Local channel packages include the current machine's runtime binary. GitHub release builds use and validate the full cross-platform runtime artifact set.

## Automations

Automation rules are managed with `ade automations <subcommand>`. Run `ade help automations` for the full flag reference. The lane-mode flags layer on top of `--from-file` / `--stdin` / `--text` for `create` and `update`:

```bash
# Open a fresh lane for every new GitHub issue, naming it from the issue number + title.
ade automations example > rule.json
ade automations create --from-file rule.json \
  --lane-mode create --lane-name-preset issue-num-title

# Reuse an existing lane instead.
ade automations create --from-file rule.json --lane-mode reuse --lane lane-42

# Run in the trigger PR's own branch (PR triggers only), so the agent can push to the PR.
# The run reuses the lane already linked to the PR, or opens the branch as a new lane.
ade automations create --from-file dependabot-rule.json --lane-mode pr-branch

# Custom template (only valid with --lane-name-preset custom).
ade automations create --from-file rule.json \
  --lane-mode create --lane-name-preset custom \
  --lane-name-template "{{trigger.issue.author}}/{{trigger.issue.title}}"

# Test a rule before it runs for real. preview shows what a real run does;
# safe runs in a throwaway lane and only reports posts and pushes; live runs
# for real and needs --yes (without it, or with --plan, it shows the plan).
ade automations test rule-1 --pr 1542
ade automations test rule-1 --mode safe --pr 1542
ade automations test rule-1 --mode live --lane lane-42 --yes
ade automations cleanup-test <runId>

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

### Webhook automations

A webhook automation gives a service (GitHub, Stripe, Linear, Sentry, anything that can call a URL) a private URL. Each request that reaches it is checked (signature, conditions, duplicates) and then starts the agent. One command makes the URL and the rule:

```bash
# GitHub issues opened → triage, every delivery as a new turn in this chat
ade automations webhook create --service github --filter body.action=opened --in-this-chat --text

# Anything else; no signature; a custom prompt with request fields
ade automations webhook create --service generic --no-signature \
  --name "Deploy failures" --filter body.status=failed \
  --prompt "The {{trigger.body.service}} deploy failed: {{trigger.body.url}}. Find out why." --text
```

`create` prints the URL, the steps for pasting it into the service, whether the signing secret is saved yet, and the conditions in words. Filters are `body.<path>=value`, `headers.<name>=value`, `query.<name>=value`, with `!=` (not equal), `~` (contains), `^=` (regex), or a bare path (present). Without `--filter`, the preset's suggested conditions apply; `--any-request` runs on every request. Save the signing secret without pasting it into a chat: `ade secrets request GITHUB_WEBHOOK_SECRET --reason "…" --generate` raises the private secret card.

```bash
ade automations webhook list --text                 # every webhook automation, URL, last delivery
ade automations webhook test <wh-id> --text         # ring it like the real service (signed)
ade automations webhook deliveries <wh-id> --text   # what arrived and why it ran or was skipped
ade automations webhook delivery <whd-id> --text    # the prompt the agent got, headers, body
ade automations webhook replay <whd-id>             # run a logged delivery again
ade automations webhook rotate <wh-id>              # new URL; the old one stops at once
ade automations webhook retire <wh-id>              # stop a URL no rule uses (deleting a rule does this)
```

The standalone `create-lane` action is deprecated. By default the CLI auto-migrates a rule whose first action is `create-lane` into `execution.laneMode: "create"` and carries the template forward. Pass `--allow-legacy` on `create` / `update` to opt out of the migration.
