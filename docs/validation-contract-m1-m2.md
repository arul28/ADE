# Validation Contract — Milestone 1 & Milestone 2

> ADE Missions Overhaul — Testable Behavioral Assertions
> Generated: 2026-03-10

---

## Area: Worktree Isolation (runtime-fixes)

### VAL-ISO-001: Workers execute within lane worktree, not primary repo

**Title:** Worker CWD resolves to lane worktree path

**Behavioral description:**
When a worker is spawned for a step that has a `laneId`, the worker's working directory (`cwd`) MUST resolve to the lane's `worktree_path` from the `lanes` table — never to `projectRoot`. If `worktree_path` is null or empty, the attempt MUST fail with a clear error rather than silently falling back to `projectRoot`.

**Pass condition:** For every attempt where `step.laneId` is non-null, the tracked session's `cwd` equals the lane's `worktree_path`. No file writes occur under `projectRoot` when the lane has a valid worktree.

**Fail condition:** Any attempt with a valid `laneId` starts a session in `projectRoot`, or any file modification is detected outside the worktree directory tree.

**Evidence requirements:**
1. Unit test: mock a lane with `worktree_path = "/tmp/test-worktree"` and verify `startExecutor()` passes `/tmp/test-worktree` as the session cwd.
2. Unit test: mock a lane with `worktree_path = null` and verify the attempt returns `status: "failed"` with `errorClass: "configuration_error"` (not silent fallback).
3. Code review: confirm `orchestratorService.ts` lines ~6556–6563 no longer fall back to `projectRoot` when `worktree_path` is empty.

---

### VAL-ISO-002: Prompt instructs worker to write only in worktree

**Title:** Worker prompt includes explicit worktree path constraint

**Behavioral description:**
The assembled worker prompt from `buildFullPrompt()` MUST include the resolved worktree path and an explicit instruction that all file edits must be made within that path. This prevents workers from accidentally editing files in the primary repo even if their CWD is correct.

**Pass condition:** The prompt string returned by `buildFullPrompt()` contains a line matching `"You are working in: <worktree_path>"` and `"All file edits MUST be made in the worktree path above."` when a lane worktree is present.

**Fail condition:** `buildFullPrompt()` omits the worktree constraint or references `projectRoot` when a lane worktree is assigned.

**Evidence requirements:**
1. Unit test: call `buildFullPrompt()` with a step that has a lane worktree path and verify the output contains the constraint text.
2. Existing test (`coordinatorTools.test.ts:1664-1666`) already asserts this for `/tmp/worktree` — confirm it still passes after changes.

---

## Area: State Coherence (runtime-fixes)

### VAL-STATE-001: Mission status and run status are mutually consistent

**Title:** `intervention_required` is never set while a run is `active`

**Behavioral description:**
When a mission transitions to `intervention_required`, all associated runs MUST be in a non-active state (`paused`, `completing`, `completed`, `failed`, or `canceled`). Conversely, if any run is `active`, the mission status MUST NOT be `intervention_required`. The state machine MUST pause the active run before (or atomically with) the mission status transition.

**Pass condition:** After every call to `transitionMissionStatus(missionId, "intervention_required", ...)`, a subsequent query of `listRuns({ missionId })` returns zero runs with `status === "active"`.

**Fail condition:** A mission with `status === "intervention_required"` has at least one run with `status === "active"` or `status === "bootstrapping"`.

**Evidence requirements:**
1. Unit test: trigger `pauseMissionWithIntervention()` and verify the run is `paused` before the mission status is `intervention_required`.
2. Unit test: simulate a step failure that creates an intervention — assert that the run is paused.
3. Code review: confirm `pauseRunWithIntervention()` (aiOrchestratorService.ts ~5686) calls `orchestratorService.pauseRun()` before `missionService.addIntervention()` with `pauseMission: true`.

---

### VAL-STATE-002: Parent step status reflects spawned variant outcomes

**Title:** Parent step transitions to `failed` when all spawned variants fail

**Behavioral description:**
When a step spawns parallel variants (fan-out), the parent step's status MUST NOT remain `ready` after all variants have completed. If all variants fail, the parent step MUST be `failed`. If at least one variant succeeds, the parent step MUST be `succeeded`. The parent step should be `running` while variants are in progress.

**Pass condition:** After all variant attempts for a parent step reach a terminal state, the parent step's status is either `succeeded` (at least one variant passed) or `failed` (all variants failed) — never `ready` or `running`.

