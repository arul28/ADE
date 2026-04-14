# Validation Gates (Behavioral Contract)

Missions have a dedicated validation contract that lives outside the normal unit-test suite: `docs/validation-contract-m1-m2.md`. It is a set of behavioral assertions — each with a title, behavioral description, pass/fail conditions, and explicit evidence requirements. Assertions are ID'd as `VAL-<AREA>-<NNN>`.

This document indexes the assertions by area and notes where the backing tests live. It is a pointer to the contract, not a replacement for it.

## Source file map

- `docs/validation-contract-m1-m2.md` — the contract (366 lines, 19 assertions).
- `apps/desktop/src/main/services/orchestrator/worktreeIsolation.test.ts` — VAL-ISO-*.
- `apps/desktop/src/main/services/orchestrator/stateCoherence.test.ts` — VAL-STATE-*.
- `apps/desktop/src/main/services/orchestrator/runtimeInterventionsSteeringErrors.test.ts` — VAL-INTV-*, VAL-STEER-*, VAL-ERR-*.
- `apps/desktop/src/main/services/orchestrator/planningFlowAndHandoffs.test.ts`, `planningGapsFixes.test.ts` — VAL-PLAN-*, VAL-HAND-*, VAL-ART-*.
- `apps/desktop/src/main/services/orchestrator/hardeningMissions.test.ts` — hardening regressions.
- `apps/desktop/src/main/services/orchestrator/coordinatorTools.test.ts` — coordinator tool behavior including VAL-ISO-002.
- `apps/desktop/src/main/services/orchestrator/orchestrationRuntime.test.ts` — end-to-end runtime integration.
- `apps/desktop/src/main/services/orchestrator/orchestratorService.test.ts` — row-level orchestratorService assertions, including VAL-BUDGET-002 coverage.

## Assertion index

### Area: Worktree Isolation

Ensures workers run inside lane worktrees and never write to the primary repo without an explicit constraint.

- **VAL-ISO-001** — Worker CWD resolves to `lanes.worktree_path`, not `projectRoot`. Null/empty worktree MUST fail with `errorClass: "configuration_error"` — no silent fallback. Evidence in `worktreeIsolation.test.ts` (mocked lane with `worktree_path = "/tmp/test-worktree"` and null variant). Code reference: `orchestratorService.ts` ~lines 6556–6563.
- **VAL-ISO-002** — `buildFullPrompt()` must include `"You are working in: <worktree_path>"` and `"All file edits MUST be made in the worktree path above."` when a lane worktree is present. Tested in `coordinatorTools.test.ts` (~lines 1664–1666).

### Area: State Coherence

Ensures mission and run statuses stay mutually consistent.

- **VAL-STATE-001** — Mission `intervention_required` is never set while a run is `active` or `bootstrapping`. `transitionMissionStatus(..., "intervention_required")` must pause all runs first. Evidence in `stateCoherence.test.ts`; code reference: `pauseRunWithIntervention` in `aiOrchestratorService.ts` ~5686 must call `orchestratorService.pauseRun()` before `missionService.addIntervention({ pauseMission: true })`.
- **VAL-STATE-002** — A parent step that fanned out to variants MUST transition to `succeeded` (at least one variant succeeded) or `failed` (all failed) after variants terminal-ize — never remain `ready` or `running`. Code reference: `completeAttempt()` checks remaining sibling attempts and transitions the parent step on last-variant completion.

### Area: Intervention Deduplication

Prevents duplicate interventions for single failure events.

- **VAL-INTV-001** — At most one open `failed_step` intervention per step. N distinct step failures produce N interventions; re-failing the same step with an open intervention produces no new intervention. Code reference: intervention creation in `missionService.ts` ~3335 and `aiOrchestratorService.ts` must both check for an existing-open intervention before inserting.
- **VAL-INTV-002** — Intervention creation is idempotent across the dual creation paths (`completeAttempt` + `runtimeEventRouter.routeEventToCoordinator`). Concurrent failure handlers must not race to create duplicates.

### Area: Steering & Resume

Ensures steering a paused mission actually unsticks it.

- **VAL-STEER-001** — `steerMission({ missionId, directive: "continue" })` on a paused mission with open `manual_input` interventions must:
  1. resolve matching interventions,
  2. resume the paused run to `active`,
  3. transition the mission to `in_progress`.
  Code reference: `steerMission()` (~`aiOrchestratorService.ts` line 7400+) must call `orchestratorService.resumeRun()` after resolving interventions; `triggerCoordinatorEvaluation()` must fire so the coordinator picks up the state.

### Area: Worker Error Classification

Distinguishes "never started" from "started but interrupted".

