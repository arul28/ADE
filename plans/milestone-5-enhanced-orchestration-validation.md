# Milestone 5 — Enhanced Orchestration: Validation Contract

> **Scope**: Adaptive execution, structured completion checks, enhanced shared knowledge,
> merge-conflict resolution as coordinator tools, auto-integration PR, agent-browser
> capability, artifact capture, and CTO integration.

---

## 5.1 Adaptive Execution Strategy

| ID | Title | Behavior / Pass Criteria | Evidence |
|----|-------|--------------------------|----------|
| VAL-ENH-001 | Task complexity classifier exists | A function classifies incoming tasks into one of `"trivial" \| "simple" \| "moderate" \| "complex"` (matches `FanOutDecision.subtasks[].complexity` in `orchestrator.ts`). Unit test covers all four buckets with representative inputs. | Unit test output; code inspection of classifier function |
| VAL-ENH-002 | Fan-out strategy scales with complexity | When the meta-reasoner returns `FanOutDecision.strategy`, the orchestrator spawns the correct number of workers: `inline` → 1 worker, `internal_parallel` / `external_parallel` → N workers matching `subtasks.length`, `hybrid` → mixed. Test verifies at least three scenarios. | Unit test; mock `FanOutDecision` objects fed to the dispatcher |
| VAL-ENH-003 | TeamComplexityAssessment drives parallelism | `TeamManifest.parallelismCap` is set proportionally to `TeamComplexityAssessment.estimatedScope`. `"small"` → cap ≤ 2, `"large"` / `"very_large"` → cap ≥ 4. | Unit test covering small, medium, large, very_large scopes |
| VAL-ENH-004 | Budget check gates high-parallelism spawns | `checkBudgetHardCaps()` is called before every `spawn_worker` / `delegate_parallel` invocation. If any cap is triggered, the spawn is blocked and no step is created. | Unit test mocking `getMissionBudgetStatus` with triggered caps |

## 5.2 Structured Completion Checks

| ID | Title | Behavior / Pass Criteria | Evidence |
|----|-------|--------------------------|----------|
| VAL-ENH-010 | `complete_mission` runs finalization gates | Calling `complete_mission` invokes `orchestratorService.finalizeRun()`. If `FinalizeRunResult.blockers` is non-empty, the tool returns `{ ok: false }` with the blocker list. | Unit test with mock orchestratorService returning blockers |
| VAL-ENH-011 | Closeout requirements enumerated | `MissionCloseoutRequirement[]` is populated on `MissionFinalizationState.requirements`. All keys from `MissionCloseoutRequirementKey` are checked (including `"screenshot"`, `"browser_verification"`, `"test_report"`, `"pr_url"`). Status is `"present"` / `"missing"` / `"incomplete"` / `"waived"` / `"blocked_by_capability"`. | Code inspection of finalization builder; unit test asserting requirement keys |
| VAL-ENH-012 | `RunCompletionValidation` blocks early close | If `RunCompletionValidation.canComplete === false`, the coordinator cannot transition the run to `"succeeded"`. Blocker codes include `"running_attempts"`, `"claimed_tasks"`, `"unresolved_interventions"`, `"validation_failed"`. | Unit test exercising each blocker code |
| VAL-ENH-013 | `CompletionDiagnostic` per phase | Each configured `PhaseCard` produces a `CompletionDiagnostic` entry. Codes include `"phase_required_missing"`, `"phase_in_progress"`, `"phase_failed"`, `"phase_succeeded"`. Diagnostic `blocking: true` prevents finalization. | Unit test with multi-phase mission verifying diagnostic array |
| VAL-ENH-014 | Active worker detection blocks completion | When `filterExecutionSteps` finds any step with `status === "running"`, `complete_mission` refuses with a message listing active workers. | Unit test with a graph containing running steps |

## 5.3 Enhanced Shared Knowledge

