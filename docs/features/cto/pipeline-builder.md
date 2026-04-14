# Pipeline Builder (Linear Workflows)

The visual pipeline builder is the Workflows tab inside `/cto`. It edits `LinearWorkflowDefinition` records — the same records the backend dispatches. There is no separate "visual" format: what you see is what runs.

> This is the newest CTO surface. The stage-chain mapping between visual and backend representations is custom, the step reconstruction is lossy if you bypass `rebuildWorkflowSteps`, and most files in `pipeline/` have landed within the last few weeks. Treat changes here as fragile until we have more runtime coverage.

## Source file map

### Renderer (apps/desktop/src/renderer/components/cto/pipeline/)

- `PipelineCanvas.tsx` — top-level editor. Owns `selection` state (`trigger` / stage index / closeout / null), the add-stage popover, the save bar, and the header block (name, description, priority, active toggle, source badge, auto summary).
- `PipelineVisualization.tsx` — the horizontal pipeline. Renders `TriggerCard`, `StageCard[]` separated by `StageConnector` instances, and `CloseoutCard`. Below the cards it renders the step preview strip.
- `StageCard.tsx` — one stage. Shows target type, run mode, lane strategy, session reuse, PR behavior. Visual color from `STAGE_COLORS[stage.type]`.
- `TriggerCard.tsx` — left node. Builds a human sentence from the trigger groups via `buildTriggerSentence`.
- `CloseoutCard.tsx` — right node. Summarizes success/failure states, notification status.
- `StageConnector.tsx` — decorative connector between cards. Single source for "add stage" affordance between existing stages.
- `StageConfigPanel.tsx` — detail panel that renders below the pipeline once a node is selected. Dispatches to `TriggerConfig`, `ExecutionConfig`, `PlanConfig`, `CloseoutConfig`, `AdvancedConfig`.
- `WorkflowListSidebar.tsx` — left rail. Linear connection status, workflow list (priority-sorted), preset "Add from template" block, sync-now button, refresh button, new workflow button.
- `pipelineHelpers.ts` — `flattenTargetChain`, `rebuildTargetChain`, `countStages`, `getStageAt`, `insertStageAt`, `removeStageAt`, `updateStageAt`, `createDefaultStage`. Pure functions. All tests in `pipelineHelpers.test.ts`.
- `pipelineLabels.ts` — single-source-of-truth human-readable naming for every workflow field and enum value. `FIELD_LABELS`, `TARGET_TYPE_LABELS`, `RUN_MODE_LABELS`, `STAGE_COLORS`, `COMPLETION_CONTRACT_LABELS`, `SUPERVISOR_MODE_LABELS`, `REJECT_ACTION_LABELS`, `NOTIFY_ON_LABELS`, `LANE_SELECTION_LABELS`, `SESSION_REUSE_LABELS`, `STEP_TYPE_LABELS`, `PRESET_TEMPLATE_DESCRIPTIONS`, `enumLabel`, `enumDescription`, `fieldLabel`, `fieldDescription`, `generateWorkflowSummary`. Tier metadata (`essential` / `advanced` / `expert` / `hidden`) drives progressive disclosure.
- `config/TriggerConfig.tsx` — trigger group editor. Chip-input plus state transition editor.
- `config/ExecutionConfig.tsx` — per-stage execution fields (target type, run mode, identity, lane strategy, session reuse, worker selector, PR strategy, PR timing, templates).
- `config/PlanConfig.tsx` — `LinearWorkflowVisualPlan` fields: completion contract, supervisor mode, supervisor identity, reject action, notifications.
- `config/CloseoutConfig.tsx` — success state, failure state, proof attachment, cleanup.
- `config/AdvancedConfig.tsx` — expert-tier fields.
- `shared/VisualSelector.tsx` — pill-button picker used across the config panels.

### Shared

