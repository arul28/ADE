# Local development

Everything you need to run, test and package DAEX from a checkout. The README
keeps the short version; this is the full reference.

The CLI is `daex`; `ade` is a permanent alias and works in every command
below. Internal names keep the old spelling on purpose (`ADE_*` env vars,
`~/.ade`, `.ade/` folders, the `ADE Alpha.app` bundle); see
`docs/brand/README.md`.

## Glossary

| Term | Meaning |
| --- | --- |
| Brain | The always-on, machine-owned DAEX process for one channel. It carries the sync websocket, project catalog, local RPC endpoint and executor authority. |
| Runtime | The machinery that opens databases and runs agents, PTYs, git and orchestration. A runtime process can host the brain role; "brain" is the authority and lifecycle term. |
| Manual runtime | A foreground runtime started with `daex runtime run --socket <path>`. Sync is always off. |
| Machine | A computer with a per-channel DAEX home and a stable sync device identity. |
| Channel | A build line such as stable, alpha or dev. Each has its own home. Beta is an update track of stable, not a channel. |
| Client | A surface that attaches to the brain: desktop, the iPhone app, or an SSH-bound desktop window. |
| Project | A registered repo with one database at `<project>/.ade/ade.db`. |
| Lane | A task worktree under `.ade/worktrees/` that shares the project database. |
| Catalog | The machine-level project list the brain serves to clients and the phone. |

## Brain vs. manual runtime

| Capability | Brain | Manual runtime |
| --- | --- | --- |
| Lifecycle | Always-on login service for a channel; a packaged desktop installs or repairs it. | Foreground process started with `daex runtime run --socket <path>`. |
| Sync, phone websocket, pairing PIN, catalog authority | Yes. | No; `runtime run` forces sync off, and the phone ignores manual runtimes. |
| Runs agents, PTYs, git, lanes, PR work | Yes. | Yes. |
| Clients | Desktop and the phone attach to it; SSH-bound windows attach to the remote machine's transport. | Only clients pointed at its endpoint. |
| Survives client close | Yes, when service-owned. | Only while the foreground process runs. |

## What to rebuild after a change

| Change you made | What to run/test | Why |
| --- | --- | --- |
| iOS UI-only change | Build the iOS app from the lane and connect it to an existing brain. | The phone is a client. |
| iOS sync protocol, catalog, pairing or remote-command change | Rebuild and restart the target brain from the lane, then build the iOS app from the same lane. | Both sides need the new contract. |
| Desktop renderer UI change | Run Desktop from the lane against the channel brain. | Renderer code is client-side unless it needs new brain APIs. |
| Desktop main/preload/runtime-bridge change | Run Desktop from the lane; restart the brain only if the RPC contract or brain behavior changed. | Some handlers route through the brain. |
| Brain, sync, catalog, pairing, agents, PTYs, lanes, PR workflows or CLI runtime service | Rebuild the CLI/brain from the lane and restart the target brain before testing clients. | Installed brains keep running old code. |
| Manual runtime behavior | Start `daex runtime run --socket <path>` from the lane and point a client at it. | Manual runtimes are standalone. |
| Remote runtime / SSH transport | Test against a remote target with lane-built desktop and runtime artifacts. | SSH windows talk to the remote transport. |
| Docs or web-only change | Run that surface's preview or static checks. | No brain or client lifecycle is involved. |

## Running DAEX locally

First-time setup:

```bash
npm run setup
```

`setup` (`scripts/install-apps.mjs`) installs desktop, ade-cli, web,
`packages/sdk` and `packages/chat-ui` in their own folders, and the five
Cloudflare Workers (`apps/account-directory`, `password-key-service`,
`push-relay`, `tunnel-relay`, `webhook-relay`) with one `npm install` at the
repo root: they are one npm workspace with one root `package-lock.json`. To
install only the Workers, run `npm ci` at the repo root.

`npm install` does not download the Electron binary; `setup` and `npm run dev`
fetch it through `apps/desktop/scripts/ensure-electron.cjs` and fail with the
download's exit code if they cannot.

