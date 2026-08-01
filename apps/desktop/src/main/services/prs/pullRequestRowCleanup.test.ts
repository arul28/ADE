import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import {
  countLaneProvenance,
  detachPullRequestRowsByIds,
  detachPullRequestRowsForLane,
} from "./pullRequestRowCleanup";

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
}

const PROJECT_ID = "proj-1";
const LANE_ID = "lane-1";
const DETACHED_AT = "2026-07-31T12:00:00.000Z";

describe("pullRequestRowCleanup detach", () => {
  let dir: string;
  let db: Awaited<ReturnType<typeof openKvDb>>;

  const insertPr = (id: string, overrides: Record<string, unknown> = {}) => {
    db.run(
      `insert into pull_requests
         (id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url,
          state, base_branch, head_branch, additions, deletions, created_at, updated_at)
       values (?, ?, ?, 'arul', 'ADE', 977, 'https://github.com/arul/ADE/pull/977',
               ?, 'main', 'ade/feature', 412, 88, ?, ?)`,
      [
        id,
        PROJECT_ID,
        (overrides.lane_id as string) ?? LANE_ID,
        (overrides.state as string) ?? "merged",
        DETACHED_AT,
        DETACHED_AT,
      ],
    );
  };

  const insertSnapshot = (prId: string) => {
    db.run(
      `insert into pull_request_snapshots
         (pr_id, detail_json, status_json, checks_json, reviews_json, comments_json,
          files_json, commits_json, updated_at)
       values (?, '{"body":"x"}', '{"ok":true}', '[{"a":1}]', '[{"r":1}]', '[{"c":1}]',
               ?, ?, ?)`,
      [
        prId,
        JSON.stringify([{ f: 1 }, { f: 2 }, { f: 3 }]),
        JSON.stringify([{ c: 1 }, { c: 2 }]),
        DETACHED_AT,
      ],
    );
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-detach-"));
    db = await openKvDb(path.join(dir, "kv.sqlite"), createLogger());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the row, marks it detached, and records the lane it belonged to", () => {
    insertPr("pr-1");

    detachPullRequestRowsForLane(db, {
      projectId: PROJECT_ID,
      laneId: LANE_ID,
      laneName: "auto-naming",
      laneColor: "#4ADE80",
      detachedAt: DETACHED_AT,
    });

    const row = db.get<{
      lane_id: string;
      detached_at: string | null;
      detached_lane_name: string | null;
      detached_lane_color: string | null;
    }>(
      "select lane_id, detached_at, detached_lane_name, detached_lane_color from pull_requests where id = ?",
      ["pr-1"],
    );
    expect(row?.detached_at).toBe(DETACHED_AT);
    expect(row?.detached_lane_name).toBe("auto-naming");
    expect(row?.detached_lane_color).toBe("#4ADE80");
    // lane_id is NOT NULL and CRR strips the FK, so it stays as a provenance key
    // rather than forcing a phone-critical table rebuild to make it nullable.
    expect(row?.lane_id).toBe(LANE_ID);
  });

  it("lifts commit and file counts off the snapshot before purging it", () => {
    insertPr("pr-1");
    insertSnapshot("pr-1");

    detachPullRequestRowsForLane(db, {
      projectId: PROJECT_ID,
      laneId: LANE_ID,
      laneName: "auto-naming",
      laneColor: null,
      detachedAt: DETACHED_AT,
    });

    const row = db.get<{ commit_count: number | null; changed_files: number | null }>(
      "select commit_count, changed_files from pull_requests where id = ?",
      ["pr-1"],
    );
    expect(row?.commit_count).toBe(2);
    expect(row?.changed_files).toBe(3);

    // Bulky kinds are dropped; detail/status/commits stay so the merged view still reads.
    const snapshot = db.get<Record<string, string | null>>(
      `select files_json, checks_json, comments_json, reviews_json, detail_json, status_json, commits_json
         from pull_request_snapshots where pr_id = ?`,
      ["pr-1"],
    );
    expect(snapshot?.files_json).toBeNull();
    expect(snapshot?.checks_json).toBeNull();
    expect(snapshot?.comments_json).toBeNull();
    expect(snapshot?.reviews_json).toBeNull();
    expect(snapshot?.detail_json).toBeTruthy();
    expect(snapshot?.commits_json).toBeTruthy();
  });

  it("keeps the first detach authoritative when a row is detached twice", () => {
    insertPr("pr-1");

    detachPullRequestRowsForLane(db, {
      projectId: PROJECT_ID,
      laneId: LANE_ID,
      laneName: "original-lane",
      laneColor: null,
      detachedAt: DETACHED_AT,
    });
    detachPullRequestRowsForLane(db, {
      projectId: PROJECT_ID,
      laneId: LANE_ID,
      laneName: "some-later-lane",
      laneColor: null,
      detachedAt: "2026-08-05T00:00:00.000Z",
    });

    const row = db.get<{ detached_at: string; detached_lane_name: string }>(
      "select detached_at, detached_lane_name from pull_requests where id = ?",
      ["pr-1"],
    );
    expect(row?.detached_lane_name).toBe("original-lane");
    expect(row?.detached_at).toBe(DETACHED_AT);
  });

  it("detaches only the named rows when a lane switches branch", () => {
    insertPr("pr-stale");
    insertPr("pr-keep");

    detachPullRequestRowsByIds(db, {
      projectId: PROJECT_ID,
      laneId: LANE_ID,
      laneName: "auto-naming",
      laneColor: null,
      detachedAt: DETACHED_AT,
      prIds: ["pr-stale"],
    });

    expect(
      db.get<{ detached_at: string | null }>("select detached_at from pull_requests where id = ?", ["pr-stale"])
        ?.detached_at,
    ).toBe(DETACHED_AT);
    expect(
      db.get<{ detached_at: string | null }>("select detached_at from pull_requests where id = ?", ["pr-keep"])
        ?.detached_at,
    ).toBeNull();
  });

  it("counts zero provenance for a lane with no recorded activity", () => {
    expect(countLaneProvenance(db, PROJECT_ID, LANE_ID)).toEqual({
      chats: 0,
      artifacts: 0,
      checkpoints: 0,
    });
  });

  it("counts the lane's sessions and checkpoints before they are deleted", () => {
    db.run(
      `insert into terminal_sessions (id, lane_id, tool_type, title, started_at, transcript_path)
       values ('sess-1', ?, 'chat', 'Chat', ?, '/tmp/t.jsonl')`,
      [LANE_ID, DETACHED_AT],
    );
    db.run(
      `insert into checkpoints (id, project_id, lane_id, sha, created_at)
       values ('cp-1', ?, ?, 'abc123', ?)`,
      [PROJECT_ID, LANE_ID, DETACHED_AT],
    );

    const provenance = countLaneProvenance(db, PROJECT_ID, LANE_ID);
    expect(provenance.chats).toBe(1);
    expect(provenance.checkpoints).toBe(1);
  });
});
