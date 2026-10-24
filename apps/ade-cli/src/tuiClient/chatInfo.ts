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
import { canonicalInputFromSummary, sessionCanonicalUiState } from "../../../desktop/src/renderer/lib/terminalAttention";
import { primarySessionLabel } from "../../../desktop/src/renderer/lib/sessions";
import type { CanonicalSessionPhase } from "../../../desktop/src/shared/sessionCanonicalState";

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

function rosterPhaseStatus(phase: CanonicalSessionPhase): SubagentSnapshot["status"] {
  switch (phase) {
    case "starting":
    case "running":
    case "stale":
    case "needs_you":
      return "running";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "completed";
  }
}

/**
 * The chat's filed subagents from the session roster. The Work list no longer
 * shows them, so this pane is where they are reached: a child the transcript
 * has no row for (a promoted peer, an old or windowed transcript) gets a row,
 * and a child waiting on the user is marked `needsYou`. Same rule as the
 * desktop actions pane: same lane, `spawnKind: "subagent"`, parent = this chat.
 *
 * Returns the input array when the roster adds nothing.
 */
export function withRosterSubagentSnapshots(
  snapshots: SubagentSnapshot[],
  parentSessionId: string | null | undefined,
  sessions: readonly TuiChatSessionSummary[],
): SubagentSnapshot[] {
  const parentId = parentSessionId?.trim();
  if (!parentId || sessions.length === 0) return snapshots;
  const parentLaneId = sessions.find((session) => session.sessionId === parentId)?.laneId;
  if (!parentLaneId) return snapshots;
  const children = sessions.filter((session) => (
    session.sessionId !== parentId
    && !session.archivedAt
    && session.spawnKind === "subagent"
    && session.orchestrationParentSessionId?.trim() === parentId
    && session.laneId === parentLaneId
  ));
  if (children.length === 0) return snapshots;
  const phaseById = new Map<string, CanonicalSessionPhase>();
  for (const child of children) {
    phaseById.set(child.sessionId, sessionCanonicalUiState(canonicalInputFromSummary(toWorkSessionSummary(child))).phase);
  }
  const rowChildId = (snapshot: SubagentSnapshot): string => (
    snapshot.id.startsWith("chat:") ? snapshot.id.slice("chat:".length) : snapshot.id
  );
  let changed = false;
  const covered = new Set<string>();
  const out = snapshots.map((snapshot) => {
    const childId = rowChildId(snapshot);
    covered.add(childId);
    const needsYou = phaseById.get(childId) === "needs_you";
    if ((snapshot.needsYou === true) === needsYou) return snapshot;
    changed = true;
    return { ...snapshot, needsYou };
  });
  for (const child of children) {
    if (covered.has(child.sessionId)) continue;
    changed = true;
    const phase = phaseById.get(child.sessionId)!;
    out.push({
      id: child.sessionId,
      name: primarySessionLabel(toWorkSessionSummary(child)),
      kind: "subagent",
      status: rosterPhaseStatus(phase),
      summary: "",
      provider: child.provider ?? null,
      taskType: "subagent",
      startedAt: child.startedAt ?? null,
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
