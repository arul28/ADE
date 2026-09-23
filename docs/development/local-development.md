# Local development

Everything you need to run, test, and package ADE from a checkout. The README
keeps the short version; this is the full reference.

## Glossary

| Term | Meaning |
| --- | --- |
| Brain | The always-on, machine-owned ADE process for one channel. It carries the sync websocket, project catalog, local RPC endpoint, and executor authority. |
| Runtime | ADE execution machinery: processes/services that open DBs and run agents, PTYs, git, and orchestration. A runtime process can host the brain role, but "brain" is the authority/lifecycle term. |
| Manual runtime | A foreground runtime process started explicitly with `ade runtime run --socket <path>`. Sync is always off; use it for dev/test work instead of the automated stable/beta/alpha brain service. |
| Machine | A physical computer with a per-channel ADE home and stable sync device identity. |
| Channel | A release lane such as stable, beta, alpha, or dev. Each channel has its own ADE home. |
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

Daily desktop dev:

```bash
npm run dev
```

That aliases to `npm run dev:desktop`: it rebuilds `apps/ade-cli`, refreshes the shared dev runtime at `/tmp/ade-runtime-dev.sock` when needed, launches the Electron desktop app, and points desktop at that runtime. This is the normal desktop-dev flow.

**This is the only supported way to run a dev app on a machine that also runs the installed ADE.** The dev brain shares `~/.ade` (your account, projects, and sync identity are served by the installed brain) and is started with `--no-sync`, so it can never take the machine-wide sync host lease. It stamps and respects chat runtime ownership, so it never adopts a chat the installed brain is driving. An unpackaged app never installs or repairs the launchd brain service. The launcher prints a dev isolation report (state root, socket, sync, project, installed brain untouched) before the window opens; read it. Do not start `ade serve` by hand, do not set a fresh `ADE_HOME` (a never-signed-in home shows the account gate), and do not copy `~/.ade` secrets into another home. `ADE_DEV_RUNTIME_SYNC=1` opts a dev brain into sync on purpose and is almost never what you want.

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

Two rules go with it:

- **Pick your own socket.** The default is `/tmp/ade-runtime-dev.sock` and it is
  shared. Two dev brains on one socket restart each other. Use one path per
  lane and keep using the same one, so `--attach` finds it.
- **Read the isolation report before anything else.** If it says `sync : ON`,
  stop and fix that: a dev brain holding the machine-wide sync host lease drops
  the installed brain's tunnel and kills the agents running under it.

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
npm run dev:code:web          # `ade code` in the browser (PTY + inspector WebSocket)
npm run dev:code:attach      # terminal TUI only; fail if dev runtime is not already running
npm run dev:runtime          # runtime only in the foreground
npm run dev:all              # start shared dev runtime, then run desktop/code attach commands in separate terminals
npm run dev:stop             # stop the dev runtime
npm stop dev                 # same as dev:stop
```

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

The detached runtime also gets a **sanitized environment**. It inherits the rest
of the shell env (`PATH`, `HOME`, `ADE_PERF_RUN_ID`, …), but variables that
identify the *launching* agent shell rather than the shared daemon are stripped
by name: `ADE_DEFAULT_ROLE`, `ADE_CHAT_SESSION_ID`,
`ADE_PARENT_CHAT_SESSION_ID`, `ADE_SPAWN_KIND`, `ADE_BROWSER_ACTOR_TOKEN`, the
run identity (`ADE_RUN_ID`, `ADE_STEP_ID`, `ADE_ATTEMPT_ID`,
`ADE_OWNER_ID`), and the location binding (`ADE_LANE_ID`, `ADE_PROJECT_ROOT`,
`ADE_WORKSPACE_ROOT`). This matters when an ADE chat is what launched the
script: `ptyService` stamps `ADE_DEFAULT_ROLE=agent` on every tracked agent CLI
terminal, and any caller context carrying a `chatSessionId` downgrades a `cto`
default to an agent — either one clamps the shared dev brain to an agent role
and breaks project-wide desktop actions such as importing external sessions. The
daemon's own role is computed from the sanitized env, never read back out of the
shell that was just stripped, and its project/workspace comes from its own
arguments. `ADE_RUNTIME_PARENT_PID` / `ADE_RUNTIME_IDLE_EXIT_MS` are removed for
the separate reason that a shared daemon must outlive the process that launched
it.

A brain started any other way — `ade serve` or `~/.ade-<channel>/bin/ade serve`
typed into an agent's shell — now drops the caller identity itself at startup
(`brainInheritedIdentity.ts`: the chat, spawn, browser-token and run keys above)
and prints `ADE: This brain was started from an agent's shell. It ignores that
agent's identity …`. Before that, such a brain clamped EVERY client to the
launching agent, desktop included, and the Mac Desktop panel answered "Action
'mac_desktop.startStream' requires elevated role." (2026-09-22). The role
ceiling is not changed for you: a plain `ade serve` still defaults to `agent`,
and it now says so — `ADE: This brain serves at role agent, so ADE desktop,
phone and web clients (role cto) will be refused.` Start a hand-run brain that a
desktop will connect to as `ade --role cto serve`.

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
data. A fresh worktree has no `node_modules` — symlink the root and `apps/desktop`
`node_modules` from the primary checkout, or run `npm run setup` inside the
worktree first.