**Fail condition:** A parent step's status is `ready` or `running` when all its variant attempts are in a terminal status (`succeeded`, `failed`, `canceled`).

**Evidence requirements:**
1. Unit test: create a step with 3 variant attempts, fail all 3 — assert parent step status is `failed`.
2. Unit test: create a step with 3 variant attempts, succeed 1 and fail 2 — assert parent step status is `succeeded`.
3. Code review: confirm `completeAttempt()` checks remaining sibling attempts and transitions the parent step when the last variant completes.

---

## Area: Intervention Deduplication (runtime-fixes)

### VAL-INTV-001: At most one intervention per failed step per failure event

**Title:** Duplicate interventions are not created for a single failure

**Behavioral description:**
When a step fails, the system MUST create at most one intervention of type `failed_step`. If an open intervention already exists for the same step (matched by step ID in intervention metadata), no additional intervention is created. The historical behavior of creating 6 interventions for 3 failures (2x multiplier due to dual creation paths) MUST be eliminated.

**Pass condition:** After N distinct step failures (each a different step), exactly N interventions of type `failed_step` exist (one per step). Re-failing the same step does not create a second intervention if one is still open.

**Fail condition:** The count of `failed_step` interventions exceeds the count of distinct failed steps, or multiple open interventions exist for the same step.

**Evidence requirements:**
1. Unit test: fail 3 different steps in sequence — assert exactly 3 interventions are created.
2. Unit test: fail step A, then fail step A again (retry + re-fail) without resolving the first intervention — assert only 1 open intervention exists for step A.
3. Code review: confirm the intervention creation path in `missionService.ts` (~line 3335) and `aiOrchestratorService.ts` both check for existing open interventions before inserting.

---

### VAL-INTV-002: Intervention creation is idempotent within a failure event

**Title:** Concurrent failure handlers do not race to create duplicate interventions

**Behavioral description:**
Both `completeAttempt()` in `orchestratorService.ts` and the runtime event router can trigger intervention creation for the same failure. Only one path MUST actually insert the intervention. This should be enforced via a deduplication check (e.g., query for existing open intervention on the same step) or by consolidating to a single creation path.

**Pass condition:** Triggering the same failure event through both `completeAttempt` error handling and `routeEventToCoordinator` results in exactly 1 intervention row.

**Fail condition:** 2 interventions are created for a single failure event.

**Evidence requirements:**
1. Unit test: simulate a failure that triggers both code paths simultaneously — assert exactly 1 intervention.
2. Code review: identify all call sites that create `failed_step` interventions and confirm deduplication logic exists.

---

## Area: Steering & Resume (runtime-fixes)

### VAL-STEER-001: steerMission auto-resumes paused runs

**Title:** Steering a paused mission resumes the run after resolving interventions

**Behavioral description:**
When `steerMission()` is called on a mission whose status is `intervention_required` and whose run is `paused`, it MUST:
1. Resolve matching open `manual_input` interventions.
2. If all interventions are resolved, resume the paused run (transition from `paused` to `active`).
3. Transition the mission status back to `in_progress`.

Currently, `steerMission()` resolves interventions but does NOT call `orchestratorService.resumeRun()`, leaving runs stuck in `paused`.

**Pass condition:** After `steerMission({ missionId, directive: "continue" })` on a paused mission with one open `manual_input` intervention, the run status is `active` and the mission status is `in_progress`.

**Fail condition:** The run remains `paused` after steering resolves all open interventions.

**Evidence requirements:**
1. Unit test: create a mission + run, pause the run, add a `manual_input` intervention, call `steerMission()` — assert run status is `active`.
2. Code review: confirm `steerMission()` (~aiOrchestratorService.ts line 7400+) calls `orchestratorService.resumeRun()` after all interventions are resolved.
3. Integration test: verify `triggerCoordinatorEvaluation()` is called after resume so the coordinator picks up the unblocked state.

---

## Area: Worker Error Classification (runtime-fixes)

### VAL-ERR-001: Interrupted workers are not classified as startup_failure

**Title:** Workers that started but were interrupted get a distinct error class

**Behavioral description:**
`classifySilentWorkerExit()` currently returns `errorClass: "startup_failure"` for any worker that exits without a transcript summary and without material output. However, if a worker produced tool activity (e.g., file reads, edits) before being interrupted, it should be classified as `interrupted` or `executor_failure`, not `startup_failure`. The `startup_failure` class MUST be reserved for workers that never produced any assistant or tool activity.

