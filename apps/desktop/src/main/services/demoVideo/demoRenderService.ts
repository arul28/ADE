/**
 * Turns a finished raw recording into the one file ADE keeps: the demo.
 *
 * measure (engine) → plan (`demoPlanner.ts`) → render (engine) → check the
 * size → delete the raw file.
 *
 * - The first engine that can read the raw file does the work: the Swift
 *   `ade-media` for an MP4/MOV on macOS, the desktop app's Chromium engine for
 *   an `.aderaw` capture.
 * - A render over {@link DEMO_MAX_BYTES} is done again at a fitted bitrate, a
 *   step smaller when needed (see `renderToFit`). No file over the limit is
 *   ever returned.
 * - A demo render that fails is tried once more as a plain render. When that
 *   fails too, a raw MP4 under the limit is filed as it is (the fallback is
 *   recorded in the metadata); a larger one, or a raw `.aderaw` (which cannot
 *   be played), is an error, and the raw file is left for the caller.
 * - The raw file never outlives this call when a file is returned: it is
 *   deleted after a render, or it becomes the output on the fallback. On a
 *   thrown error it is left for the caller, which decides.
 * - A raw MP4 about to be filed as it is is read first: one that holds
 *   nothing to show (empty, never finalised, no frames) throws
 *   {@link DemoRecordingUnusableError} and is never filed as proof; any other
 *   reports the length read from its own index, not zero.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEMO_MAX_BYTES,
  DEMO_MAX_RENDER_ATTEMPTS,
  type DemoAnalysis,
  type DemoArtifactMetadata,
  type DemoEngine,
  type DemoEngineId,
  type DemoPlan,
  type DemoTrack,
} from "../../../shared/demoVideo/demoContract";
import { demoMetadataFor, planDemo, planPlainDemo, refitPlanForSize } from "../../../shared/demoVideo/demoPlanner";
import type { Logger } from "../logging/logger";
import { type DemoMp4Inspection, inspectDemoMp4 } from "./demoMp4Source";

/** The recording holds nothing to show. The caller must not file it as proof. */
export class DemoRecordingUnusableError extends Error {}

/** A recording's three lengths: the video, the real time it covers, and what was cut. */
export type DemoRecordingLengths = { durationMs: number; wallDurationMs: number; idleCutMs: number };

/** The lengths a filed demo reports. */
export function demoLengths(meta: DemoArtifactMetadata): DemoRecordingLengths {
  const durationMs = Math.round(meta.outputSeconds * 1000);
  const wallDurationMs = Math.round(meta.sourceSeconds * 1000);
  return { durationMs, wallDurationMs, idleCutMs: Math.max(0, wallDurationMs - durationMs) };
}

export type ProducedDemoVideo = {
  path: string;
  bytes: number;
  engine: DemoEngineId | null;
  metadata: DemoArtifactMetadata;
};

const PLAYABLE_RAW = new Set([".mp4", ".mov", ".m4v"]);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // A leftover temp file is not worth failing a filed demo over.
  }
}

/** A plan whose output is no smaller than the last one's: the ladder is at its bottom. */
function sameOutputSize(a: DemoPlan, b: DemoPlan): boolean {
  return a.output.width === b.output.width && a.output.height === b.output.height && a.output.fps === b.output.fps;
}

/**
 * Renders until the file fits under {@link DEMO_MAX_BYTES}: at a fitted
 * bitrate, then a ladder step smaller each time. After
 * {@link DEMO_MAX_RENDER_ATTEMPTS} renders it keeps going only while a
 * smaller step is left, so a result never goes out over the limit; the
 * bottom step holds a five-minute recording in under 2 MB. When even that is
 * over, it throws, and the caller keeps the raw file.
 */
