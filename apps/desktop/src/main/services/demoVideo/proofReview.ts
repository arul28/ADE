/**
 * `ade proof review <id>`: what an agent needs to check its own proof before
 * a person sees it. For a video, a contact sheet of frames across it (one
 * image the agent can look at instead of the whole video); for a picture, the
 * picture itself. Both come with the findings ADE can tell from the file and
 * its record alone. What the frames show (a stray banner, a tiny subject, a
 * secret on screen) is the agent's call: the sheet is what it looks at.
 *
 * The sheet goes under `.ade/cache/proof-review/`, never to the proof drawer.
 */

import fs from "node:fs";
import path from "node:path";
import type { DemoEngine } from "../../../shared/demoVideo/demoContract";
import { readDemoMp4 } from "./demoMp4Source";

/** Sheets kept per project; older ones are removed as new ones are written. */
const SHEET_KEEP = 20;
const MIN_FRAMES = 4;
const MAX_FRAMES = 12;
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
  columns: number;
  /** What ADE found from the file and its record. Empty when nothing. */
  findings: string[];
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);

export async function reviewProofFile(args: {
  artifact: ProofReviewInput;
  filePath: string;
  projectRoot: string;
  engines: DemoEngine[];
  now?: () => Date;
  signal?: AbortSignal;
}): Promise<ProofReview> {
  const video = VIDEO_EXTENSIONS.has(path.extname(args.filePath).toLowerCase());
  const metadata = args.artifact.metadata ?? {};
  const findings: string[] = [];
  if (metadata.recordedBeforeRequest === true) findings.push("Recorded before this request: record it again.");

  if (!video) {
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
      columns: 0,
      findings,
    };
  }

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
  const demo = metadata.demo && typeof metadata.demo === "object" ? (metadata.demo as Record<string, unknown>) : null;
  if (duration == null && typeof demo?.outputSeconds === "number") duration = demo.outputSeconds;
  if (demo?.fallbackReason) findings.push(`Not a demo: ${String(demo.fallbackReason)}. Record it again.`);
  else if (demo?.plain === true) findings.push("A plain recording (no cuts, frame or captions). Fine only when someone asked for it as recorded.");
  if (demo && !demo.plain && Array.isArray(demo.steps) && demo.steps.length === 0) {
    findings.push("No captions. Mark each beat with `ade proof step \"<short caption>\"` while recording.");
  }
  if (duration != null && duration < SHORT_SECONDS) findings.push(`Only ${duration.toFixed(1)} s: too short to show anything happen.`);
  if (duration != null && duration > LONG_SECONDS) findings.push(`${Math.round(duration)} s is long for a demo. Record only the flow, or split it into one video per feature.`);

  const portrait = width != null && height != null && height > width;
  const columns = portrait ? 6 : 4;
  const tileWidth = portrait ? 240 : 480;
  const count = duration == null ? MAX_FRAMES : Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, Math.round(duration)));
  const span = duration ?? 0;
  const frameTimes = Array.from({ length: count }, (_, index) => round2(((index + 0.5) * span) / count));

  // In engine order; one that fails (an older helper without the command, a
  // codec it cannot read) hands the video to the next.
  const engines = args.engines.filter((candidate) => candidate.contactSheet && candidate.canRead(args.filePath));
  let sheetPath: string | null = null;
  let sheetError: string | null = null;
  if (!engines.length) {
    sheetError = "No engine on this machine can read this video for a frame sheet";
  } else if (duration == null) {
    sheetError = "ADE could not read the video's length";
  } else {
    const dir = path.join(args.projectRoot, ".ade", "cache", "proof-review");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = (args.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const output = path.join(dir, `review-${stamp}-${args.artifact.id.slice(0, 8)}.png`);
    for (const engine of engines) {
      try {
        await engine.contactSheet!({ input: args.filePath, output, times: frameTimes, columns, tileWidth }, { signal: args.signal });
        sheetPath = output;
        sheetError = null;
        pruneSheets(dir);
        break;
      } catch (error) {
        if (args.signal?.aborted) throw error;
        sheetError = `${engine.id}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
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
    columns,
    findings,
  };
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

function pruneSheets(dir: string): void {
  try {
    const sheets = fs.readdirSync(dir).filter((entry) => entry.startsWith("review-") && entry.endsWith(".png")).sort();
    for (const stale of sheets.slice(0, Math.max(0, sheets.length - SHEET_KEEP))) fs.rmSync(path.join(dir, stale), { force: true });
  } catch {
    // Pruning is housekeeping; the sheet itself is written.
  }
}

/** Width and height from a PNG, JPEG, GIF or WebP header; null for anything else. */
export function readImageSize(filePath: string): { width: number; height: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(64 * 1024);
    const length = fs.readSync(fd, head, 0, head.length, 0);
    const bytes = head.subarray(0, length);
    if (length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (length >= 10 && bytes.toString("ascii", 0, 3) === "GIF") {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
      const chunk = bytes.toString("ascii", 12, 16);
      if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      if (chunk === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1]!;
        const segment = bytes.readUInt16BE(offset + 2);
        // SOF0–SOF15 carry the size, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
        }
        offset += 2 + segment;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}
