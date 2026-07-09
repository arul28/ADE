/**
 * The bridge between an `AutomationRuleDraft` and the flat list of workflow
 * steps the builder edits. This logic is intricate and load-bearing (solo-agent
 * collapse, laneMode strip, built-in chain assembly) — it is ported faithfully
 * from the previous RuleEditorPanel and only extended for the new `delete-lane`
 * cleanup step. Presentation lives elsewhere; this file is pure data.
 */

import type {
  AutomationAction,
  AutomationDraftAction,
  AutomationRuleDraft,
  ModelConfig,
} from "../../../../shared/types";
import type { AiPermissionSettings } from "../../../../shared/types";
import type { StepKind } from "../actionCatalog";
import {
  type LaneDeleteOptions,
  makeDeleteLaneAction,
  readAfterMinutes,
  readAlwaysRun,
  readLaneDeleteOptions,
} from "../localAutomationConfig";

export type AdeActionValue = {
  domain: string;
  action: string;
  args?: Record<string, unknown> | unknown[];
  resolvers?: Record<string, string>;
};

export type WorkflowStep = {
  kind: StepKind;
  // Shared runtime controls
  targetLaneId?: string | null;
  condition?: string;
  continueOnFailure?: boolean;
  timeoutMs?: number;
  retry?: number;
  /** "Always runs — even if earlier steps fail." Rendered on the step card. */
  alwaysRun?: boolean;
  // agent-session
  prompt?: string;
  sessionTitle?: string;
  modelConfig?: ModelConfig;
  fastMode?: boolean;
  permissionConfig?: AiPermissionSettings;
  // ade-action
  adeAction?: AdeActionValue;
  // run-tests
  suiteId?: string;
  // run-command
  command?: string;
  cwd?: string;
  // delete-lane
  afterMinutes?: number;
  laneDeleteOptions?: LaneDeleteOptions;
};

const REQUIRE_LANE_MODES = new Set(["require-on-trigger", "provided", "prompt-at-run"]);

export function readLaneMode(draft: AutomationRuleDraft): string {
  const raw = (draft.execution as { laneMode?: unknown } | undefined)?.laneMode;
  return typeof raw === "string" && raw.trim() ? raw.trim() : "reuse";
}

export function isRequireLaneMode(mode: string | null | undefined): boolean {
  return mode != null && REQUIRE_LANE_MODES.has(mode);
}

function actionRuntime(action: AutomationAction): Partial<WorkflowStep> {
  return {
    ...(action.targetLaneId ? { targetLaneId: action.targetLaneId } : {}),
    ...(action.condition ? { condition: action.condition } : {}),
    ...(typeof action.continueOnFailure === "boolean" ? { continueOnFailure: action.continueOnFailure } : {}),
    ...(Number.isFinite(action.timeoutMs) ? { timeoutMs: action.timeoutMs } : {}),
    ...(Number.isFinite(action.retry) ? { retry: action.retry } : {}),
    ...(readAlwaysRun(action) ? { alwaysRun: true } : {}),
  };
}

function stepRuntime(step: WorkflowStep): Partial<AutomationAction> {
  return {
    ...(step.targetLaneId ? { targetLaneId: step.targetLaneId } : {}),
    ...(step.condition?.trim() ? { condition: step.condition.trim() } : {}),
    ...(step.continueOnFailure ? { continueOnFailure: true } : {}),
    ...(step.alwaysRun ? { alwaysRun: true } : {}),
    ...(Number.isFinite(step.timeoutMs) ? { timeoutMs: step.timeoutMs } : {}),
    ...(Number.isFinite(step.retry) ? { retry: step.retry } : {}),
  };
}

function stepHasRuntimeOptions(step: WorkflowStep): boolean {
  return Boolean(
    step.targetLaneId
      || step.condition?.trim()
      || step.continueOnFailure
      || Number.isFinite(step.timeoutMs)
      || Number.isFinite(step.retry)
      || step.alwaysRun,
  );
}

