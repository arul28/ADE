import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// adb is the process boundary: the capture returns a PNG, or runs a hook that
// changes the disk while it "captures".
const adb = vi.hoisted(() => ({ duringCapture: null as null | (() => void) }));
vi.mock("./adb", () => ({
  runAdb: vi.fn(async () => {
    adb.duringCapture?.();
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(2400, 20);
    return { stdout: png, stderr: "", exitCode: 0 };
  }),
}));

import { takeAndroidScreenshot } from "./androidScreenshot";

/** A directory link that needs no admin rights on Windows. */
function linkDir(target: string, at: string): void {
  fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

/** Every file and folder under `dir`, relative. */
function listTree(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

describe("takeAndroidScreenshot", () => {
  let base: string;
  let lane: string;
  let outside: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-shot-")));
    lane = path.join(base, "lane");
    outside = path.join(base, "outside");
    fs.mkdirSync(path.join(lane, "sub"), { recursive: true });
    fs.mkdirSync(outside);
    adb.duringCapture = null;
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const shoot = (outPath: string, laneRoot: () => string | null = () => lane) => {
    const requireBooted = vi.fn(async () => ({ serial: "emulator-5554", adbPath: "adb" }));
    const result = takeAndroidScreenshot({
      laneId: "lane-1",
      outPath,
      laneRoot,
      workCopy: false,
      requireBooted,
      dataDir: path.join(base, "data"),
      platform: process.platform,
      signal: new AbortController().signal,
      now: () => new Date("2026-11-04T10:00:00Z"),
    });
    return { result, requireBooted };
  };

  it.each([
    ["a parent escape", () => path.join("..", "outside", "a.png"), null],
    ["an absolute path outside the lane", () => path.join(outside, "b.png"), null],
    ["a link inside the lane that points outside", () => {
      linkDir(outside, path.join(lane, "via"));
      return path.join("via", "newdir", "c.png");
    }, null],
    ["a folder swapped for a link during the capture", () => path.join("sub", "newdir", "d.png"), () => {
      fs.rmSync(path.join(lane, "sub"), { recursive: true });
      linkDir(outside, path.join(lane, "sub"));
    }],
    ["the lane's folder moving during the capture", () => path.join("sub", "e.png"), "moved" as const],
  ])("refuses %s and writes nothing outside the lane", async (_label, makeOut, during) => {
    let root = lane;
    if (typeof during === "function") adb.duringCapture = during;
    if (during === "moved") adb.duringCapture = () => { root = path.join(base, "lane-moved"); };
    const { result } = shoot(makeOut(), () => root);

    await expect(result).rejects.toMatchObject({ code: "ANDROID_PATH_OUTSIDE_LANE" });
    expect(listTree(outside)).toEqual([]);
    expect(fs.existsSync(path.join(base, "data"))).toBe(false);
  });

  it("writes a named path inside the lane, folders included, and checks it before the capture", async () => {
    const { result, requireBooted } = shoot(path.join("shots", "nested", "ok.png"));

    const shot = await result;
    const target = path.join(lane, "shots", "nested", "ok.png");
    expect(shot).toMatchObject({ path: target, width: 1080, height: 2400, bytes: 24 });
    expect(fs.readFileSync(target).subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(requireBooted).toHaveBeenCalledTimes(1);

    // A path refused up front never boots or captures anything.
    const refused = shoot(path.join("..", "outside", "early.png"));
    await expect(refused.result).rejects.toMatchObject({ code: "ANDROID_PATH_OUTSIDE_LANE" });
    expect(refused.requireBooted).not.toHaveBeenCalled();
  });
});
