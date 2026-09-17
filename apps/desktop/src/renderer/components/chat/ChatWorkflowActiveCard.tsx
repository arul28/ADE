import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  CaretRight,
  Check,
  CheckCircle,
  Circle,
  CircleHalf,
  CircleNotch,
  Clock,
  Lightning,
  ListNumbers,
  Stop,
  TreeStructure,
  UsersThree,
  Wrench,
  X,
} from "@phosphor-icons/react";
import type { AgentChatWorkflowAgent, AgentChatWorkflowPhase, AgentChatWorkflowProgress } from "../../../shared/types";
import { cn } from "../ui/cn";
import { formatDurationMs, formatSubagentDurationMs } from "../../lib/format";
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
 * prefix match keeps two workflows with the same display name independent;
 * the name fallback is only for older event histories that predate the rich
 * workflow snapshot.
 */
export function deriveChatWorkflowRuns(snapshots: ChatSubagentSnapshot[]): ChatWorkflowRun[] {
  const directParents = snapshots.filter(
    (snapshot): snapshot is ChatSubagentSnapshot & { workflowProgress: AgentChatWorkflowProgress } => (
      snapshot.workflowProgress !== undefined
    ),
  );
  const directParentIds = new Set(directParents.map((snapshot) => snapshot.taskId));
  const directNames = new Set(directParents.map(workflowName));
  const directMemberPrefixes = directParents.map((snapshot) => `${snapshot.taskId}::a`);
  const runs: ChatWorkflowRun[] = directParents.map((parent) => {
    const prefix = `${parent.taskId}::a`;
    const members = snapshots.filter((snapshot) => snapshot.taskId.startsWith(prefix));
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
    if (!snapshot.workflowName?.trim() || directNames.has(workflowName(snapshot))) continue;
    if (directParentIds.has(snapshot.taskId)) continue;
    if (directMemberPrefixes.some((prefix) => snapshot.taskId.startsWith(prefix))) continue;
    const group = fallbackGroups.get(workflowName(snapshot)) ?? [];
    group.push(snapshot);
    fallbackGroups.set(workflowName(snapshot), group);
  }
  for (const [name, group] of fallbackGroups) {
    const parent = group.find((snapshot) => snapshot.taskType === "local_workflow") ?? group[0];
    if (!parent) continue;
    const members = group.filter((snapshot) => snapshot.taskId !== parent.taskId);
    runs.push({
      id: `workflow:${name}`,
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

function phaseAgentList(progress: AgentChatWorkflowProgress, phase: AgentChatWorkflowPhase): AgentChatWorkflowAgent[] {
  return progress.agents.filter((agent) => agent.phaseTitle === phase.title);
}

function phaseState(
  progress: AgentChatWorkflowProgress,
  phase: AgentChatWorkflowPhase,
  workflowStatus: WorkflowStatus,
): "queued" | "active" | "completed" | "failed" {
  const agents = phaseAgentList(progress, phase);
  if (agents.some((agent) => agent.status === "failed" || agent.status === "stopped")) return "failed";
  if (agents.some((agent) => agent.status === "running")) return "active";
  if (agents.length > 0 && agents.every((agent) => agent.status === "completed")) return "completed";
  if (workflowStatus === "completed" || workflowStatus === "failed" || workflowStatus === "stopped") {
    return progress.failedCount > 0 ? "failed" : "completed";
  }
  const activePhase = progress.agents.find((agent) => agent.status === "running")?.phaseTitle;
  if (activePhase === phase.title) return "active";
  if (activePhase && progress.phases.findIndex((candidate) => candidate.title === activePhase) > progress.phases.indexOf(phase)) {
    return "completed";
  }
  return "queued";
}

function workflowDuration(run: ChatWorkflowRun, nowMs: number): number | null {
  const reported = run.parent.usage?.durationMs;
  if (typeof reported === "number" && reported > 0) return reported;
  const started = Date.parse(run.parent.startedAt);
  if (!Number.isFinite(started)) return null;
  const end = run.parent.status === "running" ? nowMs : Date.parse(run.parent.updatedAt);
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
  if (status === "completed") return <CheckCircle aria-hidden size={15} weight="fill" className="text-emerald-300/90" />;
  if (status === "failed") return <X aria-hidden size={15} weight="bold" className="text-rose-300/90" />;
  if (status === "stopped") return <Stop aria-hidden size={14} weight="fill" className="text-amber-300/85" />;
  return <CircleNotch aria-hidden size={15} className="motion-safe:animate-spin text-violet-200/90 [animation-duration:1.25s]" />;
}

function WorkflowMetric({ icon: Icon, label, value }: { icon: typeof UsersThree; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-white/[0.055] bg-white/[0.025] px-2 py-1.5">
      <Icon aria-hidden size={13} className="shrink-0 text-fg/35" />
      <div className="min-w-0">
        <div className="truncate text-[9px] uppercase tracking-[0.08em] text-fg/30">{label}</div>
        <div className="truncate text-[11px] tabular-nums text-fg/72">{value}</div>
      </div>
    </div>
  );
}

export function ChatWorkflowActiveCard({
  snapshots,
  onSelectSubagent,
  onStopWorkflow,
}: {
  snapshots: ChatSubagentSnapshot[];
  onSelectSubagent?: (snapshot: ChatSubagentSnapshot) => void;
  onStopWorkflow?: (snapshot: ChatSubagentSnapshot) => void;
}) {
  const runs = useMemo(() => deriveChatWorkflowRuns(snapshots), [snapshots]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const openRun = runs.find((run) => run.id === openRunId) ?? null;
  const liveAnnouncement = runs.slice(0, 3).map((run) => {
    const running = workflowAgentViews(run).filter((view) => view.status === "running").length;
    return `${run.name}: ${statusLabel(run.parent.status)}${running > 0 ? `, ${running} agent${running === 1 ? "" : "s"} running` : ""}`;
  }).join(". ");

  useEffect(() => {
    if (openRunId && !openRun) setOpenRunId(null);
  }, [openRun, openRunId]);

  if (runs.length === 0) return null;

  return (
    <section
      className="border-b border-white/[0.055] px-3 pb-3 pt-2"
      aria-label="Workflow activity"
      data-testid="chat-workflow-active-card-list"
    >
      <span className="sr-only" role="status" aria-live="polite">{liveAnnouncement}</span>
      <div className="mb-1.5 flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-fg/42">
          <TreeStructure aria-hidden size={13} className="text-amber-200/75" />
          Workflow activity
        </div>
        <span className="text-[10px] tabular-nums text-fg/28">{runs.length} tracked</span>
      </div>
      <div className="space-y-1.5">
        {runs.slice(0, 3).map((run) => {
          const progress = run.progress;
          const total = progress.agents.length + progress.queuedCount;
          const views = workflowAgentViews(run);
          const counts = workflowAgentCounts(views);
          const currentPhase = run.parent.status === "running"
            ? views.find((view) => view.status === "running")?.agent.phaseTitle
            : undefined;
          const totals = workflowTotals(run);
          return (
            <button
              key={run.id}
              type="button"
              className={cn(
                "ade-workflow-active-card group relative w-full overflow-hidden rounded-xl border p-2.5 text-left",
                "border-amber-200/[0.14] bg-[linear-gradient(135deg,rgba(245,158,11,0.10),rgba(139,92,246,0.08)_52%,rgba(15,23,42,0.16))]",
                "transition duration-200 hover:border-amber-200/30 hover:bg-[linear-gradient(135deg,rgba(245,158,11,0.14),rgba(139,92,246,0.11)_52%,rgba(15,23,42,0.24))]",
              )}
              onClick={() => setOpenRunId(run.id)}
              aria-label={`View ${run.name} workflow details`}
              data-testid="chat-workflow-active-card"
            >
              {run.parent.status === "running" ? <span aria-hidden className="ade-workflow-active-card__sheen" /> : null}
              <span className="relative flex items-start gap-2.5">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-amber-200/20 bg-black/20 text-amber-100/85">
                  <WorkflowStatusIcon status={run.parent.status} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg/88">{run.name}</span>
                    <span className={cn("shrink-0 text-[10px] font-medium", statusTone(run.parent.status))}>
                      {statusLabel(run.parent.status)}
                    </span>
                    <CaretRight aria-hidden size={12} className="shrink-0 text-fg/30 transition-transform group-hover:translate-x-0.5 group-hover:text-fg/65" />
                  </span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-fg/48">
                    {currentPhase || (total > 0
                      ? `${counts.completed}/${total} agents complete${counts.failed ? ` · ${counts.failed} failed` : ""}${counts.stopped ? ` · ${counts.stopped} stopped` : ""}`
                      : "Workflow telemetry ready")}
                  </span>
                </span>
              </span>
              <span className="relative mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[0.07] pt-2 text-[10px] tabular-nums text-fg/42">
                <span className="inline-flex items-center gap-1"><UsersThree aria-hidden size={11} />{counts.completed}/{total || "–"} agents</span>
                {totals.tokens !== null ? <span>{totals.tokens.toLocaleString()} tok</span> : null}
                {totals.tools !== null ? <span>{totals.tools} tools</span> : null}
                {counts.running > 0 ? <span className="inline-flex items-center gap-1 text-violet-200/70"><CircleHalf aria-hidden size={10} weight="fill" />{counts.running} running</span> : null}
                {progress.queuedCount > 0 ? <span>{progress.queuedCount} queued</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      {openRun ? (
        <ChatWorkflowDetailsModal
          run={openRun}
          onClose={() => setOpenRunId(null)}
          onSelectSubagent={onSelectSubagent}
          onStopWorkflow={onStopWorkflow}
        />
      ) : null}
    </section>
  );
}

function ChatWorkflowDetailsModal({
  run,
  onClose,
  onSelectSubagent,
  onStopWorkflow,
}: {
  run: ChatWorkflowRun;
  onClose: () => void;
  onSelectSubagent?: (snapshot: ChatSubagentSnapshot) => void;
  onStopWorkflow?: (snapshot: ChatSubagentSnapshot) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { progress } = run;
  const totalAgents = progress.agents.length + progress.queuedCount;
  const agentViews = workflowAgentViews(run);
  const agentCounts = workflowAgentCounts(agentViews);
  const totals = workflowTotals(run);
  const durationMs = workflowDuration(run, nowMs);

  useEffect(() => {
    if (run.parent.status !== "running") return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [run.parent.status]);

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[210] bg-black/72 backdrop-blur-md" />
        <Dialog.Content
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeButtonRef.current?.focus();
          }}
          data-testid="chat-workflow-details-dialog"
          className="fixed left-1/2 top-1/2 z-[211] grid max-h-[min(860px,calc(100vh-24px))] w-[min(980px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-2xl border border-amber-100/[0.13] bg-[#11131b] shadow-[0_32px_140px_rgba(0,0,0,0.70)] focus:outline-none"
        >
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-amber-200/20 bg-[linear-gradient(145deg,rgba(245,158,11,0.16),rgba(139,92,246,0.12))] text-amber-100/90">
              <TreeStructure aria-hidden size={21} weight="duotone" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Dialog.Title className="truncate text-[15px] font-semibold text-fg/92">{run.name}</Dialog.Title>
                <span className={cn("rounded-full border border-white/[0.08] bg-white/[0.035] px-2 py-0.5 text-[10px] font-medium", statusTone(run.parent.status))}>
                  {statusLabel(run.parent.status)}
                </span>
              </div>
              <Dialog.Description className="mt-1 max-w-[680px] text-[11px] leading-4 text-fg/48">
                {run.parent.description || "Dynamic workflow run"}. Live orchestration details from the provider are grouped here so the chat stays readable.
              </Dialog.Description>
            </div>
          </div>
          <Dialog.Close asChild>
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="Close workflow details"
              title="Close"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg/42 transition-colors hover:bg-white/[0.06] hover:text-fg/80"
            >
              <X aria-hidden size={15} />
            </button>
          </Dialog.Close>
        </header>

        <div className="grid grid-cols-2 gap-1.5 border-b border-white/[0.07] p-3 sm:grid-cols-5 sm:gap-2 sm:px-5">
          <WorkflowMetric icon={ListNumbers} label="Phases" value={`${progress.phases.length || "–"}`} />
          <WorkflowMetric icon={UsersThree} label="Agents" value={`${agentCounts.completed}/${totalAgents || "–"}`} />
          <WorkflowMetric icon={Lightning} label="Running" value={`${agentCounts.running}`} />
          <WorkflowMetric icon={Wrench} label="Tools" value={totals.tools?.toLocaleString() ?? "–"} />
          <WorkflowMetric icon={Clock} label="Duration" value={formatDurationMs(durationMs)} />
        </div>

        <div className="min-h-0 overflow-y-auto p-3 sm:p-5">
          <div className="grid gap-4 md:grid-cols-[minmax(190px,0.34fr)_minmax(0,1fr)]">
            <aside className="rounded-xl border border-white/[0.07] bg-white/[0.018] p-3">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-[10px] font-medium uppercase tracking-[0.11em] text-fg/38">Phases</div>
                <span className="text-[10px] tabular-nums text-fg/28">{progress.phases.length}</span>
              </div>
              {progress.phases.length > 0 ? (
                <div className="space-y-1">
                  {progress.phases.map((phase, index) => {
                    const state = phaseState(progress, phase, run.parent.status);
                    const count = phaseAgentList(progress, phase).length;
                    return (
                      <div key={`${phase.index}-${phase.title}`} className={cn(
                        "flex items-start gap-2 rounded-lg px-2 py-2",
                        state === "active" && "bg-violet-300/[0.08]",
                        state === "failed" && "bg-rose-300/[0.06]",
                      )}>
                        <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-white/[0.09] bg-black/20 text-[10px] tabular-nums text-fg/48">
                          {state === "completed" ? <Check aria-hidden size={12} weight="bold" className="text-emerald-300/90" /> : state === "active" ? <CircleHalf aria-hidden size={12} weight="fill" className="text-violet-200/90" /> : state === "failed" ? <X aria-hidden size={11} weight="bold" className="text-rose-300/90" /> : index + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cn(
                            "block break-words text-[11.5px] leading-4",
                            state === "active" && "text-violet-100/90",
                            state === "completed" && "text-fg/55",
                            state === "failed" && "text-rose-100/85",
                            state === "queued" && "text-fg/42",
                          )}>{phase.title}</span>
                          <span className="mt-0.5 block text-[9.5px] text-fg/28">
                            {state === "active" ? "In progress" : state === "completed" ? `${count} agent${count === 1 ? "" : "s"} complete` : state === "failed" ? "Needs attention" : "Queued"}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-white/[0.08] px-2.5 py-3 text-[10.5px] leading-4 text-fg/36">
                  This run predates phase labels, but its agent activity is still available below.
                </div>
              )}
              {run.parent.status === "running" && onStopWorkflow ? (
                <button
                  type="button"
                  onClick={() => onStopWorkflow(run.parent)}
                  className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-rose-300/15 bg-rose-400/[0.06] px-2.5 py-2 text-[10.5px] font-medium text-rose-100/72 transition-colors hover:border-rose-300/30 hover:bg-rose-400/[0.12] hover:text-rose-100"
                >
                  <Stop aria-hidden size={12} weight="fill" />
                  Stop workflow
                </button>
              ) : null}
            </aside>

            <section className="min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.018] p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-[0.11em] text-fg/38">Agent roster</div>
                  <div className="mt-0.5 text-[10.5px] text-fg/35">
                    {agentCounts.running > 0
                      ? `${agentCounts.running} active now`
                      : run.parent.status === "running"
                        ? "Waiting for provider updates"
                        : agentCounts.stopped > 0
                          ? `${agentCounts.stopped} stopped when the workflow ended`
                          : "Run settled"}
                  </div>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/[0.07] bg-black/15 px-2 py-1 text-[10px] tabular-nums text-fg/42">
                  <UsersThree aria-hidden size={11} />
                  {progress.agents.length}/{totalAgents || "–"}
                </span>
              </div>
              <div className="space-y-1">
                {agentViews.map(({ agent, member, status, summary }) => {
                  const row = (
                    <span className="flex min-w-0 items-start gap-2.5">
                      <span className="mt-0.5 shrink-0"><WorkflowStatusIcon status={status} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="truncate text-[11.5px] text-fg/78">{agent.name}</span>
                          {agent.phaseTitle ? <span className="truncate text-[9.5px] text-amber-200/48">{agent.phaseTitle}</span> : null}
                          {agent.model || member?.model ? <span className="truncate text-[9.5px] text-fg/35">{agent.model || member?.model}</span> : null}
                        </span>
                        <span className="mt-0.5 block break-words text-[10px] leading-4 text-fg/42">{summary}</span>
                        <span className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[9.5px] tabular-nums text-fg/28">
                          {typeof agent.tokens === "number" ? <span>{agent.tokens.toLocaleString()} tok</span> : null}
                          {typeof agent.toolCalls === "number" ? <span>{agent.toolCalls} tools</span> : null}
                          {agent.durationMs ? <span>{formatSubagentDurationMs(agent.durationMs)}</span> : null}
                          {agent.lastToolName ? <span className="inline-flex items-center gap-1"><Wrench aria-hidden size={9} />{agent.lastToolName}</span> : null}
                        </span>
                      </span>
                      {member ? <CaretRight aria-hidden size={12} className="mt-1 shrink-0 text-fg/25" /> : null}
                    </span>
                  );
                  return member && onSelectSubagent ? (
                    <button
                      key={`${agent.key}-${agent.index}`}
                      type="button"
                      className="group w-full rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.045]"
                      onClick={() => {
                        onClose();
                        onSelectSubagent(member);
                      }}
                      aria-label={`Open ${agent.name} details`}
                      data-testid="chat-workflow-agent-row"
                    >
                      {row}
                    </button>
                  ) : (
                    <div key={`${agent.key}-${agent.index}`} className="rounded-lg px-2 py-2" data-testid="chat-workflow-agent-row">{row}</div>
                  );
                })}
                {progress.queuedCount > 0 ? (
                  <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-white/[0.08] px-2 py-2 text-[10.5px] text-fg/36">
                    <Circle aria-hidden size={14} className="text-fg/25" />
                    {progress.queuedCount} agent{progress.queuedCount === 1 ? "" : "s"} queued behind the current phase
                  </div>
                ) : null}
                {progress.agents.length === 0 && progress.queuedCount === 0 ? (
                  <div className="rounded-lg border border-dashed border-white/[0.08] px-2.5 py-4 text-center text-[10.5px] leading-4 text-fg/35">
                    The provider has not published individual agent rows yet.
                  </div>
                ) : null}
              </div>
            </section>
          </div>
          {totals.tokens !== null ? (
            <div className="mt-3 flex items-center gap-1.5 px-1 text-[10px] text-fg/30">
              <Lightning aria-hidden size={11} />
              {totals.tokens.toLocaleString()} total tokens reported by the workflow
            </div>
          ) : null}
        </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
