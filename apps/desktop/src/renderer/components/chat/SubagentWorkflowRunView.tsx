import { Check, ListChecks, X } from "@phosphor-icons/react";
import { deriveSubagentCardName } from "../../../shared/chatSubagents";
import { pluralCount } from "../../../shared/formatting";
import { cn } from "../ui/cn";
import { formatSubagentDurationMs } from "../../lib/format";
import { CHAT_CARD_WIDTH_CLASS } from "./chatCardPrimitives";
import type { SubagentCardGridMember } from "./chatTranscriptRows";
import {
  CARD_META_TEXT,
  SUBAGENT_RUN_HEADER_TEXT,
  SubagentCardGrid,
  subagentStatusParts,
  subagentStatusTally,
} from "./SubagentActivityCards";

/**
 * A Claude dynamic workflow's run, drawn as ONE group: its name, tally and
 * span, then a block per phase with a full-width line per agent. Own module
 * because it is a different concern from the agent cards (and it kept the card
 * file at the 1k-line threshold).
 */

/** The `::a<index>` suffix every agent of a workflow carries. */
function workflowAgentIndex(taskId: string | null | undefined): number | null {
  const match = typeof taskId === "string" ? /::a(\d+)$/.exec(taskId) : null;
  return match ? Number(match[1]) : null;
}

/**
 * The workflow task among a grid's members, when its run can be drawn as one
 * group: it carries a `workflow_progress` snapshot and at least one member is
 * one of its own `::a<index>` agents. Null for every other run, which keeps the
 * plain card grid for ordinary fan-outs.
 */
export function workflowRunParent(members: readonly SubagentCardGridMember[]): SubagentCardGridMember | null {
  return workflowRunShape(members)?.parent ?? null;
}

export type SubagentWorkflowRunShape = {
  parent: SubagentCardGridMember;
  /** One block per phase, in plan order, each with the agents it owns. */
  blocks: Array<{ title: string; members: SubagentCardGridMember[] }>;
  /** Owned agents the snapshot never placed in a phase. */
  unphased: SubagentCardGridMember[];
  /** Agents the provider says are still queued (no rows yet). */
  queued: number;
  /** Members that are not part of this workflow at all. */
  foreign: SubagentCardGridMember[];
};

/** Partition a grid's members into the workflow's phases; null when it holds no workflow run. */
export function workflowRunShape(members: readonly SubagentCardGridMember[]): SubagentWorkflowRunShape | null {
  if (members.length < 2) return null;
  for (const parent of members) {
    const progress = parent.event.workflowProgress ?? null;
    const parentTaskId = parent.event.taskId ?? null;
    if (!progress || !parentTaskId) continue;
    const owned: SubagentCardGridMember[] = [];
    const foreign: SubagentCardGridMember[] = [];
    for (const member of members) {
      if (member.key === parent.key) continue;
      const index = workflowAgentIndex(member.event.taskId);
      if (index !== null && member.event.taskId === `${parentTaskId}::a${index}`) owned.push(member);
      else foreign.push(member);
    }
    if (owned.length === 0) continue;
    const phaseOfIndex = new Map<number, string>();
    for (const agent of progress.agents) {
      if (agent.phaseTitle) phaseOfIndex.set(agent.index, agent.phaseTitle);
    }
    const claimed = new Set<SubagentCardGridMember>();
    const blocks = progress.phases.map((phase) => {
      const blockMembers = owned.filter((member) => {
        const index = workflowAgentIndex(member.event.taskId);
        return index !== null && phaseOfIndex.get(index) === phase.title;
      });
      blockMembers.forEach((member) => claimed.add(member));
      return { title: phase.title, members: blockMembers };
    }).filter((block) => block.members.length > 0);
    return {
      parent,
      blocks,
      unphased: owned.filter((member) => !claimed.has(member)),
      queued: progress.queuedCount > 0 ? progress.queuedCount : 0,
      foreign,
    };
  }
  return null;
}

type WorkflowPhaseState = "queued" | "running" | "done" | "failed" | "stopped";

/**
 * A phase's state from its agents. A `stopped` agent is NOT a failure — the run
 * was interrupted, and the header tally says "stopped" in amber for the same
 * agents — so the phase gets its own state and its own mark, or every phase of
 * an interrupted run would read as broken.
 */
function phaseStateOf(members: readonly SubagentCardGridMember[]): WorkflowPhaseState {
  if (members.some((member) => member.event.status === "failed")) return "failed";
  if (members.some((member) => member.event.status === "stopped")) return "stopped";
  if (members.some((member) => member.event.status === "running")) return "running";
  if (members.length === 0) return "queued";
  return "done";
}

function PhaseStateMark({ state }: { state: WorkflowPhaseState }) {
  if (state === "done") return <Check aria-hidden size={11} weight="bold" className="shrink-0 text-emerald-300/85" />;
  if (state === "failed") return <X aria-hidden size={11} weight="bold" className="shrink-0 text-rose-300/85" />;
  if (state === "stopped") {
    return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300/70" />;
  }
  if (state === "running") {
    return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent-bright,#C4B5FD)]" />;
  }
  return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg/25" />;
}

