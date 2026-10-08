import { useEffect, useMemo, useRef } from "react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import type { SessionFilingBucket } from "../../lib/terminalAttention";
import { parentsWithBusySubagents } from "../../../shared/sessionSpawnNesting";
import { workFocusQueue } from "./workLaneFocus";

const EMPTY_ID_SET: ReadonlySet<string> = new Set();

/** A chat the Focus grid shows, with the machine it lives on (null = this one). */
export type WorkFocusQueueItem = {
  session: TerminalSessionSummary;
  binding: OpenProjectBinding | null;
};

/**
 * The sidebar's half of the Focus grid: every chat the grid shows, reported up
 * to `TerminalsPage`. This machine's chats (`localIds`, already filtered by
 * the sidebar's Focus rule) come first, then each other machine's unfolded
 * lanes by the same rule. A row from another machine carries its binding so
 * the tile talks to that machine; one with no open binding cannot render a
 * chat and is left out. Reported only when what a tile shows can change, not
 * on every streamed status tick. Returns how many chats wait.
 */
export function useWorkFocusQueueReport({
  active,
  localSessions,
  localIds,
  foreignRows,
  foldedForeignLaneIds,
  filingBucketsFor,
  foreignNesting,
  nowMs,
  onChange,
}: {
  active: boolean;
  localSessions: readonly TerminalSessionSummary[];
  localIds: readonly string[];
  foreignRows: readonly {
    machineId: string;
    lane: { id: string };
    binding?: OpenProjectBinding | null;
    sessions: readonly TerminalSessionSummary[];
  }[];
  foldedForeignLaneIds: ReadonlySet<string>;
  filingBucketsFor: (sessions: readonly TerminalSessionSummary[]) => ReadonlyMap<string, SessionFilingBucket>;
  /** Each foreign lane's nesting, keyed by `machineId:laneId`. */
  foreignNesting: ReadonlyMap<string, { excludedTopLevelIds: ReadonlySet<string> }>;
  nowMs: number;
  onChange?: (items: readonly WorkFocusQueueItem[]) => void;
}): number {
  const items = useMemo<WorkFocusQueueItem[]>(() => {
    if (!active) return [];
    const next: WorkFocusQueueItem[] = [];
    const localById = new Map(localSessions.map((session) => [session.id, session] as const));
    // Busy parents come from each machine's whole roster, the same rule the
    // local queue reads, so a parent its subagent keeps busy gets no tile.
    const rosterByMachine = new Map<string, TerminalSessionSummary[]>();
    for (const row of foreignRows) {
      const roster = rosterByMachine.get(row.machineId) ?? [];
      roster.push(...row.sessions);
      rosterByMachine.set(row.machineId, roster);
    }
    const busyParentsByMachine = new Map<string, Set<string>>();
    for (const [machineId, roster] of rosterByMachine) {
      busyParentsByMachine.set(machineId, parentsWithBusySubagents(roster, nowMs));
    }
    for (const id of localIds) {
      const session = localById.get(id);
      if (session) next.push({ session, binding: null });
    }
    for (const row of foreignRows) {
      const compositeLaneId = `${row.machineId}:${row.lane.id}`;
      if (foldedForeignLaneIds.has(compositeLaneId) || !row.binding) continue;
      const ids = workFocusQueue({
        sessions: row.sessions,
        filingBuckets: filingBucketsFor(row.sessions),
        foldedLaneIds: EMPTY_ID_SET,
        laneWaiting: () => false,
        nestedSessionIds: foreignNesting.get(compositeLaneId)?.excludedTopLevelIds ?? EMPTY_ID_SET,
        busySubagentParentIds: busyParentsByMachine.get(row.machineId),
        nowMs,
      });
      const byId = new Map(row.sessions.map((session) => [session.id, session] as const));
      for (const id of ids) {
        const session = byId.get(id);
        if (session) next.push({ session, binding: row.binding });
      }
    }
    return next;
  }, [active, filingBucketsFor, foldedForeignLaneIds, foreignNesting, foreignRows, localIds, localSessions, nowMs]);
  // Every field a tile's header reads, plus the machine it routes to.
  const key = items
    .map(({ session, binding }) => [
      session.id,
      session.status,
      session.runtimeState ?? "",
      session.lastActivityAt ?? "",
      session.pendingInputItemId ?? "",
      session.title ?? "",
      session.toolType ?? "",
      session.laneId,
      session.pinned ? "1" : "",
      binding?.key ?? "",
    ].join("|"))
    .join("\n");
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current?.(itemsRef.current);
  }, [key]);
  return items.length;
}
