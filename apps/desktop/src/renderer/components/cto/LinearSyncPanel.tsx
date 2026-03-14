import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  LinearWorkflowRunDetail,
  LinearWorkflowCatalog,
  LinearWorkflowConfig,
  LinearWorkflowDefinition,
  LinearWorkflowReviewRejectionAction,
  LinearWorkflowTargetType,
} from "../../../shared/types";
import {
  completionContractUsesPrGate,
  createDefaultLinearWorkflowConfig,
  createWorkflowPreset,
  defaultCompletionContract,
  deriveVisualPlan,
  rebuildWorkflowSteps,
  type LinearWorkflowCompletionContract as CompletionContract,
  type LinearWorkflowSupervisorMode as SupervisorMode,
  type LinearWorkflowVisualPlan as VisualPlan,
} from "../../../shared/linearWorkflowPresets";
import { TimelineEntry } from "./shared/TimelineEntry";
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

const issueStateOptions: WorkflowStateOption[] = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
  { value: "blocked", label: "Blocked" },
  { value: "canceled", label: "Canceled" },
];

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

function applyTargetTypeDefaults(
  workflow: LinearWorkflowDefinition,
  targetType: LinearWorkflowTargetType,
): LinearWorkflowDefinition {
  const preset = createWorkflowPreset(targetType, {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    source: workflow.source,
    triggerAssignees: workflow.triggers.assignees,
    triggerLabels: workflow.triggers.labels,
  });

  return {
    ...preset,
    enabled: workflow.enabled,
    priority: workflow.priority,
    description: workflow.description,
    routing: workflow.routing,
    triggers: {
      ...preset.triggers,
      ...workflow.triggers,
      assignees: workflow.triggers.assignees,
      labels: workflow.triggers.labels,
    },
    retry: workflow.retry ?? preset.retry,
    concurrency: workflow.concurrency ?? preset.concurrency,
    observability: workflow.observability ?? preset.observability,
    closeout: {
      ...(preset.closeout ?? {}),
      ...(workflow.closeout ?? {}),
      reviewReadyWhen: preset.closeout?.reviewReadyWhen ?? workflow.closeout?.reviewReadyWhen,
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
        latestRun?.status === "escalated"
          ? `Supervisor review is waiting on ${latestRun.supervisorIdentityKey ?? "the configured reviewer"}.`
          : latestRun?.prId
          ? `PR ${latestRun.prId} is linked and the run can move the issue to review.`
          : latestRun?.status === "resolved"
            ? "The workflow completed and closeout should have moved the issue to review."
            : "PR linking and final closeout will appear here when the workflow progresses.",
      done: Boolean(latestRun?.prId || latestRun?.status === "resolved" || latestRun?.status === "escalated"),
    },
  ];
}

function formatIdentityLabel(value: string | null | undefined, agents: AgentIdentity[]): string {
  if (!value) return "Unassigned";
  if (value === "cto") return "CTO";
  if (value.startsWith("agent:")) {
    const agentId = value.slice("agent:".length);
    const match = agents.find((agent) => agent.id === agentId);
    return match ? `${match.name} (${match.slug})` : value;
  }
  return value;
}

function formatQueueRunStatus(item: LinearSyncQueueItem): string {
  if (item.status === "escalated") return "Awaiting supervisor";
  if (item.status === "resolved") return "Completed";
  return item.status.replace(/_/g, " ");
}

function formatPrStatus(item: LinearSyncQueueItem): string {
  if (!item.prId) return "No PR";
  return [item.prState ?? "unknown", item.prChecksStatus ?? "none", item.prReviewStatus ?? "none"].join(" · ");
}

export function shouldShowDelegationOverride(status: LinearSyncQueueItem["status"]): boolean {
  return status === "queued" || status === "retry_wait" || status === "escalated";
}