Use Node 24 (the version in `.nvmrc`). CI and release builds use it too. The
`daex` CLI itself runs on Node 22.13 or newer; before 24.14 it ignores
`HTTPS_PROXY` (a brain says so once at start). See
[Building the static runtime](#building-the-static-runtime) for the embedded
Node.

Daily desktop dev:

```bash
npm run dev
```

`dev` runs `dev:desktop` (`scripts/dev-desktop.mjs --auto`): it rebuilds
`apps/ade-cli`, refreshes the shared dev runtime at `/tmp/ade-runtime-dev.sock`
when needed, launches the Electron app and points it at that runtime.

**This is the only supported way to run a dev app on a machine that also runs
the installed DAEX.** The dev brain shares `~/.ade` (your account, projects and
sync identity) and starts with `--no-sync`, so it can never take the
machine-wide sync host lease. Its own socket keeps it from taking over chats the
installed brain runs: while the installed brain is live on the project, the dev
brain does not recover, prewarm or fire scheduled wakes for chats it does not
run, and a send, steer or interrupt for such a chat is refused with the owner's
socket. An unpackaged app never installs or repairs the brain service. The
launcher prints a dev isolation report (state root, socket, sync, account,
machines, project) before the window opens; read it.

Do not start `daex serve` by hand or copy `~/.ade` secrets into another home. (A
hand-run `daex serve` that finds the installed brain alive starts with sync off
and says so.) `ADE_DEV_RUNTIME_SYNC=1` opts a dev brain into sync on purpose and
is almost never what you want. When another machine must reach a branch brain,
use a [dev test machine](#test-what-other-machines-call-into-a-dev-test-machine).

### If you are an agent, start it detached

`npm run dev:desktop` runs in the foreground while the app is open. An agent
that runs it as an ordinary command holds its turn open, and when the harness
ends the turn it kills the process group and the window closes. Start it in the
background and wait for the report:

```bash
node scripts/dev-detached.mjs /tmp/ade-dev-<lane>.log \
  npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock
until grep -q 'dev isolation report' /tmp/ade-dev-<lane>.log; do sleep 2; done
cat /tmp/ade-dev-<lane>.log
```

A plain `&` is not enough: it does not survive a SIGTERM to the process group.
The script puts the app in its own session.

Rules (`AGENTS.md` and the context skill link here):

- **Pick your own socket.** The default `/tmp/ade-runtime-dev.sock` is shared;
  two dev brains on one socket restart each other. Use one path per lane and
  keep using it, so `--attach` finds it.
- **Read the isolation report first.** If it says `sync : ON`, stop and fix
  that: a dev brain holding the sync host lease drops the installed brain's
  tunnel and kills the agents under it.
- **Never hand-start `daex serve`**, never set a fresh `ADE_HOME`, never copy
  `~/.ade` secrets, and never run a packaged build on a machine serving live
  agents.
- **Testing something saved to the account.** With sync off, a dev brain has no
  account stores. Start the app with `ADE_DEV_ACCOUNT_STORES=1` to open your
  real account's settings and vault in a folder of the dev brain's own
  (`~/.ade/dev-account-stores/<pid>`, deleted when it stops). Sync stays off.
  The report's `account` line says which mode you are in. What you save reaches
  all your machines, so remove test entries when you finish.
- **`--no-sync` protects the sync lease only.** A dev brain still opens the same
  project `.ade/ade.db` and sees every chat in every lane, so do not restart one
  casually while other lanes are working. Use a throwaway project for full data
  isolation.
- **A dev desktop never connects to your other machines on its own.** Every
  DAEX on this computer shares the device pairing in `~/.ade`, and a paired
  machine keeps one connection per device. An unpackaged desktop connects only
  when someone presses Connect in it (`explicitConnectOnly`), and the report's
  `machines` line says so. Pressing Connect takes that machine from the
  installed app: press Connect there afterwards. Do not press Disconnect in a
  dev app; it saves "don't auto-connect" to the shared machine list.
  `ADE_DEV_REMOTE_AUTOCONNECT=1` restores auto-connect on purpose.
- **Close the app before you edit main-process code.**
  `apps/desktop/scripts/dev.cjs` watches the main build (`tsup --watch` over
  `src/main`, the preload and the `src/shared` code they import) and relaunches
  Electron after every rebuild, bringing the window to the front. Renderer-only
  edits hot-reload through Vite. If you did not change brain code and your dev
  brain still runs, `npm run dev:desktop:attach -- --socket <your socket>`
  reopens just the window.
- **Mind the machine's memory.** One dev app per agent, only while you use it.
  Before you start a dev app, brain, simulator or build, check free memory
  (`memory_pressure | tail -1` on macOS) and wait while it is under about 30%.
  A dev app started from an agent's shell opens no detached DevTools window;
  attach over CDP, or set `ADE_OPEN_DEVTOOLS=1`. An App Control launch passes
  `NO_DEVTOOLS=1` itself.
- **Stop what you started, brain included.** Stop the dev app's process group
  (the pid `dev-detached.mjs` printed), then confirm its brain exited:
  `pgrep -fl "<your socket>"`. A full desktop typecheck takes an 8 GB heap; do
  not run two at once.

Run from a lane worktree under `.ade/worktrees/`, these commands run that
lane's code but open the primary checkout's project data by default
(`--project-root` overrides it).

Dev command matrix:

```bash
npm run dev:desktop          # refresh the shared dev runtime, then launch desktop
npm run dev:desktop:attach   # desktop only; fails if the dev runtime is not running or its build differs
npm run dev:desktop:clean    # like dev:desktop, after clearing the Vite cache
npm run dev:desktop -- --first-run  # walk setup as a brand-new user (below)
npm run dev:runtime          # runtime only, in the foreground
npm run dev:all              # start the shared dev runtime, then dev:desktop:attach
npm run dev:stop             # stop the dev runtime (same as npm stop)
npm run dev:clean-data       # list dev user-data folders; --yes removes stale ones
```

### Test what other machines call into: a dev test machine

A dev brain runs `--no-sync`, so nothing else can reach it. For a change
another machine calls into (a cloud computer asking this Mac for a simulator,
the phone, another computer's desktop), run this checkout's brain as its own
machine instead of replacing the installed brain:

```bash
npm run dev:machine -- start            # builds the CLI if needed; prints a report
npm run dev:machine -- login            # once: approve the code; it is named "<Mac> (dev)"
npm run dev:machine -- project --clone  # a --shared clone of this repo, on this branch
# from any machine on the account:
daex lanes list --machine "<Mac> (dev)"
daex apple start --machine "<Mac> (dev)"
npm run dev:machine -- stop             # keeps its home and sign-in
npm run dev:machine -- remove           # signs out (its account row goes) and stops
```

`--name <n>` runs more than one. What keeps it apart from the installed app
(`apps/ade-cli/src/services/sync/devTestMachine.ts`):

- **Its own home,** `~/.ade-dev-machine-<name>`: its own machine key, device
  id, sign-in and account row. The row's hardware anchor hashes the home path,
  so it never merges with this computer's row.
- **Its own sync lease** and the next free sync port. Brains skip a brain
  started with `--dev-test-machine` in their listener scan.
- **No Tailscale entry.** It is reached over the relay or the LAN.
- **No shared project.** Any `daex` command on its home refuses a project the
  installed app (or Alpha) has registered, or a folder inside one. `project
  --clone` gives it a clone with the real `origin`, which is how `--machine`
  finds the repository.

Approving the sign-in code needs a browser signed in to your account; an agent
can use the DAEX browser (`daex browser open <the printed URL>`). A dev desktop
can connect to the test machine like any other (Connections, Connect).

### Walk first-run setup as a new user

`npm run dev:desktop -- --first-run` is the one sanctioned exception to "share
`~/.ade`". It runs the dev app the way a new user meets DAEX, and nothing it
does reaches your setup.

- Its own home, `~/.ade-dev-first-run`. Every launch empties it **except its
  account sign-in**.
- Its own brain socket (`ade-runtime-first-run`, unless `--socket`), sync off,
  fresh Electron app data, and Home with no project open (`--home`).
- Shared on purpose: the agents' own history (`~/.claude`, `~/.codex`, ...),
  which setup reads to find projects, and the provider CLIs' logins. A project
  you open from it is still the real repo, so use a scratch project when the
  tour sends its first chat.

`--first-run --keep` skips the reset and reopens as a returning user. In dev
builds the command palette also has **Dev: Suggestions test mode** and **Dev:
Reset Tips, suggestions and What's new**.

Sign it in once, as its own device: through the app's sign-in card, or
`ADE_HOME=~/.ade-dev-first-run daex --socket /tmp/ade-runtime-first-run.sock login`.
Never copy `~/.ade/secrets` into it: a copied session shares a refresh token,
and whichever rotates it first signs the other out. The launcher refuses to
reset the home while a brain listens on its socket.

### Browser preview of the renderer

```bash
cd apps/desktop
npm run dev:vite             # mock-only: synthetic window.ade, fast shell
ADE_PROJECT_ROOT=/path/to/project npm run dev:vite:live   # mock + live runtime bridge
```

`dev:vite:live` starts the dev runtime, a localhost HTTP bridge to it, and Vite
with a proxy, so the browser can call real backend methods on top of the mock.
Set `ADE_PROJECT_ROOT` to your primary checkout. Details:
[apps/desktop/README.md](../../apps/desktop/README.md).

### Dev endpoints, logs and environment

The dev commands use a temp endpoint and a separate Electron profile:

```text
/tmp/ade-runtime-dev.sock
~/Library/Application Support/ade-desktop-dev
```

The auto-started runtime is detached, so its output goes to an append-only log
(`0600`, truncated past about 20 MB, best effort):

```text
~/.ade/runtime/dev-runtime.out.log
```

The launcher strips the detached runtime's environment: caller and run identity
(`ADE_CHAT_SESSION_ID`, parent chat, spawn, browser token, run ids),
lane/project/workspace bindings (`ADE_LANE_ID`, `ADE_PROJECT_ROOT`,
`ADE_WORKSPACE_ROOT`), `ADE_DEFAULT_ROLE`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`
when they point into a DAEX `provider-homes` folder, the `CLAUDECODE` /
`CLAUDE_CODE_*` markers, `ADE_RUNTIME_PARENT_PID` and `ADE_RUNTIME_IDLE_EXIT_MS`.
`PATH`, `HOME`, the perf-run id and outside provider paths stay.

A hand-started brain does the same cleanup when it detects an agent shell, and
reports what it removed. A plain `daex serve` defaults to role `agent`, which
refuses desktop, phone and web clients; for those use `daex --role cto serve`.

A separate `ADE_HOME` does not isolate a project. Each project keeps its
database in `<project>/.ade/ade.db`, so a test brain on `~/.ade-alpha` that opens
`~/Projects/ADE` writes the same database as the installed brain. Register only
a throwaway project in a test home, and check `lsof <project>/.ade/ade.db` to see
who holds a project's database.

Overrides:

```bash
npm run dev:desktop -- --socket /tmp/my-ade-dev.sock
ADE_DEV_RUNTIME_SOCKET_PATH=/tmp/my-ade-dev.sock npm run dev:runtime
ADE_DESKTOP_BRIDGE_SOCKET_PATH=/tmp/my-bridge.sock npm run dev:desktop
```

> [!WARNING]
> Never point `--socket` at a runtime you do not want restarted. In `--auto`
> mode the wrapper **shuts down and recreates** whatever runtime listens on that
> endpoint when its build hash does not match the checkout, so aiming at the
> production `~/.ade/sock/ade.sock` or another lane's runtime kills it and its
> clients. Use a fresh per-lane endpoint, or `npm run dev:desktop:attach --
> --socket <path>`, which refuses on a build-hash mismatch instead.

A brain that `dev:desktop` starts exits when the launcher exits. A brain from
`npm run dev:runtime`, or one a launcher left behind, exits after 20 idle
minutes (`ADE_RUNTIME_IDLE_EXIT_MS`, set in `scripts/dev-shared.mjs`); set
`ADE_DEV_RUNTIME_IDLE_EXIT_MS` (ms, `0` disables) on the launch command to
change it.

Starting a brain on a home that already has one prints who else is there and
logs `brain.home_shared`. A record counts only while its pid is a process with
the start time it wrote (`isBrainRecordLive`); on Linux a pid whose
`/proc/<pid>/status` Tgid names another process is a thread, so its record is
gone. List brains and their homes before assuming:

```bash
pgrep -alf "cli.cjs serve|/bin/ade serve|/bin/daex serve"
ps eww -p <pid> | tr ' ' '\n' | grep ADE_HOME   # no output = the shared ~/.ade
```

### Agent CLIs in a dev run

A dev app or source-checkout brain runs DAEX's own pinned agent CLIs, never the
ones on your PATH. Codex, Claude Code, OpenCode and the Copilot runtime come from
the checkout's `node_modules` (the lockfile is the pin). The other pins (Droid,
Grok, Qwen, Kimi, Devin, Antigravity, Pi, the Copilot and Cursor terminal CLIs,
Node, Muse) download into the shared tools root the first time a chat, probe or
terminal needs them. A dev run does no startup download pass.

| Variable | Use |
| --- | --- |
| `ADE_TOOLS_ROOT=/tmp/<dir>` | Download into a throwaway tools root, so `~/.ade/tools` stays untouched. |
| `ADE_DISABLE_TOOLS_FETCH=1` | No downloads. Missing tools read "DAEX has not downloaded <Tool> for this machine, and downloads are turned off in this DAEX process." |
| `ADE_FORCE_TOOLS_FETCH=1` | A source-checkout `daex serve` behaves like a packaged one (startup pass included). |

Your own CLI build is a dev hook only: `CLAUDE_CODE_EXECUTABLE_PATH`,
`CODEX_EXECUTABLE`, `DROID_EXECUTABLE`, `ADE_PI_PACKAGE_ROOT`,
`ADE_MUSE_EXECUTABLE` and the ACP `<PROVIDER>_EXECUTABLE` variables. See
[agent tools cache](../features/onboarding-and-settings/agent-tools-cache.md#dev-checkouts).

### Building the static runtime

`npm run build:static` in `apps/ade-cli` (`scripts/build-static.mjs`) embeds the
Node it runs on in the headless runtime. It warns when that Node is older than
24.14 (which ignores `HTTPS_PROXY`) and refuses one older than 22.19.0 (the
runtime runs Pi's SDK worker on its own Node). `ADE_STATIC_NODE_BINARY` picks
another Node binary. On Apple Silicon, `npm run build:static -- --target
darwin-x64` builds the Intel runtime when `ADE_STATIC_NODE_BINARY` names an
official darwin-x64 Node (`node scripts/release-tools/officialNodeBinary.mjs
--target darwin-x64` downloads one) and Rosetta 2 is installed.

### On Windows

Everything above applies, with these differences. See also
[windows-support.md](./windows-support.md).

**Endpoints are named pipes.** Pass a pipe name to `--socket`:

```powershell
node scripts/dev-detached.mjs "$wt\perf\dev.log" npm run dev:desktop -- `
  --socket '\\.\pipe\ade-runtime-dev-<lane>' `
  --project-root "C:\Users\<you>\Documents\Programming\ADE" `
  --remote-debugging-port=9413
```

**The printed pid is a console host.** `dev-detached.mjs` and the dev brain run
their command under `scripts/dev-console-host.mjs`, which gives it a hidden
console (otherwise every `cmd.exe`, `git` and probe under it flashes a terminal
window). Stop the whole tree with `taskkill /T /F /PID <pid>`.

**Launch from PowerShell, not Git Bash.** MSYS rewrites POSIX-looking paths, so
`\\.\pipe\ade-runtime-dev-x` reaches Node as `C:\pipe\ade-runtime-dev-x` and the
runtime exits. `MSYS_NO_PATHCONV=1` also works.

**Do not set `ADE_HOME`.** Your account lives in `~/.ade`; a private home gives
you a dev app on a sign-in page with no projects. The launcher refuses an
alternate home and names the escape hatch (`ADE_DEV_ALLOW_ALT_HOME=1`). Share
`~/.ade`, isolate the pipe.

**The CLI resolves the project from the shell's cwd.** `daex lanes create` run
from `.ade/worktrees/<lane>` acts on the **primary project**, whatever the dev
app opened, and has created real lanes, branches and pushes that way. Prefer
driving the dev window (CDP, App Control). If you must use the CLI, `cd` into the
target project, set `ADE_HOME` and `ADE_RUNTIME_SOCKET_PATH`, and run one
read-only command first. A dev brain reports version `1.0.0-beta.1`; the
installed one reports the release version.

**Verify, do not assume.** A stale `ade.exe` earlier on `PATH` once spawned a
dev brain on the Stable endpoint. After launching, check:

```powershell
# the installed brain still owns the stable pipe, and its heartbeat advances
Get-Content "$env:USERPROFILE\.ade\brains\<installed-pid>.json"
Get-Content "$env:USERPROFILE\.ade\runtime\heartbeat.json"   # seq must climb
[System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -match 'ade-runtime' }
```

Stop only the PIDs you started, and remove only your own
`~/.ade/brains/<pid>.json` record.

**One brain per project database for clean numbers.** A contended SQLite write
blocks the brain's event loop (`node:sqlite` is synchronous), and a lock whose
release depends on the blocked loop waits the full `busy_timeout` (5,000 ms) and
throws `database is locked`. Two brains on one project are fine for reproducing
behaviour, wrong for before/after numbers.

#### Measuring on Windows

- `ADE_TRACE_IPC=1` (or `verbose`) logs IPC invoke summaries; tracing is on in
  an unpackaged app.
- `ADE_PERF_RUN_ID=<id>` appends every IPC invoke, main-loop delay, long task
  and renderer-memory sample to `~/.ade/perf-runs/<id>/events.jsonl`. Look at
  the gaps between events to tell work from waiting.
- To profile a brain you must not restart, `node -e
  "process._debugProcess(<pid>)"` opens its inspector on 127.0.0.1:9229 until
  that process exits; a short `Profiler.start`/`stop` is read-only.

Traps that give confident, wrong answers:

- **`window.ade` cannot be monkey-patched.** `contextBridge` freezes it, so a
  wrapper reports hundreds of wrapped methods and records zero calls. Time IPC
  in main or the preload.
- **"The DOM stopped mutating" is not "it finished loading."** Measure
  something content-shaped, such as the transcript's `scrollHeight`
  stabilising.
- **State carries between trials.** The app restores the last-selected chat, so
  a "cold open" is usually warm. Vary the target or relaunch.
- **Process CPU cannot measure a renderer on a many-core box.** Use a CDP trace.
  See `scripts/perf-animation-lab/README.md`.

Calibration on a healthy Windows dev app: switching between real chats takes
53-111 ms to first content and settles in 0.3-1.4 s, with the brain about 98.6%
idle. A multi-second stall with an idle brain and no long tasks is latency: look
for polls, debounces and idle-callback starvation.

## Run a specific lane worktree

Run `dev:desktop` **from the lane checkout** on its own endpoints. Vite serves
that lane's code, and project data resolves to the primary checkout:

```bash
cd /path/to/ADE/.ade/worktrees/<lane>
ADE_DESKTOP_BRIDGE_SOCKET_PATH=/tmp/ade-desktop-bridge-<lane>.sock \
  npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock
```

The per-lane bridge endpoint avoids the installed app's
`~/.ade/sock/desktop-bridge.sock`. A fresh worktree has no `node_modules`: run
`npm run setup` inside it first, or give the project a lane template that
installs them (Settings > Lane templates > Set up with an agent).

Launching that flow through App Control from a running Alpha window: clear the
inherited packaged-channel variables and use an absolute cwd, or the dev app
reuses the Alpha profile and loses the single-instance lock:

```bash
daex --socket app-control launch --force \
  --cwd "/path/to/ADE/.ade/worktrees/<lane>" \
  --command "sh -lc 'ADE_PACKAGE_CHANNEL= ADE_DESKTOP_APP_NAME= ADE_DESKTOP_BRIDGE_SOCKET_PATH=/tmp/ade-desktop-bridge-<lane>.sock npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock'" \
  --text
```

App Control runs a launch with no `--cwd` in the caller's lane worktree;
`daex app-control status` shows the `cwd` it used.

### Each lane's dev app has its own user-data folder

Electron keeps its single-instance lock in the user-data folder. `dev:desktop`
from a lane worktree uses `ade-desktop-dev-<lane>` (printed as `user data :`);
the primary checkout keeps `ade-desktop-dev`. `ADE_DESKTOP_USER_DATA_PATH` wins.

- A new lane folder copies `ade-state.json` from `ade-desktop-dev` once.
- On any `ADE_HOME` other than `~/.ade`, the app gets a folder for that home
  (`…-home-<name>-<hash>`) that copies nothing, so a scratch home never picks up
  real projects.
- If two dev apps still share a folder, the second prints which app holds it
  and exits.
- Each lane folder has a `.ade-dev-lane.json` marker. `dev:desktop` removes
  marked folders whose worktree is gone or that went unused for 30 days.
  `npm run dev:clean-data` lists every folder with its size; `--yes` removes the
  stale ones, `--include-unmarked` also removes unmarked ones no app uses.

### Test Mac Desktop in the dev app

Mac Desktop needs the native helper and two macOS grants, both usable from the
dev app:

```bash
cd /path/to/ADE/.ade/worktrees/<lane>
npm --prefix apps/desktop run build:desktop-driver   # resources/native/ade-desktop-driver
ADE_DESKTOP_BRIDGE_SOCKET_PATH=/tmp/ade-desktop-bridge-<lane>.sock \
  npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock
```

The dev app runs the Electron binary from `node_modules`, signed by the dev
launcher (below), so macOS keeps the Screen Recording and Accessibility grants
across rebuilds; grant them once for "Electron". Because the dev brain does not
host sync it never publishes to the account, so the Connections card is not
testable this way; the Mac Desktop pane is. Use `--project-root` to point at a
throwaway project. The floating corner preview shows only for chat sessions.

To test auto-runtime creation, run `npm run dev:stop`, then `npm run dev:desktop`.

## Test the push relay locally

To test `/attention/*`, account settings and the `/cloud/*` reads against a
local push relay:

1. Run the relay as its own process: `wrangler dev --local --port 8824
   --env-file <relay env file>`. Do not run it in one `wrangler dev -c a -c b`
   with the account directory: the env file reaches only the first worker.
2. In the relay env file set `VAULT_ENCRYPTION_KEY` (32-byte base64),
   `DIRECTORY_AUTH_SECRET` (same as the directory), the Clerk client id, and
   `WEB_CLIENT_ORIGIN` to the web client's exact dev origin
   (`http://localhost:5174` by default), or the relay refuses the browser
   (CORS).
3. Start the web client with
   `ADE_DEV_PUSH_RELAY_PROXY_TARGET=http://127.0.0.1:8824`. Without it the dev
   proxy sends `/attention/*` to the production relay.

The directory's `ACTIVITY_RELAY` binding reaches the relay through the wrangler
dev registry. With no `AGENT37_API_KEY`, `/cloud/instances` answers 503 locally.

## Build DAEX Alpha locally

A local packaged macOS Alpha build, without the release workflow:

```bash
npm run package:alpha        # current checkout -> ADE Alpha.app, ade-alpha, ~/.ade-alpha
```

`package:alpha` (`scripts/package-channel.mjs alpha`) builds exactly the
checkout you are in. Outputs:

```text
apps/desktop/release-alpha/mac-arm64/ADE Alpha.app
apps/desktop/release-alpha/ADE-Alpha-local.zip
```

Beta is not a local build; it is an update track of the normal install
(Settings > About > Updates), built by `.github/workflows/beta.yml`. To build one
branch once: `gh workflow run beta.yml -f preview_ref=<branch>`. See
[Update tracks](../features/onboarding-and-settings/desktop-auto-update.md#update-tracks-stable-and-beta).

Every Alpha build has a per-build version `<base>-alpha.<yyyymmddHHMM>` (UTC),
where `<base>` is the newest reachable `v*` tag (or the `apps/desktop/package.json`
version). It goes into the app's `version`, `ADE_CLI_VERSION` for the bundled CLI
and `ADE_DESKTOP_VERSION` for the Windows wrapper, so a fresh Alpha never reuses
a brain from an earlier build (the runtime gate treats equal versions as
compatible).

Install it by replacing the app in `/Applications`:

```bash
rm -rf "/Applications/ADE Alpha.app"
ditto "apps/desktop/release-alpha/mac-arm64/ADE Alpha.app" "/Applications/ADE Alpha.app"
xattr -dr com.apple.quarantine "/Applications/ADE Alpha.app" 2>/dev/null || true
```

Re-pin a Dock icon after installing: Dock icons keep the exact path they were
pinned from.

Replacing the app does not replace a running brain. Close sessions that depend
on it, then restart and verify the channel brain:

```bash
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" daex brain status --text
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" daex brain restart --text
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" daex doctor --text
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" daex sync status --text
```

Do not kill brain processes directly during normal testing. If an old
incompatible brain stays running, the packaged desktop may launch a private
no-sync fallback runtime for its window.

Launching a packaged channel build installs or repairs that channel's brain
service, and the service should report the same runtime build hash as the
packaged CLI:

```bash
launchctl print gui/$(id -u)/com.ade.runtime.alpha
ls -l ~/Library/LaunchAgents/com.ade.runtime.alpha.plist ~/.ade-alpha/sock/ade.sock
```

Set or rotate the channel's phone pairing PIN from **Connections > Mobile**, or:

```bash
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" daex brain pin generate
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" daex brain pin set 123456
```

Alpha never touches the production `ADE.app`, `daex`/`ade` or `~/.ade`, and uses
its own Electron profile (`ade-desktop-alpha`). Local channel packages include
only this Mac's runtime binary.

### Alpha builds and macOS permission grants

A channel build has no Developer ID certificate, so by default it is signed
ad-hoc and its designated requirement is its cdhash, which changes on every
build: macOS drops its Screen Recording and Accessibility grants each time. A
self-signed code-signing certificate makes the requirement the bundle id plus
the certificate leaf, so grants survive.

Create it once:

1. Keychain Access > Certificate Assistant > Create a Certificate.
2. Name it exactly `ADE Local`, Certificate Type `Code Signing`.
3. Run a channel build and press `Always Allow` on the keychain prompt.

Then remove ADE Alpha from Screen Recording and Accessibility and add it back
once. The build prints "Signing identity: ADE Local" when it is used.

The packager picks `ADE Local` automatically. `--sign "<identity>"` or
`ADE_CHANNEL_SIGN_IDENTITY` picks another (a name or SHA-1). Developer ID is
never picked automatically. Without any, the build stays ad-hoc and warns.

The dev launcher signs the lane's Electron in `node_modules` the same way
(`apps/desktop/scripts/sign-dev-electron.cjs`): `ADE Local`, else the first
`Apple Development:` identity, never Developer ID, so "Always Allow" on the login
Keychain holds across Electron upgrades. `ADE_DEV_SIGN=0` skips it;
`ADE_DEV_SIGN_IDENTITY` picks the identity.

Validate with `npm --prefix apps/desktop run typecheck` and the tests that cover
your change; `npm run test:desktop:sharded` is the full desktop suite (CI runs
it; see "Running checks" in `AGENTS.md`).