| ID | Title | Behavior / Pass Criteria | Evidence |
|----|-------|--------------------------|----------|
| VAL-ENH-020 | `addSharedFact` persists structured facts | Calling `unifiedMemoryService.addSharedFact({ runId, factType, content })` writes a row to `orchestrator_shared_facts`. Returned `SharedFact` has a valid UUID `id` and ISO `createdAt`. | Unit test with in-memory DB |
| VAL-ENH-021 | Shared facts support all types | `factType` supports `"api_pattern"`, `"schema_change"`, `"config"`, `"architectural"`, `"gotcha"`. Inserting each type and reading back via `getSharedFacts(runId)` returns all of them. | Unit test inserting 5 facts and asserting count + types |
| VAL-ENH-022 | Memory write-gate deduplicates facts | Inserting two memories with identical content (after normalization) into the same scope results in a single row with `observationCount ≥ 2` and `deduped: true` in the result. | Unit test calling `writeMemory` twice with same content |
| VAL-ENH-023 | Hybrid search retrieves relevant facts | `searchMemories(query, projectId)` returns memories whose content matches the query. Pinned memories (`tier: 1`) rank higher than unpinned ones. | Unit test inserting 3 memories with varying relevance and asserting ordering |
| VAL-ENH-024 | Structured topics partitioned by scope | `writeMemory` with `scope: "mission"` + `scopeOwnerId: missionId` isolates facts per mission. Querying a different `scopeOwnerId` returns no results. | Unit test with two distinct scopeOwnerIds |

## 5.4 Merge Conflict Resolution as Coordinator Tools

| ID | Title | Behavior / Pass Criteria | Evidence |
|----|-------|--------------------------|----------|
| VAL-ENH-030 | Conflict prediction runs per lane pair | `conflictService.runPrediction({ laneId })` produces a `BatchAssessmentResult` with `matrix` entries. Each entry has `riskLevel`, `overlapCount`, `hasConflict`. | Unit test with mock git commands returning overlapping files |
| VAL-ENH-031 | Merge simulation returns clean/conflict | `conflictService.simulateMerge({ laneAId, laneBId })` returns `MergeSimulationResult.outcome` as `"clean"` or `"conflict"`. On conflict, `conflictingFiles[]` is populated with paths. | Unit test with `runGitMergeTree` mocked for both outcomes |
| VAL-ENH-032 | External resolver session lifecycle | `prepareResolverSession → runExternalConflictResolver → commitExternalConflictResolverRun` lifecycle works end-to-end. Run records are persisted to `externalRunsRootDir` as JSON files with schema `"ade.conflictExternalRun.v1"`. | Integration-style test verifying file creation and status transitions |
| VAL-ENH-033 | Rebase-need detection | `conflictService.getRebaseNeeds()` (or equivalent) detects lanes that are behind base by checking `lane.status.behind > 0`. Result includes `RebaseNeed` entries. | Unit test with lane summaries containing `behind > 0` |
| VAL-ENH-034 | Conflict chips emitted on risk change | `buildChips(prevMatrix, nextMatrix)` produces `ConflictChip[]` with `kind: "new-overlap"` when a pair goes from 0 to >0 overlap, and `kind: "high-risk"` when risk escalates. | Unit test comparing two matrix snapshots |

## 5.5 Auto-Integration PR on Completion

| ID | Title | Behavior / Pass Criteria | Evidence |
|----|-------|--------------------------|----------|
| VAL-ENH-040 | `createIntegrationPr` merges source lanes | `prService.createIntegrationPr({ sourceLaneIds, baseBranch, title })` creates a child lane, merges source branches into it, and creates a GitHub PR. Returns `CreateIntegrationPrResult` with `integrationLaneId` and `pr`. | Unit test with mocked `githubService.apiRequest` and `laneService.createChild` |
| VAL-ENH-041 | Failed merge aborts and reports | When one source lane merge fails (mock `runGit` returning non-zero), `createIntegrationPr` throws with a message listing failed lanes. The integration lane is archived for cleanup. PR group is also cleaned up. | Unit test verifying cleanup behavior |
| VAL-ENH-042 | Queue PRs target same branch | `prService.createQueuePrs({ laneIds, targetBranch })` creates individual PRs all targeting the same base branch. `CreateQueuePrsResult.prs` has length matching input. | Unit test with 3 lanes |
| VAL-ENH-043 | Finalization policy drives PR creation | `MissionFinalizationPolicy.kind` of `"integration"` triggers integration-lane PR creation, `"per-lane"` triggers per-lane PRs, `"queue"` triggers queue-based landing. `"disabled"` / `"manual"` skips automatic PR creation. | Code inspection of finalization handler; unit test covering each `kind` |
| VAL-ENH-044 | Stack landing retargets and merges | `prService.landStack({ rootLaneId, method })` iterates the stack chain, retargets each PR to the same base branch, and merges sequentially. On failure, stops and returns partial results. | Unit test with 3-lane stack, second lane failing |