- `apps/desktop/src/shared/linearWorkflowPresets.ts` — core translation layer. Defines `LinearWorkflowVisualPlan`, `deriveVisualPlan`, `rebuildWorkflowSteps`, `defaultCompletionContract`, `reviewReadyWhenForContract`, `createWorkflowPreset`, `defaultWorkflowName`. Test coverage in `linearWorkflowPresets.test.ts`.
- `apps/desktop/src/shared/types/linearSync.ts` — `LinearWorkflowDefinition` and related types.

## Data model and the nesting gotcha

The backend stores a workflow target as a recursively nested chain: a target can have a `downstreamTarget` which itself can have a `downstreamTarget`, and so on. The visual builder shows this as a flat horizontal pipeline.

Translation happens in `pipelineHelpers.ts`:

- `flattenTargetChain(target)` walks `downstreamTarget` links and returns a flat `PipelineStage[]` where `PipelineStage = Omit<LinearWorkflowTarget, "downstreamTarget">`.
- `rebuildTargetChain(stages)` rebuilds the nested chain from the array (last stage first, no downstream; preceding stages attach the previous build as their downstream).
- `insertStageAt` / `removeStageAt` / `updateStageAt` operate on the flat array and rebuild.

Insertion at index 0 replaces the primary target and pushes everything down — this is intentional because the "primary" target in the backend is always the first stage. `removeStageAt` refuses to remove the only remaining stage.

`createDefaultStage(type)` provides sensible defaults for each of the five target types:

| Target type | Default runMode | Default lane | Default sessionReuse / PR |
| --- | --- | --- | --- |
| `employee_session` | `assisted` | `fresh_issue_lane` | `fresh_session`, `prTiming: "none"` |
| `worker_run` | `autopilot` | `fresh_issue_lane` | `prTiming: "none"` |
| `mission` | `autopilot` | n/a | `missionTemplate: "default"` |
| `pr_resolution` | `autopilot` | `fresh_issue_lane` | `prStrategy: per-lane+draft`, `prTiming: "after_target_complete"` |
| `review_gate` | `manual` | n/a | none |

## Visual plan -> steps

Workflow steps are a runtime concern — they describe the ordered runtime actions (`set_linear_state`, `launch_target`, `wait_for_target_status`, `wait_for_pr`, `request_human_review`, `emit_app_notification`, `complete_issue`). The visual plan is a higher-level summary the UI edits directly.

`LinearWorkflowVisualPlan` (in `linearWorkflowPresets.ts`) captures:

- `startState` — the Linear state to transition into when launching.
- `completionContract` — one of `complete_on_launch`, `wait_for_explicit_completion`, `wait_for_runtime_success`, `wait_for_pr_created`, `wait_for_review_ready`.
- `prTiming` — `none`, `after_start`, `after_target_complete`.
- `reviewReadyWhen` — `work_complete`, `pr_created`, `pr_ready`.
- `supervisorMode` — `none`, `after_work`, `before_pr`, `after_pr`.
- `supervisorIdentityKey` — an `AgentChatIdentityKey`.
- `rejectAction` — `loop_back`, `reopen_issue`, `cancel`.
- `notificationEnabled` + `notificationMilestone` — optional in-app notification.

`deriveVisualPlan(workflow)` reads the persisted steps and reconstructs the plan. `rebuildWorkflowSteps(workflow, patch)` takes a plan patch and rewrites the `workflow.steps` array from scratch using the managed step types (`visualManagedStepTypes` set in `linearWorkflowPresets.ts`). Steps outside that set are preserved verbatim — that lets expert YAML users add custom steps without having them deleted on every edit.

`generateWorkflowSummary(workflow)` is the autosummary rendered under the header. It's the source of truth that the CTO saw on the workflow list sidebar (`triggerSummary` in `WorkflowListSidebar.tsx`).

## Add-from-template flow

`WorkflowListSidebar.tsx` exposes five preset buttons (`PRESET_TEMPLATES`). Clicking one calls `onAddPreset(type)` which in the container delegates to `createWorkflowPreset(targetType, options)`. That preset builder assembles a consistent default:

1. pick `completionContract = defaultCompletionContract(targetType)`.
2. derive `reviewReadyWhen` and notification defaults.
3. build the primary target (no `downstreamTarget` by default).
4. synthesize the managed steps (`launch`, `wait_for_target_status`, optional review, optional notify) in order.
5. default closeout (success state, failure state).

