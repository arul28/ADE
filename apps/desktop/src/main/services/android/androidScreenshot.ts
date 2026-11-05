import fs from "node:fs";
import path from "node:path";
import type { AndroidScreenshot } from "../../../shared/types/androidEmulator";
import { isPathInside } from "../shared/pathCompare";
import { isPathEscapeError, resolvePathWithinRoot } from "../shared/utils";
import { runAdb } from "./adb";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";

/*
 * The lane's screenshot: one `screencap -p` over adb, written as a PNG to a
 * path inside the lane's folder or to ADE's own data folder.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

const SCREENSHOT_TIMEOUT_MS = 20_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk (bytes 16–23), or null for anything else. */
function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Where an agent's screenshot may go: inside the lane's worktree, after both
 * a lexical check and a real-path check (a symlink inside the worktree can
 * point anywhere). `outPath` comes from agents and other machines, so an
 * unchecked one could overwrite any file the brain can write.
 */
export function containAndroidOutPath(outPath: string, root: string, platform: NodeJS.Platform): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, outPath);
  const outside = () => new AndroidEmulatorFailure(
    "ANDROID_PATH_OUTSIDE_LANE",
    `${target} is outside the lane's worktree (${resolvedRoot}). Pick a path inside it, or leave the path out.`,
  );
  if (!isPathInside(target, resolvedRoot, platform)) throw outside();
  if (fs.existsSync(resolvedRoot)) {
    try {
      resolvePathWithinRoot(resolvedRoot, target, { allowMissing: true });
    } catch (error) {
      throw isPathEscapeError(error) ? outside() : error;
    }
  }
  return target;
}

type TakeAndroidScreenshotInput = {
  laneId: string;
  /** The path the caller named, or null for a file under `dataDir`. */
  outPath: string | null;
  /** The lane's folder, read only when `outPath` is named. */
  laneRoot: () => string | null;
  /** The lane is a chat's work copy: its refusal names the copy. */
  workCopy: boolean;
  /** The lane's booted emulator, or the service's refusal. */
  requireBooted: () => Promise<{ serial: string; adbPath: string }>;
  dataDir: string;
  platform: NodeJS.Platform;
  signal: AbortSignal;
  now: () => Date;
};

/**
 * Captures the lane's screen. A named path is checked before the capture and
 * again right before the write, and the file is opened without following a
 * link.
 */
export async function takeAndroidScreenshot(input: TakeAndroidScreenshotInput): Promise<AndroidScreenshot> {
  const laneGone = () => new AndroidEmulatorFailure(
    "ANDROID_PATH_OUTSIDE_LANE",
    input.workCopy
      ? "This chat's work copy on this machine is gone, so ADE will not write a screenshot to a chosen path. Leave the path out."
      : "ADE cannot find this lane's worktree, so it will not write a screenshot to a chosen path. Leave the path out.",
  );
  let outPath: string | null = null;
  let outRoot: string | null = null;
  if (input.outPath) {
    const root = input.laneRoot();
    if (!root) throw laneGone();
    outPath = containAndroidOutPath(input.outPath, root, input.platform);
    outRoot = root;
  }
  const { serial, adbPath } = await input.requireBooted();
  const result = await runAdb(adbPath, ["exec-out", "screencap", "-p"], {
    serial,
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    signal: input.signal,
  });
  const png = result.stdout;
  const size = readPngSize(png);
  if (!size) throw new Error(`The emulator ${serial} did not return a PNG (${png.length} bytes).`);
  const capturedAt = input.now();
  const target = outPath
    ?? path.join(input.dataDir, "screenshots", `${input.laneId.replace(/[^A-Za-z0-9_-]+/gu, "_")}-${capturedAt.toISOString().replace(/[:.]/gu, "-")}.png`);
  if (outPath && outRoot) {
    // Checked again before any folder is made: the lane's folder may be gone
    // or moved, or a link swapped in, during the capture.
    const rootNow = input.laneRoot();
    if (!rootNow || path.resolve(rootNow) !== path.resolve(outRoot)) throw laneGone();
    containAndroidOutPath(outPath, outRoot, input.platform);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Opened without following a link.
  const handle = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    fs.writeSync(handle, png);
  } finally {
    fs.closeSync(handle);
  }
  return { path: target, width: size.width, height: size.height, bytes: png.length, capturedAt: capturedAt.toISOString() };
}
