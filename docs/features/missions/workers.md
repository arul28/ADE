# Mission Workers

Mission workers are transient, role-scoped agents spawned by the coordinator to execute specific phases of a mission. They are distinct from CTO "Team" workers (see `../cto/workers.md`) — Team workers are stable identities the operator configures; mission workers are ephemeral, spawned by `spawn_worker` with a role and a delegation contract that applies only to the current run.

## Source file map

- `apps/desktop/src/main/services/orchestrator/coordinatorTools.ts` — `spawn_worker` tool, `classifyPlannerLaunchFailure`.
- `apps/desktop/src/main/services/orchestrator/delegationContracts.ts` — `DelegationContract` type, scope helpers, handoff shape.
- `apps/desktop/src/main/services/orchestrator/orchestratorService.ts` — attempt lifecycle (`startAttempt`, `completeAttempt`, `failAttempt`, `cancelAttempt`), claims, fan-out parent/variant tracking.
- `apps/desktop/src/main/services/orchestrator/workerDeliveryService.ts` — message delivery between coordinator and worker, retry, in-flight leases.
- `apps/desktop/src/main/services/orchestrator/baseOrchestratorAdapter.ts` — `buildFullPrompt`, shell escaping.
- `apps/desktop/src/main/services/orchestrator/providerOrchestratorAdapter.ts` — provider-specific launchers (Claude CLI, Codex CLI, MCP).
- `apps/desktop/src/main/services/orchestrator/stepPolicyResolver.ts` — step policy, autopilot config, file-claim scope.
- `apps/desktop/src/main/services/orchestrator/teamRuntimeConfig.ts` / `teamRuntimeState.ts` — team manifest, per-run worker roster.
- `apps/desktop/src/main/services/orchestrator/permissionMapping.ts` — mission permission config -> provider-specific allowed tools.
- `apps/desktop/src/main/services/orchestrator/orchestratorConstants.ts` — `DEFAULT_ROLE_ISOLATION_RULES`, `DEFAULT_RECOVERY_LOOP_POLICY`, `DEFAULT_CONTEXT_VIEW_POLICIES`.
- `apps/desktop/src/main/services/orchestrator/workerTracking.ts` — tracked session state, heartbeats.
- `apps/desktop/src/main/services/orchestrator/recoveryService.ts` — recovery iteration policy.

## Worker roles

`OrchestratorWorkerRole` values:

- `planner` — runs during the planning phase; produces the execution DAG and plan artifacts.
- `implementation` — writes code inside the assigned lane worktree.
- `testing` — runs tests, captures results, produces test artifacts.
- `validation` — validates completion against the execution policy and gate reports.
- `code_review` — reviews implementation diffs (read-only).
- `test_review` — reviews test results and test diffs (read-only).
- `pr_review` — reviews PR readiness (read-only).
- `merge` — executes merges (controlled by `merge.mode`).

Role isolation rules (`DEFAULT_ROLE_ISOLATION_RULES`) enforce mutual exclusivity:

- `implementation` and `code_review` cannot share a worker (reviewers must not implement code they reviewed, and vice versa).
- `implementation` and `test_review` cannot share.
- `testing` and `test_review` cannot share (test authors must not review their own results).

`enforcement: "auto_correct"` means the runtime will refuse to assign both roles to the same worker and will route the second role to a distinct worker.

## Delegation contract

Each `spawn_worker` creates a `DelegationContract`:

- `scope` — what the worker can touch: file-path globs, lane id, step ids, read-only flag.
- `allowedTools` — provider-specific tool list, derived via `permissionMapping.ts` from `MissionProviderPermissions`.
- `handoff` — expected output shape: summary, artifacts, next-step hints, human-review requests.
- `failurePolicy` — retry budget, fallback model, escalation (auto-retry vs intervention).
- `role` — one of the roles above.

Contract helpers in `delegationContracts.ts`:

- `createDelegationContract` — produces the initial contract from a `spawn_worker` invocation.
- `createDelegationScope` — narrows the scope.
- `extractDelegationContract(metadata)` — reads a contract off a persisted attempt.
- `updateDelegationContract(contract, patch)` — merges a partial update.
- `extractActiveDelegationContracts(run)` — returns currently active contracts for the coordinator's "what's running" view.
- `derivePlanningStartupStateFromContract` — maps a planner contract into the coordinator's planning-startup state machine.
- `normalizeCoordinatorToolName` — canonicalizes tool names across providers (`mcp__ade__foo` vs `foo`).

## Attempt lifecycle

1. **Claim** — `orchestratorService.acquireClaim()` grabs file and path scopes. Overlapping claims refuse (`doFileClaimsOverlap`, `doesFileClaimMatchPath`).
2. **Start** — `startAttempt` writes the attempt row, starts tracking (`workerTracking.ts`), and launches the executor.
3. **Execute** — provider-specific launcher runs the worker (Claude CLI / Codex CLI / MCP). Messages flow through `workerDeliveryService`.
4. **Complete** — `completeAttempt(attemptId, result)` applies the handoff, releases claims, updates step status, and potentially transitions the parent step (for fan-out steps).
5. **Fail** — `failAttempt` classifies the error via `classifySilentWorkerExit` / `classifyPlannerLaunchFailure`, creates an intervention if needed (with dedup), and may trigger recovery.
6. **Cancel** — `cancelAttempt` cancels the tracked session and marks the attempt as cancelled without failing the step if other variants remain.

Attempt status lifecycle:

```
queued -> running -> (succeeded | failed | cancelled)
```

`OrchestratorAttemptResultEnvelope` is the typed shape of the result payload.

## Fan-out

A step can spawn multiple parallel `variant` attempts. The parent step stays `running` until all variants reach a terminal state. Then:

- At least one `succeeded` -> parent `succeeded`.
- All `failed` -> parent `failed`.
- Mixed fail/cancel with no success -> parent `failed`.

See `VAL-STATE-002` in the validation contract.

Variant attempt metadata carries a `variantGroupId` so `completeAttempt` can efficiently query sibling status. Fan-out is a core pattern for roles like `code_review` and `test_review` which can run N reviewers in parallel.

## Concurrency caps

The coordinator respects:

- `userRules.maxParallelWorkers` — per-mission cap.
- `userRules.allowParallelAgents` — kill switch for any parallelism.
- `userRules.allowSubAgents` — whether a worker can itself spawn sub-workers.
- `userRules.allowClaudeAgentTeams` — whether to use Claude's built-in sub-agent teams.

`adaptiveRuntime.classifyTaskComplexity` also scales parallelism based on mission complexity: `trivial` / `simple` run serially, `moderate` / `complex` parallelize.

## Provider launch paths

`providerOrchestratorAdapter.ts` supports:

- **Claude CLI** — `resolveClaudeCliModel`, spawns the Claude Code CLI binary with `--model`, `--append-system-prompt`, and a tailored tool allowlist.
- **Codex CLI** — `resolveCodexCliModel`, spawns the Codex CLI with a similar config.
- **MCP** — `resolveAdeMcpServerLaunch` launches the ADE MCP server so workers can call ADE operator tools over MCP. `cleanupMcpConfigFile` tears down the temp config.

Each launcher reads the `classifyWorkerExecutionPath(model)` classification from the model registry to decide between CLI and MCP.

## File-claim scope

Claims are the concurrency-safety mechanism:

- `normalizeRepoRelativePath` — resolves input paths relative to the repo root.
- `normalizeFileClaimScopeValue` — canonicalizes claim scope strings.
- `doesFileClaimMatchPath(claim, path)` — tests whether a claim covers a given path.
- `doFileClaimsOverlap(a, b)` — tests whether two claims overlap.

Overlapping claims are rejected at acquisition time — the second attempt to claim an overlapping scope receives a scoped failure and must either wait or fail. This is how the runtime prevents two workers from simultaneously editing overlapping files.

## Sandboxing and permissions

`permissionMapping.ts` maps `MissionProviderPermissions` (the mission's permission config) into provider-specific allowed-tool lists:

- Claude CLI — allowed-tools list plus working-dir constraints.
- Codex CLI — allowed tools plus sandbox mode.
- MCP — the in-process permission structure (`mapPermissionToInProcess`) used when workers call ADE tools over MCP.

`WorkerSandboxConfig` (in `shared/types`) controls sandbox mode, allowed network hosts, allowed file roots. Default is strict worktree-only writes.

## Worker tracking

`workerTracking.ts` keeps per-session state:

- session id, attempt id, tracked pid, started-at, last-event-at.
- active status: `active` / `stagnant` / `terminated`.
- stagnation detection: `WORKER_EVENT_HEARTBEAT_INTERVAL_MS` defines the expected activity cadence.

Stagnant workers surface to the coordinator so it can intervene (usually by sending a nudge via `send_message_to_worker` or by cancelling).

## Recovery

`RecoveryLoopPolicy` (default):

- `enabled: true`
- `maxIterations: 3`
- `onExhaustion: "intervention"` — escalate when retries are exhausted.
- `minConfidenceDelta: 0.1` — minimum progress between iterations to avoid stagnation.
- `escalateAfterStagnant: 2` — escalate after N stagnant iterations.

`recoveryService.getTrackedSessionState` reads per-session recovery progress so the coordinator can decide whether to retry, switch provider/model, or escalate to the user.

## Context views

`DEFAULT_CONTEXT_VIEW_POLICIES` defines what each role sees:

- `implementation` — full diff, scratch context, artifacts, handoff summaries, check results. Not read-only.
- `review` — artifacts + handoff summaries + full diff. Read-only.
- `test_review` — artifacts + handoff summaries + summary diff. Read-only.

Per-role context isolation keeps reviewers honest (they don't get to read the implementer's scratch notes).

## Handoff

On completion, a worker must produce a structured handoff (VAL-HAND-001). The coordinator injects relevant handoff summaries into downstream workers' prompts (VAL-HAND-002) via `buildFullPrompt`.

The handoff shape lives in `DelegationContract.handoff`. If the worker returns malformed handoff data, `completeAttempt` marks the attempt failed with `errorClass: "handoff_malformed"` instead of silently accepting partial output.

## Gotchas

- **Mission workers are not Team workers.** Don't conflate `OrchestratorWorkerRole` (phase-bound) with `AgentRole` (team identity).
- **Role isolation is auto-corrective.** The runtime will refuse to assign both roles to the same worker. Don't code around it by packing roles into one worker — split the attempts.
- **Fan-out parent transitions are delicate.** `completeAttempt` must query sibling attempts and transition the parent in one atomic step; races produce `VAL-STATE-002` regressions.
- **Claim scope normalization is the concurrency safety boundary.** Any path-normalization change needs to round-trip through `doFileClaimsOverlap` and the existing tests.
- **Sandbox escape via `WorkerSandboxConfig` is provider-specific.** Adding a new allowed-root requires testing against both Claude and Codex sandbox modes.
- **Handoff validation belongs at `completeAttempt`**, not at the coordinator level. Moving the check into the coordinator produces inconsistent behavior when workers crash without sending a completion message.

## Cross-links

- `README.md` — mission overview.
- `orchestration.md` — coordinator, delegation contracts, DAG model.
- `validation-gates.md` — VAL-ISO-*, VAL-STATE-*, VAL-HAND-* assertions that gate worker behavior.
- `../cto/workers.md` — the Team worker identity model (stable, configurable) that is different from mission workers.
