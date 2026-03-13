import React, { useCallback, useEffect, useMemo, useState } from "react";
import YAML from "yaml";
import { ArrowClockwise, FloppyDisk, Lightning, Plus, Shuffle } from "@phosphor-icons/react";
import type {
  AgentIdentity,
  CtoFlowPolicyRevision,
  LinearConnectionStatus,
  LinearIngressEventRecord,
  LinearIngressStatus,
  LinearPriorityLabel,
  LinearRouteDecision,
  LinearSyncDashboard,
  LinearSyncQueueItem,
  LinearWorkflowCatalog,
  LinearWorkflowConfig,
  LinearWorkflowDefinition,
  LinearWorkflowStep,
  LinearWorkflowTargetType,
} from "../../../shared/types";
import { LinearConnectionPanel } from "./LinearConnectionPanel";
import { Button } from "../ui/Button";
import { PaneHeader } from "../ui/PaneHeader";
import { Chip } from "../ui/Chip";
import { inputCls, labelCls, recessedPanelCls, selectCls, textareaCls, cardCls } from "./shared/designTokens";
import { cn } from "../ui/cn";

type WorkflowStateOption = {
  value: string;
  label: string;
};

type SetupChecklistItem = {
  id: string;
  title: string;
  description: string;
  done: boolean;
};

type SimulationDraft = {
  identifier: string;
  title: string;
  description: string;
  labels: string;
  assigneeName: string;
  projectSlug: string;
  teamKey: string;
  priorityLabel: LinearPriorityLabel;
};

type VisualPlan = {
  startState: string;
  waitForCompletion: boolean;
  waitForPr: boolean;
  reviewReadyWhen: "work_complete" | "pr_created" | "pr_ready";
  notificationEnabled: boolean;
  notificationMilestone: NonNullable<LinearWorkflowStep["notifyOn"]>;
};

const issueStateOptions: WorkflowStateOption[] = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
  { value: "blocked", label: "Blocked" },
  { value: "canceled", label: "Canceled" },
];

const visualManagedStepTypes = new Set<LinearWorkflowStep["type"]>([
  "set_linear_state",
  "launch_target",
  "wait_for_target_status",
  "wait_for_pr",
  "request_human_review",
  "emit_app_notification",
  "complete_issue",
]);

function joinList(values: string[] | null | undefined): string {
  return (values ?? []).join(", ");
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const next = value?.trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    ordered.push(next);
  }
  return ordered;
}

function removeValue(values: string[] | undefined, value: string): string[] {
  return (values ?? []).filter((entry) => entry !== value);
}

function workerSelectorValue(selector: LinearWorkflowDefinition["target"]["workerSelector"]): string {
  return selector && "value" in selector ? selector.value : "";
}

function defaultWorkflowName(targetType: LinearWorkflowTargetType): string {
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

function buildWorkflow(targetType: LinearWorkflowTargetType): LinearWorkflowDefinition {
  const notificationStep = defaultNotificationStep(targetType);
  const target: LinearWorkflowDefinition["target"] =
    targetType === "employee_session"
      ? {
          type: targetType,
          runMode: "assisted",
          sessionTemplate: "default",
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
              prStrategy: { kind: "per-lane", draft: true },
            }
          : {
              type: targetType,
              runMode: "autopilot",
              workerSelector: targetType === "mission" ? { mode: "none" } : { mode: "none" },
              ...(targetType === "mission" ? { missionTemplate: "default" } : {}),
            };

  const steps: LinearWorkflowStep[] = [
    { id: "set-in-progress", type: "set_linear_state", name: "Move issue to In Progress", state: "in_progress" },
    defaultLaunchStep(targetType),
  ];
  if (targetType === "review_gate") {
    steps.push({ id: "review", type: "request_human_review", name: "Await human review" });
  } else {
    steps.push({ id: "wait", type: "wait_for_target_status", name: "Wait for delegated work", targetStatus: "completed" });
  }
  if (targetType === "pr_resolution") {
    steps.push({ id: "wait-pr", type: "wait_for_pr", name: "Wait for PR" });
  }
  steps.push(notificationStep);
  steps.push({ id: "complete", type: "complete_issue", name: "Mark workflow complete" });

  return {
    id: `workflow-${targetType}-${Date.now()}`,
    name: defaultWorkflowName(targetType),
    enabled: true,
    priority: 100,
    description: "Starts only when the assigned employee and workflow label both match.",
    source: "generated",
    triggers: {
      assignees: ["CTO"],
      labels: ["workflow:default"],
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
      reviewReadyWhen: targetType === "pr_resolution" ? "pr_created" : "work_complete",
    },
    retry: { maxAttempts: 3, baseDelaySec: 30 },
    concurrency: { maxActiveRuns: 5, perIssue: 1 },
    observability: { emitNotifications: true, captureIssueSnapshot: true, persistTimeline: true },
  };
}

function createDefaultPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "generated",
    settings: {
      ctoLinearAssigneeName: "CTO",
      ctoLinearAssigneeAliases: ["cto"],
    },
    workflows: [buildWorkflow("employee_session")],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: true },
    legacyConfig: null,
  };
}

function createPreset(targetType: LinearWorkflowTargetType): LinearWorkflowDefinition {
  const workflow = buildWorkflow(targetType);
  return {
    ...workflow,
    id:
      targetType === "employee_session"
        ? "assigned-employee-session"
        : targetType === "mission"
          ? "assigned-mission-run"
          : targetType === "worker_run"
            ? "assigned-worker-run"
            : targetType === "pr_resolution"
              ? "assigned-pr-resolution"
              : "assigned-review-gate",
  };
}

function getStep(workflow: LinearWorkflowDefinition, type: LinearWorkflowStep["type"]): LinearWorkflowStep | undefined {
  return workflow.steps.find((step) => step.type === type);
}

function deriveVisualPlan(workflow: LinearWorkflowDefinition): VisualPlan {
  const notificationStep = getStep(workflow, "emit_app_notification");
  return {
    startState: getStep(workflow, "set_linear_state")?.state ?? "",
    waitForCompletion: Boolean(getStep(workflow, "wait_for_target_status")),
    waitForPr: Boolean(getStep(workflow, "wait_for_pr")),
    reviewReadyWhen: workflow.closeout?.reviewReadyWhen ?? (getStep(workflow, "wait_for_pr") ? "pr_created" : "work_complete"),
    notificationEnabled: Boolean(notificationStep),
    notificationMilestone: notificationStep?.notifyOn ?? (getStep(workflow, "wait_for_pr") ? "review_ready" : "completed"),
  };
}

