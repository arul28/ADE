import { useMemo } from "react";
import { CaretRight, Check, CircleNotch, Stop, TreeStructure, X } from "@phosphor-icons/react";
import type { AgentChatWorkflowAgent, AgentChatWorkflowPhase, AgentChatWorkflowProgress } from "../../../shared/types";
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
  const runs: ChatWorkflowRun[] = directParents.map((parent) => {
    const members = snapshots.filter((snapshot) => workflowLineageParentTaskId(snapshot.taskId) === parent.taskId);
    return {
      id: parent.taskId,
      name: workflowName(parent),
      parent,
      progress: parent.workflowProgress,
      members,
    };
  });

  const fallbackGroups = new Map<string, ChatSubagentSnapshot[]>();
  for (const snapshot of snapshots) {
    const name = snapshot.workflowName?.trim();
    if (!name) continue;
    if (directParentIds.has(snapshot.taskId)) continue;
    const lineageParentId = workflowLineageParentTaskId(snapshot.taskId);
    if (lineageParentId && directParentIds.has(lineageParentId)) continue;
    // A synthetic child without its parent is incomplete history, not a
    // stoppable workflow. Keep it out of the fallback so the renderer never
    // routes a stop action to the child's task ID.
    if (lineageParentId && !snapshotIds.has(lineageParentId)) continue;
    const groupKey = lineageParentId
      ? "lineage:" + lineageParentId
      : lineageParentIds.has(snapshot.taskId)
        ? "lineage:" + snapshot.taskId
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
  if (typeof reported === "number" && reported > 0) return reported;
  if (!Number.isFinite(started)) return null;
  const end = Date.parse(run.parent.updatedAt);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - started);
}

