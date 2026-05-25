# Goal: ADE Huge Cleanup Pass 2 - Find What The Last Pass Missed

You are the next agent working in:

`/Users/admin/Projects/ADE/.ade/worktrees/huge-cleanup-8469674a`

This lane already contains a large cleanup/audit pass. Your job is **not** to admire that pass and rubber-stamp it. Your job is to assume there are still mistakes hiding in the diff, audit it again from first principles, and make the code safer, clearer, and cheaper to change while preserving ADE's behavior and UX.

Read this whole file before touching code.

---

## Mission

Run a second end-to-end cleanup pass over the entire worktree, focused on:

- finding bugs or regressions introduced by the current diff,
- finding missed dead code, stale docs, stale tests, and stale assumptions,
- simplifying risky or needlessly complex code without changing behavior,
- improving tests where the previous pass made behavior more important but did not pin it tightly enough,
- verifying that every changed interface is synced across main process, preload/shared types, renderer, ADE CLI, docs, and tests,
- keeping ADE fast and smooth in practice, not just "more performant" on paper.

This pass should feel like a strict source-command audit plus a code quality review. Do not stop after one green test. Re-inventory the diff, re-read suspicious files, use parallel agents for distinct slices, fix what you find, then validate again.

---

## Project rules you must preserve

Read `AGENTS.md` first. The key constraints:

- ADE desktop lives in `apps/desktop` and uses Electron, React, and TypeScript.
- ADE CLI lives in `apps/ade-cli`.
- Node.js 22.x is required.
- There are no npm workspaces; each app has its own `node_modules` and lockfile.
- Keep IPC contracts, preload types, shared types, and renderer usage in sync.
- For ADE CLI changes, verify both headless mode and the desktop socket-backed ADE RPC path when relevant.
- Use "lane" for worktrees/branches and "mission" for orchestrated multi-step work.
- Do not reframe ADE as a generic docs site or template app.
- Do not store secrets in plaintext project files.
- Preserve user-facing smoothness. Avoid "performance improvements" that delay visible data, create races, remove useful optimistic state, or make UI feel worse.

Respect the existing worktree. Do not revert changes you did not make unless explicitly instructed.

---

## Current state of this lane

The previous agent already made a large diff and ran a full validation loop. Treat that as useful context, not as proof.

At the end of the previous pass, the worktree had roughly 76 changed tracked files and 3 untracked files:

- `apps/ade-cli/src/runtimeRoles.ts`
- `apps/desktop/src/renderer/components/settings/AiFeaturesSection.test.tsx`
- `scripts/run-desktop-test-shards.mjs`

Those untracked files are intentional and required. The tracked diff imports or references them. If you prepare a commit or PR, include them.

Major areas already touched:

- ADE CLI runtime role normalization and stale daemon detection.
- Runtime `buildHash`, `defaultRole`, `projectRoot`, and `pid` reporting.
- Dev launcher freshness checks in `scripts/dev-*.mjs` and `scripts/tui-web.mjs`.
- Root and desktop test scripts, including `scripts/run-desktop-test-shards.mjs`.
- Constrained model selection in `AgentChatPane`, `AgentChatComposer`, and shared `ModelPicker`.
- Settings AI feature setup routing and tests.
- CTO/first-journey onboarding tour tab switching and tests.
- Mission status sync after mission-step sync, with a regression test for failed-step interventions.
- App control screenshot timer cleanup.
- macOS VM test cleanup.
- A broad unused import/dead-code cleanup across desktop main, renderer, and shared types.
- Docs across architecture, ADE code, agents/tool registration, chat composer, CTO, missions, onboarding/settings, and remote runtime.

Validation already run once on the final tree:

- `npm test` from repo root: all 8 desktop shards passed, then ADE CLI tests passed.
- `npm --prefix apps/desktop run typecheck`
- `npm --prefix apps/ade-cli run typecheck`
- `npm --prefix apps/desktop run lint` passed with 0 errors and existing warnings.
- `npm --prefix apps/desktop run build`
- `node scripts/validate-docs.mjs`
- `git diff --check`
- `node --check` on touched dev/test-shard scripts.