function rebuildWorkflowSteps(workflow: LinearWorkflowDefinition, planPatch: Partial<VisualPlan>): LinearWorkflowDefinition {
  const currentPlan = deriveVisualPlan(workflow);
  const nextPlan = { ...currentPlan, ...planPatch };
  const customSteps = workflow.steps.filter((step) => !visualManagedStepTypes.has(step.type));
  const steps: LinearWorkflowStep[] = [];

  if (nextPlan.startState.trim()) {
    steps.push({
      ...(getStep(workflow, "set_linear_state") ?? { id: "set-in-progress", type: "set_linear_state", name: "Move issue" }),
      state: nextPlan.startState,
      name: nextPlan.startState === "in_progress" ? "Move issue to In Progress" : getStep(workflow, "set_linear_state")?.name ?? "Set Linear state",
    });
  }

  steps.push(getStep(workflow, "launch_target") ?? defaultLaunchStep(workflow.target.type));

  if (workflow.target.type === "review_gate") {
    steps.push(getStep(workflow, "request_human_review") ?? { id: "review", type: "request_human_review", name: "Await human review" });
  } else if (nextPlan.waitForCompletion) {
    steps.push(
      getStep(workflow, "wait_for_target_status") ?? {
        id: "wait",
        type: "wait_for_target_status",
        name: "Wait for delegated work",
        targetStatus: "completed",
      }
    );
  }

  if (nextPlan.waitForPr) {
    steps.push(getStep(workflow, "wait_for_pr") ?? { id: "wait-pr", type: "wait_for_pr", name: "Wait for PR" });
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
    steps,
    closeout: {
      ...(workflow.closeout ?? {}),
      reviewReadyWhen: nextPlan.waitForPr ? nextPlan.reviewReadyWhen : "work_complete",
    },
  };
}

function describeAssignee(value: string, agents: AgentIdentity[]): string {
  const match = agents.find((agent) => agent.id === value || agent.slug === value || agent.name === value);
  if (!match) return value;
  return `${match.name} (${match.slug})`;
}

function describeLabel(value: string, catalog: LinearWorkflowCatalog): string {
  const match = catalog.labels.find((label) => label.name === value || label.id === value);
  return match ? match.name : value;
}

function formatEndpoint(status: LinearIngressStatus["relay"] | LinearIngressStatus["localWebhook"]): string {
  if (!status?.status) return "not configured";
  if (!status.configured && status.status === "disabled") return "disabled";
  const base = status.status.replace(/_/g, " ");
  const delivery = status.lastDeliveryAt ? ` · last event ${new Date(status.lastDeliveryAt).toLocaleTimeString()}` : "";
  return `${base}${delivery}`;
}

function buildMonitorStory(args: {
  ingressEvents: LinearIngressEventRecord[];
  queue: LinearSyncQueueItem[];
}): Array<{ title: string; detail: string; done: boolean }> {
  const latestIngress = args.ingressEvents[0] ?? null;
  const latestRun = args.queue[0] ?? null;
  return [
    {
      title: "Issue event arrives",
      detail: latestIngress ? `${latestIngress.source} received ${latestIngress.summary}` : "Waiting for the first webhook or reconciliation event.",
      done: Boolean(latestIngress),
    },
    {
      title: "Workflow run is created",
      detail: latestRun ? `${latestRun.workflowName} matched ${latestRun.identifier}` : "No workflow run has been created yet.",
      done: Boolean(latestRun),
    },
    {
      title: "Delegated work starts",
      detail: latestRun ? `${latestRun.targetType} is ${latestRun.status}. Current step: ${latestRun.currentStepId ?? "pending"}.` : "Once matched, ADE launches the delegated target automatically.",
      done: Boolean(latestRun && latestRun.currentStepId),
    },
    {
      title: "Review handoff happens",
      detail:
        latestRun?.prId
          ? `PR ${latestRun.prId} is linked and the run can move the issue to review.`
          : latestRun?.status === "resolved"
            ? "The workflow completed and closeout should have moved the issue to review."
            : "PR linking and final closeout will appear here when the workflow progresses.",
      done: Boolean(latestRun?.prId || latestRun?.status === "resolved"),
    },
  ];
}

