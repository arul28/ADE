/**
 * `ade proof review <id>`: what an agent needs to check its own proof before
 * a person sees it. For a video, a contact sheet of its key moments (one
 * image the agent can look at instead of the whole video; `sheetFrames.ts`
 * picks them); for a picture, the picture itself. Both come with the findings
 * ADE can tell from the file and its record alone. What the frames show (a
 * stray banner, a tiny subject, a secret on screen) is the agent's call: the
 * sheet is what it looks at.
 *
 * The sheet goes under `.ade/cache/proof-review/`, never to the proof drawer.
 */

import fs from "node:fs";
import path from "node:path";
import type { DemoAnalysis, DemoArtifactMetadata, DemoContactSheetRequest, DemoEngine } from "../../../shared/demoVideo/demoContract";
import { DEMO_CONTACT_SHEET_MAX_FRAMES, DEMO_CONTACT_SHEET_TILE_WIDTH } from "../../../shared/demoVideo/demoContract";
import { readProofProvenance } from "../../../shared/proofProvenance";
import { gifDimensions, jpegDimensions, pngDimensions, webpDimensions, type ImageDimensions } from "../shared/imageDimensions";
import type { Logger } from "../logging/logger";
import { readDemoMp4 } from "./demoMp4Source";
import { pickSheetFrames, type SheetFrame } from "./sheetFrames";

/** Sheets kept per project; older ones are removed as new ones are written. */
const SHEET_KEEP = 20;
const SHORT_SECONDS = 3;
const LONG_SECONDS = 90;
/** A picture whose shorter side is under this reads soft once posted. */
const SMALL_SIDE = 700;
const STRIP_ASPECT = 3;

export type ProofReviewInput = {
  id: string;
  kind: string;
  metadata: Record<string, unknown> | null;
};

/** The render summary a demo recording's record carries, when it has one. */
function demoMetadataOf(metadata: Record<string, unknown> | null): Partial<DemoArtifactMetadata> | null {
  const demo = metadata?.demo;
  return demo && typeof demo === "object" && !Array.isArray(demo) ? (demo as Partial<DemoArtifactMetadata>) : null;
}

export type ProofReview = {
  artifactId: string;
  media: "video" | "image";
  /** The stored proof file. */
  path: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /** The contact sheet to look at (a video), or null with `sheetError`. */
  sheetPath: string | null;
  sheetError: string | null;
  /** Times of the sheet's frames, left to right, top to bottom. */
  frameTimes: number[];
  /** The same frames with why each is there and the caption showing. */
  frames: SheetFrame[];
  columns: number;
  /** What ADE found from the file and its record. Empty when nothing. */
  findings: string[];
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);

/** Part of a video to look at closer, and how many frames to show. */
export type ProofReviewWindow = {
  from?: number | null;
  to?: number | null;
  frames?: number | null;
};

type ReviewArgs = {
  artifact: ProofReviewInput;
  window?: ProofReviewWindow;
  logger?: Pick<Logger, "warn">;
  filePath: string;
  projectRoot: string;
  engines: DemoEngine[];
  now?: () => Date;
  signal?: AbortSignal;
};

export async function reviewProofFile(args: ReviewArgs): Promise<ProofReview> {
  const findings: string[] = [];
  if (readProofProvenance(args.artifact.metadata).recordedBeforeRequest) findings.push("Recorded before this request: record it again.");
  return VIDEO_EXTENSIONS.has(path.extname(args.filePath).toLowerCase())
    ? await reviewVideo(args, findings)
    : reviewImage(args, findings);
}

function reviewImage(args: ReviewArgs, findings: string[]): ProofReview {
  const size = readImageSize(args.filePath);
  if (size) imageFindings(size, findings);
  return {
    artifactId: args.artifact.id,
    media: "image",
    path: args.filePath,
    width: size?.width ?? null,
    height: size?.height ?? null,
    durationSeconds: null,
    sheetPath: null,
    sheetError: null,
    frameTimes: [],
    frames: [],
    columns: 0,
    findings,
  };
}

