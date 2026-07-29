import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaintenanceRunReport, StorageCleanupPreview, StorageCleanupTarget } from "../../../shared/types/storage";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createStorageInsightsService } from "./storageInsightsService";
import { classifyDbTable, deriveSyncBookkeepingAction, mapDbBreakdown } from "./storageDbBreakdown";
import { isMaintenanceReport, readMaintenanceJournal } from "./storageMaintenanceJournal";
import { ADE_LAYOUT_DEFINITIONS } from "../../../shared/adeLayout";
import {
  deriveCategoryPolicyChips,
  getLedgerEntry,
  LEDGER_LAYOUT_COVERAGE,
  STORAGE_LEDGER,
} from "./storageLedger";
import { recordLastFailure } from "../runtime/lastFailureStore";
import { createPromptStash } from "../chat/promptStashService";

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

async function makeStorageFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-extra-project-"));
  const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-extra-home-"));
  fs.mkdirSync(path.join(projectRoot, ".ade"), { recursive: true });
  const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), logger);
  seedProject(db, projectRoot);
  return {
    projectRoot,
    adeHome,
    db,
    cleanup() {
      db.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(adeHome, { recursive: true, force: true });
    },
  };
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
    writeSized(path.join(projectRoot, ".ade", "artifacts", "computer-use", "proof.bin"), 5);
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

  it("never authorizes a same-named archived lane to delete a different active worktree", async () => {
    // Regression: an archived lane at /tmp/feature must not authorize cleanup
    // of an active lane's .ade/worktrees/feature just because the basenames
    // match — that would delete live work.
    const activeWorktree = path.join(projectRoot, ".ade", "worktrees", "feature");
    writeSized(path.join(activeWorktree, "work.ts"), 42);
    const strayArchived = fs.mkdtempSync(path.join(os.tmpdir(), "storage-stray-"));
    const strayFeature = path.join(strayArchived, "feature");
    fs.mkdirSync(strayFeature, { recursive: true });
    extraPaths.push(strayArchived);
    seedLane(db, { id: "active", name: "Active feature", worktreePath: activeWorktree });
    seedLane(db, { id: "archived", name: "Old feature", worktreePath: strayFeature, archivedAt: "2026-07-01T00:00:00.000Z" });
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });

    // The active worktree stays classified as protected, not archived.
    const items = (await service.getSnapshot()).categories.find((c) => c.id === "lanes_worktrees")!.items;
    expect(items.find((item) => item.path === activeWorktree)).toMatchObject({ laneStatus: "active", safety: "protected" });

    // Attempting to remove the active worktree under the archived lane's id is
    // blocked at preview and at cleanup (even with a forged preview).
    const target = { kind: "archived_lane_worktree" as const, laneId: "archived", path: activeWorktree };
    const preview = await service.cleanupPreview([target]);
    expect(preview.items).toHaveLength(0);
    expect(preview.blocked).toHaveLength(1);
    const forged = { items: [{ path: activeWorktree, bytes: 42, label: "Old feature", identity: "forged" }], totalBytes: 42, blocked: [] };
    const result = await service.cleanup([target], { preview: forged });
    expect(result.removed).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(fs.existsSync(activeWorktree)).toBe(true);
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
    expect(preview.items).toEqual([
      { path: stale, bytes: 31, label: "Old release staging", identity: expect.any(String) },
    ]);
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

  it("removes proof storage and drops the matching proof records with it", async () => {
    // Settings used to render this card with a size and no Remove button,
    // pointing the user at a proof-drawer control that did not exist.
    const artifactsDir = path.join(projectRoot, ".ade", "artifacts");
    const proofDir = path.join(artifactsDir, "computer-use");
    const packsDir = path.join(artifactsDir, "packs");
    const logBundlesDir = path.join(artifactsDir, "log-bundles");
    writeSized(path.join(proofDir, "shot.png"), 21);
    writeSized(path.join(packsDir, "lane-pack.tar"), 13);
    writeSized(path.join(logBundlesDir, "diagnostic.log"), 8);
    const purged: string[] = [];
    const service = createStorageInsightsService({
      projectRoot,
      adeHome,
      db,
      logger,
      purgeProofRecordsUnder: (removedPath) => purged.push(removedPath),
    });

    const targets: StorageCleanupTarget[] = [{ kind: "proof_attachments", path: proofDir }];
    const preview = await service.cleanupPreview(targets);
    expect(preview.blocked).toEqual([]);
    expect(preview.items[0]).toMatchObject({ path: proofDir, bytes: 21, label: "Proof and recordings" });

    const result = await service.cleanup(targets, { preview });
    expect(result.removed).toEqual([{ path: proofDir, bytes: 21 }]);
    expect(fs.existsSync(proofDir)).toBe(false);
    expect(fs.existsSync(path.join(packsDir, "lane-pack.tar"))).toBe(true);
    expect(fs.existsSync(path.join(logBundlesDir, "diagnostic.log"))).toBe(true);
    // Rows must never outlive the bytes.
    expect(purged).toEqual([proofDir]);
  });

  it("never offers the live composer attachment store for recursive cleanup", async () => {
    const attachmentsDir = path.join(projectRoot, ".ade", "attachments");
    const stashedImage = path.join(attachmentsDir, "stashed-image.png");
    const activeDraftImage = path.join(attachmentsDir, "active-draft.png");
    writeSized(stashedImage, 17);
    writeSized(activeDraftImage, 19);
    createPromptStash(db, {
      text: "Keep this image",
      attachments: [{ path: stashedImage, type: "image" }],
    });
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });

    const snapshot = await service.getSnapshot();
    expect(snapshot.categories.find((category) => category.id === "proof_attachments")?.items)
      .not.toContainEqual(expect.objectContaining({ path: attachmentsDir }));

    const preview = await service.cleanupPreview([
      { kind: "proof_attachments", path: attachmentsDir },
      { kind: "proof_attachments", path: activeDraftImage },
    ]);
    expect(preview.items).toEqual([]);
    expect(preview.blocked).toEqual([
      {
        path: attachmentsDir,
        reason: "Composer attachments are live chat data and cannot be removed from Storage.",
      },
      {
        path: activeDraftImage,
        reason: "Composer attachments are live chat data and cannot be removed from Storage.",
      },
    ]);
    expect(fs.existsSync(stashedImage)).toBe(true);
    expect(fs.existsSync(activeDraftImage)).toBe(true);
  });

  it("refuses proof cleanup for the shared artifacts parent", async () => {
    const artifactsDir = path.join(projectRoot, ".ade", "artifacts");
    writeSized(path.join(artifactsDir, "packs", "lane-pack.tar"), 4);
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });

    const preview = await service.cleanupPreview([{ kind: "proof_attachments", path: artifactsDir }]);

    expect(preview.items).toEqual([]);
    expect(preview.blocked).toEqual([
      { path: artifactsDir, reason: "This path is not proof or attachment storage." },
    ]);
  });

  it("refuses proof cleanup for paths outside the proof and attachment stores", async () => {
    const outside = path.join(projectRoot, ".ade", "cache");
    writeSized(path.join(outside, "blob.bin"), 4);
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });

    const preview = await service.cleanupPreview([{ kind: "proof_attachments", path: outside }]);
    expect(preview.items).toEqual([]);
    expect(preview.blocked).toEqual([
      { path: outside, reason: "This path is not proof or attachment storage." },
    ]);
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

  it("binds a confirmation to its own preview so a later preview cannot revalidate a stale confirm", async () => {
    // Regression for the preview-identity drift found in review: identities
    // used to live in service state keyed by path, so previewing the same
    // path again replaced the identity an earlier confirmation depended on,
    // letting a stale confirm delete a file generation the user never saw.
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-drift-"));
    extraPaths.push(staging);
    const inner = path.join(staging, "data");
    writeSized(inner, 13);
    const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60_000);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    fs.utimesSync(inner, nineDaysAgo, nineDaysAgo);
    fs.utimesSync(staging, nineDaysAgo, nineDaysAgo);
    const targets: StorageCleanupTarget[] = [{ kind: "stale_tmp_staging", path: staging }];
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });

    const stalePreview = await service.cleanupPreview(targets);
    expect(stalePreview.items).toHaveLength(1);

    // Same byte count, different generation: the user who confirmed the
    // first dialog never saw this content.
    writeSized(inner, 13);
    fs.utimesSync(inner, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(staging, eightDaysAgo, eightDaysAgo);
    const freshPreview = await service.cleanupPreview(targets);
    expect(freshPreview.items).toHaveLength(1);
    expect(freshPreview.items[0]!.identity).not.toBe(stalePreview.items[0]!.identity);

    const staleResult = await service.cleanup(targets, { preview: stalePreview });
    expect(staleResult.removed).toEqual([]);
    expect(staleResult.failed).toEqual([
      { path: staging, reason: "This item changed after the preview. Preview it again before removing it." },
    ]);
    expect(fs.existsSync(staging)).toBe(true);

    const freshResult = await service.cleanup(targets, { preview: freshPreview });
    expect(freshResult.removed).toEqual([{ path: staging, bytes: 13 }]);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("blocks active iOS DerivedData at execution time and removes stale data once inactive", async () => {
    const derivedData = path.join(projectRoot, ".ade", "cache", "ios-simulator", "DerivedData");
    const objectFile = path.join(derivedData, "module.o");
    writeSized(objectFile, 37);
    let buildActive = false;
    const service = createStorageInsightsService({
      projectRoot,
      adeHome,
      db,
      logger,
      isPathActive: (candidatePath) => buildActive && path.resolve(candidatePath) === derivedData,
      stagingTmpDir: path.join(adeHome, "no-real-staging"),
    });
    const target = { kind: "rebuildable_cache" as const, path: derivedData };

    const recentSnapshot = await service.getSnapshot({ forceRefresh: true });
    expect(recentSnapshot.categories.find((category) => category.id === "build_release")?.items)
      .toContainEqual(expect.objectContaining({ path: derivedData, safety: "review_first" }));

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    fs.utimesSync(objectFile, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(derivedData, eightDaysAgo, eightDaysAgo);
    buildActive = true;
    const activeSnapshot = await service.getSnapshot({ forceRefresh: true });
    expect(activeSnapshot.categories.find((category) => category.id === "build_release")?.items)
      .toContainEqual(expect.objectContaining({ path: derivedData, safety: "review_first" }));
    expect((await service.cleanupPreview([target])).blocked).toEqual([
      { path: derivedData, reason: "An iOS build is currently using this data." },
    ]);
    const iosCacheRoot = path.dirname(derivedData);
    expect((await service.cleanupPreview([{ kind: "rebuildable_cache", path: iosCacheRoot }])).blocked)
      .toEqual([{ path: iosCacheRoot, reason: "An iOS build is currently using this data." }]);

    buildActive = false;
    const inactiveSnapshot = await service.getSnapshot({ forceRefresh: true });
    expect(inactiveSnapshot.categories.find((category) => category.id === "build_release")?.items)
      .toContainEqual(expect.objectContaining({ path: derivedData, safety: "safe_to_remove" }));
    const preview = await service.cleanupPreview([target]);
    expect(preview.items).toHaveLength(1);

    // A build that starts after confirmation is caught by the execution-time
    // activity check, so a valid stale preview cannot delete its DerivedData.
    buildActive = true;
    const blocked = await service.cleanup([target], { preview });
    expect(blocked.removed).toEqual([]);
    expect(blocked.failed).toEqual([
      { path: derivedData, reason: "An iOS build is currently using this data." },
    ]);
    expect(fs.existsSync(derivedData)).toBe(true);

    buildActive = false;
    const inactivePreview = await service.cleanupPreview([target]);
    const removed = await service.cleanup([target], { preview: inactivePreview });
    expect(removed).toEqual({
      removed: [{ path: derivedData, bytes: 37 }],
      failed: [],
      freedBytes: 37,
    });
    expect(fs.existsSync(derivedData)).toBe(false);
  });

  const normalDiskPressure = {
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

  it("runs the maintenance doctor: compresses history, lists filesystem review candidates, and journals it", async () => {
    // Compression candidate (>14d old inactive transcript).
    const oldTranscript = path.join(projectRoot, ".ade", "transcripts", "chat", "old.jsonl");
    fs.mkdirSync(path.dirname(oldTranscript), { recursive: true });
    fs.writeFileSync(oldTranscript, `${"repeat history ".repeat(50)}\n`);
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60_000);
    fs.utimesSync(oldTranscript, twentyDaysAgo, twentyDaysAgo);

    // .ade/tmp release staging: one stale (reaped), one fresh (kept).
    const adeTmpStale = path.join(projectRoot, ".ade", "tmp", "ios-testflight-old");
    const adeTmpFresh = path.join(projectRoot, ".ade", "tmp", "release-fresh");
    writeSized(path.join(adeTmpStale, "ipa.bin"), 40);
    writeSized(path.join(adeTmpFresh, "ipa.bin"), 41);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    fs.utimesSync(adeTmpStale, eightDaysAgo, eightDaysAgo);

    // System temp staging in an isolated fixture root (never the real /tmp).
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-doctor-staging-"));
    extraPaths.push(staging);
    const stageStale = path.join(staging, "ade-old-run");
    writeSized(path.join(stageStale, "artifact.bin"), 50);
    fs.utimesSync(stageStale, eightDaysAgo, eightDaysAgo);

    // Recovery backups: two obsolete copies (old, db healthy, no recent open
    // failure). keepLatest: 1 spares the newest; only the older one is reaped.
    const backupNewer = path.join(projectRoot, ".ade", "ade.db.recovery-doctor-new.bak");
    const backupOlder = path.join(projectRoot, ".ade", "ade.db.recovery-doctor-old.bak");
    writeSized(backupNewer, 61);
    writeSized(backupOlder, 60);
    const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60_000);
    fs.utimesSync(backupNewer, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(backupOlder, nineDaysAgo, nineDaysAgo);

    // iOS DerivedData build cache.
    const derived = path.join(projectRoot, ".ade", "cache", "ios-simulator", "DerivedData");
    const derivedObject = path.join(derived, "module.o");
    writeSized(derivedObject, 70);
    fs.utimesSync(derivedObject, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(derived, eightDaysAgo, eightDaysAgo);

    const service = createStorageInsightsService({
      projectRoot, adeHome, db, logger,
      diskPressure: normalDiskPressure,
      isPathActive: () => false,
      stagingTmpDir: staging,
    });
    const report = await service.runMaintenanceNow();

    // Filesystem candidates remain until a user previews and confirms them.
    expect(fs.existsSync(adeTmpStale)).toBe(true);
    expect(fs.existsSync(adeTmpFresh)).toBe(true);
    expect(fs.existsSync(stageStale)).toBe(true);
    expect(fs.existsSync(backupOlder)).toBe(true);
    expect(fs.existsSync(backupNewer)).toBe(true);
    expect(fs.existsSync(derived)).toBe(true);
    // Compression outcome (transparent gzip).
    expect(fs.existsSync(`${oldTranscript}.gz`)).toBe(true);

    // Report correctness.
    expect(report.trigger).toBe("manual");
    expect(typeof report.dbSizeBytes).toBe("number");
    const byLedger = Object.fromEntries(report.actions.map((action) => [action.ledgerId, action]));
    expect(byLedger["fs.transcripts"]!.itemsAffected).toBe(1);
    expect(byLedger["fs.tmp"]!.itemsAffected).toBe(1);
    expect(byLedger["fs.tmp"]!.skippedReason).toBe("review_required");
    expect(byLedger["fs.tmp_staging"]!.itemsAffected).toBe(1);
    expect(byLedger["fs.recovery_backups"]!.itemsAffected).toBe(1);
    expect(byLedger["fs.ios_derived_data"]!.itemsAffected).toBe(1);
    // DB hooks absent (no maintenance handle) → unsupported skips, not errors.
    expect(byLedger["db.automation_ingress_events"]!.skippedReason).toBe("unsupported");
    expect(byLedger["db.automation_ingress_events"]!.error).toBeNull();
    expect(report.reclaimedBytes).toBeGreaterThan(0);

    // Journal written to .ade/cache and surfaced through snapshot extras.
    const journalPath = path.join(projectRoot, ".ade", "cache", "storage-doctor-journal.json");
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8"))).toHaveLength(1);
    const extras = (await service.getSnapshot({ forceRefresh: true })).extras!;
    expect(extras.maintenance.lastRun?.trigger).toBe("manual");
    service.dispose();
  });

  it("isolates a failing maintenance step without aborting the run", async () => {
    (db as unknown as { maintenance?: unknown }).maintenance = {
      pruneIngressEvents: () => { throw new Error("prune boom"); },
      pruneReviewArtifacts: () => ({ itemsAffected: 2, bytesReclaimed: 128 }),
      prunePrSnapshots: () => ({ itemsAffected: 0, bytesReclaimed: 0 }),
      compactCrsqlTombstones: () => ({ itemsAffected: 0, bytesReclaimed: 0, skippedReason: "has_peers" }),
      vacuumIfFragmented: () => ({ itemsAffected: 0, bytesReclaimed: 512 }),
    };
    // Point staging at a nonexistent dir so the reap never scans the real /tmp.
    const service = createStorageInsightsService({
      projectRoot, adeHome, db, logger, stagingTmpDir: path.join(adeHome, "no-real-staging"),
    });
    const report = await service.runMaintenanceNow();
    const byLedger = Object.fromEntries(report.actions.map((action) => [action.ledgerId, action]));
    expect(byLedger["db.automation_ingress_events"]!.error).toBe("prune boom");
    expect(byLedger["db.review_run_artifacts"]).toMatchObject({ itemsAffected: 2, bytesReclaimed: 128, error: null });
    expect(byLedger["db.operations_crsql"]!.skippedReason).toBe("has_peers");
    expect(report.reclaimedBytes).toBeGreaterThanOrEqual(128 + 512);
    expect(fs.existsSync(path.join(projectRoot, ".ade", "cache", "storage-doctor-journal.json"))).toBe(true);
    delete (db as unknown as { maintenance?: unknown }).maintenance;
    service.dispose();
  });

  it("caps the maintenance journal at 30 runs, newest first", async () => {
    const cacheDir = path.join(projectRoot, ".ade", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const seed: MaintenanceRunReport[] = Array.from({ length: 30 }, (_value, index) => ({
      startedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      finishedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:01.000Z`,
      trigger: "daily",
      actions: [],
      reclaimedBytes: 0,
      dbSizeBytes: 1,
    }));
    fs.writeFileSync(path.join(cacheDir, "storage-doctor-journal.json"), JSON.stringify(seed));
    const service = createStorageInsightsService({
      projectRoot, adeHome, db, logger, stagingTmpDir: path.join(adeHome, "no-real-staging"),
    });
    const report = await service.runMaintenanceNow();
    const journal = JSON.parse(fs.readFileSync(path.join(cacheDir, "storage-doctor-journal.json"), "utf8"));
    expect(journal).toHaveLength(30);
    expect(journal[0].trigger).toBe("manual");
    expect(journal[0].startedAt).toBe(report.startedAt);
    service.dispose();
  });

  it("emits one bounded maintenance analytics event per run", async () => {
    const captures: Array<Record<string, unknown>> = [];
    const service = createStorageInsightsService({
      projectRoot, adeHome, db, logger,
      projectId: "proj-1",
      captureAnalytics: (input) => { captures.push(input as Record<string, unknown>); },
      stagingTmpDir: path.join(adeHome, "no-real-staging"),
    });
    await service.runMaintenanceNow();
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      event: "ade_feature_used",
      surface: "desktop",
      projectId: "proj-1",
      dedupeKey: "storage_doctor_run:proj-1",
      minimumIntervalMs: 20 * 60 * 60_000,
    });
    const properties = captures[0]!.properties as Record<string, unknown>;
    expect(properties).toMatchObject({ feature: "storage_doctor", action: "maintenance_run", outcome: "completed" });
    expect(typeof properties.bytes_freed).toBe("number");
    expect(typeof properties.files_compressed).toBe("number");
    service.dispose();
  });

  it("does not promise dbstat table totals as reclaimable bytes", async () => {
    const snapshot = await createStorageInsightsService({
      projectRoot, adeHome, db, logger, stagingTmpDir: path.join(adeHome, "no-real-staging"),
    }).getSnapshot();
    const extras = snapshot.extras!;
    const prunableDbBytes = extras.dbBreakdown.reduce(
      (sum, entry) => sum + (entry.action === "prunable" ? entry.bytes : 0),
      0,
    );

    expect(prunableDbBytes).toBeGreaterThan(0);
    expect(extras.safeReclaimableBytes).toBe(0);
  });

  it("counts only filesystem targets accepted by the cleanup validator", async () => {
    writeSized(path.join(projectRoot, ".ade", "cache", "browser-observations", "c.bin"), 100);
    const derivedData = path.join(projectRoot, ".ade", "cache", "ios-simulator", "DerivedData");
    const derivedObject = path.join(derivedData, "m.o");
    writeSized(derivedObject, 200);
    const newerBackup = path.join(projectRoot, ".ade", "ade.db.recovery-newer.bak");
    const obsoleteBackup = path.join(projectRoot, ".ade", "ade.db.recovery-obsolete.bak");
    const appUpdateStaging = path.join(adeHome, "runtime", "updates", "stale-update.zip");
    writeSized(newerBackup, 400);
    writeSized(obsoleteBackup, 500);
    writeSized(appUpdateStaging, 600);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60_000);
    fs.utimesSync(derivedObject, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(derivedData, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(newerBackup, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(obsoleteBackup, nineDaysAgo, nineDaysAgo);
    fs.utimesSync(appUpdateStaging, nineDaysAgo, nineDaysAgo);
    const snapshot = await createStorageInsightsService({
      projectRoot,
      adeHome,
      db,
      logger,
      isPathActive: () => false,
      stagingTmpDir: path.join(adeHome, "no-real-staging"),
    }).getSnapshot();
    const extras = snapshot.extras!;
    expect(Array.isArray(extras.dbBreakdown)).toBe(true);
    expect(extras.maintenance.journal).toEqual([]);
    expect(extras.maintenance.lastRun).toBeNull();
    expect(extras.policyChips.chats_history).toBe("Compressed after 14 days");
    const prunableDbBytes = extras.dbBreakdown.reduce(
      (sum, entry) => sum + (entry.action === "prunable" ? entry.bytes : 0),
      0,
    );
    const presentedFilesystemBytes = snapshot.categories
      .filter((category) => category.id === "caches" || category.id === "build_release")
      .reduce((categorySum, category) => categorySum + category.items.reduce(
        (itemSum, item) => itemSum + (item.safety === "safe_to_remove" ? item.bytes : 0),
        0,
      ),
      0,
    );
    const recoveryBackups = snapshot.categories.find((category) => category.id === "recovery_backups")!;
    expect(recoveryBackups.items.find((item) => item.path === obsoleteBackup)).toMatchObject({
      bytes: 500,
      safety: "safe_to_remove",
    });
    expect(presentedFilesystemBytes).toBe(900);
    expect(snapshot.categories.find((category) => category.id === "caches")?.items).toContainEqual(
      expect.objectContaining({ path: appUpdateStaging, safety: "safe_to_remove" }),
    );
    // Project cache + stale DerivedData are valid targets (300 bytes). App
    // update staging is outside the project cache validator and is omitted.
    expect(extras.safeReclaimableBytes).toBe(300);
    if (extras.dbBreakdown.length > 0) {
      expect(extras.dbBreakdown.some((entry) => entry.category === "core")).toBe(true);
    }
  });

  it("classifies and aggregates db tables into coarse breakdown categories", () => {
    expect(classifyDbTable("automation_ingress_events")).toBe("webhooks");
    expect(classifyDbTable("idx_automation_ingress_events_project_received")).toBe("webhooks");
    expect(classifyDbTable("operations__crsql_clock")).toBe("sync_bookkeeping");
    expect(classifyDbTable("review_run_artifacts")).toBe("review_artifacts");
    expect(classifyDbTable("pull_request_snapshots")).toBe("pr_cache");
    expect(classifyDbTable("chats")).toBe("core");

    const breakdown = mapDbBreakdown([
      { name: "automation_ingress_events", bytes: 300 },
      { name: "idx_automation_ingress_events_x", bytes: 100 },
      { name: "operations__crsql_clock", bytes: 90 },
      { name: "chats", bytes: 500 },
      { name: "lanes", bytes: 0 },
    ]);
    const byCategory = Object.fromEntries(breakdown.map((entry) => [entry.category, entry]));
    expect(byCategory.webhooks).toMatchObject({ bytes: 400, label: "Webhook history", action: "prunable" });
    expect(byCategory.sync_bookkeeping!.action).toBe("compactable");
    expect(byCategory.core).toMatchObject({ bytes: 500, action: null });
    // Sorted by bytes desc: core (500) before webhooks (400).
    expect(breakdown[0]!.category).toBe("core");

    // Override replaces only the sync_bookkeeping action label.
    const pending = mapDbBreakdown(
      [{ name: "operations__crsql_clock", bytes: 90 }, { name: "chats", bytes: 500 }],
      { syncBookkeeping: "compaction_pending" },
    );
    expect(pending.find((entry) => entry.category === "sync_bookkeeping")!.action).toBe("compaction_pending");
    expect(pending.find((entry) => entry.category === "core")!.action).toBeNull();
  });

  it("derives the sync-bookkeeping label from the last journal run's compaction skip", () => {
    const run = (compactAction: Record<string, unknown> | null): MaintenanceRunReport => ({
      startedAt: "2026-07-17T00:00:00.000Z",
      finishedAt: "2026-07-17T00:00:01.000Z",
      trigger: "daily",
      actions: compactAction ? [compactAction as never] : [],
      reclaimedBytes: 0,
      dbSizeBytes: 1,
    });
    // No journal yet → nothing proven safe, so we wait rather than offer an
    // action that might turn out to be peer-blocked.
    expect(deriveSyncBookkeepingAction([])).toBe("compaction_pending");
    // Last run was peer-blocked → waiting to compact.
    expect(deriveSyncBookkeepingAction([
      run({ ledgerId: "db.operations_crsql", kind: "compact", skippedReason: "has_peers" }),
    ])).toBe("compaction_pending");
    // Last run actually compacted (no peer skip) → compactable.
    expect(deriveSyncBookkeepingAction([
      run({ ledgerId: "db.operations_crsql", kind: "compact", skippedReason: null, itemsAffected: 3 }),
    ])).toBe("compactable");
    // Unsupported or failed work is not evidence that compaction can run.
    expect(deriveSyncBookkeepingAction([
      run({ ledgerId: "db.operations_crsql", kind: "compact", skippedReason: "unsupported" }),
    ])).toBe("compaction_pending");
    expect(deriveSyncBookkeepingAction([
      run({ ledgerId: "db.operations_crsql", kind: "compact", error: "compaction failed" }),
    ])).toBe("compaction_pending");
    expect(deriveSyncBookkeepingAction([
      run({ ledgerId: "db.operations_crsql", kind: "vacuum", skippedReason: null }),
    ])).toBe("compaction_pending");
    // Newest run wins even if an older run was peer-blocked.
    expect(deriveSyncBookkeepingAction([
      run({ ledgerId: "db.operations_crsql", kind: "compact", skippedReason: null }),
      run({ ledgerId: "db.operations_crsql", kind: "compact", skippedReason: "has_peers" }),
    ])).toBe("compactable");
  });
});

describe("storageMaintenanceJournal", () => {
  const validReport: MaintenanceRunReport = {
    startedAt: "2026-07-17T00:00:00.000Z",
    finishedAt: "2026-07-17T00:00:01.000Z",
    trigger: "manual",
    actions: [{
      ledgerId: "db.operations_crsql",
      kind: "compact",
      itemsAffected: 2,
      bytesReclaimed: 64,
      durationMs: 8,
      skippedReason: null,
      error: null,
    }],
    reclaimedBytes: 64,
    dbSizeBytes: null,
  };

  it("accepts complete reports and rejects malformed nested fields", () => {
    expect(isMaintenanceReport(validReport)).toBe(true);
    expect(isMaintenanceReport({ ...validReport, trigger: "sometimes" })).toBe(false);
    expect(isMaintenanceReport({ ...validReport, actions: [null] })).toBe(false);
    expect(isMaintenanceReport({ ...validReport, actions: [{ ...validReport.actions[0], durationMs: -1 }] })).toBe(false);
    const { skippedReason: _skippedReason, ...withoutSkippedReason } = validReport.actions[0]!;
    const { error: _error, ...withoutError } = validReport.actions[0]!;
    expect(isMaintenanceReport({ ...validReport, actions: [withoutSkippedReason] })).toBe(false);
    expect(isMaintenanceReport({ ...validReport, actions: [withoutError] })).toBe(false);
    expect(isMaintenanceReport({
      ...validReport,
      actions: [{ ...validReport.actions[0], skippedReason: undefined }],
    })).toBe(false);
    expect(isMaintenanceReport({
      ...validReport,
      actions: [{ ...validReport.actions[0], error: undefined }],
    })).toBe(false);
    expect(isMaintenanceReport({ ...validReport, dbSizeBytes: undefined })).toBe(false);
  });

  it("filters malformed entries before downstream journal consumers see them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-storage-journal-"));
    const journalPath = path.join(root, "journal.json");
    try {
      fs.writeFileSync(journalPath, JSON.stringify([
        { ...validReport, actions: [null] },
        validReport,
      ]));
      expect(readMaintenanceJournal(journalPath)).toEqual([validReport]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("serializes confirmations so the same directory is removed at most once", async () => {
    const fixture = await makeStorageFixture();
    const { projectRoot, adeHome, db } = fixture;
    const orphan = path.join(projectRoot, ".ade", "worktrees", "concurrent-orphan");
    writeSized(path.join(orphan, "nested", "file.bin"), 64);
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });
    const target: StorageCleanupTarget = { kind: "orphaned_worktree", path: orphan };
    const preview = await service.cleanupPreview([target]);

    const [first, second] = await Promise.all([
      service.cleanup([target], { preview }),
      service.cleanup([target], { preview }),
    ]);

    expect(first.removed.length + second.removed.length).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    expect([...first.failed, ...second.failed].some((failure) => /no longer exists/i.test(failure.reason))).toBe(true);
    service.dispose();
    fixture.cleanup();
  });

  it("routes archived lane folders through Archive & Reclaim safety checks", async () => {
    const fixture = await makeStorageFixture();
    const { projectRoot, adeHome, db } = fixture;
    const worktree = path.join(projectRoot, ".ade", "worktrees", "archived-guard");
    writeSized(path.join(worktree, "file.bin"), 32);
    seedLane(db, {
      id: "lane-archived-guard",
      name: "Archived",
      worktreePath: worktree,
      archivedAt: "2026-07-01T00:00:00.000Z",
    });
    const service = createStorageInsightsService({ projectRoot, adeHome, db, logger });

    const preview = await service.cleanupPreview([
      { kind: "archived_lane_worktree", laneId: "lane-archived-guard", path: worktree },
    ]);

    expect(preview.items).toHaveLength(0);
    expect(preview.blocked[0]?.reason).toMatch(/Archive & Reclaim/i);
    expect(fs.existsSync(worktree)).toBe(true);
    service.dispose();
    fixture.cleanup();
  });

  it("does not auto-archive lanes with an active worktree lease, including a lease acquired during the scan", async () => {
    const fixture = await makeStorageFixture();
    const { projectRoot, adeHome, db } = fixture;
    const lockedPath = path.join(projectRoot, ".ade", "worktrees", "lane-locked");
    const racedPath = path.join(projectRoot, ".ade", "worktrees", "lane-raced");
    seedLane(db, { id: "lane-locked", name: "Locked lane", worktreePath: lockedPath });
    seedLane(db, { id: "lane-raced", name: "Raced lane", worktreePath: racedPath });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const insertLock = (laneId: string, worktreePath: string, token: string) => {
      const now = new Date().toISOString();
      db.run(
        `insert into lane_worktree_locks(
           worktree_key, worktree_path, lane_id, owner_kind, owner_pr_id,
           owner_session_id, owner_proposal_id, owner_label, token,
           created_at, heartbeat_at, expires_at
         ) values(?, ?, ?, 'storage_lifecycle', null, null, null, ?, ?, ?, ?, ?)`,
        [worktreePath, worktreePath, laneId, `Storage work for ${laneId}`, token, now, now, expiresAt],
      );
    };
    insertLock("lane-locked", lockedPath, "lock-before-scan");
    const archive = vi.fn();
    const getReclaimRisk = vi.fn(async (laneId: string) => {
      if (laneId === "lane-raced") insertLock(laneId, racedPath, "lock-during-scan");
      return {
        laneId,
        dirty: false,
        activeChatCount: 0,
        activePtyCount: 0,
        activeWatcherCount: 0,
        blockedReasons: [],
      };
    });
    const service = createStorageInsightsService({
      projectRoot,
      adeHome,
      db,
      logger,
      projectId: "project-1",
      laneService: {
        list: vi.fn(async () => [
          {
            id: "lane-locked",
            laneType: "worktree" as const,
            isEditProtected: false,
            status: { dirty: false },
          },
          {
            id: "lane-raced",
            laneType: "worktree" as const,
            isEditProtected: false,
            status: { dirty: false },
          },
        ]),
        getReclaimRisk,
        archive,
      },
      projectConfigService: {
        get: () => ({
          effective: {
            laneCleanup: {
              cleanupIntervalHours: 1,
              autoArchiveAfterHours: 1,
            },
          },
        }),
      },
    });

    await service.runLifecycleScanNow();

    expect(getReclaimRisk).toHaveBeenCalledTimes(1);
    expect(getReclaimRisk).toHaveBeenCalledWith("lane-raced");
    expect(archive).not.toHaveBeenCalled();
    service.dispose();
    fixture.cleanup();
  });

  it("treats a lane with no valid activity timestamps as recently active", async () => {
    const fixture = await makeStorageFixture();
    const { projectRoot, adeHome, db } = fixture;
    const worktreePath = path.join(projectRoot, ".ade", "worktrees", "lane-invalid-activity");
    seedLane(db, { id: "lane-invalid-activity", name: "Invalid activity", worktreePath });
    db.run("update lanes set created_at = 'not-a-date' where id = ?", ["lane-invalid-activity"]);
    const archive = vi.fn();
    const service = createStorageInsightsService({
      projectRoot,
      adeHome,
      db,
      logger,
      projectId: "project-1",
      laneService: {
        list: vi.fn(async () => [{
          id: "lane-invalid-activity",
          laneType: "worktree" as const,
          isEditProtected: false,
          status: { dirty: false },
        }]),
        getReclaimRisk: vi.fn(async () => ({
          dirty: false,
          activeChatCount: 0,
          activePtyCount: 0,
          activeWatcherCount: 0,
          blockedReasons: [],
        })),
        archive,
      },
      projectConfigService: {
        get: () => ({
          effective: {
            laneCleanup: {
              cleanupIntervalHours: 1,
              autoArchiveAfterHours: 1,
            },
          },
        }),
      },
    });

    await service.runLifecycleScanNow();

    expect(archive).not.toHaveBeenCalled();
    service.dispose();
    fixture.cleanup();
  });

  it("runs manual maintenance when the lane lifecycle scan fails", async () => {
    const fixture = await makeStorageFixture();
    const { projectRoot, adeHome, db } = fixture;
    const service = createStorageInsightsService({
      projectRoot,
      adeHome,
      db,
      logger,
      projectId: "project-1",
      stagingTmpDir: path.join(adeHome, "no-real-staging"),
      laneService: {
        list: vi.fn(async () => {
          throw new Error("lane scan failed");
        }),
        getReclaimRisk: vi.fn(),
        archive: vi.fn(),
      },
      projectConfigService: {
        get: () => ({
          effective: {
            laneCleanup: {
              cleanupIntervalHours: 1,
            },
          },
        }),
      },
    });

    const report = await service.runMaintenanceNow();

    expect(report.trigger).toBe("manual");
    expect(report.actions.length).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledWith("storage.lifecycle_scan_failed", expect.objectContaining({
      projectRoot,
      trigger: "manual",
      error: "lane scan failed",
    }));
    service.dispose();
    fixture.cleanup();
  });

  it("enforces active-lane limits on safe lanes and only marks retained files for review", async () => {
    const fixture = await makeStorageFixture();
    const { projectRoot, adeHome, db } = fixture;
    const activeIds = ["lane-a", "lane-b", "lane-c"];
    for (const id of activeIds) {
      const worktreePath = path.join(projectRoot, ".ade", "worktrees", id);
      writeSized(path.join(worktreePath, "file.bin"), 16);
      seedLane(db, { id, name: id, worktreePath });
    }
    const retainedPath = path.join(projectRoot, ".ade", "worktrees", "lane-retained");
    writeSized(path.join(retainedPath, "file.bin"), 24);
    seedLane(db, {
      id: "lane-retained",
      name: "Retained lane",
      worktreePath: retainedPath,
      archivedAt: "2026-07-01T00:00:00.000Z",
    });
    const archive = vi.fn(({ laneId }: { laneId: string }) => {
      db.run(
        "update lanes set status = 'archived', archived_at = ? where id = ?",
        [new Date().toISOString(), laneId],
      );
    });
    const laneService = {
      list: vi.fn(async () => db.all<{ id: string; name: string; worktree_path: string; is_edit_protected: number }>(
        "select id, name, worktree_path, is_edit_protected from lanes where status != 'archived'",
      ).map((row) => ({
        id: row.id,
        name: row.name,
        laneType: "worktree" as const,
        worktreePath: row.worktree_path,
        isEditProtected: row.is_edit_protected === 1,
        status: { dirty: false },
      }))),
      getReclaimRisk: vi.fn(async (laneId: string) => ({
        laneId,
        dirty: false,
        activeChatCount: 0,
        activePtyCount: 0,
        activeWatcherCount: 0,
        blockedReasons: [],
      })),
      archive,
    };
    const projectConfigService = {
      get: () => ({
        effective: {
          laneCleanup: {
            maxActiveLanes: 1,
            cleanupIntervalHours: 6,
            reclaimArchivedAfterHours: 1,
          },
        },
      }),
    };
    const releaseLaneRuntimeResources = vi.fn();
    const service = createStorageInsightsService({
      projectRoot,
      adeHome,
      db,
      logger,
      projectId: "project-1",
      laneService,
      projectConfigService,
      releaseLaneRuntimeResources,
    });

    await service.runLifecycleScanNow();
    await service.runLifecycleScanNow();

    expect(archive).toHaveBeenCalledTimes(2);
    expect(releaseLaneRuntimeResources.mock.calls.map(([laneId]) => laneId))
      .toEqual(archive.mock.calls.map(([args]) => args.laneId));
    expect(db.get("select reclaim_state from local_lane_storage_state where lane_id = ?", ["lane-retained"]))
      .toMatchObject({ reclaim_state: "ready_for_review" });
    expect(fs.existsSync(retainedPath)).toBe(true);
    service.dispose();
    fixture.cleanup();
  });
});

describe("storageLedger", () => {
  it("declares a well-formed, unique policy for every entry", () => {
    const ids = new Set<string>();
    for (const entry of STORAGE_LEDGER) {
      expect(entry.id).toMatch(/^[a-z]+\.[a-z0-9_]+$/);
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(["table", "directory", "file_family"]).toContain(entry.kind);
      expect(["user_data", "derived", "operational"]).toContain(entry.policyClass);
      expect(["write_time", "doctor", "both", "manual"]).toContain(entry.enforcement);
      // compressAfterDays only applies to user_data (spec §2 contract).
      if (entry.policy.compressAfterDays != null) {
        expect(entry.policyClass).toBe("user_data");
      }
    }
  });

  it("covers every §1 evidence table and the doctor's own artifacts", () => {
    for (const id of [
      "db.automation_ingress_events",
      "db.operations_crsql",
      "db.review_run_artifacts",
      "db.pull_request_snapshots",
      "fs.transcripts",
      "fs.tmp",
      "fs.recovery_backups",
      "fs.cache",
      "fs.storage_doctor_journal",
      "fs.artifacts",
      "fs.attachments",
    ]) {
      expect(getLedgerEntry(id), `missing ledger entry ${id}`).toBeDefined();
    }
  });

  it("declares a storage policy (or explicit unmanaged waiver) for every layout directory", () => {
    // CI guard: adding a new tracked directory to ADE_LAYOUT_DEFINITIONS without
    // declaring its storage policy here must fail. Either map it to a ledger id
    // or add it to LEDGER_LAYOUT_COVERAGE as intentionally unmanaged (null).
    const ledgerIds = new Set(STORAGE_LEDGER.map((entry) => entry.id));
    for (const definition of ADE_LAYOUT_DEFINITIONS) {
      if (definition.pathType !== "directory") continue;
      const declared = Object.prototype.hasOwnProperty.call(
        LEDGER_LAYOUT_COVERAGE,
        definition.relativePath,
      );
      expect(declared, `layout dir ${definition.relativePath} has no ledger coverage entry`).toBe(true);
      const ledgerId = LEDGER_LAYOUT_COVERAGE[definition.relativePath];
      if (ledgerId !== null && ledgerId !== undefined) {
        expect(ledgerIds.has(ledgerId), `coverage points at missing ledger id ${ledgerId}`).toBe(true);
      }
    }
  });

  it("derives category policy chips from the ledger policy values", () => {
    const chips = deriveCategoryPolicyChips();
    expect(chips.chats_history).toBe("Compressed after 14 days");
    expect(chips.build_release).toBe("Review after 7 days");
    expect(chips.recovery_backups).toBe("Keeps the latest backup");
    expect(chips.caches).toBeTruthy();
    expect(chips.lanes_worktrees).toBeTruthy();
  });
});
