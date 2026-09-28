/**
 * The App Control recorder for Windows and Linux, hosted by the ADE desktop app.
 *
 * macOS records the app's window with the desktop helper. Windows and Linux
 * have no such helper, so the CDP screencast frames App Control already
 * receives are the recording: each JPEG frame is written as it is to an
 * `.aderaw` capture (kind 1) with its source time, from the first frame. The
 * Chromium demo engine renders that capture into the demo at stop
 * (`produceDemoVideo`); nothing is encoded while recording.
 *
 * The host lives in the desktop because the engine does, and so the raw file
 * stays on the machine that renders it. The runtime daemon reaches it through
 * whatever the desktop wires as `getScreencastRecorder` (in-process, or the
 * desktop bridge).
 *
 * Timing: the screencast sends a frame only when the page repaints. Frames are
 * kept at most `fps` a second (a burst keeps its newest frame, written when
 * the interval allows), and at stop the newest frame is written once more at
 * the stop time, so the capture covers the whole recording and a still ending
 * is not lost. There is no idle cut here: the planner decides what to cut.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEMO_RAW_FILE_EXTENSION,
  DEMO_RAW_KIND_JPEG,
} from "../../../shared/demoVideo/demoContract";
import type { AppControlScreencastFrame } from "../../../shared/types/appControl";
import type { Logger } from "../logging/logger";
import { createDemoRawWriter, type DemoRawWriter } from "../demoVideo/demoRawFormat";
import type {
  AppControlRecordingFinish,
  AppControlScreencastRecorderBackend,
} from "./appControlRecording";

/** The finished raw capture, as the screencast host reports it. */
export type AppControlScreencastRecordingFinish = AppControlRecordingFinish & {
  /** The `.aderaw` capture; `filePath` is the same file. */
  rawPath: string;
  /** Frames in the capture, the closing copy of the last one included. */
  frameCount: number;
  /** Wall-clock ms of the capture's time 0 (its first frame). */
  firstFrameAtMs: number | null;
  /** True when the raw size cap stopped the capture early. */
  truncated: boolean;
};

const MAX_FPS = 60;

type Entry = {
  writer: DemoRawWriter;
  filePath: string;
  minIntervalMs: number;
  firstFrameAtMs: number | null;
  lastWrittenAtMs: number;
  /** The newest frame's bytes, written again at stop. */
  lastFrame: Buffer | null;
  pending: { frame: AppControlScreencastFrame; atMs: number } | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  warnedTruncated: boolean;
  stopping: boolean;
};

