# ADE CLI

`apps/ade-cli` owns the `ade` command, the per-machine ADE runtime daemon, and the terminal `ade code` client. The runtime daemon is the source of truth for lanes, chats, PR state, process state, sync, and proof artifacts on a machine. Desktop ADE, `ade code`, the iOS app, and SSH-attached desktops all attach to it.

## Modes

The `ade` binary has three operating modes:

- **Socket** — the runtime daemon (`ade serve`) listens on `~/.ade/sock/ade.sock` (POSIX) or `\\.\pipe\ade-runtime` (Windows). All other CLI commands and clients open that socket and speak ADE JSON-RPC.
- **Headless** (`--headless` or `ade code --embedded`) — the CLI builds an in-process `AdeRuntime` for one project and answers the same JSON-RPC surface directly. Used for one-shot commands and as a fallback when no socket is available.
- **`ade rpc --stdio`** — attaches to the local runtime daemon and bridges its JSON-RPC over stdio. This is the transport the desktop's remote runtime feature spawns over SSH.

Default routing for typed commands: prefer the socket if reachable; auto-spawn `ade serve` in the background if the socket does not exist; fall back to headless for commands that don't need shared live state. Add `--socket` to require the daemon, or `--headless` to force in-process execution.

## Machine layout

`resolveMachineAdeLayout()` (in `src/services/projects/machineLayout.ts`) is the single source for per-machine paths. Override the root with `ADE_HOME`.

| Path | Purpose |
| --- | --- |
| `~/.ade/` | Per-machine ADE state root. |
| `~/.ade/sock/ade.sock` | Runtime daemon socket (POSIX). |
| `\\.\pipe\ade-runtime` | Runtime daemon named pipe (Windows). |
| `~/.ade/projects.json` | Project registry. |
| `~/.ade/secrets/` | Encrypted credential store (`credentials.json.enc` + `.machine-key`). |
| `~/.ade/bin/ade` | Bundled static runtime binary (release installs / remote uploads). |
| `~/.ade/runtime/<platform-arch>/` | Native node modules for that runtime binary. |
| `~/.ade/runtime/launchd.{out,err}.log` | Daemon stdout/stderr when running as a login service on macOS. |

Per-project state stays under `<project>/.ade/` and is governed by `projectConfigService` (see `docs/features/onboarding-and-settings/configuration-schema.md`).

Channel builds use parallel state roots and binary names so Stable, Beta, and Alpha can coexist:

```text
ADE.app        -> ade        -> ~/.ade        -> ade-desktop
ADE Beta.app   -> ade-beta   -> ~/.ade-beta   -> ade-desktop-beta
ADE Alpha.app  -> ade-alpha  -> ~/.ade-alpha  -> ade-desktop-alpha
```

Source dev launches use the temp dev socket and `ade-desktop-dev` Electron profile instead of the installed app profile.

## Install paths

Three ways to put `ade` on a machine:

1. **Standalone runtime install** — single static binary plus its native dependency archive, fetched from a GitHub release. Suitable for headless macOS/Linux servers.

   ```bash
   curl -fsSL https://github.com/arul28/ADE/releases/latest/download/install.sh | sh
   ```

   Environment overrides accepted by `install.sh`:

   - `ADE_VERSION=vX.Y.Z` — install a specific release tag (default `latest`).
   - `ADE_INSTALL_DIR=/usr/local/bin` — destination directory for the binary.
   - `ADE_RELEASE_REPO=owner/repo` — fetch from a fork.
   - `ADE_HOME=/custom/.ade` — change the per-machine state root.

   The script downloads `ade-<platform-arch>` to `$ADE_INSTALL_DIR/ade`, extracts `ade-<platform-arch>.native.tar.gz` to `~/.ade/runtime/<platform-arch>/`, runs `ade --version` to verify, and best-effort registers the per-user login service on macOS / systemd.

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

   Requires Node.js 22 or newer (the headless runtime depends on `node:sqlite`).

## Service manager

The runtime daemon runs as a per-user login service. The implementations live in `src/serviceManager/`.

| Platform | Backend | Service path |
| --- | --- | --- |
| macOS | launchd `LaunchAgent` | `~/Library/LaunchAgents/com.ade.runtime.plist` |
| Linux | `systemctl --user` | `~/.config/systemd/user/ade-runtime.service` |
| Windows | `schtasks.exe ONLOGON` | scheduled task `ADE Runtime` |

