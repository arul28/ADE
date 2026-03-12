import type {
  LinearPriorityLabel,
  LinearRouteDecision,
  LinearWorkflowConfig,
  LinearWorkflowDefinition,
  LinearWorkflowMatchCandidate,
  LinearWorkflowStep,
  NormalizedLinearIssue,
} from "../../../shared/types";
import type { FlowPolicyService } from "./flowPolicyService";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function describeStep(step: LinearWorkflowStep): string {
  switch (step.type) {
    case "launch_target":
      return "Launch the configured execution target";
    case "wait_for_target_status":
      return "Wait for the target to finish";
    case "wait_for_pr":
      return "Wait for a PR outcome";
    case "comment_linear":
      return `Comment in Linear${step.comment ? `: ${step.comment}` : ""}`;
    case "set_linear_state":
      return `Move the Linear issue to ${step.state ?? "a mapped state"}`;
    case "set_linear_assignee":
      return "Set the Linear assignee";
    case "apply_linear_label":
      return `Apply the '${step.label ?? "configured"}' label`;
    case "attach_artifacts":
      return "Attach workflow artifacts";
    case "request_human_review":
      return "Pause for human review";
    case "complete_issue":
      return "Complete the issue";
    case "reopen_issue":
      return "Reopen the issue";
    case "emit_app_notification":
      return `Emit an app notification${step.notificationTitle ? `: ${step.notificationTitle}` : ""}`;
    default:
      return step.name ?? step.type;
  }
}

function matchesAssignee(policy: LinearWorkflowConfig, issue: NormalizedLinearIssue, values: string[]): string[] {
  if (!values.length) return [];
  const aliases = new Set<string>(
    [
      policy.settings.ctoLinearAssigneeId ?? "",
      policy.settings.ctoLinearAssigneeName ?? "",
      ...(policy.settings.ctoLinearAssigneeAliases ?? []),
      "cto",
    ]
      .map(normalizeText)
      .filter(Boolean)
  );
  const issueValues = new Set(
    [issue.assigneeId, issue.assigneeName]
      .map(normalizeText)
      .filter(Boolean)
  );

  const matched = values.some((value) => {
    const normalized = normalizeText(value);
    if (!normalized) return false;
    if (aliases.has(normalized)) {
      for (const issueValue of issueValues) {
        if (aliases.has(issueValue)) return true;
      }
      return false;
    }
    return issueValues.has(normalized);
  });

  return matched ? [`Assignee matched ${values.join(", ")}`] : [];
}

function matchesStringField(actualValues: Array<string | null | undefined>, wanted: string[], label: string): string[] {
  if (!wanted.length) return [];
  const actual = new Set(actualValues.map(normalizeText).filter(Boolean));
  const matched = wanted.some((entry) => actual.has(normalizeText(entry)));
  return matched ? [`${label} matched ${wanted.join(", ")}`] : [];
}

function matchesPriority(priority: LinearPriorityLabel, wanted: LinearPriorityLabel[]): string[] {
  if (!wanted.length) return [];
  return wanted.includes(priority) ? [`Priority matched ${priority}`] : [];
}

function matchesStateTransition(issue: NormalizedLinearIssue, transitions: NonNullable<LinearWorkflowDefinition["triggers"]["stateTransitions"]>): string[] {
  if (!transitions.length) return [];
  const fromValues = [issue.previousStateId, issue.previousStateName, issue.previousStateType].map(normalizeText).filter(Boolean);
  const toValues = [issue.stateId, issue.stateName, issue.stateType].map(normalizeText).filter(Boolean);

  const matched = transitions.some((transition) => {
    const toMatched = (transition.to ?? []).some((value) => toValues.includes(normalizeText(value)));
    if (!toMatched) return false;
    if (!transition.from?.length) return true;
    return transition.from.some((value) => fromValues.includes(normalizeText(value)));
  });

  return matched ? ["State transition matched"] : [];
}

function evaluateWorkflow(policy: LinearWorkflowConfig, workflow: LinearWorkflowDefinition, issue: NormalizedLinearIssue): LinearWorkflowMatchCandidate {
  const reasons: string[] = [];
  const matchedSignals: string[] = [];
  let matched = true;

  const checks = [
    matchesAssignee(policy, issue, workflow.triggers.assignees ?? []),
    matchesStringField(issue.labels, workflow.triggers.labels ?? [], "Label"),
    matchesStringField([issue.projectSlug], workflow.triggers.projectSlugs ?? [], "Project"),
    matchesStringField([issue.teamKey], workflow.triggers.teamKeys ?? [], "Team"),
    matchesPriority(issue.priorityLabel, workflow.triggers.priority ?? []),
    matchesStateTransition(issue, workflow.triggers.stateTransitions ?? []),
    matchesStringField([issue.ownerId], workflow.triggers.owner ?? [], "Owner"),
    matchesStringField([issue.creatorId, issue.creatorName], workflow.triggers.creator ?? [], "Creator"),
    matchesStringField(issue.metadataTags ?? [], workflow.triggers.metadataTags ?? [], "Metadata tag"),
  ];

  const triggerGroups = [
    workflow.triggers.assignees ?? [],
    workflow.triggers.labels ?? [],
    workflow.triggers.projectSlugs ?? [],
    workflow.triggers.teamKeys ?? [],
    workflow.triggers.priority ?? [],
    workflow.triggers.stateTransitions ?? [],
    workflow.triggers.owner ?? [],
    workflow.triggers.creator ?? [],
    workflow.triggers.metadataTags ?? [],
  ];

  checks.forEach((result, index) => {
    if (!triggerGroups[index]?.length) return;
    if (!result.length) matched = false;
    if (result.length) {
      reasons.push(...result);
      matchedSignals.push(...result);
    } else {
      reasons.push(`Missing ${["assignee", "label", "project", "team", "priority", "state transition", "owner", "creator", "metadata tag"][index]}`);
    }
  });

  if (!workflow.enabled) {
    matched = false;
    reasons.unshift("Workflow is disabled");
  }

  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    priority: workflow.priority,
    matched,
    reasons,
    matchedSignals,
  };
}

export function createLinearRoutingService(args: {
  flowPolicyService: FlowPolicyService;
}) {
  const routeIssue = async (input: {
    issue: NormalizedLinearIssue;
    policy?: LinearWorkflowConfig;
  }): Promise<LinearRouteDecision> => {
    const policy = args.flowPolicyService.normalizePolicy(input.policy ?? args.flowPolicyService.getPolicy());
    const candidates = policy.workflows.map((workflow) => evaluateWorkflow(policy, workflow, input.issue));
    const winnerCandidate = candidates
      .filter((candidate) => candidate.matched)
      .sort((left, right) => right.priority - left.priority || left.workflowName.localeCompare(right.workflowName))[0] ?? null;
    const workflow = winnerCandidate
      ? policy.workflows.find((entry) => entry.id === winnerCandidate.workflowId) ?? null
      : null;

    return {
      workflowId: workflow?.id ?? null,
      workflowName: workflow?.name ?? null,
      workflow,
      target: workflow?.target ?? null,
      reason: workflow
        ? `Selected '${workflow.name}' because it was the highest-priority matching workflow.`
        : "No workflow matched the current issue snapshot.",
      candidates,
      nextStepsPreview: workflow ? workflow.steps.map(describeStep) : [],
    };
  };

  return {
    routeIssue,
    simulateRoute: routeIssue,
  };
}

export type LinearRoutingService = ReturnType<typeof createLinearRoutingService>;
