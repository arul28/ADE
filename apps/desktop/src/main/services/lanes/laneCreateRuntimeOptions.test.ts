import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { parseGitCheckoutProgressLine } from "../git/git";
import { createLaneService, removeWorktreeDirectoryWithRecovery } from "./laneService";

// Real git, no mocks: these options exist for the chat-launch service, and the
// behaviour they promise (a reserved id, live checkout %, a clean abort) is
// only meaningful against an actual `git worktree add`.

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const RESERVED_ID = "7d3f2b10-5a4c-4e8d-9b21-0c9f8e7d6a5b";
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function setup(options: { fileCount?: number; fileBytes?: number } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-create-opts-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  const filler = "x".repeat(options.fileBytes ?? 0);
  for (let index = 0; index < (options.fileCount ?? 60); index += 1) {
    fs.writeFileSync(path.join(repo, `file-${index}.txt`), `content ${index}\n${filler}`);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  const db = await openKvDb(path.join(root, "kv.sqlite"), logger);
  const now = new Date().toISOString();
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    ["proj-1", repo, "repo", "main", now, now],
  );
  const service = createLaneService({
    db,
    projectRoot: repo,
    projectId: "proj-1",
    defaultBaseRef: "main",
    worktreesDir: path.join(root, "worktrees"),
  } as never);
  return { db, repo, root, service };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("laneService.create runtime options", () => {
  it("parses git's checkout progress lines", () => {
    expect(parseGitCheckoutProgressLine("Updating files:  78% (2104/2700)")).toEqual({ percent: 78, completed: 2104, total: 2700 });
    expect(parseGitCheckoutProgressLine("Updating files: 100% (2700/2700), done.")).toEqual({ percent: 100, completed: 2700, total: 2700 });
    expect(parseGitCheckoutProgressLine("Preparing worktree (new branch 'x')")).toBeNull();
  });

  it("uses the reserved lane id and streams checkout progress", async () => {
    const { db, service } = await setup();
    try {
      const progress: number[] = [];
      const lane = await service.create(
        { name: "reserved lane", branchName: "ade/0a1b2c3d", baseBranch: "main" },
        { laneId: RESERVED_ID, onCheckoutProgress: (update) => progress.push(update.percent) },
      );
      expect(lane.id).toBe(RESERVED_ID);
      expect(fs.existsSync(path.join(lane.worktreePath, "file-0.txt"))).toBe(true);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.at(-1)).toBe(100);
    } finally {
      db.close();
    }
  });

  it("findLaneIdentity reports the lane row a reserved id landed as (for restart recovery)", async () => {
    const { db, service } = await setup();
    try {
      expect(service.findLaneIdentity(RESERVED_ID)).toBeNull();
      const lane = await service.create(
        { name: "adopt me", branchName: "ade/77777777", baseBranch: "main" },
        { laneId: RESERVED_ID },
      );
      expect(service.findLaneIdentity(RESERVED_ID)).toEqual({
        id: RESERVED_ID,
        name: "adopt me",
        branchRef: "ade/77777777",
        baseRef: lane.baseRef,
        worktreePath: lane.worktreePath,
      });
    } finally {
      db.close();
    }
  });

  it("rejects a reserved id that is not a UUID or is already taken", async () => {
    const { db, service } = await setup();
    try {
      await expect(service.create({ name: "bad", baseBranch: "main" }, { laneId: "not-a-uuid" })).rejects.toThrow(/UUID/);
      await service.create({ name: "first", branchName: "ade/11111111", baseBranch: "main" }, { laneId: RESERVED_ID });
      await expect(
        service.create({ name: "second", branchName: "ade/22222222", baseBranch: "main" }, { laneId: RESERVED_ID }),
      ).rejects.toThrow(/already in use/);
    } finally {
      db.close();
    }
  });

  it("an aborted checkout leaves no worktree, branch, or lane row behind", async () => {
    const { db, repo, root, service } = await setup();
    try {
      const abort = new AbortController();
      abort.abort();
      await expect(
        service.create({ name: "aborted", branchName: "ade/33333333", baseBranch: "main" }, { laneId: RESERVED_ID, signal: abort.signal }),
      ).rejects.toThrow();
      expect(git(repo, "branch", "--list", "ade/33333333").trim()).toBe("");
      expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
      const leftovers = fs.existsSync(path.join(root, "worktrees")) ? fs.readdirSync(path.join(root, "worktrees")) : [];
      expect(leftovers).toEqual([]);
      expect(db.get("select id from lanes where id = ?", [RESERVED_ID])).toBeFalsy();
    } finally {
      db.close();
    }
  });

  it("an abort mid-checkout (worktree still locked by git) leaves no worktree, branch, or dir behind", async () => {
    const { db, repo, root, service } = await setup({ fileCount: 4000, fileBytes: 2048 });
    try {
      const abort = new AbortController();
      const seen: number[] = [];
      await expect(
        service.create(
          { name: "mid checkout", branchName: "ade/44444444", baseBranch: "main" },
          {
            laneId: RESERVED_ID,
            signal: abort.signal,
            onCheckoutProgress: (update) => {
              seen.push(update.percent);
              abort.abort();
            },
          },
        ),
      ).rejects.toThrow();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBeLessThan(100);
      expect(git(repo, "branch", "--list", "ade/44444444").trim()).toBe("");
      expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
      expect(fs.existsSync(path.join(repo, ".git", "worktrees"))
        ? fs.readdirSync(path.join(repo, ".git", "worktrees"))
        : []).toEqual([]);
      const leftovers = fs.existsSync(path.join(root, "worktrees")) ? fs.readdirSync(path.join(root, "worktrees")) : [];
      expect(leftovers).toEqual([]);
      expect(db.get("select id from lanes where id = ?", [RESERVED_ID])).toBeFalsy();
    } finally {
      db.close();
    }
  }, 30_000);

  it("cleanupReservedWorktree clears a locked leftover at the reserved path so a retry can check out", async () => {
    const { db, repo, root, service } = await setup();
    try {
      const reservedPath = path.join(root, "worktrees", `retry-lane-${RESERVED_ID.slice(0, 8)}`);
      git(repo, "worktree", "add", "-q", "-b", "ade/55555555", reservedPath, "main");
      git(repo, "worktree", "lock", "--reason", "initializing", reservedPath);

      await service.cleanupReservedWorktree({ laneId: RESERVED_ID, name: "retry lane" });
      expect(fs.existsSync(reservedPath)).toBe(false);
      expect(git(repo, "branch", "--list", "ade/55555555").trim()).toBe("");
      expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);

      const lane = await service.create(
        { name: "retry lane", branchName: "ade/66666666", baseBranch: "main" },
        { laneId: RESERVED_ID },
      );
      expect(lane.worktreePath).toBe(reservedPath);
      // A lane row now owns the id: a second cleanup must leave it alone.
      await service.cleanupReservedWorktree({ laneId: RESERVED_ID, name: "retry lane" });
      expect(fs.existsSync(path.join(reservedPath, "file-0.txt"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("retries a worktree directory Windows still holds open (EBUSY) instead of leaking it", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-ebusy-")));
    roots.push(root);
    const target = path.join(root, "held");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "file.txt"), "x");
    const realRm = fs.promises.rm.bind(fs.promises);
    let calls = 0;
    const spy = vi.spyOn(fs.promises, "rm").mockImplementation(async (...args: Parameters<typeof fs.promises.rm>) => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      return realRm(...args);
    });
    try {
      await removeWorktreeDirectoryWithRecovery(target);
      expect(calls).toBe(3);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    // A non-retryable error surfaces at once.
    const other = vi.spyOn(fs.promises, "rm").mockRejectedValue(Object.assign(new Error("bad"), { code: "EINVAL" }));
    try {
      await expect(removeWorktreeDirectoryWithRecovery(path.join(root, "x"))).rejects.toThrow("bad");
      expect(other).toHaveBeenCalledTimes(1);
    } finally {
      other.mockRestore();
    }
  });
});