export function LinearSyncPanel() {
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [dashboard, setDashboard] = useState<LinearSyncDashboard | null>(null);
  const [policy, setPolicy] = useState<LinearWorkflowConfig>(createDefaultPolicy());
  const [loadedPolicy, setLoadedPolicy] = useState<LinearWorkflowConfig>(createDefaultPolicy());
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(createDefaultPolicy().workflows[0]?.id ?? null);
  const [queue, setQueue] = useState<LinearSyncQueueItem[]>([]);
  const [revisions, setRevisions] = useState<CtoFlowPolicyRevision[]>([]);
  const [catalog, setCatalog] = useState<LinearWorkflowCatalog>({ users: [], labels: [], states: [] });
  const [agents, setAgents] = useState<AgentIdentity[]>([]);
  const [ingressStatus, setIngressStatus] = useState<LinearIngressStatus | null>(null);
  const [ingressEvents, setIngressEvents] = useState<LinearIngressEventRecord[]>([]);
  const [simulationDraft, setSimulationDraft] = useState<SimulationDraft>({
    identifier: "SIM-42",
    title: "Fix flaky auth test on CI",
    description: "Auth integration test intermittently fails.",
    labels: "bug, workflow:default",
    assigneeName: "CTO",
    projectSlug: "my-project",
    teamKey: "MY",
    priorityLabel: "high",
  });
  const [simulationResult, setSimulationResult] = useState<LinearRouteDecision | null>(null);
  const [advancedYaml, setAdvancedYaml] = useState("");
  const [advancedMode, setAdvancedMode] = useState(false);
  const [assigneePicker, setAssigneePicker] = useState("");
  const [labelPicker, setLabelPicker] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  const selectedWorkflow = useMemo(
    () => policy.workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? policy.workflows[0] ?? null,
    [policy.workflows, selectedWorkflowId]
  );

  const visualPlan = useMemo(
    () => (selectedWorkflow ? deriveVisualPlan(selectedWorkflow) : null),
    [selectedWorkflow]
  );

  const availableEmployees = useMemo(
    () => agents.filter((agent) => !agent.deletedAt),
    [agents]
  );

  const availableAssigneeOptions = useMemo(
    () => availableEmployees.map((agent) => ({ value: agent.id, label: `${agent.name} (${agent.slug})` })),
    [availableEmployees]
  );

  const availableLabelOptions = useMemo(
    () => catalog.labels.map((label) => ({ value: label.name, label: label.teamKey ? `${label.name} · ${label.teamKey}` : label.name })),
    [catalog.labels]
  );

  useEffect(() => {
    if (!selectedWorkflow) {
      setAdvancedYaml("");
      return;
    }
    setAdvancedYaml(YAML.stringify(selectedWorkflow, { indent: 2 }));
  }, [selectedWorkflow]);

  useEffect(() => {
    if (!assigneePicker && availableAssigneeOptions[0]?.value) {
      setAssigneePicker(availableAssigneeOptions[0].value);
    }
  }, [assigneePicker, availableAssigneeOptions]);

  useEffect(() => {
    if (!labelPicker && availableLabelOptions[0]?.value) {
      setLabelPicker(availableLabelOptions[0].value);
    }
  }, [availableLabelOptions, labelPicker]);

  const hydrate = useCallback((nextPolicy: LinearWorkflowConfig) => {
    setPolicy(nextPolicy);
    setLoadedPolicy(nextPolicy);
    setSelectedWorkflowId((current) => (current && nextPolicy.workflows.some((workflow) => workflow.id === current) ? current : nextPolicy.workflows[0]?.id ?? null));
  }, []);

  const loadRuntimeState = useCallback(async () => {
    if (!window.ade?.cto) return;
    const [dash, q, nextIngressStatus, nextIngressEvents] = await Promise.all([
      window.ade.cto.getLinearSyncDashboard(),
      window.ade.cto.listLinearSyncQueue(),
      window.ade.cto.getLinearIngressStatus().catch(
        async (): Promise<LinearIngressStatus> => ({
          localWebhook: { configured: false, healthy: false, status: "disabled" },
          relay: { configured: false, healthy: false, status: "disabled" },
          reconciliation: { enabled: true, intervalSec: 30, lastRunAt: null },
        })
      ),
      window.ade.cto.listLinearIngressEvents({ limit: 12 }).catch(async (): Promise<LinearIngressEventRecord[]> => []),
    ]);
    setDashboard(dash);
    setQueue(q);
    setIngressStatus(nextIngressStatus);
    setIngressEvents(nextIngressEvents);
  }, []);

  const loadAll = useCallback(async () => {
    if (!window.ade?.cto) return;
    setLoading(true);
    setError(null);
    try {
      const [conn, pol, revs, nextCatalog, nextAgents] = await Promise.all([
        window.ade.cto.getLinearConnectionStatus(),
        window.ade.cto.getFlowPolicy(),
        window.ade.cto.listFlowPolicyRevisions(),
        window.ade.cto.getLinearWorkflowCatalog().catch(async (): Promise<LinearWorkflowCatalog> => ({ users: [], labels: [], states: [] })),
        window.ade.cto.listAgents().catch(async (): Promise<AgentIdentity[]> => []),
      ]);
      setConnection(conn);
      setRevisions(revs);
      setCatalog(nextCatalog);
      setAgents(nextAgents);
      hydrate(pol);
      await loadRuntimeState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow data.");
    } finally {
      setLoading(false);
    }
  }, [hydrate, loadRuntimeState]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const updateSelectedWorkflow = useCallback(
    (updater: (workflow: LinearWorkflowDefinition) => LinearWorkflowDefinition) => {
      if (!selectedWorkflowId) return;
      setPolicy((current) => ({
        ...current,
        workflows: current.workflows.map((workflow) => (workflow.id === selectedWorkflowId ? updater(workflow) : workflow)),
      }));
    },
    [selectedWorkflowId]
  );

  const updateTriggerValues = useCallback(
    (field: keyof LinearWorkflowDefinition["triggers"], values: string[]) => {
      updateSelectedWorkflow((workflow) => ({
        ...workflow,
        triggers: {
          ...workflow.triggers,
          [field]: uniqueValues(values),
        },
      }));
    },
    [updateSelectedWorkflow]
  );

  const patchVisualPlan = useCallback(
    (patch: Partial<VisualPlan>) => {
      updateSelectedWorkflow((workflow) => rebuildWorkflowSteps(workflow, patch));
    },
    [updateSelectedWorkflow]
  );

  const savePolicy = useCallback(async () => {
    if (!window.ade?.cto) return;
    setSaving(true);
    setError(null);
    setStatusNote(null);
    try {
      const nextPolicy =
        advancedMode && selectedWorkflow
          ? {
              ...policy,
              workflows: policy.workflows.map((workflow) =>
                workflow.id === selectedWorkflow.id ? (YAML.parse(advancedYaml) as LinearWorkflowDefinition) : workflow
              ),
            }
          : policy;
      const saved = await window.ade.cto.saveFlowPolicy({ policy: nextPolicy, actor: "user" });
      hydrate(saved);
      await loadRuntimeState();
      setRevisions(await window.ade.cto.listFlowPolicyRevisions());
      setStatusNote("Workflow files saved to the repo.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [advancedMode, advancedYaml, hydrate, loadRuntimeState, policy, selectedWorkflow]);

  const runSyncNow = useCallback(async () => {
    if (!window.ade?.cto) return;
    setError(null);
    try {
      await window.ade.cto.runLinearSyncNow();
      await loadRuntimeState();
      setStatusNote("Workflow intake and dispatch cycle completed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    }
  }, [loadRuntimeState]);

  const ensureWebhook = useCallback(async () => {
    if (!window.ade?.cto) return;
    setError(null);
    try {
      const ensured = await window.ade.cto.ensureLinearWebhook({ force: true });
      setIngressStatus(ensured);
      setIngressEvents(await window.ade.cto.listLinearIngressEvents({ limit: 12 }));
      setStatusNote("Linear webhook ingress is configured and listening for real-time events.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to ensure the Linear webhook.");
    }
  }, []);

  const simulate = useCallback(async () => {
    if (!window.ade?.cto) return;
    setError(null);
    try {
      const result = await window.ade.cto.simulateFlowRoute({
        issue: {
          identifier: simulationDraft.identifier,
          title: simulationDraft.title,
          description: simulationDraft.description,
          labels: splitList(simulationDraft.labels),
          assigneeName: simulationDraft.assigneeName,
          priorityLabel: simulationDraft.priorityLabel,
          projectSlug: simulationDraft.projectSlug,
          teamKey: simulationDraft.teamKey,
        },
      });
      setSimulationResult(result);
      setStatusNote("Simulation updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed.");
      setSimulationResult(null);
    }
  }, [simulationDraft]);

  const addPreset = useCallback((targetType: LinearWorkflowTargetType) => {
    const workflow = createPreset(targetType);
    setPolicy((current) => ({ ...current, workflows: [...current.workflows, workflow] }));
    setSelectedWorkflowId(workflow.id);
  }, []);

  const diffPreview = useMemo(() => {
    const previous = loadedPolicy.workflows.find((workflow) => workflow.id === selectedWorkflow?.id) ?? null;
    const next = selectedWorkflow ?? null;
    return {
      before: previous ? YAML.stringify(previous, { indent: 2 }) : "# New workflow\n",
      after: next ? YAML.stringify(next, { indent: 2 }) : "# No workflow selected\n",
    };
  }, [loadedPolicy.workflows, selectedWorkflow]);

  const selectedEmployeeBinding = selectedWorkflow?.target.employeeIdentityKey ?? "__assigned__";
  const labelRequirementReady = Boolean(selectedWorkflow?.triggers.labels?.length);
  const assigneeRequirementReady = Boolean(selectedWorkflow?.triggers.assignees?.length);
  const webhookReady = Boolean(
    ingressStatus && ((ingressStatus.relay.configured && ingressStatus.relay.healthy) || (ingressStatus.localWebhook.configured && ingressStatus.localWebhook.healthy))
  );
  const employeeSetupReady = availableEmployees.length > 0;
  const checklistItems = useMemo<SetupChecklistItem[]>(
    () => [
      {
        id: "connect",
        title: "Connect Linear",
        description: connection?.connected ? `Connected as ${connection.viewerName ?? "your account"}.` : "Use the Linear connection card on the left to authenticate first.",
        done: Boolean(connection?.connected),
      },
      {
        id: "employees",
        title: "Configure ADE employees",
        description: employeeSetupReady
          ? `${availableEmployees.length} employee ${availableEmployees.length === 1 ? "identity is" : "identities are"} available for assignment matching.`
          : "Open CTO > Team and add at least one employee identity before using assignee-based workflows.",
        done: employeeSetupReady,
      },
      {
        id: "webhook",
        title: "Optional: turn on real-time ingress",
        description: webhookReady
          ? "Webhook ingress is healthy. Linear updates should start the workflow immediately."
          : "Polling already works. Click 'Ensure webhook' only if you want faster real-time intake.",
        done: webhookReady,
      },
      {
        id: "trigger",
        title: "Choose both trigger conditions",
        description:
          assigneeRequirementReady && labelRequirementReady
            ? "This workflow now requires both an ADE employee match and a workflow label."
            : "Select at least one employee and one workflow label. ADE requires both before a run starts.",
        done: assigneeRequirementReady && labelRequirementReady,
      },
      {
        id: "monitor",
        title: "Test and monitor it",
        description: "Use simulation, recent ingress events, and run observability in the right rail to watch the workflow progress.",
        done: Boolean(simulationResult || ingressEvents.length || queue.length),
      },
    ],
    [
      assigneeRequirementReady,
      availableEmployees.length,
      connection?.connected,
      connection?.viewerName,
      employeeSetupReady,
      ingressEvents.length,
      labelRequirementReady,
      queue.length,
      simulationResult,
      webhookReady,
    ]
  );
  const completedChecklistCount = checklistItems.filter((item) => item.done).length;
  const monitorStory = useMemo(() => buildMonitorStory({ ingressEvents, queue }), [ingressEvents, queue]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="linear-sync-panel">
      <PaneHeader
        title="Linear Workflows"
        meta="Webhook-first workflow orchestration with visual authoring, simulation, and observable runs."
        right={(
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void runSyncNow()} disabled={loading}>
              <Lightning size={10} />
              Reconcile now
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void loadAll()}>
              <ArrowClockwise size={10} />
            </Button>
          </div>
        )}
      />

      {(statusNote || error) && (
        <div className="border-b border-border/20 px-4 py-2">
          {statusNote ? <div className="font-mono text-[10px] text-success">{statusNote}</div> : null}
          {error ? <div className="font-mono text-[10px] text-error">{error}</div> : null}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_360px]">
        <aside className={cn("border-r border-border/20 p-3", recessedPanelCls)}>
          <div className="space-y-3">
            <LinearConnectionPanel compact onStatusChange={setConnection} />

            <div className={cardCls}>
              <div className="mb-2 flex items-center justify-between">
                <span className={labelCls}>Workflows</span>
                <Chip>{policy.workflows.length}</Chip>
              </div>
              <div className="space-y-2">
                {policy.workflows.map((workflow) => (
                  <button
                    key={workflow.id}
                    type="button"
                    onClick={() => setSelectedWorkflowId(workflow.id)}
                    className={cn(
                      "w-full rounded border px-3 py-2 text-left",
                      selectedWorkflowId === workflow.id ? "border-accent bg-accent/10" : "border-border/30 bg-surface"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate font-sans text-xs font-semibold text-fg">{workflow.name}</div>
                      <Chip>{workflow.priority}</Chip>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-muted-fg">
                      {workflow.target.type} · {workflow.enabled ? "enabled" : "disabled"}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className={cardCls}>
              <div className="mb-2 font-mono text-[10px] text-muted-fg uppercase">Starter presets</div>
              <div className="grid gap-2">
                <Button variant="outline" size="sm" onClick={() => addPreset("employee_session")}>
                  <Plus size={10} />
                  Assigned Employee
                </Button>
                <Button variant="outline" size="sm" onClick={() => addPreset("mission")}>
                  <Plus size={10} />
                  Mission
                </Button>
                <Button variant="outline" size="sm" onClick={() => addPreset("worker_run")}>
                  <Plus size={10} />
                  Worker Run
                </Button>
                <Button variant="outline" size="sm" onClick={() => addPreset("pr_resolution")}>
                  <Plus size={10} />
                  PR Resolution
                </Button>
                <Button variant="outline" size="sm" onClick={() => addPreset("review_gate")}>
                  <Plus size={10} />
                  Review Gate
                </Button>
              </div>
            </div>
          </div>
        </aside>

        <main className="min-h-0 overflow-auto p-4">
          {!selectedWorkflow ? (
            <div className={cardCls}>No workflow selected.</div>
          ) : (
            <div className="space-y-4">
              <div className={cardCls} data-testid="linear-first-run-guide">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-sans text-sm font-semibold text-fg">Create your first real-time Linear workflow</div>
                    <div className="mt-1 max-w-3xl font-mono text-[10px] text-muted-fg">
                      The normal setup is: connect Linear, make sure your ADE employees exist, pick who the issue must be assigned to, pick the workflow label, choose what ADE should launch, then save and test it.
                    </div>
                  </div>
                  <Chip>{completedChecklistCount}/{checklistItems.length} ready</Chip>
                </div>
                <div className="mt-4 grid gap-3 lg:grid-cols-5">
                  {checklistItems.map((item, index) => (
                    <div
                      key={item.id}
                      className={cn(
                        "rounded border px-3 py-3",
                        item.done ? "border-success/30 bg-success/5" : "border-border/20 bg-surface-recessed"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-mono text-[10px] text-muted-fg">Step {index + 1}</div>
                        <Chip>{item.done ? "ready" : "todo"}</Chip>
                      </div>
                      <div className="mt-2 font-sans text-xs font-semibold text-fg">{item.title}</div>
                      <div className="mt-1 font-mono text-[10px] text-muted-fg">{item.description}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => void ensureWebhook()} disabled={!connection?.connected}>
                    <Lightning size={10} />
                    Ensure real-time webhook
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void simulate()}>
                    <Shuffle size={10} />
                    Test this workflow
                  </Button>
                </div>
              </div>

              <div className={cardCls}>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className={labelCls}>Workflow Name</label>
                    <input
                      className={inputCls}
                      value={selectedWorkflow.name}
                      onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, name: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Priority</label>
                    <input
                      className={inputCls}
                      type="number"
                      value={selectedWorkflow.priority}
                      onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, priority: Number(e.target.value) || 0 }))}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className={labelCls}>Description</label>
                    <textarea
                      className={textareaCls}
                      rows={2}
                      value={selectedWorkflow.description ?? ""}
                      onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, description: e.target.value }))}
                    />
                  </div>
                  <label className="flex items-center gap-2 font-mono text-[10px] text-fg">
                    <input
                      type="checkbox"
                      checked={selectedWorkflow.enabled}
                      onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, enabled: e.target.checked }))}
                    />
                    Enabled
                  </label>
                </div>
              </div>

              <div className={cardCls}>
                <div className="mb-2 font-sans text-sm font-semibold text-fg">Trigger Conditions</div>
                <div className="mb-3 font-mono text-[10px] text-muted-fg">
                  This workflow fires only when both cards below match: the issue is assigned to one of the selected ADE employees, and the issue has one of the selected workflow labels.
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  <div className="rounded border border-border/20 bg-surface-recessed p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-sans text-sm font-semibold text-fg">Assigned to employee</div>
                      <Chip>{selectedWorkflow.triggers.assignees?.length ?? 0}</Chip>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-muted-fg">
                      OR within this card. Match any selected ADE employee identity. Employees come from CTO &gt; Team, where each ADE employee can map to one or more Linear identities.
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(selectedWorkflow.triggers.assignees ?? []).map((value) => (
                        <button
                          key={value}
                          type="button"
                          className="rounded border border-border/20 bg-surface px-2 py-1 font-mono text-[10px] text-fg"
                          onClick={() => updateTriggerValues("assignees", removeValue(selectedWorkflow.triggers.assignees, value))}
                        >
                          {describeAssignee(value, availableEmployees)} ×
                        </button>
                      ))}
                      {!selectedWorkflow.triggers.assignees?.length ? (
                        <div className="font-mono text-[10px] text-warning">Pick at least one employee. Without it, the workflow will not start.</div>
                      ) : null}
                    </div>
                    <div className="mt-3 flex gap-2">
                      <select className={selectCls} value={assigneePicker} onChange={(e) => setAssigneePicker(e.target.value)} data-testid="linear-trigger-assignee-select">
                        {availableAssigneeOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updateTriggerValues("assignees", [...(selectedWorkflow.triggers.assignees ?? []), assigneePicker])}
                        disabled={!assigneePicker}
                        data-testid="linear-trigger-assignee-add"
                      >
                        <Plus size={10} />
                        Add
                      </Button>
                    </div>
                    {!employeeSetupReady ? (
                      <div className="mt-2 font-mono text-[10px] text-warning">
                        No ADE employees are configured yet. Open CTO &gt; Team first, then come back here to match Linear assignees.
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded border border-border/20 bg-surface-recessed p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-sans text-sm font-semibold text-fg">Has workflow label</div>
                      <Chip>{selectedWorkflow.triggers.labels?.length ?? 0}</Chip>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-muted-fg">
                      OR within this card. Use a normal Linear label to choose the workflow. ADE watches for that label in real time and only starts after both the assignee and label match.
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(selectedWorkflow.triggers.labels ?? []).map((value) => (
                        <button
                          key={value}
                          type="button"
                          className="rounded border border-border/20 bg-surface px-2 py-1 font-mono text-[10px] text-fg"
                          onClick={() => updateTriggerValues("labels", removeValue(selectedWorkflow.triggers.labels, value))}
                        >
                          {describeLabel(value, catalog)} ×
                        </button>
                      ))}
                      {!selectedWorkflow.triggers.labels?.length ? (
                        <div className="font-mono text-[10px] text-warning">Pick at least one workflow label. Without it, the workflow will not start.</div>
                      ) : null}
                    </div>
                    <div className="mt-3 flex gap-2">
                      <select className={selectCls} value={labelPicker} onChange={(e) => setLabelPicker(e.target.value)} data-testid="linear-trigger-label-select">
                        {availableLabelOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updateTriggerValues("labels", [...(selectedWorkflow.triggers.labels ?? []), labelPicker])}
                        disabled={!labelPicker}
                        data-testid="linear-trigger-label-add"
                      >
                        <Plus size={10} />
                        Add
                      </Button>
                    </div>
                    {!availableLabelOptions.length ? (
                      <div className="mt-2 font-mono text-[10px] text-warning">
                        No Linear labels are available yet. Create the workflow label in Linear first, then select it here.
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <label className={labelCls}>Project Slugs</label>
                    <input
                      className={inputCls}
                      value={joinList(selectedWorkflow.triggers.projectSlugs)}
                      onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, triggers: { ...workflow.triggers, projectSlugs: splitList(e.target.value) } }))}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Team Keys</label>
                    <input
                      className={inputCls}
                      value={joinList(selectedWorkflow.triggers.teamKeys)}
                      onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, triggers: { ...workflow.triggers, teamKeys: splitList(e.target.value) } }))}
                    />
                  </div>
                </div>
              </div>

              <div className={cardCls}>
                <div className="mb-3 font-sans text-sm font-semibold text-fg">Execution Target</div>
                <div className="mb-3 font-mono text-[10px] text-muted-fg">
                  Most teams want `employee_session` here. That means ADE will open the assigned employee's chat, send the Linear issue context into it, and start work automatically.
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className={labelCls}>Target Type</label>
                    <select
                      className={selectCls}
                      value={selectedWorkflow.target.type}
                      data-testid="linear-target-type-select"
                      onChange={(e) =>
                        updateSelectedWorkflow((workflow) =>
                          rebuildWorkflowSteps(
                            {
                              ...workflow,
                              target: {
                                ...workflow.target,
                                type: e.target.value as LinearWorkflowTargetType,
                                runMode:
                                  e.target.value === "employee_session"
                                    ? "assisted"
                                    : e.target.value === "review_gate"
                                      ? "manual"
                                      : "autopilot",
                              },
                            },
                            {}
                          )
                        )
                      }
                    >
                      <option value="employee_session">employee_session</option>
                      <option value="mission">mission</option>
                      <option value="worker_run">worker_run</option>
                      <option value="pr_resolution">pr_resolution</option>
                      <option value="review_gate">review_gate</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Run Mode</label>
                    <select
                      className={selectCls}
                      value={selectedWorkflow.target.runMode ?? "autopilot"}
                      onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, target: { ...workflow.target, runMode: e.target.value as LinearWorkflowDefinition["target"]["runMode"] } }))}
                    >
                      <option value="autopilot">autopilot</option>
                      <option value="assisted">assisted</option>
                      <option value="manual">manual</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Delegated Employee</label>
                    <select
                      className={selectCls}
                      value={selectedEmployeeBinding}
                      onChange={(e) =>
                        updateSelectedWorkflow((workflow) => ({
                          ...workflow,
                          target: {
                            ...workflow.target,
                            employeeIdentityKey:
                              e.target.value === "__assigned__" ? undefined : (e.target.value as LinearWorkflowDefinition["target"]["employeeIdentityKey"]),
                          },
                        }))
                      }
                    >
                      <option value="__assigned__">Use the Linear assignee</option>
                      {availableEmployees.map((agent) => (
                        <option key={agent.id} value={`agent:${agent.id}`}>
                          {agent.name} ({agent.slug})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Worker Selector Mode</label>
                    <select
                      className={selectCls}
                      value={selectedWorkflow.target.workerSelector?.mode ?? "none"}
                      onChange={(e) =>
                        updateSelectedWorkflow((workflow) => ({
                          ...workflow,
                          target: {
                            ...workflow.target,
                            workerSelector:
                              e.target.value === "none"
                                ? { mode: "none" }
                                : {
                                    mode: e.target.value as "id" | "slug" | "capability",
                                    value: workerSelectorValue(workflow.target.workerSelector),
                                  },
                          },
                        }))
                      }
                    >
                      <option value="none">none</option>
                      <option value="slug">slug</option>
                      <option value="id">id</option>
                      <option value="capability">capability</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Worker Selector Value</label>
                    <input
                      className={inputCls}
                      value={workerSelectorValue(selectedWorkflow.target.workerSelector)}
                      onChange={(e) =>
                        updateSelectedWorkflow((workflow) => ({
                          ...workflow,
                          target: {
                            ...workflow.target,
                            workerSelector:
                              workflow.target.workerSelector && workflow.target.workerSelector.mode !== "none"
                                ? { ...workflow.target.workerSelector, value: e.target.value }
                                : { mode: "slug", value: e.target.value },
                          },
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Template</label>
                    <input
                      className={inputCls}
                      value={selectedWorkflow.target.sessionTemplate ?? selectedWorkflow.target.missionTemplate ?? ""}
                      onChange={(e) =>
                        updateSelectedWorkflow((workflow) => ({
                          ...workflow,
                          target: workflow.target.type === "mission"
                            ? { ...workflow.target, missionTemplate: e.target.value }
                            : { ...workflow.target, sessionTemplate: e.target.value },
                        }))
                      }
                    />
                  </div>
                </div>
              </div>

              <div className={cardCls}>
                <div className="mb-3 font-sans text-sm font-semibold text-fg">Execution Plan</div>
                <div className="mb-3 font-mono text-[10px] text-muted-fg">
                  Common path: move issue to In Progress, launch delegated work, optionally wait for a PR, hand off to In Review, then notify you in ADE.
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className={labelCls}>Move issue when workflow starts</label>
                    <select
                      className={selectCls}
                      value={visualPlan?.startState ?? ""}
                      data-testid="linear-start-state-select"
                      onChange={(e) => patchVisualPlan({ startState: e.target.value })}
                    >
                      <option value="">Do not change state</option>
                      {issueStateOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Wait for delegated work</label>
                    <select
                      className={selectCls}
                      value={visualPlan?.waitForCompletion ? "yes" : "no"}
                      data-testid="linear-wait-target-select"
                      onChange={(e) => patchVisualPlan({ waitForCompletion: e.target.value === "yes" })}
                      disabled={selectedWorkflow.target.type === "review_gate"}
                    >
                      <option value="yes">Yes, pause until work completes</option>
                      <option value="no">No, continue immediately</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>PR Behavior</label>
                    <select
                      className={selectCls}
                      value={selectedWorkflow.target.prStrategy?.kind ?? "none"}
                      data-testid="linear-pr-behavior-select"
                      onChange={(e) =>
                        updateSelectedWorkflow((workflow) => ({
                          ...rebuildWorkflowSteps(workflow, {
                            waitForPr: e.target.value !== "none",
                          }),
                          target: {
                            ...workflow.target,
                            prStrategy:
                              e.target.value === "none"
                                ? null
                                : e.target.value === "manual"
                                  ? { kind: "manual" }
                                  : { kind: e.target.value as "integration" | "per-lane" | "queue", draft: true },
                          },
                        }))
                      }
                    >
                      <option value="none">Do not create or link a PR</option>
                      <option value="per-lane">Create or link a per-lane PR</option>
                      <option value="integration">Create an integration PR</option>
                      <option value="queue">Create a queue PR</option>
                      <option value="manual">Track a manually created PR</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Review-ready when</label>
                    <select
                      className={selectCls}
                      value={visualPlan?.reviewReadyWhen ?? "work_complete"}
                      data-testid="linear-review-ready-select"
                      onChange={(e) => patchVisualPlan({ reviewReadyWhen: e.target.value as VisualPlan["reviewReadyWhen"], waitForPr: e.target.value !== "work_complete" })}
                    >
                      <option value="work_complete">Delegated work completes</option>
                      <option value="pr_created">A PR exists</option>
                      <option value="pr_ready">A PR is ready for review</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Move issue on success</label>
                    <select
                      className={selectCls}
                      value={selectedWorkflow.closeout?.successState ?? "in_review"}
                      data-testid="linear-success-state-select"
                      onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, closeout: { ...(workflow.closeout ?? {}), successState: e.target.value } }))}
                    >
                      {issueStateOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Move issue on failure</label>
                    <select
                      className={selectCls}
                      value={selectedWorkflow.closeout?.failureState ?? "blocked"}
                      onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, closeout: { ...(workflow.closeout ?? {}), failureState: e.target.value } }))}
                    >
                      {issueStateOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="md:col-span-2 grid gap-3 md:grid-cols-[180px_minmax(0,1fr)]">
                    <div className="rounded border border-border/20 bg-surface-recessed p-3">
                      <div className="font-sans text-sm font-semibold text-fg">Notify in ADE</div>
                      <label className="mt-2 flex items-center gap-2 font-mono text-[10px] text-fg">
                        <input
                          type="checkbox"
                          checked={visualPlan?.notificationEnabled ?? false}
                          onChange={(e) => patchVisualPlan({ notificationEnabled: e.target.checked })}
                          data-testid="linear-notify-toggle"
                        />
                        Send an in-app notification
                      </label>
                    </div>
                    <div>
                      <label className={labelCls}>Notify when</label>
                      <select
                        className={selectCls}
                        value={visualPlan?.notificationMilestone ?? "review_ready"}
                        onChange={(e) => patchVisualPlan({ notificationMilestone: e.target.value as VisualPlan["notificationMilestone"] })}
                        disabled={!visualPlan?.notificationEnabled}
                      >
                        <option value="delegated">The task is delegated</option>
                        <option value="pr_linked">A PR is linked</option>
                        <option value="review_ready">The workflow is review-ready</option>
                        <option value="completed">The workflow fully completes</option>
                        <option value="failed">The workflow fails</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded border border-border/20 bg-surface-recessed p-3">
                  <div className="mb-2 font-sans text-sm font-semibold text-fg">What Happens Next</div>
                  <div className="space-y-2">
                    {selectedWorkflow.steps.map((step, index) => (
                      <div key={step.id} className="flex items-start gap-2 rounded border border-border/10 bg-surface px-3 py-2">
                        <Chip>{index + 1}</Chip>
                        <div className="min-w-0">
                          <div className="font-sans text-xs font-semibold text-fg">{step.name ?? step.type}</div>
                          <div className="font-mono text-[10px] text-muted-fg">
                            {step.type}
                            {step.type === "set_linear_state" && step.state ? ` -> ${step.state}` : ""}
                            {step.type === "emit_app_notification" && step.notifyOn ? ` -> ${step.notifyOn}` : ""}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className={cardCls}>
                <div className="mb-3 flex items-center justify-between">
                  <div className="font-sans text-sm font-semibold text-fg">Advanced Mode</div>
                  <Button variant="ghost" size="sm" onClick={() => setAdvancedMode((value) => !value)}>
                    <Shuffle size={10} />
                    {advancedMode ? "Hide YAML" : "Show YAML"}
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className={labelCls}>Max Attempts</label>
                    <input
                      className={inputCls}
                      type="number"
                      value={selectedWorkflow.retry?.maxAttempts ?? 3}
                      onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, retry: { ...(workflow.retry ?? {}), maxAttempts: Number(e.target.value) || 0 } }))}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Max Active Runs</label>
                    <input
                      className={inputCls}
                      type="number"
                      value={selectedWorkflow.concurrency?.maxActiveRuns ?? 5}
                      onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, concurrency: { ...(workflow.concurrency ?? {}), maxActiveRuns: Number(e.target.value) || 1 } }))}
                    />
                  </div>
                </div>
                {advancedMode ? (
                  <div className="mt-3">
                    <label className={labelCls}>Workflow YAML</label>
                    <textarea className={textareaCls} rows={18} value={advancedYaml} onChange={(e) => setAdvancedYaml(e.target.value)} spellCheck={false} />
                  </div>
                ) : (
                  <div className="mt-3 font-mono text-[10px] text-muted-fg">
                    Visual editing handles the common workflow path. Use YAML only when you need custom steps or unsupported advanced fields.
                  </div>
                )}
              </div>

              <div className={cardCls}>
                <div className="mb-3 flex items-center justify-between">
                  <div className="font-sans text-sm font-semibold text-fg">Simulation</div>
                  <Button variant="outline" size="sm" onClick={() => void simulate()} data-testid="linear-simulate-btn">
                    <Lightning size={10} />
                    Simulate
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className={labelCls}>Issue Identifier</label>
                    <input className={inputCls} value={simulationDraft.identifier} onChange={(e) => setSimulationDraft((current) => ({ ...current, identifier: e.target.value }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Assigned Employee</label>
                    <input className={inputCls} value={simulationDraft.assigneeName} onChange={(e) => setSimulationDraft((current) => ({ ...current, assigneeName: e.target.value }))} />
                  </div>
                  <div className="md:col-span-2">
                    <label className={labelCls}>Issue Title</label>
                    <input className={inputCls} value={simulationDraft.title} onChange={(e) => setSimulationDraft((current) => ({ ...current, title: e.target.value }))} />
                  </div>
                  <div className="md:col-span-2">
                    <label className={labelCls}>Workflow Labels</label>
                    <input className={inputCls} value={simulationDraft.labels} onChange={(e) => setSimulationDraft((current) => ({ ...current, labels: e.target.value }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Project Slug</label>
                    <input className={inputCls} value={simulationDraft.projectSlug} onChange={(e) => setSimulationDraft((current) => ({ ...current, projectSlug: e.target.value }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Team Key</label>
                    <input className={inputCls} value={simulationDraft.teamKey} onChange={(e) => setSimulationDraft((current) => ({ ...current, teamKey: e.target.value }))} />
                  </div>
                  <div className="md:col-span-2">
                    <label className={labelCls}>Description</label>
                    <textarea className={textareaCls} rows={3} value={simulationDraft.description} onChange={(e) => setSimulationDraft((current) => ({ ...current, description: e.target.value }))} />
                  </div>
                </div>
                {simulationResult ? (
                  <div className="mt-3 space-y-2 rounded border border-border/20 bg-surface-recessed p-3" data-testid="linear-simulation-result">
                    <div className="font-mono text-[10px] text-fg">
                      Winner: {simulationResult.workflowName ?? "No match"} {simulationResult.target ? `-> ${simulationResult.target.type}` : ""}
                    </div>
                    <div className="font-mono text-[10px] text-muted-fg">{simulationResult.reason}</div>
                    {simulationResult.simulation?.explainsAndAcrossFields ? (
                      <div className="font-mono text-[10px] text-muted-fg">
                        Match semantics: at least one assignee match AND at least one workflow label match.
                      </div>
                    ) : null}
                    <div className="space-y-1">
                      {simulationResult.candidates.map((candidate) => (
                        <div key={candidate.workflowId} className="rounded border border-border/20 bg-surface px-2 py-2">
                          <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-fg">
                            <span>{candidate.workflowName}</span>
                            <Chip>{candidate.matched ? "fires" : "blocked"}</Chip>
                          </div>
                          {candidate.matchedSignals?.length ? (
                            <div className="mt-1 font-mono text-[10px] text-success">Matched: {candidate.matchedSignals.join(" · ")}</div>
                          ) : null}
                          {candidate.missingSignals?.length ? (
                            <div className="mt-1 font-mono text-[10px] text-warning">Missing: {candidate.missingSignals.join(" · ")}</div>
                          ) : null}
                          <div className="mt-1 font-mono text-[10px] text-muted-fg">{candidate.reasons.join(" · ")}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className={cardCls}>
                <div className="mb-3 font-sans text-sm font-semibold text-fg">Save Preview</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <div className="mb-1 font-mono text-[10px] text-muted-fg uppercase">Current</div>
                    <textarea className={textareaCls} rows={14} value={diffPreview.before} readOnly spellCheck={false} />
                  </div>
                  <div>
                    <div className="mb-1 font-mono text-[10px] text-muted-fg uppercase">Next</div>
                    <textarea className={textareaCls} rows={14} value={diffPreview.after} readOnly spellCheck={false} />
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <div className="font-mono text-[10px] text-muted-fg">
                    {policy.files.length ? `${policy.files.length} repo workflow file(s)` : "No repo workflow files yet"}
                  </div>
                  <Button variant="primary" size="sm" onClick={() => void savePolicy()} disabled={saving} data-testid="linear-save-policy-btn">
                    <FloppyDisk size={10} />
                    Save Workflow YAML
                  </Button>
                </div>
              </div>
            </div>
          )}
        </main>

        <aside className="min-h-0 overflow-auto border-l border-border/20 p-4">
          <div className="space-y-4">
            <div className={cardCls}>
              <div className="mb-2 font-sans text-sm font-semibold text-fg">Watch It Live</div>
              <div className="mb-3 font-mono text-[10px] text-muted-fg">
                This is the simplest way to monitor the workflow in action. Work flows from top to bottom as ADE receives the issue, matches the workflow, delegates work, links a PR, and closes out to review.
              </div>
              <div className="space-y-2">
                {monitorStory.map((item, index) => (
                  <div key={item.title} className="rounded border border-border/20 bg-surface px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-mono text-[10px] text-muted-fg">Stage {index + 1}</div>
                      <Chip>{item.done ? "seen" : "waiting"}</Chip>
                    </div>
                    <div className="mt-1 font-sans text-xs font-semibold text-fg">{item.title}</div>
                    <div className="mt-1 font-mono text-[10px] text-muted-fg">{item.detail}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className={cardCls}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-sans text-sm font-semibold text-fg">Optional Real-Time Ingress</div>
                <Button variant="outline" size="sm" onClick={() => void ensureWebhook()} data-testid="linear-ensure-webhook-btn">
                  <Lightning size={10} />
                  Ensure webhook
                </Button>
              </div>
              <div className="mb-3 font-mono text-[10px] text-muted-fg">
                Sync polling is enough for the normal Linear workflow. Turn this on only when you want lower-latency webhook delivery.
              </div>
              <div className="space-y-2 font-mono text-[10px] text-muted-fg">
                <div>Relay: {ingressStatus ? formatEndpoint(ingressStatus.relay) : "loading"}</div>
                {ingressStatus?.relay.webhookUrl ? <div className="truncate text-fg">{ingressStatus.relay.webhookUrl}</div> : null}
                <div>Local receiver: {ingressStatus ? formatEndpoint(ingressStatus.localWebhook) : "loading"}</div>
                {ingressStatus?.localWebhook.url ? <div className="truncate text-fg">{ingressStatus.localWebhook.url}</div> : null}
                <div>
                  Reconciliation: {ingressStatus?.reconciliation.enabled ? `every ${ingressStatus.reconciliation.intervalSec}s` : "disabled"}
                  {dashboard?.reconciliationIntervalSec ? ` · dashboard ${dashboard.reconciliationIntervalSec}s` : ""}
                </div>
              </div>
            </div>

            <div className={cardCls}>
              <div className="mb-2 font-sans text-sm font-semibold text-fg">Recent Ingress Events</div>
              {ingressEvents.length ? (
                <div className="space-y-2">
                  {ingressEvents.map((event) => (
                    <div key={event.id} className="rounded border border-border/20 bg-surface px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 truncate font-sans text-xs font-semibold text-fg">
                          {event.issueIdentifier ?? event.issueId ?? "Issue update"}
                        </div>
                        <Chip>{event.source}</Chip>
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-muted-fg">
                        {event.summary}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-muted-fg">
                        {new Date(event.createdAt).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="font-mono text-[10px] text-muted-fg">No ingress events observed yet.</div>
              )}
            </div>

            <div className={cardCls}>
              <div className="mb-2 font-sans text-sm font-semibold text-fg">Run Observability</div>
              <div className="font-mono text-[10px] text-muted-fg">
                {dashboard
                  ? `queued=${dashboard.queue.queued} · waiting=${dashboard.queue.dispatched} · review=${dashboard.queue.escalated} · failed=${dashboard.queue.failed}`
                  : "Loading dashboard…"}
              </div>
              {queue.length ? (
                <div className="mt-3 space-y-2">
                  {queue.slice(0, 10).map((item) => (
                    <div key={item.id} className="rounded border border-border/20 bg-surface px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 truncate font-sans text-xs font-semibold text-fg">{item.identifier}</div>
                        <Chip>{item.status}</Chip>
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-muted-fg">
                        {item.workflowName} {"->"} {item.targetType}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-muted-fg">
                        current={item.currentStepId ?? "none"} {item.reviewState ? `· review=${item.reviewState}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 font-mono text-[10px] text-muted-fg">No workflow runs yet.</div>
              )}
            </div>

            <div className={cardCls}>
              <div className="mb-2 font-sans text-sm font-semibold text-fg">Revision History</div>
              <div className="space-y-2">
                {revisions.slice(0, 8).map((revision) => (
                  <div key={revision.id} className="rounded border border-border/20 bg-surface px-3 py-2">
                    <div className="font-mono text-[10px] text-fg">{revision.actor}</div>
                    <div className="font-mono text-[10px] text-muted-fg">{new Date(revision.createdAt).toLocaleString()}</div>
                  </div>
                ))}
                {!revisions.length ? <div className="font-mono text-[10px] text-muted-fg">No saved revisions yet.</div> : null}
              </div>
            </div>

            <div className={cardCls}>
              <div className="mb-2 font-sans text-sm font-semibold text-fg">Source of Truth</div>
              <div className="font-mono text-[10px] text-muted-fg">
                {policy.source === "repo" ? "Using repo workflow YAML." : "Using generated starter workflows until you save."}
              </div>
              {policy.migration?.needsSave ? (
                <div className="mt-2 font-mono text-[10px] text-warning">
                  A save will materialize editable YAML under `.ade/workflows/linear/`.
                </div>
              ) : null}
              {connection ? (
                <div className="mt-2 font-mono text-[10px] text-muted-fg">
                  Linear: {connection.connected ? "connected" : "disconnected"}
                </div>
              ) : null}
              <div className="mt-2 font-mono text-[10px] text-muted-fg">
                Trigger ready: {assigneeRequirementReady ? "assignee selected" : "missing employee"} · {labelRequirementReady ? "label selected" : "missing label"}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
