/**
 * The proof a saved chat cites, saved with the chat's copy before an ADE
 * Cloud computer rests (`cloudRestSave.ts`), so a client shows it while the
 * computer sleeps or after it is deleted, with no wake.
 *
 * - Which proof: every `![…](ade-proof://<id>)` and ```proof-compare id in
 *   the chat's answers (`citedProofArtifactIds`), read from its transcript.
 * - A picture goes up as WebP, its longest side at most 2000 px, quality 80,
 *   so text in a screenshot stays readable. Without a WebP encoder it goes as
 *   JPEG; without ffmpeg, as the original when it is a PNG, JPEG, WebP or GIF
 *   under the server's cap.
 * - A video goes up as one still (its frame at one second, the same way).
 *   The client shows the still and wakes the computer to play the video.
 *
 * The server checks the bytes again and keeps nothing else (`chats.ts`).
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  CLOUD_CHAT_PROOF_MAX_BYTES,
  CLOUD_CHAT_PROOF_MAX_PER_CHAT,
  CLOUD_CHAT_PROOF_MIME,
  cloudChatProofKindOf,
  type CloudChatProofSource,
} from "../../../../account-directory/src/cloud/contract";
import { citedProofArtifactIds, PROOF_COMPARE_FENCE_LANGUAGE } from "../../../../desktop/src/shared/proofCitation";
import { resolveExecutableFromKnownLocations } from "../../../../desktop/src/main/services/ai/cliExecutableResolver";

/** How much of a transcript's end is read for its citations. */
const SCAN_BYTES = 16 * 1024 * 1024;
/** The longest side of a saved picture, in pixels. */
const MAX_SIDE_PX = 2000;
const WEBP_QUALITY = "80";
/** JPEG's `-q:v` (2 best … 31 worst): about the same text legibility as WebP 80. */
const JPEG_QSCALE = "4";
/** Where a video's still is taken, in seconds; a shorter video gives its first frame. */
const STILL_AT_SECONDS = "1";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif", ".tif", ".tiff", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".qt", ".webm", ".mkv", ".avi"]);
/** Pictures the server keeps as they are, when nothing here can convert them. */
const ORIGINAL_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * Every proof id a chat's answers cite, oldest first, the newest
 * `CLOUD_CHAT_PROOF_MAX_PER_CHAT`. Answers stream in pieces, so each
 * message's text is joined before it is read. A transcript that is missing
 * or can't be read cites nothing.
 */
export function chatCitedProofIds(transcriptPath: string, maxBytes: number = SCAN_BYTES): string[] {
  const text = readTranscriptEnd(transcriptPath, maxBytes);
  if (!text) return [];
  const messages = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.includes('"text"')) continue;
    try {
      const event = (JSON.parse(line) as { event?: { type?: unknown; text?: unknown; messageId?: unknown; turnId?: unknown } }).event;
      if (event?.type !== "text" || typeof event.text !== "string") continue;
      const key = typeof event.messageId === "string" ? `m:${event.messageId}` : typeof event.turnId === "string" ? `t:${event.turnId}` : "";
      messages.set(key, (messages.get(key) ?? "") + event.text);
    } catch {
      // A line cut by the read window, or not JSON.
    }
  }
  const ids: string[] = [];
  for (const answer of messages.values()) {
    if (!answer.includes("ade-proof") && !answer.includes(PROOF_COMPARE_FENCE_LANGUAGE)) continue;
    for (const id of citedProofArtifactIds(answer)) {
      // Cited again later: it counts as the newer citation.
      const at = ids.indexOf(id);
      if (at >= 0) ids.splice(at, 1);
      ids.push(id);
    }
  }
  return ids.slice(-CLOUD_CHAT_PROOF_MAX_PER_CHAT);
}

/** The transcript's last `maxBytes` as text (`.jsonl`, else `.jsonl.gz`), or null. */
function readTranscriptEnd(transcriptPath: string, maxBytes: number): string | null {
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    try {
      const raw = gunzipSync(fs.readFileSync(`${transcriptPath}.gz`), { maxOutputLength: 8 * maxBytes });
      return raw.subarray(Math.max(0, raw.length - maxBytes)).toString("utf8");
    } catch {
      return null;
    }
  }
}

/** A transcript's size and time, which change with every new line; null when it is missing. */
export function transcriptMark(transcriptPath: string): string | null {
  for (const file of [transcriptPath, `${transcriptPath}.gz`]) {
    try {
      const stat = fs.statSync(file);
      return `${stat.size}|${Math.floor(stat.mtimeMs)}`;
    } catch {
      // Try the packed one.
    }
  }
  return null;
}

/** Whether a proof file is a picture or a video, by its record and its name; null for anything else (text, a trace). */
export function proofSourceOf(artifact: { kind?: string | null; mimeType?: string | null }, filePath: string): CloudChatProofSource | null {
  const extension = path.extname(filePath).toLowerCase();
  const mime = artifact.mimeType?.toLowerCase() ?? "";
  if (artifact.kind === "video_recording" || mime.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) return "video";
  if (mime === "image/svg+xml" || extension === ".svg") return null;
  if (artifact.kind === "screenshot" || mime.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) return "image";
  return null;
}

