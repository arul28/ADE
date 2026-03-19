import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKvDb } from "./kvDb";
import { isCrsqliteAvailable } from "./crsqliteExtension";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function makeProjectRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
  return root;
}

function insertProjectGraph(db: Awaited<ReturnType<typeof openKvDb>>) {
  const now = "2026-03-17T00:00:00.000Z";
  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["project-1", "/repo/ade", "ADE", "main", now, now],
  );
  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
      is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "lane-primary",
      "project-1",
      "Primary",
      null,
      "primary",
      "main",
      "main",
      "/repo/ade",
      null,
      1,
      null,
      null,
      null,
      null,
      null,
      "active",
      now,
      null,
    ],
  );
  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
      is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "lane-child",
      "project-1",
      "linear test",
      null,
      "worktree",
      "main",
      "ade/linear-test",
      "/repo/ade/.ade/worktrees/linear-test",
      null,
      0,
      "lane-primary",
      null,
      null,
      null,
      null,
      "active",
      "2026-03-17T00:05:00.000Z",
      null,
    ],
  );
  db.run(
    `insert into lane_state_snapshots(
      lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress, agent_summary_json, mission_summary_json, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["lane-primary", 0, 0, 0, 0, 0, null, null, now],
  );
  db.run(
    `insert into lane_state_snapshots(
      lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress, agent_summary_json, mission_summary_json, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["lane-child", 1, 0, 1, 0, 0, null, null, "2026-03-17T00:05:00.000Z"],
  );
}

function insertSessionAndPr(db: Awaited<ReturnType<typeof openKvDb>>) {
  const now = "2026-03-17T00:10:00.000Z";
  db.run(
    `insert into terminal_sessions(
      id, lane_id, pty_id, tracked, goal, tool_type, pinned, title, started_at, ended_at,
      exit_code, transcript_path, head_sha_start, head_sha_end, status, last_output_preview,
      last_output_at, summary, resume_command
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "session-1",
      "lane-child",
      null,
      1,
      "Ship W5",
      "run-shell",
      0,
      "npm test",
      now,
      null,
      null,
      "/tmp/session-1.log",
      null,
      null,
      "running",
      "Tests starting",
      now,
      null,
      "npm test",
    ],
  );
  db.run(
    `insert into pull_requests(
      id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
      title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
      last_synced_at, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "pr-1",
      "project-1",
      "lane-child",
      "arul",
      "ade",
      42,
      "https://github.com/arul/ade/pull/42",
      "node-42",
      "Fix mobile hydration",
      "open",
      "main",
      "ade/linear-test",
      "pending",
      "requested",
      12,
      4,
      now,
      now,
      now,
    ],
  );
  db.run(
    `insert into pull_request_snapshots(
      pr_id, detail_json, status_json, checks_json, reviews_json, comments_json, files_json, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "pr-1",
      JSON.stringify({
        prId: "pr-1",
        body: "Hydration fix",
        assignees: [],
        author: { login: "arul", avatarUrl: null },
        isDraft: false,
        labels: [],
        requestedReviewers: [],
        milestone: null,
        linkedIssues: [],
      }),
      JSON.stringify({
        prId: "pr-1",
        state: "open",
        checksStatus: "pending",
        reviewStatus: "requested",
        isMergeable: true,
        mergeConflicts: false,
        behindBaseBy: 0,
      }),
      "[]",
      "[]",
      "[]",
      "[]",
      now,
    ],
  );
}

const activeDisposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (activeDisposers.length > 0) {
    const dispose = activeDisposers.pop();
    if (dispose) await dispose();
  }
});

describe.skipIf(!isCrsqliteAvailable())("openKvDb CRR repair", () => {
  it("backfills phone-critical tables whose rows predate CRR enablement", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-pre-crr-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(first);
    insertSessionAndPr(first);

    first.run("drop table terminal_sessions__crsql_clock");
    first.run("drop table terminal_sessions__crsql_pks");
    first.run("drop table pull_request_snapshots__crsql_clock");
    first.run("drop table pull_request_snapshots__crsql_pks");
    first.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    expect(reopened.get<{ count: number }>("select count(1) as count from terminal_sessions__crsql_pks")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from pull_request_snapshots__crsql_pks")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from terminal_sessions")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from pull_request_snapshots")?.count).toBe(1);
  });

  it("repairs divergent __crsql_pks counts without losing rows or indexes", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-mismatch-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(first);
    insertSessionAndPr(first);

    first.run("delete from lanes__crsql_pks where __crsql_key = (select max(__crsql_key) from lanes__crsql_pks)");
    first.run(
      "delete from lane_state_snapshots__crsql_pks where __crsql_key = (select max(__crsql_key) from lane_state_snapshots__crsql_pks)",
    );
    first.run("delete from terminal_sessions__crsql_pks");
    first.run("delete from pull_requests__crsql_pks");
    first.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    expect(reopened.get<{ count: number }>("select count(1) as count from lanes")?.count).toBe(2);
    expect(reopened.get<{ count: number }>("select count(1) as count from lanes__crsql_pks")?.count).toBe(2);
    expect(reopened.get<{ count: number }>("select count(1) as count from lane_state_snapshots__crsql_pks")?.count).toBe(2);
    expect(reopened.get<{ count: number }>("select count(1) as count from terminal_sessions__crsql_pks")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from pull_requests__crsql_pks")?.count).toBe(1);
    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'index' and name = 'idx_terminal_sessions_started_at' limit 1",
      )?.present,
    ).toBe(1);
  });
});
