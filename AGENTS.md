# ADE Project Instructions

## About this project

- ADE is a local-first desktop application for orchestrating coding agents, lanes, PR workflows, and proof/artifact capture.
- The main product lives in `apps/desktop` and is built with Electron, React, and TypeScript.
- The ADE CLI lives in `apps/ade-cli` and shares core services with the desktop app.
- State is primarily stored under `.ade/` inside the active project, with runtime metadata in SQLite and machine-local files under `.ade/secrets`, `.ade/cache`, and `.ade/artifacts`.

## Dev loop

Day-to-day work follows a five-stage loop, each stage an agent-folder skill under
`.agents/skills/` (invocable as `/<name>` across runtimes — ADE discovers them via
`apps/desktop/src/shared/agentSkillRoots.ts`, and `.claude/skills` symlinks to
`.agents/skills` for native Claude):

`/context` → work → `/quality` → `/test` → `/ship`

- **/context** — session primer: detects the lane's area and loads only the matching docs + perf skill (never a broad dump).
- **/quality** — opens the PR first so CI and the review bots run during the review; then a dual-track review (correctness/security + maintainability/code-judo) that fixes every verified finding at every severity; then harvests the PR's CI failures and bot comments and fixes those too. It gates only a product decision the agent cannot make or a behavior change the branch was not authorized to make.
- **/test** — test steward: prune/consolidate/add + docs/mobile/CLI/TUI parity + CI-mirrored shards. Adds a test for a fixed bug only when no existing test would catch it, and never a tautological or change-detector test. Harvests the PR again before it finishes.
- **/ship** — autonomous PR→merge loop (poll → fix → rebase → merge). It adopts the early PR with one round already fixed, so it mostly closes the PR out. After any ship-loop mutation it reruns commit-bound `/quality` revalidation on the delta only. Wraps `docs/playbooks/ship-lane.md`.

The PR opens at the start of `/quality`, not at `/ship`. CI and the bots then work in parallel with quality and test, and each phase harvests their results (playbook: **Early PR and harvests**). Do not push while a review bot is in flight on the remote head — a push restarts Greptile.

### Running the dev app

One command, from the lane worktree, and **detached**:

```bash
node scripts/dev-detached.mjs /tmp/ade-dev-<lane>.log \
  npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock
until grep -q 'dev isolation report' /tmp/ade-dev-<lane>.log; do sleep 2; done
cat /tmp/ade-dev-<lane>.log
```

