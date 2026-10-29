# Local development

Everything you need to run, test, and package ADE from a checkout. The README
keeps the short version; this is the full reference.

## Glossary

| Term | Meaning |
| --- | --- |
| Brain | The always-on, machine-owned ADE process for one channel. It carries the sync websocket, project catalog, local RPC endpoint, and executor authority. |
| Runtime | ADE execution machinery: processes/services that open DBs and run agents, PTYs, git, and orchestration. A runtime process can host the brain role, but "brain" is the authority/lifecycle term. |
| Manual runtime | A foreground runtime process started explicitly with `ade runtime run --socket <path>`. Sync is always off; use it for dev/test work instead of the automated stable/alpha brain service. |
| Machine | A physical computer with a per-channel ADE home and stable sync device identity. |
| Channel | A build lane such as stable, alpha, or dev. Each channel has its own ADE home. Beta is an update track of stable, not a channel. |
| Client | A surface that attaches to the brain: desktop, `ade code`, ADE Mobile, or an SSH-bound desktop window. |
| Project | A registered repo with one ADE database at `<project>/.ade/ade.db`. |
| Lane | A task worktree under `.ade/worktrees/` that shares the project database. |
| Catalog | The machine-level project list served by the brain to clients and ADE Mobile. |

## Brain vs. manual runtime

This table describes the current code behavior.

| Capability | Brain | Manual runtime |
| --- | --- | --- |
| Lifecycle | Always-on login service for an ADE channel; Desktop can install/repair it in packaged builds. | Foreground process started explicitly with `ade runtime run --socket <path>`. |
| Owner | Machine / ADE install. | User or developer who launched it. |
| Sync | Yes. | No; `ade runtime run` forces sync off. |
| Mobile websocket | Yes. | No. |
| Phone pairing / PIN | Yes. | No. |
| Mobile/machine catalog authority | Yes. | No; it may expose registry data to explicitly attached clients, but ADE Mobile ignores manual runtimes. |
| Runs agents, PTYs, git, lanes, PR work | Yes. | Yes. |
| Clients | Desktop, `ade code`, and ADE Mobile attach to it; SSH-bound desktop windows attach to the remote machine's ADE transport. | Only clients explicitly pointed at its endpoint attach to it. |
| Survives client close | Yes, when service-owned. Desktop/TUI fallback spawns still exist for recovery and dev paths. | Only while that foreground process is still running. |

## What to rebuild after a change

| Change you made | What to run/test | Why |
| --- | --- | --- |
| iOS UI/client-only change | Build the iOS app from the lane and connect it to an existing ADE brain. | The phone is a client; UI-only work does not require a new brain. |
| iOS sync protocol, project catalog, pairing, or remote-command change | Rebuild/restart the target brain from the lane, then build the iOS app from the same lane. | The phone and brain both need the new contract. |
| Desktop renderer UI change | Run/build Desktop from the lane and let it attach to the channel brain. | Renderer code is client-side unless it depends on new brain APIs. |
| Desktop main/preload/runtime-bridge change | Run/build Desktop from the lane; rebuild/restart the brain only if the runtime RPC contract or brain behavior changed. | Electron main is a client/bridge, but some handlers route through the brain. |
| `ade code` / TUI UI change | Build/run `ade code` from the lane and attach to the existing brain. | The TUI is a client of the brain. |
| TUI command that depends on new RPC or shared types | Rebuild/restart the brain from the lane, then run the lane's `ade code`. | Both sides of the RPC contract must match. |
| Brain, sync, project catalog, pairing, agents, PTYs, lanes, PR workflows, or CLI runtime service change | Rebuild the ADE CLI/brain from the lane and restart the target brain before testing clients. | These live in the always-on process; existing installed brains keep running old code. |
| Manual runtime behavior | Start `ade runtime run --socket <path>` from the lane and point a client at that endpoint. | Manual runtimes are standalone and sync is always off. |
| Remote runtime / SSH transport change | Test with a remote target using the lane-built desktop/runtime artifacts. | SSH-bound windows talk to the remote ADE transport, not the local mobile brain. |
| Docs or web-only change | Run the docs/web preview or static checks for that surface. | No ADE brain/client lifecycle is involved. |

## Running ADE locally

First-time setup:

```bash
npm run setup
```

Since Electron 42, `npm install` no longer downloads the Electron binary; `npm run setup`
fetches it afterwards through `apps/desktop/scripts/ensure-electron.cjs`, the same step
`npm run dev` runs, and fails with the download's exit code if it cannot.

Daily desktop dev:

```bash
npm run dev
```

That aliases to `npm run dev:desktop`: it rebuilds `apps/ade-cli`, refreshes the shared dev runtime at `/tmp/ade-runtime-dev.sock` when needed, launches the Electron desktop app, and points desktop at that runtime. This is the normal desktop-dev flow.

