import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createRebaseSuggestionService } from "./rebaseSuggestionService";

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? "").trim();
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

function seedRepo(root: string): void {
  fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "ade@test.local"]);
  git(root, ["config", "user.name", "ADE Test"]);
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "base"]);
}

function createBranchWorktree(root: string, branchName: string, prefix: string): string {
  git(root, ["branch", "--force", branchName, "HEAD"]);
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, ["worktree", "add", worktreePath, branchName]);
  return worktreePath;
}

function commitMainUpdate(root: string, fileName: string, content: string, message: string): void {
  fs.writeFileSync(path.join(root, fileName), content, "utf8");
  git(root, ["add", fileName]);
  git(root, ["commit", "-m", message]);
}

describe("rebaseSuggestionService", () => {
  it("dismiss short-circuits when existing state is present", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-rebase-dismiss-short-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-dismiss-short";
    const laneId = "lane-X";
    const previouslySuggestedAt = "2026-03-20T08:00:00.000Z";

    db.setJson(`rebase:suggestion:${laneId}`, {
      laneId,
      parentLaneId: "lane-parent",
      parentHeadSha: "abc123",
      behindCount: 2,
      lastSuggestedAt: previouslySuggestedAt,
      deferredUntil: null,
      dismissedAt: null,
    });

    const listMock = vi.fn(() => {
      throw new Error("laneService.list must not be called on dismiss short-circuit");
    });

    const service = createRebaseSuggestionService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: { list: listMock } as any,
    });

    await service.dismiss({ laneId });

    expect(listMock).not.toHaveBeenCalled();
    const saved = db.getJson(`rebase:suggestion:${laneId}`) as any;
    expect(saved.dismissedAt).toBeTruthy();
    expect(typeof saved.dismissedAt).toBe("string");
    expect(saved.lastSuggestedAt).toBe(previouslySuggestedAt);
    expect(saved.deferredUntil).toBeNull();
    expect(saved.parentHeadSha).toBe("abc123");
    expect(saved.behindCount).toBe(2);
  });

  it("defer short-circuits when existing state is present", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-rebase-defer-short-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-defer-short";
    const laneId = "lane-Y";
    const previouslySuggestedAt = "2026-03-20T08:00:00.000Z";

    db.setJson(`rebase:suggestion:${laneId}`, {
      laneId,
      parentLaneId: "lane-parent",
      parentHeadSha: "def456",
      behindCount: 3,
      lastSuggestedAt: previouslySuggestedAt,
      deferredUntil: null,
      dismissedAt: "2026-03-20T09:00:00.000Z",
    });

    const listMock = vi.fn(() => {
      throw new Error("laneService.list must not be called on defer short-circuit");
    });

    const service = createRebaseSuggestionService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: { list: listMock } as any,
    });

    const before = Date.now();
    await service.defer({ laneId, minutes: 30 });
    const after = Date.now();

    expect(listMock).not.toHaveBeenCalled();
    const saved = db.getJson(`rebase:suggestion:${laneId}`) as any;
    expect(saved.dismissedAt).toBeNull();
    expect(typeof saved.deferredUntil).toBe("string");
    const deferMs = Date.parse(saved.deferredUntil);
    expect(Number.isFinite(deferMs)).toBe(true);
    // 30 minutes in future, allow wide tolerance
    expect(deferMs).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(deferMs).toBeLessThanOrEqual(after + 31 * 60_000);
    expect(saved.lastSuggestedAt).toBe(previouslySuggestedAt);
    expect(saved.parentHeadSha).toBe("def456");
    expect(saved.behindCount).toBe(3);
  });

  it("caches short repeated suggestion scans", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-rebase-cache-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const listMock = vi.fn(async () => []);

    const service = createRebaseSuggestionService({
      db,
      logger: createLogger(),
      projectId: "proj-cache",
      projectRoot: repoRoot,
      laneService: { list: listMock } as any,
    });

    await service.listSuggestions();
    await service.listSuggestions();

    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("force refresh bypasses the suggestion cache", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-rebase-force-cache-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const listMock = vi.fn(async () => []);

    const service = createRebaseSuggestionService({
      db,
      logger: createLogger(),
      projectId: "proj-force-cache",
      projectRoot: repoRoot,
      laneService: { list: listMock } as any,
    });

    await service.listSuggestions();
    await service.listSuggestions({ force: true });

    expect(listMock).toHaveBeenCalledTimes(2);
  });
});
