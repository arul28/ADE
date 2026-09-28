/**
 * The limits every recording shares, so none can run without end.
 *
 * Each surface keeps its own wall-clock cap timer (capped at
 * {@link RECORDING_MAX_MS}); this watch adds the three stops a timer cannot
 * see:
 *
 * - idle: no action, load or step on the recording's track for
 *   {@link RECORDING_IDLE_STOP_MS} (a recording nobody acts in shows nothing);
 * - raw size: the raw file reached {@link RECORDING_MAX_RAW_BYTES};
 * - disk: the raw file's volume has less than
 *   {@link RECORDING_MIN_FREE_DISK_BYTES} free.
 *
 * `onLimit` fires once; the surface stops and files the recording the same
 * way its cap does.
 */

import fs from "node:fs";
import path from "node:path";
import {
  RECORDING_IDLE_STOP_MS,
  RECORDING_MAX_MS,
  RECORDING_MAX_RAW_BYTES,
  RECORDING_MIN_FREE_DISK_BYTES,
} from "../../../shared/demoVideo/demoContract";
import type { Logger } from "../logging/logger";
import { demoTrackRegistry } from "./demoTrackRegistry";

export type DemoRecordingLimit = "idle" | "disk";

const CHECK_INTERVAL_MS = 10_000;

/** A caller's `maxSeconds`, in ms, never over {@link RECORDING_MAX_MS}. */
export function recordingCapMsFor(maxSeconds: number | null | undefined): number {
  if (typeof maxSeconds !== "number" || !Number.isFinite(maxSeconds) || maxSeconds <= 0) return RECORDING_MAX_MS;
  return Math.round(Math.min(Math.max(maxSeconds, 1) * 1000, RECORDING_MAX_MS));
}

function freeBytes(directory: string): number | null {
  try {
    const stats = fs.statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function fileBytes(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

export function watchDemoRecording(args: {
  key: string;
  rawPath: string;
  onLimit: (limit: DemoRecordingLimit, detail: string) => void;
  logger: Logger | null;
  /** The surface's clock, so its idle stop agrees with its own timers. */
  now?: () => number;
  /**
   * False when the surface cannot see a person's own input (a person driving
   * the browser pane acts on the page directly), so "no action" would stop a
   * recording someone is busy in. Size and disk limits still apply.
   */
  idleStop?: boolean;
}): () => void {
  const now = args.now ?? (() => Date.now());
  const startedAtMs = now();
  let fired = false;

  const fire = (limit: DemoRecordingLimit, detail: string) => {
    if (fired) return;
    fired = true;
    clearInterval(timer);
    args.logger?.info("demo_video.recording_limit", { key: args.key, limit, detail });
    args.onLimit(limit, detail);
  };

  const check = () => {
    if (fired) return;
    const lastActivity = demoTrackRegistry.lastActivityAt(args.key) ?? startedAtMs;
    if (args.idleStop !== false && now() - Math.max(lastActivity, startedAtMs) >= RECORDING_IDLE_STOP_MS) {
      fire("idle", `nothing happened for ${Math.round(RECORDING_IDLE_STOP_MS / 60_000)} minutes`);
      return;
    }
    const bytes = fileBytes(args.rawPath);
    if (bytes !== null && bytes >= RECORDING_MAX_RAW_BYTES) {
      fire("disk", "the recording's file reached its size limit");
      return;
    }
    const free = freeBytes(path.dirname(args.rawPath));
    if (free !== null && free < RECORDING_MIN_FREE_DISK_BYTES) {
      fire("disk", "the disk is almost full");
    }
  };

  const timer = setInterval(check, CHECK_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => {
    fired = true;
    clearInterval(timer);
  };
}

/** The raw file's path for a final demo path: `<name>.raw.<ext>` beside it. */
export function rawPathFor(finalPath: string, rawExtension = path.extname(finalPath) || ".mp4"): string {
  const extension = path.extname(finalPath);
  const base = extension ? finalPath.slice(0, -extension.length) : finalPath;
  return `${base}.raw${rawExtension.startsWith(".") ? rawExtension : `.${rawExtension}`}`;
}

/** The inverse of {@link rawPathFor}: `<base>.raw.<ext>` → `<base><finalExtension>`. */
export function finalPathForRaw(rawPath: string, finalExtension = ".mp4"): string {
  return rawPath.replace(/(\.raw)?\.[^./\\]+$/, finalExtension);
}