The default service label is `com.ade.runtime`; channel builds override it via `ADE_PACKAGE_CHANNEL=alpha|beta` (`com.ade.runtime.alpha`, `com.ade.runtime.beta`). `ADE_RUNTIME_SERVICE_NAME` overrides the label outright. macOS also writes `~/.ade/runtime/launchd.{out,err}.log`.

Manage the service from the CLI:

```bash
ade serve --install-service       # write the plist/unit/task and start it
ade serve --uninstall-service     # stop and remove it
ade serve --service-status        # JSON: { ok, installed, running, path, message }

# Aliases on the runtime command (same backend):
ade runtime install-service
ade runtime uninstall-service
ade runtime service-status --text
```

`resolveAdeServeCommand()` builds the service command from the current `ade` binary path so the installed service launches the same ADE channel that ran the install.

## Foreground daemon

`ade serve` runs the runtime in the foreground. Use it for development or when the system service is disabled.

```bash
ade serve
ade serve --socket ~/.ade/sock/ade.sock
ade serve --port 8787              # also accept JSON-RPC on 127.0.0.1:8787
ade serve --no-sync                # disable phone-sync host for this run
```

## Runtime control

`ade runtime` is the typed wrapper for daemon lifecycle commands:

```bash
ade runtime status --text          # is the daemon up, which socket
ade runtime start                  # spawn it in the background if missing
ade runtime stop                   # graceful shutdown via JSON-RPC
ade runtime install-service        # delegates to ade serve --install-service
```

`ade runtime start` is idempotent: it spawns `ade serve` detached and returns once the runtime answers `ade/initialize`. `ade runtime stop` calls the daemon's `shutdown` method.

## Project registry

