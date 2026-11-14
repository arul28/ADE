import { useMemo } from "react";
import type { CanonicalSessionPhase } from "../../../shared/sessionCanonicalState";
import {
  childChatPaneStatus,
  chatToolProvider,
  filedSubagentsOf,
  spawnNestingPhase,
} from "../../../shared/sessionSpawnNesting";
import {
  ORPHAN_SUBAGENT_CHAT_ENDED_SUMMARY,
  ORPHAN_SUBAGENT_NO_REPORT_SUMMARY,
} from "../../../shared/chatOrphanRunReconcile";
import type { AgentChatSessionStatus, TerminalSessionSummary } from "../../../shared/types";
import { primarySessionLabel } from "../../lib/sessions";
import { useStableIdentity } from "../../lib/stableIdentity";
import { projectStateKeyForBinding, useAppStore } from "../../state/appStore";
import { useSessionsForPin } from "../../state/crossMachineLanes";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import { isBackgroundShellCommand } from "../../../shared/chatSubagents";
import { paneRowChildSessionId, selfHealSubagentSnapshots } from "./chatPaneSelfHeal";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * What the actions pane reads about a chat's child chats from the sessions of
 * the machine the chat runs on. The Work list files a chat's subagents under it
 * (`sessionSpawnNesting`), so this pane is where they are reached:
 *
 * - a filed subagent the transcript has no row for (a peer promoted to
 *   subagent, a grandchild, a transcript that predates or windowed away the
 *   spawn) gets a row, appended after the transcript's rows;
 * - any child-chat row whose chat is waiting on the user says so;
 * - the pane's self-heal learns the state of children this chat's runtime has
 *   not loaded, so it does not close a row whose child is still working.
 *
 * Titles and liveness are not read here: the pane's own props carry them.
 */

type ChildChat = { session: TerminalSessionSummary; phase: CanonicalSessionPhase };

type ChatChildRoster = {
  /** Filed subagents of this chat, in filing order. */
  filed: readonly ChildChat[];
  /** Every child chat the pane can name, filed or named by a transcript row. */
  byId: ReadonlyMap<string, ChildChat>;
};

const EMPTY_ROSTER: ChatChildRoster = { filed: [], byId: new Map() };

/**
 * The sessions of the machine this chat runs on: that machine's slice of the
 * cross-machine union when pinned, else the tab's own session cache. Store
 * reads only; nothing is fetched or polled for this.
 */
export function useChatMachineSessions(): TerminalSessionSummary[] | null {
  const scope = useChatRuntimeScope();
  const pinned = useSessionsForPin(scope.binding);
  const bound = useAppStore((state) => {
    if (scope.binding) return null;
    const key = projectStateKeyForBinding(null, scope.rootPath);
    return key ? state.sessionsCacheByProject[key] ?? null : null;
  });
  return pinned ?? bound;
}

