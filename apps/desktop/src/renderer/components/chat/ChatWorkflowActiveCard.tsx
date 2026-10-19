import { useEffect, useMemo, useReducer, useState } from "react";
import { CaretRight, Check, Circle, CircleNotch, Stop, TreeStructure, X } from "@phosphor-icons/react";
import type { AgentChatWorkflowAgent, AgentChatWorkflowProgress } from "../../../shared/types";
import type { ChatWorkflowScriptPlan } from "../../../shared/chatWorkflowScript";
import { pluralCount } from "../../../shared/formatting";
import { cn } from "../ui/cn";
import { formatDurationMs, formatSubagentDurationMs } from "../../lib/format";
import { formatContextTokens } from "./usage/contextUsageModel";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";

export type ChatWorkflowRun = {
  id: string;
  name: string;
  parent: ChatSubagentSnapshot;
  progress: AgentChatWorkflowProgress;
  members: ChatSubagentSnapshot[];
};

type WorkflowStatus = ChatSubagentSnapshot["status"];

function workflowName(snapshot: ChatSubagentSnapshot): string {
  return snapshot.workflowName?.trim() || snapshot.description?.trim() || "Dynamic workflow";
}

function workflowAgentIndex(taskId: string, fallback: number): number {
  const match = /::a(\d+)$/.exec(taskId);
  return match ? Number(match[1]) : fallback;
}

function workflowLineageParentTaskId(taskId: string): string | undefined {
  const match = /^(.*)::a\d+$/.exec(taskId);
  return match?.[1] || undefined;
}

function fallbackWorkflowProgress(members: ChatSubagentSnapshot[]): AgentChatWorkflowProgress {
  const agents: AgentChatWorkflowAgent[] = members.map((snapshot, fallbackIndex) => ({
    key: snapshot.agentId ?? snapshot.taskId,
    index: workflowAgentIndex(snapshot.taskId, fallbackIndex),
    name: snapshot.label?.trim() || snapshot.agentType?.trim() || snapshot.description || `Agent #${fallbackIndex + 1}`,
    status: snapshot.status,
    summary: snapshot.finalSummary?.trim() || snapshot.summary?.trim() || snapshot.description || "Working",
    ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
    ...(snapshot.agentType ? { agentType: snapshot.agentType } : {}),
    ...(snapshot.model ? { model: snapshot.model } : {}),
    ...(snapshot.usage?.totalTokens !== undefined ? { tokens: snapshot.usage.totalTokens } : {}),
    ...(snapshot.usage?.toolUses !== undefined ? { toolCalls: snapshot.usage.toolUses } : {}),
    ...(snapshot.usage?.durationMs !== undefined ? { durationMs: snapshot.usage.durationMs } : {}),
    ...(snapshot.lastToolName ? { lastToolName: snapshot.lastToolName } : {}),
  })).sort((left, right) => left.index - right.index);
  return {
    phases: [],
    agents,
    queuedCount: 0,
    runningCount: agents.filter((agent) => agent.status === "running").length,
    doneCount: agents.filter((agent) => agent.status === "completed").length,
    failedCount: agents.filter((agent) => agent.status === "failed").length,
  };
}

/**
 * Groups the parent Workflow row with its synthetic workflow-agent rows. The
 * lineage ID keeps two workflows with the same display name independent; the
 * name fallback is only for older event histories that predate rich workflow
 * snapshots.
 */
