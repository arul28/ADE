/**
 * Turns a finished raw recording into the one file ADE keeps: the demo.
 *
 * measure (engine) → plan (`demoPlanner.ts`) → render (engine) → check the
 * size → delete the raw file.
 *
 * - The first engine that can read the raw file does the work: the Swift
 *   `ade-media` for an MP4/MOV on macOS, the desktop app's Chromium engine for
 *   an `.aderaw` capture.
 * - Every result ends under {@link DEMO_MAX_BYTES}. A render over it is done
 *   again at a fitted bitrate, a step smaller when needed, up to
 *   {@link DEMO_MAX_RENDER_ATTEMPTS} times.
 * - A demo render that fails is tried once more as a plain render. When that
 *   fails too, a raw MP4 is filed as it is (the fallback is recorded in the
 *   metadata, and it may be over the limit); a raw `.aderaw` cannot be played,
 *   so the error is thrown and nothing is filed.
 * - The raw file never outlives this call when a file is returned: it is
 *   deleted after a render, or it becomes the output on the fallback. On a
 *   thrown error it is left for the caller, which decides.
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
  let smallest: { plan: DemoPlan; bytes: number } | null = null;
  for (let attempt = 1; attempt <= DEMO_MAX_RENDER_ATTEMPTS; attempt += 1) {
    args.signal?.throwIfAborted();
    await args.engine.render(
      { input: args.rawPath, output: args.outputPath, plan },
      {
        signal: args.signal,
        onProgress: args.onProgress
          ? (fraction) => args.onProgress!(Math.min(1, (attempt - 1 + fraction) / DEMO_MAX_RENDER_ATTEMPTS))
          : undefined,
      },
    );
    const bytes = fs.statSync(args.outputPath).size;
    if (bytes <= DEMO_MAX_BYTES) return { plan, bytes };
    args.logger.info("demo_video.refit", { attempt, bytes, bitrate: plan.output.bitrate, width: plan.output.width, fps: plan.output.fps });
    if (!smallest || bytes < smallest.bytes) smallest = { plan, bytes };
    if (attempt < DEMO_MAX_RENDER_ATTEMPTS) plan = refitPlanForSize(plan, bytes, { stepDown: attempt >= 2 });
  }
  // Out of attempts: the last render is on disk. The smallest one is the best
  // answer; render it again only when the last one was not it.
  if (smallest && smallest.plan !== plan) {
    await args.engine.render({ input: args.rawPath, output: args.outputPath, plan: smallest.plan }, { signal: args.signal });
    return { plan: smallest.plan, bytes: fs.statSync(args.outputPath).size };
  }
  return { plan, bytes: fs.statSync(args.outputPath).size };
}

export async function produceDemoVideo(args: {
  rawPath: string;
  outputPath: string;
  track: DemoTrack | null;
  plain: boolean;
  engines: Array<DemoEngine | null | undefined>;
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

  const fileRawAsIs = (reason: string, analysis: DemoAnalysis | null): ProducedDemoVideo => {
    if (!rawIsPlayable) throw new Error(`The demo video could not be made: ${reason}`);
    removeQuietly(outputPath);
    if (path.resolve(rawPath) !== path.resolve(outputPath)) fs.renameSync(rawPath, outputPath);
    const seconds = analysis?.durationSeconds ?? 0;
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
    return fileRawAsIs(
      rawIsPlayable ? "this machine has no demo engine, so the recording is filed as it was recorded" : "no engine on this machine can read the recording",
      null,
    );
  }

  let analysis: DemoAnalysis;
  try {
    analysis = await engine.analyze(rawPath, { signal: args.signal });
  } catch (error) {
    if (args.signal?.aborted) throw error;
    return fileRawAsIs(`the recording could not be read (${errorText(error)})`, null);
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
  return fileRawAsIs(`the video could not be rendered (${errorText(lastError)})`, analysis);
}
