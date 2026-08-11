import type { AdeDb, SqlValue } from "../state/kvDb";
import { SettlingStateRegistry, type SettleAbortReason } from "./settlingStateRegistry";
import type { SessionSettleOverride, SessionSettleSource } from "../../../shared/types/sessions";

/**
 * The settle-lifecycle writer.
 *
 * Extracted from `sessionService` so the "no settle-tuple SQL outside this
 * unit" invariant is a FILE boundary rather than a pair of offsets inside a
 * 1900-line module — `settleLifecycleWriter.test.ts` allowlists this file and
 * scans everything else.
 */
/** What a settle-lifecycle mutation is asking for. */
export type SettleLifecycleIntent =
  | { kind: "settle"; settledAt: string; source: SessionSettleSource }
  /**
   * Real activity: drop the whole declaration, keep-active pin included.
   *
   * `cause` is what makes teardown possible at all. Stopping a process EMITS
   * OUTPUT, so C4 fires *because* teardown is running — if that cleared the
   * settle or tripped abort, every real teardown would self-abort and a settle
   * could never land. Mechanical exhaust is therefore swallowed during the
   * settling window; a human decision aborts it. Outside the window both behave
   * identically, exactly as before.
   */
  | { kind: "clearOnActivity"; cause: SettleClearCause }
  /** Declared unsettle: drops a `'settled'` pin but preserves `'active'`. */
  | { kind: "unsettleDeclared" }
  | { kind: "override"; value: SessionSettleOverride | null; source: SessionSettleSource };

/**
 * Columns a caller may set alongside the settle tuple. A closed union, so
 * routing a tuple column through `extraSet` is a compile error rather than
 * something only the source-scan test would catch.
 */
/**
 * Who asked for the clear.
 *
 * - `mechanical` — C4 `setLastOutputPreview`, C5 `touchSessionActivity`. Output
 *   and activity bookkeeping, largely produced by the teardown itself.
 * - `turn_start` / `turn_failed` / `attention_requested` — C3, C6, C7. Durable
 *   signals of intent that outrank a settle in canonical precedence.
 */
export type SettleClearCause = "mechanical" | SettleAbortReason;

export type SettleExtraColumn =
  | "status_note"
  | "attention_requested_at"
  | "attention_message"
  | "attention_source"
  | "last_output_preview"
  | "last_output_at"
  | "last_turn_failed_at";


export type SettleLifecycleWriter = {
  write: (args: {
    intent: SettleLifecycleIntent;
    sessionIds: readonly string[];
    extraSet?: Partial<Record<SettleExtraColumn, SqlValue>>;
    guard?: string;
  }) => void;
  readRevision: (sessionId: string) => number;
  /** The in-flight settle windows. See `settlingStateRegistry.ts`. */
  settling: SettlingStateRegistry;
  /** Drop a deleted session's token so the local table and map do not grow forever. */
  forget: (sessionId: string) => void;
};

