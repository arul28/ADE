import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  AgentIdentity,
  CtoFlowPolicyRevision,
  LinearConnectionStatus,
  LinearIngressEventRecord,
  LinearIngressStatus,
  LinearWorkflowMatchCandidate,
  LinearSyncDashboard,
  LinearSyncQueueItem,
  LinearWorkflowRunDetail,
  LinearWorkflowConfig,
  LinearWorkflowDefinition,
  LinearWorkflowTargetType,
} from "../../../shared/types";
import {
  createDefaultLinearWorkflowConfig,
  createWorkflowPreset,
} from "../../../shared/linearWorkflowPresets";
import { WorkflowListSidebar } from "./pipeline/WorkflowListSidebar";
import { OperationsSidebar } from "./pipeline/OperationsSidebar";
import { PipelineCanvas } from "./pipeline/PipelineCanvas";

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

function getTriggerGroupEntries(workflow: LinearWorkflowDefinition): Array<{ label: string; values: string[] }> {
  return [
    { label: "Assignees", values: workflow.triggers.assignees ?? [] },
    { label: "Labels", values: workflow.triggers.labels ?? [] },
    { label: "Project slugs", values: workflow.triggers.projectSlugs ?? [] },
    { label: "Team keys", values: workflow.triggers.teamKeys ?? [] },
    { label: "Priority", values: (workflow.triggers.priority ?? []).map((value) => String(value)) },
    {
      label: "State transitions",
      values: (workflow.triggers.stateTransitions ?? []).map((transition) => {
        const fromValues = (transition.from ?? []).join(", ");
        const toValues = (transition.to ?? []).join(", ");
        return fromValues.length ? `${fromValues} -> ${toValues}` : toValues;
      }),
    },
    { label: "Owner", values: workflow.triggers.owner ?? [] },
    { label: "Creator", values: workflow.triggers.creator ?? [] },
    { label: "Metadata tags", values: workflow.triggers.metadataTags ?? [] },
  ].filter((entry) => entry.values.length > 0);
}

export function describeTriggerSemantics(workflow: LinearWorkflowDefinition): string {
  const populatedGroups = getTriggerGroupEntries(workflow).length;
  if (!populatedGroups) {
    return "Add at least one trigger group before saving. Populated groups are OR-ed within the group and AND-ed across groups.";
  }
  if (populatedGroups === 1) {
    return "This workflow fires when the populated trigger group matches. Values inside the group are OR-ed.";
  }
  return "Each populated trigger group must match. Values inside a group are OR-ed.";
}

export function buildRunMatchSummary(detail: LinearWorkflowRunDetail): {
  reason: string;
  matchedSignals: string[];
  routeTags: string[];
  nextStepsPreview: string[];
  matchedCandidate: LinearWorkflowMatchCandidate | null;
} | null {
  const createdEvent = detail.events.find((event) => event.eventType === "run.created") ?? null;
  const payload = (createdEvent?.payload ?? null) as
    | {
        candidates?: LinearWorkflowMatchCandidate[];
        nextStepsPreview?: string[];
      }
    | null;
  const routeContext = detail.run.routeContext ?? null;
  const candidates = payload?.candidates ?? [];
  const matchedCandidate =
    candidates.find((candidate) => candidate.workflowId === detail.run.workflowId && candidate.matched) ??
    candidates.find((candidate) => candidate.matched) ??
    null;

  if (
    !createdEvent &&
    !matchedCandidate &&
    !(payload?.nextStepsPreview?.length ?? 0) &&
    !routeContext?.reason &&
    !(routeContext?.matchedSignals?.length ?? 0)
  ) {
    return null;
  }

  return {
    reason:
      createdEvent?.message?.trim() ||
      routeContext?.reason?.trim() ||
      `Matched workflow '${detail.run.workflowName}'.`,
    matchedSignals: uniqueValues([
      ...(matchedCandidate?.matchedSignals ?? []),
      ...(routeContext?.matchedSignals ?? []),
    ]),
    routeTags: uniqueValues([...(routeContext?.routeTags ?? [])]),
    nextStepsPreview: payload?.nextStepsPreview ?? [],
    matchedCandidate,
  };
}

