# ADE CLI

`apps/ade-cli` owns the `ade` command, the ADE brain, manual runtime entry points, and the terminal `ade code` client. The **brain** is the always-on, machine-owned ADE process for one channel; it is the source of truth for lanes, agent chats, work sessions, PR state, process state, sync, proof artifacts, and the project catalog on a machine. Desktop ADE, `ade code`, the iOS app, and SSH-attached desktops all attach to it. A **manual runtime** is an explicit foreground execution process you start for dev/test work instead of using the automated brain service.

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
| `~/.ade/secrets/` | Machine credential store (`credentials.safe.enc` for desktop safeStorage, `credentials.json.enc` plus `.machine-key` for headless fallback storage, and per-store `*.lock` files). |
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

1. **Standalone runtime install** — single static binary plus its native dependency archive, fetched from a GitHub release. Suitable for headless macOS/Linux servers.

   ```bash
   curl -fsSL https://github.com/arul28/ADE/releases/latest/download/install.sh | sh
   ```

   Environment overrides accepted by `install.sh`:

   - `ADE_VERSION=vX.Y.Z` — install a specific release tag (default `latest`).
   - `ADE_INSTALL_DIR=/custom/bin` — destination directory for the binary (default `$ADE_HOME/bin`).
   - `ADE_RELEASE_REPO=owner/repo` — fetch from a fork.
   - `ADE_HOME=/custom/.ade` — change the per-machine state root.

   The script downloads `ade-<platform-arch>` to `$ADE_INSTALL_DIR/ade`, verifies it and `ade-<platform-arch>.native.tar.gz` against `SHA256SUMS`, extracts the archive to `$ADE_HOME/runtime/<platform-arch>/`, runs `ade --version` to verify, and best-effort registers the per-user login service on macOS / systemd.

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
| Windows | `schtasks.exe ONLOGON` | scheduled task `ADE Runtime` |

The default service label is `com.ade.runtime`; channel builds override it via `ADE_PACKAGE_CHANNEL=alpha|beta` (`com.ade.runtime.alpha`, `com.ade.runtime.beta`). `ADE_RUNTIME_SERVICE_NAME` overrides the label outright and is used for both launchd and systemd unit names. macOS writes `launchd.{out,err}.log` under `ADE_HOME/runtime/`.

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

The service manager builds the launch command from the current `ade` binary path so the installed service launches the same ADE channel that ran the install. Release installs use `$ADE_HOME/bin/ade`, which lets `ade brain update` stage the next release under `$ADE_HOME/runtime/updates/`, verify downloaded assets against `SHA256SUMS`, atomically promote the binary/native deps, and restart the login service without the desktop app being open. After a packaged desktop update, ADE also refreshes this service so the brain re-execs the updated bundled CLI instead of leaving clients attached to an older build hash.

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

The ADE brain owns a per-machine project catalog at `$ADE_HOME/projects.json` (`ProjectRegistry` in `src/services/projects/projectRegistry.ts`). A project record carries a stable `projectId` (`project_<sha256(rootPath)[..24]>`), root path, display name, `addedAt`, `lastOpenedAt`, and the resolved git origin URL.

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
projects.list    projects.add      projects.remove   projects.touch
personalChats.call                 personalChats.streamEvents
runtimeEvents.subscribe   runtimeEvents.unsubscribe
sync.getStatus            sync.refreshDiscovery
sync.listDevices          sync.updateLocalDevice
sync.connectToBrain       sync.disconnectFromBrain
sync.forgetDevice
sync.getTransferReadiness sync.transferBrainToLocal
sync.getPin   sync.setPin   sync.clearPin
sync.setActiveLanePresence
sync.getCloudRelayStatus  sync.setCloudRelayEnabled
sync.getRequireDpop       sync.setRequireDpop
```

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

## `ade code`

`ade code` launches the terminal-native ADE Work chat (Ink + React, in `src/tuiClient/`). Default behavior:

```bash
ade code                           # attach to the machine brain, auto-spawn it if missing
ade code --embedded                # force the in-process embedded runtime
ade code --print-state             # smoke-test the connection and exit
ade code remote --target mac --project ADE
                                   # attach to a saved desktop remote machine
ade code remote session --target mac --project ADE --session chat-1
                                   # open a remote chat or provider CLI terminal session