/** Wall-clock span of a run of cards: earliest start to the latest end (or now). */
function cardsElapsedLabel(members: readonly SubagentCardGridMember[]): string | null {
  const starts = members
    .map((member) => member.event.startedAt)
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .map((value) => Date.parse(value));
  if (starts.length === 0) return null;
  const earliest = Math.min(...starts);
  const ends = members
    .map((member) => ("endedAt" in member.event ? member.event.endedAt : null))
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .map((value) => Date.parse(value));
  const latest = ends.length === members.length ? Math.max(...ends) : Date.now();
  return formatSubagentDurationMs(Math.max(0, latest - earliest));
}

/**
 * A Claude dynamic workflow's run as ONE group: the workflow's name, its tally
 * and its wall-clock span, then a quiet block per phase (`workflow_progress`
 * phases, in plan order) holding that phase's agents. The workflow task's own
 * card is the header — the task that launched the run is not repeated as a
 * card — and agents the snapshot never placed in a phase land in a trailing
 * `Other` block so every one stays reachable. Members that are not part of this
 * workflow (another agent spawned alongside it) render as ordinary cards below.
 */
export function SubagentWorkflowRun({
  parent,
  members,
  renderCard,
}: {
  /** The workflow task's own card: its `workflowProgress` is the run's plan. */
  parent: SubagentCardGridMember;
  members: readonly SubagentCardGridMember[];
  renderCard: (member: SubagentCardGridMember) => React.ReactNode;
}) {
  const shape = workflowRunShape(members);
  if (!shape || shape.parent.key !== parent.key) return null;
  const { blocks, unphased, queued, foreign } = shape;
  const owned = [...blocks.flatMap((block) => block.members), ...unphased];
  const name = parent.event.workflowName?.trim() || deriveSubagentCardName(parent.event);
  const counts = subagentStatusTally(owned);
  const parts = subagentStatusParts(counts);
  const elapsed = cardsElapsedLabel(owned);

  return (
    <section
      data-subagent-workflow-run={name}
      data-subagent-workflow-agents={counts.total}
      className={cn(CHAT_CARD_WIDTH_CLASS, "min-w-0")}
    >
      <header className="mb-1.5 flex min-w-0 items-center gap-2">
        <ListChecks aria-hidden size={13} weight="bold" className="shrink-0 text-amber-300/75" />
        <span
          className="min-w-0 truncate font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold text-fg/85"
          title={name}
          data-subagent-workflow-name
        >
          {name}
        </span>
        <span className={cn("shrink-0 text-fg/50", SUBAGENT_RUN_HEADER_TEXT)}>
          {pluralCount(counts.total, "agent")}
          {parts.map((part) => (
            <span key={part.key} className={part.className}> · {part.text}</span>
          ))}
        </span>
        {elapsed ? <span className={cn("ml-auto shrink-0 text-fg/35", CARD_META_TEXT)}>{elapsed}</span> : null}
      </header>
      {blocks.length > 0 ? (
        <div className="mb-2 space-y-2">
          {blocks.map((block) => (
            <div key={block.title} className="min-w-0" data-subagent-workflow-phase={block.title}>
              <div className="flex min-w-0 items-center gap-1.5 pb-1">
                <PhaseStateMark state={phaseStateOf(block.members)} />
                <span className={cn("min-w-0 truncate text-fg/60", SUBAGENT_RUN_HEADER_TEXT)} title={block.title}>
                  {block.title}
                </span>
                <span className={cn("shrink-0 text-fg/35", SUBAGENT_RUN_HEADER_TEXT)}>
                  {pluralCount(block.members.length, "agent")}
                </span>
              </div>
              {/* One agent per line: a workflow's agents are read in order, and a
                  full-width line keeps the name, the result and the counts all
                  readable where a three-up card grid would clip them. */}
              <div className="space-y-1">
                {block.members.map((member) => (
                  <div key={member.key} className="min-w-0">{renderCard(member)}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {unphased.length > 0 ? (
        <div className="mb-2 min-w-0" data-subagent-workflow-phase="Other">
          <div className="flex min-w-0 items-center gap-1.5 pb-1">
            <PhaseStateMark state={phaseStateOf(unphased)} />
            <span className={cn("min-w-0 truncate text-fg/60", SUBAGENT_RUN_HEADER_TEXT)}>
              Other
            </span>
            <span className={cn("shrink-0 text-fg/35", SUBAGENT_RUN_HEADER_TEXT)}>
              {pluralCount(unphased.length, "agent")}
            </span>
          </div>
          <div className="space-y-1">
            {unphased.map((member) => (
              <div key={member.key} className="min-w-0">{renderCard(member)}</div>
            ))}
          </div>
        </div>
      ) : null}
      {queued > 0 ? (
        <div className={cn("mb-2 text-fg/35", SUBAGENT_RUN_HEADER_TEXT)}>
          {pluralCount(queued, "agent")} queued behind the current phase
        </div>
      ) : null}
      {foreign.length > 0 ? <SubagentCardGrid members={foreign} renderCard={renderCard} /> : null}
    </section>
  );
}

