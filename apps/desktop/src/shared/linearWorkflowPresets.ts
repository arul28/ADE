import type {
  AgentChatIdentityKey,
  LinearWorkflowConfig,
  LinearWorkflowDefinition,
  LinearWorkflowReviewRejectionAction,
  LinearWorkflowStep,
  LinearWorkflowTargetType,
} from "./types";

export type LinearWorkflowCompletionContract =
  | "complete_on_launch"
  | "wait_for_explicit_completion"
  | "wait_for_runtime_success"
  | "wait_for_pr_created"
  | "wait_for_review_ready";

export type LinearWorkflowSupervisorMode = "none" | "after_work" | "before_pr" | "after_pr";

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

const visualManagedStepTypes = new Set<LinearWorkflowStep["type"]>([
  "set_linear_state",
  "launch_target",
  "wait_for_target_status",
  "wait_for_pr",
  "request_human_review",
  "emit_app_notification",
  "complete_issue",
]);

function workflowIdForTargetType(targetType: LinearWorkflowTargetType): string {
  if (targetType === "employee_session") return "assigned-employee-session";
  if (targetType === "mission") return "assigned-mission-run";
  if (targetType === "worker_run") return "assigned-worker-run";
  if (targetType === "pr_resolution") return "assigned-pr-resolution";
  return "assigned-review-gate";
}

export function defaultWorkflowName(targetType: LinearWorkflowTargetType): string {
  if (targetType === "employee_session") return "Assigned employee -> review handoff";
  if (targetType === "mission") return "Mission autopilot";
  if (targetType === "worker_run") return "Worker run";
  if (targetType === "pr_resolution") return "PR resolution";
  return "Human review gate";
}

function defaultLaunchStep(targetType: LinearWorkflowTargetType): LinearWorkflowStep {
  return {
    id: "launch",
    type: "launch_target",
    name:
      targetType === "employee_session"
        ? "Launch delegated employee chat"
        : targetType === "review_gate"
          ? "Create review gate"
          : targetType === "pr_resolution"
            ? "Launch PR workflow"
            : targetType === "worker_run"
              ? "Launch worker run"
              : "Launch mission",
  };
}

function defaultReviewStep(): LinearWorkflowStep {
  return {
    id: "review",
    type: "request_human_review",
    name: "Supervisor review",
    reviewerIdentityKey: "cto",
    rejectAction: "loop_back",
    loopToStepId: "launch",
  };
}

function defaultNotificationStep(targetType: LinearWorkflowTargetType): LinearWorkflowStep {
  return {
    id: "notify",
    type: "emit_app_notification",
    name: "Notify in app",
    notificationTitle: targetType === "review_gate" ? "Workflow needs review" : "Workflow reached review-ready",
    message:
      targetType === "review_gate"
        ? "A Linear workflow is waiting on a human decision."
        : "The Linear workflow is ready for your review in ADE.",
    notifyOn: targetType === "review_gate" ? "delegated" : "review_ready",
  };
}

export function defaultCompletionContract(targetType: LinearWorkflowTargetType): LinearWorkflowCompletionContract {
  if (targetType === "mission") return "wait_for_runtime_success";
  if (targetType === "pr_resolution") return "wait_for_pr_created";
  if (targetType === "employee_session" || targetType === "worker_run") {
    return "wait_for_explicit_completion";
  }
  return "complete_on_launch";
}

export function completionContractUsesPrGate(contract: LinearWorkflowCompletionContract): boolean {
  return contract === "wait_for_pr_created" || contract === "wait_for_review_ready";
}

export function reviewReadyWhenForContract(
  contract: LinearWorkflowCompletionContract,
): LinearWorkflowVisualPlan["reviewReadyWhen"] {
  if (contract === "wait_for_review_ready") return "pr_ready";
  if (contract === "wait_for_pr_created") return "pr_created";
  return "work_complete";
}

export function resolveWorkflowTargetWaitStatus(
  workflow: LinearWorkflowDefinition,
  step?: LinearWorkflowStep,
): LinearWorkflowStep["targetStatus"] {
  if (!step || step.type !== "wait_for_target_status") return undefined;
  if (workflow.target.type === "mission") {
    return step.targetStatus ?? "runtime_completed";
  }
  if (!step.targetStatus || step.targetStatus === "completed") {
    return "explicit_completion";
  }
  return step.targetStatus;
}

type WorkflowPresetOptions = {
  id?: string;
  name?: string;
  description?: string;
  source?: LinearWorkflowDefinition["source"];
  triggerLabels?: string[];
  triggerAssignees?: string[];
};

