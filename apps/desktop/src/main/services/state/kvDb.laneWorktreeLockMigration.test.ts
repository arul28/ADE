import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createLaneWorktreeLockService } from "../lanes/laneWorktreeLockService";
import { openKvDb } from "./kvDb";

const require = createRequire(import.meta.url);

type RawDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...params: unknown[]) => void };
  close: () => void;
};

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function makeDbPath(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(root, ".ade", "kv.sqlite");
}

describe("kvDb lane worktree lock schema migration", () => {
  it("repairs legacy lock tables before lane lock upserts run", async () => {
    const dbPath = makeDbPath("ade-kvdb-lane-lock-legacy-");
    const worktreePath = path.join(path.dirname(dbPath), "worktree");
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      create table lane_worktree_locks (
        worktree_key text not null,
        worktree_path text not null,
        lane_id text not null,
        owner_kind text not null,
        owner_pr_id text,
        owner_session_id text,
        owner_proposal_id text,
        owner_label text not null,
        token text not null,
        created_at text not null,
        heartbeat_at text not null,
        expires_at text not null
      );
    `);
    const insert = rawDb.prepare(`
      insert into lane_worktree_locks (
        worktree_key, worktree_path, lane_id, owner_kind, owner_pr_id,
        owner_session_id, owner_proposal_id, owner_label, token,
        created_at, heartbeat_at, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const key = fs.realpathSync.native(worktreePath);
    const expiredAt = "2026-01-01T00:00:00.000Z";
    insert.run(key, key, "lane-old", "path_to_merge", "pr-old", null, null, "Old stale lock 1", "token-1", expiredAt, expiredAt, expiredAt);
    insert.run(key, key, "lane-old", "path_to_merge", "pr-old", null, null, "Old stale lock 2", "token-2", expiredAt, expiredAt, expiredAt);
    rawDb.close();

    const db = await openKvDb(dbPath, createLogger() as any);
    try {
      expect(
        db.get<{ name: string }>(
          "select name from sqlite_master where type = 'index' and name = 'idx_lane_worktree_locks_worktree_key_unique' limit 1",
        )?.name,
      ).toBe("idx_lane_worktree_locks_worktree_key_unique");
      expect(db.get<{ count: number }>("select count(1) as count from lane_worktree_locks where worktree_key = ?", [key])?.count).toBe(1);

      const service = createLaneWorktreeLockService({ db, logger: createLogger() });
      const acquired = service.acquire({
        laneId: "lane-new",
        worktreePath,
        ownerKind: "path_to_merge",
        ownerPrId: "pr-new",
        ownerLabel: "Path to Merge for PR #123",
      });

      expect(acquired.token).toBeTruthy();
      expect(acquired.lock.worktreeKey).toBe(key);
      expect(acquired.lock.laneId).toBe("lane-new");
      expect(db.get<{ count: number }>("select count(1) as count from lane_worktree_locks where worktree_key = ?", [key])?.count).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("lane worktree locks", () => {
  it("returns the actual number of rows released", async () => {
    const dbPath = makeDbPath("ade-kvdb-lane-lock-release-");
    const worktreePath = path.join(path.dirname(dbPath), "worktree");
    fs.mkdirSync(worktreePath, { recursive: true });

    const db = await openKvDb(dbPath, createLogger() as any);
    try {
      const service = createLaneWorktreeLockService({ db, logger: createLogger() });
      const acquired = service.acquire({
        laneId: "lane-1",
        worktreePath,
        ownerKind: "path_to_merge",
        ownerPrId: "pr-1",
        ownerLabel: "Path to Merge for PR #1",
      });

      expect(service.release({ ownerKind: "path_to_merge", ownerPrId: "missing" })).toBe(0);
      expect(service.getActiveForLane("lane-1")).toHaveLength(1);
      expect(service.release({ token: "missing-token" })).toBe(0);
      expect(service.release({ token: acquired.token })).toBe(1);
      expect(service.release({ token: acquired.token })).toBe(0);
    } finally {
      db.close();
    }
  });
});