async function renderToFit(args: {
  engine: DemoEngine;
  rawPath: string;
  outputPath: string;
  plan: DemoPlan;
  logger: Logger;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<{ plan: DemoPlan; bytes: number }> {
  let plan = args.plan;
  const maxAttempts = DEMO_MAX_RENDER_ATTEMPTS * 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    args.signal?.throwIfAborted();
    await args.engine.render(
      { input: args.rawPath, output: args.outputPath, plan },
      {
        signal: args.signal,
        onProgress: args.onProgress
          ? (fraction) => args.onProgress!(Math.min(1, (Math.min(attempt, DEMO_MAX_RENDER_ATTEMPTS) - 1 + fraction) / DEMO_MAX_RENDER_ATTEMPTS))
          : undefined,
      },
    );
    const bytes = fs.statSync(args.outputPath).size;
    if (bytes <= DEMO_MAX_BYTES) return { plan, bytes };
    args.logger.info("demo_video.refit", { attempt, bytes, bitrate: plan.output.bitrate, width: plan.output.width, fps: plan.output.fps });
    const next = refitPlanForSize(plan, bytes, { stepDown: attempt >= 2 });
    if (attempt >= DEMO_MAX_RENDER_ATTEMPTS && sameOutputSize(next, plan)) break;
    plan = next;
  }
  throw new Error(`the video could not be made smaller than ${Math.round(DEMO_MAX_BYTES / (1024 * 1024))} MB`);
}

export async function produceDemoVideo(args: {
  rawPath: string;
  outputPath: string;
  track: DemoTrack | null;
  plain: boolean;
  engines: Array<DemoEngine | null | undefined>;
  /** Why no engine is here, when the caller knows (`DemoEngineSet.missingEngineReason`). */
  missingEngineReason?: string | null;
  logger: Logger;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<ProducedDemoVideo> {
  const { rawPath, outputPath, logger } = args;
  if (!fs.existsSync(rawPath)) throw new Error("The recording's raw file is gone, so no video can be made.");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const engine = args.engines.find((candidate): candidate is DemoEngine => Boolean(candidate?.canRead(rawPath))) ?? null;
  const rawIsPlayable = PLAYABLE_RAW.has(path.extname(rawPath).toLowerCase());
  const startedAt = Date.now();
  const fileRawAsIs = async (reason: string, analysis: DemoAnalysis | null): Promise<ProducedDemoVideo> => {
    if (!rawIsPlayable) throw new Error(`The demo video could not be made: ${reason}`);
    // The movie's own index: an empty or unfinished one is never proof, and
    // one with no analysis still reports its real length, not zero.
    const inspection: DemoMp4Inspection = await inspectDemoMp4(rawPath);
    if (inspection.status === "unusable") {
      logger.warn("demo_video.unusable_raw", { reason: inspection.reason, rawPath });
      throw new DemoRecordingUnusableError(`The recording was not filed. ${inspection.reason}`);
    }
    // The raw file answers to the same 10 MB limit as a demo. One over it is
    // left for the caller, which keeps it and reports why.
    if (fs.statSync(rawPath).size > DEMO_MAX_BYTES) {
      throw new Error(`The demo video could not be made (${reason}), and the recording is over ${Math.round(DEMO_MAX_BYTES / (1024 * 1024))} MB as it was recorded.`);
    }
    removeQuietly(outputPath);
    if (path.resolve(rawPath) !== path.resolve(outputPath)) fs.renameSync(rawPath, outputPath);
    const seconds = analysis?.durationSeconds ?? (inspection.status === "ok" ? inspection.durationSeconds : 0);
    logger.warn("demo_video.fallback_raw", { reason, rawPath });
    return {
      path: outputPath,
      bytes: fs.statSync(outputPath).size,
      engine: null,
      metadata: {
        plain: true,
        engine: null,
        sourceSeconds: seconds,
        outputSeconds: seconds,
        cutSeconds: 0,
        spedUpSourceSeconds: 0,
        steps: [],
        fallbackReason: reason,
      },
    };
  };

  if (!engine) {
    const missing = args.missingEngineReason?.trim();
    return await fileRawAsIs(
      missing
        || (rawIsPlayable ? "this machine has no demo engine, so the recording is filed as it was recorded" : "no engine on this machine can read the recording"),
      null,
    );
  }

  let analysis: DemoAnalysis;
  try {
    analysis = await engine.analyze(rawPath, { signal: args.signal });
  } catch (error) {
    if (args.signal?.aborted) throw error;
    return await fileRawAsIs(`the recording could not be read (${errorText(error)})`, null);
  }

  const attempts: Array<{ plain: boolean; plan: () => DemoPlan }> = args.plain
    ? [{ plain: true, plan: () => planPlainDemo(analysis) }]
    : [
      { plain: false, plan: () => planDemo({ track: args.track, analysis, plain: false }) },
      { plain: true, plan: () => planPlainDemo(analysis) },
    ];

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const { plan, bytes } = await renderToFit({
        engine,
        rawPath,
        outputPath,
        plan: attempt.plan(),
        logger,
        signal: args.signal,
        onProgress: args.onProgress,
      });
      removeQuietly(rawPath);
      const metadata = demoMetadataFor({ plan, analysis, track: args.track, plain: attempt.plain, engine: engine.id });
      if (attempt.plain && !args.plain && lastError) {
        metadata.fallbackReason = `the demo could not be made (${errorText(lastError)}), so this is the plain recording`;
      }
      logger.info("demo_video.produced", {
        engine: engine.id,
        plain: attempt.plain,
        bytes,
        sourceSeconds: metadata.sourceSeconds,
        outputSeconds: metadata.outputSeconds,
        width: plan.output.width,
        fps: plan.output.fps,
        bitrate: plan.output.bitrate,
        elapsedMs: Date.now() - startedAt,
      });
      return { path: outputPath, bytes, engine: engine.id, metadata };
    } catch (error) {
      if (args.signal?.aborted) throw error;
      lastError = error;
      removeQuietly(outputPath);
      logger.warn("demo_video.render_failed", { engine: engine.id, plain: attempt.plain, error: errorText(error) });
    }
  }
  return await fileRawAsIs(`the video could not be rendered (${errorText(lastError)})`, analysis);
}
