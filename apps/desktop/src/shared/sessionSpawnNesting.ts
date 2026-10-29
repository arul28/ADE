import {
  backgroundWorkFromSummary,
  canonicalSessionState,
  isSessionFiledAsSnoozed,
  type CanonicalSessionPhase,
} from "./sessionCanonicalState";
import {
  scheduledWakeState,
  sessionStatusPresentation,
  sessionStatusShoutsLabel,
  type SessionStatusTone,
} from "./sessionStatusPresentation";
import type { TerminalSessionSummary } from "./types/sessions";
import { pluralCount } from "./formatting";

/**
 * Same-lane `spawnKind: "subagent"` chats (and tracked CLI `--type subagent`
 * sessions) of a parent CHAT are filed under that parent in the by-lane Work
 * list: they leave the top-level rows, the parent row carries one mark for
 * them (`nestedSubagentMark`), and the parent's actions pane lists them
 * (`filedSubagentsOf`). Peers stay top-level. This module is the one filing
 * rule desktop and the iOS mirror consult so a demote, a
 * quiet-parent pull-up, or a grandchild flatten cannot disagree across
 * surfaces.
 *
 * Quiet parent (snoozed / settled): not-done children (starting, running,
 * needs_you, failed, stale) stay top-level rows. Done children stay filed and
 * follow the parent into the quiet tails.
 *
 * Grandchildren file under the root parent, so one mark and one pane cover a
 * whole tree.
 */

export type SpawnNestingSession = Pick<
  TerminalSessionSummary,
  | "id"
  | "laneId"
  | "spawnKind"
  | "orchestrationParentSessionId"
  | "chatSessionId"
  | "status"
  | "runtimeState"
  | "toolType"
  | "pendingInputItemId"
  | "attentionSource"
  | "lastOutputPreview"
  | "lastActivityAt"
  | "exitCode"
  | "settledAt"
  | "settleOverride"
  | "attentionRequestedAt"
  | "lastTurnFailedAt"
  | "snoozedUntil"
  | "snoozedAt"
  | "backgroundWork"
  | "activeBackgroundTaskCount"
  | "startedAt"
  | "usageLimitResume"
  | "chatActivityMode"
  | "nextWakeAt"
  | "archivedAt"
>;

export type SpawnNestingIndex<T extends SpawnNestingSession = SpawnNestingSession> = {
  childrenByRootParentId: Map<string, T[]>;
  nestedChildIds: Set<string>;
  nestedChildToRootParentId: Map<string, string>;
};

export type WorkNesting<T extends SpawnNestingSession = SpawnNestingSession> = {
  subagentsByParentId: Map<string, T[]>;
  nestedChildIds: Set<string>;
  nestedChildToRootParentId: Map<string, string>;
  excludedTopLevelIds: Set<string>;
};

export function emptySpawnNestingIndex<
  T extends SpawnNestingSession = SpawnNestingSession,
>(): SpawnNestingIndex<T> {
  return {
    childrenByRootParentId: new Map(),
    nestedChildIds: new Set(),
    nestedChildToRootParentId: new Map(),
  };
}

/**
 * Match renderer `isChatToolType` so Cursor and every `*-chat` tool type are
 * chats; tracked CLI subagents are not. Owned here because filing lives in
 * shared, not the renderer.
 */
export function isChatToolType(toolType: string | null | undefined): boolean {
  if (!toolType) return false;
  const normalized = toolType.trim().toLowerCase();
  return normalized === "cursor" || normalized.endsWith("-chat");
}

/** The provider of an ADE chat's tool type (`claude-chat` → `claude`); null for a session that is not a chat. */
export function chatToolProvider(toolType: string | null | undefined): string | null {
  if (!toolType || !isChatToolType(toolType)) return null;
  const normalized = toolType.trim().toLowerCase();
  return normalized === "cursor" ? "cursor" : normalized.slice(0, -"-chat".length);
}

/** A session's canonical phase, as the nesting rules read it. */
export function spawnNestingPhase(session: SpawnNestingSession, nowMs: number = Date.now()): CanonicalSessionPhase {
  return canonicalSessionState({
    status: session.status,
    runtimeState: session.runtimeState ?? null,
    toolType: session.toolType ?? null,
    pendingInputItemId: session.pendingInputItemId ?? null,
    attentionSource: session.attentionSource ?? null,
    lastOutputPreview: session.lastOutputPreview,
    lastActivityAt: session.lastActivityAt ?? null,
    exitCode: session.exitCode ?? null,
    settledAt: session.settledAt ?? null,
    settleOverride: session.settleOverride ?? null,
    attentionRequestedAt: session.attentionRequestedAt ?? null,
    lastTurnFailedAt: session.lastTurnFailedAt ?? null,
    backgroundWork: backgroundWorkFromSummary(session),
    nowMs,
    isChatTool: isChatToolType,
  }).phase;
}

