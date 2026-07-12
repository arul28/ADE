import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageCleanupPreview, StorageCleanupTarget } from "../../../shared/types/storage";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createStorageInsightsService } from "./storageInsightsService";
import { recordLastFailure } from "../runtime/lastFailureStore";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function writeSized(filePath: string, bytes: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
}

function seedProject(db: AdeDb, projectRoot: string): void {
  const now = "2026-07-01T00:00:00.000Z";
  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["project-1", projectRoot, "Fixture", "main", now, now],
  );
}

function seedLane(db: AdeDb, args: {
  id: string;
  name: string;
  worktreePath: string;
  archivedAt?: string | null;
}): void {
  const now = "2026-07-01T00:00:00.000Z";
  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
      attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder,
      status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      "project-1",
      args.name,
      null,
      "worktree",
      "main",
      `lane/${args.id}`,
      args.worktreePath,
      null,
      0,
      null,
      null,
      null,
      null,
      null,
      args.archivedAt ? "archived" : "active",
      now,
      args.archivedAt ?? null,
    ],
  );
}

describe("storageInsightsService", () => {
  let projectRoot: string;
  let adeHome: string;
  let db: AdeDb;
  const extraPaths: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-project-"));
    adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "storage-machine-home-"));
    fs.mkdirSync(path.join(projectRoot, ".ade"), { recursive: true });
    db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), logger);
    seedProject(db, projectRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(adeHome, { recursive: true, force: true });
    for (const extraPath of extraPaths.splice(0)) {
      fs.rmSync(extraPath, { recursive: true, force: true });
    }
  });

  it("reports exact fixture totals and counts nested lane data only as a worktree", async () => {
    writeSized(path.join(projectRoot, ".ade", "transcripts", "chat", "one.log"), 11);
    writeSized(path.join(projectRoot, ".ade", "cache", "terminal-snapshots", "one.txt"), 13);
    writeSized(path.join(projectRoot, ".ade", "cache", "browser-observations", "cache.bin"), 7);
    writeSized(path.join(projectRoot, ".ade", "artifacts", "proof.bin"), 5);
    writeSized(path.join(projectRoot, ".ade", "ade.db.recovery-fixture.bak"), 3);
    const lanePath = path.join(projectRoot, ".ade", "worktrees", "active-lane");
    writeSized(path.join(lanePath, "source.bin"), 17);
    writeSized(path.join(lanePath, ".ade", "transcripts", "nested.log"), 19);
    seedLane(db, { id: "active", name: "Active lane", worktreePath: lanePath });

    const snapshot = await createStorageInsightsService({ projectRoot, adeHome, db, logger }).getSnapshot();
    const byId = Object.fromEntries(snapshot.categories.map((category) => [category.id, category]));

    expect(byId.chats_history.bytes).toBe(24);
    expect(byId.chats_history.fileCount).toBe(2);
    expect(byId.caches.bytes).toBe(7);
    expect(byId.lanes_worktrees.bytes).toBe(36);
    expect(byId.proof_attachments.bytes).toBe(5);
    expect(byId.recovery_backups.bytes).toBe(3);
    expect(byId.chats_history.items.every((item) => !item.path.startsWith(lanePath))).toBe(true);
    expect(byId.lanes_worktrees.items[0]).toMatchObject({ label: "Active lane", laneStatus: "active", safety: "protected" });
    expect(snapshot.totalAdeBytes).toBe(snapshot.categories.reduce((sum, category) => sum + category.bytes, 0));
  });

  it("reports compressed history bytes separately from remaining compressible bytes", async () => {
    const compressedPath = path.join(projectRoot, ".ade", "transcripts", "chat", "old.jsonl.gz");
    const plainPath = path.join(projectRoot, ".ade", "transcripts", "chat", "plain.jsonl");
    writeSized(compressedPath, 17);
    writeSized(plainPath, 23);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    fs.utimesSync(compressedPath, old, old);
    fs.utimesSync(plainPath, old, old);

    const snapshot = await createStorageInsightsService({ projectRoot, adeHome, db, logger }).getSnapshot();
    const history = snapshot.categories.find((category) => category.id === "chats_history")!;

    expect(history.compressedBytes).toBe(17);
    expect(history.compressibleBytes).toBe(23);
  });

  it("compressNow runs one bounded history sweep", async () => {
    const transcriptPath = path.join(projectRoot, ".ade", "transcripts", "chat", "compress-now.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, `${"repeatable history ".repeat(100)}\n`);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    fs.utimesSync(transcriptPath, old, old);
    const diskPressure = {
      getSnapshot: () => ({
        state: "normal" as const,
        freeBytes: 100 * 1024 ** 3,
        totalBytes: 200 * 1024 ** 3,
        freeFraction: 0.5,
        perRoot: [],
        sampledAt: new Date().toISOString(),
      }),
      canPerform: () => ({ allowed: true as const, state: "normal" as const }),
      subscribe: () => () => {},
    };
    const service = createStorageInsightsService({
      projectRoot,
      adeHome,
      db,
      logger,
      diskPressure,
      isPathActive: () => false,
    });

    await expect(service.compressNow()).resolves.toMatchObject({ filesCompressed: 1 });
    expect(fs.existsSync(transcriptPath)).toBe(false);
    expect(fs.existsSync(`${transcriptPath}.gz`)).toBe(true);
    service.dispose();
  });

  it("keeps old recovery backups review-first while a database-open failure is fresh", async () => {
    const backupPath = path.join(projectRoot, ".ade", "ade.db.recovery-old.bak");
    writeSized(backupPath, 19);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    fs.utimesSync(backupPath, old, old);
    recordLastFailure({ kind: "project", projectRoot }, {
      code: "db_integrity",
      component: "project_db_open",
      message: "database failed",
      projectRoot,
    });

    const snapshot = await createStorageInsightsService({ projectRoot, adeHome, db, logger }).getSnapshot();
    const backup = snapshot.categories.find((category) => category.id === "recovery_backups")!.items[0];

    expect(backup).toMatchObject({ path: backupPath, safety: "review_first" });
  });

  it("classifies active, archived, and orphaned worktrees, including orphaned bytes", async () => {
    const activePath = path.join(projectRoot, ".ade", "worktrees", "active");
    const archivedPath = path.join(projectRoot, ".ade", "worktrees", "archived");
    const orphanedPath = path.join(projectRoot, ".ade", "worktrees", "orphaned");
    writeSized(path.join(activePath, "data"), 2);
    writeSized(path.join(archivedPath, "data"), 3);
    writeSized(path.join(orphanedPath, "data"), 29);
    seedLane(db, { id: "active", name: "Current", worktreePath: activePath });
    seedLane(db, { id: "archived", name: "Past", worktreePath: archivedPath, archivedAt: "2026-07-02T00:00:00.000Z" });

    const snapshot = await createStorageInsightsService({ projectRoot, adeHome, db, logger }).getSnapshot();
    const items = snapshot.categories.find((category) => category.id === "lanes_worktrees")!.items;

    expect(items.find((item) => item.path === activePath)).toMatchObject({ laneStatus: "active", safety: "protected" });
    expect(items.find((item) => item.path === archivedPath)).toMatchObject({ laneStatus: "archived", safety: "review_first" });
    expect(items.find((item) => item.path === orphanedPath)).toMatchObject({
      bytes: 29,
      laneStatus: "orphaned",
      safety: "review_first",
      detail: "Left over from a deleted lane",
    });
  });

  it("never follows symlinks and blocks link and traversal cleanup targets", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "storage-outside-"));
    extraPaths.push(outside);
    writeSized(path.join(outside, "large.bin"), 1024 * 1024);
    const linkPath = path.join(projectRoot, ".ade", "cache", "linked-data");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(outside, linkPath);
    const linkedParent = path.join(projectRoot, ".ade", "cache", "linked-parent");
    fs.symlinkSync(outside, linkedParent);
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });

    const snapshot = await service.getSnapshot();
    const item = snapshot.categories.find((category) => category.id === "caches")!.items.find((entry) => entry.path === linkPath)!;
    expect(item.bytes).toBeLessThan(1024 * 1024);

    const preview = await service.cleanupPreview([
      { kind: "rebuildable_cache", path: linkPath },
      { kind: "rebuildable_cache", path: path.join(linkedParent, "large.bin") },
      { kind: "rebuildable_cache", path: path.join(projectRoot, ".ade", "cache", "..", "secrets") },
    ]);
    expect(preview.items).toHaveLength(0);
    expect(preview.blocked).toHaveLength(3);
  });

  it("blocks protected data at preview and cleanup even with a forged preview", async () => {
    const activePath = path.join(projectRoot, ".ade", "worktrees", "active");
    const chatSessions = path.join(projectRoot, ".ade", "cache", "chat-sessions");
    const secrets = path.join(projectRoot, ".ade", "secrets");
    writeSized(path.join(activePath, "data"), 5);
    writeSized(path.join(chatSessions, "pointer"), 5);
    writeSized(path.join(secrets, "secret"), 5);
    seedLane(db, { id: "active", name: "Current", worktreePath: activePath });
    const targets: StorageCleanupTarget[] = [
      { kind: "orphaned_worktree", path: activePath },
      { kind: "rebuildable_cache", path: chatSessions },
      { kind: "rebuildable_cache", path: path.join(projectRoot, ".ade", "ade.db") },
      { kind: "rebuildable_cache", path: secrets },
    ];
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });

    expect((await service.cleanupPreview(targets)).blocked).toHaveLength(4);
    const forged: StorageCleanupPreview = {
      items: targets.map((target) => ({ path: target.path, bytes: 5, label: "Forged" })),
      totalBytes: 20,
      blocked: [],
    };
    const result = await service.cleanup(targets, { preview: forged });
    expect(result.removed).toHaveLength(0);
    expect(result.failed).toHaveLength(4);
    expect(fs.existsSync(activePath)).toBe(true);
    expect(fs.existsSync(chatSessions)).toBe(true);
    expect(fs.existsSync(secrets)).toBe(true);
  });

  it("blocks fresh staging and removes unchanged stale staging with itemized freed bytes", async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-fresh-"));
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-stale-"));
    extraPaths.push(fresh, stale);
    writeSized(path.join(fresh, "data"), 7);
    writeSized(path.join(stale, "data"), 31);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    fs.utimesSync(stale, old, old);
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });
    const targets: StorageCleanupTarget[] = [
      { kind: "stale_tmp_staging", path: fresh },
      { kind: "stale_tmp_staging", path: stale },
    ];

    const preview = await service.cleanupPreview(targets);
    expect(preview.blocked.map((item) => item.path)).toContain(fresh);
    expect(preview.items).toEqual([{ path: stale, bytes: 31, label: "Old release staging" }]);
    const result = await service.cleanup([{ kind: "stale_tmp_staging", path: stale }], { preview });
    expect(result).toEqual({ removed: [{ path: stale, bytes: 31 }], failed: [], freedBytes: 31 });
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("caches snapshots, lets force refresh bypass the cache, and reports scan caps", async () => {
    writeSized(path.join(projectRoot, ".ade", "transcripts", "one"), 1);
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });
    const readdir = vi.spyOn(fs.promises, "readdir");
    await service.getSnapshot();
    const afterFirst = readdir.mock.calls.length;
    await service.getSnapshot();
    expect(readdir.mock.calls.length).toBe(afterFirst);
    await service.getSnapshot({ forceRefresh: true });
    expect(readdir.mock.calls.length).toBeGreaterThan(afterFirst);

    const capped = createStorageInsightsService({ projectRoot, adeHome, db, logger, scanEntryLimit: 1 });
    expect((await capped.getSnapshot()).truncated).toBe(true);
  });

  it("itemizes a removed target and a target deleted after preview", async () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-old-first-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-old-second-"));
    const replaced = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-old-replaced-"));
    extraPaths.push(first, second, replaced);
    writeSized(path.join(first, "data"), 9);
    writeSized(path.join(second, "data"), 10);
    writeSized(path.join(replaced, "data"), 11);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    fs.utimesSync(first, old, old);
    fs.utimesSync(second, old, old);
    fs.utimesSync(replaced, old, old);
    const targets: StorageCleanupTarget[] = [
      { kind: "stale_tmp_staging", path: first },
      { kind: "stale_tmp_staging", path: second },
      { kind: "stale_tmp_staging", path: replaced },
    ];
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });
    const preview = await service.cleanupPreview(targets);
    fs.rmSync(second, { recursive: true });
    fs.rmSync(replaced, { recursive: true });
    fs.mkdirSync(replaced);
    writeSized(path.join(replaced, "data"), 11);
    fs.utimesSync(replaced, old, old);

    const result = await service.cleanup(targets, { preview });
    expect(result.removed).toEqual([{ path: first, bytes: 9 }]);
    expect(result.failed).toEqual([
      { path: second, reason: "This item no longer exists." },
      { path: replaced, reason: "This item changed after the preview. Preview it again before removing it." },
    ]);
    expect(result.freedBytes).toBe(9);
  });
});
