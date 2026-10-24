import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
  AgentChatSubagentSnapshot,
} from "../../../desktop/src/shared/types/chat";
import { isBackgroundShellCommand } from "../../../desktop/src/shared/chatSubagents";
import { deriveChatTaskList, isPlanProposalEvent } from "../../../desktop/src/shared/chatTaskList";
import { deriveBackgroundItems, mergeManagedScheduledWorkSnapshots } from "../../../desktop/src/shared/chatScheduledWork";
import { resolveSubagentCapability } from "../../../desktop/src/shared/subagentCapabilities";
import { deriveMissionSnapshot } from "../../../desktop/src/renderer/components/chat/chatMission";
import type {
  AdeCodeProvider,
  ChatInfoPrSummary,
  ChatInfoSnapshot,
  SubagentSnapshot,
} from "./types";
import type { PrSummary } from "../../../desktop/src/shared/types/prs";

import type { TokenStats, TuiChatSessionSummary } from "./adeApi";
import { toWorkSessionSummary } from "./workRow";
import { primarySessionLabel } from "../../../desktop/src/renderer/lib/sessions";
import { orphanRowChildSessionCandidate } from "../../../desktop/src/shared/chatOrphanRunReconcile";
import {
  childChatPaneStatus,
  filedSubagentsOf,
  spawnNestingPhase,
} from "../../../desktop/src/shared/sessionSpawnNesting";

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function tokenStatsSummary(stats: TokenStats | null): string | null {
  if (!stats) return null;
  const parts: string[] = [];
  if (stats.inputTokens != null || stats.outputTokens != null) {
    const input = stats.inputTokens != null ? `+${compactNumber(stats.inputTokens)}` : "+0";
    const output = stats.outputTokens != null ? compactNumber(stats.outputTokens) : "0";
    parts.push(`${input}/${output}`);
  }
  const cacheParts: string[] = [];
  if (stats.cacheReadTokens != null && stats.cacheReadTokens > 0) {
    cacheParts.push(`${compactNumber(stats.cacheReadTokens)}✶`);
  }
  if (stats.cacheCreationTokens != null && stats.cacheCreationTokens > 0) {
    cacheParts.push(`${compactNumber(stats.cacheCreationTokens)}✎`);
  }
  if (cacheParts.length) {
    parts.push(`(${cacheParts.join(" ")})`);
  }
  if (stats.costUsd != null) {
    parts.push(`$${stats.costUsd.toFixed(2)}`);
  }
  return parts.length ? parts.join(" ") : null;
}

function latestPlanEvent(events: AgentChatEventEnvelope[]): Extract<AgentChatEvent, { type: "plan" }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "plan") return event;
  }
  return null;
}

function trimmedOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function snapshotFromRuntimeSubagent(row: AgentChatSubagentSnapshot): SubagentSnapshot {
  return {
    id: row.agentId?.trim() || row.taskId,
    name: row.description || row.label || row.agentType || "subagent",
    kind: "subagent",
    status: row.status,
    summary: row.finalSummary || row.summary || "",
    parentToolUseId: row.parentToolUseId ?? null,
    parentAgentId: row.parentAgentId ?? null,
    turnId: row.turnId ?? null,
    label: row.label ?? null,
    background: row.background === true,
    startedAt: row.startTimestamp ?? null,
    endedAt: row.endTimestamp ?? null,
    tokens: row.usage?.totalTokens,
    toolUses: row.usage?.toolUses,
    costUsd: row.usage?.costUsd,
    durationMs: row.usage?.durationMs,
    lastToolName: row.lastToolName,
    workflowProgress: row.workflowProgress,
  };
}

export function mergeSubagentSnapshots(
  eventDerived: readonly SubagentSnapshot[],
  runtime: readonly SubagentSnapshot[],
): SubagentSnapshot[] {
  if (runtime.length === 0) return [...eventDerived];
  const byId = new Map<string, SubagentSnapshot>();
  for (const row of eventDerived) byId.set(row.id, row);
  for (const row of runtime) {
    const existing = byId.get(row.id);
    byId.set(row.id, existing ? { ...row, ...existing, ...row, lastToolName: existing.lastToolName ?? row.lastToolName } : row);
  }
  return [...byId.values()];
}

