# Linear Workflow Presets

This document describes the workflow preset layer that translates the
user-facing "pipeline" representation in the CTO tab into a fully populated
`LinearWorkflowDefinition`, and vice versa.

Source file: `apps/desktop/src/shared/linearWorkflowPresets.ts` (420 lines).

## Why presets exist

`LinearWorkflowDefinition` is the on-disk / in-db shape of a Linear
workflow. It is expressive enough to model almost anything (arbitrary step
sequences, multi-stage targets, conditional review gates), but authoring it
by hand is painful. The presets layer provides two things:

1. **`createWorkflowPreset(targetType, options)`** — a canonical default
   workflow for each `LinearWorkflowTargetType`, used by the "New workflow"
   button in `LinearSyncPanel` and by tests.
2. **`deriveVisualPlan(workflow)` / `rebuildWorkflowSteps(workflow, plan)`**
   — a lossless round-trip between a workflow and the smaller "visual
   plan" surface used by the pipeline canvas. Editing happens against the
   visual plan; on save the steps are rebuilt while preserving any
   custom (non-visual-managed) steps the user added.

## Types exported

```ts
export type LinearWorkflowCompletionContract =
  | "complete_on_launch"
  | "wait_for_explicit_completion"
  | "wait_for_runtime_success"
  | "wait_for_pr_created"
  | "wait_for_review_ready";

export type LinearWorkflowSupervisorMode =
  | "none"
  | "after_work"
  | "before_pr"
  | "after_pr";

export type LinearWorkflowVisualPlan = {
  startState: string;
  completionContract: LinearWorkflowCompletionContract;
  prTiming: "none" | "after_start" | "after_target_complete";
  reviewReadyWhen: "work_complete" | "pr_created" | "pr_ready";
  supervisorMode: LinearWorkflowSupervisorMode;
  supervisorIdentityKey: string;
  rejectAction: LinearWorkflowReviewRejectionAction;
  notificationEnabled: boolean;
  notificationMilestone: NonNullable<LinearWorkflowStep["notifyOn"]>;
};
```

The visual plan is intentionally smaller than the full definition. It
captures the decisions a human actually wants to make in the UI
(when does the issue move to in-progress, how do we decide the run is
done, is there a review gate, does a PR gate the closeout) and leaves
everything else to defaults.

## Managed step types

The following steps are considered "visual managed" — they are owned by
`rebuildWorkflowSteps` and any edits the user makes to them in raw form
will be overwritten when the visual plan is saved:

```ts
const visualManagedStepTypes = new Set<LinearWorkflowStep["type"]>([
  "set_linear_state",
  "launch_target",
  "wait_for_target_status",
  "wait_for_pr",
  "request_human_review",
  "emit_app_notification",
  "complete_issue",
]);
```

Everything else (`comment_linear`, `set_linear_assignee`,
`apply_linear_label`, `attach_artifacts`, `reopen_issue`) is treated as a
**custom step** and preserved across a rebuild. `rebuildWorkflowSteps`
splices custom steps back into the sequence after the managed steps are
regenerated.

## Default completion contracts

```ts
export function defaultCompletionContract(targetType) {
  if (targetType === "mission") return "wait_for_runtime_success";
  if (targetType === "pr_resolution") return "wait_for_pr_created";
  if (targetType === "employee_session" || targetType === "worker_run") {
    return "wait_for_explicit_completion";
  }
  return "complete_on_launch"; // review_gate
}
```

The shape of the preset flows from this:

- **Mission**: starts → moves to In Progress → launches mission → waits for
  runtime success → optional review/notify → complete. No PR gate.
- **Employee session**: starts → In Progress → creates chat session →
  waits for explicit completion (chat ends or user marks done) → optional
  review/notify → complete.
- **Worker run**: same shape as employee session but dispatches through
  `workerAgentService`.
- **PR resolution**: starts → In Progress → launches target → waits for
  `wait_for_pr` → optional review → complete. `prTiming` defaults to
  `after_target_complete`.
- **Review gate**: starts → In Progress → creates review gate →
  `request_human_review` is the primary step → complete on approve or
  run through `rejectAction` on reject.

## Preset inputs

```ts
type WorkflowPresetOptions = {
  id?: string;
  name?: string;
  description?: string;
  source?: LinearWorkflowDefinition["source"];
  triggerLabels?: string[];
  triggerAssignees?: string[];
};
```

Defaults when options are omitted:

- `id` from `workflowIdForTargetType(targetType)`:
  - `mission` → `"assigned-mission-run"`
  - `employee_session` → `"assigned-employee-session"`
  - `worker_run` → `"assigned-worker-run"`
  - `pr_resolution` → `"assigned-pr-resolution"`
  - `review_gate` → `"assigned-review-gate"`
- `name` from `defaultWorkflowName(targetType)`. Examples:
  `"Assigned employee -> review handoff"`, `"Mission autopilot"`,
  `"Human review gate"`.
- `triggers.assignees` defaults to `["CTO"]`.
- `triggers.labels` defaults to `["workflow:default"]`.
- `closeout.successState = "in_review"`, `failureState = "blocked"`,
  `applyLabels = ["ade"]`, `resolveOnSuccess = true`,
  `reopenOnFailure = true`, `artifactMode = "links"`.
- `retry: { maxAttempts: 3, baseDelaySec: 30 }`.
- `concurrency: { maxActiveRuns: 5, perIssue: 1 }`.
- `observability: { emitNotifications: true, captureIssueSnapshot: true,
   persistTimeline: true }`.

