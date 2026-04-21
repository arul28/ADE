# Guardrails

Automations publish effects — comments, PRs, Linear updates, external webhooks. Guardrails gate publishing so a low-confidence or unreviewed run doesn't write to external systems silently. This doc covers the review/verification path, confidence scoring, the queue that holds runs needing a human, and the permission/scope knobs that constrain what an automation can touch.

## Source file map

- `apps/desktop/src/main/services/automations/automationService.ts` — review queue, confidence scoring, verification gating, publish disposition, status mapping.
- `apps/desktop/src/main/services/automations/automationSecretService.ts` — secret policy (env-ref only, same as CTO workers).
- `apps/desktop/src/main/services/automations/automationPlannerService.ts` — rule validation before persistence.

## Guardrail structure on a rule

`AutomationRule.guardrails` (typed via `shared/types`):

- `confidenceThreshold: number` — 0..1. A run with computed confidence below this threshold lands in `verification-required` instead of publishing. Default baseline is ~0.65; raising the threshold tightens the gate.
- `maxDurationMin: number` — upper bound on run duration. Exceeded runs are cancelled with `status: "cancelled"`; baseline `10` minutes (used as the `Math.floor(... * 60_000)` cap).
- `requireHuman: boolean` — force human review regardless of confidence.
- Path/lane allowlists — constrain `built-in` shell and file actions to specific lane worktrees or subpaths. `validateAutomationCwd` + `resolvePathWithinRoot` enforce them at dispatch.
- `reviewProfile` — one of `quick` / `incremental` / `full` / `security` / `release-risk` / `cross-repo-contract`. Drives the confidence base:

  | Profile | Base confidence |
  | --- | --- |
  | quick | 0.58 |
  | incremental | 0.64 |
  | full | 0.73 |
  | security | 0.79 |
  | release-risk | 0.75 |
  | cross-repo-contract | 0.68 |

## Confidence computation

`computeConfidence(rule, procedureCount)` in `automationService.ts`:

```
base = baseByProfile[rule.reviewProfile]
contextBoost = min(0.12, rule.contextSources.length * 0.015)
procedureBoost = min(0.1, procedureCount * 0.03)
thresholdPenalty = max(0, (threshold - 0.65)) * 0.25
value = clamp(base + contextBoost + procedureBoost - thresholdPenalty, 0.2, 0.95)
```

Labels: `high` when `value >= 0.78`, `medium` when `value >= 0.52`, else `low`. Reason text is filled in based on retrieved procedures and context sources.

## Verification modes

`AutomationRule.verification`:

- `verifyBeforePublish: boolean` — when true, the run must pass a verification step before external effects are applied.
- `mode` — one of `intervention` (default), `dry-run`, or an implementation-specific mode.

When `mode === "dry-run"`, the provider is forced into plan-mode at dispatch:

```
claude: "plan" instead of the configured edit mode
codex: "plan" instead of the configured edit mode
opencode: "plan" instead of the configured edit mode
```

This path is used for "what would this rule do?" dry runs — nothing persists externally, but the logs capture the planned effects.

`requiresPublishGate(rule)` returns true when `verifyBeforePublish` is true and `mode !== "dry-run"`. Publish-gated runs set `verification_required = 1` on the run row and land in the review queue rather than executing their publish step.

## Queue statuses

`AutomationRunQueueStatus`:

- `pending-review` — waiting for a reviewer.
- `actionable-findings` — verification surfaced findings that need operator action.
- `verification-required` — gated before publish; requires human approval.
- `completed-clean` — ran, published, no follow-up needed.
- `ignored` — reviewer chose to ignore.
- `archived` — no longer active.

`normalizeQueueStatus` coerces incoming values; `classifyQueueStatus` (via `deriveQueueStatus` in the service) picks the correct status based on verification state + findings count.

## Run status

`AutomationRunStatus` values: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `paused`, `needs_review`.

Status mapping:

- `mapMissionStatus(status, verificationRequired)` — maps mission runtime status into run status. When `verificationRequired` is true and the mission would otherwise be `succeeded`, the run is `needs_review`.
- `mapWorkerStatus(status, verificationRequired)` — same pattern for worker-backed runs.

The key invariant: when a rule has `verifyBeforePublish`, completion surfaces as `needs_review` rather than `succeeded`, keeping the run in the queue until a human acts.

## Publish disposition