The runtime daemon owns a per-machine project registry at `~/.ade/projects.json` (`ProjectRegistry` in `src/services/projects/projectRegistry.ts`). A project record carries a stable `projectId` (`project_<sha256(rootPath)[..24]>`), root path, display name, `addedAt`, `lastOpenedAt`, and the resolved git origin URL.

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
projects.list   { } -> ProjectRecord[]
projects.add    { rootPath } -> ProjectRecord
projects.remove { projectId } -> { removed }
projects.touch  { projectId } -> ProjectRecord
```

Adding a project creates `<rootPath>/.ade/` if needed but does not run any heavy onboarding. The first project-scoped JSON-RPC call lazily builds an `AdeRuntime` for that root via `ProjectScopeRegistry`.

## RPC surface

The runtime exposes two layers of JSON-RPC methods (`src/multiProjectRpcServer.ts`):

**Runtime-scoped** — no `projectId` required:

```text
ade/initialize   ade/initialized   ping   shutdown   exit
runtime/info     machineInfo.get
projects.list    projects.add      projects.remove   projects.touch
runtimeEvents.subscribe   runtimeEvents.unsubscribe
sync.getStatus            sync.refreshDiscovery
sync.listDevices          sync.updateLocalDevice
sync.connectToBrain       sync.disconnectFromBrain
sync.forgetDevice
sync.getTransferReadiness sync.transferBrainToLocal
sync.getPin   sync.setPin   sync.clearPin
sync.setActiveLanePresence
```

**Project-scoped** — every other request must carry `params.projectId`. `ade/actions/call` (and the legacy ADE action / tool catalog underneath it) is dispatched into the per-project `ProjectScope` returned by `ProjectScopeRegistry.get(projectId)`.

`ade/initialize` advertises `runtimeInfo.multiProject: true` and `capabilities.projects: true`. Clients use that to switch between sending `projectId` per request (multi-project runtime) and the legacy per-process binding (embedded runtime). Sync is hosted by the daemon for the most-recently-opened registered project; `ProjectScopeRegistry.ensureSyncHost` re-elects a host when projects are added or removed.

## Credentials

`src/services/credentials/credentialStore.ts` owns the machine-scoped credential store under `~/.ade/secrets/`:

- `KeytarCredentialStore` (default when `keytar` is loadable) keys against the OS keychain under service `com.ade.runtime.credentials.v1`.
- `EncryptedFileCredentialStore` falls back to AES-256-GCM at `~/.ade/secrets/credentials.json.enc`, with the AES key in `~/.ade/secrets/.machine-key` (mode 600).
- `ElectronSafeStorageCredentialStore` is used when the desktop process talks to the same files but wants to encrypt with `safeStorage` instead.

Disable keytar with `ADE_CREDENTIAL_STORE_DISABLE_KEYTAR=1` to force the encrypted-file store.

## `ade code`

`ade code` launches the terminal-native ADE Work chat (Ink + React, in `src/tuiClient/`). Default behavior:

```bash
ade code                           # attach to the machine daemon, auto-spawn it if missing
ade code --embedded                # force the in-process embedded runtime
ade code --print-state             # smoke-test the connection and exit
ade --socket /path/to/ade.sock code   # attach to a specific socket
ade --project-root /repo code      # bind to a specific project root
```

See `docs/features/ade-code/README.md` for the full attach/embedded handshake, slash command catalog, and right-pane drawers.

## `ade rpc --stdio`

`ade rpc --stdio` attaches to the local runtime daemon (auto-spawning it if needed) and bridges its JSON-RPC over stdio. The remote-runtime path on the desktop runs `ade rpc --stdio` over an SSH `exec` channel; see `docs/features/remote-runtime/internal-architecture.md` for the protocol shape and bootstrap sequence.

## `ade desktop`

`ade desktop` opens the installed ADE app from the terminal. On macOS it runs `open -a "ADE"` (or `ADE Beta` / `ADE Alpha` based on `ADE_PACKAGE_CHANNEL` / `ADE_DESKTOP_APP_NAME`). The desktop attaches to the same machine runtime; if the daemon is not running, the desktop spawns and waits for it via `LocalRuntimeConnectionPool`.

## CLI surface (selected)

```bash
ade desktop
ade runtime status --text
ade runtime start
ade runtime stop
ade auth status
ade doctor --json
ade projects list --text
ade init
ade lanes list --text
ade lanes create "fix-checkout-flow" --parent main
ade lanes create "lin-123" --linear-issue-json '{"id":"...","identifier":"LIN-123","title":"...","projectId":"...","projectSlug":"...","teamId":"...","teamKey":"...","stateId":"...","stateName":"Todo","stateType":"unstarted","priority":2,"priorityLabel":"high","labels":[],"assigneeId":null,"assigneeName":null,"createdAt":"...","updatedAt":"..."}'
ade --role cto linear quick-view --text
ade --role cto linear search-issues --query "auth" --state-type started,unstarted --first 50
ade git commit --lane lane-id
ade git push --lane lane-id
ade git branches --lane lane-id --text
ade git user-identity --lane lane-id --text
ade diff patch --lane lane-id --path src/file.ts --text
ade prs create --lane lane-id --base main --title "Fix checkout flow"
ade prs create --lane lane-id --base main --close-linear-issue-on-merge
ade prs list-open --text
ade prs path-to-merge --pr pr-id --model gpt-5.5 --max-rounds 3 --no-auto-merge
ade prs path-to-merge --pr pr-id --model gpt-5.5 --conflict-strategy auto --force-finalize conditional
ade prs pipeline pr-id save --conflict-strategy rebase --no-early-merge-on-green
ade run defs --text
ade run start web --lane lane-id
ade shell start --lane lane-id -- npm test
ade shell start-cli codex --lane lane-id --permission-mode edit --message "fix failing tests"
ade shell start-cli --provider claude --lane lane-id --permission-mode default
ade chat create --lane lane-id --model gpt-5.5
ade code
ade code --embedded
ade tests run --lane lane-id --suite unit --wait
ade proof list --arg ownerKind=chat --arg ownerId=session-id
ade ios-sim devices --text
ade --socket ios-sim apps --text
ade --socket ios-sim launch --target target-id --text
ade --socket ios-sim preview-render --source apps/ios/ADE/Views/Home.swift --index 0 --text
ade --socket app-control launch --command "npm run dev" --text
ade --socket browser open http://localhost:5173 --new-tab --text
ade --socket macos-vm status --lane lane-id --text
ade --socket macos-vm start --lane lane-id --create --no-display --text
ade --socket update status --text
ade --socket update check --text
ade --socket update install --text
ade usage snapshot --text
ade usage refresh --text
ade usage budget get --text
ade usage budget set --from-file budget.json
ade usage budget check --provider claude --scope global
ade usage budget cumulative --scope global --text
ade actions list
ade actions run git.stageFile --arg laneId=lane-id --arg path=src/index.ts
ade cursor cloud agents list --text
ade cursor cloud agents create --repo https://github.com/owner/repo --prompt "fix flaky test" --auto-pr
```

Use typed commands first. They validate common arguments and provide stable JSON fields or readable text summaries. Use `ade help <command> <subcommand>` for exact flags, `ade actions list --text` to discover the full service-backed action catalog, and `ade actions run <domain.action>` only when there is no typed command for the workflow yet.

Output modes are explicit: `--text` for human-readable summaries, `--json` (default for piped output) for stable JSON, and `--pretty` for pretty-printed JSON.

`--socket` requires the daemon and fails fast when it is missing. Without `--socket`, the CLI auto-attaches when reachable and falls back to headless for commands that can run that way.

## `ade auth` and `ade doctor`

ADE CLI auth is local project access, not a separate cloud login. `ade auth status` verifies that the current terminal can initialize an ADE runtime for the project. Provider credentials, GitHub tokens, Linear tokens, and computer-use policy are read from ADE project settings and the existing secure stores.

`ade doctor` reports local-only readiness metadata by default:

- CLI version, Node/runtime version, project root, workspace root, `.ade` initialization, and config file presence.
- Machine socket path, whether the socket exists, and whether this invocation is using `runtime-socket`, `desktop-socket`, or `headless` mode.
- RPC tool count, ADE action count, and action counts by domain.
- Git repository readiness and GitHub readiness signals from local remotes, `gh` availability, and token environment presence.
- Linear readiness from local encrypted token presence or headless environment variables.
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

The dev scripts are the same runtime daemon, just running from source against a temporary socket so a packaged ADE on the same machine is not affected:

```text
/tmp/ade-runtime-dev.sock
```

From an ADE lane checkout under `.ade/worktrees/`, the dev scripts keep using
that lane's source code, but default the ADE project root back to the primary
checkout. `npm run dev:code` also passes the lane checkout as the workspace root
so initial lane selection matches `ade code` launched directly from the lane.

Full matrix:

```bash
npm run dev:desktop          # desktop only; dev socket; desktop may auto-create runtime
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