export function deriveChatWorkflowRuns(snapshots: ChatSubagentSnapshot[]): ChatWorkflowRun[] {
  const directParents = snapshots.filter(
    (snapshot): snapshot is ChatSubagentSnapshot & { workflowProgress: AgentChatWorkflowProgress } => (
      snapshot.workflowProgress !== undefined
    ),
  );
  const directParentIds = new Set(directParents.map((snapshot) => snapshot.taskId));
  const snapshotIds = new Set(snapshots.map((snapshot) => snapshot.taskId));
  const lineageParentIds = new Set(
    snapshots
      .map((snapshot) => workflowLineageParentTaskId(snapshot.taskId))
      .filter((parentId): parentId is string => parentId !== undefined),
  );
  const claimedMemberIds = new Set<string>();
  const runs: ChatWorkflowRun[] = directParents.map((parent) => {
    // Snapshot derivation keys a workflow agent by its agentId, which drops the
    // `<taskId>::a<index>` lineage; the run's own roster names those agents.
    const rosterIds = new Set(
      parent.workflowProgress.agents.flatMap((agent) => (agent.agentId ? [agent.agentId, agent.key] : [agent.key])),
    );
    const members = snapshots.filter((snapshot) => (
      snapshot.taskId !== parent.taskId
      && (
        workflowLineageParentTaskId(snapshot.taskId) === parent.taskId
        || rosterIds.has(snapshot.taskId)
        || (snapshot.agentId !== undefined && rosterIds.has(snapshot.agentId))
      )
    ));
    members.forEach((member) => claimedMemberIds.add(member.taskId));
    return {
      id: parent.taskId,
      name: workflowName(parent),
      parent,
      progress: parent.workflowProgress,
      members,
    };
  });

  // Each workflow task is its own run with its own Stop, even when two share
  // a name. A legacy member that carries only the name joins the workflow of
  // that name when exactly one exists.
  const fallbackWorkflowIdsByName = new Map<string, string[]>();
  for (const snapshot of snapshots) {
    const name = snapshot.workflowName?.trim();
    if (!name || snapshot.taskType !== "local_workflow" || directParentIds.has(snapshot.taskId)) continue;
    fallbackWorkflowIdsByName.set(name, [...(fallbackWorkflowIdsByName.get(name) ?? []), snapshot.taskId]);
  }
  const fallbackGroups = new Map<string, ChatSubagentSnapshot[]>();
  for (const snapshot of snapshots) {
    const name = snapshot.workflowName?.trim();
    if (!name) continue;
    if (directParentIds.has(snapshot.taskId) || claimedMemberIds.has(snapshot.taskId)) continue;
    const lineageParentId = workflowLineageParentTaskId(snapshot.taskId);
    if (lineageParentId && directParentIds.has(lineageParentId)) continue;
    // A synthetic child without its parent is incomplete history, not a
    // stoppable workflow. Keep it out of the fallback so the renderer never
    // routes a stop action to the child's task ID.
    if (lineageParentId && !snapshotIds.has(lineageParentId)) continue;
    const namedWorkflowIds = fallbackWorkflowIdsByName.get(name) ?? [];
    const groupKey = lineageParentId
      ? "lineage:" + lineageParentId
      : lineageParentIds.has(snapshot.taskId) || snapshot.taskType === "local_workflow"
        ? "lineage:" + snapshot.taskId
        : namedWorkflowIds.length === 1
          ? "lineage:" + namedWorkflowIds[0]
          : "name:" + name;
    const group = fallbackGroups.get(groupKey) ?? [];
    group.push(snapshot);
    fallbackGroups.set(groupKey, group);
  }
  for (const [groupKey, group] of fallbackGroups) {
    const lineageParentId = groupKey.startsWith("lineage:")
      ? groupKey.slice("lineage:".length)
      : undefined;
    const parent = group.find((snapshot) => snapshot.taskId === lineageParentId)
      ?? group.find((snapshot) => snapshot.taskType === "local_workflow")
      ?? group[0];
    if (!parent) continue;
    const name = workflowName(parent);
    const members = group.filter((snapshot) => snapshot.taskId !== parent.taskId);
    runs.push({
      id: lineageParentId ? "workflow:" + lineageParentId : "workflow:" + name,
      name,
      parent,
      progress: fallbackWorkflowProgress(members),
      members,
    });
  }
  return runs.sort((left, right) => Date.parse(right.parent.updatedAt) - Date.parse(left.parent.updatedAt));
}

/** Task IDs for workflow parents, which are represented by the workflow card. */
/** Every snapshot a workflow run draws: its parent and its agents. */
export function workflowRunTaskIds(snapshots: ChatSubagentSnapshot[]): Set<string> {
  return new Set(deriveChatWorkflowRuns(snapshots).flatMap((run) => [
    run.parent.taskId,
    ...run.members.map((member) => member.taskId),
  ]));
}

function statusLabel(status: WorkflowStatus): string {
  switch (status) {
    case "completed": return "Complete";
    case "failed": return "Failed";
    case "stopped": return "Stopped";
    default: return "Active";
  }
}

function statusTone(status: WorkflowStatus): string {
  switch (status) {
    case "completed": return "text-emerald-200/85";
    case "failed": return "text-rose-200/90";
    case "stopped": return "text-amber-200/80";
    default: return "text-violet-200/95";
  }
}