## 5.6 Agent-Browser as Configurable Capability

| ID | Title | Behavior / Pass Criteria | Evidence |
|----|-------|--------------------------|----------|
| VAL-ENH-050 | PhaseCard schema supports capabilities | `PhaseCard` type accepts an optional `capabilities` field (or equivalent in `metadata`). When `agent-browser` is listed, workers spawned for that phase receive the capability flag. | Type inspection; code review of phase card → worker spawn metadata path |
| VAL-ENH-051 | Closeout requirement `browser_verification` | `MissionCloseoutRequirementKey` includes `"browser_verification"` and `"browser_trace"`. When a phase card enables agent-browser but no browser artifact is captured, the requirement status is `"missing"` or `"blocked_by_capability"`. | Code inspection of closeout requirement builder |
| VAL-ENH-052 | Tool profile enables agent-browser | `RoleToolProfile.allowedTools` can include `"agent-browser"`. `resolveRoleToolProfile(teamRuntime, roleName)` returns the profile, and the spawned worker receives it in `metadata.toolProfile`. | Unit test with a `TeamRuntimeConfig` containing an agent-browser role |

## 5.7 Artifact Capture (Screenshots/Video)

| ID | Title | Behavior / Pass Criteria | Evidence |
|----|-------|--------------------------|----------|
| VAL-ENH-060 | `MissionArtifactType` supports media | `MissionArtifactType` includes `"summary"`, `"pr"`, `"link"`, `"note"`, `"patch"`. New types for `"screenshot"` and `"video"` should be added (or artifacts are stored via `OrchestratorArtifact` with `kind: "custom"` and metadata). | Type inspection |
| VAL-ENH-061 | Worker result report accepts artifacts | `WorkerResultReport.artifacts[]` entries can have `type: "screenshot"` or `type: "video"`, with `uri` pointing to the captured file. The `report_result` coordinator tool parses and persists these. | Code inspection of `report_result` tool handler |
| VAL-ENH-062 | Artifacts linked to mission | `OrchestratorArtifact` rows are queryable by `missionId` via `ListOrchestratorArtifactsArgs`. Each artifact has `kind`, `value`, `metadata`. | Unit test inserting an artifact and listing back |
| VAL-ENH-063 | Closeout checks artifact presence | When `MissionCloseoutRequirementKey` includes `"screenshot"`, the closeout builder checks if at least one `OrchestratorArtifact` with matching kind exists. Status is `"present"` if found, `"missing"` otherwise. | Unit test with/without screenshot artifacts |

## 5.8 CTO Integration

| ID | Title | Behavior / Pass Criteria | Evidence |
|----|-------|--------------------------|----------|
| VAL-ENH-070 | CTO core memory updatable | `ctoStateService.updateCoreMemory(patch)` accepts `CoreMemoryPatch` with fields `projectSummary`, `criticalConventions`, `userPreferences`, `activeFocus`, `notes`. The version increments on each call. | Unit test calling `updateCoreMemory` and checking `version` |
| VAL-ENH-071 | CTO reads retrospective data | `MissionRetrospective` includes `wins`, `failures`, `topPainPoints`, `patternsToCapture`. CTO session can read `latestRetrospective` from `MissionStateDocument`. | Code inspection; unit test asserting `MissionStateDocument.latestRetrospective` is populated after retrospective generation |
| VAL-ENH-072 | Session logs persisted to both DB and file | `ctoStateService.appendSessionLog(entry)` writes to both `cto_session_logs` table and `sessions.jsonl` file. Reconciliation on startup merges file-only and DB-only entries. | Unit test calling `appendSessionLog` then `getSessionLogs` verifying presence in both stores |
| VAL-ENH-073 | CTO reconstruction context includes patterns | `ctoStateService.buildReconstructionContext()` returns a string containing core memory sections, identity, and recent sessions. When `patternsToCapture` from retrospectives are promoted to core memory `notes`, they appear in the reconstruction context. | Unit test: promote a pattern, rebuild context, assert pattern substring |
| VAL-ENH-074 | Retrospective trends tracked | `OrchestratorRetrospectiveTrend` rows are inserted when a pain point's status changes across retrospectives. Fields include `painPointKey`, `status` (`"resolved"` / `"still_open"` / `"worsened"`), and `previousPainScore` / `currentPainScore`. | Code inspection of trend insertion logic; unit test with two retrospectives |
| VAL-ENH-075 | Pattern stats accumulate | `OrchestratorRetrospectivePatternStat` tracks `occurrenceCount`, `firstSeenRetrospectiveId`, `lastSeenRetrospectiveId`. When a pattern appears in multiple retrospectives, `occurrenceCount` increments and `promotedMemoryId` links to the promoted memory. | Unit test inserting two retrospectives with overlapping patterns |

