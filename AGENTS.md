# ADE Project Instructions

## About this project

- ADE is a local-first desktop app for orchestrating coding agents, lanes, PR workflows, and proof capture. Desktop: `apps/desktop` (Electron, React, TypeScript). CLI: `apps/ade-cli`, which shares core services with desktop. iOS: `apps/ios`.
- A project's ADE state lives in its `.ade/`: the SQLite database `ade.db`, plus machine-local `secrets/`, `cache/` and `artifacts/`.
- Words: a **lane** is an ADE worktree and its branch. **Computer use** means screenshot, video, GUI and browser proof flows.

## Dev loop

`/context` → work → `/quality` → `/test` → `/ship`. Each stage is a skill in `.agents/skills/` (`.claude/skills` links there). Open each one when you reach it.

- **"Run the dev loop"** (or "dev loop") is one task: invoke `/quality`, then `/test`, then `/ship`, print each summary, and keep going. Approximating a skill does not count: running tests is not `/test`, and green CI is not `/quality`. Stop early only for a failing gate or a decision only the user can make, and name it.
- The PR opens at the start of `/quality`, so CI and the review bots run while quality and test work. Do not push while a review bot is running on the remote head: a push restarts Greptile.
- Utilities, when relevant: `/audit`, `/finalize`, `/optimize`, `/release`, `/update-providers`.

### Running the dev app

From the lane worktree, detached, on the lane's own socket:

```bash
node scripts/dev-detached.mjs /tmp/ade-dev-<lane>.log \
  npm run dev:desktop -- --socket /tmp/ade-runtime-<lane>.sock
until grep -q 'dev isolation report' /tmp/ade-dev-<lane>.log; do sleep 2; done
cat /tmp/ade-dev-<lane>.log
```

- Read the isolation report and stop if sync is ON. Never hand-start `ade serve`.
- Never press Connect or Disconnect for a paired machine in a dev app unless the task is remote machines: it takes that machine away from the user's installed ADE.
- Close the app before you edit main-process, preload or `src/shared` code. Each save relaunches the window in front of the user's work. Renderer edits hot-reload.
- When done, stop the app's process group and confirm its brain exited. Give `scripts/dev-runtime-stop.mjs` an explicit `--socket`: without it, inside an ADE shell, it stops the user's real brain.
- Use Node 22 (`node:sqlite`). Full rules: `docs/development/local-development.md`.

## Ways to hurt yourself

Each of these has caused real damage while developing ADE from inside ADE.

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or kill a PID found by name or path: your own agent, xcodebuildmcp and the user's real brain all match. Kill only a PID you captured at spawn, after checking its cwd is your worktree.
2. **Writing to live state.** The project root's `.ade/` and the installed brain are the user's real ADE. Read them for realistic data; never open them read-write, point a dev server at them, or clean them up. A throwaway project must live outside any git repo: a folder inside this repo resolves to the real ADE project.
3. **Editing outside the lane worktree.** Every edit targets `.ade/worktrees/<lane>/...`. Search tools may print root-checkout paths; translate them before editing.
4. **Sharing a brain or database by accident.** List brains and their homes before starting or blaming one: `pgrep -alf "cli.cjs serve|/bin/ade serve"`, then `ps eww -p <pid> | tr ' ' '\n' | grep ADE_HOME` (no output means the shared `~/.ade`). `--no-sync` guards only the sync lease. A separate `ADE_HOME` is not enough either: each project keeps its own `.ade/ade.db`, so real isolation is a separate home plus a throwaway project registered only there (`lsof <project>/.ade/ade.db` shows who holds it). A brain a desktop connects to needs `ade --role cto serve`.

## Built for remote machines

ADE is built around remote connections. One window drives several machines: a laptop works on lanes that live on a desktop, a phone drives the brain at home, and the Work tab lists chats, CLIs and shells from every connected machine. A lane owns its machine, and its chats and terminals live there and only there. So every action on something that can live on another machine (a chat, session, lane, terminal, sign-in) must be sent to **that** machine:

1. **Pass the scope.** Renderer calls take an optional `pin` (an `OpenProjectBinding`). Leave it out and the call silently goes to the tab's machine: fine in local testing, broken when the chat is elsewhere ("Chat session '…' was not found"). In a chat subtree read `useChatRuntimeScope().pin`; on the Work page, the row's `foreignRow.binding` or `useWorkSessions().resolveSessionRuntimePin`; in Settings, `useSettingsMachineScope().pin`. These are null for the tab's own machine, which keeps the unpinned route; do not substitute the tab binding. A start, its stop and its status reads all use the same pin.
2. **Make the contract carry it.** A new IPC/preload method acting on a chat, session, lane or terminal takes `pin?: OpenProjectBinding | null` and routes it through `callPinnedRuntimeAction` (or `callPinnedOrBoundRuntimeActionOr`), and its runtime action is reachable remotely (action domain + `actionPolicy`). In components, prefer a required `pin` prop over an optional one.
3. **Key effects on `pin?.key`,** not the pin object, or a rebuilt pin restarts the effect (a login shell, a voice call) for nothing.
4. **Check it remotely.** Ask "what if this chat is on another machine?" for every new action, and name in `/quality` which new calls are scoped and how. Something that can only run on this computer gets a clear guard message, never a misroute.

## Hit every ADE surface

The most common defect here is a change that works on the tested path and is missing everywhere else. Before calling a change done, state which of these applied:

- **Entry points:** desktop UI, `ade` CLI, `ade code` TUI, deeplinks, command palette, keybindings.
- **Clients:** desktop, hosted web, iOS and the TUI share one brain. Shared logic goes in shared services and types.
- **Providers:** Claude, Codex, Cursor, OpenCode, Droid and the rest each need a decision, even "not supported", recorded in the capability gate.
- **Contracts:** main handler, `src/shared` types, preload, renderer caller, daemon action domain, tests and mocks move together.
- **Reverse states:** a way in needs a way out and a way to see it (snooze/unsnooze, settle/unsettle, link/unlink).
- **Connection modes:** local runtime, remote runtime and relay differ; the phone can be newer than the host. See **Built for remote machines**.
- **Windows:** parity is part of done for all new code.
- **Docs:** user-visible changes update the matching `docs/features/` doc, in present tense.

## Working norms

- Preserve existing patterns before adding abstractions. Fix the underlying service or shared type, not a renderer-only workaround.
- When code can enforce a policy, do not leave it to prompt text (computer-use policy and artifact ownership especially). No plaintext secrets in project files when an encrypted store exists.
- Anything new must survive a project switch: declare each new runtime action `read` or `write` in `apps/desktop/src/shared/adeActionAccess.ts`, and make a surface that loads data say "couldn't load" with a retry, never show a false empty state.
- For ADE CLI changes, verify both headless mode and the desktop socket-backed RPC path.
- Search ADE with `ade search "<query>" --text`, not by grepping `.ade/`.
- Copy is direct, concrete and stateful: what changed, what is blocked, what to do next. Sentence case.

## Performance budget

`docs/perf/macos-baseline.md` holds ADE's measured numbers and a ceiling for each. It applies when a change renders lists or long content; adds an effect, timer, poll, subscription or animation; adds or changes IPC or a runtime action; spawns processes; reads files or databases on a hot path; builds large in-memory structures; or adds a surface that loads its own data. When in doubt, it applies.

Measure before and after with the doc's scripts, same machine and conditions. If a row gets more than 25% worse or crosses its ceiling, optimize before calling it done, never by cutting features or UI (`/optimize` and the `ade-perf-*` skills). Update the table in the same branch. Never raise a ceiling without the user's approval. The PR body lists the rows measured, before and after, or says why you could not measure.

## Subagents

Agents cost the user real usage. These rules apply to every agent in this repo, including agents started by a skill.

