import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";

/** A lane the Work list has chats for but no lane row, and those chats. */
type MissingLaneGroup = readonly [laneId: string, sessions: readonly TerminalSessionSummary[]];

/**
 * The missing lanes one machine owns: its pin (`null` is the tab's own machine),
 * the scope that names that machine, and their ids. The scope is the pin's key,
 * or the tab binding's key for a null pin, so a read never outlives its project.
 */
type MissingLaneQuery = { pin: OpenProjectBinding | null; scopeKey: string; laneIds: string[] };

const NO_ARCHIVED_LANE_IDS: ReadonlySet<string> = new Set();

/**
 * Groups the missing lanes by the machine their chats run on. A lane owns its
 * machine, so the first chat of a group names the machine for the whole group.
 * A null pin is the tab's own machine, so it takes the tab binding's key as its
 * scope. Sorted, so a list that merely re-orders (groups order by their newest
 * chat) produces the same queries.
 */
function missingLaneQueries(
  groups: readonly MissingLaneGroup[],
  resolvePin: (session: TerminalSessionSummary) => OpenProjectBinding | null,
  tabBindingKey: string | null,
): MissingLaneQuery[] {
  const byScopeKey = new Map<string, MissingLaneQuery>();
  for (const [laneId, sessions] of groups) {
    const first = sessions[0];
    if (!first) continue;
    const pin = resolvePin(first);
    const scopeKey = pin?.key ?? tabBindingKey ?? "";
    const query = byScopeKey.get(scopeKey) ?? { pin, scopeKey, laneIds: [] };
    query.laneIds.push(laneId);
    byScopeKey.set(scopeKey, query);
  }
  return [...byScopeKey.values()]
    .sort((left, right) => (left.scopeKey < right.scopeKey ? -1 : left.scopeKey > right.scopeKey ? 1 : 0))
    .map((query) => ({ ...query, laneIds: [...query.laneIds].sort() }));
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
 * change of the missing set or of a machine's scope: the effect is keyed on each
 * query's scope and lane ids, never on the pin object, a group list rebuilt on
 * every poll, or a render. `tabBindingKey` is the project tab's binding key. A
 * chat with a null pin is on that machine, so switching the tab asks it again.
 * A lane the machine does not report as archived stays missing. A machine that
 * cannot answer leaves its groups missing, and is not asked again until the set
 * or the scope changes.
 */
export function useArchivedMissingLaneIds(
  missingGroups: readonly MissingLaneGroup[],
  resolvePin: (session: TerminalSessionSummary) => OpenProjectBinding | null,
  tabBindingKey: string | null,
): ReadonlySet<string> {
  const queries = useMemo(
    () => missingLaneQueries(missingGroups, resolvePin, tabBindingKey),
    [missingGroups, resolvePin, tabBindingKey],
  );
  const queryKey = useMemo(
    () => JSON.stringify(queries.map((query) => [query.scopeKey, query.laneIds])),
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
        if (cancelled) return;
        // Recorded even when nothing is archived: an answer kept from an earlier
        // scope would otherwise come back when the tab returns to that scope.
        setResolved({ queryKey, archivedLaneIds: new Set(perMachine.flat()) });
      });
    return () => {
      cancelled = true;
    };
  }, [queryKey]);

  // A result for another missing set or scope says nothing about this one.
  return resolved?.queryKey === queryKey ? resolved.archivedLaneIds : NO_ARCHIVED_LANE_IDS;
}