`AutomationRule.outputs.disposition`:

- `comment-only` — write a comment.
- `open-pr` — open a draft PR.
- `linear-comment` — Linear comment via CTO's Linear client.
- `in-app-notification` — desktop notification.
- `evidence-only` — record only; no external effects.

Publish is only allowed when:

1. The run's `verification_required` flag is cleared (either `verifyBeforePublish: false` or a reviewer approved).
2. The run's confidence meets `guardrails.confidenceThreshold`.
3. `guardrails.requireHuman` is not set, or a reviewer has approved.
4. The disposition-specific path is available (e.g. Linear credentials exist for `linear-comment`).

`PUBLISH_CAPABLE_TOOL_FAMILIES` (`github`, `linear`, `browser`, `external-cli`) is the set of families that can publish — built-in palettes like `repo`, `git`, `tests`, `memory`, `mission` cannot publish externally regardless of disposition.

## Human review

Review gating creates an intervention via the mission runtime (for `kind: "mission"`) or a queue entry (for `agent-session` and `built-in`). The operator:

- Approves -> run transitions to `succeeded`, publish proceeds.
- Rejects -> run transitions to `failed` or `cancelled` depending on the rejection reason.
- Asks for more proof -> run returns to `needs_review` with an operator note.

The queue dashboard surfaces the severity summary, suggested actions, and any procedure feedback (`AutomationProcedureFeedback`) so the reviewer can triage without opening each run.

## Secrets

`automationSecretService.ts` enforces the same env-ref policy as CTO worker adapters:

- Raw secret-like values at sensitive keys are rejected.
- Only `${env:VAR_NAME}` references are allowed.
- Resolution happens at dispatch time; missing env vars produce a clear runtime error rather than a silent fallback.

This applies to webhook secrets, relay access tokens, GitHub tokens used by built-in actions, and any adapter config.

## Scope and sandboxing

Built-in shell actions must stay within the allowed workdirs:

- `resolveAutomationCwdBase(projectRoot, laneService, laneId)` picks the lane worktree if `laneId` is set, else the project root.
- `validateAutomationCwd(baseCwd, cwdRaw)` resolves the requested cwd against the base and rejects anything outside.
- Paths are resolved with `resolvePathWithinRoot` which handles symlink-resolution and rejects traversal.

Mission-execution rules inherit the mission runtime's sandbox (`WorkerSandboxConfig`). Agent-session rules run inside the ADE chat service's permission model (per-session allowed tools).

## Budget caps

Shared with Missions via Settings > Usage. Automations also support rule-level caps:

- `guardrails.maxDurationMin` — duration cap.
- Billing codes (`billingCode`) flag spend so operators can slice usage by rule.
- `budgetCapService` enforces hard caps at the project level; breaches pause runs with an intervention.

## Audit trail

Every run writes:

- Run row with executor, status, queue status, confidence, spend, trigger metadata, verification flag.
- Action rows for each step with status and output.
- Ingress event row (for webhook/relay triggers) with raw payload.
- Mission artifacts (when `outputs.createArtifact` is true) for cross-surface indexing.
- Procedure feedback (`AutomationProcedureFeedback`) — operator ratings and notes that feed back into the procedural learning service.

## Gotchas

- **Confidence threshold is multiplicative, not additive.** Raising the threshold penalizes base confidence; the penalty formula is fixed at `(threshold - 0.65) * 0.25`. Document expected confidence in rule descriptions.
- **`verifyBeforePublish` does not imply `requireHuman`.** A verification run can auto-approve if a verification worker succeeds; human review is a separate opt-in.
- **`dry-run` mode forces provider plan-mode.** Don't assume a dry run touches real files even if the action config would normally edit.
- **`verification_required = 1` on the run row is sticky** until the review decision is applied. Changing it mid-run without triggering the correct status transition leaves the queue inconsistent.
- **Publish happens after verification, not before.** Don't add a publish call inside the action-runner loop without gating it through the queue.
- **Secrets validation is enforced at dispatch.** Missing env vars surface as run errors, not as silent skips — operators will see a clear failure in history.

## Cross-links

- `README.md` — rule structure, execution surfaces, memory.
- `triggers-and-actions.md` — trigger surface and built-in action catalog.
- `../cto/workers.md` — same env-ref secret policy.
- `../missions/README.md` — mission runtime enforces its own sandboxing for mission-execution automations.