export function createWorkflowPreset(
  targetType: LinearWorkflowTargetType,
  options: WorkflowPresetOptions = {},
): LinearWorkflowDefinition {
  const completionContract = defaultCompletionContract(targetType);
  const reviewReadyWhen = reviewReadyWhenForContract(completionContract);
  const wantsNotification = targetType !== "review_gate";
  const target: LinearWorkflowDefinition["target"] =
    targetType === "employee_session"
      ? {
          type: targetType,
          runMode: "assisted",
          sessionTemplate: "default",
          laneSelection: "fresh_issue_lane",
          sessionReuse: "fresh_session",
          prTiming: "none",
        }
      : targetType === "review_gate"
        ? {
            type: targetType,
            runMode: "manual",
          }
        : targetType === "pr_resolution"
          ? {
              type: targetType,
              runMode: "autopilot",
              workerSelector: { mode: "none" },
              prStrategy: { kind: "per-lane", draft: true },
              laneSelection: "fresh_issue_lane",
              prTiming: "after_target_complete",
            }
          : targetType === "mission"
            ? {
                type: targetType,
                runMode: "autopilot",
                missionTemplate: "default",
              }
            : {
                type: targetType,
                runMode: "autopilot",
                workerSelector: { mode: "none" },
                laneSelection: "fresh_issue_lane",
                prTiming: "none",
              };

  const steps: LinearWorkflowStep[] = [
    { id: "set-in-progress", type: "set_linear_state", name: "Move issue to In Progress", state: "in_progress" },
    defaultLaunchStep(targetType),
  ];

  if (targetType === "review_gate") {
    steps.push(defaultReviewStep());
  } else if (completionContractUsesPrGate(completionContract)) {
    if (targetType !== "pr_resolution") {
      steps.push({
        id: "wait",
        type: "wait_for_target_status",
        name: "Wait for delegated work",
        targetStatus: targetType === "mission" ? "runtime_completed" : "explicit_completion",
      });
    }
    steps.push({ id: "wait-pr", type: "wait_for_pr", name: "Wait for PR" });
  } else if (completionContract !== "complete_on_launch") {
    steps.push({
      id: "wait",
      type: "wait_for_target_status",
      name: "Wait for delegated work",
      targetStatus:
        completionContract === "wait_for_runtime_success"
          ? targetType === "mission"
            ? "runtime_completed"
            : "runtime_completed"
          : "explicit_completion",
    });
  }

  if (wantsNotification) {
    steps.push(defaultNotificationStep(targetType));
  }
  steps.push({ id: "complete", type: "complete_issue", name: "Mark workflow complete" });

  return {
    id: options.id ?? workflowIdForTargetType(targetType),
    name: options.name ?? defaultWorkflowName(targetType),
    enabled: true,
    priority: 100,
    description: options.description ?? "Starts only when the assigned employee and workflow label both match.",
    source: options.source ?? "generated",
    triggers: {
      assignees: options.triggerAssignees ?? ["CTO"],
      labels: options.triggerLabels ?? ["workflow:default"],
    },
    target,
    steps,
    closeout: {
      successState: "in_review",
      failureState: "blocked",
      applyLabels: ["ade"],
      resolveOnSuccess: true,
      reopenOnFailure: true,
      artifactMode: "links",
      reviewReadyWhen,
    },
    humanReview: targetType === "review_gate" ? { required: true, reviewers: ["cto"] } : undefined,
    retry: { maxAttempts: 3, baseDelaySec: 30 },
    concurrency: { maxActiveRuns: 5, perIssue: 1 },
    observability: { emitNotifications: true, captureIssueSnapshot: true, persistTimeline: true },
  };
}

export function createDefaultLinearWorkflowConfig(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "generated",
    settings: {
      ctoLinearAssigneeName: "CTO",
      ctoLinearAssigneeAliases: ["cto"],
    },
    workflows: [createWorkflowPreset("pr_resolution")],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: true },
    legacyConfig: null,
  };
}

function getStep(workflow: LinearWorkflowDefinition, type: LinearWorkflowStep["type"]): LinearWorkflowStep | undefined {
  return workflow.steps.find((step) => step.type === type);
}

function reviewStepPosition(workflow: LinearWorkflowDefinition): LinearWorkflowSupervisorMode {
  const reviewIndex = workflow.steps.findIndex((step) => step.type === "request_human_review");
  if (reviewIndex < 0) return "none";
  const waitPrIndex = workflow.steps.findIndex((step) => step.type === "wait_for_pr");
  if (waitPrIndex >= 0) {
    return reviewIndex > waitPrIndex ? "after_pr" : "before_pr";
  }
  return "after_work";
}

export function deriveVisualPlan(workflow: LinearWorkflowDefinition): LinearWorkflowVisualPlan {
  const notificationStep = getStep(workflow, "emit_app_notification");
  const reviewStep = getStep(workflow, "request_human_review");
  const waitTargetStep = getStep(workflow, "wait_for_target_status");
  const waitTargetStatus = resolveWorkflowTargetWaitStatus(workflow, waitTargetStep);
  const completionContract: LinearWorkflowCompletionContract = getStep(workflow, "wait_for_pr")
    ? (workflow.closeout?.reviewReadyWhen === "pr_ready" ? "wait_for_review_ready" : "wait_for_pr_created")
    : waitTargetStatus === "runtime_completed"
      ? "wait_for_runtime_success"
      : waitTargetStatus === "explicit_completion"
        ? "wait_for_explicit_completion"
        : "complete_on_launch";
  return {
    startState: getStep(workflow, "set_linear_state")?.state ?? "",
    completionContract,
    prTiming: workflow.target.prStrategy ? workflow.target.prTiming ?? "after_target_complete" : "none",
    reviewReadyWhen: reviewReadyWhenForContract(completionContract),
    supervisorMode: reviewStepPosition(workflow),
    supervisorIdentityKey: reviewStep?.reviewerIdentityKey ?? workflow.humanReview?.reviewers?.[0] ?? "cto",
    rejectAction: reviewStep?.rejectAction ?? (workflow.closeout?.reopenOnFailure ? "reopen_issue" : "cancel"),
    notificationEnabled: Boolean(notificationStep),
    notificationMilestone: notificationStep?.notifyOn ?? (completionContractUsesPrGate(completionContract) ? "review_ready" : "completed"),
  };
}