**This is the only supported way to run a dev app on a machine that also runs the installed ADE.** The dev brain shares `~/.ade` (your account, projects, and sync identity are served by the installed brain) and is started with `--no-sync`, so it can never take the machine-wide sync host lease. Its own socket keeps it from taking over chats run by the installed brain, including across different ADE homes. While the installed brain is live on the project, the dev brain leaves chats it does not run to it: it does not recover or prewarm them or fire their scheduled wakes. Other dev brains do not make one another yield. Its own chats and messages sent directly to it still work; a send, steer or interrupt for a chat another brain runs is refused with the owner's socket instead of starting a second provider process. An unpackaged app never installs or repairs the launchd brain service. The launcher prints a dev isolation report (state root, socket, sync, project, installed brain untouched) before the window opens; read it. Do not start `ade serve` by hand or copy `~/.ade` secrets into another home. Use a separate `ADE_HOME` only for deliberate scratch-home work; a new home shows the account gate, and full project isolation also needs a throwaway project. `ADE_DEV_RUNTIME_SYNC=1` opts a dev brain into sync on purpose and is almost never what you want.

### If you are an agent, start it detached

`npm run dev:desktop` runs in the foreground for as long as the app is open. An
agent that runs it as an ordinary command holds its turn open until the app
exits, and when the harness ends the turn it kills the process group — so the
window the human was about to look at closes. Start it in the background and
wait for the report instead:

```bash
node scripts/dev-detached.mjs /tmp/ade-dev-<lane>.log \
  npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock
until grep -q 'dev isolation report' /tmp/ade-dev-<lane>.log; do sleep 2; done
cat /tmp/ade-dev-<lane>.log
```

A plain `&` is not enough: it survives the shell exiting but not a SIGTERM to
the process group, which is how a turn is torn down. The script puts the app in
its own session, so `electron exited (code=143)` mid-run stops happening.

The rules that go with it (`AGENTS.md` and the context skill link here):

- **Pick your own socket.** The default is `/tmp/ade-runtime-dev.sock` and it is
  shared. Two dev brains on one socket restart each other. Use one path per
  lane and keep using the same one, so `--attach` finds it.
- **Read the isolation report before anything else.** If it says `sync : ON`,
  stop and fix that: a dev brain holding the machine-wide sync host lease drops
  the installed brain's tunnel and kills the agents running under it.
- **Never hand-start `ade serve`**, never set a fresh `ADE_HOME`, never copy
  `~/.ade` secrets, and never run a packaged build on a machine serving live
  agents.
- **`--no-sync` protects the sync lease only.** It does not isolate the
  database: a dev brain still sees every chat and task in every lane, so do not
  restart one casually while other lanes are working.
- **A dev desktop never connects to your other machines on its own.** A paired
  machine (a Mac Studio, a Windows box) keeps one connection per device, and
  every ADE on this computer shares the device pairing in `~/.ade`. A dev app
  that reconnected saved machines took them from the installed ADE, which then
  showed "Another ADE on this computer is using the connection" and waited.
  An unpackaged desktop now connects only when someone presses Connect in it
  (`explicitConnectOnly` in `RemoteConnectionService`), and the isolation
  report says so on its `machines` line. Pressing Connect in a dev app still
  takes that machine from the installed ADE: press Connect in the installed app
  afterwards. Do not press Disconnect in a dev app either; it saves
  "don't auto-connect" to the shared machine list, which the installed app
  reads too. `ADE_DEV_REMOTE_AUTOCONNECT=1` restores auto-connect on purpose.
- **Close the app before you edit its main-process code, and reopen it when
  you need it.** `apps/desktop/scripts/dev.cjs` watches the main build (`tsup
  --watch` over `src/main`, the preload and the `src/shared` code they import)
  and relaunches Electron after every successful rebuild, and each relaunch
  brings the window to the front, over whatever the human is doing.
  Renderer-only edits go through Vite and hot-reload in place, with no
  relaunch. So once you have looked at what you needed, stop the dev app's
  process group before your next batch of such edits, and start it again only
  when you are ready to look at the result. If you did not change brain code
  and your dev brain is still running,
  `npm run dev:desktop:attach -- --socket <your socket>` reopens just the
  window. Never leave the app open while you edit main-process code.
- **Mind the machine's memory.** Run one dev app per agent, and only while you
  use it. Before you start a dev app, a dev brain, a simulator or a build,
  check `memory_pressure | tail -1` and wait while free memory is under ~30%:
  many lanes' dev apps, brains and simulators at once once filled a Mac
  Studio, and the installed ADE that hosts every agent kept crashing. A dev
  app an agent starts from its shell (an ADE chat or run) opens no detached
  DevTools window; attach over CDP instead, or set `ADE_OPEN_DEVTOOLS=1` to get
  it. An App Control launch cannot be told from a person's, so put
  `NO_DEVTOOLS=1` in its command. Run by hand, it still opens DevTools
  unless `NO_DEVTOOLS=1` is set. View > Toggle DevTools works either way.