**Pass condition:** A worker that executed at least one tool call before being terminated is classified with `errorClass: "interrupted"` or `"executor_failure"`, not `"startup_failure"`.

**Fail condition:** A worker with `hasMaterialOutput === true` or with tool activity in its transcript is classified as `startup_failure`.

**Evidence requirements:**
1. Unit test: call `classifySilentWorkerExit({ hasMaterialOutput: true, transcriptSummary: null, stepMetadata: {} })` — assert result is NOT `startup_failure`.
2. Unit test: call `classifySilentWorkerExit({ hasMaterialOutput: false, transcriptSummary: null, stepMetadata: {} })` — assert result IS `startup_failure` (correct case).
3. Code review: confirm `classifySilentWorkerExit()` (orchestratorService.ts ~547-572) differentiates between "never started" and "started but interrupted".

---

## Area: Budget Pause Consistency (runtime-fixes)

### VAL-BUDGET-001: Budget exceeded uses a single, consistent pause mechanism

**Title:** Token budget exceeded triggers the same pause flow as hard cap

**Behavioral description:**
Currently, two independent budget pause mechanisms exist:
1. **Token budget in `completeAttempt()`** (orchestratorService.ts ~6301-6317 and ~8022-8031): Directly calls `updateRunStatus(run.id, "paused")` and throws an error.
2. **Hard cap in `coordinatorTools.ts`** (~4806, ~5106): Calls `orchestratorService.pauseRun()` and triggers `onHardCapTriggered` which creates an intervention via `pauseMissionWithIntervention()`.

Both should produce identical observable effects: run paused + intervention created + timeline event emitted + mission set to `intervention_required`.

**Pass condition:** When the token budget is exceeded via `completeAttempt()`, the same downstream effects occur as when `onHardCapTriggered` fires: a `budget_limit_reached` intervention is created, the mission status is `intervention_required`, and a `mission_paused` timeline event is emitted.

**Fail condition:** Token budget exceeded only pauses the run without creating an intervention or transitioning the mission, leaving the user with no actionable intervention to resolve.

**Evidence requirements:**
1. Unit test: trigger token budget exceeded in `completeAttempt()` — assert an intervention of type `budget_limit_reached` is created.
2. Unit test: trigger hard cap in `spawn_worker` — assert identical intervention and timeline events.
3. Code review: confirm both paths converge on the same `pauseMissionWithIntervention()` helper or equivalent.

---

### VAL-BUDGET-002: Paused-for-budget runs are not auto-resumed by tick

**Title:** Run tick does not resume budget-paused runs

**Behavioral description:**
`tickRun()` (orchestratorService.ts ~5816) correctly skips paused runs. This assertion ensures that invariant is maintained: runs paused due to budget exceeded MUST only be resumed by explicit user action (steer or resume), never by an automatic tick or health sweep.

**Pass condition:** A run paused with `last_error` containing "budget exceeded" remains `paused` after 10 calls to `tickRun()`.

**Fail condition:** `tickRun()` changes the run status from `paused` to `active` for a budget-paused run.

**Evidence requirements:**
1. Unit test: pause a run with budget exceeded reason, call `tickRun()` 10 times — assert status is still `paused`.
2. Existing test in `orchestratorService.test.ts:3659` covers partial budget accumulation — extend it to verify tick doesn't resume.

---

## Area: Planning Artifacts (planning-and-handoffs)

### VAL-PLAN-001: Planning artifacts are written to `.ade/` not `~/.claude/plans/`

**Title:** Planner worker writes plans to project-local `.ade/` directory

**Behavioral description:**
The planner worker's sandbox and prompt MUST direct plan artifacts to `.ade/plans/` within the project/worktree root, not to `~/.claude/plans/`. Writes to `~/.claude/plans/` should be blocked by the sandbox policy and the prompt should not reference that path. The coordinator prompt already warns against ExitPlanMode (coordinatorAgent.ts ~1070), but the planner worker's own prompt must also redirect plan file writes.

**Pass condition:** Plan artifacts created by the planner worker appear under `<worktree>/.ade/plans/` or equivalent project-local path. No files are created under `~/.claude/plans/`.

**Fail condition:** Any plan file is written to `~/.claude/plans/` or the sandbox blocks the write with no fallback path provided.

**Evidence requirements:**
1. Unit test: verify `buildFullPrompt()` for a planning-type step includes an instruction to write plans to `.ade/plans/`.
2. Code review: confirm the sandbox configuration blocks writes outside the worktree (including `~/.claude/plans/`).
3. Integration test: run a planner worker and verify the output plan file exists under `.ade/plans/`.

