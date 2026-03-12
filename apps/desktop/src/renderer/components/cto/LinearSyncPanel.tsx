import React, { useCallback, useEffect, useMemo, useState } from "react";
import YAML from "yaml";
import {
  ArrowClockwise,
  FloppyDisk,
  Lightning,
  Plus,
  Shuffle,
} from "@phosphor-icons/react";
import type {
  CtoFlowPolicyRevision,
  LinearConnectionStatus,
  LinearRouteDecision,
  LinearSyncDashboard,
  LinearSyncQueueItem,
  LinearWorkflowConfig,
  LinearWorkflowDefinition,
  LinearWorkflowTargetType,
} from "../../../shared/types";
import { LinearConnectionPanel } from "./LinearConnectionPanel";
import { Button } from "../ui/Button";
import { PaneHeader } from "../ui/PaneHeader";
import { Chip } from "../ui/Chip";
import { inputCls, labelCls, recessedPanelCls, selectCls, textareaCls, cardCls } from "./shared/designTokens";
import { cn } from "../ui/cn";

function joinList(values: string[] | null | undefined): string {
  return (values ?? []).join(", ");
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function workerSelectorValue(selector: LinearWorkflowDefinition["target"]["workerSelector"]): string {
  return selector && "value" in selector ? selector.value : "";
}

function createDefaultPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "generated",
    settings: {
      ctoLinearAssigneeName: "CTO",
      ctoLinearAssigneeAliases: ["cto"],
    },
    workflows: [
      {
        id: "cto-mission-autopilot",
        name: "CTO -> Mission autopilot",
        enabled: true,
        priority: 100,
        description: "Default mission-backed workflow for CTO-assigned issues.",
        source: "generated",
        triggers: {
          assignees: ["CTO"],
        },
        target: {
          type: "mission",
          runMode: "autopilot",
          missionTemplate: "default",
        },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch mission" },
          { id: "wait", type: "wait_for_target_status", name: "Wait for mission", targetStatus: "completed" },
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: {
          successState: "done",
          failureState: "blocked",
          applyLabels: ["ade"],
          resolveOnSuccess: true,
          reopenOnFailure: true,
          artifactMode: "links",
        },
        retry: { maxAttempts: 3, baseDelaySec: 30 },
        concurrency: { maxActiveRuns: 5, perIssue: 1 },
        observability: { emitNotifications: true, captureIssueSnapshot: true, persistTimeline: true },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: true },
    legacyConfig: null,
  };
}

function createPreset(targetType: LinearWorkflowTargetType): LinearWorkflowDefinition {
  const base = {
    id: `workflow-${targetType}-${Date.now()}`,
    enabled: true,
    priority: 100,
    source: "generated" as const,
    triggers: { assignees: ["CTO"] },
    closeout: {
      successState: "done" as const,
      failureState: "blocked" as const,
      applyLabels: ["ade"],
      resolveOnSuccess: true,
      reopenOnFailure: true,
      artifactMode: "links" as const,
    },
    retry: { maxAttempts: 3, baseDelaySec: 30 },
    concurrency: { maxActiveRuns: 5, perIssue: 1 },
    observability: { emitNotifications: true, captureIssueSnapshot: true, persistTimeline: true },
  };

  if (targetType === "employee_session") {
    return {
      ...base,
      id: "cto-direct-employee-session",
      name: "CTO -> Direct employee session",
      description: "Open a direct tracked employee chat/session.",
      target: { type: targetType, runMode: "assisted" },
      steps: [
        { id: "launch", type: "launch_target", name: "Open employee session" },
        { id: "wait", type: "wait_for_target_status", name: "Wait for session close", targetStatus: "completed" },
        { id: "complete", type: "complete_issue", name: "Complete issue" },
      ],
    };
  }
  if (targetType === "pr_resolution") {
    return {
      ...base,
      id: "cto-pr-fast-lane",
      name: "CTO -> PR-only fast lane",
      description: "Launch a direct PR-oriented worker run.",
      target: { type: targetType, runMode: "autopilot" },
      steps: [
        { id: "launch", type: "launch_target", name: "Launch PR flow" },
        { id: "wait", type: "wait_for_pr", name: "Wait for PR" },
        { id: "complete", type: "complete_issue", name: "Complete issue" },
      ],
    };
  }
  if (targetType === "review_gate") {
    return {
      ...base,
      id: "cto-human-review-gate",
      name: "CTO -> Human review gate",
      description: "Track the issue but stop at a human approval gate.",
      target: { type: targetType, runMode: "manual" },
      steps: [
        { id: "launch", type: "launch_target", name: "Create review gate" },
        { id: "review", type: "request_human_review", name: "Wait for approval" },
        { id: "complete", type: "complete_issue", name: "Complete issue" },
      ],
    };
  }
  if (targetType === "worker_run") {
    return {
      ...base,
      id: "cto-worker-run",
      name: "CTO -> Direct worker run",
      description: "Launch a worker execution path without creating a mission.",
      target: { type: targetType, runMode: "autopilot" },
      steps: [
        { id: "launch", type: "launch_target", name: "Launch worker" },
        { id: "wait", type: "wait_for_target_status", name: "Wait for worker", targetStatus: "completed" },
        { id: "complete", type: "complete_issue", name: "Complete issue" },
      ],
    };
  }
  return createDefaultPolicy().workflows[0]!;
}