1. **Do the work yourself first.** Start one only for large, truly parallel, or second-opinion work, and batch related work into one agent.
2. **Subagents do not start subagents** unless absolutely necessary, then only one, and they say so in their report.
3. **Say it in the brief:** "Do not start subagents or parallel reviewers; do all the work yourself."
4. **Tell the user first:** the agent, its model, and why. When the user asked to limit agents, run a skill's "one agent per track" tracks yourself, in order.
5. **Use the cheapest model that can do the job.** When the user names a model, use that one.

## Tests and checks

- **Do not write new tests while you build.** Validate by hand first: in the running app, or with App Control, the browser, the iOS simulator, or the CLI. New tests come in `/test`, and its default is zero. The exception is behavior only a test can validate (a race, a pure parser, a state machine with no UI or CLI surface); say why in your report. When the user asks for tests directly, write them.
- While you build, list the ways the change can fail for a caller, as notes in your report. `/test` tests those.
- **Before you write or edit any test, read the Test value rules in `.agents/skills/test/SKILL.md`.** They are hard rules: a test that breaks one is a defect even when it passes.
- When an existing test breaks because you changed behavior on purpose, leave it for `/test`.
- **One check pass, at the end of `/quality`:** typecheck each touched package and run the tests that cover the touched code. Never check after every edit; after a failure, re-run only what failed. Later fixes in `/test` and `/ship` re-check only their delta. CI is the full gate: run the full suite (`npm run test:desktop:sharded`) only when the user asks or in `/finalize`.
- Commands: `npm --prefix apps/desktop run typecheck|build|lint:ci`, `cd apps/desktop && npx vitest run <file>`, `npm --prefix apps/ade-cli run typecheck|test|build`.
- Install deps with `npm run install:apps` from the root or `cd apps/<app> && npm install`. Never `npm --prefix apps/<app> install`: it installs the root package into the app (`"ade": "file:../.."` in its `package.json`); revert that if you hit it.

## UI primitives

There is exactly one of each notice and overlay. Read `docs/design/notices.md` before adding a banner, toast, dialog or popover, and `docs/design/visual-language.md` before building or restyling a surface (reuse `styles/surfaceKit.css` and `settings/primitives/SettingsModern.tsx`).

- Banners: `Banner` / `useAppBanner` from `components/ui/notice`. Toasts: `showToast()` from `components/app/toast/toastStore`. Dialogs: `confirmDialog()` / `promptDialog()` / `<Dialog>` from `components/ui/dialog`, never `window.confirm`/`prompt`/`alert`. Top-bar dropdowns: `HeaderSheet`.
- Stacking: `Z_LAYERS` from `components/ui/zLayers.ts`. No raw `zIndex` ≥ 50, `z-50`, `z-[N]`, or `position: fixed` outside the hosts.
- `npm --prefix apps/desktop run lint:ci` fails CI when a file's `ade-ui/*` warning count grows. After fixing violations, run `npm run lint:baseline` in `apps/desktop` and commit the smaller baseline.

## Work artifacts and docs

- Plans, research notes and scratch files stay out of the repo. The merged PR is the record.
- Docs describe the present. A task list in a feature doc is kept current by the branch that changes the feature, or deleted.
- Track future work in Linear (the `ade-linear` skill), not committed TODO files.

## Pull requests

- Open with `ade prs create` (the `ade-pr-workflows` skill has the writing guide); `gh pr create` is the fallback.
- Conventional commit titles in plain language: `fix(desktop): new chats no longer spike CPU`.
- The body is a brief for someone with two minutes: **Why**, **What changed** (for the person using it; what was left alone on purpose), **Evidence** (how you checked and what you saw), **Not checked** (or "Nothing"), and **Choices I made** when you settled a trade-off alone. End with the model and harness. Plain words; no code names in Why and What changed.
- Match evidence to the change (a picture for layout, a short video for motion, numbers for speed), cited as `ade-proof://` links. Never commit screenshots.
- One concern per PR.
- Close every review thread you handle in the same turn: reply with what changed or why not, then resolve it (`ade prs reply`, `ade prs resolve-thread`). Leave one open only when a person must decide.

## Releases

Use the `/release` skill. Its `reference.md` holds the App Store Connect (`asc`), iOS signing, desktop tag, and branch-protection details.