function buildRunTimeline(detail: LinearWorkflowRunDetail): Array<{
  id: string;
  timestamp: string;
  title: string;
  subtitle: string;
  status: string;
  statusVariant: "info" | "success" | "warning" | "error" | "muted";
  payload: Record<string, unknown> | null;
}> {
  const entries = [
    ...detail.ingressEvents.map((event) => ({
      id: `ingress:${event.id}`,
      timestamp: event.createdAt,
      title: `Ingress · ${event.issueIdentifier ?? event.issueId ?? "Issue update"}`,
      subtitle: `${event.source} · ${event.summary}`,
      status: event.source,
      statusVariant: "muted" as const,
      payload: event.payload ?? null,
    })),
    ...detail.events.map((event) => {
      const statusVariant: "info" | "success" | "warning" | "error" | "muted" =
        event.status === "failed"
          ? "error"
          : event.status === "completed"
            ? "success"
            : event.status === "waiting"
              ? "warning"
              : "info";
      return {
        id: `event:${event.id}`,
        timestamp: event.createdAt,
        title: event.message?.trim() || event.eventType,
        subtitle: event.eventType,
        status: event.status ?? "event",
        statusVariant,
        payload: event.payload ?? null,
      };
    }),
    ...detail.steps
      .filter((step) => step.startedAt || step.completedAt)
      .map((step) => {
        const statusVariant: "info" | "success" | "warning" | "error" | "muted" =
          step.status === "failed"
            ? "error"
            : step.status === "completed"
              ? "success"
              : step.status === "waiting"
                ? "warning"
                : "muted";
        return {
          id: `step:${step.id}`,
          timestamp: step.completedAt ?? step.startedAt ?? detail.run.createdAt,
          title: step.name ?? step.workflowStepId,
          subtitle: step.type,
          status: step.status,
          statusVariant,
          payload: step.payload ?? null,
        };
      }),
  ];

  return entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function LinearSyncPanel() {
  const navigate = useNavigate();
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [dashboard, setDashboard] = useState<LinearSyncDashboard | null>(null);
  const [policy, setPolicy] = useState<LinearWorkflowConfig>(createDefaultLinearWorkflowConfig());
  const [loadedPolicy, setLoadedPolicy] = useState<LinearWorkflowConfig>(createDefaultLinearWorkflowConfig());
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(createDefaultLinearWorkflowConfig().workflows[0]?.id ?? null);
  const [queue, setQueue] = useState<LinearSyncQueueItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<LinearWorkflowRunDetail | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [queueActionLoading, setQueueActionLoading] = useState<"approve" | "reject" | "retry" | "complete" | null>(null);
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
  const [delegationOverrides, setDelegationOverrides] = useState<Record<string, string>>({});
  const runtimeRefreshTimerRef = useRef<number | null>(null);

  const selectedWorkflow = useMemo(
    () => policy.workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? policy.workflows[0] ?? null,
    [policy.workflows, selectedWorkflowId]
  );

  const visualPlan = useMemo(
    () => (selectedWorkflow ? deriveVisualPlan(selectedWorkflow) : null),
    [selectedWorkflow]
  );

  const ctoAssigneeName = useMemo(
    () => policy.settings.ctoLinearAssigneeName?.trim() || "CTO",
    [policy.settings.ctoLinearAssigneeName]
  );

  const availableEmployees = useMemo(
    () => agents.filter((agent) => !agent.deletedAt),
    [agents]
  );

  const availableAssigneeOptions = useMemo(
    () => [
      { value: ctoAssigneeName, label: `${ctoAssigneeName} (ADE CTO)` },
      ...availableEmployees.map((agent) => ({ value: agent.id, label: `${agent.name} (${agent.slug})` })),
    ],
    [availableEmployees, ctoAssigneeName]
  );

  const delegatedEmployeeOptions = useMemo(
    () => [
      { value: "cto", label: "CTO" },
      ...availableEmployees.map((agent) => ({ value: `agent:${agent.id}`, label: `${agent.name} (${agent.slug})` })),
    ],
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

  useEffect(() => {
    if (!queue.length) {
      setSelectedRunId(null);
      setSelectedRunDetail(null);
      return;
    }
    setSelectedRunId((current) => (current && queue.some((item) => item.id === current) ? current : queue[0]?.id ?? null));
  }, [queue]);

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

  const loadRunDetail = useCallback(async (runId: string | null) => {
    if (!window.ade?.cto || !runId) {
      setSelectedRunDetail(null);
      return;
    }
    setRunDetailLoading(true);
    try {
      const detail = await window.ade.cto.getLinearWorkflowRunDetail({ runId });
      setSelectedRunDetail(detail);
      setReviewNote(detail?.run.latestReviewNote ?? "");
    } catch (err) {
      setSelectedRunDetail(null);
      setError(err instanceof Error ? err.message : "Failed to load run detail.");
    } finally {
      setRunDetailLoading(false);
    }
  }, []);

  const loadAll = useCallback(async () => {
    const cto = window.ade?.cto;
    if (!cto) return;
    setLoading(true);
    setError(null);
    try {
      const [conn, pol] = await Promise.all([
        cto.getLinearConnectionStatus(),
        cto.getFlowPolicy(),
      ]);
      setConnection(conn);
      hydrate(pol);
      window.setTimeout(() => {
        void Promise.allSettled([
          cto.listFlowPolicyRevisions().then(setRevisions),
          cto.getLinearWorkflowCatalog()
            .then(setCatalog)
            .catch(async (): Promise<void> => setCatalog({ users: [], labels: [], states: [] })),
          cto.listAgents()
            .then(setAgents)
            .catch(async (): Promise<void> => setAgents([])),
          loadRuntimeState(),
        ]);
      }, 120);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow data.");
    } finally {
      setLoading(false);
    }
  }, [hydrate, loadRuntimeState]);

  const openPath = useCallback((path: string) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.dispatchEvent(new Event("hashchange"));
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void loadRunDetail(selectedRunId);
  }, [loadRunDetail, selectedRunId]);

  useEffect(() => {
    const unsubscribe = window.ade?.cto?.onLinearWorkflowEvent?.(() => {
      if (runtimeRefreshTimerRef.current !== null) {
        window.clearTimeout(runtimeRefreshTimerRef.current);
      }
      runtimeRefreshTimerRef.current = window.setTimeout(() => {
        runtimeRefreshTimerRef.current = null;
        void loadRuntimeState();
        if (selectedRunId) {
          void loadRunDetail(selectedRunId);
        }
      }, 150);
    });
    return () => {
      unsubscribe?.();
      if (runtimeRefreshTimerRef.current !== null) {
        window.clearTimeout(runtimeRefreshTimerRef.current);
        runtimeRefreshTimerRef.current = null;
      }
    };
  }, [loadRunDetail, loadRuntimeState, selectedRunId]);

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

  const actOnRun = useCallback(
    async (action: "approve" | "reject" | "retry" | "complete") => {
      if (!window.ade?.cto || !selectedRunId) return;
      setQueueActionLoading(action);
      setError(null);
      try {
        const override = delegationOverrides[selectedRunId];
        await window.ade.cto.resolveLinearSyncQueueItem({
          queueItemId: selectedRunId,
          action,
          note: reviewNote.trim() || undefined,
          employeeOverride: override || undefined,
        });
        setDelegationOverrides((prev) => {
          if (!prev[selectedRunId]) return prev;
          const next = { ...prev };
          delete next[selectedRunId];
          return next;
        });
        await loadRuntimeState();
        await loadRunDetail(selectedRunId);
        setStatusNote(
          action === "approve"
            ? "Supervisor approval recorded."
            : action === "reject"
              ? "Supervisor decision recorded."
              : action === "complete"
                ? "Delegated work marked complete."
                : "Workflow queued to retry."
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update the workflow run.");
      } finally {
        setQueueActionLoading(null);
      }
    },
    [delegationOverrides, loadRunDetail, loadRuntimeState, reviewNote, selectedRunId]
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
    const workflow = createWorkflowPreset(targetType);
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
  const selectedSupervisorBinding = visualPlan?.supervisorIdentityKey ?? "cto";
  const labelRequirementReady = Boolean(selectedWorkflow?.triggers.labels?.length);
  const assigneeRequirementReady = Boolean(selectedWorkflow?.triggers.assignees?.length);
  const webhookReady = Boolean(
    ingressStatus && ((ingressStatus.relay.configured && ingressStatus.relay.healthy) || (ingressStatus.localWebhook.configured && ingressStatus.localWebhook.healthy))
  );
  const employeeSetupReady = Boolean(ctoAssigneeName || availableEmployees.length > 0);
  const checklistItems = useMemo<SetupChecklistItem[]>(
    () => [
      {
        id: "connect",
        title: "Connect Linear",
        description: connection?.connected ? `Connected as ${connection.viewerName ?? "your account"}.` : "Connect Linear in Settings before using workflow routing here.",
        done: Boolean(connection?.connected),
      },
      {
        id: "employees",
        title: "Configure ADE employees",
        description: employeeSetupReady
          ? availableEmployees.length
            ? `${availableEmployees.length} mapped ADE ${availableEmployees.length === 1 ? "employee is" : "employees are"} available, and CTO is always available for direct supervisor workflows.`
            : "CTO is ready now. Open CTO > Team if you want non-CTO employees to match Linear assignees too."
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
        description: "Use simulation, recent ingress events, and the per-run timeline in the right rail to watch the workflow progress and approve supervisor handoffs.",
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
  const selectedRunQueueItem = useMemo(
    () => queue.find((item) => item.id === selectedRunId) ?? null,
    [queue, selectedRunId]
  );
  const selectedRunCurrentStep = useMemo(
    () => selectedRunDetail?.steps.find((step) => step.workflowStepId === selectedRunDetail.run.currentStepId) ?? null,
    [selectedRunDetail]
  );
  const canMarkRunComplete = Boolean(
    selectedRunDetail
    && selectedRunDetail.run.status === "waiting_for_target"
    && selectedRunCurrentStep?.type === "wait_for_target_status"
    && selectedRunCurrentStep.targetStatus === "explicit_completion",
  );
  const selectedRunTimeline = useMemo(
    () => (selectedRunDetail ? buildRunTimeline(selectedRunDetail) : []),
    [selectedRunDetail]
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="linear-sync-panel">
      {(statusNote || error) && (
        <div className="px-4 py-2">
          {statusNote ? <div className="text-[11px] text-success">{statusNote}</div> : null}
          {error ? <div className="text-[11px] text-error">{error}</div> : null}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)_340px]">
        <aside className="border-r p-3 overflow-y-auto" style={{ borderColor: "rgba(167,139,250,0.06)", background: "rgba(12,10,20,0.4)" }}>
          <div className="space-y-3">
            <div className={cn(cardCls, "space-y-3 p-3")}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/40">Linear connection</div>
                  <div className="mt-1 text-xs text-fg/70">
                    {connection?.connected
                      ? `Connected${connection.viewerName ? ` as ${connection.viewerName}` : ""}.`
                      : "Not connected. Connect Linear in Settings, then come back here to manage workflows."}
                  </div>
                </div>
                <span
                  className="rounded-full px-2 py-1 text-[9px] font-medium uppercase tracking-wider"
                  style={{
                    color: connection?.connected ? "#34D399" : "#F59E0B",
                    background: connection?.connected ? "rgba(52, 211, 153, 0.08)" : "rgba(245, 158, 11, 0.08)",
                    border: `1px solid ${connection?.connected ? "rgba(52, 211, 153, 0.15)" : "rgba(245, 158, 11, 0.15)"}`,
                  }}
                >
                  {connection?.connected ? "Connected" : "Needs setup"}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="!text-[10px]"
                  onClick={() => navigate("/settings?tab=integrations")}
                >
                  {connection?.connected ? "Manage in Settings" : "Connect in Settings"}
                </Button>
                <Button variant="ghost" size="sm" className="!h-7 !text-[10px]" onClick={() => void loadAll()}>
                  <ArrowClockwise size={10} />
                  Refresh
                </Button>
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-medium text-muted-fg/40 uppercase tracking-wider">Workflows</span>
                <div className="flex items-center gap-1.5">
                  <Button variant="ghost" size="sm" className="!h-5 !px-1.5" onClick={() => void runSyncNow()} disabled={loading} title="Sync now">
                    <Lightning size={9} />
                  </Button>
                  <Button variant="ghost" size="sm" className="!h-5 !px-1.5" onClick={() => void loadAll()} title="Refresh">
                    <ArrowClockwise size={9} />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                {policy.workflows.map((workflow) => {
                  const isSelected = selectedWorkflowId === workflow.id;
                  return (
                    <button
                      key={workflow.id}
                      type="button"
                      onClick={() => setSelectedWorkflowId(workflow.id)}
                      className={cn(
                        "w-full rounded-lg px-3 py-2 text-left transition-all duration-200",
                        isSelected
                          ? "bg-[rgba(167,139,250,0.08)]"
                          : "hover:bg-white/[0.03]",
                      )}
                      style={isSelected ? { border: "1px solid rgba(167,139,250,0.15)" } : { border: "1px solid transparent" }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-xs font-medium text-fg">{workflow.name}</div>
                        <div className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: workflow.enabled ? "#34D399" : "#6B7280" }} />
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted-fg/35">
                        {workflow.target.type}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-2 text-[10px] font-medium text-muted-fg/40 uppercase tracking-wider">Add from template</div>
              <div className="grid gap-1">
                {([
                  { type: "employee_session" as const, label: "Employee", color: "#A78BFA" },
                  { type: "mission" as const, label: "Mission", color: "#60A5FA" },
                  { type: "worker_run" as const, label: "Worker Run", color: "#34D399" },
                  { type: "pr_resolution" as const, label: "PR Resolution", color: "#F472B6" },
                  { type: "review_gate" as const, label: "Review Gate", color: "#FBBF24" },
                ] as const).map(({ type, label, color }) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => addPreset(type)}
                    className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-all duration-200 hover:bg-white/[0.03]"
                    style={{ border: "1px solid transparent" }}
                  >
                    <Plus size={9} style={{ color }} />
                    <span className="text-[11px] text-muted-fg/50">{label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>

        <main className="min-h-0 overflow-auto p-4">
          {!selectedWorkflow ? (
            <div className="flex items-center justify-center h-full text-xs text-muted-fg/35">Select or create a workflow</div>
          ) : (
            <div className="space-y-3">
              {/* Setup progress - compact */}
              <div className="flex items-center gap-3 rounded-lg px-3 py-2" style={{ background: "rgba(24,20,35,0.4)", border: "1px solid rgba(167,139,250,0.06)" }} data-testid="linear-first-run-guide">
                <div className="flex items-center gap-1">
                  {checklistItems.map((item) => (
                    <div key={item.id} className="h-1.5 w-6 rounded-full" style={{ background: item.done ? "#34D399" : "rgba(255,255,255,0.06)" }} />
                  ))}
                </div>
                <span className="text-[10px] text-muted-fg/40">{completedChecklistCount}/{checklistItems.length} ready</span>
                <div className="flex-1" />
                <Button variant="ghost" size="sm" className="!h-5 !text-[10px]" onClick={() => void ensureWebhook()} disabled={!connection?.connected}>
                  <Lightning size={9} />
                  Webhook
                </Button>
                <Button variant="ghost" size="sm" className="!h-5 !text-[10px]" onClick={() => void simulate()}>
                  <Shuffle size={9} />
                  Test
                </Button>
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
                  <label className="flex items-center gap-2 text-xs text-fg">
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
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-1.5 w-1.5 rounded-full" style={{ background: "#60A5FA" }} />
                  <div className="text-xs font-semibold text-fg">Triggers</div>
                  <span className="text-[10px] text-muted-fg/30">Both must match</span>
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  <div className="rounded-lg p-3" style={{ background: "rgba(96,165,250,0.04)", border: "1px solid rgba(96,165,250,0.1)" }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-fg">Assignee</div>
                      <span className="text-[10px] font-medium" style={{ color: "#60A5FA" }}>{selectedWorkflow.triggers.assignees?.length ?? 0}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(selectedWorkflow.triggers.assignees ?? []).map((value) => (
                        <button
                          key={value}
                          type="button"
                          className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-xs text-fg hover:bg-white/[0.06] transition-colors"
                          onClick={() => updateTriggerValues("assignees", removeValue(selectedWorkflow.triggers.assignees, value))}
                        >
                          {describeAssignee(value, availableEmployees)} ×
                        </button>
                      ))}
                      {!selectedWorkflow.triggers.assignees?.length ? (
                        <div className="text-xs text-warning">Pick at least one employee. Without it, the workflow will not start.</div>
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
                      <div className="mt-2 text-xs text-warning">
                        No ADE employees are configured yet. Open CTO &gt; Team first, then come back here to match Linear assignees.
                      </div>
                    ) : availableEmployees.length === 0 ? (
                      <div className="mt-2 text-[10px] text-muted-fg">
                        CTO is available now. Open CTO &gt; Team only if you want additional ADE employees to match Linear assignees too.
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-lg p-3" style={{ background: "rgba(52,211,153,0.04)", border: "1px solid rgba(52,211,153,0.1)" }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-fg">Label</div>
                      <span className="text-[10px] font-medium" style={{ color: "#34D399" }}>{selectedWorkflow.triggers.labels?.length ?? 0}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(selectedWorkflow.triggers.labels ?? []).map((value) => (
                        <button
                          key={value}
                          type="button"
                          className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-xs text-fg hover:bg-white/[0.06] transition-colors"
                          onClick={() => updateTriggerValues("labels", removeValue(selectedWorkflow.triggers.labels, value))}
                        >
                          {describeLabel(value, catalog)} ×
                        </button>
                      ))}
                      {!selectedWorkflow.triggers.labels?.length ? (
                        <div className="text-xs text-warning">Pick at least one workflow label. Without it, the workflow will not start.</div>
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
                      <div className="mt-2 text-xs text-warning">
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
                <div className="mb-3 text-xs text-muted-fg/60 leading-relaxed">
                  Pick how ADE should execute the matched issue. Employee session is the direct handoff path, worker run is the delegated isolated worker path, and mission is best when you want a broader multi-step mission.
                </div>
                <div className="mb-3 grid gap-2.5 md:grid-cols-3">
                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3.5 hover:bg-white/[0.03] transition-colors">
                    <div className="font-sans text-xs font-semibold text-fg">Direct CTO session</div>
                    <div className="mt-1.5 text-[10px] text-muted-fg/60 leading-relaxed">Assign to CTO + add a workflow label. ADE opens the CTO chat and sends the issue context immediately.</div>
                  </div>
                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3.5 hover:bg-white/[0.03] transition-colors">
                    <div className="font-sans text-xs font-semibold text-fg">Fresh worker lane</div>
                    <div className="mt-1.5 text-[10px] text-muted-fg/60 leading-relaxed">Use worker_run with a fresh issue lane when you want isolated delegated implementation before review.</div>
                  </div>
                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3.5 hover:bg-white/[0.03] transition-colors">
                    <div className="font-sans text-xs font-semibold text-fg">Mission workflow</div>
                    <div className="mt-1.5 text-[10px] text-muted-fg/60 leading-relaxed">Use mission when the issue should become a broader ADE mission instead of a single employee-owned chat.</div>
                  </div>
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
                          applyTargetTypeDefaults(workflow, e.target.value as LinearWorkflowTargetType)
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
                      data-testid="linear-delegated-employee-select"
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
                      {delegatedEmployeeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Lane Behavior</label>
                    <select
                      className={selectCls}
                      value={selectedWorkflow.target.laneSelection ?? "primary"}
                      data-testid="linear-lane-selection-select"
                      disabled={selectedWorkflow.target.type === "mission" || selectedWorkflow.target.type === "review_gate"}
                      onChange={(e) =>
                        updateSelectedWorkflow((workflow) => ({
                          ...workflow,
                          target: {
                            ...workflow.target,
                            laneSelection: e.target.value as NonNullable<LinearWorkflowDefinition["target"]["laneSelection"]>,
                          },
                        }))
                      }
                    >
                      <option value="primary">Reuse the primary lane</option>
                      <option value="fresh_issue_lane">Create a fresh dedicated issue lane</option>
                    </select>
                  </div>
                  {selectedWorkflow.target.type === "employee_session" ? (
                    <div>
                      <label className={labelCls}>Session Behavior</label>
                      <select
                        className={selectCls}
                        value={selectedWorkflow.target.sessionReuse ?? "reuse_existing"}
                        data-testid="linear-session-reuse-select"
                        onChange={(e) =>
                          updateSelectedWorkflow((workflow) => ({
                            ...workflow,
                            target: {
                              ...workflow.target,
                              sessionReuse: e.target.value as NonNullable<LinearWorkflowDefinition["target"]["sessionReuse"]>,
                            },
                          }))
                        }
                      >
                        <option value="reuse_existing">Reuse the employee&apos;s existing session</option>
                        <option value="fresh_session">Create a fresh dedicated session</option>
                      </select>
                    </div>
                  ) : null}
                  {selectedWorkflow.target.laneSelection === "fresh_issue_lane" && selectedWorkflow.target.type !== "mission" && selectedWorkflow.target.type !== "review_gate" ? (
                    <div>
                      <label className={labelCls}>Fresh Lane Name</label>
                      <input
                        className={inputCls}
                        placeholder="Defaults to issue identifier + title"
                        value={selectedWorkflow.target.freshLaneName ?? ""}
                        onChange={(e) =>
                          updateSelectedWorkflow((workflow) => ({
                            ...workflow,
                            target: {
                              ...workflow.target,
                              freshLaneName: e.target.value,
                            },
                          }))
                        }
                      />
                    </div>
                  ) : null}
                  {selectedWorkflow.target.type !== "employee_session" && selectedWorkflow.target.type !== "review_gate" ? (
                    <>
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
                    </>
                  ) : null}
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
                <div className="mt-3 text-[10px] text-muted-fg">
                  {selectedWorkflow.target.type === "employee_session"
                    ? "Direct employee sessions can reuse the person's ongoing chat, create a fresh session in the same lane, or create a fresh issue lane for fully isolated execution."
                    : selectedWorkflow.target.type === "worker_run"
                      ? "Worker runs are ideal when you want a delegated implementation path that can still hand back to a supervisor later."
                      : selectedWorkflow.target.type === "review_gate"
                        ? "Review gate is a manual approval-only target. For most supervised implementation flows, use employee_session or worker_run plus a supervisor step below."
                        : "Mission and PR-resolution targets keep the same webhook-first trigger semantics but change the execution engine."}
                </div>
              </div>

              <div className={cardCls}>
                <div className="mb-3 font-sans text-sm font-semibold text-fg">Execution Plan</div>
                <div className="mb-3 text-xs text-muted-fg/60 leading-relaxed">
                  Common path: move the issue to In Progress, launch delegated work, optionally create or wait for a PR, optionally route to a supervisor, then hand off to In Review and notify you in ADE.
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
                    <label className={labelCls}>Completion contract</label>
                    <select
                      className={selectCls}
                      value={visualPlan?.completionContract ?? defaultCompletionContract(selectedWorkflow.target.type)}
                      data-testid="linear-wait-target-select"
                      onChange={(e) => patchVisualPlan({ completionContract: e.target.value as CompletionContract })}
                      disabled={selectedWorkflow.target.type === "review_gate"}
                    >
                      <option value="complete_on_launch">Complete immediately after launch</option>
                      {selectedWorkflow.target.type !== "mission" ? (
                        <option value="wait_for_explicit_completion">Wait for explicit ADE completion</option>
                      ) : null}
                      {selectedWorkflow.target.type === "mission" || selectedWorkflow.target.type === "worker_run" ? (
                        <option value="wait_for_runtime_success">
                          {selectedWorkflow.target.type === "mission" ? "Wait for mission completion" : "Wait for runtime success"}
                        </option>
                      ) : null}
                      <option value="wait_for_pr_created">Wait for a PR to exist</option>
                      <option value="wait_for_review_ready">Wait for a PR to be review-ready</option>
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
                          ...rebuildWorkflowSteps(workflow, e.target.value === "none"
                            ? {
                                completionContract: completionContractUsesPrGate(deriveVisualPlan(workflow).completionContract)
                                  ? defaultCompletionContract(workflow.target.type)
                                  : deriveVisualPlan(workflow).completionContract,
                                prTiming: "none",
                              }
                            : { prTiming: deriveVisualPlan(workflow).prTiming === "none" ? "after_target_complete" : deriveVisualPlan(workflow).prTiming }),
                          target: {
                            ...workflow.target,
                            prStrategy:
                              e.target.value === "none"
                                ? null
                                : e.target.value === "manual"
                                  ? { kind: "manual" }
                                  : { kind: e.target.value as "integration" | "per-lane" | "queue", draft: true },
                            prTiming:
                              e.target.value === "none"
                                ? "none"
                                : workflow.target.prTiming === "none" || !workflow.target.prTiming
                                  ? "after_target_complete"
                                  : workflow.target.prTiming,
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
                    <label className={labelCls}>ADE-managed PR Timing</label>
                    <select
                      className={selectCls}
                      value={visualPlan?.prTiming ?? "none"}
                      data-testid="linear-pr-timing-select"
                      onChange={(e) => patchVisualPlan({ prTiming: e.target.value as VisualPlan["prTiming"] })}
                      disabled={!selectedWorkflow.target.prStrategy || selectedWorkflow.target.prStrategy.kind === "manual"}
                    >
                      <option value="after_start">Create or link a PR right after work starts</option>
                      <option value="after_target_complete">Create or link a PR after delegated work completes</option>
                      <option value="none">Do not manage PR timing here</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Block review-ready until</label>
                    <select
                      className={selectCls}
                      value={visualPlan?.reviewReadyWhen ?? "work_complete"}
                      data-testid="linear-review-ready-select"
                      onChange={(e) => patchVisualPlan({
                        completionContract:
                          e.target.value === "pr_ready"
                            ? "wait_for_review_ready"
                            : e.target.value === "pr_created"
                              ? "wait_for_pr_created"
                              : selectedWorkflow.target.type === "mission"
                                ? "wait_for_runtime_success"
                                : "wait_for_explicit_completion",
                      })}
                    >
                      <option value="work_complete">Delegated work completes</option>
                      <option value="pr_created">A PR exists</option>
                      <option value="pr_ready">A PR is ready for review</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Supervisor Path</label>
                    <select
                      className={selectCls}
                      value={visualPlan?.supervisorMode ?? "none"}
                      data-testid="linear-supervisor-mode-select"
                      disabled={selectedWorkflow.target.type === "review_gate"}
                      onChange={(e) => {
                        const nextMode = e.target.value as SupervisorMode;
                        patchVisualPlan(
                          nextMode === "before_pr" || nextMode === "after_pr"
                            ? {
                                supervisorMode: nextMode,
                                completionContract:
                                  visualPlan?.completionContract === "wait_for_review_ready"
                                    ? "wait_for_review_ready"
                                    : "wait_for_pr_created",
                              }
                            : { supervisorMode: nextMode }
                        );
                      }}
                    >
                      <option value="none">No supervisor step</option>
                      <option value="after_work">Send to supervisor after delegated work completes</option>
                      <option value="before_pr">Require supervisor approval before PR handoff</option>
                      <option value="after_pr">Require supervisor approval after PR handoff</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Supervisor</label>
                    <select
                      className={selectCls}
                      value={selectedSupervisorBinding}
                      data-testid="linear-supervisor-identity-select"
                      onChange={(e) => patchVisualPlan({ supervisorIdentityKey: e.target.value })}
                    >
                      {delegatedEmployeeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>If supervisor rejects</label>
                    <select
                      className={selectCls}
                      value={visualPlan?.rejectAction ?? "cancel"}
                      data-testid="linear-supervisor-reject-select"
                      onChange={(e) => patchVisualPlan({ rejectAction: e.target.value as LinearWorkflowReviewRejectionAction })}
                    >
                      <option value="loop_back">Request changes and loop back to delegated work</option>
                      <option value="reopen_issue">Reject and reopen the Linear issue</option>
                      <option value="cancel">Reject and cancel the workflow</option>
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
                    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3.5">
                      <div className="font-sans text-sm font-semibold text-fg">Notify in ADE</div>
                      <label className="mt-2 flex items-center gap-2 text-xs text-fg cursor-pointer">
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

                <div className="mt-3 text-xs text-muted-fg/50 leading-relaxed">
                  Direct workflows hand off to review-ready as soon as the configured work/PR milestone is met. Supervised workflows insert a real approval step so CTO or another ADE employee can approve, reject, or loop the issue back before closeout continues.
                </div>

                <div className="mt-4 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
                  <div className="mb-3 font-sans text-sm font-semibold text-fg">What Happens Next</div>
                  <div className="space-y-2">
                    {selectedWorkflow.steps.map((step, index) => (
                      <div key={step.id} className="flex items-start gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5">
                        <Chip>{index + 1}</Chip>
                        <div className="min-w-0">
                          <div className="font-sans text-xs font-semibold text-fg">{step.name ?? step.type}</div>
                          <div className="text-[10px] text-muted-fg/60 mt-0.5">
                            {step.type}
                            {step.type === "set_linear_state" && step.state ? ` -> ${step.state}` : ""}
                            {step.type === "wait_for_pr" && selectedWorkflow.target.prStrategy ? ` -> ${selectedWorkflow.target.prStrategy.kind}` : ""}
                            {step.type === "request_human_review" ? ` -> ${formatIdentityLabel(step.reviewerIdentityKey ?? null, availableEmployees)} (${step.rejectAction ?? "cancel"})` : ""}
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
                  <div className="mt-3 text-xs text-muted-fg/50">
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
                  <div className="mt-3 space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4" data-testid="linear-simulation-result">
                    <div className="text-xs text-fg">
                      Winner: {simulationResult.workflowName ?? "No match"} {simulationResult.target ? `-> ${simulationResult.target.type}` : ""}
                    </div>
                    <div className="text-xs text-muted-fg/60">{simulationResult.reason}</div>
                    {simulationResult.simulation?.explainsAndAcrossFields ? (
                      <div className="text-xs text-muted-fg/60">
                        Match semantics: at least one assignee match AND at least one workflow label match.
                      </div>
                    ) : null}
                    <div className="space-y-1.5">
                      {simulationResult.candidates.map((candidate) => (
                        <div key={candidate.workflowId} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                          <div className="flex items-center justify-between gap-2 text-xs text-fg">
                            <span>{candidate.workflowName}</span>
                            <Chip>{candidate.matched ? "fires" : "blocked"}</Chip>
                          </div>
                          {candidate.matchedSignals?.length ? (
                            <div className="mt-1 text-[10px] text-success">Matched: {candidate.matchedSignals.join(" · ")}</div>
                          ) : null}
                          {candidate.missingSignals?.length ? (
                            <div className="mt-1 text-[10px] text-warning">Missing: {candidate.missingSignals.join(" · ")}</div>
                          ) : null}
                          <div className="mt-1 text-[10px] text-muted-fg/60">{candidate.reasons.join(" · ")}</div>
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
                    <div className="mb-1 text-[10px] text-muted-fg uppercase">Current</div>
                    <textarea className={textareaCls} rows={14} value={diffPreview.before} readOnly spellCheck={false} />
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] text-muted-fg uppercase">Next</div>
                    <textarea className={textareaCls} rows={14} value={diffPreview.after} readOnly spellCheck={false} />
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <div className="text-xs text-muted-fg/50">
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

        <aside className="min-h-0 overflow-auto p-3" style={{ borderLeft: "1px solid rgba(167,139,250,0.06)", background: "rgba(12,10,20,0.3)" }}>
          <div className="space-y-3">
            {/* Pipeline — colored stage cards */}
            <div className="rounded-xl p-3" style={{ background: "rgba(24,20,35,0.5)", border: "1px solid rgba(96,165,250,0.08)" }}>
              <div className="flex items-center gap-2 mb-2.5">
                <div className="h-1.5 w-1.5 rounded-full" style={{ background: "#60A5FA" }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#60A5FA" }}>Pipeline</span>
              </div>
              <div className="space-y-1.5">
                {monitorStory.map((item, index) => {
                  const stageColors = ["#A78BFA", "#60A5FA", "#34D399", "#F472B6"];
                  const color = stageColors[index] ?? "#A78BFA";
                  return (
                    <div key={item.title} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2" style={{
                      background: item.done ? `${color}0A` : "transparent",
                      borderLeft: `2px solid ${item.done ? color : "rgba(255,255,255,0.04)"}`,
                    }}>
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-medium" style={{ color: item.done ? color : "rgba(255,255,255,0.35)" }}>{item.title}</div>
                      </div>
                      <div className="h-2 w-2 rounded-full shrink-0" style={{ background: item.done ? color : "rgba(255,255,255,0.06)" }} />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Ingress status — compact */}
            <div className="rounded-xl p-3" style={{ background: "rgba(24,20,35,0.5)", border: "1px solid rgba(251,191,36,0.08)" }}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full" style={{ background: "#FBBF24" }} />
                  <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#FBBF24" }}>Ingress</span>
                </div>
                <Button variant="ghost" size="sm" className="!h-5 !px-1.5 !text-[11px]" onClick={() => void ensureWebhook()} data-testid="linear-ensure-webhook-btn">
                  <Lightning size={9} />
                </Button>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-fg/35">Relay</span>
                  <span className="text-muted-fg/55">{ingressStatus ? formatEndpoint(ingressStatus.relay) : "..."}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-fg/35">Local</span>
                  <span className="text-muted-fg/55">{ingressStatus ? formatEndpoint(ingressStatus.localWebhook) : "..."}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-fg/35">Reconcile</span>
                  <span className="text-muted-fg/55">{ingressStatus?.reconciliation.enabled ? `${ingressStatus.reconciliation.intervalSec}s` : "off"}</span>
                </div>
              </div>
            </div>

            {/* Runs — colored */}
            <div className="rounded-xl p-3" style={{ background: "rgba(24,20,35,0.5)", border: "1px solid rgba(52,211,153,0.08)" }}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full" style={{ background: "#34D399" }} />
                  <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#34D399" }}>Runs</span>
                </div>
                {dashboard && (
                  <div className="flex items-center gap-1.5">
                    {[
                      { n: dashboard.queue.queued, color: "#60A5FA", label: "Q" },
                      { n: dashboard.queue.dispatched, color: "#FBBF24", label: "W" },
                      { n: dashboard.queue.escalated, color: "#F472B6", label: "R" },
                      { n: dashboard.queue.failed, color: "#EF4444", label: "F" },
                    ].map((s) => (
                      <span key={s.label} className="text-[11px] font-medium" style={{ color: s.n > 0 ? s.color : "rgba(255,255,255,0.12)" }} title={s.label}>
                        {s.n}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {queue.length ? (
                <div className="space-y-1">
                  {queue.slice(0, 6).map((item) => {
                    const statusColor = item.status === "resolved" ? "#34D399" : item.status === "escalated" ? "#F472B6" : item.status === "failed" ? "#EF4444" : "#60A5FA";
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedRunId(item.id)}
                        className={cn(
                          "w-full rounded-lg px-2.5 py-2 text-left transition-all duration-200",
                          selectedRunId === item.id ? "bg-white/[0.04]" : "hover:bg-white/[0.02]",
                        )}
                        style={{ borderLeft: `2px solid ${selectedRunId === item.id ? statusColor : "transparent"}` }}
                        data-testid={`linear-run-row-${item.id}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-fg/70 truncate">{item.identifier}</span>
                          <span className="text-[11px] font-medium shrink-0" style={{ color: statusColor }}>{formatQueueRunStatus(item)}</span>
                        </div>
                        <div className="text-xs text-muted-fg/30 truncate">{item.workflowName}</div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs text-muted-fg/25">No runs yet</div>
              )}
            </div>

            {/* Run detail — only if selected */}
            {selectedRunId && (
              <div className="rounded-xl p-3" style={{ background: "rgba(24,20,35,0.5)", border: "1px solid rgba(167,139,250,0.08)" }} data-testid="linear-run-timeline-card">
                <div className="flex items-center gap-2 mb-2">
                  <div className="h-1.5 w-1.5 rounded-full" style={{ background: "#A78BFA" }} />
                  <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#A78BFA" }}>Run Detail</span>
                  {selectedRunQueueItem && <Chip>{formatQueueRunStatus(selectedRunQueueItem)}</Chip>}
                </div>
                {runDetailLoading ? (
                  <div className="text-xs text-muted-fg/30">Loading...</div>
                ) : !selectedRunDetail ? (
                  <div className="text-xs text-muted-fg/30">Unavailable</div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1">
                      <Chip>{selectedRunDetail.run.identifier}</Chip>
                      <Chip>{selectedRunDetail.run.targetType}</Chip>
                    </div>

                    {selectedRunDetail.reviewContext && selectedRunDetail.run.status === "awaiting_human_review" ? (
                      <div className="rounded-lg p-3" style={{ background: "rgba(251,191,36,0.04)", border: "1px solid rgba(251,191,36,0.12)" }}>
                        <div className="text-[11px] font-medium" style={{ color: "#FBBF24" }}>Supervisor action needed</div>
                        <div className="mt-2">
                          <textarea className={textareaCls} rows={2} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="Note..." />
                        </div>
                        <div className="mt-2 flex gap-1.5">
                          <Button variant="primary" size="sm" onClick={() => void actOnRun("approve")} disabled={queueActionLoading !== null}>Approve</Button>
                          <Button variant="outline" size="sm" onClick={() => void actOnRun("reject")} disabled={queueActionLoading !== null}>Reject</Button>
                        </div>
                      </div>
                    ) : null}

                    {canMarkRunComplete ? (
                      <div className="rounded-lg p-3" style={{ background: "rgba(167,139,250,0.04)", border: "1px solid rgba(167,139,250,0.12)" }}>
                        <div className="text-[11px] font-medium" style={{ color: "#A78BFA" }}>Awaiting completion</div>
                        <div className="mt-2">
                          <textarea className={textareaCls} rows={2} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="Completion note..." />
                        </div>
                        <div className="mt-2">
                          <Button variant="primary" size="sm" onClick={() => void actOnRun("complete")} disabled={queueActionLoading !== null}>Complete</Button>
                        </div>
                      </div>
                    ) : null}

                    {(selectedRunDetail.run.status === "failed" || selectedRunDetail.run.status === "cancelled" || selectedRunDetail.run.status === "retry_wait") ? (
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => void actOnRun("retry")} disabled={queueActionLoading !== null}>Retry</Button>
                        {selectedRunDetail.run.lastError ? <span className="text-xs text-warning truncate">{selectedRunDetail.run.lastError}</span> : null}
                      </div>
                    ) : null}

                    <div className="space-y-1" data-testid="linear-run-timeline">
                      {selectedRunTimeline.map((entry) => (
                        <TimelineEntry key={entry.id} timestamp={entry.timestamp} title={entry.title} subtitle={entry.subtitle} status={entry.status} statusVariant={entry.statusVariant} defaultExpanded={false}>
                          {entry.payload ? (
                            <pre className="overflow-auto text-xs text-muted-fg whitespace-pre-wrap">{JSON.stringify(entry.payload, null, 2)}</pre>
                          ) : null}
                        </TimelineEntry>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Events — compact */}
            {ingressEvents.length > 0 && (
              <div className="rounded-xl p-3" style={{ background: "rgba(24,20,35,0.5)", border: "1px solid rgba(244,114,182,0.08)" }}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="h-1.5 w-1.5 rounded-full" style={{ background: "#F472B6" }} />
                  <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#F472B6" }}>Events</span>
                  <span className="text-[11px] text-muted-fg/25">{ingressEvents.length}</span>
                </div>
                <div className="space-y-1">
                  {ingressEvents.slice(0, 5).map((event) => (
                    <div key={event.id} className="flex items-center justify-between gap-2 py-1">
                      <span className="text-xs text-fg/50 truncate">{event.issueIdentifier ?? "update"}</span>
                      <span className="text-[11px] text-muted-fg/25 shrink-0">{event.source}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Footer info */}
            <div className="space-y-1 px-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-fg/25">Source</span>
                <span className="text-muted-fg/40">{policy.source === "repo" ? "Repo YAML" : "Generated"}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-fg/25">Linear</span>
                <span style={{ color: connection?.connected ? "#34D399" : "#EF4444" }}>{connection?.connected ? "Connected" : "Disconnected"}</span>
              </div>
              {revisions.length > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-fg/25">Last save</span>
                  <span className="text-muted-fg/40">{new Date(revisions[0].createdAt).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