export function rebuildWorkflowSteps(
  workflow: LinearWorkflowDefinition,
  planPatch: Partial<LinearWorkflowVisualPlan>,
): LinearWorkflowDefinition {
  const currentPlan = deriveVisualPlan(workflow);
  const nextPlan = { ...currentPlan, ...planPatch };
  const customSteps = workflow.steps.filter((step) => !visualManagedStepTypes.has(step.type));
  const steps: LinearWorkflowStep[] = [];
  const reviewStep = {
    ...(getStep(workflow, "request_human_review") ?? defaultReviewStep()),
    reviewerIdentityKey: (nextPlan.supervisorIdentityKey || "cto") as AgentChatIdentityKey,
    rejectAction: nextPlan.rejectAction,
    loopToStepId: getStep(workflow, "launch_target")?.id ?? "launch",
  } satisfies LinearWorkflowStep;

  if (nextPlan.startState.trim()) {
    steps.push({
      ...(getStep(workflow, "set_linear_state") ?? { id: "set-in-progress", type: "set_linear_state", name: "Move issue" }),
      state: nextPlan.startState,
      name: nextPlan.startState === "in_progress" ? "Move issue to In Progress" : getStep(workflow, "set_linear_state")?.name ?? "Set Linear state",
    });
  }

  steps.push(getStep(workflow, "launch_target") ?? defaultLaunchStep(workflow.target.type));

  if (workflow.target.type === "review_gate") {
    steps.push(reviewStep);
  } else {
    const targetWaitStep = getStep(workflow, "wait_for_target_status") ?? {
      id: "wait",
      type: "wait_for_target_status",
      name: "Wait for delegated work",
      targetStatus: workflow.target.type === "mission" ? "runtime_completed" : "explicit_completion",
    };
    if (nextPlan.completionContract === "wait_for_runtime_success") {
      steps.push({
        ...targetWaitStep,
        targetStatus: "runtime_completed",
      });
    } else if (nextPlan.completionContract === "wait_for_explicit_completion") {
      steps.push({
        ...targetWaitStep,
        targetStatus: "explicit_completion",
      });
    } else if (
      completionContractUsesPrGate(nextPlan.completionContract)
      && nextPlan.prTiming === "after_target_complete"
      && workflow.target.type !== "pr_resolution"
    ) {
      steps.push({
        ...targetWaitStep,
        targetStatus: workflow.target.type === "mission" ? "runtime_completed" : "explicit_completion",
      });
    }
  }

  if (workflow.target.type !== "review_gate" && nextPlan.supervisorMode !== "none" && nextPlan.supervisorMode !== "after_pr") {
    steps.push(reviewStep);
  }

  if (completionContractUsesPrGate(nextPlan.completionContract)) {
    steps.push(getStep(workflow, "wait_for_pr") ?? { id: "wait-pr", type: "wait_for_pr", name: "Wait for PR" });
  }

  if (workflow.target.type !== "review_gate" && nextPlan.supervisorMode === "after_pr") {
    steps.push(reviewStep);
  }

  steps.push(...customSteps);

  if (nextPlan.notificationEnabled) {
    steps.push({
      ...(getStep(workflow, "emit_app_notification") ?? defaultNotificationStep(workflow.target.type)),
      notifyOn: nextPlan.notificationMilestone,
    });
  }

  steps.push(getStep(workflow, "complete_issue") ?? { id: "complete", type: "complete_issue", name: "Mark workflow complete" });

  return {
    ...workflow,
    target: workflow.target.prStrategy
      ? {
          ...workflow.target,
          prTiming: nextPlan.prTiming,
        }
      : {
          ...workflow.target,
        },
    steps,
    closeout: {
      ...(workflow.closeout ?? {}),
      reviewReadyWhen: reviewReadyWhenForContract(nextPlan.completionContract),
    },
    humanReview:
      nextPlan.supervisorMode === "none"
        ? workflow.humanReview
          ? {
              ...workflow.humanReview,
              required: false,
              reviewers: nextPlan.supervisorIdentityKey ? [nextPlan.supervisorIdentityKey] : workflow.humanReview.reviewers,
            }
          : undefined
        : {
            ...(workflow.humanReview ?? {}),
            required: true,
            reviewers: [nextPlan.supervisorIdentityKey || "cto"],
          },
  };
}
