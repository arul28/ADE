import {
  backgroundWorkFromSummary,
  canonicalSessionState,
  isSessionFiledAsSnoozed,
  type CanonicalSessionPhase,
} from "./sessionCanonicalState";
import { sessionStatusPresentation, sessionStatusShoutsLabel } from "./sessionStatusPresentation";
import type { TerminalSessionSummary } from "./types/sessions";

/**
 * Same-lane `spawnKind: "subagent"` chats (and tracked CLI `--type subagent`
 * sessions) nest under their parent in the by-lane Work list, the way attached
 * shells already do. Peers stay top-level. This module is the one filing rule
 * desktop, ADE Code, and the iOS mirror consult so a demote, a quiet-parent
 * pull-up, or a grandchild flatten cannot disagree across surfaces.
 *
 * Quiet parent (snoozed / settled): not-done children (starting, running,
 * needs_you, failed, stale) promote to top-level cards. Done children stay
 * nested and follow the parent into the quiet tails.
 *
 * Grandchildren flatten into the root parent's one drawer — a compact nested
 * row cannot own a second indent.
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
>;

export type NestedSubagentDrawerAttention = "failed" | "needs_you" | null;

export type SpawnNestingIndex<T extends SpawnNestingSession = SpawnNestingSession> = {
  childrenByRootParentId: Map<string, T[]>;
  nestedChildIds: Set<string>;
  nestedChildToRootParentId: Map<string, string>;
};

export type WorkNestingDrawers<T extends SpawnNestingSession = SpawnNestingSession> = {
  subagentsByParentId: Map<string, T[]>;
  shellsByParentId: Map<string, T[]>;
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

export function nestedSubagentSectionId(parentId: string): string {
  return `chat-subagents:${parentId}`;
}

export function attachedShellSectionId(parentId: string): string {
  return `chat:${parentId}`;
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

function phaseOf(session: SpawnNestingSession, nowMs: number): CanonicalSessionPhase {
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
  const phase = phaseOf(session, nowMs);
  if (isSessionFiledAsSnoozed(session, phase, nowMs)) return true;
  return phase === "settled";
}

function isNotDone(session: SpawnNestingSession, nowMs: number): boolean {
  const phase = phaseOf(session, nowMs);
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
 * Attached shells (`chatSessionId`) of a nested subagent remount onto the
 * root parent's shell drawer so they do not vanish with the compact child.
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

export function workNestingDrawers<T extends SpawnNestingSession>(
  sessions: readonly T[],
  options?: {
    nowMs?: number;
    visibleParentIds?: ReadonlySet<string>;
    nestSubagents?: boolean;
  },
): WorkNestingDrawers<T> {
  const nestSubagents = options?.nestSubagents !== false;
  const index = nestSubagents
    ? indexNestedSubagents(sessions, options)
    : emptySpawnNestingIndex<T>();
  const visibleParentIds = options?.visibleParentIds ?? new Set(sessions.map((session) => session.id));
  const shellsByParentId = groupAttachedShellsByParentId(
    sessions,
    index.nestedChildToRootParentId,
    visibleParentIds,
  );
  const excludedTopLevelIds = new Set(index.nestedChildIds);
  for (const list of shellsByParentId.values()) {
    for (const child of list) excludedTopLevelIds.add(child.id);
  }
  return {
    subagentsByParentId: index.childrenByRootParentId,
    shellsByParentId,
    nestedChildIds: index.nestedChildIds,
    nestedChildToRootParentId: index.nestedChildToRootParentId,
    excludedTopLevelIds,
  };
}

export function isTopLevelWorkSession(
  session: SpawnNestingSession,
  rosterIds: ReadonlySet<string>,
  nestedChildIds: ReadonlySet<string>,
  nestedChildToRootParentId: ReadonlyMap<string, string>,
): boolean {
  if (nestedChildIds.has(session.id)) return false;
  const shellParent = attachedShellNestParentId(session, nestedChildToRootParentId);
  if (shellParent && shellParent !== session.id && rosterIds.has(shellParent)) return false;
  return true;
}

export function nestedSubagentDrawerAttention(
  children: readonly SpawnNestingSession[],
  nowMs: number = Date.now(),
): NestedSubagentDrawerAttention {
  let needsYou = false;
  for (const child of children) {
    const phase = phaseOf(child, nowMs);
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
    if (!presentation) continue;
    if (sessionStatusShoutsLabel(presentation)) {
      if (presentation.tone === "red") return "failed";
      needsYou = true;
    }
  }
  return needsYou ? "needs_you" : null;
}