export function LinearSyncPanel() {
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [dashboard, setDashboard] = useState<LinearSyncDashboard | null>(null);
  const [policy, setPolicy] = useState<LinearWorkflowConfig>(createDefaultPolicy());
  const [loadedPolicy, setLoadedPolicy] = useState<LinearWorkflowConfig>(createDefaultPolicy());
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(createDefaultPolicy().workflows[0]?.id ?? null);
  const [queue, setQueue] = useState<LinearSyncQueueItem[]>([]);
  const [revisions, setRevisions] = useState<CtoFlowPolicyRevision[]>([]);
  const [simulationInput, setSimulationInput] = useState(
    JSON.stringify(
      {
        identifier: "SIM-42",
        title: "Fix flaky auth test on CI",
        description: "Auth integration test intermittently fails.",
        labels: ["bug", "fast-lane"],
        assigneeName: "CTO",
        priorityLabel: "high",
        projectSlug: "my-project",
      },
      null,
      2
    )
  );
  const [simulationResult, setSimulationResult] = useState<LinearRouteDecision | null>(null);
  const [advancedYaml, setAdvancedYaml] = useState("");
  const [advancedMode, setAdvancedMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  const selectedWorkflow = useMemo(
    () => policy.workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? policy.workflows[0] ?? null,
    [policy.workflows, selectedWorkflowId]
  );

  useEffect(() => {
    if (!selectedWorkflow) {
      setAdvancedYaml("");
      return;
    }
    setAdvancedYaml(YAML.stringify(selectedWorkflow, { indent: 2 }));
  }, [selectedWorkflow]);

  const hydrate = useCallback((nextPolicy: LinearWorkflowConfig) => {
    setPolicy(nextPolicy);
    setLoadedPolicy(nextPolicy);
    setSelectedWorkflowId((current) => current && nextPolicy.workflows.some((workflow) => workflow.id === current)
      ? current
      : nextPolicy.workflows[0]?.id ?? null);
  }, []);

  const loadAll = useCallback(async () => {
    if (!window.ade?.cto) return;
    setLoading(true);
    setError(null);
    try {
      const [conn, pol, dash, q, revs] = await Promise.all([
        window.ade.cto.getLinearConnectionStatus(),
        window.ade.cto.getFlowPolicy(),
        window.ade.cto.getLinearSyncDashboard(),
        window.ade.cto.listLinearSyncQueue(),
        window.ade.cto.listFlowPolicyRevisions(),
      ]);
      setConnection(conn);
      setDashboard(dash);
      setQueue(q);
      setRevisions(revs);
      hydrate(pol);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow data.");
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const updateSelectedWorkflow = useCallback((updater: (workflow: LinearWorkflowDefinition) => LinearWorkflowDefinition) => {
    if (!selectedWorkflowId) return;
    setPolicy((current) => ({
      ...current,
      workflows: current.workflows.map((workflow) => workflow.id === selectedWorkflowId ? updater(workflow) : workflow),
    }));
  }, [selectedWorkflowId]);

  const savePolicy = useCallback(async () => {
    if (!window.ade?.cto) return;
    setSaving(true);
    setError(null);
    setStatusNote(null);
    try {
      const nextPolicy = advancedMode && selectedWorkflow
        ? {
            ...policy,
            workflows: policy.workflows.map((workflow) => workflow.id === selectedWorkflow.id ? YAML.parse(advancedYaml) as LinearWorkflowDefinition : workflow),
          }
        : policy;
      const saved = await window.ade.cto.saveFlowPolicy({ policy: nextPolicy, actor: "user" });
      hydrate(saved);
      setDashboard(await window.ade.cto.getLinearSyncDashboard());
      setRevisions(await window.ade.cto.listFlowPolicyRevisions());
      setStatusNote("Workflow files saved to the repo.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [advancedMode, advancedYaml, hydrate, policy, selectedWorkflow]);

  const runSyncNow = useCallback(async () => {
    if (!window.ade?.cto) return;
    setError(null);
    try {
      const [dash, q] = await Promise.all([
        window.ade.cto.runLinearSyncNow(),
        window.ade.cto.listLinearSyncQueue(),
      ]);
      setDashboard(dash);
      setQueue(q);
      setStatusNote("Workflow intake and dispatch cycle completed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    }
  }, []);

  const simulate = useCallback(async () => {
    if (!window.ade?.cto) return;
    setError(null);
    try {
      const result = await window.ade.cto.simulateFlowRoute({ issue: JSON.parse(simulationInput) });
      setSimulationResult(result);
      setStatusNote("Simulation updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed.");
      setSimulationResult(null);
    }
  }, [simulationInput]);

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

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="linear-sync-panel">
      <PaneHeader
        title="Linear Workflows"
        meta="Repo-owned YAML workflows with simulation, save preview, and workflow-run visibility."
        right={(
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void runSyncNow()} disabled={loading}>
              <Lightning size={10} />
              Sync now
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

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_340px]">
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
                <Button variant="outline" size="sm" onClick={() => addPreset("mission")}><Plus size={10} /> Mission</Button>
                <Button variant="outline" size="sm" onClick={() => addPreset("employee_session")}><Plus size={10} /> Employee Session</Button>
                <Button variant="outline" size="sm" onClick={() => addPreset("worker_run")}><Plus size={10} /> Worker Run</Button>
                <Button variant="outline" size="sm" onClick={() => addPreset("pr_resolution")}><Plus size={10} /> PR Fast Lane</Button>
                <Button variant="outline" size="sm" onClick={() => addPreset("review_gate")}><Plus size={10} /> Review Gate</Button>
              </div>
            </div>
          </div>
        </aside>

        <main className="min-h-0 overflow-auto p-4">
          {!selectedWorkflow ? (
            <div className={cardCls}>No workflow selected.</div>
          ) : (
            <div className="space-y-4">
              <div className={cardCls}>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className={labelCls}>Workflow Name</label>
                    <input className={inputCls} value={selectedWorkflow.name} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, name: e.target.value }))} />
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
                    <textarea className={textareaCls} rows={2} value={selectedWorkflow.description ?? ""} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, description: e.target.value }))} />
                  </div>
                  <label className="flex items-center gap-2 font-mono text-[10px] text-fg">
                    <input type="checkbox" checked={selectedWorkflow.enabled} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, enabled: e.target.checked }))} />
                    Enabled
                  </label>
                </div>
              </div>

              <div className={cardCls}>
                <div className="mb-3 font-sans text-sm font-semibold text-fg">Trigger</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className={labelCls}>Assignees</label>
                    <input className={inputCls} value={joinList(selectedWorkflow.triggers.assignees)} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, triggers: { ...workflow.triggers, assignees: splitList(e.target.value) } }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Labels</label>
                    <input className={inputCls} value={joinList(selectedWorkflow.triggers.labels)} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, triggers: { ...workflow.triggers, labels: splitList(e.target.value) } }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Project Slugs</label>
                    <input className={inputCls} value={joinList(selectedWorkflow.triggers.projectSlugs)} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, triggers: { ...workflow.triggers, projectSlugs: splitList(e.target.value) } }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Team Keys</label>
                    <input className={inputCls} value={joinList(selectedWorkflow.triggers.teamKeys)} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, triggers: { ...workflow.triggers, teamKeys: splitList(e.target.value) } }))} />
                  </div>
                  <div className="md:col-span-2">
                    <label className={labelCls}>Metadata Tags</label>
                    <input className={inputCls} value={joinList(selectedWorkflow.triggers.metadataTags)} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, triggers: { ...workflow.triggers, metadataTags: splitList(e.target.value) } }))} />
                  </div>
                </div>
              </div>

              <div className={cardCls}>
                <div className="mb-3 font-sans text-sm font-semibold text-fg">Execution Target</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className={labelCls}>Target Type</label>
                    <select className={selectCls} value={selectedWorkflow.target.type} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, target: { ...workflow.target, type: e.target.value as LinearWorkflowTargetType } }))}>
                      <option value="mission">mission</option>
                      <option value="employee_session">employee_session</option>
                      <option value="worker_run">worker_run</option>
                      <option value="pr_resolution">pr_resolution</option>
                      <option value="review_gate">review_gate</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Run Mode</label>
                    <select className={selectCls} value={selectedWorkflow.target.runMode ?? "autopilot"} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, target: { ...workflow.target, runMode: e.target.value as LinearWorkflowDefinition["target"]["runMode"] } }))}>
                      <option value="autopilot">autopilot</option>
                      <option value="assisted">assisted</option>
                      <option value="manual">manual</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Worker Selector Mode</label>
                    <select className={selectCls} value={selectedWorkflow.target.workerSelector?.mode ?? "none"} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, target: { ...workflow.target, workerSelector: e.target.value === "none" ? { mode: "none" } : { mode: e.target.value as "id" | "slug" | "capability", value: workerSelectorValue(workflow.target.workerSelector) } } }))}>
                      <option value="none">none</option>
                      <option value="slug">slug</option>
                      <option value="id">id</option>
                      <option value="capability">capability</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Worker Selector Value</label>
                    <input className={inputCls} value={workerSelectorValue(selectedWorkflow.target.workerSelector)} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, target: { ...workflow.target, workerSelector: workflow.target.workerSelector && workflow.target.workerSelector.mode !== "none" ? { ...workflow.target.workerSelector, value: e.target.value } : { mode: "slug", value: e.target.value } } }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Mission Template</label>
                    <input className={inputCls} value={selectedWorkflow.target.missionTemplate ?? ""} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, target: { ...workflow.target, missionTemplate: e.target.value } }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Session Template</label>
                    <input className={inputCls} value={selectedWorkflow.target.sessionTemplate ?? ""} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, target: { ...workflow.target, sessionTemplate: e.target.value } }))} />
                  </div>
                </div>
                <div className="mt-3 rounded border border-border/20 bg-surface-recessed p-3 font-mono text-[10px] text-muted-fg">
                  What happens next: {selectedWorkflow.steps.map((step) => step.name ?? step.type).join(" -> ")}
                </div>
              </div>

              <div className={cardCls}>
                <div className="mb-3 font-sans text-sm font-semibold text-fg">Closeout</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className={labelCls}>Success State</label>
                    <select className={selectCls} value={selectedWorkflow.closeout?.successState ?? "done"} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, closeout: { ...(workflow.closeout ?? {}), successState: e.target.value as NonNullable<LinearWorkflowDefinition["closeout"]>["successState"] } }))}>
                      <option value="done">done</option>
                      <option value="in_review">in_review</option>
                      <option value="in_progress">in_progress</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Failure State</label>
                    <select className={selectCls} value={selectedWorkflow.closeout?.failureState ?? "blocked"} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, closeout: { ...(workflow.closeout ?? {}), failureState: e.target.value as NonNullable<LinearWorkflowDefinition["closeout"]>["failureState"] } }))}>
                      <option value="blocked">blocked</option>
                      <option value="todo">todo</option>
                      <option value="canceled">canceled</option>
                    </select>
                  </div>
                  <div className="md:col-span-2">
                    <label className={labelCls}>Labels On Closeout</label>
                    <input className={inputCls} value={joinList(selectedWorkflow.closeout?.applyLabels)} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, closeout: { ...(workflow.closeout ?? {}), applyLabels: splitList(e.target.value) } }))} />
                  </div>
                </div>
              </div>

              <div className={cardCls}>
                <div className="mb-3 flex items-center justify-between">
                  <div className="font-sans text-sm font-semibold text-fg">Safety</div>
                  <Button variant="ghost" size="sm" onClick={() => setAdvancedMode((value) => !value)}>
                    <Shuffle size={10} />
                    {advancedMode ? "Hide Advanced" : "Advanced YAML"}
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className={labelCls}>Max Attempts</label>
                    <input className={inputCls} type="number" value={selectedWorkflow.retry?.maxAttempts ?? 3} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, retry: { ...(workflow.retry ?? {}), maxAttempts: Number(e.target.value) || 0 } }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Max Active Runs</label>
                    <input className={inputCls} type="number" value={selectedWorkflow.concurrency?.maxActiveRuns ?? 5} onChange={(e) => updateSelectedWorkflow((workflow) => ({ ...workflow, concurrency: { ...(workflow.concurrency ?? {}), maxActiveRuns: Number(e.target.value) || 1 } }))} />
                  </div>
                </div>
                {advancedMode ? (
                  <div className="mt-3">
                    <label className={labelCls}>Workflow YAML</label>
                    <textarea className={textareaCls} rows={18} value={advancedYaml} onChange={(e) => setAdvancedYaml(e.target.value)} spellCheck={false} />
                  </div>
                ) : null}
              </div>

              <div className={cardCls}>
                <div className="mb-3 flex items-center justify-between">
                  <div className="font-sans text-sm font-semibold text-fg">Simulation</div>
                  <Button variant="outline" size="sm" onClick={() => void simulate()} data-testid="linear-simulate-btn">
                    <Lightning size={10} />
                    Simulate
                  </Button>
                </div>
                <textarea className={textareaCls} rows={10} value={simulationInput} onChange={(e) => setSimulationInput(e.target.value)} spellCheck={false} />
                {simulationResult ? (
                  <div className="mt-3 space-y-2 rounded border border-border/20 bg-surface-recessed p-3" data-testid="linear-simulation-result">
                    <div className="font-mono text-[10px] text-fg">
                      Winner: {simulationResult.workflowName ?? "No match"} {simulationResult.target ? `-> ${simulationResult.target.type}` : ""}
                    </div>
                    <div className="font-mono text-[10px] text-muted-fg">{simulationResult.reason}</div>
                    <div className="space-y-1">
                      {simulationResult.candidates.map((candidate) => (
                        <div key={candidate.workflowId} className="rounded border border-border/20 bg-surface px-2 py-1">
                          <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-fg">
                            <span>{candidate.workflowName}</span>
                            <Chip>{candidate.matched ? "match" : "reject"}</Chip>
                          </div>
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
                  <Button variant="primary" size="sm" onClick={() => void savePolicy()} disabled={saving}>
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
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