export function createSettleLifecycleWriter(db: AdeDb): SettleLifecycleWriter {
  // ---------------------------------------------------------------------
  // The settle-lifecycle chokepoint.
  //
  // Every mutation of the settle tuple — `settled_at`, `settle_override`,
  // `settle_source` — goes through `writeSettleLifecycle`, and no SQL literal
  // anywhere else may assign those columns. `settleLifecycleChokepoint.test.ts`
  // enforces that by scanning this file.
  //
  // The point is the REVISION. A settle decision is taken at t0 and (once
  // teardown exists) applied at t0 + T, and the world is free to move in
  // between. The revision is the detector that window needs: bumped in the same
  // transaction as the column write, so there is no gap between "the world
  // changed" and "the revision says so".
  //
  // `settle_override` is inside the tuple deliberately. It never touches
  // `settled_at`, but a `'settled'` pin makes a row read as settled at the
  // declared-settle tier all the same — so a revision keyed to `settled_at`
  // alone would be blind to exactly the kind of change it exists to catch.
  // ---------------------------------------------------------------------

  const settleTupleAssignment = (intent: SettleLifecycleIntent): { sql: string; params: SqlValue[] } => {
    switch (intent.kind) {
      case "settle":
        return {
          sql: "settled_at = coalesce(settled_at, ?), settle_override = null, settle_source = ?",
          params: [intent.settledAt, intent.source],
        };
      case "clearOnActivity":
        return { sql: "settled_at = null, settle_override = null, settle_source = null", params: [] };
      case "unsettleDeclared":
        return {
          sql:
            "settled_at = null, "
            + "settle_override = case when settle_override = 'settled' then null else settle_override end, "
            + "settle_source = null",
          params: [],
        };
      case "override":
        return {
          sql:
            "settle_override = ?, "
            + "settle_source = case when ? = 'settled' then ? when settled_at is null then null else settle_source end",
          params: [intent.value, intent.value, intent.source],
        };
    }
  };

    /**
   * Per-process revision counter, incremented on EVERY bump — not only when the
   * table write fails.
   *
   * Both stores are needed, and not only for restart survival. ADE supports
   * several processes against one database (`kvDb` sets `busy_timeout` for
   * exactly that), and the desktop main process and the CLI brain each build a
   * `sessionService` over the same file — so a table value can be AHEAD of this
   * process, written by a sibling. Conversely, bumping memory only on failure
   * would let the revision stall: after a failed write the table is behind, and
   * on recovery it restarts its own count at 1, so a real mutation could produce
   * no observable change — the failure direction that matters. Reading
   * `max(table, in-process)` is correct against both.
   *
   * Bounded by the sessions this process has touched, same order as the row set
   * it shadows.
   */
  const inProcessLifecycleRevisions = new Map<string, number>();

  const persistedRevision = (sessionId: string): number => {
    const row = db.get<{ revision: number }>(
      "select revision from session_lifecycle_revisions where session_id = ?",
      [sessionId],
    );
    return row ? Number(row.revision) || 0 : 0;
  };

  const bumpLifecycleRevisions = (sessionIds: readonly string[]): void => {
    for (const id of sessionIds) {
      try {
        // One atomic statement, PK lookup, local-only table. No pre-read: this
        // sits on the session output path.
        db.run(
          `insert into session_lifecycle_revisions (session_id, revision) values (?, 1)
             on conflict(session_id) do update set revision = session_lifecycle_revisions.revision + 1`,
          [id],
        );
        inProcessLifecycleRevisions.set(id, (inProcessLifecycleRevisions.get(id) ?? 0) + 1);
      } catch {
        // The write failed, so this process must produce a strictly higher value
        // on its own — and "higher" has to mean higher than what a READER would
        // have seen, which is `max(persisted, inProcess)`. Incrementing the
        // private counter alone is not enough: if a sibling ADE process has
        // pushed the table ahead of it, `max` would return the same number
        // across a real mutation, and a teardown holding that token would accept
        // a decision the world has already invalidated. Reading here is safe —
        // this branch is the rare one, not the output path.
        let anchor = inProcessLifecycleRevisions.get(id) ?? 0;
        try {
          anchor = Math.max(anchor, persistedRevision(id));
        } catch {
          // Table unreadable too; the private counter is all there is.
        }
        inProcessLifecycleRevisions.set(id, anchor + 1);
      }
    }
  };

  const readLifecycleRevision = (sessionId: string): number => {
    const trimmed = sessionId.trim();
    if (!trimmed) return 0;
    let persisted = 0;
    try {
      persisted = persistedRevision(trimmed);
    } catch {
      persisted = 0;
    }
    // The MAXIMUM of the two stores, never whichever answered. After a restart
    // — or a write by a sibling ADE process — the table is ahead; after a failed
    // write the in-process counter is. Taking either alone could hand back a
    // LOWER number than a previous call did, and a revision that moves backwards
    // is worse than none: it lets a stale settle match a token it should have
    // missed. Monotonic within a process is the property this value must have;
    // across a restart it can reset only when table writes were failing, which
    // is benign because a restart abandons any decision that was in flight.
    return Math.max(persisted, inProcessLifecycleRevisions.get(trimmed) ?? 0);
  };

  /**
   * The ONLY writer of the settle tuple.
   *
   * `sessionIds` is both the scope of the update and the set whose revisions
   * move — one array, so the two cannot drift. `guard` is an extra predicate
   * ANDed onto the id match; it takes no parameters, and only `settleMany` uses
   * one (its "still unsettled" check, which another ADE process could otherwise
   * invalidate between the select and the update).
   */
  const settling = new SettlingStateRegistry();

  /**
   * What the settling window does to this write.
   *
   * "Swallowed" means precisely three things, and all three matter: the tuple is
   * NOT cleared, the revision is NOT bumped, and abort is NOT tripped. The
   * caller's own columns still land, so the row keeps showing live output while
   * it settles — which is what a visible `Settling…` state should look like.
   */
  /**
   * Land ONLY the caller's own columns, for a session whose settle window is
   * open and whose write is mechanical exhaust.
   *
   * "Swallowed" means precisely three things and all three matter: the tuple is
   * not cleared, the revision is not bumped, and abort is not tripped. The
   * preview and activity columns still update, so the row keeps showing live
   * output while it settles.
   */
  const writeExtraColumnsOnly = (
    sessionIds: readonly string[],
    extraSet: Partial<Record<SettleExtraColumn, SqlValue>> | undefined,
  ): void => {
    const extraEntries = Object.entries(extraSet ?? {}) as Array<[SettleExtraColumn, SqlValue]>;
    if (!extraEntries.length || !sessionIds.length) return;
    db.run(
      `update terminal_sessions set ${extraEntries.map(([column]) => `${column} = ?`).join(", ")}`
        + ` where id in (${sessionIds.map(() => "?").join(", ")})`,
      [...extraEntries.map(([, value]) => value), ...sessionIds],
    );
  };

  /**
   * Split a clear into the sessions whose window swallows it and the sessions
   * that clear normally.
   *
   * Per session, not per batch. Every mechanical caller is single-session today,
   * so a mixed batch is unreachable — but deciding one disposition for a whole
   * array would silently stop a NON-settling session's own output from clearing
   * its settle, and nothing in the signature would warn the caller who first
   * passes two ids.
   */
  const partitionForSettlingWindow = (
    intent: SettleLifecycleIntent,
    sessionIds: readonly string[],
  ): { swallowed: string[]; normal: string[] } => {
    if (intent.kind !== "clearOnActivity") return { swallowed: [], normal: [...sessionIds] };
    const settlingIds = sessionIds.filter((id) => settling.isSettling(id));
    if (!settlingIds.length) return { swallowed: [], normal: [...sessionIds] };
    if (intent.cause === "mechanical") {
      return {
        swallowed: settlingIds,
        normal: sessionIds.filter((id) => !settling.isSettling(id)),
      };
    }
    // A human decision: trip abort for the settling sessions, then let every
    // session clear normally — the clear itself is not suppressed.
    for (const id of settlingIds) settling.abort(id, intent.cause);
    return { swallowed: [], normal: [...sessionIds] };
  };

  const writeSettleLifecycle = (args: {
    intent: SettleLifecycleIntent;
    sessionIds: readonly string[];
    extraSet?: Partial<Record<SettleExtraColumn, SqlValue>>;
    guard?: string;
  }): void => {
    const ids = args.sessionIds.map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return;

    const { swallowed, normal } = partitionForSettlingWindow(args.intent, ids);
    writeExtraColumnsOnly(swallowed, args.extraSet);
    if (!normal.length) return;

    const tuple = settleTupleAssignment(args.intent);
    const extraEntries = Object.entries(args.extraSet ?? {}) as Array<[SettleExtraColumn, SqlValue]>;
    const setClauses = [...extraEntries.map(([column]) => `${column} = ?`), tuple.sql];
    const setParams = [...extraEntries.map(([, value]) => value), ...tuple.params];
    const idPlaceholders = normal.map(() => "?").join(", ");
    const where = args.guard
      ? `${args.guard} and id in (${idPlaceholders})`
      : `id in (${idPlaceholders})`;

    const changed = db.runChanged(
      `update terminal_sessions set ${setClauses.join(", ")} where ${where}`,
      [...setParams, ...normal],
    );
    // Only a write that MATCHED A ROW bumps — that is what this gate buys, and
    // it is what stops a deleted or absent session inserting an orphan token.
    //
    // It is deliberately not "the tuple's values differed": `sqlite3_changes`
    // counts matched rows, not changed values, so re-clearing an already-clear
    // tuple still counts. Predicating the UPDATE on "would actually change"
    // was tried and reverted — it gates the caller's own columns too, so a
    // preview write silently stopped landing. Over-bumping is the safe
    // direction anyway (a spent revision costs a re-taken settle; a missed one
    // accepts a stale decision), and step 2's swallow rule is what keeps a
    // session's own idle output from invalidating its teardown.
    if (changed <= 0) return;
    // Immediately adjacent, with no `await` between, and `bumpLifecycleRevisions`
    // cannot throw. `AdeDb` exposes no transaction helper and an explicit BEGIN
    // here could nest inside a caller's, so adjacency is what orders them: within
    // this process no reader can see the column write without the bump. ADE does
    // support several processes against one database, so a sibling process could
    // observe the pair mid-flight; that window is microseconds and closing it
    // needs a transaction helper `AdeDb` does not have.
    bumpLifecycleRevisions(normal);
  };


  return {
    write: writeSettleLifecycle,
    readRevision: readLifecycleRevision,
    settling,
    forget: (sessionId: string) => {
      const trimmed = sessionId.trim();
      if (!trimmed) return;
      try {
        db.run("delete from session_lifecycle_revisions where session_id = ?", [trimmed]);
      } catch {
        // The token is advisory; failing to reap it must not fail the delete.
      }
      inProcessLifecycleRevisions.delete(trimmed);
    },
  };
}