export type ProofFfmpeg = { path: string; webp: boolean };

/** ffmpeg builds already asked for their encoders, by path. */
const webpCapable = new Map<string, boolean>();

function encodesWebp(binaryPath: string): Promise<boolean> {
  const known = webpCapable.get(binaryPath);
  if (known !== undefined) return Promise.resolve(known);
  return new Promise((resolve) => {
    execFile(binaryPath, ["-hide_banner", "-encoders"], { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const capable = !error && /\blibwebp\b/.test(String(stdout ?? ""));
      webpCapable.set(binaryPath, capable);
      resolve(capable);
    });
  });
}

/**
 * The ffmpeg on this computer (the cloud template installs one), or ADE's own
 * copy when it is already here. Never a download: the rest save must not wait
 * on one. Null when there is none.
 */
export async function findProofFfmpeg(): Promise<ProofFfmpeg | null> {
  let binary = resolveExecutableFromKnownLocations("ffmpeg")?.path ?? null;
  if (!binary) {
    const { resolveFfmpegTools } = await import("../../../../desktop/src/main/services/demoVideo/ffmpegDemoEngine");
    binary = resolveFfmpegTools()?.ffmpegPath ?? null;
  }
  return binary ? { path: binary, webp: await encodesWebp(binary) } : null;
}

export type ProofPicture = { bytes: Buffer; contentType: string; via: "webp" | "jpeg" | "original" };

/** The scale that keeps the picture's shape with neither side past `MAX_SIDE_PX` (and never larger than it was). */
const SCALE = `scale='min(${MAX_SIDE_PX},iw)':'min(${MAX_SIDE_PX},ih)':force_original_aspect_ratio=decrease`;

function runFfmpegOnce(binary: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: Math.max(1_000, timeoutMs), windowsHide: true, maxBuffer: 1024 * 1024 }, (error) => resolve(!error));
  });
}

/** One frame of `input` as WebP or JPEG at `output`; true when ffmpeg made it. */
async function convertFrame(binary: string, input: string, output: string, codec: "webp" | "jpeg", source: CloudChatProofSource, timeoutMs: number): Promise<boolean> {
  const encode = codec === "webp"
    ? ["-vf", SCALE, "-c:v", "libwebp", "-quality", WEBP_QUALITY, "-compression_level", "4", "-f", "webp"]
    : ["-vf", `${SCALE}:force_divisible_by=2`, "-pix_fmt", "yuvj420p", "-c:v", "mjpeg", "-q:v", JPEG_QSCALE, "-f", "image2"];
  const run = (seek: boolean) => runFfmpegOnce(binary, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...(seek ? ["-ss", STILL_AT_SECONDS] : []),
    "-i", input, "-frames:v", "1", "-an", ...encode, output,
  ], timeoutMs);
  const made = () => {
    try {
      return fs.statSync(output).size > 0;
    } catch {
      return false;
    }
  };
  if (await run(source === "video") && made()) return true;
  // A video shorter than the seek gives no frame there: its first frame instead.
  return source === "video" && await run(false) && made();
}

/**
 * The picture to save for one proof file: WebP, else JPEG, else (a picture
 * only) the original when the server keeps it as it is. Each is checked by
 * its first bytes and the server's cap. Null when there is nothing to save:
 * a video with no ffmpeg here, a picture nothing can make small enough, or a
 * file that can't be read.
 */
export async function proofPictureFor(input: { filePath: string; source: CloudChatProofSource; ffmpeg: ProofFfmpeg | null; timeoutMs: number }): Promise<ProofPicture | null> {
  const { filePath, source, ffmpeg } = input;
  const startedAt = Date.now();
  const left = () => input.timeoutMs - (Date.now() - startedAt);
  const kept = (bytes: Buffer | null, via: ProofPicture["via"]): ProofPicture | null => {
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > CLOUD_CHAT_PROOF_MAX_BYTES) return null;
    const kind = cloudChatProofKindOf(bytes);
    return kind ? { bytes, contentType: CLOUD_CHAT_PROOF_MIME[kind], via } : null;
  };
  if (ffmpeg) {
    for (const codec of ffmpeg.webp ? (["webp", "jpeg"] as const) : (["jpeg"] as const)) {
      if (left() <= 1_000) break;
      const output = path.join(os.tmpdir(), `ade-proof-save-${randomUUID()}.${codec === "webp" ? "webp" : "jpg"}`);
      try {
        if (await convertFrame(ffmpeg.path, filePath, output, codec, source, left())) {
          const picture = kept(await fs.promises.readFile(output).catch(() => null), codec);
          if (picture) return picture;
        }
      } finally {
        await fs.promises.rm(output, { force: true }).catch(() => undefined);
      }
    }
  }
  if (source !== "image" || !ORIGINAL_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null;
  try {
    if ((await fs.promises.stat(filePath)).size > CLOUD_CHAT_PROOF_MAX_BYTES) return null;
    return kept(await fs.promises.readFile(filePath), "original");
  } catch {
    return null;
  }
}
