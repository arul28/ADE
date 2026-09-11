import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  pruneAgentObservationCacheRoot,
  pruneAgentObservationDirectory,
} from "./agentObservationCache";

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-obs-cache-")));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeObservation(dir: string, id: string, ageMs = 0): void {
  for (const suffix of [".json", ".png", ".map.png"]) {
    const file = path.join(dir, `${id}${suffix}`);
    fs.writeFileSync(file, "x");
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(file, when, when);
    }
  }
}

describe("pruneAgentObservationDirectory", () => {
  it("keeps the newest N observations with all three files, deletes the rest", async () => {
    const dir = scratchDir();
    for (const id of ["obs-1", "obs-2", "obs-3", "obs-4"]) writeObservation(dir, id);

    const result = await pruneAgentObservationDirectory(dir, 2);

    expect(result).toEqual({ keepCount: 2, keptCount: 2, deletedCount: 2 });
    expect(fs.readdirSync(dir).sort()).toEqual([
      "obs-3.json", "obs-3.map.png", "obs-3.png",
      "obs-4.json", "obs-4.map.png", "obs-4.png",
    ].sort());
  });

  it("reports nothing rather than throwing when the directory is missing", async () => {
    expect(await pruneAgentObservationDirectory(path.join(scratchDir(), "nope"), 3))
      .toEqual({ keepCount: 3, keptCount: 0, deletedCount: 0 });
  });
});

describe("pruneAgentObservationCacheRoot", () => {
  it("drops aged-out files and removes the directory they emptied", async () => {
    const root = scratchDir();
    const stale = path.join(root, "session-old");
    const live = path.join(root, "session-live");
    fs.mkdirSync(stale);
    fs.mkdirSync(live);
    writeObservation(stale, "obs-1", 60 * 60_000);
    writeObservation(live, "obs-1");

    await pruneAgentObservationCacheRoot(root, 30 * 60_000);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readdirSync(live)).toHaveLength(3);
  });

  // Regression: `fs.stat` resolved a symlink, so a link planted in the cache
  // root made a read-shaped sweep delete .json/.png files in the link's target.
  it("skips a symlinked directory instead of deleting through it", async () => {
    const root = scratchDir();
    const outside = scratchDir();
    writeObservation(outside, "precious", 60 * 60_000);
    fs.symlinkSync(outside, path.join(root, "session-link"));

    await pruneAgentObservationCacheRoot(root, 30 * 60_000);

    expect(fs.readdirSync(outside)).toHaveLength(3);
    expect(fs.existsSync(path.join(root, "session-link"))).toBe(true);
  });
});