- **Stop what you started, brain included.** Stop the dev app's process group
  (the pid `dev-detached.mjs` printed) and then confirm its brain exited:
  `pgrep -fl "<your socket>"`. A full desktop typecheck takes an 8 GB heap;
  do not leave one running in the background, and do not start a second while
  one is still going.

When these commands are run from an ADE lane worktree under `.ade/worktrees/`,
they still run code from that lane checkout, but they open the primary checkout's
project data by default. For example, running from
`/path/to/ADE/.ade/worktrees/my-lane` opens `/path/to/ADE` as the ADE project
and uses the lane path as the workspace root for `dev:code`.

Dev command matrix:

```bash
npm run dev:desktop          # refresh shared dev runtime, then launch desktop
npm run dev:desktop:attach   # desktop only; fail if dev runtime is not already running
npm run dev:desktop:clean    # desktop only; clear Vite cache before launch
npm run dev:desktop -- --first-run  # walk setup as a brand-new user, isolated from your ADE (below)
npm run dev:code:web          # `ade code` in the browser (PTY + inspector WebSocket)
npm run dev:code:attach      # terminal TUI only; fail if dev runtime is not already running
npm run dev:runtime          # runtime only in the foreground
npm run dev:all              # start shared dev runtime, then run desktop/code attach commands in separate terminals
npm run dev:stop             # stop the dev runtime
npm stop dev                 # same as dev:stop
```

### Walk first-run setup as a new user

`npm run dev:desktop -- --first-run` is the one sanctioned exception to "share
`~/.ade`". It runs the dev app the way a brand-new user meets ADE: the welcome
card, Connect your agents, Bring your projects in, the tour, and nothing it does
reaches your ADE.

- Its own ADE home, `~/.ade-dev-first-run`: project registry, personal chats,
  launch defaults, provider sign-ins, machine identity and account session.
  Every launch empties it **except its account sign-in**, so setup finds no
  project already in ADE and no saved choice.
- Its own brain socket (`ade-runtime-first-run`, unless `--socket`), sync off,
  fresh Electron app data, and Home with no project open (`--home`).
- Shared, on purpose: the agents' own history (`~/.claude`, `~/.codex`, …),
  which setup reads to find projects, and the provider CLIs' own logins. A
  project you open from it is still the real repo and its project database, so
  use a scratch project when the tour sends its first chat.

`--first-run --keep` skips the reset and reopens the same app as a returning
user: the visit where What's new pages and situational suggestions can show.
In dev builds the command palette also has **Dev: Suggestions test mode** (each
suggestion shows as soon as its signal is there, no cooldown or wait for a
later launch) and **Dev: Reset Tips, suggestions and What's new**.

Sign it in once, as its own device: through the app's sign-in card, or
`ADE_HOME=~/.ade-dev-first-run ade --socket /tmp/ade-runtime-first-run.sock login`.
Never copy `~/.ade/secrets` into it: a copied session shares a refresh token
with your ADE, and whichever rotates it first signs the other out. The launcher
refuses to reset the home while a brain is still listening on its socket.

Browser preview of the desktop renderer (UI work without Electron):

```bash
cd apps/desktop
npm run dev:vite             # mock-only: synthetic window.ade, fast shell
ADE_PROJECT_ROOT=/path/to/project npm run dev:vite:live   # mock + live runtime bridge (Linear, sync, lanes)
```

`dev:vite:live` starts the ADE dev runtime, a localhost HTTP bridge to the runtime endpoint, and Vite with a proxy so the browser can call real backend methods on top of the mock. Set `ADE_PROJECT_ROOT` to your primary project checkout (where `.ade/` and secrets live), especially when working from a lane worktree. Full details: [apps/desktop/README.md](../../apps/desktop/README.md).

The dev commands intentionally use a temp endpoint and a separate Electron profile so they do not collide with the installed ADE app:

```text
/tmp/ade-runtime-dev.sock
~/Library/Application Support/ade-desktop-dev
```

The auto-started dev runtime is **detached**, so nobody is reading its stdout or
stderr. Its output goes to an append-only dev log instead — a daemon that dies
during startup would otherwise leave no trace at all:

```text
~/.ade/runtime/dev-runtime.out.log
```

The log is created mode `0600`, truncated when it passes ~20 MB, and is strictly
best effort: if it cannot be opened the runtime still starts (with `stdio:
"ignore"`, as before). The startup line printed by `dev:desktop` names the path
whenever the log is in use.