When launching that same flow through ADE App Control from a running Alpha/Beta
ADE window, also clear the packaged-channel environment variables inherited from
the host app (and use an absolute lane cwd). Otherwise the dev Electron app can
reuse the Alpha/Beta profile and lose the single-instance lock instead of opening
the lane build:

```bash
ade --socket app-control launch --force \
  --cwd "/path/to/ADE/.ade/worktrees/<lane>" \
  --command "sh -lc 'ADE_PACKAGE_CHANNEL= ADE_DESKTOP_APP_NAME= ADE_DESKTOP_BRIDGE_SOCKET_PATH=/tmp/ade-desktop-bridge-<lane>.sock npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock'" \
  --text
```

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

`--no-sync` guards the sync lease and **nothing else**. A dev brain started
this way still attaches to the same `~/.ade` database as the installed app,
and two brains on one database can only have one owner for a given chat, so
the other's agents can stop with no explanation. Starting a brain on a home
that already has one now prints who else is there and logs
`brain.home_shared`; if you see that, decide which brain you meant to have.
List them, with their homes, before assuming:

```bash
pgrep -alf "cli.cjs serve|/bin/ade serve"
ps eww -p <pid> | tr ' ' '\n' | grep ADE_HOME   # no output = the shared ~/.ade
```

A dev brain is spawned detached so it survives the Electron restarts a dev
loop is made of, which also means it survives the app going away for good. One
ran orphaned on the shared home for five hours. Launcher-spawned brains now
exit after 20 idle minutes (`ADE_RUNTIME_IDLE_EXIT_MS`, set in
`scripts/dev-shared.mjs`); raise or clear it when debugging a deliberately
quiet brain. For work that only needs to read or drive a lane, give the brain
its own home — `ADE_HOME=$HOME/.ade-<name>` on its own socket — instead of
sharing `~/.ade`. Because the dev
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

## Rebuild ADE Alpha or Beta locally

Use these commands when you need a local packaged macOS channel build without
waiting for the GitHub release workflow.

```bash
npm run package:alpha        # current checkout -> ADE Alpha.app, ade-alpha, ~/.ade-alpha
npm run package:beta         # origin/main -> ADE Beta.app, ade-beta, ~/.ade-beta
```

The build prints one line about code signing. "Signing identity: ADE Local"
means macOS keeps the app's Screen Recording and Accessibility grants across
rebuilds. The ad-hoc warning means it does not; set up the certificate once as
described in [Alpha/Beta builds and macOS permission grants](#alphabeta-builds-and-macos-permission-grants).

`package:alpha` builds exactly the checkout you are in. `package:beta` is
release-like: it fetches `origin/main`, fast-forwards the local `main` checkout
when possible, and builds that checkout as `ADE Beta`. It does not create a
packaging worktree.

To smoke-test the Beta channel from a PR branch before it lands on `main`, pass
the branch checkout explicitly:

```bash
node scripts/package-channel.mjs beta --repo "$PWD" --skip-install
```

Local channel outputs:

```text
apps/desktop/release-alpha/mac-arm64/ADE Alpha.app
apps/desktop/release-alpha/ADE-Alpha-local.zip
apps/desktop/release-beta/mac-arm64/ADE Beta.app
apps/desktop/release-beta/ADE-Beta-local.zip
```

Every channel build carries a per-build version of the form
`<base>-<channel>.<yyyymmddHHMM>`, where `<base>` is the newest `v*` tag
reachable from HEAD (or the `apps/desktop/package.json` version when no tag
exists) and the timestamp is UTC — for example `1.2.75-alpha.202609211035`.
The stamp is written into the packaged app's `version` (electron-builder
`extraMetadata.version`, so `app.getVersion()` reports it), into
`ADE_CLI_VERSION` for the bundled CLI build, and through `ADE_DESKTOP_VERSION`
for the Windows packaging wrapper. This is what stops a fresh Alpha/Beta app
from reusing a brain left by an earlier build: the runtime compatibility gate
treats equal versions as compatible, so a build has to identify itself with a
version that changes every time. The desktop never writes the stamp back into
`package.json`.