---

## Cross-Area Flows

These assertions validate interactions that span multiple M5 features.

| ID | Title | Behavior / Pass Criteria | Evidence |
|----|-------|--------------------------|----------|
| VAL-ENH-100 | Adaptive strategy → conflict check → integration PR | A mission with `estimatedScope: "large"` spawns parallel workers on separate lanes. After all workers complete, `conflictService.runPrediction` detects overlapping files. If clean, `prService.createIntegrationPr` merges them into a single PR. If conflicting, the resolver session is triggered. | Integration test scenario with mock git/GitHub services |
| VAL-ENH-101 | Agent-browser artifact → closeout requirement | A phase card with agent-browser enabled spawns a worker that reports a screenshot artifact. On `complete_mission`, the closeout builder marks `"screenshot"` requirement as `"present"` and `"browser_verification"` as `"present"`. Without the artifact, they are `"missing"`. | Unit test toggling artifact presence |
| VAL-ENH-102 | Retrospective → CTO memory → next mission | After a mission completes, `MissionRetrospective.patternsToCapture` are promoted to `CtoCoreMemory.notes` via `ctoStateService.updateCoreMemory`. On the next mission, `buildReconstructionContext()` includes those patterns, informing the coordinator prompt. | Sequential unit test simulating two mission lifecycles |
| VAL-ENH-103 | Structured completion prevents premature close | A mission with phases `[planning, development, testing, validation]` cannot call `complete_mission` if the validation phase has no succeeded steps. `CompletionDiagnostic` with `code: "phase_required_missing"` and `blocking: true` is emitted. | Unit test with validation phase having zero terminal steps |
| VAL-ENH-104 | Shared fact from worker → memory search | A worker calls `addSharedFact({ runId, factType: "gotcha", content })`. A subsequent `searchMemories("gotcha topic")` returns the fact (or a promoted memory derived from it). | Unit test chaining `addSharedFact` and `searchMemories` |
| VAL-ENH-105 | Budget cap blocks parallel spawn cascade | With `fiveHourTriggered: true` on the budget snapshot, `delegate_parallel` (which internally calls `spawn_worker` per subtask) is blocked for every subtask. No steps are created. The coordinator receives a budget-exceeded error. | Unit test mocking budget snapshot with triggered cap |
| VAL-ENH-106 | Conflict resolution → rebase → PR update | When `conflictService.runPrediction` reports `status: "conflict"` for a lane, the coordinator triggers a rebase. After successful rebase, the lane's PR is refreshed via `prService.refreshOne`. The PR's `checksStatus` is updated. | Integration test with mocked git rebase + GitHub sync |

---

## Summary

| Area | Assertion Count |
|------|:-:|
| 5.1 Adaptive Execution Strategy | 4 |
| 5.2 Structured Completion Checks | 5 |
| 5.3 Enhanced Shared Knowledge | 5 |
| 5.4 Merge Conflict Resolution | 5 |
| 5.5 Auto-Integration PR | 5 |
| 5.6 Agent-Browser Capability | 3 |
| 5.7 Artifact Capture | 4 |
| 5.8 CTO Integration | 6 |
| Cross-Area Flows | 7 |
| **Total** | **44** |