The dev launcher sanitizes the detached runtime's environment before it starts.
It removes inherited caller and run identity (`ADE_CHAT_SESSION_ID`, parent
chat, spawn, browser token, and run ids), lane/project/workspace bindings
(`ADE_LANE_ID`, `ADE_PROJECT_ROOT`, `ADE_WORKSPACE_ROOT`), and the agent's
`ADE_DEFAULT_ROLE`. It also removes `CLAUDE_CONFIG_DIR` and `CODEX_HOME` only
when they point inside an ADE `provider-homes` directory, plus the
`CLAUDECODE` / `CLAUDE_CODE_*` markers that identify a parent Claude session.
The shell's `PATH`, `HOME`, performance-run id, and provider paths outside ADE
are retained. The detached runtime also drops `ADE_RUNTIME_PARENT_PID` and
`ADE_RUNTIME_IDLE_EXIT_MS` so it outlives the process that launched it.

A hand-started brain performs the same cleanup when it detects an agent shell:
it drops caller identity, lane/project/workspace bindings and inherited default
role itself, and removes ADE provider-home paths and Claude parent-session
markers before serving. The dev app's main process strips the provider-home
paths and Claude markers as well. No `env -u` prefix is needed. The startup
message reports the inherited values it removed. A plain `ade serve` still
defaults to role `agent`, which refuses desktop, phone and web clients; start a
hand-run brain for those clients as `ade --role cto serve`.

A separate `ADE_HOME` does not isolate a PROJECT. Machine state lives in the
home, but each project keeps its own database in `<project>/.ade/ade.db`. A
test brain on `~/.ade-alpha` that opens `~/Projects/ADE` — because it is in that
home's `projects.json`, or because an `ade` command ran from inside it — writes
the same `ade.db` as the installed brain. For a test brain that must not touch
the installed one, register only a throwaway project in its home, and check
with `lsof <project>/.ade/ade.db` which processes hold a project's database.

Override it when needed:

```bash
npm run dev:desktop -- --socket /tmp/my-ade-dev.sock
npm run dev:code -- --socket /tmp/my-ade-dev.sock
ADE_DEV_RUNTIME_SOCKET_PATH=/tmp/my-ade-dev.sock npm run dev:runtime
ADE_DESKTOP_BRIDGE_SOCKET_PATH=/tmp/my-bridge.sock npm run dev:desktop
```

> [!WARNING]
> Never point `--socket` at an ADE runtime you do not want restarted. In the default
> `--auto` mode the wrapper **shuts down and recreates** whatever runtime is
> already listening on that endpoint whenever its build hash does not match the
> checkout you are launching — so aiming at the production `~/.ade/sock/ade.sock`
> or another lane's live runtime will kill it (and any clients attached to it).
> Point at a fresh per-lane endpoint (below), or use
> `npm run dev:desktop:attach -- --socket <path>` to connect to an already-running
> runtime — attach mode refuses on a build-hash mismatch instead of restarting.

### Agent CLIs in a dev run

A dev app or a source-checkout brain runs ADE's own pinned agent CLIs, never the
ones on your PATH, just like a packaged build. Codex, Claude Code, OpenCode and
the Copilot runtime come from the checkout's `node_modules` (the lockfile is the
pin) and are never downloaded. The other pins (Droid, Grok, Qwen, Kimi, Devin,
Antigravity, Pi, the Copilot and Cursor terminal CLIs, Node, Muse) download into
the shared tools root the first time a chat, probe or terminal needs them. The
dev run does no startup download pass.

| Variable | Use |
| --- | --- |
| `ADE_TOOLS_ROOT=/tmp/<dir>` | Download into a throwaway tools root. Use one for any validation that downloads, so `~/.ade/tools` stays untouched. |
| `ADE_DISABLE_TOOLS_FETCH=1` | No downloads at all. Tools not already on disk read "ADE has not downloaded <Tool> for this machine yet". |
| `ADE_FORCE_TOOLS_FETCH=1` | A source-checkout `ade serve` behaves like a packaged one (startup pass included). |