- **VAL-ERR-001** — `classifySilentWorkerExit()` (`orchestratorService.ts` ~547–572) must return `interrupted` or `executor_failure` for workers that produced tool activity before termination. `startup_failure` is reserved for workers that never produced any assistant or tool activity (`hasMaterialOutput === false` and no transcript summary and no tool activity).

### Area: Budget Pause Consistency

Two budget pause paths must converge on the same downstream effects.

- **VAL-BUDGET-001** — Token budget exceeded in `completeAttempt()` (`orchestratorService.ts` ~6301–6317 and ~8022–8031) and hard cap in `coordinatorTools.ts` (~4806, ~5106) must both produce:
  - run paused,
  - `budget_limit_reached` intervention,
  - `mission_paused` timeline event,
  - mission status `intervention_required`.
  Both paths should converge on `pauseMissionWithIntervention()` or an equivalent helper.
- **VAL-BUDGET-002** — `tickRun()` (`orchestratorService.ts` ~5816) must never auto-resume a budget-paused run. Paused runs stay paused until explicit user action (steer or resume). Evidence: paused run remains paused after 10 calls to `tickRun()`. Partial coverage already in `orchestratorService.test.ts:3659`.

### Area: Planning Artifacts

Ensures planning outputs land in project-local `.ade/plans/` and not in home-directory sandboxes.

- **VAL-PLAN-001** — Planner worker writes plan files to `<worktree>/.ade/plans/`, never to `~/.claude/plans/`. Sandbox policy should block home-dir writes and prompts must reference project-local paths. Coordinator prompt already warns against `ExitPlanMode` (`coordinatorAgent.ts` ~1070); the planner prompt must also redirect plan writes.
- **VAL-PLAN-002** — `ExitPlanMode` MUST NOT be triggered during mission planning. The coordinator prompt blocks the tool; the planner prompt reinforces it; the runtime event router should classify an `ExitPlanMode` invocation as a planning-guard violation.
- **VAL-PLAN-003** — When the planner needs clarification it must call `ask_user` (which creates a `manual_input` intervention), not emit free-text questions the user has to scrape out of the transcript.

### Area: Worker Handoff Data

Ensures workers produce structured handoff data on completion.

- **VAL-HAND-001** — Worker completion must produce a `DelegationContract` handoff object with the contract's required shape. Missing or malformed handoff data should mark the attempt failed with `errorClass: "handoff_malformed"`, not silently accept partial output.
- **VAL-HAND-002** — Downstream workers must receive upstream handoff summaries in their prompt. `buildFullPrompt()` injects the relevant handoff context from the completed upstream attempts.

### Area: Artifact Visibility

Ensures planning + worker artifacts are discoverable as mission artifacts.

- **VAL-ART-001** — Planning artifacts (plan files under `.ade/plans/`) are registered as `MissionArtifact` records so they appear in the Artifacts tab and survive a mission list query.
- **VAL-ART-002** — `OrchestratorWorkerCheckpoint` entries are accessible as mission artifacts alongside any produced files. Mission UI treats checkpoints as first-class artifacts, not hidden orchestrator state.

## How to work with the contract

When changing orchestrator code:

1. Identify which area(s) the change intersects.
2. Read the existing assertion bodies and their code references in `docs/validation-contract-m1-m2.md`. The code references are approximate line numbers — grep by function name.
3. Run the corresponding test file. Each area maps to one or two primary test files listed in the source file map.
4. If adding a new invariant, extend the contract and add a VAL-XXX entry with a pass/fail condition and explicit evidence requirements. The contract is the source of truth for what "correct runtime behavior" means — PR descriptions should reference the VAL-XXX id.

## Gotchas

- **The contract is not auto-verified.** There is no single test runner that fails if an assertion is broken — each assertion maps to a specific behavioral test. Adding a VAL id without wiring a test leaves a silent gap.
- **Line-number references drift.** The contract lists approximate line numbers inside `orchestratorService.ts` and related files. After large refactors, code references will be stale but the behavioral description is still the source of truth.
- **Dual-path invariants need both tests.** VAL-INTV-002 and VAL-BUDGET-001 specifically guard against one path diverging from the other; adding coverage only to one path defeats the assertion's intent.
- **`transitionMissionStatus` guard skips transitions silently.** Any future logging of these skips should be careful not to regress the silence-when-terminal behavior described in the README.

## Cross-links

- `README.md` — mission overview and runtime contract.
- `orchestration.md` — detailed orchestrator component map.
- `workers.md` — worker pool, role isolation, concurrency (relates to VAL-HAND-*, VAL-ART-*).
- `docs/validation-contract-m1-m2.md` — the canonical contract.
