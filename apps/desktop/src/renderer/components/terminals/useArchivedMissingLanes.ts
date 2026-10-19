import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";

/** A lane the Work list has chats for but no lane row, and those chats. */
type MissingLaneGroup = readonly [laneId: string, sessions: readonly TerminalSessionSummary[]];

/** The missing lanes one machine owns: its pin (`null` is the tab's own machine) and their ids. */
type MissingLaneQuery = { pin: OpenProjectBinding | null; laneIds: string[] };

const NO_ARCHIVED_LANE_IDS: ReadonlySet<string> = new Set();

/**
 * Groups the missing lanes by the machine their chats run on. A lane owns its
 * machine, so the first chat of a group names the machine for the whole group.
 * Sorted, so a list that merely re-orders (groups order by their newest chat)
 * produces the same queries.
 */
function missingLaneQueries(
  groups: readonly MissingLaneGroup[],
  resolvePin: (session: TerminalSessionSummary) => OpenProjectBinding | null,
): MissingLaneQuery[] {
  const byPinKey = new Map<string, MissingLaneQuery>();
  for (const [laneId, sessions] of groups) {
    const first = sessions[0];
    if (!first) continue;
    const pin = resolvePin(first);
    const pinKey = pin?.key ?? "";
    const query = byPinKey.get(pinKey) ?? { pin, laneIds: [] };
    query.laneIds.push(laneId);
    byPinKey.set(pinKey, query);
  }
  return [...byPinKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, query]) => ({ pin: query.pin, laneIds: [...query.laneIds].sort() }));
}

/** Which of the query's lanes its machine reports as archived. */
async function archivedLaneIdsOf(query: MissingLaneQuery): Promise<string[]> {
  // Status stays off: with it on, the owning machine runs git for every lane,
  // and archived-ness is all this read is for.
  const lanes = await window.ade.lanes.list({ includeArchived: true, includeStatus: false }, query.pin);
  const missing = new Set(query.laneIds);
  return lanes
    .filter((lane) => Boolean(lane.archivedAt) && missing.has(lane.id))
    .map((lane) => lane.id);
}

/**
 * The lane ids, out of `missingGroups`, that are archived on the machine owning
 * their chats.
 *
 * The lane list asks for live lanes only, so a chat on an archived lane has no
 * lane row and would read as an orphan. This asks each owning machine once per
 * change of the missing set: the effect is keyed on the queries' ids and
 * `pin?.key`, never on the pin object, a group list rebuilt on every poll, or a
 * render. A lane the machine does not report as archived stays missing. A failed
 * read leaves its machine's groups as they were, and is not retried until the
 * missing set changes.
 */
export function useArchivedMissingLaneIds(
  missingGroups: readonly MissingLaneGroup[],
  resolvePin: (session: TerminalSessionSummary) => OpenProjectBinding | null,
): ReadonlySet<string> {
  const queries = useMemo(
    () => missingLaneQueries(missingGroups, resolvePin),
    [missingGroups, resolvePin],
  );
  const queryKey = useMemo(
    () => JSON.stringify(queries.map((query) => [query.pin?.key ?? "", query.laneIds])),
    [queries],
  );
  // The read effect below runs only when the key changes, and reads the queries
  // of the render that changed it. This ref carries them there without putting
  // every rebuilt group list into the effect's dependencies.
  const queriesRef = useRef(queries);
  useEffect(() => {
    queriesRef.current = queries;
  });
  const [resolved, setResolved] = useState<{ queryKey: string; archivedLaneIds: ReadonlySet<string> } | null>(null);

  useEffect(() => {
    const current = queriesRef.current;
    if (current.length === 0) return undefined;
    let cancelled = false;
    // Best effort: a machine that cannot answer leaves its groups missing, as
    // they were before this read.
    void Promise.all(current.map((query) => archivedLaneIdsOf(query).catch(() => [] as string[])))
      .then((perMachine) => {
        const archivedLaneIds = new Set(perMachine.flat());
        // Nothing archived renders the same as no answer, so it needs no state.
        if (cancelled || archivedLaneIds.size === 0) return;
        setResolved({ queryKey, archivedLaneIds });
      });
    return () => {
      cancelled = true;
    };
  }, [queryKey]);

  // A result for an earlier missing set says nothing about this one.
  return resolved?.queryKey === queryKey ? resolved.archivedLaneIds : NO_ARCHIVED_LANE_IDS;
}