ade --socket /path/to/ade.sock code   # attach to a specific local endpoint
ade --project-root /repo code      # bind to a specific project root
```

`ade code remote` reads the same saved remote-machine registry as desktop ADE,
starts `ade rpc --stdio` over SSH, and bridges it back into the normal TUI with
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
ade auth status
ade doctor --json
ade projects list --text
ade init
ade lanes list --text
ade lanes create "fix-checkout-flow" --parent main
ade lanes create "fix-login" --base origin/main   # omit --base to branch from the configured new-lane base (remote-first by default)
ade lanes create "lin-123" --linear-issue-json '{"id":"...","identifier":"LIN-123","title":"...","projectId":"...","projectSlug":"...","teamId":"...","teamKey":"...","stateId":"...","stateName":"Todo","stateType":"unstarted","priority":2,"priorityLabel":"high","labels":[],"assigneeId":null,"assigneeName":null,"createdAt":"...","updatedAt":"..."}'
ade lanes reparent lane-child --parent lane-parent --stack-base-branch main
ade lanes delete lane-id --force --delete-branch
ade lanes create-from-linear --issue-id ENG-431 --start-chat --provider codex --model <model>
ade lanes batch-create-from-linear --linear-issues-json '[{"id":"...","identifier":"ENG-431"},{"id":"...","identifier":"ENG-440"}]'
ade chat attach-linear-issue <session> --issue-id ENG-431
ade chat create --from-linear-issue ENG-431
ade chat list --personal --text
ade chat create --personal --provider codex --model openai/gpt-5.5 --prompt "Plan a trip"
ade chat steer personal-session-id --personal --text "focus on the tradeoffs"
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
ade search "login redirect" --text                          # full-text search across chats, terminals, PRs, commits, lanes, files, Linear
ade search "flaky test" --kind chat,terminal --lane fix-login --text  # exit 1 when nothing matches
ade search --status --text                                  # index doc counts, backfill state, index path
ade prs create --lane lane-id --base main --title "Fix checkout flow" --text  # prints GitHub + ADE PR URLs
ade prs create --lane lane-id --base main --close-linear-issue-on-merge
ade prs list-open --text
ade prs github-snapshot --include-external-closed
ade prs checks pr-id --text
ade prs comments pr-id --text
ade run defs --text
ade run start web --lane lane-id
ade shell start --lane lane-id -- npm test
ade terminal list --lane lane-id --text
ade terminal resume --terminal session-id --text
ade new chat --mode chat --lane lane-id --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --no-fast --permissions full-auto --prompt "fix failing tests"
ade new chat --mode cli --lane lane-id --provider codex --model openai/gpt-5.6-sol --reasoning-effort xhigh --no-fast --permissions full-auto --prompt "fix failing tests"
ade new chat --mode chat --lane auto --lane-name fix-checkout-flow --prompt "fix failing tests"
ade chat list --lane lane-id --include-automation --no-archived --text
ade chat create --lane lane-id --provider codex --model openai/gpt-5.6-sol --permissions full-auto --print-config --json
ade chat create --lane lane-id --provider codex --no-parent   # spawned chats default their parent to $ADE_CHAT_SESSION_ID; --parent <session> overrides, --no-parent opts out
ade chat read session-id --limit 20 --text
ade chat message session-id --kind auto --text "status/context"
ade chat steer session-id --text "active-turn context"
ade chat schedules session-id --pause              # pause this chat's durable wakeups/cron/loops (omit flag to inspect, --resume to re-arm)
ade chat wait session-id --for idle --timeout-ms 600000
ade chat recover session-id --turn turn-id --action nudge        # wait | nudge | retry | resume
ade chat models --provider codex --json                          # model order + supported reasoning tiers
ade code
ade code --embedded
ade tests run --lane lane-id --suite unit --wait
ade proof list --arg ownerKind=chat --arg ownerId=session-id
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
ade --socket browser open http://localhost:5173 --new-tab --text
ade --socket update status --text
ade --socket update check --text
ade --socket update install --text
ade sync relay status --text                       # cloud relay: wss URL phones dial + on/off state (on by default)
ade sync relay enable                              # re-enable after a disable (relay is on by default; headless brains have no Settings UI)
ade sync relay disable                             # kill-switch: never route sync through the relay
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
ade actions list --domain chat --text
ade actions run git.stageFile --arg laneId=lane-id --arg path=src/index.ts
ade actions run pty.resumeSession --arg sessionId=session-id
ade cursor cloud agents list --text
ade cursor cloud agents create --repo https://github.com/owner/repo --prompt "fix flaky test" --auto-pr
ade --role cto github app-auth login              # device-flow authorize the machine ADE GitHub App (headless/brain)
ade github app-auth status --text                 # show whether a GitHub App user token is stored (login, expiry)
ade --role cto github app-auth clear              # remove the stored GitHub App authorization
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

Use typed commands first. They validate common arguments and provide stable JSON fields or readable text summaries. Use `ade help <command> <subcommand>` for exact flags, `ade actions list --text` to discover the full service-backed action catalog, and `ade actions run <domain.action>` only when there is no typed command for the workflow yet. For stored project credentials, prefer `ade secrets`; `list` is metadata-only and `get --text` prints the secret value, so agents should read only the named secret the user asked for and avoid logging it.

Output modes are explicit: `--text` for human-readable summaries, `--json` (default for piped output) for stable JSON, and `--pretty` for pretty-printed JSON.

`--socket` requires a specific ADE local endpoint and fails fast when it is missing. Without `--socket`, the CLI auto-attaches to the brain when reachable and falls back to headless for commands that can run that way.

## `ade auth` and `ade doctor`

ADE CLI auth is local project access, not a separate cloud login. `ade auth status` verifies that the current terminal can initialize an ADE runtime for the project. Provider credentials, GitHub tokens, Linear tokens, and computer-use policy are read from ADE project settings and the existing secure stores.

`ade doctor` reports local-only readiness metadata by default:

- CLI version, Node/runtime version, project root, workspace root, `.ade` initialization, and config file presence.
- Machine endpoint path, whether the endpoint exists, and whether this invocation is using an attached runtime, desktop bridge, or headless mode.
- RPC tool count, ADE action count, and action counts by domain.
- Git repository readiness and GitHub readiness signals from local remotes, `gh` availability, and token environment presence.
- Linear readiness from the active project's `.ade/secrets` credential store (`linear.token.v1`), a legacy project-scoped encrypted token file, or headless environment variables.
- Provider/model readiness from local ADE config, API-key provider references, and provider CLI availability.
- Computer-use readiness from local platform capabilities.
- Packaged/PATH status for the `ade` binary and concrete next actions.

Default doctor / auth checks do not call provider, GitHub, or Linear networks. They report presence and local readiness only, without printing secret values.

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