function workflowTotals(run: ChatWorkflowRun): { tokens: number | null; tools: number | null } {
  const parentTokens = run.parent.usage?.totalTokens;
  const parentTools = run.parent.usage?.toolUses;
  return {
    tokens: typeof parentTokens === "number"
      ? parentTokens
      : run.progress.agents.reduce((total, agent) => total + (agent.tokens ?? 0), 0) || null,
    tools: typeof parentTools === "number"
      ? parentTools
      : run.progress.agents.reduce((total, agent) => total + (agent.toolCalls ?? 0), 0) || null,
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
  if (runs.length === 0) return null;

  return (
    <section
      className="border-b border-fg/[0.04] pb-1"
      aria-label="Workflow activity"
      data-testid="chat-workflow-active-card-list"
    >
      <header className="flex items-center justify-between px-3.5 pb-1 pt-3">
        <span className="flex items-center gap-1.5 font-sans text-[10.5px] font-medium uppercase tracking-[0.06em] text-fg/45">
          <TreeStructure aria-hidden size={12} weight="bold" className="shrink-0 text-amber-300/75" />
          Workflow activity
        </span>
        <span className="font-sans text-[10.5px] tabular-nums text-fg/35">
          {runs.length} tracked
        </span>
      </header>
      <div className="space-y-px px-2">
        {runs.map((run) => (
          <WorkflowRunBlock
            key={run.id}
            run={run}
            plan={plans?.get(run.parent.taskId) ?? null}
            onSelectSubagent={onSelectSubagent}
            onStopWorkflow={onStopWorkflow}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One run, drawn inside the section — no box, no dialog: the run's name and
 * state, then one quiet block per phase with its agent rows (same vocabulary as
 * the transcript's workflow run). A run whose provider published no
 * `workflow_progress` shows the phases its *script* declares instead, marked as
 * the plan it is; a running run carries its own Stop.
 */
function WorkflowRunBlock({
  run,
  plan,
  onSelectSubagent,
  onStopWorkflow,
}: {
  run: ChatWorkflowRun;
  plan: ChatWorkflowScriptPlan | null;
  onSelectSubagent?: (snapshot: ChatSubagentSnapshot) => void;
  onStopWorkflow?: (snapshot: ChatSubagentSnapshot) => void;
}) {
  const progress = run.progress;
  const views = workflowAgentViews(run);
  const counts = workflowAgentCounts(views);
  const totals = workflowTotals(run);
  const total = views.length + progress.queuedCount;
  const durationMs = workflowDuration(run, Date.now());
  const running = run.parent.status === "running";
  const phaseOfIndex = new Map<number, string>();
  for (const agent of progress.agents) {
    if (agent.phaseTitle) phaseOfIndex.set(agent.index, agent.phaseTitle);
  }
  const claimed = new Set<number>();
  const blocks = progress.phases.map((phase) => {
    const rows = views.filter((view) => {
      const title = phaseOfIndex.get(view.agent.index);
      return title === phase.title;
    });
    rows.forEach((view) => claimed.add(view.agent.index));
    return { title: phase.title, rows };
  }).filter((block) => block.rows.length > 0);
  const unphased = views.filter((view) => !claimed.has(view.agent.index));
  // No live telemetry: the script's own plan is what this run published.
  const plannedOnly = progress.agents.length === 0 && progress.queuedCount === 0;

  return (
    <div data-testid="chat-workflow-run" data-workflow-name={run.name} className="min-w-0 rounded-md px-1.5 pb-1.5 pt-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] leading-5 text-fg/85" title={run.name}>
          {run.name}
        </span>
        <span className={cn("shrink-0 font-sans text-[10.5px]", statusTone(run.parent.status))}>
          {statusLabel(run.parent.status)}
        </span>
        {durationMs !== null ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-fg/35">
            {formatDurationMs(durationMs)}
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 font-sans text-[10.5px] tabular-nums text-fg/40">
        {total > 0 ? <span>{counts.completed}/{total} agents</span> : null}
        {counts.running > 0 ? <span className="text-violet-200/70">{counts.running} running</span> : null}
        {counts.failed > 0 ? <span className="text-rose-300/80">{counts.failed} failed</span> : null}
        {counts.stopped > 0 ? <span>{counts.stopped} stopped</span> : null}
        {progress.queuedCount > 0 ? <span>{progress.queuedCount} queued</span> : null}
        {totals.tokens !== null && totals.tokens > 0 ? <span>{formatContextTokens(totals.tokens)} tok</span> : null}
        {totals.tools !== null ? <span>{totals.tools} tools</span> : null}
      </div>

      {plannedOnly ? (
        <div className="mt-1 min-w-0" data-testid="chat-workflow-planned-phases">
          {/* No live status exists for these phases, so none is drawn: a neutral
              dot would read as "queued". The caption says what they are. */}
          <div className="pl-0.5 font-sans text-[10.5px] text-fg/35">
            {plan
              ? `Plan from its script · ${pluralCount(plan.lines, "line")} · no agent rows published`
              : "No phase detail published for this run"}
          </div>
          {plan && plan.phases.length > 0 ? (
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-0.5">
              {plan.phases.map((title, index) => (
                <span key={`${index}-${title}`} className="flex min-w-0 items-center gap-1.5">
                  {index > 0 ? <span aria-hidden className="text-fg/25">›</span> : null}
                  <span className="min-w-0 truncate font-sans text-[11.5px] text-fg/70" title={title}>{title}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-1 space-y-0.5">
          {blocks.map((block) => (
            <div key={block.title}>
              <div className="flex min-w-0 items-center gap-1.5 pb-0.5 pl-0.5 pt-1">
                <PhaseStateIcon state={phaseStateOfViews(block.rows)} />
                <span className="min-w-0 truncate font-sans text-[11px] text-fg/60" title={block.title}>
                  {block.title}
                </span>
                <span className="shrink-0 font-sans text-[10px] text-fg/35">
                  {pluralCount(block.rows.length, "agent")}
                </span>
              </div>
              {block.rows.map((view) => (
                <WorkflowAgentRow key={`${view.agent.key}-${view.agent.index}`} view={view} onSelect={onSelectSubagent} />
              ))}
            </div>
          ))}
          {unphased.length > 0 ? (
            <div>
              {blocks.length > 0 ? (
                <div className="flex min-w-0 items-center gap-1.5 pb-0.5 pl-0.5 pt-1">
                  <PhaseStateIcon state={phaseStateOfViews(unphased)} />
                  <span className="font-sans text-[11px] text-fg/60">Other</span>
                  <span className="shrink-0 font-sans text-[10px] text-fg/35">
                    {pluralCount(unphased.length, "agent")}
                  </span>
                </div>
              ) : null}
              {unphased.map((view) => (
                <WorkflowAgentRow key={`${view.agent.key}-${view.agent.index}`} view={view} onSelect={onSelectSubagent} />
              ))}
            </div>
          ) : null}
        </div>
      )}

      {running && onStopWorkflow ? (
        <button
          type="button"
          onClick={() => onStopWorkflow(run.parent)}
          className="mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-sans text-[10.5px] text-fg/45 transition-colors hover:bg-rose-500/10 hover:text-rose-200/90"
        >
          <Stop aria-hidden size={10} weight="fill" />
          Stop workflow
        </button>
      ) : null}
    </div>
  );
}

/** One agent of a run: status mark, name, what it found, tokens · time. */
function WorkflowAgentRow({
  view,
  onSelect,
}: {
  view: WorkflowAgentView;
  onSelect?: (snapshot: ChatSubagentSnapshot) => void;
}) {
  const { agent, member, status, summary } = view;
  const metrics = [
    typeof agent.tokens === "number" ? formatContextTokens(agent.tokens) : null,
    agent.durationMs ? formatSubagentDurationMs(agent.durationMs) : null,
  ].filter((part): part is string => Boolean(part)).join(" · ");
  const content = (
    <>
      <span className="mt-[1px] shrink-0"><WorkflowStatusIcon status={status} /></span>
      <span className="min-w-0 max-w-[62%] shrink-0 truncate font-sans text-[11.5px] text-fg/75" title={agent.name}>
        {agent.name}
      </span>
      {summary && (status === "failed" || status === "stopped") ? (
        <span className="min-w-0 flex-1 truncate font-sans text-[10.5px] text-rose-200/80" title={summary}>
          {summary}
        </span>
      ) : null}
      {metrics ? <span className="shrink-0 font-mono text-[10px] tabular-nums text-fg/35">{metrics}</span> : null}
      {member ? <CaretRight aria-hidden size={11} className="shrink-0 text-fg/25 group-hover:text-fg/60" /> : null}
    </>
  );
  return member && onSelect ? (
    <button
      type="button"
      onClick={() => onSelect(member)}
      aria-label={`Open ${agent.name} details`}
      data-testid="chat-workflow-agent-row"
      className="group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-fg/[0.045]"
    >
      {content}
    </button>
  ) : (
    <div className="flex min-w-0 items-center gap-2 px-1.5 py-1" data-testid="chat-workflow-agent-row">{content}</div>
  );
}

function phaseStateOfViews(views: readonly WorkflowAgentView[]): "queued" | "running" | "done" | "failed" {
  if (views.some((view) => view.status === "failed" || view.status === "stopped")) return "failed";
  if (views.some((view) => view.status === "running")) return "running";
  return views.length > 0 ? "done" : "queued";
}

function PhaseStateIcon({ state }: { state: "queued" | "running" | "done" | "failed" }) {
  if (state === "done") return <Check aria-hidden size={11} weight="bold" className="shrink-0 text-emerald-300/85" />;
  if (state === "failed") return <X aria-hidden size={11} weight="bold" className="shrink-0 text-rose-300/85" />;
  if (state === "running") {
    return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent-bright,#C4B5FD)]" />;
  }
  return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg/25" />;
}