async function reviewVideo(args: ReviewArgs, findings: string[]): Promise<ProofReview> {
  let width: number | null = null;
  let height: number | null = null;
  let duration: number | null = null;
  try {
    const info = await readDemoMp4(args.filePath);
    width = info.width;
    height = info.height;
    duration = info.durationSeconds;
  } catch {
    // A movie this reader does not know (a WebM, HEVC): the sheet engine may still read it.
  }
  // The same engines measure the moments; they also size a movie the MP4 reader could not.
  const readers = args.engines.filter((engine) => engine.canRead(args.filePath));
  const analysis = await analyzeVideo(readers, args.filePath, args.logger, args.signal);
  if (analysis && width == null && height == null) {
    width = analysis.width;
    height = analysis.height;
  }
  if (duration == null && analysis && analysis.durationSeconds > 0) duration = analysis.durationSeconds;
  const demo = demoMetadataOf(args.artifact.metadata);
  if (duration == null && typeof demo?.outputSeconds === "number") duration = demo.outputSeconds;
  if (demo?.fallbackReason) findings.push(`Not a demo: ${demo.fallbackReason}. Record it again.`);
  else if (demo?.plain === true) findings.push("A plain recording (no cuts, frame or captions). Fine only when someone asked for it as recorded.");
  if (demo && !demo.plain && Array.isArray(demo.steps) && demo.steps.length === 0) {
    findings.push("No captions. Mark each beat with `ade proof step \"<short caption>\"` while recording.");
  }
  if (duration != null && duration < SHORT_SECONDS) findings.push(`Only ${duration.toFixed(1)} s: too short to show anything happen.`);
  if (duration != null && duration > LONG_SECONDS) findings.push(`${Math.round(duration)} s is long for a demo. Record only the flow, or split it into one video per feature.`);

  // Four 384 px tiles a row, six 240 px for portrait. Twelve landscape frames
  // come to about 1 megapixel, under the ~1.15 vision models read without
  // scaling; a portrait sheet or a 16-frame one runs larger (up to ~1.8) and
  // may be scaled down, which the tile labels survive.
  const portrait = width != null && height != null && height > width;
  const columns = portrait ? 6 : 4;
  const tileWidth = portrait ? 240 : 384;
  const frames = duration == null
    ? []
    : pickSheetFrames({
      durationSeconds: duration,
      steps: Array.isArray(demo?.steps) ? demo.steps : [],
      changes: analysis?.frames ?? null,
      from: args.window?.from,
      to: args.window?.to,
      frames: args.window?.frames,
    });
  const frameTimes = frames.map((frame) => frame.t);

  // In engine order; one that fails (an older helper without the command, a
  // codec it cannot read) hands the video to the next.
  const sheetMakers = readers.flatMap((engine) => {
    const contactSheet = engine.contactSheet?.bind(engine);
    return contactSheet ? [{ id: engine.id, contactSheet }] : [];
  });
  let sheetPath: string | null = null;
  let sheetError: string | null = null;
  if (!sheetMakers.length) {
    sheetError = "No engine on this machine can read this video for a frame sheet";
  } else if (duration == null) {
    sheetError = "ADE could not read the video's length";
  } else {
    const dir = path.join(args.projectRoot, ".ade", "cache", "proof-review");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = (args.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const output = path.join(dir, `review-${stamp}-${args.artifact.id.slice(0, 8)}.png`);
    const request: DemoContactSheetRequest = { input: args.filePath, output, times: frameTimes, columns, tileWidth };
    sheetError = contactSheetRequestError(request);
    for (const maker of sheetError ? [] : sheetMakers) {
      try {
        await maker.contactSheet(request, { signal: args.signal });
        sheetPath = output;
        sheetError = null;
        pruneSheets(dir, args.logger);
        break;
      } catch (error) {
        if (args.signal?.aborted) throw error;
        sheetError = `${maker.id}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
      }
    }
  }
  return {
    artifactId: args.artifact.id,
    media: "video",
    path: args.filePath,
    width,
    height,
    durationSeconds: duration == null ? null : round2(duration),
    sheetPath,
    sheetError,
    frameTimes,
    frames,
    columns,
    findings,
  };
}

/**
 * How much the screen changed frame to frame, from the first engine that can
 * measure this file; null when none can. Without it the sheet still has the
 * ends, the steps and even fill, only not the moments between.
 */
async function analyzeVideo(
  engines: DemoEngine[],
  filePath: string,
  logger: Pick<Logger, "warn"> | undefined,
  signal: AbortSignal | undefined,
): Promise<DemoAnalysis | null> {
  for (const engine of engines) {
    try {
      return await engine.analyze(filePath, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      logger?.warn("proof_review.analyze_failed", {
        engine: engine.id,
        error: error instanceof Error ? error.message.split("\n")[0] : String(error),
      });
    }
  }
  return null;
}

/** Why an engine would refuse this sheet (the contract's limits), or null. */
function contactSheetRequestError(request: DemoContactSheetRequest): string | null {
  const count = request.times.length;
  if (count === 0) return "A contact sheet needs at least one frame time";
  if (count > DEMO_CONTACT_SHEET_MAX_FRAMES) return `A contact sheet holds at most ${DEMO_CONTACT_SHEET_MAX_FRAMES} frames (asked for ${count})`;
  if (!request.times.every(Number.isFinite)) return "A contact sheet's frame times must be numbers of seconds";
  if (!Number.isInteger(request.columns) || request.columns < 1) return "A contact sheet needs a whole number of columns, at least one";
  const { min, max } = DEMO_CONTACT_SHEET_TILE_WIDTH;
  if (!Number.isInteger(request.tileWidth) || request.tileWidth < min || request.tileWidth > max) {
    return `A contact sheet's tiles must be ${min}–${max} px wide (asked for ${request.tileWidth})`;
  }
  return null;
}

function imageFindings(size: { width: number; height: number }, findings: string[]): void {
  if (Math.min(size.width, size.height) < SMALL_SIDE) {
    findings.push(`${size.width}×${size.height} is small for posting. Capture at 2× (a browser: \`emulate --scale 2\`) or with a larger window.`);
  }
  const aspect = size.width / Math.max(size.height, 1);
  if (aspect > STRIP_ASPECT || aspect < 1 / STRIP_ASPECT) {
    findings.push(`${size.width}×${size.height} is a thin strip. Crop to the subject with some context around it.`);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pruneSheets(dir: string, logger?: Pick<Logger, "warn">): void {
  try {
    const sheets = fs.readdirSync(dir).filter((entry) => entry.startsWith("review-") && entry.endsWith(".png")).sort();
    for (const stale of sheets.slice(0, Math.max(0, sheets.length - SHEET_KEEP))) fs.rmSync(path.join(dir, stale), { force: true });
  } catch (error) {
    // Pruning is housekeeping; the sheet itself is written.
    logger?.warn("proof_review.prune_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Width and height from a PNG, JPEG, GIF or WebP header; null for anything else. */
function readImageSize(filePath: string): ImageDimensions | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(64 * 1024);
    const bytes = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0));
    return pngDimensions(bytes) ?? jpegDimensions(bytes) ?? gifDimensions(bytes) ?? webpDimensions(bytes);
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}