function sameChildChat(left: ChildChat | undefined, right: ChildChat): boolean {
  return left != null
    && left.phase === right.phase
    && left.session.id === right.session.id
    && left.session.laneId === right.session.laneId
    && primarySessionLabel(left.session) === primarySessionLabel(right.session)
    && left.session.toolType === right.session.toolType
    && left.session.startedAt === right.session.startedAt
    && left.session.endedAt === right.session.endedAt
    && left.session.lastActivityAt === right.session.lastActivityAt;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Churn elsewhere on the machine must not rebuild this pane's rows. */
function sameRoster(left: ChatChildRoster, right: ChatChildRoster): boolean {
  if (left.filed.length !== right.filed.length || left.byId.size !== right.byId.size) return false;
  for (const [id, child] of right.byId) {
    if (!sameChildChat(left.byId.get(id), child)) return false;
  }
  return right.filed.every((child, index) => left.filed[index]?.session.id === child.session.id);
}

function buildChatChildRoster(
  sessions: readonly TerminalSessionSummary[] | null,
  parentId: string | null | undefined,
  namedChildIds: readonly string[],
): ChatChildRoster {
  if (!sessions?.length || !parentId) return EMPTY_ROSTER;
  const nowMs = Date.now();
  const byId = new Map<string, ChildChat>();
  const filed = filedSubagentsOf(sessions, parentId, nowMs).map((session) => {
    const child = { session, phase: spawnNestingPhase(session, nowMs) };
    byId.set(session.id, child);
    return child;
  });
  // A `chat:<id>` row is only ever written into the chat that spawned that
  // child, so looking the id up among all the machine's sessions finds the same
  // chat the iOS mirror finds among this chat's children.
  if (namedChildIds.length > 0) {
    const sessionById = new Map(sessions.map((session) => [session.id, session] as const));
    for (const id of namedChildIds) {
      const session = sessionById.get(id);
      if (session && !byId.has(id)) byId.set(id, { session, phase: spawnNestingPhase(session, nowMs) });
    }
  }
  return byId.size === 0 ? EMPTY_ROSTER : { filed, byId };
}

/** The chat status a child in this phase has, in the self-heal's terms. */
function phaseChatStatus(phase: CanonicalSessionPhase): AgentChatSessionStatus {
  switch (phase) {
    case "starting":
    case "running":
    case "stale":
    case "needs_you":
      return "active";
    case "ready":
    case "idle":
      return "idle";
    case "failed":
    case "stopped":
    case "ended":
    case "settled":
      return "ended";
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

function filedSubagentRow(child: ChildChat): ChatSubagentSnapshot {
  const { session, phase } = child;
  return {
    taskId: `chat:${session.id}`,
    childSessionId: session.id,
    agentId: session.id,
    agentType: chatToolProvider(session.toolType) ?? session.toolType ?? undefined,
    parentToolUseId: null,
    description: primarySessionLabel(session),
    status: childChatPaneStatus(phase),
    startedAt: session.startedAt,
    elapsedStartAt: null,
    updatedAt: session.lastActivityAt ?? session.endedAt ?? session.startedAt,
    summary: null,
    background: false,
    taskType: "subagent",
    spawnKind: "subagent",
  };
}

/**
 * The pane's rows with the chat's filed subagents added, a lookup for the
 * child chats it names, and the child statuses the self-heal reads: the chat
 * runtime's own (`runtimeChildStatuses`) where it has one, else the child's
 * state on its machine. Returns the inputs themselves when nothing is added.
 */
export function useChatChildRoster(
  parentId: string | null | undefined,
  snapshots: ChatSubagentSnapshot[],
  runtimeChildStatuses: ReadonlyMap<string, AgentChatSessionStatus> | undefined,
): {
  snapshots: ChatSubagentSnapshot[];
  childById: ReadonlyMap<string, ChildChat>;
  childStatuses: ReadonlyMap<string, AgentChatSessionStatus> | undefined;
} {
  const sessions = useChatMachineSessions();
  // The child ids the rows name, kept stable while the rows only stream.
  const namedChildIds = useStableIdentity(
    useMemo(() => {
      const ids = new Set<string>();
      for (const snapshot of snapshots) {
        const id = paneRowChildSessionId(snapshot);
        if (id) ids.add(id);
      }
      return [...ids].sort();
    }, [snapshots]),
    sameIds,
  );
  const roster = useStableIdentity(
    useMemo(
      () => buildChatChildRoster(sessions, parentId, namedChildIds),
      [sessions, parentId, namedChildIds],
    ),
    sameRoster,
  );
  const withFiled = useMemo(() => {
    const covered = new Set(namedChildIds);
    const missing = roster.filed.filter((child) => !covered.has(child.session.id));
    const rows = missing.length === 0 ? snapshots : [...snapshots, ...missing.map(filedSubagentRow)];
    // Only children that report back are this chat's subagents. A chat that
    // does not report back is a normal chat, listed in Work, not here.
    const reporting = rows.filter((row) => !childDoesNotReport(row, roster.byId));
    return reporting.length === snapshots.length && missing.length === 0 ? snapshots : reporting;
  }, [namedChildIds, roster, snapshots]);
  const childStatuses = useMemo(() => {
    let merged: Map<string, AgentChatSessionStatus> | null = null;
    for (const [id, child] of roster.byId) {
      if (runtimeChildStatuses?.has(id)) continue;
      merged ??= new Map(runtimeChildStatuses ?? []);
      merged.set(id, phaseChatStatus(child.phase));
    }
    return merged ?? runtimeChildStatuses;
  }, [roster, runtimeChildStatuses]);
  return { snapshots: withFiled, childById: roster.byId, childStatuses };
}

/**
 * The chat's subagent rows as the actions pane shows them: the children that
 * report back (filed ones added), "running" healed against what the machine
 * says, and a settled spawned chat worded like its transcript card. The pane
 * and the toolbar badge both read this, so they cannot disagree.
 */
export function useChatSubagentRows(
  parentId: string | null | undefined,
  snapshots: ChatSubagentSnapshot[],
  runtimeChildStatuses: ReadonlyMap<string, AgentChatSessionStatus> | undefined,
  runtimeAlive: boolean | undefined,
): { rows: ChatSubagentSnapshot[]; childById: ReadonlyMap<string, ChildChat> } {
  const { snapshots: withRoster, childById, childStatuses } = useChatChildRoster(
    parentId,
    snapshots,
    runtimeChildStatuses,
  );
  const rows = useMemo(
    () => settleChildRowsLikeCards(
      selfHealSubagentSnapshots(withRoster, { runtimeAlive, childChatStatuses: childStatuses }),
      childById,
    ),
    [withRoster, runtimeAlive, childStatuses, childById],
  );
  return { rows, childById };
}

/** How many of those rows are running now: the toolbar badge's number. */
export function runningSubagentRowCount(rows: readonly ChatSubagentSnapshot[]): number {
  let count = 0;
  for (const row of rows) {
    if (row.status !== "running") continue;
    if (isBackgroundShellCommand({ taskType: row.taskType, agentType: row.agentType, description: row.description })) continue;
    count += 1;
  }
  return count;
}

/**
 * The self-heal's "Stopped: … went idle without a report" is written for a
 * delegate cut short. A spawned chat whose turn simply ended is done: its card
 * and its Work row say so, and its row here uses the same word.
 */
const HEALED_STOP_SUMMARIES: ReadonlySet<string> = new Set([
  ORPHAN_SUBAGENT_NO_REPORT_SUMMARY,
  ORPHAN_SUBAGENT_CHAT_ENDED_SUMMARY,
]);

function settleChildRowsLikeCards(
  rows: ChatSubagentSnapshot[],
  childById: ReadonlyMap<string, ChildChat>,
): ChatSubagentSnapshot[] {
  if (childById.size === 0) return rows;
  let changed = false;
  const next = rows.map((row) => {
    if (row.status === "running") return row;
    const id = paneRowChildSessionId(row);
    const child = id != null ? childById.get(id) : undefined;
    if (!child) return row;
    const status = childChatPaneStatus(child.phase);
    if (status === "running" || status === row.status) return row;
    changed = true;
    const healedText = (text: string | null | undefined) => text != null && HEALED_STOP_SUMMARIES.has(text);
    return {
      ...row,
      status,
      summary: healedText(row.summary) ? null : row.summary,
      finalSummary: healedText(row.finalSummary) ? null : row.finalSummary,
    };
  });
  return changed ? next : rows;
}

/**
 * The child chat's own kind decides: "Report back" and "Stop reports" change
 * it after the row was written. The row's kind counts only for a child this
 * machine does not list.
 */
function childDoesNotReport(row: ChatSubagentSnapshot, childById: ReadonlyMap<string, ChildChat>): boolean {
  const id = paneRowChildSessionId(row);
  const current = id != null ? childById.get(id)?.session.spawnKind : undefined;
  return (current ?? row.spawnKind) === "peer";
}

/**
 * The pane status of one spawned child chat, read from its machine's sessions:
 * running, completed, failed or stopped. Null when the chat is not known here.
 */
export function useSpawnedChildPaneStatus(
  childSessionId: string | null | undefined,
): "running" | "completed" | "failed" | "stopped" | null {
  const sessions = useChatMachineSessions();
  const id = childSessionId?.trim() || null;
  return useMemo(() => {
    if (!id || !sessions?.length) return null;
    const session = sessions.find((candidate) => candidate.id === id);
    return session ? childChatPaneStatus(spawnNestingPhase(session, Date.now())) : null;
  }, [id, sessions]);
}

type SpawnedChildPaneStatus = "running" | "completed" | "failed" | "stopped";

/**
 * The pane status of several spawned child chats at once, keyed by chat id:
 * what each card's `useSpawnedChildPaneStatus` reads, for a header that counts
 * the cards. A chat this machine does not list has no entry.
 */
export function useSpawnedChildPaneStatuses(
  childSessionIds: readonly string[],
): ReadonlyMap<string, SpawnedChildPaneStatus> {
  const sessions = useChatMachineSessions();
  const ids = useStableIdentity(childSessionIds, sameIds);
  return useMemo(() => {
    const statuses = new Map<string, SpawnedChildPaneStatus>();
    if (ids.length === 0 || !sessions?.length) return statuses;
    const wanted = new Set(ids);
    const nowMs = Date.now();
    for (const session of sessions) {
      if (wanted.has(session.id)) statuses.set(session.id, childChatPaneStatus(spawnNestingPhase(session, nowMs)));
    }
    return statuses;
  }, [ids, sessions]);
}

function sameChildRows(left: readonly ChatSubagentSnapshot[], right: readonly ChatSubagentSnapshot[]): boolean {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index];
    return other != null
      && row.childSessionId === other.childSessionId
      && row.status === other.status
      && row.description === other.description
      && row.updatedAt === other.updatedAt
      && row.spawnKind === other.spawnKind;
  });
}