Each target type picks a canonical id via `workflowIdForTargetType` (e.g. `assigned-employee-session`). That id is stable so repo YAML across clones references the same preset.

## Selection model

`PipelineSelection` in `PipelineVisualization.tsx`:

```
type PipelineSelection =
  | { kind: "trigger" }
  | { kind: "stage"; index: number }
  | { kind: "closeout" }
  | null;
```

`StageConfigPanel.tsx` reads that selection and dispatches to one of the config subcomponents. `null` collapses the config panel entirely.

## Triggers

All trigger groups are edited via chip inputs except state transitions. Populated groups are AND-ed at runtime; values inside a group are OR-ed. A `routing.watchOnly` toggle in `AdvancedConfig` turns the workflow into a match-only logger. Priorities are numeric; higher fires first when multiple workflows match the same issue.

## Progressive disclosure

Every field in `FIELD_LABELS` carries a `tier` (`essential`, `advanced`, `expert`, `hidden`). Config panels check the tier and collapse or stash advanced/expert blocks behind expanders so the default view stays scoped to essentials. This is the single control point for changing what shows by default — the fields don't gate rendering individually.

## Saving

`PipelineCanvas` holds a `workflow` prop that the parent owns. Every edit calls `onUpdateWorkflow(updater)` where `updater: (w) => w`. That lets the parent debounce, validate, and persist. The save bar calls `onSave()` which in the container reaches `flowPolicyService.updateWorkflow` via IPC. The source badge ("From repo YAML" or "Generated") is driven by `workflow.source` and the server uses that to decide whether to persist back to the on-disk YAML (via `linearWorkflowFileService`).

## Fragile areas and invariants to preserve

- **Don't edit `workflow.steps` directly** from the UI. Use `rebuildWorkflowSteps(workflow, patch)` so managed steps stay in sync and non-managed steps are preserved. Manual step edits are the most common way to drop the wait/review/notify sequencing.
- **Don't mutate `target.downstreamTarget` in place.** Use `insertStageAt` / `removeStageAt` / `updateStageAt` which rebuild the chain.
- **Stage 0 is primary.** Inserting at index 0 reassigns the primary target. Some call sites assume that and pass `afterIndex: -1` semantics via `handleAddStage`. If you change `insertStageAt` to accept negative indices, audit callers.
- **Preset ids are stable.** Don't rename them (`assigned-employee-session`, `assigned-mission-run`, etc.) — downstream repo YAML pins to them.
- **`STAGE_COLORS` keys must cover every target type.** Missing entries silently fall back to purple; add new types to both `STAGE_COLORS` and `TYPE_ICONS` in `StageCard.tsx`.
- **`visualManagedStepTypes` is the contract boundary.** Adding a new step type that should be rebuilt from the visual plan requires adding it to the set in `linearWorkflowPresets.ts` or it will be preserved-but-not-regenerated (often leading to stale steps after a plan change).
- **Tests in `pipelineHelpers.test.ts` and `linearWorkflowPresets.test.ts`** cover the translation invariants. Keep them green — they are the regression net for this surface.
- **PR strategy kind polymorphism.** `target.prStrategy` is a union (`{kind: "per-lane"}`, `{kind: "manual"}`, etc.). `StageCard.tsx` branches on `kind`; new kinds must update the card summary and the config panel.
- **Headless parity.** `apps/mcp-server/src/headlessLinearServices.ts` instantiates the same flow policy and dispatcher — any YAML schema change must pass through the headless code path as well, otherwise `ade mcp` diverges.

## Cross-links

- `README.md` — overall CTO architecture and the source file map that includes this surface.
- `linear-integration.md` — how these workflow definitions drive dispatcher, routing, and sync.
- `identity-and-memory.md` — `supervisorIdentityKey` ties into the same identity model used by CTO and worker chat sessions.
- `../missions/README.md` — `target.type === "mission"` dispatches through the mission runtime.