Use these when you want a production-shaped local app without going through the GitHub release workflow. Alpha builds from the current checkout under `apps/desktop/release-alpha`; beta fetches `origin/main`, fast-forwards the local `main` checkout when possible, and writes artifacts under `apps/desktop/release-beta`. Use the dev scripts when you want Vite/Electron live reload, the temp dev socket, and the dev-only Electron profile. Local channel packages include the host runtime binary for the build machine. GitHub release builds use and validate the full cross-platform runtime artifact set.

The `prs path-to-merge` and `prs pipeline save` commands persist a partial `PipelineSettings` patch via `issue_inventory.savePipelineSettings` before launching the resolver. The Path to Merge orchestrator reads these from saved settings, so the same flags work either way:

| Flag | PipelineSettings field | Values |
| --- | --- | --- |
| `--max-rounds <n>` (alias `--rounds`) | `maxRounds` | positive integer |
| `--auto-merge` / `--no-auto-merge` | `autoMerge` | boolean |
| `--merge-method <m>` | `mergeMethod` | `repo_default` \| `merge` \| `squash` \| `rebase` |
| `--conflict-strategy <s>` | `conflictStrategy` | `pause` \| `rebase` \| `merge` \| `auto` |
| `--force-finalize <m>` | `forceFinalizeMode` | `off` \| `conditional` \| `unconditional` |
| `--force-finalize-require-no-ci` / `--force-finalize-allow-ci` | `forceFinalizeRequireNoCiFailures` | boolean |
| `--early-merge-on-green` / `--no-early-merge-on-green` | `earlyMergeOnGreen` | boolean |

To set fields without a dedicated flag (for example `autoAgentSettings`), call the action directly:

```bash
ade actions run issue_inventory.savePipelineSettings --args-list-json \
  '["pr-1",{"autoAgentSettings":{"provider":"claude","model":"sonnet","reasoningEffort":"high","permissionMode":"guarded_edit","confidenceThreshold":0.7}}]'
```

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
```

The standalone `create-lane` action is deprecated. By default the CLI auto-migrates a rule whose first action is `create-lane` into `execution.laneMode: "create"` and carries the template forward. Pass `--allow-legacy` on `create` / `update` to opt out of the migration.
