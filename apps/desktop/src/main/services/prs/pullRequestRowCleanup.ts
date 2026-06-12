type DbLike = {
  run(sql: string, params?: unknown[]): unknown;
};

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

export function deletePullRequestRowsForLane(db: DbLike, projectId: string, laneId: string): void {
  const params = [laneId, projectId];
  const prSelect = "select id from pull_requests where lane_id = ? and project_id = ?";

  db.run("delete from pr_group_members where lane_id = ?", [laneId]);
  db.run(`delete from pr_group_members where pr_id in (${prSelect})`, params);
  db.run(`delete from pull_request_ai_summaries where pr_id in (${prSelect})`, params);
  db.run(`delete from pull_request_snapshots where pr_id in (${prSelect})`, params);
  db.run("delete from pull_requests where lane_id = ? and project_id = ?", params);
  pruneEmptyPrGroups(db, projectId);
}