function frameTime(frame: AppControlScreencastFrame): number {
  const parsed = Date.parse(frame.capturedAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** `<name>.aderaw` next to the path the recording reserved. */
function rawPathFor(filePath: string): string {
  const extension = path.extname(filePath);
  return `${extension ? filePath.slice(0, -extension.length) : filePath}${DEMO_RAW_FILE_EXTENSION}`;
}

export function createAppControlScreencastRecorderHost(deps: { logger: Logger }): AppControlScreencastRecorderBackend & {
  stop(key: string): Promise<AppControlScreencastRecordingFinish>;
  dispose(): void;
} {
  const entries = new Map<string, Entry>();
  /**
   * Keys whose start is still opening its file. Reserved before the first
   * await so a second start for the key is refused; `true` once a cancel
   * asked the start to give up.
   */
  const reserved = new Map<string, boolean>();

  const write = (key: string, entry: Entry, data: Buffer, atMs: number): void => {
    if (entry.firstFrameAtMs === null) entry.firstFrameAtMs = atMs;
    const t = Math.max(0, (atMs - entry.firstFrameAtMs) / 1000);
    if (!entry.writer.append(DEMO_RAW_KIND_JPEG, t, data) && entry.writer.summary().truncated && !entry.warnedTruncated) {
      entry.warnedTruncated = true;
      deps.logger.warn("app_control.screencast_recorder.raw_size_cap", { key, filePath: entry.filePath });
    }
    entry.lastWrittenAtMs = Math.max(entry.lastWrittenAtMs, atMs);
    entry.lastFrame = data;
  };

  const flushPending = (key: string, entry: Entry): void => {
    if (entry.pendingTimer) clearTimeout(entry.pendingTimer);
    entry.pendingTimer = null;
    const pending = entry.pending;
    entry.pending = null;
    if (pending) write(key, entry, Buffer.from(pending.frame.data, "base64"), pending.atMs);
  };

  const teardown = async (key: string, entry: Entry, removeFile: boolean): Promise<void> => {
    entries.delete(key);
    if (entry.pendingTimer) clearTimeout(entry.pendingTimer);
    entry.pendingTimer = null;
    entry.pending = null;
    if (removeFile) await entry.writer.discard();
    else await entry.writer.close().catch(() => undefined);
  };

  return {
    async start(args) {
      if (entries.has(args.key) || reserved.has(args.key)) {
        throw new Error(`A recording for ${args.key} is already running.`);
      }
      reserved.set(args.key, false);
      try {
        const filePath = rawPathFor(args.filePath);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const writer = await createDemoRawWriter(filePath);
        if (reserved.get(args.key) === true) {
          await writer.discard();
          throw new Error(`The recording for ${args.key} was cancelled while it was starting.`);
        }
        const fps = Math.min(MAX_FPS, Math.max(1, Number.isFinite(args.fps) ? args.fps : 15));
        entries.set(args.key, {
          writer,
          filePath,
          minIntervalMs: 1000 / fps,
          firstFrameAtMs: null,
          lastWrittenAtMs: 0,
          lastFrame: null,
          pending: null,
          pendingTimer: null,
          warnedTruncated: false,
          stopping: false,
        });
        deps.logger.info("app_control.screencast_recorder.started", { key: args.key, fps, filePath });
        return { filePath };
      } finally {
        reserved.delete(args.key);
      }
    },

    pushFrame(key, frame) {
      const entry = entries.get(key);
      if (!entry || entry.stopping || !frame.data) return;
      const atMs = frameTime(frame);
      if (entry.firstFrameAtMs === null || atMs - entry.lastWrittenAtMs >= entry.minIntervalMs) {
        if (entry.pendingTimer) clearTimeout(entry.pendingTimer);
        entry.pendingTimer = null;
        entry.pending = null;
        write(key, entry, Buffer.from(frame.data, "base64"), atMs);
        return;
      }
      // Too soon after the last one: keep the newest and write it when the
      // interval allows, so the end of a burst is never lost.
      entry.pending = { frame, atMs };
      if (!entry.pendingTimer) {
        const wait = Math.max(0, entry.lastWrittenAtMs + entry.minIntervalMs - Date.now());
        entry.pendingTimer = setTimeout(() => {
          entry.pendingTimer = null;
          if (entries.get(key) === entry && !entry.stopping) flushPending(key, entry);
        }, wait);
      }
    },

    async stop(key): Promise<AppControlScreencastRecordingFinish> {
      const entry = entries.get(key);
      if (!entry) throw new Error(`No App Control recording is running for ${key}.`);
      entry.stopping = true;
      flushPending(key, entry);
      // The page may have been still since its last frame: that picture lasts
      // until now, and the capture has to say so.
      if (entry.lastFrame && entry.firstFrameAtMs !== null) {
        write(key, entry, entry.lastFrame, Math.max(Date.now(), entry.lastWrittenAtMs));
      }
      entries.delete(key);
      let summary;
      try {
        summary = await entry.writer.close();
      } catch (error) {
        await fs.promises.rm(entry.filePath, { force: true }).catch(() => {});
        throw new Error(`The recording could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (summary.frames <= 0) {
        await fs.promises.rm(entry.filePath, { force: true }).catch(() => {});
        throw new Error("The recording captured no frames: the app did not paint while it was running.");
      }
      const durationMs = Math.round(summary.lastTime * 1000);
      deps.logger.info("app_control.screencast_recorder.stopped", {
        key,
        frames: summary.frames,
        bytes: summary.bytes,
        durationMs,
        truncated: summary.truncated,
      });
      return {
        filePath: entry.filePath,
        rawPath: entry.filePath,
        durationMs,
        wallDurationMs: durationMs,
        idleCutMs: 0,
        frameCount: summary.frames,
        firstFrameAtMs: entry.firstFrameAtMs,
        truncated: summary.truncated,
      };
    },

    cancel(key) {
      if (reserved.has(key)) reserved.set(key, true);
      const entry = entries.get(key);
      if (!entry) return;
      entry.stopping = true;
      void teardown(key, entry, true);
    },

    dispose() {
      for (const key of reserved.keys()) reserved.set(key, true);
      for (const [key, entry] of [...entries]) {
        entry.stopping = true;
        // Keep what was captured: the next start of the app reports it as a partial file.
        void teardown(key, entry, false);
      }
    },
  };
}