/** Read a draft into an editable step list. */
export function draftToSteps(draft: AutomationRuleDraft): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  const execution = draft.execution;
  if (execution?.kind === "agent-session") {
    steps.push({
      kind: "agent-session",
      prompt: draft.prompt ?? "",
      sessionTitle: execution.session?.title ?? "",
      modelConfig: draft.modelConfig,
      fastMode: execution.session?.fastMode === true,
      permissionConfig: draft.permissionConfig,
    });
  } else if (execution?.kind === "built-in") {
    for (const action of execution.builtIn?.actions ?? []) {
      const step = actionToStep(action);
      if (step) steps.push(step);
    }
  }
  return steps;
}

function actionToStep(action: AutomationAction): WorkflowStep | null {
  const runtime = actionRuntime(action);
  switch (action.type) {
    case "create-lane":
      // Lane creation is an Execution setting now; legacy create-lane actions are
      // migrated server-side. Drop them from the editable stack.
      return null;
    case "lane-setup":
      return null;
    case "run-tests":
      return { kind: "run-tests", suiteId: action.suiteId ?? "", ...runtime };
    case "run-command":
      return { kind: "run-command", command: action.command ?? "", cwd: action.cwd ?? "", ...runtime };
    case "predict-conflicts":
      return { kind: "predict-conflicts", ...runtime };
    case "ade-action":
      return { kind: "ade-action", adeAction: action.adeAction ?? { domain: "", action: "" }, ...runtime };
    case "agent-session":
      return {
        kind: "agent-session",
        prompt: action.prompt ?? "",
        sessionTitle: action.sessionTitle ?? "",
        modelConfig: action.modelConfig,
        fastMode: action.fastMode === true,
        permissionConfig: action.permissionConfig,
        ...runtime,
      };
    case "delete-lane":
      return {
        kind: "delete-lane",
        afterMinutes: readAfterMinutes(action),
        laneDeleteOptions: readLaneDeleteOptions(action),
        ...runtime,
      };
    default:
      return null;
  }
}

/**
 * Map a runtime `AutomationAction` to the deprecated draft-union mirror the
 * planner/normalizer reads (`draft.actions`). Field names mostly match; the
 * exception is run-tests (`suiteId` → `suite`). Lane-setup / create-lane have no
 * draft form.
 */
export function actionToDraftAction(action: AutomationAction): AutomationDraftAction | null {
  const base = {
    ...(action.targetLaneId ? { targetLaneId: action.targetLaneId } : {}),
    ...(action.condition ? { condition: action.condition } : {}),
    ...(typeof action.continueOnFailure === "boolean" ? { continueOnFailure: action.continueOnFailure } : {}),
    ...(action.alwaysRun ? { alwaysRun: true } : {}),
    ...(Number.isFinite(action.timeoutMs) ? { timeoutMs: action.timeoutMs } : {}),
    ...(Number.isFinite(action.retry) ? { retry: action.retry } : {}),
  };
  switch (action.type) {
    case "create-lane":
    case "lane-setup":
      return null;
    case "run-tests":
      return { ...base, type: "run-tests", suite: action.suiteId ?? "" };
    case "run-command":
      return { ...base, type: "run-command", command: action.command ?? "", ...(action.cwd ? { cwd: action.cwd } : {}) };
    case "predict-conflicts":
      return { ...base, type: "predict-conflicts" };
    case "ade-action":
      return { ...base, type: "ade-action", adeAction: action.adeAction ?? { domain: "", action: "" } };
    case "agent-session":
      return {
        ...base,
        type: "agent-session",
        ...(action.prompt ? { prompt: action.prompt } : {}),
        ...(action.sessionTitle ? { sessionTitle: action.sessionTitle } : {}),
        ...(action.modelConfig ? { modelConfig: action.modelConfig } : {}),
        ...(action.fastMode === true ? { fastMode: true } : {}),
        ...(action.permissionConfig ? { permissionConfig: action.permissionConfig } : {}),
      };
    case "delete-lane":
      return {
        ...base,
        type: "delete-lane",
        ...(action.laneDeleteOptions ? { laneDeleteOptions: action.laneDeleteOptions } : {}),
        ...(Number.isFinite(action.afterMinutes) ? { afterMinutes: action.afterMinutes } : {}),
      };
  }
}