Install the build you want to test by replacing the matching app in
`/Applications`:

```bash
rm -rf "/Applications/ADE Beta.app"
ditto "apps/desktop/release-beta/mac-arm64/ADE Beta.app" "/Applications/ADE Beta.app"
xattr -dr com.apple.quarantine "/Applications/ADE Beta.app" 2>/dev/null || true
```

Use `ADE Alpha.app` and `release-alpha` for Alpha. If the Dock already has an
ADE Alpha/Beta icon, remove and re-pin it after installing from `/Applications`;
Dock icons keep the exact bundle path they were pinned from, so an old icon can
launch a stale `apps/desktop/release-*` build even after `/Applications` was
updated.

Replacing the app bundle does not replace a brain process that is already
running for that channel. Before restarting the channel brain, close or finish
any active ADE Desktop, ADE Code, agent, or mobile sessions that depend on it.
Then restart and verify the channel brain through the CLI:

```bash
ADE_PACKAGE_CHANNEL=beta ADE_HOME="$HOME/.ade-beta" ade brain status --text
ADE_PACKAGE_CHANNEL=beta ADE_HOME="$HOME/.ade-beta" ade brain restart --text
ADE_PACKAGE_CHANNEL=beta ADE_HOME="$HOME/.ade-beta" ade doctor --text
ADE_PACKAGE_CHANNEL=beta ADE_HOME="$HOME/.ade-beta" ade sync status --text
```

For Alpha, use `ADE_PACKAGE_CHANNEL=alpha` and `ADE_HOME="$HOME/.ade-alpha"`.
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
launchctl print gui/$(id -u)/com.ade.runtime.beta
ls -l ~/Library/LaunchAgents/com.ade.runtime.beta.plist ~/.ade-beta/sock/ade.sock
```

Set or rotate the channel's mobile pairing PIN from **Connections > Mobile**,
or from the CLI against that channel home:

```bash
ADE_PACKAGE_CHANNEL=beta ADE_HOME="$HOME/.ade-beta" ade brain pin generate
ADE_PACKAGE_CHANNEL=beta ADE_HOME="$HOME/.ade-beta" ade brain pin set 123456
```

For Alpha, use `com.ade.runtime.alpha` and `~/.ade-alpha`. These builds do not
replace the production `ADE.app`, production `ade`, or `~/.ade` runtime/state.
Alpha and Beta also use separate Electron profile directories
(`ade-desktop-alpha` / `ade-desktop-beta`) so browser storage and window state
do not collide with dev or stable. Local channel packages include this Mac's
runtime binary. Release builds still require the full cross-platform runtime
artifact set used by remote runtime bootstrap.

### Alpha/Beta builds and macOS permission grants

`npm run package:alpha` and `npm run package:beta` sign the app locally. There is
no Developer ID certificate behind a channel build, so the default is an ad-hoc
signature, and the app's designated requirement is its cdhash. The cdhash changes
on every build, so macOS treats each rebuild as a new app and drops its Screen
Recording and Accessibility grants. Re-adding ADE Alpha or ADE Beta in System
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

Then remove ADE Alpha or ADE Beta from Screen Recording and from Accessibility,
add it back once, and the grants are stored against the new requirement.

The packager uses the certificate automatically when an identity named exactly
`ADE Local` is present. To use another certificate, or a specific SHA-1 hash,
pass `--sign "<identity>"` or set `ADE_CHANNEL_SIGN_IDENTITY`. Developer ID
identities are never selected automatically. Without any of these, the build
stays ad-hoc and prints a warning.

Validate with `npm --prefix apps/desktop run typecheck` and `npm run test:desktop:sharded` for the full desktop suite. The desktop test suite is large, so run the smallest relevant subset first.