You still need to audit. Green tests are not a substitute for thought.

---

## Required first steps

1. Read `AGENTS.md`.
2. Run:
   - `git status --short`
   - `git diff --stat`
   - `git diff --name-status`
   - `git diff --check`
3. Read the current diff in slices. Do not only look at file names.
4. Use parallel agents for independent audit slices. Suggested slices:
   - ADE CLI/runtime daemon/dev scripts.
   - Desktop renderer/model picker/settings/onboarding.
   - Desktop main services/orchestrator/mission/app-control/macOS VM/local runtime.
   - Docs/package/test infrastructure.
5. Keep working locally while agents run. Do not wait idly unless you are blocked.
6. If a subagent finds a real issue, patch it and rerun relevant validation.

---

## Areas that deserve extra suspicion

### 1. Runtime role normalization and daemon freshness

Files to audit:

- `apps/ade-cli/src/runtimeRoles.ts`
- `apps/ade-cli/src/cli.ts`
- `apps/ade-cli/src/adeRpcServer.ts`
- `apps/ade-cli/src/multiProjectRpcServer.ts`
- `apps/ade-cli/src/tuiClient/connection.ts`
- `apps/ade-cli/src/tuiClient/__tests__/connection.test.ts`
- `apps/ade-cli/src/stdioRpcDaemon.test.ts`
- `scripts/dev-shared.mjs`
- `scripts/dev-desktop.mjs`
- `scripts/dev-code.mjs`
- `scripts/dev-runtime.mjs`
- `scripts/dev-all.mjs`
- `scripts/tui-web.mjs`

Questions to answer:

- Is `ADE_DEFAULT_ROLE` normalized consistently everywhere?
- Are invalid roles handled as missing where that is intended?
- Does embedded TUI force `cto` only when it should, and restore env afterward?
- Do `serve`, headless CLI, machine daemon, multi-project daemon, and desktop socket-backed RPC agree on trusted role behavior?
- Can an older daemon with the same version but stale code survive because `buildHash` is missing or computed against the wrong file?
- Is the placeholder version `0.0.0` bypass intentional and still safe?
- Does `dev:desktop --auto` now behave consistently with `dev-code`/`tui-web` auto mode?
- Does `dev:desktop --auto` starting a runtime before Electron change the expected developer experience in a bad way?
- Do attach modes fail clearly when the runtime is stale?
- Do TCP sockets fail safely when auto-start is impossible?
- Are docs accurate about build hash, default role, project root, and daemon freshness?

Targeted validation ideas:

- `npm --prefix apps/ade-cli run typecheck`
- `npx vitest run src/stdioRpcDaemon.test.ts src/tuiClient/__tests__/connection.test.ts` in `apps/ade-cli`
- `npx vitest run src/adeRpcServer.test.ts src/multiProjectRpcServer.test.ts` in `apps/ade-cli`
- `node --check scripts/dev-shared.mjs scripts/dev-desktop.mjs scripts/dev-code.mjs scripts/tui-web.mjs scripts/run-desktop-test-shards.mjs`

### 2. Constrained model selection

Files to audit:

- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx`
- `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx`
- `apps/desktop/src/renderer/components/chat/AgentChatPane.submit.test.tsx`
- `apps/desktop/src/renderer/components/shared/ModelPicker/ModelPicker.tsx`
- `apps/desktop/src/renderer/components/shared/ModelPicker/ModelPickerContent.tsx`

Questions to answer:

- Does constrained mode truly avoid merging runtime catalog models?
- Does it block submit, draft creation, and parallel launch when the selected model is stale or unavailable?
- Is `runtimeCatalogVersion` intentionally in the memo dependencies even if lint calls it unnecessary? If yes, do not "fix" it into a stale UI bug.
- Are existing unconstrained chat surfaces still able to pick configured/runtime models as before?
- Are active-session models preserved where allowed by policy?
- Are empty constrained lists handled with clear UI and no accidental launch?
- Are tests strong enough to catch stale localStorage model config issues?

Targeted validation ideas:

- `npx vitest run src/renderer/components/chat/AgentChatPane.submit.test.tsx src/renderer/components/shared/ModelPicker/ModelPicker.test.tsx` in `apps/desktop`
- `npm --prefix apps/desktop run typecheck`

### 3. Settings AI provider routing

Files to audit:

- `apps/desktop/src/renderer/components/settings/AiFeaturesSection.tsx`
- `apps/desktop/src/renderer/components/settings/AiFeaturesSection.test.tsx`
- `apps/desktop/src/renderer/components/settings/ProvidersSection.tsx`
- `apps/desktop/src/renderer/components/settings/ProxyAndPreviewSection.tsx`
- related docs in `docs/features/onboarding-and-settings/README.md`

Questions to answer:

- Do all model picker surfaces that need provider setup route to `/settings?tab=ai#ai-providers`?
- Did the cleanup remove imports or handlers that had side effects?
- Are the tests too coupled to implementation details, or are they pinning useful routing behavior?

### 4. Onboarding and CTO tour behavior

Files to audit:

- `apps/desktop/src/renderer/onboarding/tours/ctoTour.ts`
- `apps/desktop/src/renderer/onboarding/tours/firstJourneyTour.ts`
- `apps/desktop/src/renderer/onboarding/tours/firstJourneyTour.test.ts`
- `apps/desktop/src/main/services/onboarding/onboardingService.ts`
- `apps/desktop/src/renderer/components/cto/CtoPage.tsx`
- `apps/desktop/src/renderer/components/cto/LinearSyncPanel.tsx`
- `apps/desktop/src/renderer/components/cto/TeamPanel.tsx`

Questions to answer:

- Are CTO tab switch step actions preserved when steps are wrapped into the first journey tour?
- Do step targets still match actual renderer tab keys?
- Did cleanup remove any event bridging that tours still depend on?
- Are docs and terminology still current?

Targeted validation:

- `npx vitest run src/renderer/onboarding/tours/firstJourneyTour.test.ts` in `apps/desktop`

### 5. Mission/orchestrator status sync

Files to audit:

- `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.ts`
- `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.test.ts`
- `apps/desktop/src/main/services/orchestrator/orchestratorContext.ts`
- `apps/desktop/src/main/services/orchestrator/coordinatorTools.ts`
- `apps/desktop/src/main/services/orchestrator/coordinatorAgent.ts`
- `apps/desktop/src/main/services/missions/missionService.ts`
- `docs/features/missions/README.md`
- `docs/features/missions/orchestration.md`

Questions to answer:

- Is `nextMissionStatus` re-derived after `syncMissionStepsFromRun` and `syncMissionPhaseFromRun` in every path where the mission may have changed?
- Is the new failed-step intervention regression enough, or are there other sync-created intervention paths that need coverage?
- Does the re-derive logic respect explicit `options.nextMissionStatus`?
- Does finalization still use a fresh enough mission detail for outcome summaries and errors?
- Did removed imports/functions have any side effects?
- Did cleanup of coordinator/orchestrator types accidentally weaken tool contracts?

Targeted validation:

- `npx vitest run src/main/services/orchestrator/aiOrchestratorService.test.ts -t "intervention_required"` in `apps/desktop`
- `npx vitest run src/main/services/orchestrator/orchestratorPlanning.test.ts src/main/services/orchestrator/coordinatorTools.test.ts` in `apps/desktop`

### 6. App control, computer use, and artifact ownership

Files to audit:

- `apps/desktop/src/main/services/appControl/appControlService.ts`
- `apps/desktop/src/main/services/appControl/appControlService.test.ts`
- `apps/desktop/src/main/services/ai/tools/universalTools.ts`
- `apps/desktop/src/main/services/computerUse/*`

Questions to answer:

- Is screenshot timeout cleanup robust on success, failure, and timeout?
- Are timers `unref()`ed only where safe?
- Are policy enforcement and artifact ownership still implemented in code, not just prompts?
- Did cleanup remove capability checks or ownership metadata?