function stepToAction(step: WorkflowStep): AutomationAction {
  const runtime = stepRuntime(step);
  const alwaysRun = step.alwaysRun ? { alwaysRun: true } : {};
  switch (step.kind) {
    case "run-tests":
      return { type: "run-tests", ...runtime, suiteId: step.suiteId ?? "" } as AutomationAction;
    case "run-command":
      return {
        type: "run-command",
        ...runtime,
        command: step.command ?? "",
        ...(step.cwd ? { cwd: step.cwd } : {}),
      } as AutomationAction;
    case "predict-conflicts":
      return { type: "predict-conflicts", ...runtime } as AutomationAction;
    case "ade-action":
      return {
        type: "ade-action",
        ...runtime,
        adeAction: step.adeAction ?? { domain: "", action: "" },
      } as AutomationAction;
    case "agent-session":
      return {
        type: "agent-session",
        ...runtime,
        ...(step.modelConfig ? { modelConfig: step.modelConfig } : {}),
        ...(step.fastMode === true ? { fastMode: true } : {}),
        ...(step.permissionConfig ? { permissionConfig: step.permissionConfig } : {}),
        ...(step.prompt ? { prompt: step.prompt } : {}),
        ...(step.sessionTitle ? { sessionTitle: step.sessionTitle } : {}),
      } as AutomationAction;
    case "delete-lane":
      return {
        ...makeDeleteLaneAction({
          laneDeleteOptions: step.laneDeleteOptions,
          afterMinutes: step.afterMinutes,
          alwaysRun: step.alwaysRun,
        }),
        ...runtime,
        ...alwaysRun,
      } as AutomationAction;
  }
}

function stripStepTargetLane(step: WorkflowStep): WorkflowStep {
  const { targetLaneId: _drop, ...rest } = step;
  return rest;
}

/** Fold an edited step list back into a draft. */
export function applyStepsToDraft(draft: AutomationRuleDraft, steps: WorkflowStep[]): AutomationRuleDraft {
  const stepsForSave = isRequireLaneMode(readLaneMode(draft)) ? steps.map(stripStepTargetLane) : steps;

  const soloAgent =
    stepsForSave.length === 1
    && stepsForSave[0]!.kind === "agent-session"
    && !stepHasRuntimeOptions(stepsForSave[0]!);

  if (soloAgent) {
    const first = stepsForSave[0]!;
    const previousSession = draft.execution?.kind === "agent-session" ? draft.execution.session ?? {} : {};
    const sessionWithoutFast = { ...previousSession };
    delete sessionWithoutFast.fastMode;
    return {
      ...draft,
      execution: {
        ...(draft.execution ?? { kind: "agent-session" }),
        kind: "agent-session",
        session: {
          ...sessionWithoutFast,
          title: first.sessionTitle || null,
          ...(first.fastMode === true ? { fastMode: true } : {}),
        },
      },
      ...(first.modelConfig ? { modelConfig: first.modelConfig } : {}),
      ...(first.permissionConfig ? { permissionConfig: first.permissionConfig } : {}),
      prompt: first.prompt ?? "",
      actions: [],
      legacyActions: [],
    };
  }

  const builtInActions = stepsForSave.map(stepToAction);
  // The normalizer builds the built-in chain from draft.actions (the draft-union
  // mirror), so it must carry draft-union field names (e.g. run-tests `suite`).
  const draftActions = builtInActions
    .map(actionToDraftAction)
    .filter((action): action is AutomationDraftAction => action != null);

  return {
    ...draft,
    execution: {
      ...(draft.execution ?? { kind: "built-in" }),
      kind: "built-in",
      builtIn: { actions: builtInActions },
    },
    prompt: "",
    actions: draftActions,
    legacyActions: draftActions,
  };
}

/** A blank step of a given kind, with sensible defaults. */
export function blankStep(kind: StepKind, defaultSuiteId?: string): WorkflowStep {
  switch (kind) {
    case "agent-session":
      return { kind, prompt: "", sessionTitle: "" };
    case "ade-action":
      return { kind, adeAction: { domain: "", action: "" } };
    case "run-tests":
      return { kind, suiteId: defaultSuiteId ?? "" };
    case "run-command":
      return { kind, command: "", cwd: "" };
    case "predict-conflicts":
      return { kind };
    case "delete-lane":
      return { kind, alwaysRun: true, laneDeleteOptions: { deleteBranch: true, deleteRemoteBranch: false } };
  }
}