const EMPTY_CHILD_ROWS: ChatSubagentSnapshot[] = [];

/**
 * The actions-pane rows of a tracked agent CLI's children: every session on
 * the CLI's machine that names it as its parent, chats and CLIs alike, oldest
 * first. A CLI has no transcript to name them, and the Work list keeps them as
 * top-level rows (only a chat files its subagents), so this is the list the
 * CLI's own pane shows. Store reads only, under the surrounding
 * `ChatRuntimeScopeProvider`; nothing is fetched or polled.
 */
export function useCliParentChildRows(parentId: string | null | undefined): ChatSubagentSnapshot[] {
  const sessions = useChatMachineSessions();
  const rows = useMemo(() => {
    const id = parentId?.trim();
    if (!id || !sessions?.length) return EMPTY_CHILD_ROWS;
    const nowMs = Date.now();
    const children = sessions
      .filter((session) => session.id !== id
        && session.orchestrationParentSessionId?.trim() === id
        // Only children that report back; one that does not is a normal chat.
        && session.spawnKind === "subagent"
        && !session.archivedAt)
      .sort((left, right) => (left.startedAt < right.startedAt ? -1 : left.startedAt > right.startedAt ? 1 : 0));
    if (children.length === 0) return EMPTY_CHILD_ROWS;
    return children.map((session) => ({
      ...filedSubagentRow({ session, phase: spawnNestingPhase(session, nowMs) }),
      agentType: chatToolProvider(session.toolType) ?? session.toolType ?? undefined,
      spawnKind: session.spawnKind ?? "subagent",
    }));
  }, [parentId, sessions]);
  return useStableIdentity(rows, sameChildRows);
}