Targeted validation:

- `npx vitest run src/main/services/appControl/appControlService.test.ts` in `apps/desktop`

### 7. Local runtime connection pool test cleanup

Files to audit:

- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.test.ts`

Previous audit noted duplicated temp-dir cleanup. It was not refactored because it was low risk and the suite was passing.

Your task:

- Decide if this duplication is worth simplifying now.
- If you refactor, keep it tiny and rerun the file.
- Do not churn the test if it makes failure cleanup less obvious.

Targeted validation:

- `npx vitest run src/main/services/localRuntime/localRuntimeConnectionPool.test.ts` in `apps/desktop`

### 8. Sharded tests and package scripts

Files to audit:

- `package.json`
- `apps/desktop/package.json`
- `scripts/run-desktop-test-shards.mjs`
- `apps/desktop/vitest.workspace.ts`
- `docs/ARCHITECTURE.md`
- `AGENTS.md`

Questions to answer:

- Does root `npm test` match CI-style desktop sharding and then ADE CLI?
- Does `test:unit` avoid unsupported Vitest `--project`?
- Does the sharding script propagate failures, preserve exit codes, and avoid hiding output?
- Should the sharding script be tested directly, or is command validation enough?
- Are docs clear that `vitest.workspace.ts` is active but CLI `--project` is unsupported for the pinned Vitest version?

Validation:

- `node --check scripts/run-desktop-test-shards.mjs`
- `npm test` from repo root before final

### 9. Docs and stale text

Files to audit:

- `AGENTS.md`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/features/ade-code/README.md`
- `docs/features/agents/tool-registration.md`
- `docs/features/chat/composer-and-ui.md`
- `docs/features/cto/README.md`
- `docs/features/missions/README.md`
- `docs/features/missions/orchestration.md`
- `docs/features/onboarding-and-settings/README.md`
- `docs/features/remote-runtime/internal-architecture.md`

Questions to answer:

- Are docs consistent with current code, not just with the previous agent's mental model?
- Are there stale references to removed action-list changed events, old test commands, old runtime role trust model, or old local-runtime behavior?
- Are tables still valid Markdown?
- Did docs validation cover all edited docs?

Commands:

- `node scripts/validate-docs.mjs`
- `rg -n "onActionsListChanged|actions/list_changed|--project unit|vitest.config.ts|265 test files|listChanged: true|runtimeInfo.defaultRole|runtimeInfo.buildHash|ADE_DEFAULT_ROLE" AGENTS.md README.md docs apps scripts package.json`

Note: Some words like "planner" are real product concepts. Do not delete real docs just because a broad search finds the term.

### 10. Removed imports and "cleanup-only" changes

Many files were touched only to remove imports, helper functions, or stale code. These are easy places to accidentally remove a side-effect import or a piece of behavior that looked unused.

Audit at least these:

- `apps/desktop/src/main/main.ts`
- `apps/desktop/src/main/services/ipc/registerIpc.ts`
- `apps/desktop/src/main/services/state/kvDb.ts`
- `apps/desktop/src/renderer/components/app/AppShell.tsx`
- `apps/desktop/src/renderer/components/lanes/LaneGitActionsPane.tsx`
- `apps/desktop/src/renderer/components/lanes/LanesPage.tsx`
- `apps/desktop/src/renderer/components/missions/missionThreadEventAdapter.ts`
- `apps/desktop/src/renderer/components/history/*`
- `apps/desktop/src/renderer/components/settings/*`

Questions:

- Was any import removed that registered a side effect?
- Was any callback removed that still appears in JSX, IPC contracts, preload types, or tests?
- Was any type removed from shared types while serialized data still uses it?
- Do typecheck and full tests exercise enough of the affected code path?

---

## Search checklist

Run targeted searches and actually inspect results:

```sh
rg -n "TODO|FIXME|HACK|XXX|dead code|unused|stale|deprecated|temporary|compat|fallback" apps docs scripts
rg -n "onActionsListChanged|actions/list_changed|listChanged: true" apps docs scripts
rg -n "ADE_DEFAULT_ROLE|defaultRole|runtimeInfo|buildHash|projectRoot" apps/ade-cli/src scripts docs apps/desktop/src
rg -n "availableModelIdsOverride|constrainModelSelection|constrainToAvailableModelIds|runtimeCatalogVersion" apps/desktop/src/renderer/components
rg -n "syncMissionFromRun|deriveMissionStatusFromRun|intervention_required|failed_step" apps/desktop/src/main/services
rg -n "--project|test:unit|test:desktop:sharded|run-desktop-test-shards" package.json apps/desktop/package.json docs scripts
```

Do not treat grep output as truth. Follow each suspicious result to code.

---

## Validation bar before you finish

Run smallest relevant tests while iterating. Before final, run the broad checks.

Minimum final validation:

```sh
git diff --check
node scripts/validate-docs.mjs
npm --prefix apps/desktop run typecheck
npm --prefix apps/ade-cli run typecheck
npm --prefix apps/desktop run lint
npm --prefix apps/ade-cli run build
npm --prefix apps/desktop run build
npm test
pgrep -fl "run-desktop-test-shards|vitest run --shard|npm test|tsc -p tsconfig|eslint.js|vite build|tsup" || true
```

Important:

- The full desktop suite must be sharded. Root `npm test` should do this.
- Do not run desktop and ADE CLI builds in parallel; they can collide through shared build artifacts.
- Desktop lint may report existing warnings. Treat new errors as failures. If you introduce new warnings in touched files, consider fixing them if low risk.
- Expected full-test noise includes React unknown-prop warnings from mocked split panes, mocked PR check failures, preload fallback errors, terminal fit rejection logs, SQLite experimental warnings, and mocked git stderr in lane tests. These are not failures if the tests pass.
- If you touch frontend behavior that needs visual confidence, launch the local ADE desktop dev app and inspect the actual Electron surface. Follow `AGENTS.md` for macOS Computer Use instructions. Do not use Safari as the desktop parity reference.

---

## Parallel agent prompts you can reuse

Use subagents because this is too broad for one mental thread.

### Agent A: CLI/runtime/dev scripts

Audit only, or patch only with permission. Worktree is `/Users/admin/Projects/ADE/.ade/worktrees/huge-cleanup-8469674a`. Review the current diff for ADE CLI runtime roles, daemon freshness, `buildHash`, `defaultRole`, `projectRoot`, env restoration, `serve`, headless CLI, socket-backed RPC, and dev launcher scripts. Find behavior regressions or missing tests. Return severity, file/line references, and validation run.

### Agent B: Renderer model/settings/onboarding

Audit constrained model selection, provider setup routing, shared `ModelPicker`, chat submit/parallel launch guards, `AiFeaturesSection`, CTO tour wrapping, and first-journey tour tests. Verify stale model and empty allowed-list behavior. Return severity, file/line references, and validation run.

### Agent C: Main services/orchestrator/runtime cleanup

Audit app control screenshot timers, mission/orchestrator status sync, local runtime connection pool tests, macOS VM cleanup, removed imports in main services, and state/IPC cleanup. Look for behavior hidden behind "dead code" removals. Return severity, file/line references, and validation run.

### Agent D: Docs/package/test infrastructure

Audit docs and package scripts for stale commands, wrong Vitest config references, bad Markdown tables, missing mention of runtime freshness, and sharding script robustness. Return severity, file/line references, and validation run.

---

## Completion criteria

You are done only when:

- Every current diff file has been considered, not merely listed.
- All subagent findings are either fixed or explicitly rejected with a reason.
- Any new behavior you rely on has focused tests.
- The broad validation bar passes on the final tree.
- `git status --short` is understood, including untracked required files.
- You have not left long-running test/build/dev processes behind.
- Your final summary names what changed, what was validated, and any honest residual risk.

This is a second cleanup pass. Be skeptical, be practical, and preserve the feel of the product.