function isQuietParent(session: SpawnNestingSession, nowMs: number): boolean {
  const phase = spawnNestingPhase(session, nowMs);
  if (isSessionFiledAsSnoozed(session, phase, nowMs)) return true;
  return phase === "settled";
}

function isNotDone(session: SpawnNestingSession, nowMs: number): boolean {
  const phase = spawnNestingPhase(session, nowMs);
  switch (phase) {
    case "starting":
    case "running":
    case "needs_you":
    case "failed":
    case "stale":
      return true;
    case "stopped":
    case "ready":
    case "idle":
    case "ended":
    case "settled":
      return false;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

function compareNestedChildren(a: SpawnNestingSession, b: SpawnNestingSession): number {
  const aTime = Date.parse(a.startedAt);
  const bTime = Date.parse(b.startedAt);
  const aOk = Number.isFinite(aTime);
  const bOk = Number.isFinite(bTime);
  if (aOk && bOk && aTime !== bTime) return aTime - bTime;
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function sortNestedChildren<T extends SpawnNestingSession>(children: T[]): T[] {
  return children.sort(compareNestedChildren);
}

function immediateSubagentParentId(
  session: SpawnNestingSession,
  byId: ReadonlyMap<string, SpawnNestingSession>,
): string | null {
  if (session.spawnKind !== "subagent") return null;
  const parentId = session.orchestrationParentSessionId?.trim() ?? "";
  if (!parentId || parentId === session.id) return null;
  const parent = byId.get(parentId);
  if (!parent) return null;
  if (parent.laneId !== session.laneId) return null;
  // Only a chat lists its subagents (its actions pane). A child of a tracked
  // CLI or a shell stays a top-level row, or nothing would show it.
  if (!isChatToolType(parent.toolType)) return null;
  return parent.id;
}

/**
 * Walk through parents that themselves nest until a session that stays
 * top-level. Cycles refuse to nest rather than loop.
 *
 * Quiet-parent pull-up is applied to the immediate edge first, so a working
 * child of a pulled-up (now top-level) subagent nests under that subagent
 * instead of walking through it to the quiet grandparent.
 */
function flattenToRootParentId(
  sessionId: string,
  nestUnderImmediate: ReadonlyMap<string, string>,
): string | null {
  let parentId = nestUnderImmediate.get(sessionId) ?? null;
  if (!parentId) return null;
  const seen = new Set<string>([sessionId]);
  while (parentId && nestUnderImmediate.has(parentId)) {
    if (seen.has(parentId)) return null;
    seen.add(parentId);
    parentId = nestUnderImmediate.get(parentId) ?? null;
  }
  return parentId;
}

export function indexNestedSubagents<T extends SpawnNestingSession>(
  sessions: readonly T[],
  options?: {
    nowMs?: number;
    /**
     * Session ids that currently render as cards. A child whose (flattened)
     * parent is filtered out of this set stays top-level so it remains
     * reachable. Defaults to every id in `sessions`.
     */
    visibleParentIds?: ReadonlySet<string>;
  },
): SpawnNestingIndex<T> {
  if (sessions.length === 0) return emptySpawnNestingIndex<T>();
  const nowMs = options?.nowMs ?? Date.now();
  const byId = new Map<string, T>();
  for (const session of sessions) byId.set(session.id, session);
  const visibleParentIds = options?.visibleParentIds ?? new Set(byId.keys());

  const nestUnderImmediate = new Map<string, string>();
  for (const session of sessions) {
    const parentId = immediateSubagentParentId(session, byId);
    if (!parentId) continue;
    const parent = byId.get(parentId);
    if (!parent) continue;
    if (isQuietParent(parent, nowMs) && isNotDone(session, nowMs)) continue;
    nestUnderImmediate.set(session.id, parentId);
  }

  const childrenByRootParentId = new Map<string, T[]>();
  const nestedChildIds = new Set<string>();
  const nestedChildToRootParentId = new Map<string, string>();

  for (const session of sessions) {
    const rootParentId = flattenToRootParentId(session.id, nestUnderImmediate);
    if (!rootParentId) continue;
    if (!visibleParentIds.has(rootParentId)) continue;
    nestedChildIds.add(session.id);
    nestedChildToRootParentId.set(session.id, rootParentId);
    const list = childrenByRootParentId.get(rootParentId) ?? [];
    list.push(session);
    childrenByRootParentId.set(rootParentId, list);
  }

  for (const list of childrenByRootParentId.values()) sortNestedChildren(list);

  return { childrenByRootParentId, nestedChildIds, nestedChildToRootParentId };
}

/**
 * The chat an attached shell (`chatSessionId`) files under: its own chat, or
 * that chat's root parent when the chat is itself a filed subagent.
 */
export function attachedShellNestParentId(
  session: Pick<SpawnNestingSession, "id" | "chatSessionId">,
  nestedChildToRootParentId: ReadonlyMap<string, string>,
): string | null {
  const parentId = session.chatSessionId?.trim() ?? "";
  if (!parentId || parentId === session.id) return null;
  return nestedChildToRootParentId.get(parentId) ?? parentId;
}

export function groupAttachedShellsByParentId<T extends SpawnNestingSession>(
  sessions: readonly T[],
  nestedChildToRootParentId: ReadonlyMap<string, string>,
  visibleParentIds: ReadonlySet<string>,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const session of sessions) {
    const parentId = attachedShellNestParentId(session, nestedChildToRootParentId);
    if (!parentId || !visibleParentIds.has(parentId)) continue;
    const list = map.get(parentId) ?? [];
    list.push(session);
    map.set(parentId, list);
  }
  for (const list of map.values()) sortNestedChildren(list);
  return map;
}

export function buildWorkNesting<T extends SpawnNestingSession>(
  sessions: readonly T[],
  options?: {
    nowMs?: number;
    visibleParentIds?: ReadonlySet<string>;
    nestSubagents?: boolean;
  },
): WorkNesting<T> {
  const nestSubagents = options?.nestSubagents !== false;
  const index = nestSubagents
    ? indexNestedSubagents(sessions, options)
    : emptySpawnNestingIndex<T>();
  const visibleParentIds = options?.visibleParentIds ?? new Set(sessions.map((session) => session.id));
  const attachedShellsByParentId = groupAttachedShellsByParentId(
    sessions,
    index.nestedChildToRootParentId,
    visibleParentIds,
  );
  // Attached shells and filed subagents are listed in their chat's actions
  // pane, so here they only leave the top-level rows.
  const excludedTopLevelIds = new Set(index.nestedChildIds);
  for (const list of attachedShellsByParentId.values()) {
    for (const child of list) excludedTopLevelIds.add(child.id);
  }
  return {
    subagentsByParentId: index.childrenByRootParentId,
    nestedChildIds: index.nestedChildIds,
    nestedChildToRootParentId: index.nestedChildToRootParentId,
    excludedTopLevelIds,
  };
}

/**
 * Does this subagent keep its parent's work open? True while it is mid-turn or
 * parked on a scheduled wake that has not come due (`scheduledWakeState`): it
 * reports back and wakes its parent when that turn ends, so the parent's real
 * Done is still to come. An archived, snoozed, settled, finished or failed
 * child does not.
 */
export function subagentKeepsParentBusy(child: SpawnNestingSession, nowMs: number = Date.now()): boolean {
  if (child.archivedAt) return false;
  const phase = spawnNestingPhase(child, nowMs);
  if (isSessionFiledAsSnoozed(child, phase, nowMs)) return false;
  if (phase === "starting" || phase === "running" || phase === "stale") return true;
  return (phase === "ready" || phase === "idle") && scheduledWakeState(child.nextWakeAt, nowMs) === "pending";
}

/**
 * Chats with at least one nested subagent that keeps them busy, keyed by the
 * root parent each subagent files under. The board files such a parent in
 * Waiting rather than Done; attached shells are never subagents, so a dev
 * server left running cannot keep a chat busy.
 */
export function parentsWithBusySubagents<T extends SpawnNestingSession>(
  sessions: readonly T[],
  nowMs: number = Date.now(),
): Set<string> {
  const parents = new Set<string>();
  const byId = new Map(sessions.map((session) => [session.id, session] as const));
  for (const [childId, parentId] of indexNestedSubagents(sessions, { nowMs }).nestedChildToRootParentId) {
    const child = byId.get(childId);
    if (child && subagentKeepsParentBusy(child, nowMs)) parents.add(parentId);
  }
  return parents;
}

export type NestedSubagentStatus = "failed" | "needs_you" | "running";

/** How each subagent status reads on every surface: one word, one tone. */
export const NESTED_SUBAGENT_STATUS_PRESENTATION: Record<
  NestedSubagentStatus,
  { label: string; tone: SessionStatusTone }
> = {
  failed: { label: "Failed", tone: "red" },
  needs_you: { label: "Needs you", tone: "amber" },
  running: { label: "Running", tone: "blue" },
};

const NESTED_SUBAGENT_STATUS_RANK: Record<NestedSubagentStatus, number> = {
  running: 1,
  needs_you: 2,
  failed: 3,
};

/**
 * One child's contribution to its parent's mark. Failed and needs you are the
 * words the child's own row shouts (`sessionStatusShoutsLabel`), so a
 * usage-limit resume that remaps a failed phase off red counts as nothing.
 * Ended and done children add nothing.
 */
function nestedSubagentStatus(child: SpawnNestingSession, nowMs: number): NestedSubagentStatus | null {
  const phase = spawnNestingPhase(child, nowMs);
  const presentation = sessionStatusPresentation(
    phase,
    { snoozed: isSessionFiledAsSnoozed(child, phase, nowMs) },
    {
      nowMs,
      usageLimitResume: child.usageLimitResume,
      chatActivityMode: child.chatActivityMode,
      nextWakeAt: child.nextWakeAt,
      backgroundWork: child.backgroundWork,
    },
  );
  if (presentation && sessionStatusShoutsLabel(presentation)) {
    return presentation.tone === "red" ? "failed" : "needs_you";
  }
  return phase === "running" || phase === "starting" ? "running" : null;
}

/** The parent row's one mark for its filed subagents: how many, and the worst state. */
export type NestedSubagentMark = {
  count: number;
  /** Worst child state: failed, then needs you, then running. Null when none. */
  status: NestedSubagentStatus | null;
  /** How many children are in that worst state. 0 when `status` is null. */
  statusCount: number;
};

/** Null for a parent with no filed subagents. One pass over the children. */
export function nestedSubagentMark(
  children: readonly SpawnNestingSession[],
  nowMs: number = Date.now(),
): NestedSubagentMark | null {
  if (children.length === 0) return null;
  let status: NestedSubagentStatus | null = null;
  let statusCount = 0;
  for (const child of children) {
    const childStatus = nestedSubagentStatus(child, nowMs);
    if (!childStatus) continue;
    if (!status || NESTED_SUBAGENT_STATUS_RANK[childStatus] > NESTED_SUBAGENT_STATUS_RANK[status]) {
      status = childStatus;
      statusCount = 1;
    } else if (childStatus === status) {
      statusCount += 1;
    }
  }
  return { count: children.length, status, statusCount };
}

const MARK_STATUS_WORDS: Record<NestedSubagentStatus, [one: string, many: string]> = {
  failed: ["failed", "failed"],
  needs_you: ["needs you", "need you"],
  running: ["running", "running"],
};

/** The mark's spoken form, e.g. "2 subagents, 1 needs you". */
export function nestedSubagentMarkLabel(mark: NestedSubagentMark): string {
  const base = pluralCount(mark.count, "subagent");
  if (!mark.status || mark.statusCount === 0) return base;
  const [one, many] = MARK_STATUS_WORDS[mark.status];
  return `${base}, ${mark.statusCount} ${mark.statusCount === 1 ? one : many}`;
}

/**
 * The subagent chats a parent's actions pane lists from the machine's session
 * list: every session the Work list files under this parent, grandchildren
 * included. The list leaves them out, so the pane is where they are reached. A
 * quiet parent's unfinished children are top-level rows and are not here.
 */
export function filedSubagentsOf<T extends SpawnNestingSession>(
  sessions: readonly T[],
  parentId: string | null | undefined,
  nowMs: number = Date.now(),
): T[] {
  const id = parentId?.trim();
  if (!id || sessions.length === 0) return [];
  return indexNestedSubagents(sessions, { nowMs }).childrenByRootParentId.get(id) ?? [];
}

/** The actions-pane status of a child chat with this canonical phase. */
export function childChatPaneStatus(
  phase: CanonicalSessionPhase,
): "running" | "completed" | "failed" | "stopped" {
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
    case "ready":
    case "idle":
    case "ended":
    case "settled":
      return "completed";
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}