Running your own CLI build is a dev/test hook only: `CLAUDE_CODE_EXECUTABLE_PATH`,
`CODEX_EXECUTABLE`, `DROID_EXECUTABLE`, `ADE_PI_PACKAGE_ROOT`,
`ADE_MUSE_EXECUTABLE` and the ACP `<PROVIDER>_EXECUTABLE` variables. See
[agent tools cache](../features/onboarding-and-settings/agent-tools-cache.md#dev-checkouts).

Use Node 24 (the version in `.nvmrc`) for repository development. CI and the
release builds use it too. `npm run build:static` in `apps/ade-cli` embeds the
Node it runs on in the headless runtime, so a release brain built by CI gets
Node 24's proxy and system-certificate support; the build warns when it embeds
a Node older than 24.14, which ignores `HTTPS_PROXY`, and refuses one older
than 22.19.0 because the runtime runs Pi's SDK worker on its own Node. Set
`ADE_STATIC_NODE_BINARY` to use another Node binary for that build. The `ade`
CLI still runs on Node 22.13 or newer: before 24.14 it ignores `HTTPS_PROXY`
(a brain says so once at start) and otherwise works as before.

### On Windows

Everything above applies; these are the differences that have actually cost
someone a day. Verified on Windows 11 with an installed Stable brain running.

**Endpoints are named pipes, not socket files.** Pass a pipe name to `--socket`:

```powershell
node scripts/dev-detached.mjs "$wt\perf\dev.log" npm run dev:desktop -- `
  --socket '\\.\pipe\ade-runtime-dev-<lane>' `
  --project-root "C:\Users\<you>\Documents\Programming\ADE" `
  --remote-debugging-port=9413
```

**Launch it from PowerShell, not Git Bash.** MSYS rewrites anything that looks
like a POSIX path, so `\\.\pipe\ade-runtime-dev-x` reaches Node as
`C:\pipe\ade-runtime-dev-x` and the runtime exits with "exited before opening
C:\pipe\…". `MSYS_NO_PATHCONV=1` also works; PowerShell is less surprising.

**Do not set `ADE_HOME`.** The rule above ("a never-signed-in home shows the
account gate") is not a macOS detail — it is the whole ballgame. Your account
lives in `~/.ade`, so a private home gives you a dev app sitting on a sign-in
page with no projects and nothing to measure. The launcher refuses an alternate
home outright and names the escape hatch (`ADE_DEV_ALLOW_ALT_HOME=1`); wanting
that escape hatch almost always means the plan is wrong. Share `~/.ade`, isolate
the **pipe**.

Done right, a dev app on Windows is the macOS experience: your real account,
your real projects, your real chats and transcripts, alongside the installed
brain.

#### The `ade` CLI resolves the project from the shell's cwd

This is the one that bites, and no amount of `ADE_HOME`, `--socket` or
`--no-sync` protects you from it. A command like `ade lanes create` run with the
shell sitting in `.ade/worktrees/<lane>` operates on the **primary project**,
because that is what the cwd resolves to — not on whatever project the dev app
opened. That has created a real lane, branch, pushed remote branch and worktree
in a live project, and taken the installed brain down with it.

- Prefer driving the dev **window** (CDP / App Control) over the CLI.
- If the CLI is unavoidable: `cd` into the target project first, set `ADE_HOME`
  and `ADE_RUNTIME_SOCKET_PATH`, and run one read-only command to confirm what
  you are pointed at **before** anything that writes. A dev brain reports
  version `1.0.0-beta.1`; the installed one reports the release version.

#### Verify, do not assume

A dev launch has landed on the production pipe before (a stale `ade.exe` earlier
on `PATH` spawned a brain on the Stable endpoint). After launching, check:

```powershell
# the installed brain still owns the stable pipe, and its heartbeat advances
Get-Content "$env:USERPROFILE\.ade\brains\<installed-pid>.json"
Get-Content "$env:USERPROFILE\.ade\runtime\heartbeat.json"   # seq must climb
[System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -match 'ade-runtime' }
```

Capture your own PIDs at launch and stop **only** those; never `Stop-Process` a
brain you did not start. A dev brain also leaves `~/.ade/brains/<pid>.json`
behind — remove your own record, nobody else's.

**One brain per project database.** `--no-sync` protects the sync lease, not the
database. A contended SQLite write costs the holder's hold time plus ~50-80 ms,
and because `node:sqlite` is synchronous it blocks the brain's whole event loop
for that long. Worse, when releasing the lock depends on the blocked process's
own event loop nothing can release it: it waits the full `busy_timeout`
(5,000 ms) and throws `database is locked`. Two brains on one project is fine
for reproducing behaviour and wrong for clean before/after numbers.

#### Measuring on Windows: what works, and what lies

Use the instrumentation that already ships before writing any:

- `ADE_TRACE_IPC=1` (or `verbose`) logs IPC invoke summaries; tracing is already
  on in an unpackaged app.
- `ADE_PERF_RUN_ID=<id>` appends every IPC invoke, main-loop delay, long task and
  renderer-memory sample to `~/.ade/perf-runs/<id>/events.jsonl`. Aggregate it per
  channel, then look at the **gaps between** events: that is what answers "slow
  because of work, or slow because nothing is happening?".
- To profile a brain you must not restart — including the installed one —
  `node -e "process._debugProcess(<pid>)"` opens its inspector on
  127.0.0.1:9229, and a short `Profiler.start`/`stop` over that socket is
  read-only. The port stays open until that process exits, so treat it as
  lingering state.

Four traps that produce confident, wrong answers:

- **`window.ade` cannot be monkey-patched.** `contextBridge` freezes it
  (`writable: false, configurable: false, isFrozen: true`), so wrapping the
  bridge to time IPC silently does nothing — it will report that it wrapped
  hundreds of methods and then record zero calls. Time IPC in the main process or
  the preload instead.
- **"The DOM stopped mutating" is not "it finished loading."** A settle detector
  conflates loading with later churn and will report tens of seconds for an
  operation that rendered in 50 ms. Measure something content-shaped, such as the
  transcript scroller's `scrollHeight` changing and then stabilising.
- **State carries between trials.** Clicking an already-selected chat is a no-op,
  and the app restores the last-selected chat on reload, so a "cold open"
  measurement is usually warm. Vary the target or relaunch between trials.
- **Process CPU cannot measure a renderer on a many-core box.** With other agents
  building, the same animation strategy sampled 11.0% then 5.0% of a core and the
  ordering inverted between runs; a CDP trace of the same thing repeats to within
  2%. See `scripts/perf-animation-lab/README.md`.

For calibration on this hardware: a healthy dev app switches between real chats
in **53-111 ms** to first content and settles in **0.3-1.4 s**, while the brain
sits ~98.6% idle and a 24-second window of UI work contains about **1 second** of
IPC. So if you are chasing a multi-second stall and the brain is idle and the
renderer has no long tasks, the cost is latency, not compute — look for polls,
debounces and idle-callback starvation rather than slow functions.

## Run a specific lane worktree

To preview a lane's build without disturbing your installed ADE app or its
runtime, run `dev:desktop` **from the lane checkout** on its own endpoints. Running
from the worktree makes Vite serve that lane's code, while the wrapper
auto-resolves project *data* to the primary checkout (as described above), so you
see the lane's UI backed by your real lanes, PRs, and chats:

```bash
cd /path/to/ADE/.ade/worktrees/<lane>
ADE_DESKTOP_BRIDGE_SOCKET_PATH=/tmp/ade-desktop-bridge-<lane>.sock \
  npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock
```

The per-lane `--socket` gives the lane build an isolated runtime (and sidesteps
the warning above — nothing else is listening there); the per-lane bridge endpoint
avoids colliding with the installed app's `~/.ade/sock/desktop-bridge.sock`. Set
`ADE_PROJECT_ROOT=/path/to/other-project` only if you want a different project's
data. A fresh worktree has no `node_modules`: ADE no longer links the primary
checkout's packages into new lanes. Run `npm run setup` inside the worktree
first, or give the project a default lane template that installs or copies
them (Settings › Lane templates › Set up with an agent).

When launching that same flow through ADE App Control from a running Alpha
ADE window, also clear the packaged-channel environment variables inherited from
the host app (and use an absolute lane cwd). Otherwise the dev Electron app can
reuse the Alpha profile and lose the single-instance lock instead of opening
the lane build:

```bash
ade --socket app-control launch --force \
  --cwd "/path/to/ADE/.ade/worktrees/<lane>" \
  --command "sh -lc 'ADE_PACKAGE_CHANNEL= ADE_DESKTOP_APP_NAME= ADE_DESKTOP_BRIDGE_SOCKET_PATH=/tmp/ade-desktop-bridge-<lane>.sock npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock'" \
  --text
```

App Control runs a launch with no `--cwd` in the caller's lane worktree, and
`ade app-control status` shows the `cwd` it used. Before, the default was the
primary checkout, so a lane's agent started the primary checkout's app.

### Each lane's dev app has its own user-data folder

Electron keeps its single-instance lock in the app's user-data folder. When
every dev app shared `ade-desktop-dev`, a second lane's app lost the lock and
never opened a window. `dev:desktop` started from a lane worktree now uses
`ade-desktop-dev-<lane>` and prints it as `user data :`. The primary checkout
keeps `ade-desktop-dev`. An explicit `ADE_DESKTOP_USER_DATA_PATH` still wins.

- A new lane folder copies `ade-state.json` from `ade-desktop-dev` once. Other
  machine-local state (window layout, the welcome screen) starts fresh.
- On any `ADE_HOME` other than `~/.ade`, the app gets a folder for that home
  (`…-home-<name>-<hash>`) that copies nothing. The app registers every project
  its folder remembers into the home it runs on, so a reused lane folder put
  the owner's real project into a scratch home.
- If two dev apps still share a folder, the second one prints which app holds
  it and exits.
- Each lane folder has a `.ade-dev-lane.json` marker with its worktree.
  `dev:desktop` removes marked folders whose worktree is gone, or that went
  unused for 30 days, each time it starts.
- To see every folder with its size, run `npm run dev:clean-data`. Add `--yes`
  to remove the stale ones. Folders made by hand before this change have no
  marker. Nothing removes them by itself; add `--include-unmarked` to remove
  the ones no app is using.

A brain that `dev:desktop` starts exits when the launcher exits, even when the
terminal closes without Ctrl+C. A brain from `npm run dev:runtime` is not tied
to anything and still stops after 20 idle minutes.

### Test Mac Desktop in the dev app instead of an Alpha build

Mac Desktop needs the native helper and two macOS grants, and both are usable
from the dev app on this Mac, so a lane's Mac Desktop changes do not need a
packaged Alpha to be tried:

```bash
cd /path/to/ADE/.ade/worktrees/<lane>
npm --prefix apps/desktop run build:desktop-driver   # resources/native/ade-desktop-driver
ADE_DESKTOP_BRIDGE_SOCKET_PATH=/tmp/ade-desktop-bridge-<lane>.sock \
  npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock
```

The dev app runs the Electron binary from `node_modules`, which carries
Electron's own stable code signature, so macOS keeps its Screen Recording and
Accessibility grants across rebuilds; grant them once for "Electron" in System
Settings. An unpackaged app always starts its brain with `--no-sync`
(`main.ts`, `disableSync`), so a dev brain can never take the machine-wide sync
host lease from the installed ADE. On 2026-09-21 one did, before that guard
existed, and the agents running under the installed brain died with the lease.
Set `ADE_DEV_RUNTIME_SYNC=1` only when a dev brain must host sync on purpose,
and never on a machine whose installed ADE is doing real work.

`--no-sync` guards the sync lease; it does not isolate project data. A dev
brain still opens the same project `.ade/ade.db` as the installed app. Runtime
ownership keeps a live chat with its owner across ADE homes, and a dev brain on
its own socket leaves the installed brain's other chats and scheduled work
alone. The shared database still contains the same project state, so use a
throwaway project when you need full data isolation. Starting a brain on a home
that already has one prints who else is there and logs `brain.home_shared`.
List the brains, with their homes, before assuming:

```bash
pgrep -alf "cli.cjs serve|/bin/ade serve"
ps eww -p <pid> | tr ' ' '\n' | grep ADE_HOME   # no output = the shared ~/.ade
```

A dev brain is spawned detached so it survives the Electron restarts a dev
loop is made of, which also means it survives the app going away for good. One
ran orphaned on the shared home for five hours. Launcher-spawned brains now
exit after 20 idle minutes (`ADE_RUNTIME_IDLE_EXIT_MS`, set in
`scripts/dev-shared.mjs`); set `ADE_DEV_RUNTIME_IDLE_EXIT_MS` (milliseconds,
`0` disables it) on the launch command to raise or clear it, for example when
testing in the dev app for longer than the budget. For work that only needs to read or drive a lane, give the brain
its own home — `ADE_HOME=$HOME/.ade-<name>` on its own socket — instead of
sharing `~/.ade`. A separate home keeps machine-level state separate, while a
throwaway project is still required to isolate project data. Because the dev
brain does not host sync it never publishes to the account, which is why the
Connections card is not testable this way; everything on the Mac Desktop pane
is. Use `--project-root` to point the dev app at a throwaway project so the
lane's displays never touch real work. The floating corner preview only shows
for chat sessions, so test it from a chat, not from a shell session.

To test auto-runtime creation, use the default dev commands after stopping the dev runtime:

```bash
npm run dev:stop
npm run dev:desktop          # tests the desktop wrapper creating the dev runtime
npm run dev:stop
npm run dev:code             # tests TUI wrapper creating the dev runtime
```

## Rebuild ADE Alpha locally

Use this command when you need a local packaged macOS Alpha build without
waiting for the GitHub release workflow.

```bash
npm run package:alpha        # current checkout -> ADE Alpha.app, ade-alpha, ~/.ade-alpha
```

Beta is not a local build. It is an update track of the normal ADE install.
Switch to it in Settings > About > Updates. The Beta builds come from
`.github/workflows/beta.yml`. To build one branch once, run
`gh workflow run beta.yml -f preview_ref=<branch>`. See
[Update tracks](../features/onboarding-and-settings/desktop-auto-update.md#update-tracks-stable-and-beta).

The build prints one line about code signing. "Signing identity: ADE Local"
means macOS keeps the app's Screen Recording and Accessibility grants across
rebuilds. The ad-hoc warning means it does not; set up the certificate once as
described in [Alpha builds and macOS permission grants](#alpha-builds-and-macos-permission-grants).

`package:alpha` builds exactly the checkout you are in. It does not create a
packaging worktree.

Local channel outputs:

```text
apps/desktop/release-alpha/mac-arm64/ADE Alpha.app
apps/desktop/release-alpha/ADE-Alpha-local.zip
```

Every Alpha build carries a per-build version of the form
`<base>-alpha.<yyyymmddHHMM>`, where `<base>` is the newest `v*` tag
reachable from HEAD (or the `apps/desktop/package.json` version when no tag
exists) and the timestamp is UTC — for example `1.2.75-alpha.202609211035`.
The stamp is written into the packaged app's `version` (electron-builder
`extraMetadata.version`, so `app.getVersion()` reports it), into
`ADE_CLI_VERSION` for the bundled CLI build, and through `ADE_DESKTOP_VERSION`
for the Windows packaging wrapper. This is what stops a fresh Alpha app
from reusing a brain left by an earlier build: the runtime compatibility gate
treats equal versions as compatible, so a build has to identify itself with a
version that changes every time. The desktop never writes the stamp back into
`package.json`.

Install the build you want to test by replacing the matching app in
`/Applications`:

```bash
rm -rf "/Applications/ADE Alpha.app"
ditto "apps/desktop/release-alpha/mac-arm64/ADE Alpha.app" "/Applications/ADE Alpha.app"
xattr -dr com.apple.quarantine "/Applications/ADE Alpha.app" 2>/dev/null || true
```

If the Dock already has an
ADE Alpha icon, remove and re-pin it after installing from `/Applications`;
Dock icons keep the exact bundle path they were pinned from, so an old icon can
launch a stale `apps/desktop/release-*` build even after `/Applications` was
updated.

Replacing the app bundle does not replace a brain process that is already
running for that channel. Before restarting the channel brain, close or finish
any active ADE Desktop, ADE Code, agent, or mobile sessions that depend on it.
Then restart and verify the channel brain through the CLI:

```bash
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" ade brain status --text
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" ade brain restart --text
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" ade doctor --text
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" ade sync status --text
```

Do not kill ADE brain processes directly during normal testing; the channel
brain owns the mobile sync websocket and may have desktop, terminal, or phone
clients attached. If you intentionally leave an old incompatible brain running,
the packaged desktop may preserve it and launch a private no-sync fallback
runtime for the desktop window, which means the Mobile drawer will not be using
that fallback's sync service.

Launching a packaged channel build should install or repair that channel's
always-on brain service. Official auto-updates also refresh this service on the
first launch after an update, and the installed service is expected to report the
same runtime build hash as the packaged desktop CLI:

```bash
launchctl print gui/$(id -u)/com.ade.runtime.alpha
ls -l ~/Library/LaunchAgents/com.ade.runtime.alpha.plist ~/.ade-alpha/sock/ade.sock
```

Set or rotate the channel's mobile pairing PIN from **Connections > Mobile**,
or from the CLI against that channel home:

```bash
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" ade brain pin generate
ADE_PACKAGE_CHANNEL=alpha ADE_HOME="$HOME/.ade-alpha" ade brain pin set 123456
```

This build does not
replace the production `ADE.app`, production `ade`, or `~/.ade` runtime/state.
Alpha also uses a separate Electron profile directory
(`ade-desktop-alpha`) so browser storage and window state
do not collide with dev or stable. Local channel packages include this Mac's
runtime binary. Release builds still require the full cross-platform runtime
artifact set used by remote runtime bootstrap.

### Alpha builds and macOS permission grants

`npm run package:alpha` signs the app locally. There is
no Developer ID certificate behind a channel build, so the default is an ad-hoc
signature, and the app's designated requirement is its cdhash. The cdhash changes
on every build, so macOS treats each rebuild as a new app and drops its Screen
Recording and Accessibility grants. Re-adding ADE Alpha in System
Settings works until the next build.

A self-signed code-signing certificate makes the designated requirement the
bundle identifier plus the certificate leaf, which does not change between
rebuilds. Grants then survive.

Create the certificate once:

1. Open Keychain Access › Certificate Assistant › Create a Certificate.
2. Name it exactly `ADE Local`, set Certificate Type to `Code Signing`, and
   create it.
3. Run a channel build and press `Always Allow` on the keychain prompt, so later
   builds can use the private key without prompting.

Then remove ADE Alpha from Screen Recording and from Accessibility,
add it back once, and the grants are stored against the new requirement.

The dev launcher (`npm run dev:desktop`) signs the lane's Electron in
`node_modules` the same way (`apps/desktop/scripts/sign-dev-electron.cjs`): the
`ADE Local` certificate, else the first `Apple Development:` identity, never
Developer ID. Ad-hoc Electron is trusted by its cdhash, so every Electron
upgrade made macOS ask for the login Keychain password again, and the dev app
waited on that prompt at start. Signed, "Always Allow" holds across upgrades.
`ADE_DEV_SIGN=0` skips it; `ADE_DEV_SIGN_IDENTITY` picks the identity.

The packager uses the certificate automatically when an identity named exactly
`ADE Local` is present. To use another certificate, or a specific SHA-1 hash,
pass `--sign "<identity>"` or set `ADE_CHANNEL_SIGN_IDENTITY`. Developer ID
identities are never selected automatically. Without any of these, the build
stays ad-hoc and prints a warning.

Validate with `npm --prefix apps/desktop run typecheck` and `npm run test:desktop:sharded` for the full desktop suite. The desktop test suite is large, so run the smallest relevant subset first.