/** The child chat a chat-info row stands for (`chat:<id>` or a bare id). */
export function chatInfoRowChildId(snapshot: Pick<SubagentSnapshot, "id">): string | null {
  return orphanRowChildSessionCandidate(snapshot.id);
}

/**
 * The chat's child chats from the session list, by the same rules as the
 * desktop actions pane (`useChatChildRoster`): every subagent the Work list
 * files under this chat (`filedSubagentsOf`, grandchildren included) that the
 * transcript has no row for is appended, and any row whose chat is waiting on
 * the user is marked `needsYou`. A row whose chat is known and not at rest
 * takes its status from the chat's current phase.
 *
 * Returns the input array when the session list changes nothing.
 */
export function withRosterSubagentSnapshots(
  snapshots: SubagentSnapshot[],
  parentSessionId: string | null | undefined,
  sessions: readonly TuiChatSessionSummary[],
): SubagentSnapshot[] {
  const parentId = parentSessionId?.trim();
  if (!parentId || sessions.length === 0) return snapshots;
  const nowMs = Date.now();
  const summaries = sessions.map((session) => toWorkSessionSummary(session));
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary] as const));
  const providerById = new Map(sessions.map((session) => [session.sessionId, session.provider] as const));
  const phaseOfChild = (id: string | null) => {
    const summary = id ? summaryById.get(id) : undefined;
    return summary ? spawnNestingPhase(summary, nowMs) : null;
  };
  let changed = false;
  const covered = new Set<string>();
  const out = snapshots.map((snapshot) => {
    const childId = chatInfoRowChildId(snapshot);
    if (childId) covered.add(childId);
    const phase = phaseOfChild(childId);
    if (!phase) return snapshot;
    // A child chat's row reads the chat as it is now: the transcript's row can
    // still say running after the child stopped, or done after it started
    // again (the desktop pane's self-heal makes the same correction). A chat
    // at rest between turns may be a delegate that has not started yet, so
    // its row keeps what the transcript says, as on desktop.
    const needsYou = phase === "needs_you";
    const status = phase === "ready" || phase === "idle" ? snapshot.status : childChatPaneStatus(phase);
    if ((snapshot.needsYou === true) === needsYou && snapshot.status === status) return snapshot;
    changed = true;
    return { ...snapshot, needsYou, status };
  });
  for (const child of filedSubagentsOf(summaries, parentId, nowMs)) {
    if (covered.has(child.id)) continue;
    changed = true;
    const phase = spawnNestingPhase(child, nowMs);
    out.push({
      id: child.id,
      name: primarySessionLabel(child),
      kind: "subagent",
      status: childChatPaneStatus(phase),
      summary: "",
      provider: providerById.get(child.id) ?? null,
      taskType: "subagent",
      startedAt: child.startedAt || null,
      endedAt: child.endedAt ?? null,
      needsYou: phase === "needs_you",
    });
  }
  return changed ? out : snapshots;
}

/**
 * Renders `mcpCapability` honestly, per its contract: `level`/`residual` only
 * make a claim when the caller asked for strict mode, so a delivery-only
 * request reports delivery rather than an isolation ADE was never asked for.
 * `delivered: false` wins over both — the provider has no MCP surface at all.
 */
export function formatMcpCapabilityNote(
  capability: AgentChatSessionSummary["mcpCapability"],
): string | null {
  if (!capability) return null;
  if (!capability.delivered) return "MCP: unsupported by this provider";
  if (!capability.strictRequested) return "MCP: caller servers injected";
  switch (capability.level) {
    case "enforced":
      return "MCP: enforced";
    case "best-effort": {
      const residual = capability.residual?.trim();
      if (!residual) return "MCP: best-effort";
      const clipped = residual.length > 60 ? `${residual.slice(0, 57).trimEnd()}…` : residual;
      return `MCP: best-effort · ${clipped}`;
    }
    case "unsupported":
      return "MCP: unsupported by this provider";
    default: {
      const _exhaustive: never = capability.level;
      return _exhaustive;
    }
  }
}

