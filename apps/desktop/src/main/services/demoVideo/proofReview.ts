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
import { PNG } from "pngjs";
import type { DemoAnalysis, DemoArtifactMetadata, DemoContactSheetRequest, DemoEngine } from "../../../shared/demoVideo/demoContract";
import { DEMO_CONTACT_SHEET_MAX_FRAMES, DEMO_CONTACT_SHEET_TILE_WIDTH } from "../../../shared/demoVideo/demoContract";
import { readProofProvenance } from "../../../shared/proofProvenance";
import { gifDimensions, jpegDimensions, pngDimensions, webpDimensions, type ImageDimensions } from "../shared/imageDimensions";
import type { Logger } from "../logging/logger";
import { readDemoMp4 } from "./demoMp4Source";
import { ensureFfmpegTools, runFfmpeg } from "./ffmpegDemoEngine";
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
  /** A picture taller than one page: how many pages it splits into. */
  pages?: number;
  /** The part asked for (`page`, or `yFrom`/`yTo`), as a viewable JPEG, and which part it is. */
  cropPath?: string;
  page?: number;
  yFrom?: number;
  yTo?: number;
  cropError?: string;
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);

/** Part of a video to look at closer, and how many frames to show. */
export type ProofReviewWindow = {
  from?: number | null;
  to?: number | null;
  frames?: number | null;
  /** A tall picture's page, from 1. */
  page?: number | null;
  /** A band of a tall picture, in its pixels. */
  yFrom?: number | null;
  yTo?: number | null;
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
    : await reviewImage(args, findings);
}

/** One page of a tall picture is this many widths high, about a phone or laptop viewport. */
const PAGE_ASPECT = 1.5;
/** Wider than this, a model sees the picture scaled down anyway. */
const CROP_MAX_WIDTH = 1568;
/** A whole picture over this is re-encoded, so it fits an MCP answer. */
const WHOLE_PICTURE_MAX_BYTES = 2_000_000;
const CROP_TIMEOUT_MS = 30_000;
/** pngjs holds the whole picture in memory on the brain's thread; past this (about 100 MB) ffmpeg cuts it instead. */
const PNG_DECODE_MAX_PIXELS = 25_000_000;

function pageHeightOf(size: ImageDimensions): number {
  return Math.max(1, Math.round(size.width * PAGE_ASPECT));
}

function pageCountOf(size: ImageDimensions): number {
  return Math.max(1, Math.ceil(size.height / pageHeightOf(size)));
}

/** Where a review writes what it made: `.ade/cache/proof-review`, named for the proof and the time. */
function reviewOutputPath(args: ReviewArgs, suffix: string): string {
  const dir = path.join(args.projectRoot, ".ade", "cache", "proof-review");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = (args.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `review-${stamp}-${args.artifact.id.slice(0, 8)}${suffix}`);
}

/** The band of the picture a window asks for; null when the whole file serves as it is. */
function cropBand(
  size: ImageDimensions,
  window: ProofReviewWindow | undefined,
  fileBytes: number,
): { band: { y: number; height: number; page?: number } | null; error?: string } {
  if (window?.yFrom != null || window?.yTo != null) {
    const from = Math.max(0, Math.floor(window.yFrom ?? 0));
    const to = Math.min(size.height, Math.ceil(window.yTo ?? from + size.width * PAGE_ASPECT));
    if (to <= from) return { band: null, error: `That band is outside the picture, which is ${size.height} pixels tall.` };
    return { band: { y: from, height: to - from } };
  }
  if (window?.page == null) return { band: null };
  const pageHeight = pageHeightOf(size);
  const pages = pageCountOf(size);
  if (window.page > pages) return { band: null, error: `The picture has ${pages} page${pages === 1 ? "" : "s"}.` };
  if (pages === 1 && fileBytes <= WHOLE_PICTURE_MAX_BYTES) return { band: null };
  const y = (window.page - 1) * pageHeight;
  return { band: { y, height: Math.min(pageHeight, size.height - y), page: window.page } };
}

