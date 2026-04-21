# ADE CLI

`apps/ade-cli` owns the `ade` command-line entry point for agents and local automation.

The CLI is the primary agent interface. It prefers the live ADE desktop socket at `.ade/ade.sock` so commands operate against the same lanes, chats, PR state, process runtime, and proof artifacts as the UI. If the desktop app is not running, it falls back to a short-lived headless runtime for actions that can safely run without Electron.

## Scripts

```bash
npm run cli:dev -- help
npm run cli:dev -- doctor --project-root /absolute/path/to/repo
npm run dev -- --project-root /absolute/path/to/repo
npm run build
npm run typecheck
npm run test
```

## Install and PATH

For local development, build the package and link its `ade` binary:

```bash
cd apps/ade-cli
npm run build
npm link
ade doctor --project-root /absolute/path/to/repo
```

The package is also packable as a normal Node CLI. It requires Node.js 22 or newer because ADE uses `node:sqlite` in the headless runtime.

```bash
cd apps/ade-cli
npm pack
npm install -g ./ade-cli-*.tgz
```

The desktop macOS build also bundles the CLI at:

```bash
/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade
```

To make the desktop-bundled command available as `ade`, add a symlink from a directory on `PATH`:

```bash
/Applications/ADE.app/Contents/Resources/ade-cli/install-path.sh
```

That wrapper runs the CLI with the packaged ADE Electron runtime, so users do not need a separate Node install for the desktop-bundled path.

## CLI surface

```bash
ade auth status
ade doctor
ade lanes list --text
ade lanes create "fix-checkout-flow" --parent main
ade git commit --lane lane-id
ade git push --lane lane-id
ade prs create --lane lane-id --base main --title "Fix checkout flow"
ade prs path-to-merge --pr pr-id --model gpt-5.4 --max-rounds 3 --no-auto-merge
ade run defs --text
ade run start web --lane lane-id
ade shell start --lane lane-id -- npm test
ade chat create --lane lane-id --model gpt-5.4
ade tests run --lane lane-id --suite unit --wait
ade proof list --arg ownerKind=chat --arg ownerId=session-id
ade actions list
ade actions run git.stageFile --arg laneId=lane-id --arg path=src/index.ts
```

Use typed commands first. They validate common arguments and provide stable JSON fields or readable text summaries. Use `ade actions list --text` to discover the full service-backed action catalog, and use `ade actions run <domain.action>` only when there is no typed command for the workflow yet.

Output modes are explicit:

```bash
ade lanes list --text
ade git status --lane lane-id --json
ade actions run git.stageFile --arg laneId=lane-id --arg path=src/index.ts --json
```

Commands that need UI-owned state, long-running Work chat state, live Run tab process state, or desktop proof state should use the live ADE socket:

```bash
ade doctor --project-root /absolute/path/to/repo --socket --json
ade lanes list --project-root /absolute/path/to/repo --socket --text
```

Without `--socket`, the CLI auto-connects to the desktop socket when it is available and falls back to headless mode when it is not.

## Auth and readiness

ADE CLI auth is local project access, not a separate cloud login. `ade auth status` verifies that the current terminal can initialize an ADE runtime for the project. Provider credentials, GitHub tokens, and computer-use policy are read from ADE project settings and the existing secure stores.

`ade doctor` reports local-only readiness metadata by default:

- CLI version, Node/runtime version, project root, workspace root, `.ade` initialization, and config file presence.
- Desktop socket path, whether the socket exists, and whether this invocation is actually using `desktop-socket` or `headless` mode.
- RPC tool count, ADE service action count, and action counts by domain.
- Git repository readiness and GitHub readiness signals from local remotes, `gh` availability, and token environment presence.
- Linear readiness from local encrypted token presence or headless environment variables.
- Provider/model readiness from local ADE config, API-key provider references, and provider CLI availability.
- Computer-use readiness from local platform capabilities.
- Packaged/PATH status for the `ade` binary and concrete next actions.

Default doctor/auth checks do not call provider, GitHub, or Linear networks. They report presence and local readiness only, without printing secret values.

Agents should start unfamiliar ADE sessions with:

```bash
ade doctor --json
ade actions list --text
```

Then prefer typed commands such as `ade lanes list --text`, `ade files read <path> --text`, `ade prs checks <pr> --text`, or `ade tests runs --json`. Use `ade actions run ...` as the broad escape hatch for internal ADE actions that do not yet have a typed command.
