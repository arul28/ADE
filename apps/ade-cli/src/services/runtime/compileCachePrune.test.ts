import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneStaleCompileCacheTags, scheduleStaleCompileCachePrune } from "./compileCachePrune";

const CURRENT = "v24.15.0-arm64-e27d4a24-501";
const OLD = "v24.14.0-arm64-9e3ad1fa-501";
const NEWER = "v24.13.0-arm64-bbbbbbbb-501";
const OLDER = "v22.13.1-arm64-aaaaaaaa-501";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-compile-cache-prune-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(`${root}-outside`, { recursive: true, force: true }); });

function makeTag(name: string, ageMs = 0) {
  fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, name, "blob.bin"), "compiled");
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(path.join(root, name, "blob.bin"), when, when);
  fs.utimesSync(path.join(root, name), when, when);
}

describe("pruneStaleCompileCacheTags", () => {
  // Data safety: only a stale cache tag is deleted, never the active build, a recent one, or a non-tag directory.
  it("removes a stale build and nothing else", async () => {
    makeTag(CURRENT);
    makeTag(NEWER, HOUR);
    makeTag(OLDER, 2 * HOUR);
    makeTag(OLD, 40 * DAY);
    makeTag("notes", 40 * DAY);

    expect(await pruneStaleCompileCacheTags(path.join(root, CURRENT))).toEqual([OLD]);
    expect(fs.readdirSync(root).sort()).toEqual([CURRENT, NEWER, OLDER, "notes"].sort());
    expect(fs.existsSync(path.join(root, CURRENT, "blob.bin"))).toBe(true);
  });

  // The two recent siblings keep the stale-looking link inside the removable range, so only the symlink check protects it.
  it.skipIf(process.platform === "win32")("never follows or removes a symlink out of the root", async () => {
    makeTag(CURRENT);
    makeTag(NEWER, HOUR);
    makeTag(OLDER, 2 * HOUR);
    const outside = `${root}-outside`;
    fs.mkdirSync(outside);
    const old = new Date(Date.now() - 40 * DAY);
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    fs.utimesSync(path.join(outside, "keep.txt"), old, old);
    fs.symlinkSync(outside, path.join(root, OLD), "dir");
    fs.lutimesSync(path.join(root, OLD), old, old);

    expect(await pruneStaleCompileCacheTags(path.join(root, CURRENT))).toEqual([]);
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
  });
});

describe("scheduleStaleCompileCachePrune", () => {
  it("never prunes an explicitly configured cache outside the expected root", async () => {
    makeTag(CURRENT);
    makeTag(NEWER, HOUR);
    makeTag(OLDER, 2 * HOUR);
    makeTag(OLD, 40 * DAY);
    const onPruned = vi.fn();

    scheduleStaleCompileCachePrune(path.join(root, CURRENT), { delayMs: 0, expectedRoot: path.join(root, "other-root"), onPruned });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onPruned).not.toHaveBeenCalled();

    // The same cache prunes once it sits in the expected root, so the wait above is not vacuous.
    scheduleStaleCompileCachePrune(path.join(root, CURRENT), { delayMs: 0, expectedRoot: root, onPruned });
    await vi.waitFor(() => expect(onPruned).toHaveBeenCalledWith([OLD]));
  });
});