export function chatInfoPrFromSummaries(prs: readonly PrSummary[]): ChatInfoPrSummary | null {
  const primary = prs[0];
  if (!primary) return null;
  const extras = prs.slice(1).map((pr) => pr.githubPrNumber).filter((number) => Number.isInteger(number) && number > 0);
  return {
    number: primary.githubPrNumber,
    state: primary.state === "merged" ? "merged" : primary.state === "closed" ? "closed" : "open",
    checksPassed: 0,
    checksTotal: 0,
    checksStatus: primary.checksStatus,
    linkedNumbers: extras.length > 0 ? extras : undefined,
  };
}

/** Compact header chip: `#42` or `#42 +2`, matching the desktop Work peek. */
export function formatChatPrHeaderLabel(prs: readonly PrSummary[]): string | null {
  const numbers = prs
    .map((pr) => pr.githubPrNumber)
    .filter((number) => Number.isInteger(number) && number > 0);
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return `#${numbers[0]}`;
  return `#${numbers[0]} +${numbers.length - 1}`;
}

export function deriveChatInfoSnapshot(args: {
  events: AgentChatEventEnvelope[];
  activeSession: AgentChatSessionSummary | null;
  provider: AdeCodeProvider;
  modelLabel: string;
  laneLabel: string | null;
  laneIcon?: string | null;
  laneColor?: string | null;
  title?: string | null;
  snapshots: SubagentSnapshot[];
  tokenStats: TokenStats | null;
  goal: ChatInfoSnapshot["goal"];
  streaming: boolean;
  inspectedSubagentId?: string | null;
  pr?: ChatInfoSnapshot["pr"];
  /** Closed-but-resumable Claude terminal session (drives the resume row). */
  resumableTerminal?: boolean;
  /**
   * Sentence the host answered when a manual `/resume-now` was refused, for the
   * active chat only. Carried on the snapshot so it renders next to the Resume
   * row it is about — the same place the desktop popover keeps a refusal.
   */
  usageLimitResumeNotice?: string | null;
}): ChatInfoSnapshot {
  const provider = (args.activeSession?.provider ?? args.provider) as AdeCodeProvider;
  const planEvent = latestPlanEvent(args.events);
  return {
    provider,
    modelLabel: args.modelLabel,
    laneLabel: args.laneLabel,
    laneIcon: args.laneIcon ?? null,
    laneColor: args.laneColor ?? null,
    title: args.title
      ?? trimmedOrNull(args.activeSession?.title)
      ?? trimmedOrNull(args.activeSession?.summary)
      ?? null,
    claudeTag: args.activeSession?.claudeTag ?? null,
    contextPercent: args.tokenStats?.percent ?? null,
    tokenSummary: tokenStatsSummary(args.tokenStats),
    goal: args.goal,
    taskList: deriveChatTaskList(args.events),
    planStreamingText: planEvent && isPlanProposalEvent(planEvent) ? trimmedOrNull(planEvent.streamingText) : null,
    // Schedule kinds only — background command tasks render in their own block.
    scheduledWork: mergeManagedScheduledWorkSnapshots(args.events, args.activeSession?.scheduledWork)
      .filter((item) => item.kind !== "background_task"),
    scheduledWorkPaused: args.activeSession?.scheduledWorkPaused === true,
    nextWakeAt: args.activeSession?.nextWakeAt ?? null,
    usageLimitResume: args.activeSession?.usageLimitResume ?? null,
    usageLimitResumeNotice: args.usageLimitResumeNotice ?? null,
    backgroundWork: deriveBackgroundItems(args.events),
    pr: args.pr ?? null,
    // Merge subagents into one roster and drop historical command-as-subagent
    // snapshots (the shared predicate keys on taskType/description).
    snapshots: args.snapshots.filter((snapshot) => !isBackgroundShellCommand({
      taskType: snapshot.taskType,
      description: snapshot.name,
    })),
    inspectedSubagentId: args.inspectedSubagentId ?? null,
    streaming: args.streaming,
    // Single source of truth for takeover-vs-inline + which stat fields render.
    // Resolved from the session provider (runtimeKind isn't surfaced on the TUI
    // session summary, and the 4 shared runtimes map 1:1 from provider).
    capability: resolveSubagentCapability(provider),
    mission: deriveMissionSnapshot(args.events),
    mcpNote: formatMcpCapabilityNote(args.activeSession?.mcpCapability),
    resumableTerminal: args.resumableTerminal ?? false,
  };
}
