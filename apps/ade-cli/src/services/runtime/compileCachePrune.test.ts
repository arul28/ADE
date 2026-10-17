import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneStaleCompileCacheTags, scheduleStaleCompileCachePrune } from "./compileCachePrune";

const CURRENT = "v24.15.0-arm64-e27d4a24-501";
const OLD = "v24.14.0-arm64-9e3ad1fa-501";
const OLDER = "v22.13.1-arm64-aaaaaaaa-501";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-compile-cache-prune-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function makeTag(name: string): void {
  fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, name, "blob.bin"), "compiled");
}

describe("pruneStaleCompileCacheTags", () => {
  it("removes other builds' directories and keeps the active one", async () => {
    makeTag(CURRENT);
    makeTag(OLD);
    makeTag(OLDER);

    const removed = await pruneStaleCompileCacheTags(path.join(root, CURRENT));

    expect(removed.sort()).toEqual([OLD, OLDER].sort());
    expect(fs.readdirSync(root)).toEqual([CURRENT]);
    expect(fs.existsSync(path.join(root, CURRENT, "blob.bin"))).toBe(true);
  });

  it("ignores files and directories that are not cache tags", async () => {
    makeTag(CURRENT);
    fs.writeFileSync(path.join(root, OLD), "a file that looks like a tag");
    fs.mkdirSync(path.join(root, "notes"));

    const removed = await pruneStaleCompileCacheTags(path.join(root, CURRENT));

    expect(removed).toEqual([]);
    expect(fs.readdirSync(root).sort()).toEqual([CURRENT, "notes", OLD].sort());
  });

  it("does nothing when the active directory is not a cache tag", async () => {
    // The cache root itself is the active directory here, so its parent is not ours to touch.
    makeTag(OLD);

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
    makeTag(OLD);
    makeTag(OLDER);
    const realRm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, "rm").mockImplementation((target, options) => {
      if (String(target).endsWith(OLD)) {
        return Promise.reject(Object.assign(new Error("resource busy or locked"), { code: "EBUSY" }));
      }
      return realRm(target, options);
    });

    const removed = await pruneStaleCompileCacheTags(path.join(root, CURRENT));

    expect(removed).toEqual([OLDER]);
    expect(fs.existsSync(path.join(root, OLD, "blob.bin"))).toBe(true);
  });
});

describe("scheduleStaleCompileCachePrune", () => {
  it("prunes only when the active cache is in the expected root", async () => {
    makeTag(CURRENT);
    makeTag(OLD);
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
