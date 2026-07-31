type DbLike = {
  run(sql: string, params?: unknown[]): unknown;
};

/**
 * Reads are only needed by the detach path, which must count before rows vanish.
 * Signature mirrors `AdeDb.get` so the concrete db satisfies it structurally.
 */
type ReadableDbLike = DbLike & {
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: any[],
  ): T | null;
};

/**
 * Lane activity frozen onto the PR row at detach time. None of it is recoverable
 * afterwards: `terminal_sessions`, `computer_use_artifacts` and `checkpoints` are all
 * deleted with the lane, and ADE has no commits table.
 */
export type DetachedLaneProvenance = {
  chats: number;
  artifacts: number;
  checkpoints: number;
};

export type DetachPullRequestRowsArgs = {
  projectId: string;
  laneId: string;
  laneName: string | null;
  laneColor: string | null;
  detachedAt: string;
};

function countRows(db: ReadableDbLike, sql: string, params: unknown[]): number {
  const row = db.get<{ count: number | null }>(sql, params);
  return Number(row?.count ?? 0) || 0;
}

/**
 * Count what happened in this lane before its child rows are deleted. Must run ahead
 * of `cleanupLaneDatabaseRows`' delete block, not after.
 */
export function countLaneProvenance(
  db: ReadableDbLike,
  projectId: string,
  laneId: string,
): DetachedLaneProvenance {
  return {
    chats: countRows(
      db,
      "select count(1) as count from terminal_sessions where lane_id = ?",
      [laneId],
    ),
    artifacts: countRows(
      db,
      "select count(1) as count from computer_use_artifacts where project_id = ? and lane_id = ?",
      [projectId, laneId],
    ),
    checkpoints: countRows(
      db,
      "select count(1) as count from checkpoints where lane_id = ?",
      [laneId],
    ),
  };
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function pruneEmptyPrGroups(db: DbLike, projectId: string): void {
  db.run(
    `
      delete from pr_groups
      where project_id = ?
        and id in (
          select g.id
          from pr_groups g
          left join pr_group_members m on m.group_id = g.id
          where g.project_id = ?
          group by g.id
          having count(m.id) = 0
        )
    `,
    [projectId, projectId],
  );
}

export function deletePullRequestRowsByIds(db: DbLike, projectId: string, prIds: string[]): void {
  const ids = uniqueIds(prIds);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");

  db.run(`delete from pr_group_members where pr_id in (${placeholders})`, ids);
  db.run(`delete from pull_request_ai_summaries where pr_id in (${placeholders})`, ids);
  db.run(`delete from pull_request_snapshots where pr_id in (${placeholders})`, ids);
  db.run(`delete from pull_requests where project_id = ? and id in (${placeholders})`, [projectId, ...ids]);
  pruneEmptyPrGroups(db, projectId);
}

/**
 * Soft-detach this lane's PR rows instead of deleting them.
 *
 * Deleting was why the Merged bucket showed a wall of amber `unmapped` badges: the
 * normal "merge, then delete the lane and branch" flow erased ADE's record that the PR
 * was ever ADE's, taking the CI outcome, review result and diff stats with it.
 *
 * `lane_id` is intentionally left pointing at the now-deleted lane. It is NOT NULL and
 * the table is a CRR, so nulling it would mean rebuilding a phone-critical table; CRR
 * already strips the FK, so the dangling id is inert and useful as a provenance key.
 *
 * Storage does not grow: the heavy snapshot columns are nulled here, which frees more
 * than the retained row costs. `commit_count` / `changed_files` are lifted onto the row
 * first so the merged view survives the purge.
 */
function detachRows(
  db: ReadableDbLike,
  args: {
    projectId: string;
    /** SQL predicate over `pull_requests`, e.g. `lane_id = ? and project_id = ?`. */
    predicate: string;
    predicateParams: unknown[];
    laneName: string | null;
    laneColor: string | null;
    detachedAt: string;
    provenance: DetachedLaneProvenance;
  },
): void {
  const { projectId, predicate, predicateParams, laneName, laneColor, detachedAt, provenance } = args;
  const prSelect = `select id from pull_requests where ${predicate}`;

  // Lift counts off the snapshot before nulling it, so the merged row can still say
  // "12 commits · 9 files" once the JSON is gone.
  db.run(
    `
      update pull_requests
      set commit_count = coalesce(
            commit_count,
            (select json_array_length(s.commits_json)
             from pull_request_snapshots s
             where s.pr_id = pull_requests.id and json_valid(s.commits_json))
          ),
          changed_files = coalesce(
            changed_files,
            (select json_array_length(s.files_json)
             from pull_request_snapshots s
             where s.pr_id = pull_requests.id and json_valid(s.files_json))
          )
      where ${predicate}
    `,
    predicateParams,
  );

  // `detached_at is null` keeps the first detach authoritative: re-detaching an already
  // detached row would overwrite the original lane name with a later, unrelated one.
  db.run(
    `
      update pull_requests
      set detached_at = ?,
          detached_lane_name = ?,
          detached_lane_color = ?,
          detached_provenance = ?
      where ${predicate} and detached_at is null
    `,
    [detachedAt, laneName, laneColor, JSON.stringify(provenance), ...predicateParams],
  );

  // Keep detail/status/commits (small, and what the merged view reads); drop the bulky
  // kinds. The 60-day TTL in `prunePrSnapshots` remains the backstop for the rest.
  db.run(
    `
      update pull_request_snapshots
      set files_json = null,
          checks_json = null,
          comments_json = null,
          reviews_json = null
      where pr_id in (${prSelect})
    `,
    predicateParams,
  );

  // Group membership is lane-scoped work-in-progress, not history — it goes.
  db.run(`delete from pr_group_members where pr_id in (${prSelect})`, predicateParams);
  pruneEmptyPrGroups(db, projectId);
}

export function detachPullRequestRowsForLane(
  db: ReadableDbLike,
  args: DetachPullRequestRowsArgs,
): void {
  const { projectId, laneId, laneName, laneColor, detachedAt } = args;
  detachRows(db, {
    projectId,
    predicate: "lane_id = ? and project_id = ?",
    predicateParams: [laneId, projectId],
    laneName,
    laneColor,
    detachedAt,
    provenance: countLaneProvenance(db, projectId, laneId),
  });
  db.run("delete from pr_group_members where lane_id = ?", [laneId]);
  pruneEmptyPrGroups(db, projectId);
}

/**
 * Detach specific PR rows whose head branch no longer matches their lane (branch switch
 * or rename). Same reasoning as the lane-delete path: the PR still happened, so keep the
 * record rather than erasing it. The lane itself survives here, so provenance is counted
 * live off the still-present child rows.
 */
export function detachPullRequestRowsByIds(
  db: ReadableDbLike,
  args: DetachPullRequestRowsArgs & { prIds: string[] },
): void {
  const { projectId, laneId, laneName, laneColor, detachedAt } = args;
  const ids = uniqueIds(args.prIds);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  detachRows(db, {
    projectId,
    predicate: `project_id = ? and id in (${placeholders})`,
    predicateParams: [projectId, ...ids],
    laneName,
    laneColor,
    detachedAt,
    provenance: countLaneProvenance(db, projectId, laneId),
  });
}

