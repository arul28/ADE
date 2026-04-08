import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupStaleTempArtifacts } from "./tempCleanupService";

const tempRoots: string[] = [];
const NOW_MS = Date.parse("2026-04-02T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-temp-cleanup-test-"));
  tempRoots.push(root);
  return root;
}

function touchMtime(targetPath: string, mtimeMs: number): void {
  const stamp = new Date(mtimeMs);
  fs.utimesSync(targetPath, stamp, stamp);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("cleanupStaleTempArtifacts", () => {
  it("removes stale ADE ShipIt caches but keeps recent ones", () => {
    const tempRoot = createTempRoot();
    const stalePath = path.join(tempRoot, "com.ade.desktop.ShipIt.stale");
    const freshPath = path.join(tempRoot, "com.ade.desktop.ShipIt.fresh");
    fs.mkdirSync(stalePath, { recursive: true });
    fs.mkdirSync(freshPath, { recursive: true });
    touchMtime(stalePath, NOW_MS - (8 * DAY_MS));
    touchMtime(freshPath, NOW_MS - (2 * DAY_MS));

    cleanupStaleTempArtifacts({
      tempRoot,
      nowMs: NOW_MS,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(freshPath)).toBe(true);
  });

  it("removes stale screenshot temp directories", () => {
    const tempRoot = createTempRoot();
    const stalePath = path.join(tempRoot, "ade-screenshot-old");
    const freshPath = path.join(tempRoot, "ade-screenshot-new");
    fs.mkdirSync(stalePath, { recursive: true });
    fs.mkdirSync(freshPath, { recursive: true });
    touchMtime(stalePath, NOW_MS - (2 * DAY_MS));
    touchMtime(freshPath, NOW_MS - (6 * 60 * 60 * 1000));

    cleanupStaleTempArtifacts({
      tempRoot,
      nowMs: NOW_MS,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(freshPath)).toBe(true);
  });

  it("prunes stale fallback attachments and removes the directory when it becomes empty", () => {
    const tempRoot = createTempRoot();
    const attachmentsDir = path.join(tempRoot, "ade-attachments");
    const staleFile = path.join(attachmentsDir, "stale.png");
    fs.mkdirSync(attachmentsDir, { recursive: true });
    fs.writeFileSync(staleFile, "stale", "utf8");
    touchMtime(staleFile, NOW_MS - (8 * DAY_MS));

    cleanupStaleTempArtifacts({
      tempRoot,
      nowMs: NOW_MS,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(attachmentsDir)).toBe(false);
  });

  it("keeps recent fallback attachments", () => {
    const tempRoot = createTempRoot();
    const attachmentsDir = path.join(tempRoot, "ade-attachments");
    const freshFile = path.join(attachmentsDir, "fresh.png");
    fs.mkdirSync(attachmentsDir, { recursive: true });
    fs.writeFileSync(freshFile, "fresh", "utf8");
    touchMtime(freshFile, NOW_MS - (2 * DAY_MS));

    cleanupStaleTempArtifacts({
      tempRoot,
      nowMs: NOW_MS,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(fs.existsSync(freshFile)).toBe(true);
    expect(fs.existsSync(attachmentsDir)).toBe(true);
  });
});