---

### VAL-PLAN-002: ExitPlanMode is not triggered during mission planning

**Title:** Planning flow does not invoke ExitPlanMode tool

**Behavioral description:**
The coordinator prompt explicitly states (coordinatorAgent.ts ~1070): "Mission runs do NOT use provider-native approval prompts. Do not rely on ExitPlanMode or any out-of-band provider approval flow." The planner worker's prompt MUST also include this constraint. If the underlying Claude CLI invokes ExitPlanMode despite the instruction, the system MUST catch the Zod validation error and handle it gracefully (e.g., log and skip) rather than entering a retry loop.

**Pass condition:**
1. The planner worker prompt contains an instruction not to use ExitPlanMode.
2. If ExitPlanMode is triggered anyway, the error is caught and the worker continues or fails cleanly with a descriptive error — not an infinite Zod error loop.

**Fail condition:** A Zod validation error from ExitPlanMode causes repeated retries or a stuck worker.

**Evidence requirements:**
1. Unit test: simulate an ExitPlanMode tool call returning a Zod error — assert the error is caught and the attempt completes (either successfully with fallback or as a clean failure).
2. Code review: confirm the planner worker prompt includes "Do not use ExitPlanMode" instruction.
3. Code review: confirm error handling around tool execution does not retry Zod schema failures indefinitely.

---

### VAL-PLAN-003: Planner uses ask_user for clarification

**Title:** Planner has access to `ask_user` tool during planning phase

**Behavioral description:**
During the planning phase, the planner worker MUST have the `ask_user` tool available and should use it for clarifying questions rather than making assumptions. The coordinator's `ask_user` tool is already phase-gated (coordinatorTools.test.ts ~1021 confirms it's blocked outside planning), but the planner worker itself needs either direct access to `ask_user` via MCP or a prompt instruction to surface questions through its output.

**Pass condition:** A planner worker can invoke `ask_user` (or equivalent) during the planning phase, and the question is surfaced to the user as an intervention or chat message.

**Fail condition:** The planner worker has no mechanism to ask clarifying questions and must guess at ambiguous requirements.

**Evidence requirements:**
1. Unit test: verify the MCP allowed tools list for a planning-phase worker includes `ask_user`.
2. Code review: confirm `coordinatorTools.ts` allows `ask_user` when the current phase is planning.
3. Integration test: planner calls `ask_user`, verify an intervention or chat message is created.

---

## Area: Worker Handoff Data (planning-and-handoffs)

### VAL-HAND-001: Workers produce structured handoff data on completion

**Title:** Completed workers emit a structured digest with files changed, tests run, and summary

**Behavioral description:**
When a worker completes (attempt reaches terminal state), a structured `OrchestratorWorkerDigest` MUST be persisted containing:
- `filesChanged`: list of files modified
- `summary`: natural language summary of work done
- `testsRun` (optional): test pass/fail counts
- `warnings`: any concerns for downstream steps

This digest is used by `propagateHandoffContext()` (aiOrchestratorService.ts ~5253) to enrich downstream step metadata with `handoffSummaries`.

**Pass condition:** Every attempt that completes with `status === "succeeded"` has an associated worker digest row with a non-empty `summary` field and a `filesChanged` array.

**Fail condition:** A succeeded attempt has no worker digest, or the digest has an empty summary and empty filesChanged.

**Evidence requirements:**
1. Unit test: complete an attempt with a transcript containing file edits — assert a worker digest is persisted with correct `filesChanged`.
2. Unit test: verify `propagateHandoffContext()` reads the digest and writes `handoffSummaries` into downstream step metadata.
3. Code review: confirm the digest creation path in `completeAttempt()` extracts structured data from the transcript or checkpoint.

---

### VAL-HAND-002: Handoff summaries are injected into downstream worker prompts

**Title:** Downstream workers receive handoff context from completed upstream steps

**Behavioral description:**
When step B depends on step A, and step A completes with a worker digest, step B's assembled prompt (via `buildFullPrompt()`) MUST include the handoff summary from step A. This is achieved through `step.metadata.handoffSummaries` being populated by `propagateHandoffContext()`.

**Pass condition:** A step with upstream dependencies includes `"Handoff context:"` in its assembled prompt, with summaries from each completed upstream step.

**Fail condition:** A step with completed upstream dependencies has no handoff context in its prompt.