function workflowDuration(run: ChatWorkflowRun, nowMs: number): number | null {
  const reported = run.parent.usage?.durationMs;
  const started = Date.parse(run.parent.startedAt);
  if (run.parent.status === "running") {
    if (Number.isFinite(started)) return Math.max(0, nowMs - started);
    return typeof reported === "number" && reported > 0 ? reported : null;
  }
  // A finished run's own span: Claude's reported duration_ms for a Workflow
  // task is not the run's wall time (a 16 s run reported 3 s).
  const end = Date.parse(run.parent.updatedAt);
  if (Number.isFinite(started) && Number.isFinite(end)) return Math.max(0, end - started);
  return typeof reported === "number" && reported > 0 ? reported : null;
}

/** Sums the roster when it carries numbers; the parent's usage is the fallback, not a total of its agents. */
function workflowTotals(run: ChatWorkflowRun): { tokens: number | null; tools: number | null } {
  const rosterTokens = run.progress.agents.reduce((total, agent) => total + (agent.tokens ?? 0), 0);
  const rosterTools = run.progress.agents.reduce((total, agent) => total + (agent.toolCalls ?? 0), 0);
  const parentTokens = run.parent.usage?.totalTokens;
  const parentTools = run.parent.usage?.toolUses;
  return {
    tokens: rosterTokens > 0 ? rosterTokens : parentTokens ?? null,
    tools: rosterTools > 0 ? rosterTools : parentTools ?? null,
  };
}

function agentMember(run: ChatWorkflowRun, agent: AgentChatWorkflowAgent): ChatSubagentSnapshot | undefined {
  return run.members.find((member) => (
    (agent.agentId && member.agentId === agent.agentId)
      || member.taskId === `${run.parent.taskId}::a${agent.index}`
      || member.taskId === agent.key
  ));
}

type WorkflowAgentDisplayStatus = AgentChatWorkflowAgent["status"];

type WorkflowAgentView = {
  agent: AgentChatWorkflowAgent;
  member?: ChatSubagentSnapshot;
  status: WorkflowAgentDisplayStatus;
  summary: string;
};

function workflowAgentViews(run: ChatWorkflowRun): WorkflowAgentView[] {
  return run.progress.agents.map((agent) => {
    const member = agentMember(run, agent);
    const status: WorkflowAgentDisplayStatus = member?.status === "failed"
      ? "failed"
      : member?.status === "stopped"
        ? "stopped"
        : member?.status === "completed"
          ? "completed"
          : run.parent.status !== "running" && agent.status === "running"
            ? "stopped"
            : agent.status;
    return {
      agent,
      member,
      status,
      summary: status === "stopped"
        ? member?.finalSummary?.trim() || member?.summary?.trim() || "Workflow ended before this agent finished."
        : agent.summary,
    };
  });
}

function workflowAgentCounts(views: WorkflowAgentView[]): {
  completed: number;
  failed: number;
  running: number;
  stopped: number;
} {
  return {
    completed: views.filter((view) => view.status === "completed").length,
    failed: views.filter((view) => view.status === "failed").length,
    running: views.filter((view) => view.status === "running").length,
    stopped: views.filter((view) => view.status === "stopped").length,
  };
}

function displayWorkflowModel(model: string | undefined | null): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^[^/]+\//, "");
}