export function deriveRunStallSummary(detail: LinearWorkflowRunDetail, queueItem?: LinearSyncQueueItem | null): string {
  const currentStep = detail.steps.find((step) => step.workflowStepId === detail.run.currentStepId) ?? null;
  const currentStepPayload = (currentStep?.payload ?? null) as Record<string, unknown> | null;
  const reviewInstructions = detail.reviewContext?.instructions?.trim() ?? "";
  const waitingFor = typeof currentStepPayload?.waitingFor === "string" ? currentStepPayload.waitingFor : null;
  const executionContext = detail.run.executionContext ?? null;
  const stalledReason = executionContext?.stalledReason?.trim() ?? "";
  const executionWaitingFor = executionContext?.waitingFor?.trim() ?? "";

  if (detail.run.status === "awaiting_delegation") {
    return "No employee could be resolved yet. Pick a delegation override, or update the workflow target.";
  }

  if (stalledReason) {
    return stalledReason;
  }

  if (detail.run.status === "retry_wait") {
    if (queueItem?.nextAttemptAt) {
      return `Retry is scheduled for ${new Date(queueItem.nextAttemptAt).toLocaleString()}.`;
    }
    return "Retry is waiting for the configured backoff to expire.";
  }

  if (detail.run.status === "awaiting_human_review") {
    return reviewInstructions.length
      ? `Waiting for supervisor review. ${reviewInstructions}`
      : "Waiting for supervisor review.";
  }

  if (currentStep?.type === "request_human_review") {
    return reviewInstructions.length
      ? `Supervisor review is required. ${reviewInstructions}`
      : "Supervisor review is required before the workflow can continue.";
  }

  if (currentStep?.type === "wait_for_target_status") {
    const waitTarget = waitingFor || executionWaitingFor;
    if (waitTarget === "explicit_completion" || currentStep.targetStatus === "explicit_completion") {
      return "Waiting for an explicit ADE completion signal.";
    }
    if (waitTarget) {
      return `Waiting for ${waitTarget.replace(/_/g, " ")}.`;
    }
    return "Waiting for delegated work to finish.";
  }

  if (currentStep?.type === "wait_for_pr") {
    return "Waiting for the linked pull request to become review-ready.";
  }

  if (detail.run.lastError?.trim()) {
    return detail.run.lastError.trim();
  }

  if (queueItem?.lastError?.trim()) {
    return queueItem.lastError.trim();
  }

  if (currentStep?.name) {
    return `Current step: ${currentStep.name}.`;
  }

  return "This run is waiting on the next workflow step.";
}

export function shouldShowDelegationOverride(status: LinearSyncQueueItem["status"] | "awaiting_delegation"): boolean {
  return status === "queued" || status === "retry_wait" || status === "escalated" || status === "awaiting_delegation";
}