/** Averages each `factor` × `factor` block into one pixel; the picture as it is when the factor is 1. */
function shrinkPng(image: PNG, factor: number): PNG {
  if (factor <= 1) return image;
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    // A band shorter (or narrower) than the factor averages only the pixels it has.
    const rows = Math.min(factor, image.height - y * factor);
    for (let x = 0; x < width; x += 1) {
      const cols = Math.min(factor, image.width - x * factor);
      const sums = [0, 0, 0, 0];
      for (let dy = 0; dy < rows; dy += 1) {
        const row = ((y * factor + dy) * image.width + x * factor) * 4;
        for (let dx = 0; dx < cols; dx += 1) {
          for (let channel = 0; channel < 4; channel += 1) sums[channel]! += image.data[row + dx * 4 + channel]!;
        }
      }
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) out.data[at + channel] = Math.round(sums[channel]! / (rows * cols));
    }
  }
  return out;
}

/** The band as its own PNG. pngjs ships with ADE, so this works on a computer with no ffmpeg. */
async function cropPng(input: string, output: string, band: { y: number; height: number }): Promise<void> {
  const source = await new Promise<PNG>((resolve, reject) => {
    const reader = new PNG();
    const file = fs.createReadStream(input);
    reader.on("parsed", () => resolve(reader));
    // A corrupt file must not keep its descriptor open until garbage collection.
    reader.on("error", (error) => {
      file.destroy();
      reject(error);
    });
    file.on("error", reject).pipe(reader);
  });
  const full = new PNG({ width: source.width, height: band.height });
  PNG.bitblt(source, full, 0, band.y, source.width, band.height, 0, 0);
  // Halved again while it is still too big to send (a detailed page compresses badly).
  for (let factor = Math.ceil(source.width / CROP_MAX_WIDTH); ; factor *= 2) {
    const cut = shrinkPng(full, factor);
    await new Promise<void>((resolve, reject) => {
      cut.pack().on("error", reject).pipe(fs.createWriteStream(output)).on("finish", () => resolve()).on("error", reject);
    });
    if (fs.statSync(output).size <= WHOLE_PICTURE_MAX_BYTES || cut.width <= 320) return;
  }
}

async function cropPicture(
  args: ReviewArgs,
  size: ImageDimensions,
  band: { y: number; height: number },
): Promise<{ cropPath: string } | { cropError: string }> {
  const isPng = path.extname(args.filePath).toLowerCase() === ".png" && size.width * size.height <= PNG_DECODE_MAX_PIXELS;
  let tools: Awaited<ReturnType<typeof ensureFfmpegTools>> | null = null;
  if (!isPng) {
    try {
      tools = await ensureFfmpegTools();
    } catch (error) {
      return { cropError: error instanceof Error ? error.message : String(error) };
    }
  }
  const output = reviewOutputPath(args, `-y${band.y}.${isPng ? "png" : "jpg"}`);
  const dir = path.dirname(output);
  try {
    if (tools) {
      await runFfmpeg({
        binaryPath: tools.ffmpegPath,
        args: [
          "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
          "-i", args.filePath,
          "-vf", `crop=${size.width}:${band.height}:0:${band.y},scale='trunc(min(${CROP_MAX_WIDTH},iw)/2)*2':-2,format=yuvj420p`,
          "-frames:v", "1", "-update", "1", "-q:v", "3",
          "-f", "image2", "-c:v", "mjpeg",
          output,
        ],
        timeoutMs: CROP_TIMEOUT_MS,
        signal: args.signal,
        logger: null,
        label: "proof crop",
      });
    } else {
      await cropPng(args.filePath, output, band);
    }
    pruneSheets(dir, args.logger);
    return { cropPath: output };
  } catch (error) {
    return { cropError: `ADE could not cut the picture: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function reviewImage(args: ReviewArgs, findings: string[]): Promise<ProofReview> {
  const size = readImageSize(args.filePath);
  if (size) imageFindings(size, findings);
  const pages = size ? pageCountOf(size) : 1;
  const fileBytes = (() => {
    try {
      return fs.statSync(args.filePath).size;
    } catch {
      return 0;
    }
  })();
  const { band, error: bandError } = size ? cropBand(size, args.window, fileBytes) : { band: null, error: undefined };
  const cropped = size && band ? await cropPicture(args, size, band) : null;
  return {
    ...(pages > 1 ? { pages } : {}),
    ...(bandError ? { cropError: bandError } : {}),
    ...(cropped ?? {}),
    ...(band?.page ? { page: band.page } : {}),
    ...(band ? { yFrom: band.y, yTo: band.y + band.height } : {}),
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
    const output = reviewOutputPath(args, ".png");
    const dir = path.dirname(output);
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
    const sheets = fs.readdirSync(dir).filter((entry) => entry.startsWith("review-") && (entry.endsWith(".png") || entry.endsWith(".jpg"))).sort();
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