function relativeActivityTime(timestamp: string | undefined, nowMs: number): string | null {
  if (!timestamp) return null;
  const activityMs = Date.parse(timestamp);
  if (!Number.isFinite(activityMs)) return null;
  const elapsedMs = Math.max(0, nowMs - activityMs);
  if (elapsedMs < 10_000) return "just now";
  if (elapsedMs < 60_000) return `${Math.floor(elapsedMs / 1_000)}s ago`;
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`;
  return `${Math.floor(elapsedMs / 3_600_000)}h ago`;
}

type WorkflowPhaseBlock = {
  title: string;
  rows: WorkflowAgentView[];
};

function workflowPhaseBlocks(
  phases: AgentChatWorkflowProgress["phases"],
  planPhases: readonly string[] | undefined,
  views: WorkflowAgentView[],
): { phases: WorkflowPhaseBlock[]; other: WorkflowAgentView[] } {
  const orderedTitles: string[] = [];
  const phaseTitles = new Set<string>();
  for (const phase of [...phases].sort((left, right) => left.index - right.index)) {
    if (phaseTitles.has(phase.title)) continue;
    phaseTitles.add(phase.title);
    orderedTitles.push(phase.title);
  }
  for (const title of planPhases ?? []) {
    if (phaseTitles.has(title)) continue;
    phaseTitles.add(title);
    orderedTitles.push(title);
  }

  const phaseRows = new Map<string, WorkflowAgentView[]>();
  for (const view of views) {
    const title = view.agent.phaseTitle;
    if (!title || !phaseTitles.has(title)) continue;
    const rows = phaseRows.get(title) ?? [];
    rows.push(view);
    phaseRows.set(title, rows);
  }

  return {
    phases: orderedTitles.map((title) => ({ title, rows: phaseRows.get(title) ?? [] })),
    other: views.filter((view) => !view.agent.phaseTitle || !phaseTitles.has(view.agent.phaseTitle)),
  };
}

function phaseDefaultExpanded(runStatus: WorkflowStatus, rows: readonly WorkflowAgentView[]): boolean {
  return runStatus === "running"
    ? rows.some((view) => view.status === "running" || view.status === "failed")
    : rows.some((view) => view.status === "failed" || view.status === "stopped");
}

function WorkflowStatusIcon({ status }: { status: WorkflowStatus | WorkflowAgentDisplayStatus }) {
  if (status === "completed") return <Check aria-hidden size={12} weight="bold" className="text-emerald-300/85" />;
  if (status === "failed") return <X aria-hidden size={12} weight="bold" className="text-rose-300/85" />;
  if (status === "stopped") return <Stop aria-hidden size={11} weight="fill" className="text-amber-300/80" />;
  return <CircleNotch aria-hidden size={12} className="motion-safe:animate-spin text-[color:var(--color-accent-bright,#C4B5FD)]/90 [animation-duration:1.25s]" />;
}

export function ChatWorkflowActiveCard({
  snapshots,
  plans,
  onSelectSubagent,
  onStopWorkflow,
}: {
  snapshots: ChatSubagentSnapshot[];
  /** Declared script plans, keyed by workflow task id (`meta.name`, `meta.phases`). */
  plans?: ReadonlyMap<string, ChatWorkflowScriptPlan>;
  onSelectSubagent?: (snapshot: ChatSubagentSnapshot) => void;
  onStopWorkflow?: (snapshot: ChatSubagentSnapshot) => void;
}) {
  const runs = useMemo(() => deriveChatWorkflowRuns(snapshots), [snapshots]);
  const [, refreshRelativeTimes] = useReducer((revision: number) => revision + 1, 0);
  const hasTimedRunningActivity = runs.some((run) => (
    run.parent.status === "running"
      && run.progress.agents.some((agent) => Boolean(agent.lastActivityAt))
  ));
  useEffect(() => {
    if (!hasTimedRunningActivity) return;
    const interval = window.setInterval(() => refreshRelativeTimes(), 5_000);
    return () => window.clearInterval(interval);
  }, [hasTimedRunningActivity, refreshRelativeTimes]);
  if (runs.length === 0) return null;
  const nowMs = Date.now();

  return (
    <section
      className="border-b border-fg/[0.04] pb-1"
      aria-label="Workflow activity"
      data-testid="chat-workflow-active-card-list"
    >
      <header className="flex items-center justify-between px-3.5 pb-1 pt-3">
        <span className="flex items-center gap-1.5 font-sans text-[10.5px] font-medium uppercase tracking-[0.06em] text-fg/45">
          <TreeStructure aria-hidden size={12} weight="bold" className="shrink-0 text-amber-300/75" />
          Workflow
        </span>
        {runs.length > 1 ? (
          <span className="font-sans text-[10.5px] tabular-nums text-fg/35">
            {pluralCount(runs.length, "run")}
          </span>
        ) : null}
      </header>
      <div className="space-y-px px-2">
        {runs.map((run) => (
          <WorkflowRunBlock
            key={run.id}
            run={run}
            plan={plans?.get(run.parent.taskId) ?? null}
            nowMs={nowMs}
            onSelectSubagent={onSelectSubagent}
            onStopWorkflow={onStopWorkflow}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One run, drawn inside the section — no box or dialog. Provider phases come
 * first, then any remaining phases declared by the script.
 */
function WorkflowRunBlock({
  run,
  plan,
  nowMs,
  onSelectSubagent,
  onStopWorkflow,
}: {
  run: ChatWorkflowRun;
  plan: ChatWorkflowScriptPlan | null;
  nowMs: number;
  onSelectSubagent?: (snapshot: ChatSubagentSnapshot) => void;
  onStopWorkflow?: (snapshot: ChatSubagentSnapshot) => void;
}) {
  const progress = run.progress;
  const views = useMemo(() => workflowAgentViews(run), [run]);
  const counts = workflowAgentCounts(views);
  const totals = workflowTotals(run);
  const total = views.length + progress.queuedCount;
  const durationMs = workflowDuration(run, nowMs);
  const running = run.parent.status === "running";
  const { phases, other } = useMemo(
    () => workflowPhaseBlocks(progress.phases, plan?.phases, views),
    [progress.phases, plan?.phases, views],
  );
  const [expandedPhases, setExpandedPhases] = useState<Record<string, boolean>>({});
  // No live telemetry: the script's own plan is what this run published.
  const plannedOnly = progress.agents.length === 0 && progress.queuedCount === 0;
  const phaseGroups = useMemo<WorkflowPhaseBlock[]>(
    () => other.length > 0 ? [...phases, { title: "Other", rows: other }] : phases,
    [other, phases],
  );

  return (
    <div data-testid="chat-workflow-run" data-workflow-name={run.name} className="min-w-0 rounded-md px-1.5 pb-1.5 pt-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] leading-5 text-fg/85" title={run.name}>
          {run.name}
        </span>
        {running && onStopWorkflow ? (
          <button
            type="button"
            onClick={() => onStopWorkflow(run.parent)}
            aria-label="Stop workflow"
            title="Stop workflow"
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-sans text-[10.5px] text-fg/45 transition-colors hover:bg-rose-500/10 hover:text-rose-200/90"
          >
            <Stop aria-hidden size={10} weight="fill" />
            Stop
          </button>
        ) : null}
      </div>
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 font-sans text-[10.5px] tabular-nums text-fg/40">
        <span className={cn("whitespace-nowrap", statusTone(run.parent.status))}>{statusLabel(run.parent.status)}</span>
        {durationMs !== null ? <span className="whitespace-nowrap">{formatDurationMs(durationMs)}</span> : null}
        {total > 0 ? <span className="whitespace-nowrap">{counts.completed}/{total} agents</span> : null}
        {counts.running > 0 ? <span className="whitespace-nowrap text-violet-200/70">{counts.running} running</span> : null}
        {counts.failed > 0 ? <span className="whitespace-nowrap text-rose-300/80">{counts.failed} failed</span> : null}
        {counts.stopped > 0 ? <span className="whitespace-nowrap">{counts.stopped} stopped</span> : null}
        {progress.queuedCount > 0 ? <span className="whitespace-nowrap">{progress.queuedCount} queued</span> : null}
        {totals.tokens !== null && totals.tokens > 0 ? <span className="whitespace-nowrap">{formatContextTokens(totals.tokens)} tok</span> : null}
        {totals.tools !== null ? <span className="whitespace-nowrap">{totals.tools} tools</span> : null}
      </div>

      {plannedOnly ? (
        <div className="mt-1 min-w-0" data-testid="chat-workflow-planned-phases">
          <div className="truncate whitespace-nowrap pl-0.5 font-sans text-[10.5px] text-fg/35">
            {running ? "Waiting for agent status…" : "No agent status was recorded"}
          </div>
          <div className="mt-0.5 space-y-0.5">
            {phaseGroups.map((phase) => (
              <PhaseRow
                key={phase.title}
                phase={phase}
                expanded={false}
                onToggle={() => undefined}
                onSelectSubagent={onSelectSubagent}
                nowMs={nowMs}
                pendingOnly
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-1 space-y-0.5">
          {phaseGroups.map((phase) => {
            const isPending = phase.rows.length === 0;
            const defaultExpanded = phaseDefaultExpanded(run.parent.status, phase.rows);
            const expanded = expandedPhases[phase.title] ?? defaultExpanded;
            return (
              <PhaseRow
                key={phase.title}
                phase={phase}
                expanded={expanded}
                onToggle={() => setExpandedPhases((current) => ({ ...current, [phase.title]: !expanded }))}
                onSelectSubagent={onSelectSubagent}
                nowMs={nowMs}
                pendingOnly={isPending}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function PhaseRow({
  phase,
  expanded,
  onToggle,
  onSelectSubagent,
  nowMs,
  pendingOnly,
}: {
  phase: WorkflowPhaseBlock;
  expanded: boolean;
  onToggle: () => void;
  onSelectSubagent?: (snapshot: ChatSubagentSnapshot) => void;
  nowMs: number;
  pendingOnly: boolean;
}) {
  const state = pendingOnly ? "pending" : phaseStateOfViews(phase.rows);
  const summary = (
    <>
      <PhaseStateIcon state={state} />
      <span className={cn("min-w-0 flex-1 truncate font-sans text-[11px]", pendingOnly ? "text-fg/35" : "text-fg/60")} title={phase.title}>
        {phase.title}
      </span>
      <span className="ml-auto shrink-0 text-right font-sans text-[10px] tabular-nums text-fg/35">
        {pendingOnly ? "—" : `${phase.rows.filter((view) => view.status === "completed").length}/${phase.rows.length}`}
      </span>
    </>
  );

  return (
    <div>
      {pendingOnly ? (
        <div className="flex min-w-0 items-center gap-1.5 px-1.5 py-1">{summary}</div>
      ) : (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-fg/[0.035]"
        >
          {summary}
        </button>
      )}
      {!pendingOnly && expanded ? (
        <div className="pl-1">
          {phase.rows.map((view) => (
            <WorkflowAgentRow
              key={`${view.agent.key}-${view.agent.index}`}
              view={view}
              onSelect={onSelectSubagent}
              nowMs={nowMs}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One agent of a run, with running activity or finished usage on a second line. */
function WorkflowAgentRow({
  view,
  onSelect,
  nowMs,
}: {
  view: WorkflowAgentView;
  onSelect?: (snapshot: ChatSubagentSnapshot) => void;
  nowMs: number;
}) {
  const { agent, member, status, summary } = view;
  const model = displayWorkflowModel(agent.model);
  // One detail line under the name, so a narrow pane never squeezes the name:
  // running → what it is doing now; completed → what it cost.
  const detail = (status === "running"
    ? [model, agent.lastToolName?.trim() || null, relativeActivityTime(agent.lastActivityAt, nowMs)]
    : status === "completed"
      ? [
        model,
        typeof agent.tokens === "number" ? formatContextTokens(agent.tokens) : null,
        typeof agent.toolCalls === "number" ? pluralCount(agent.toolCalls, "tool") : null,
        typeof agent.durationMs === "number" ? formatSubagentDurationMs(agent.durationMs) : null,
      ]
      : []
  ).filter((part): part is string => Boolean(part)).join(" · ");
  const rowTitle = [agent.name, model].filter((part): part is string => Boolean(part)).join(" · ");
  const summaryTone = status === "stopped" ? "text-amber-200/75" : "text-rose-200/80";
  const content = (
    <span className="flex w-full min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0"><WorkflowStatusIcon status={status} /></span>
        <span className="min-w-0 flex-1 truncate font-sans text-[11.5px] text-fg/75">{agent.name}</span>
        {member ? <CaretRight aria-hidden size={11} className="shrink-0 text-fg/25 group-hover:text-fg/60" /> : null}
      </span>
      {detail ? (
        <span className="truncate pl-[22px] text-left font-sans text-[10.5px] tabular-nums text-fg/40">{detail}</span>
      ) : null}
      {(status === "failed" || status === "stopped") && summary ? (
        <span className={cn("truncate pl-[22px] text-left font-sans text-[10.5px]", summaryTone)} title={summary}>
          {summary}
        </span>
      ) : null}
    </span>
  );
  return member && onSelect ? (
    <button
      type="button"
      onClick={() => onSelect(member)}
      aria-label={`Open ${agent.name} details`}
      title={rowTitle}
      data-testid="chat-workflow-agent-row"
      className="group flex w-full min-w-0 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-fg/[0.045]"
    >
      {content}
    </button>
  ) : (
    <div className="flex min-w-0 px-1.5 py-1" title={rowTitle} data-testid="chat-workflow-agent-row">{content}</div>
  );
}

function phaseStateOfViews(views: readonly WorkflowAgentView[]): "pending" | "running" | "done" | "failed" | "stopped" {
  if (views.length === 0) return "pending";
  if (views.some((view) => view.status === "failed")) return "failed";
  if (views.some((view) => view.status === "stopped")) return "stopped";
  if (views.some((view) => view.status === "running")) return "running";
  return "done";
}

function PhaseStateIcon({ state }: { state: "pending" | "running" | "done" | "failed" | "stopped" }) {
  if (state === "done") return <Check aria-hidden size={11} weight="bold" className="shrink-0 text-emerald-300/85" />;
  if (state === "failed") return <X aria-hidden size={11} weight="bold" className="shrink-0 text-rose-300/85" />;
  if (state === "stopped") {
    return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300/70" />;
  }
  if (state === "running") {
    return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent-bright,#C4B5FD)]" />;
  }
  return <Circle aria-hidden size={11} className="shrink-0 text-fg/30" />;
}