function statusToVariant(
  status: string | null | undefined,
  fallback: "info" | "muted" = "info",
): "info" | "success" | "warning" | "error" | "muted" {
  switch (status) {
    case "failed": return "error";
    case "completed": return "success";
    case "waiting": return "warning";
    default: return fallback;
  }
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
    ...detail.events.map((event) => ({
      id: `event:${event.id}`,
      timestamp: event.createdAt,
      title: event.message?.trim() || event.eventType,
      subtitle: event.eventType,
      status: event.status ?? "event",
      statusVariant: statusToVariant(event.status, "info"),
      payload: event.payload ?? null,
    })),
    ...detail.steps
      .filter((step) => step.startedAt || step.completedAt)
      .map((step) => ({
        id: `step:${step.id}`,
        timestamp: step.completedAt ?? step.startedAt ?? detail.run.createdAt,
        title: step.name ?? step.workflowStepId,
        subtitle: step.type,
        status: step.status,
        statusVariant: statusToVariant(step.status, "muted"),
        payload: step.payload ?? null,
      })),
  ];

  return entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function LinearSyncPanel() {
  const navigate = useNavigate();
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [dashboard, setDashboard] = useState<LinearSyncDashboard | null>(null);
  const [policy, setPolicy] = useState<LinearWorkflowConfig>(createDefaultLinearWorkflowConfig());
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(createDefaultLinearWorkflowConfig().workflows[0]?.id ?? null);
  const [queue, setQueue] = useState<LinearSyncQueueItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<LinearWorkflowRunDetail | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [queueActionLoading, setQueueActionLoading] = useState<"approve" | "reject" | "retry" | "complete" | null>(null);
  const [revisions, setRevisions] = useState<CtoFlowPolicyRevision[]>([]);
  const [agents, setAgents] = useState<AgentIdentity[]>([]);
  const [ingressStatus, setIngressStatus] = useState<LinearIngressStatus | null>(null);
  const [ingressEvents, setIngressEvents] = useState<LinearIngressEventRecord[]>([]);
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

  const availableEmployees = useMemo(
    () => agents.filter((agent) => !agent.deletedAt),
    [agents]
  );

  const delegatedEmployeeOptions = useMemo(
    () => [
      { value: "cto", label: "CTO" },
      ...availableEmployees.map((agent) => ({ value: `agent:${agent.id}`, label: `${agent.name} (${agent.slug})` })),
    ],
    [availableEmployees]
  );

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
        const statusMessages: Record<string, string> = {
          approve: "Supervisor approval recorded.",
          reject: "Supervisor decision recorded.",
          complete: "Delegated work marked complete.",
          retry: "Workflow queued to retry.",
        };
        setStatusNote(statusMessages[action] ?? "Workflow updated.");
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
      const saved = await window.ade.cto.saveFlowPolicy({ policy, actor: "user" });
      hydrate(saved);
      await loadRuntimeState();
      setRevisions(await window.ade.cto.listFlowPolicyRevisions());
      setStatusNote("Workflow files saved to the repo.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [hydrate, loadRuntimeState, policy]);

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

  const addPreset = useCallback((targetType: LinearWorkflowTargetType) => {
    const id = `${targetType}-${Date.now().toString(36)}`;
    const workflow = createWorkflowPreset(targetType, { id });
    setPolicy((current) => ({ ...current, workflows: [...current.workflows, workflow] }));
    setSelectedWorkflowId(workflow.id);
  }, []);

  const selectedRunQueueItem = useMemo(
    () => queue.find((item) => item.id === selectedRunId) ?? null,
    [queue, selectedRunId]
  );
  const selectedRunCurrentStep = useMemo(
    () => selectedRunDetail?.steps.find((step) => step.workflowStepId === selectedRunDetail.run.currentStepId) ?? null,
    [selectedRunDetail]
  );
  const selectedRunMatchSummary = useMemo(
    () => (selectedRunDetail ? buildRunMatchSummary(selectedRunDetail) : null),
    [selectedRunDetail]
  );
  const selectedRunStallSummary = useMemo(
    () => (selectedRunDetail ? deriveRunStallSummary(selectedRunDetail, selectedRunQueueItem) : null),
    [selectedRunDetail, selectedRunQueueItem]
  );
  const selectedRunDelegationOverride = useMemo(
    () => delegationOverrides[selectedRunId ?? ""] ?? selectedRunQueueItem?.employeeOverride ?? selectedRunDetail?.run.executionContext?.employeeOverride ?? "",
    [delegationOverrides, selectedRunDetail, selectedRunId, selectedRunQueueItem]
  );
  const selectedRunDelegationStatus = selectedRunQueueItem?.status ?? (selectedRunDetail?.run.status === "awaiting_delegation" ? "awaiting_delegation" : null);
  const showDelegationOverride = selectedRunDelegationStatus ? shouldShowDelegationOverride(selectedRunDelegationStatus) : false;
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
        <WorkflowListSidebar
          connection={connection}
          workflows={policy.workflows}
          selectedWorkflowId={selectedWorkflowId}
          loading={loading}
          onSelectWorkflow={setSelectedWorkflowId}
          onAddPreset={addPreset}
          onRefresh={() => void loadAll()}
          onSyncNow={() => void runSyncNow()}
          onNavigateSettings={() => navigate("/settings?tab=integrations")}
        />

        <main className="min-h-0 overflow-auto p-4">
          {!selectedWorkflow ? (
            <div className="flex items-center justify-center h-full text-xs text-muted-fg/35">Select or create a workflow</div>
          ) : (
            <PipelineCanvas
              workflow={selectedWorkflow}
              onUpdateWorkflow={updateSelectedWorkflow}
              onSave={() => void savePolicy()}
              saving={saving}
              agents={delegatedEmployeeOptions}
            />
          )}
        </main>

        <OperationsSidebar
          dashboard={dashboard}
          ingressStatus={ingressStatus}
          queue={queue}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
          selectedRunDetail={selectedRunDetail}
          runDetailLoading={runDetailLoading}
          selectedRunQueueItem={selectedRunQueueItem}
          selectedRunMatchSummary={selectedRunMatchSummary}
          selectedRunStallSummary={selectedRunStallSummary}
          selectedRunDelegationOverride={selectedRunDelegationOverride}
          showDelegationOverride={showDelegationOverride}
          canMarkRunComplete={canMarkRunComplete}
          selectedRunTimeline={selectedRunTimeline}
          reviewNote={reviewNote}
          onReviewNoteChange={setReviewNote}
          queueActionLoading={queueActionLoading}
          delegatedEmployeeOptions={delegatedEmployeeOptions}
          onDelegationOverrideChange={(runId, value) => {
            setDelegationOverrides((current) => {
              const next = { ...current };
              if (value === null) {
                delete next[runId];
              } else {
                next[runId] = value;
              }
              return next;
            });
          }}
          policySource={policy.source}
          connection={connection}
          revisions={revisions}
          onActOnRun={(action) => void actOnRun(action)}
          onEnsureWebhook={() => void ensureWebhook()}
        />
      </div>
    </div>
  );
}