Detach it, give the lane its own socket, read the isolation report (stop if
sync is ON), and never hand-start `ade serve`. The full rules, and why each
one exists: `docs/development/local-development.md` ("If you are an agent,
start it detached").

**"Run the dev loop"** — when the user says this (or "dev loop") after work is implemented, it names one task, not a suggestion: invoke `/quality`, then `/test`, then `/ship`, in that order. Actually invoke each skill — approximating one (running tests is not `/test`; green CI is not `/quality`) does not count. Print each skill's summary, then continue to the next without stopping; stop early only for a genuine blocker (a failing gate or a decision only the user can make) and name it.

Utilities (run when relevant, not part of the core loop): **/audit** (targeted bug hunt), **/finalize** (optional pre-push local-CI gate), **/optimize** (perf profiling), **/release** (cut a release).

## Playbooks

- `docs/playbooks/ship-lane.md` — autonomous PR-to-merge driver (poll → fix → rebase → merge), plus the **Early PR and harvests** procedure that `/quality` and `/test` run. Baseline `/quality` and `/test` run before ship; delta-only commit-bound quality revalidation runs inside it. Any agent CLI can follow it directly; Claude Code invokes it via the `/ship` skill.
- `docs/playbooks/windows-signed-release.md` — maintainer handoff for taking the gated Windows x64 build through signing, clean-host and installed-update proof, draft verification, publication, and website enablement without changing the macOS or iOS release paths.

## Hit every ADE surface

The most common defect class in this repo is a change that works on the path you tested and is missing everywhere else. Before you call a change done (and again in `/quality`), walk this list and state which entries applied:

- **Entry points.** A behavior reachable from the desktop UI is usually also reachable from the `ade` CLI, the `ade code` TUI, deeplinks, the command palette, and keybindings. Fixing one entry point is not fixing the feature.
- **Clients.** Desktop (Electron), hosted web, iOS, and the TUI attach to the same brain. Shared logic belongs in shared services and types, not re-implemented per client.
- **Providers.** Claude, Codex, Cursor, OpenCode, and Droid each have an adapter with different capabilities. A provider-shaped feature needs a decision per adapter, even when the decision is "not supported here" — record it in the capability gate, not by silence.
- **Contracts.** Anything crossing a boundary is typed once: main-process handler, `src/shared` types, preload exposure, renderer caller, daemon action domain, tests/mocks. Change the contract and all of them move together.
- **Reverse states.** If you add a way in, add the way out and the way to see it. Snooze needs unsnooze; settle needs unsettle; a link needs unlink. A one-way door is a bug.
- **Connection modes.** Local runtime, remote runtime, and relay behave differently. Multi-device and offline cases are real; the phone can be newer than the host.
- **Windows.** Parity is part of "done" for all new code, never a follow-up.
- **Docs.** User-visible behavior changes update the matching `docs/features/` doc in present tense.

## Working norms

- Preserve existing desktop app patterns before introducing new abstractions.
- Prefer fixing the underlying service or shared type rather than layering renderer-only workarounds on top.
- Keep IPC contracts, preload types, shared types, and renderer usage in sync whenever an interface changes.
- For ADE CLI changes, verify both headless mode and the desktop socket-backed ADE RPC path.
- For computer-use changes, treat policy enforcement and artifact ownership as hard requirements, not prompt guidance.
- `ade search "<query>" --text` searches everything in ADE (chats, terminal scrollback, PRs, commits, branches, lanes, files, Linear) instead of grepping `.ade/` internals; see the ade-search skill.

## UI primitives

The desktop renderer has exactly one of each notice and overlay. Read `docs/design/notices.md` before adding any banner, toast, dialog, or popover-like surface. Never invent a new style.

- **Banners:** `Banner` / `useAppBanner` from `components/ui/notice`. App-wide states are docked, short prompts float, and a banner about one pane is `layout="inline"`. Never write a new `*Banner` component with its own styling.
- **Toasts:** `showToast()` from `components/app/toast/toastStore`. No toast libraries and no hand-positioned corner cards.
- **Confirm / prompt / modals:** `confirmDialog()` / `promptDialog()` / `<Dialog>` from `components/ui/dialog`. Never call `window.confirm`, `prompt`, or `alert`.
- **Top-bar dropdowns:** `HeaderSheet`.
- **Stacking:** `Z_LAYERS` from `components/ui/zLayers.ts`. No raw `zIndex` ≥ 50, `z-50`, or `z-[N]`, and no `position: fixed` outside the hosts.
- **Lint:** the `ade-ui/*` rules are warnings, and `npm --prefix apps/desktop run lint:ci` fails CI if any file's count grows. After fixing violations, run `npm run lint:baseline` in `apps/desktop` and commit the smaller baseline.

## Ways to hurt yourself

These are the operational hazards of developing ADE from inside ADE. Each one has caused real damage.

1. **Killing by pattern.** Do not `pkill -f`, `pgrep | kill`, or kill a PID you found by matching a name or path. Your own agent process carries this worktree's path in its argv, `pgrep -f xcodebuild` also matches xcodebuildmcp and its wrapper shell, and this machine runs the real ADE brain plus other dev runtimes. Kill only a PID you captured at spawn time, after confirming its cwd is your worktree.
2. **Writing to live state.** The project root's `.ade/` (database, secrets, artifacts) and the installed brain are the developer's real, in-use ADE instance. Read from them for realistic data; never point a dev server at them, never open them read-write, never "clean them up". Isolated dev state belongs under your worktree or a temp directory.
3. **Editing outside the lane worktree.** Every edit targets `.ade/worktrees/<lane>/...`, never the project-root checkout. Search tools may print root-checkout paths — translate them before editing, or the change lands on the wrong branch.
4. **Restarting shared runtimes casually.** `ensureRuntime`-style commands can restart a brain another session is using. Check what is running before starting or restarting sockets, brains, or dev servers: `pgrep -alf "cli.cjs serve|/bin/ade serve"`, then `ps eww -p <pid> | tr ' ' '\n' | grep ADE_HOME` for each — no `ADE_HOME` means it is on the shared `~/.ade`. `--no-sync` guards only the sync lease, not the database: two brains on one home share one database and a chat can be owned by just one of them, so the other's agents can stop unexplained. Starting a brain on an occupied home prints who else is there and logs `brain.home_shared`. Give a brain you start its own `ADE_HOME` unless you specifically need the shared one, and confirm it exited when you are done. A separate home is not enough on its own: each project keeps its database in `<project>/.ade/ade.db`, so a brain on another home that opens a real project shares that project's database with the installed brain. Test against a throwaway project registered only in your home (`lsof <project>/.ade/ade.db` shows every brain holding it). A brain a desktop will connect to must be started as `ade --role cto serve`: a plain `ade serve` serves at role `agent` and refuses the desktop.

## Work artifacts

- Keep implementation plans, research notes, and agent scratch files out of the repository. They are inputs to the work, not project documentation. The merged PR is the implementation record.
- Docs describe the present tense. When behavior changes, update the matching `docs/features/` doc in the same branch. A task-tracking list in a feature doc must be kept current by the branch that changes the feature, or deleted — a stale checklist misleads every later agent.
- Track future work in Linear (see the ade-linear skill), not in committed TODO files.

## Pull requests

- Conventional commit titles in plain language: `fix(desktop): new chats no longer spike CPU`.
- Body house style, in order: **Problem** (a sentence or two), **Cause** (when known), **Change and boundary** (what moved, what deliberately did not), **Verification** (the exact focused tests/typechecks run and their counts). End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video. Upload evidence to GitHub; never commit screenshots or PR-only assets to the repo.
- One concern per PR. If the description says "also", consider splitting it.

## Validation

- Desktop checks:
  - `npm --prefix apps/desktop run typecheck`
  - `npm run test:desktop:sharded`
  - `npm --prefix apps/desktop run build`
  - `npm --prefix apps/desktop run lint:ci` (lint + `ade-ui` ratchet, what CI runs)
- ADE CLI checks:
  - `npm --prefix apps/ade-cli run typecheck`
  - `npm --prefix apps/ade-cli run test`
  - `npm --prefix apps/ade-cli run build`
- **Smallest proof first.** Run the narrowest check that proves the change: the touched test files, a scoped typecheck, one shard. Do not run full local suites by default — CI owns the full matrix, and `/finalize` is the opt-in local full gate before a push.
- Run full desktop tests with the root `npm run test:desktop:sharded` command; use single-file or single-shard Vitest commands for iteration.
- Installing deps: use `npm run install:apps` from the repo root, or `cd apps/<app> && npm install`. Never `npm --prefix apps/<app> install`. `--prefix` only redirects where npm writes `node_modules`; the package npm treats as "the one being installed" is still the one in the *current working directory*. From the repo root that is the root package `ade`, so npm installs the repo into the sub-app: it writes `"ade": "file:../.."` into the app's `package.json` and `package-lock.json` and leaves an `apps/<app>/node_modules/ade` symlink back to the root. Revert that churn if you hit it. `npm --prefix apps/<app> run <script>` and `npm --prefix apps/<app> exec` do not install anything and are unaffected -- but note `exec` runs Vitest with the *current* working directory, so run whole suites as `cd apps/<app> && npx vitest run` or the app's own `npm run test`.

## Writing tests

These are hard rules, not preferences. A test that breaks one of them is a
defect, even when it passes.

0. **Do not write new tests while you build.** First make the change work and
   validate it by hand, in the running app, or with an agent-driven check
   (App Control, the browser, the iOS simulator, the CLI). New tests come in
   `/test`, after that validation, and they pin the behavior you proved.
   - When the user asks for tests directly, write them; this rule covers tests
     that nobody asked for.
   - Run existing tests during the work as often as you want. This rule stops
     writing new tests, not running old ones.
   - When an existing test breaks because you changed behavior on purpose,
     leave it for `/test`. Do not bend it during the work.
   - **The one exception:** the behavior can only be validated by a test (a
     race, a pure parser, a state machine with no UI or CLI surface). Then the
     test is the validation tool, and you may write it during the work. Say
     why in your report.
1. **A test must fail only when behavior breaks.** It must never fail when a
   refactor keeps the behavior. Test through the public seam: the exported
   function, the IPC handler, the service API, what the user sees and does.
2. **List the failure modes while you build.** Write down, as notes in your
   report and not as test code, the ways the contract can fail for a caller.
   `/test` tests those, not the lines you changed.
3. **Never write a tautological test.** Do not assert that a mock returns what
   you told it to return. Do not assert that arguments pass through unchanged
   to a mock. Do not compute the expected value with the code under test. Do
   not assert that a constant contains its own substrings.
4. **Never write a change-detector test.** Do not read source files
   (`readFileSync` of `.ts`, `.tsx`, `.swift`) to grep for code or statement
   order. Do not pin CSS classes, pixel values, SVG paths, exact copy, or the
   call order of internal helpers. Do not assert that a removed button, field,
   or option stays removed.
5. **No regression test without a gap.** A bug fix gets a new test only when no
   existing test would fail on the pre-fix code. First, extend the existing
   test for that contract or add a row to its `it.each` table.
6. **Combine before you add.** Trivial cases of one contract are one `it.each`
   table, not many small tests. Extend the existing test file for the module;
   do not create a sibling file for one concern.
7. **Prove that each new test can fail.** Break the behavior on purpose, run the
   test, and see it fail. Then restore the code. A test that still passes
   proves nothing; delete it.
8. **Mock only at process boundaries:** file system, network, child processes,
   Electron APIs, IPC. Never mock the module under test.
9. **Wait on events, receipts, promises, or fake timers — never on wall-clock
   sleeps.** A test that needs a `sleep` or a raised timeout to pass is wrong;
   fix the seam instead.
10. **Do not replace service tests with end-to-end tests.** The most valuable
    tests here are service-level tests of races and seams (process-kill guards,
    multi-brain claims, token refresh order). An end-to-end run cannot reach
    them reliably.
11. **No test-only production seam.** Do not add an export, flag, wrapper, or
    hook that no production caller needs. Test through the real boundary, or
    do not add the test.
12. **One contract, one owner.** A second test of the same contract needs a
    failure the owner cannot reach, such as a transport or lifecycle break.
    Otherwise extend the owner.

`/quality` records a coverage gap. It does not add the test. `/test` adds one
only when it can name the behavior, the failure that turns the test red, and
why no existing test already catches that.

Keep this list the same as the copy in `CLAUDE.md` and the **Test value rules**
in `.agents/skills/test/SKILL.md`. Change all three together.

## Terminology

- Use "lane" for ADE worktrees/branches.
- Use "computer use" for screenshot/video/GUI/browser proof flows.
## Style preferences

- Prefer direct, operational language over marketing phrasing.
- Keep user-facing copy concrete and stateful: say what changed, what is blocked, and what the next action is.
- Use sentence case for headings and labels unless the existing UI pattern is intentionally uppercase.

## Content boundaries

- Do not reframe ADE as a docs site, Mintlify project, or generic template app.
- Do not store secrets in plaintext project files when an encrypted store already exists.
- Do not leave policy enforcement in prompts alone when a code path can enforce it directly.

## Releases via `asc` (App Store Connect CLI)

Release flows live behind `asc` (installed at `/opt/homebrew/bin/asc`). There's no manual IPA/cert shuffling — prefer the CLI end-to-end and consult the `asc-*` skills (`asc-xcode-build`, `asc-testflight-orchestration`, `asc-release-flow`, `asc-signing-setup`, `asc-submission-health`). Auth is keychain-backed (`asc doctor` to verify) with the API key at `~/.apple/asc/keys/AuthKey_*.p8` and `~/.asc/config.json`.

iOS signing gotchas (don't repeat these):

- The iOS project uses **automatic** signing (`CODE_SIGN_STYLE = Automatic`, `DEVELOPMENT_TEAM = VQ372F39G6`). `apps/ios/ExportOptions.plist` ships with `signingStyle = manual` + named profiles for CI/archive determinism, but local ad-hoc exports need `signingStyle = automatic` instead (drop the per-bundle profile map).
- The ADE app **embeds an App Clip** (`com.ade.ios.Clip`, target `ADEClip`, added in PR #706) alongside the app (`com.ade.ios`) and widgets (`com.ade.ios.widgets`). A manual-signing export needs a distribution profile for **every** embedded bundle. The clip's — **`ADE App Clip App Store`** (already minted in ASC, bound to the same distribution certs as the app) — is mapped in `ExportOptions.plist`. If a manual export ever fails signing the clip, the profile is missing/expired: re-mint with `asc profiles create --name "ADE App Clip App Store" --profile-type IOS_APP_STORE --bundle 97ZL5TPJB8 --certificate <dist-cert-ids>`. `ExportOptions.auto.plist` avoids the whole issue — Xcode provisions the clip via `-allowProvisioningUpdates`.
- `asc signing fetch` only downloads provisioning profiles and the `.cer` — it does **not** include the private key. Don't expect it to make local signing work on its own.
- Local exports need the App Store Connect API key passed to `xcodebuild` so it can create/fetch missing Distribution assets on demand. Add these flags (in addition to `-allowProvisioningUpdates`):
  ```
  -authenticationKeyPath ~/.apple/asc/keys/AuthKey_WRRA7YU7RA.p8 \
  -authenticationKeyID WRRA7YU7RA \
  -authenticationKeyIssuerID 4d523a6c-e68c-49b2-8560-34e59786d8e3
  ```
  (Pull the current values from `~/.asc/config.json` rather than hard-coding.) This works even when the local keychain has only the Development cert, because xcodebuild provisions the Distribution cert via ASC.
- For the full flow, `asc publish testflight --app <APP_ID> --project apps/ios/ADE.xcodeproj --scheme ADE --version <x.y.z> --build-number <N> --export-options <auto-plist> --group "<Beta Group>" --wait` does archive + export + upload + distribute in one shot.
- After upload, `processingState = VALID` alone isn't enough for TestFlight distribution — you also need `usesNonExemptEncryption` answered (`asc builds update --build-id <ID> --uses-non-exempt-encryption=false`) and the build assigned to a beta group (`asc publish testflight --build <ID> --group "<Group>"`).

Desktop release:

- Tag a commit on `main` with `vX.Y.Z` and push the tag. `.github/workflows/release.yml` triggers, runs the `release-core.yml` job, and publishes a draft GitHub Release. The workflow requires the tagged commit to be an ancestor of `origin/main`. Assets are the macOS `.dmg` and `.zip` plus `latest-mac.yml`, and the standalone runtime set (`install.sh`, `SHA256SUMS`, and the `ade-darwin-*`/`ade-linux-*` binaries with their `.native.tar.gz` archives). When the repository variable `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` is `1`, Windows builds fresh on the same tag and adds `ADE-<VERSION>-win-x64.exe`, its `.blockmap`, `latest.yml`, `install.ps1`, and `ade-win32-x64.exe` with its `.native.tar.gz`. That variable is the only Windows switch; with it off the Windows jobs skip cleanly and do not block the macOS release.
- Draft releases stay unpublished until you flip them (`gh release edit vX.Y.Z --draft=false` or the UI). Don't publish silently.
- Main is protected by a ruleset: admin bypass is required for direct pushes, and the "strict required status checks" rule makes GitHub's "Merge pull request" button reject merges that use a non-linear history (even when the branch already contains `main`). `gh pr merge --admin` hits the same block; merging locally and pushing (admin bypass) is the fallback.

## Cursor Cloud agents only (ignore outside Cursor Cloud)

**Scope:** The rest of this file applies to every ADE contributor and agent. **This section applies only to agents running in [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent)** (the remote VM environment). Claude Code, Codex, local Cursor IDE, and other harnesses must **not** treat these bullets as repo-wide requirements — skip this section unless you are on a Cursor Cloud VM.

If your environment is not Cursor Cloud, use the general **Validation** section above and the normal desktop/macOS/Windows docs elsewhere in this file.

### Environment overview

- **Node.js 22.x** is required (`node:sqlite` is used as the primary database engine).
- Each app under `apps/` has its own independent `node_modules` and `package-lock.json` (no npm workspaces).
- Validation commands are documented in the "Validation" section above.
- The desktop test suite is large; CI shards it. For local iteration, run a single file or one CI-style shard rather than the full suite.

### Working in ADE lanes (worktrees)

- When an agent session runs inside an ADE lane, its working directory is the lane's worktree (e.g. `/path/to/ADE/.ade/worktrees/<lane-slug>/`). **All file reads, edits, and writes MUST target paths under that worktree, never under the main project-root checkout.**
- `grep`, `find`, and Explore agents may return absolute paths rooted at the main checkout. Before editing, translate those paths to the worktree: replace the project root prefix with the worktree root. For example, `/Users/admin/Projects/ADE/apps/desktop/src/foo.ts` becomes `<worktree>/apps/desktop/src/foo.ts`.
- Use relative paths from your working directory whenever possible — they resolve to the worktree automatically.
- If `ADE_REPO_ROOT` is set in the environment, use it as the canonical base for all file operations.
- When launching dev servers (Vite, Electron, etc.) for a lane, run them from the worktree, not the main checkout: `cd <worktree>/apps/desktop && npm run dev:vite`.

### Running the ADE desktop web renderer (Vite-only preview)

- The desktop renderer can run standalone in a browser without Electron via `npm run dev:vite` in `apps/desktop`. This starts Vite on port 5173 with a browser mock for `window.ade`.
- To seed the mock with real data from the ADE database, run `npm run export:browser-mock-ade` in `apps/desktop` first, or let the `predev:vite` hook do it automatically. The export script reads `.ade/ade.db` from the primary project root and writes a snapshot to `src/renderer/browser-mock-ade-snapshot.generated.json`.
- This works from any lane worktree: `cd <worktree>/apps/desktop && npm run dev:vite`. The export script detects worktree paths and resolves the `.ade/ade.db` location from the parent project root.
- For live data (connected to the ADE runtime socket instead of mock data), use `npm run dev:vite:live`. This starts both Vite and a browser-runtime bridge. Note: this calls `ensureRuntime` which may restart a stale dev runtime — avoid if the ADE beta or another runtime is already running on the target socket.
- Open `http://localhost:5173/work` in a browser or ADE's built-in browser to view the Work tab.

### Inspecting the local Electron desktop app with Codex Computer Use on macOS

- To inspect ADE desktop parity locally with Codex Computer Use, launch the dev app from the worktree with `npm run dev` in `apps/desktop`.
- Treat the Electron process spawned by that command as the source of truth, even if the window title or bundle branding says "ADE". In Codex Computer Use, call `list_apps` / `get_app_state` and prefer the `Electron` app entry (`App=com.github.Electron`) over the installed `ADE` app entry (`App=com.ade.desktop`).
- Confirm the Codex Computer Use app state shows an ADE window whose HTML content URL contains `localhost:5173`. That is the local dev Electron surface.
- The first `Electron` window exposed to Codex Computer Use may be DevTools (`Developer Tools - http://localhost:5173/`). Press `Cmd+\`` in the `Electron` app to cycle to the main ADE window before interacting with the app.
- On first launch, the dev app may open to `localhost:5173/#/project` with no project selected. Open the recent `ADE /Users/admin/Projects/ADE` project inside that dev window before comparing desktop parity.
- Do not use Safari as the desktop parity reference. ADE desktop parity should be checked against the Electron app surface unless the task explicitly asks for renderer-only Vite behavior.
- Keep the dev terminal logs visible while inspecting. Useful confirmation lines include `dev launcher using http://localhost:5173`, `DevTools listening on ws://127.0.0.1:9222`, `window.loading_url`, and `renderer.route_change`.

### Pairing the iOS simulator with the desktop dev app on macOS

- When the user wants the ADE iOS app paired to desktop, run the desktop dev app from the active lane's `apps/desktop`, but set `ADE_PROJECT_ROOT` to the ADE project root the phone should sync with. For this local setup, that is commonly `ADE_PROJECT_ROOT=/Users/arul/ADE npm run dev`, even when the code under test is in `/Users/arul/ADE/.ade/worktrees/...`.
- Do not interact with an already-open Xcode GUI window unless the user explicitly says it is the ADE iOS project. Other projects may be open. Prefer `xcodebuild` and `xcrun simctl` for building, installing, launching, and inspecting the simulator.
- The desktop sync PIN can be read or configured through the dev Electron preload once the `localhost:5173` page is running. Use the CDP endpoint printed by the dev app (`http://127.0.0.1:9222/json/list`) and evaluate `window.ade.sync.getStatus()` to verify `pairingPinConfigured`, `pairingPin`, the sync port, and `connectedPeers`.
- A successful simulator pairing is not just the Settings screen showing "Connected". Also verify desktop `connectedPeers > 0`, inspect the simulator database under `xcrun simctl get_app_container <UDID> com.ade.ios data`, and check recent simulator logs for `incoming message failed`, `FOREIGN KEY`, or changeset errors.
- If pairing reaches WebSocket but the phone reports `FOREIGN KEY constraint failed` while applying `changeset_batch`, treat it as an iOS sync/materialization bug until disproven. Desktop CRR tables may not enforce the same foreign keys as the iOS SQLite schema, so valid remote CRDT batches can arrive in an order that local foreign-key checks reject.

### Running the Electron desktop app on Linux

Cursor’s own desktop IDE does not ship for Linux; Cloud Agents run on Linux VMs, so agents exercise ADE through the **headless `ade` CLI/TUI** or the **Electron dev app** built from this repo (there is still no published Linux `.deb`/AppImage — `electron-builder` only packages macOS and, when enabled, Windows).

- **Canonical Cloud Agent / Linux VM flow:** after `npm run setup`, run `ADE_PROJECT_ROOT=<project> npm run dev:desktop -- --skip-runtime-build`. That rebuilds the lane CLI when needed, points desktop at `/tmp/ade-runtime-dev.sock`, and launches Electron against Vite. Do not start Electron with bare `npx electron .` — without `ADE_RUNTIME_SOCKET_PATH` the app tries `~/.ade/sock/ade.sock`, refuses to spawn a brain there, and project open fails. Renderer-only work can use `cd apps/desktop && npm run dev:vite` (mock `window.ade`) or `npm run dev:code -- --skip-runtime-build --attach` for the TUI.
- **Repository-managed Cloud Agent bootstrap:** `.cursor/environment.json` runs `.cursor/scripts/cloud-agent-install.sh` (deps + CLI build + native rebuild + desktop prebuild) and starts the `ade-dev-desktop` terminal with the command above.
- Set `ADE_DISABLE_HARDWARE_ACCEL=1` — the VM has no real GPU, and without this the app crashes on `WebGL1 blocklisted`.
- `node-pty` ships only macOS/Windows prebuilds. After `npm install`, run `npm --prefix apps/desktop run rebuild:native` to compile `pty.node` for Electron on Linux. Then manually compile the spawn-helper: `cd apps/desktop/node_modules/node-pty && g++ -o build/Release/spawn-helper src/unix/spawn-helper.cc`.
- The `npm run dev` script has a race condition: `predev` clears `dist/`, then tsup + Electron start in parallel, so the first Electron launch fails with "Cannot find module main.cjs" and auto-restarts. To avoid this, pre-build first (`npm run build`) then run the dev launcher directly: `node scripts/normalize-runtime-binaries.cjs && node scripts/ensure-electron.cjs && node scripts/dev.cjs`.
- Alternatively, start Vite and Electron separately for more control: `npx vite --port 5173 --strictPort --force &` then `VITE_DEV_SERVER_URL=http://localhost:5173 npx electron . --no-sandbox`.
- `cr-sqlite` ships for macOS, Windows x64, and Linux x64/arm64 (`vendor/crsqlite/<platform>-<arch>/`). On Linux the brain loads `crsqlite.so` and hosts CRDT sync like any other peer. If the extension is missing, the app logs `db.crsqlite_unavailable` and continues without CRR — that is a packaging defect, not expected Linux behavior.
- The `ADE_PROJECT_ROOT=/workspace` env var tells the main process to auto-open a project at startup. However, there is a timing race: the renderer's initial `getProject()` call may return null before the async project switch completes, causing the welcome screen to appear even though the backend loaded the project. A workaround is to open the project manually via the "Open a project" button in the top bar.
- Computer-use features (screenshot, video capture, GUI automation) are macOS-only (`screencapture`, `osascript`). On Linux these gracefully degrade — the app returns `blocked_by_capability`.
- `electron-builder` config only defines a `mac` target. Distributable Linux builds (deb/AppImage) are not configured, but dev mode works fine.
- The pinned Vitest 0.34.6 does not support `--project`. Use `npx vitest run <specific-test-file>` in `apps/desktop` for targeted tests, `npx vitest run --shard=<n>/8` for a CI-style shard, or `npm run test:desktop:sharded` from the repo root for the full desktop unit workspace.
- In the Cursor Cloud VM the active X display is `:1`, not `:99`. When launching Electron set `DISPLAY=:1`.
- To launch the desktop dev app quickly when the CLI is already built: `npm run dev:desktop -- --skip-runtime-build`.
- To launch the TUI against an already-running dev runtime: `npm run dev:code -- --skip-runtime-build --attach --project-root <path> --workspace-root <path>`.
