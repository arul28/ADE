import { useMemo } from "react";
import type { CanonicalSessionPhase } from "../../../shared/sessionCanonicalState";
import {
  childChatPaneStatus,
  chatToolProvider,
  filedSubagentsOf,
  spawnNestingPhase,
} from "../../../shared/sessionSpawnNesting";
import type { TerminalSessionSummary } from "../../../shared/types";
import { primarySessionLabel } from "../../lib/sessions";
import { useStableIdentity } from "../../lib/stableIdentity";
import { projectStateKeyForBinding, useAppStore } from "../../state/appStore";
import { useSessionsForPin } from "../../state/crossMachineLanes";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import { paneRowChildSessionId } from "./chatPaneSelfHeal";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * What the actions pane reads about a chat's child chats from the sessions of
 * the machine the chat runs on. The Work list files a chat's subagents under it
 * (`sessionSpawnNesting`), so this pane is where they are reached:
 *
 * - a filed subagent the transcript has no row for (a peer promoted to
 *   subagent, a grandchild, a transcript that predates or windowed away the
 *   spawn) gets a row, appended after the transcript's rows;
 * - any child-chat row whose chat is waiting on the user says so.
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
function useChatMachineSessions(): TerminalSessionSummary[] | null {
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
 * The pane's rows with the chat's filed subagents added, and a lookup for the
 * child chats it names. Returns `snapshots` itself when nothing is added.
 */
export function useChatChildRoster(
  parentId: string | null | undefined,
  snapshots: ChatSubagentSnapshot[],
): {
  snapshots: ChatSubagentSnapshot[];
  childById: ReadonlyMap<string, ChildChat>;
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
    if (roster.filed.length === 0) return snapshots;
    const covered = new Set(namedChildIds);
    const missing = roster.filed.filter((child) => !covered.has(child.session.id));
    return missing.length === 0 ? snapshots : [...snapshots, ...missing.map(filedSubagentRow)];
  }, [namedChildIds, roster, snapshots]);
  return { snapshots: withFiled, childById: roster.byId };
}
