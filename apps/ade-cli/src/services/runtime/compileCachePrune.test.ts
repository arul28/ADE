import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneStaleCompileCacheTags, scheduleStaleCompileCachePrune } from "./compileCachePrune";

const CURRENT = "v24.15.0-arm64-e27d4a24-501";
// OLD has the highest version number but the oldest write in the first test, so the keep-recent
// rule has to rank by write time, not by name.
const OLD = "v24.14.0-arm64-9e3ad1fa-501";
const OLDER = "v22.13.1-arm64-aaaaaaaa-501";
const NEWER = "v24.13.0-arm64-bbbbbbbb-501";
const ANCIENT = "v21.7.3-arm64-cccccccc-501";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-compile-cache-prune-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Sets a path's modification time to `ageMs` ago. */
function setAge(target: string, ageMs: number): void {
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(target, when, when);
}

/**
 * Creates a cache-tag directory under the test root with one compiled file inside, last written
 * `ageMs` ago. The file is aged before the directory, since adding a file moves the directory's time.
 */
function makeTag(name: string, ageMs = 0): void {
  fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, name, "blob.bin"), "compiled");
  setAge(path.join(root, name, "blob.bin"), ageMs);
  setAge(path.join(root, name), ageMs);
}

describe("pruneStaleCompileCacheTags", () => {
  it("removes a stale build beyond the two most recently written, and keeps the active one", async () => {
    makeTag(CURRENT);
    makeTag(OLD, 40 * DAY);
    makeTag(OLDER, 20 * DAY); // stale, but one of the two most recent other builds
    makeTag(NEWER, DAY);

    const removed = await pruneStaleCompileCacheTags(path.join(root, CURRENT));

    expect(removed).toEqual([OLD]);
    expect(fs.readdirSync(root).sort()).toEqual([CURRENT, NEWER, OLDER].sort());
    expect(fs.existsSync(path.join(root, CURRENT, "blob.bin"))).toBe(true);
  });

  it("keeps every build written within the stale window, so two builds in use at once keep their caches", async () => {
    makeTag(CURRENT);
    makeTag(OLD, 5 * 60 * 1000); // a brain still running on another Node build
    makeTag(OLDER, 2 * HOUR);
    makeTag(NEWER, 13 * DAY); // third most recent, but not yet stale

    const removed = await pruneStaleCompileCacheTags(path.join(root, CURRENT));

    expect(removed).toEqual([]);
    expect(fs.readdirSync(root).sort()).toEqual([CURRENT, NEWER, OLD, OLDER].sort());
  });

  it("keeps a build with a recently changed file even when the directory's own time is old", async () => {
    makeTag(CURRENT);
    makeTag(NEWER, HOUR);
    makeTag(OLDER, 2 * HOUR);
    makeTag(OLD, 40 * DAY);
    // Changing a file in place leaves the directory's own time alone.
    setAge(path.join(root, OLD, "blob.bin"), DAY);

    const removed = await pruneStaleCompileCacheTags(path.join(root, CURRENT));

    expect(removed).toEqual([]);
    expect(fs.existsSync(path.join(root, OLD, "blob.bin"))).toBe(true);
  });

  it("ignores files and directories that are not cache tags", async () => {
    makeTag(CURRENT);
    fs.writeFileSync(path.join(root, OLD), "a file that looks like a tag");
    makeTag("notes", 40 * DAY);

    const removed = await pruneStaleCompileCacheTags(path.join(root, CURRENT));

    expect(removed).toEqual([]);
    expect(fs.readdirSync(root).sort()).toEqual([CURRENT, "notes", OLD].sort());
  });

  it("does nothing when the active directory is not a cache tag", async () => {
    // The cache root itself is the active directory here, so its parent is not ours to touch.
    makeTag(OLD, 40 * DAY);

    const removed = await pruneStaleCompileCacheTags(root);

    expect(removed).toEqual([]);
    expect(fs.existsSync(path.join(root, OLD))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("never follows a symlink out of the cache root", async () => {
    makeTag(CURRENT);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ade-compile-cache-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
      fs.symlinkSync(outside, path.join(root, OLD), "dir");

      const removed = await pruneStaleCompileCacheTags(path.join(root, CURRENT));

      expect(removed).toEqual([]);
      expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("swallows a missing root, and skips a directory it cannot remove", async () => {
    await expect(pruneStaleCompileCacheTags(path.join(root, "missing", CURRENT))).resolves.toEqual([]);

    makeTag(CURRENT);
    makeTag(NEWER, HOUR);
    makeTag(OLDER, 2 * HOUR);
    makeTag(OLD, 40 * DAY);
    makeTag(ANCIENT, 50 * DAY);
    const realRm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, "rm").mockImplementation((target, options) => {
      if (String(target).endsWith(OLD)) {
        return Promise.reject(Object.assign(new Error("resource busy or locked"), { code: "EBUSY" }));
      }
      return realRm(target, options);
    });

    const removed = await pruneStaleCompileCacheTags(path.join(root, CURRENT));

    expect(removed).toEqual([ANCIENT]);
    expect(fs.existsSync(path.join(root, OLD, "blob.bin"))).toBe(true);
  });
});

describe("scheduleStaleCompileCachePrune", () => {
  it("prunes only when the active cache is in the expected root", async () => {
    makeTag(CURRENT);
    makeTag(NEWER, HOUR);
    makeTag(OLDER, 2 * HOUR);
    makeTag(OLD, 40 * DAY);
    const onPruned = vi.fn();

    scheduleStaleCompileCachePrune(path.join(root, CURRENT), {
      delayMs: 0,
      expectedRoot: path.join(root, "some-other-root"),
      onPruned,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(path.join(root, OLD))).toBe(true);
    expect(onPruned).not.toHaveBeenCalled();

    scheduleStaleCompileCachePrune(path.join(root, CURRENT), { delayMs: 0, expectedRoot: root, onPruned });
    await vi.waitFor(() => expect(onPruned).toHaveBeenCalledWith([OLD]));
    expect(fs.existsSync(path.join(root, OLD))).toBe(false);
  });
});