## Round-trip: visual plan <-> workflow

### `deriveVisualPlan(workflow)`

Walks `workflow.steps` looking up managed step types and reconstructs the
visual plan:

```
startState = step("set_linear_state")?.state ?? ""
completionContract =
  step("wait_for_pr")
    ? (closeout.reviewReadyWhen === "pr_ready"
        ? "wait_for_review_ready"
        : "wait_for_pr_created")
    : waitStep.targetStatus === "runtime_completed"
      ? "wait_for_runtime_success"
      : waitStep.targetStatus === "explicit_completion"
        ? "wait_for_explicit_completion"
        : "complete_on_launch"
prTiming = target.prStrategy ? (target.prTiming ?? "after_target_complete") : "none"
reviewReadyWhen = derived from completionContract
supervisorMode = reviewStepPosition(workflow)  // none / after_work / before_pr / after_pr
supervisorIdentityKey = reviewStep.reviewerIdentityKey ?? humanReview.reviewers[0] ?? "cto"
rejectAction = reviewStep.rejectAction ?? (closeout.reopenOnFailure ? "reopen_issue" : "cancel")
notificationEnabled = Boolean(step("emit_app_notification"))
notificationMilestone = notificationStep.notifyOn ?? (pr-gated ? "review_ready" : "completed")
```

The review-step position is determined by comparing the `request_human_review`
step index against the `wait_for_pr` step index:

- Review before `wait_for_pr` → `"before_pr"`
- Review after `wait_for_pr` → `"after_pr"`
- No `wait_for_pr` step → `"after_work"`
- No review step → `"none"`

### `rebuildWorkflowSteps(workflow, planPatch)`

Merges `planPatch` into the current plan and reconstructs the step array:

1. Partition existing steps into managed and custom buckets.
2. Emit `set_linear_state` if `startState` is non-empty.
3. Emit `launch_target` (always).
4. For review gate targets, emit `request_human_review` immediately.
5. For non-review-gate targets, emit `wait_for_target_status` with the
   target status inferred from `completionContract` and `target.type`.
   Missions always use `runtime_completed`; employee/worker sessions
   default to `explicit_completion`.
6. If supervisor mode is `after_work` or `before_pr`, emit
   `request_human_review` here.
7. If the contract uses a PR gate (`wait_for_pr_created` or
   `wait_for_review_ready`), emit `wait_for_pr`.
8. If supervisor mode is `after_pr`, emit `request_human_review` after
   the PR gate.
9. Re-attach custom steps (preserved).
10. If notifications enabled, emit `emit_app_notification`.
11. Always emit `complete_issue` as the terminal step.

Target updates:

- If the workflow has a `prStrategy`, update `target.prTiming` from the
  plan; otherwise leave target alone.
- `closeout.reviewReadyWhen` is rewritten from the plan.
- `humanReview` is rewritten: `required: false` (keeping reviewers)
  when supervisorMode is `none`, otherwise `required: true` with
  `reviewers: [supervisorIdentityKey || "cto"]`.

## `createDefaultLinearWorkflowConfig()`

Returns the top-level `LinearWorkflowConfig` used on first run:

- `version: 1`
- `source: "generated"`
- `intake.activeStateTypes = ["backlog", "unstarted", "started"]`
- `intake.terminalStateTypes = ["completed", "canceled"]`
- `settings.ctoLinearAssigneeName = "CTO"`,
  `settings.ctoLinearAssigneeAliases = ["cto"]`
- `workflows = [createWorkflowPreset("pr_resolution")]`
- `files = []`
- `migration = { hasLegacyConfig: false, needsSave: true }`
- `legacyConfig = null`

First-time setup lands on a single PR resolution workflow so the
integration is immediately functional against a Linear label.

## Tests

`apps/desktop/src/shared/linearWorkflowPresets.test.ts` exercises:

- Each preset target type produces a valid workflow with the expected
  default step sequence.
- `deriveVisualPlan(createWorkflowPreset(...))` round-trips through
  `rebuildWorkflowSteps` without changing semantics.
- Custom steps (e.g. a `comment_linear` step a user added) survive a
  rebuild even when the managed sequence changes.
- Review-step position is correctly detected for all three supervisor
  modes.

## Gotchas

- **`rebuildWorkflowSteps` is not idempotent across step reordering.**
  If a user manually reordered managed steps in YAML, the rebuild will
  restore the canonical order. This is deliberate: the visual plan is
  the source of truth in the UI, and YAML-authored workflows that need
  non-canonical ordering should set `source: "repo"` and skip the
  pipeline builder.
- **Custom steps are appended late.** Steps like `comment_linear` or
  `attach_artifacts` go in after managed steps and before
  `emit_app_notification` and `complete_issue`. They cannot be
  interleaved between managed steps via the visual plan; they must be
  edited in YAML if ordering matters.
- **`supervisorIdentityKey` falls back to `"cto"`.** Clearing the
  supervisor in the UI does not delete the reviewer list; it just sets
  `humanReview.required = false` and keeps the existing reviewers. To
  remove a reviewer, edit the workflow JSON directly.
- **`reviewReadyWhen` is only used when the contract is PR-gated.**
  Non-PR contracts ignore it; the closeout check bases "review ready"
  on whatever terminal step finishes the run.