**Evidence requirements:**
1. Unit test: set `step.metadata.handoffSummaries = ["Step A completed: implemented auth module, changed 3 files"]` and call `buildFullPrompt()` — assert output contains the summary.
2. Existing code in `promptInspector.ts:318-322` already reads `handoffSummaries` — verify `buildFullPrompt()` does the same.
3. Integration test: run two dependent steps, verify step 2's prompt contains step 1's handoff summary.

---

## Area: Artifact Visibility (planning-and-handoffs)

### VAL-ART-001: Planning artifacts are registered as mission artifacts

**Title:** Plans produced by the planner appear in the mission's artifact list

**Behavioral description:**
When the planner worker produces a plan (written to `.ade/plans/` or reported via `report_result`), the system MUST register it as a mission artifact of type `plan` via `missionService.addArtifact()`. This ensures the plan is visible in the Evidence/Artifacts UI tab.

**Pass condition:** After a planning step completes successfully, `missionService.get(missionId).artifacts` contains at least one artifact with `artifactType === "plan"` and a valid `uri` pointing to the plan file.

**Fail condition:** The planning step completes but no artifact of type `plan` is registered, or the artifact URI points to a non-existent file.

**Evidence requirements:**
1. Unit test: simulate a planner completion that wrote a plan file — assert `addArtifact()` was called with `artifactType: "plan"`.
2. Code review: confirm the planner completion handler (in `aiOrchestratorService.ts` or `coordinatorTools.ts`) calls `missionService.addArtifact()`.
3. UI verification: after a mission with planning enabled completes, check the Artifacts tab shows the plan.

---

### VAL-ART-002: Worker checkpoints are accessible as artifacts

**Title:** Worker checkpoint files are registered and browsable

**Behavioral description:**
Worker checkpoint files (`.ade/checkpoints/<stepKey>.md`) written during execution SHOULD be registered as mission artifacts of type `checkpoint` so they appear in the Evidence/Artifacts UI. At minimum, the `getWorkerCheckpoint()` API must return the checkpoint content when queried.

**Pass condition:** `orchestratorService.getWorkerCheckpoint({ runId, stepKey })` returns checkpoint content for a step that wrote a checkpoint file. Optionally, the checkpoint also appears in `mission.artifacts`.

**Fail condition:** `getWorkerCheckpoint()` returns null for a step that wrote a `.ade/checkpoints/<stepKey>.md` file in its lane worktree.

**Evidence requirements:**
1. Unit test: write a checkpoint file to the lane worktree, call `getWorkerCheckpoint()` — assert it returns the content.
2. Code review: confirm `getWorkerCheckpointPath()` (orchestratorService.ts ~249) resolves to the correct lane worktree path (not `projectRoot`).
3. Code review: confirm the checkpoint read logic (orchestratorService.ts ~6781-6791) uses the lane's `worktree_path`.

---

## Summary Matrix

| ID | Area | Milestone | Severity | Verification Method |
|---|---|---|---|---|
| VAL-ISO-001 | Worktree Isolation | M1 | Critical | Unit test + Code review |
| VAL-ISO-002 | Worktree Isolation | M1 | High | Unit test |
| VAL-STATE-001 | State Coherence | M1 | Critical | Unit test + Code review |
| VAL-STATE-002 | State Coherence | M1 | High | Unit test |
| VAL-INTV-001 | Intervention Dedup | M1 | High | Unit test + Code review |
| VAL-INTV-002 | Intervention Dedup | M1 | Medium | Unit test + Code review |
| VAL-STEER-001 | Steering & Resume | M1 | Critical | Unit test + Code review |
| VAL-ERR-001 | Error Classification | M1 | Medium | Unit test + Code review |
| VAL-BUDGET-001 | Budget Consistency | M1 | High | Unit test + Code review |
| VAL-BUDGET-002 | Budget Consistency | M1 | Low | Unit test |
| VAL-PLAN-001 | Planning Artifacts | M2 | Critical | Unit test + Integration |
| VAL-PLAN-002 | Planning Flow | M2 | High | Unit test + Code review |
| VAL-PLAN-003 | Planning Flow | M2 | Medium | Unit test + Code review |
| VAL-HAND-001 | Worker Handoff | M2 | High | Unit test + Code review |
| VAL-HAND-002 | Worker Handoff | M2 | Medium | Unit test |
| VAL-ART-001 | Artifact Visibility | M2 | High | Unit test + Code review |
| VAL-ART-002 | Artifact Visibility | M2 | Medium | Unit test + Code review |
