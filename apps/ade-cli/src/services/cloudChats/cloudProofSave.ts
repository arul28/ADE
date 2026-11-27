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

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  CLOUD_CHAT_PROOF_MAX_BYTES,
  CLOUD_CHAT_PROOF_MAX_PER_CHAT,
  CLOUD_CHAT_PROOF_MIME,
  cloudChatProofKindOf,
  type CloudChatProofSource,
} from "../../../../account-directory/src/cloud/contract";
import { CloudApiError, type CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import { citedProofArtifactIds, PROOF_COMPARE_FENCE_LANGUAGE } from "../../../../desktop/src/shared/proofCitation";
import { isChatToolType } from "../../../../desktop/src/shared/sessionSpawnNesting";
import type { TerminalSessionSummary } from "../../../../desktop/src/shared/types/sessions";
import { resolveExecutableFromKnownLocations } from "../../../../desktop/src/main/services/ai/cliExecutableResolver";
import { ffmpegHasEncoder, isProofVideoPath, PROOF_PICTURE_EXTENSIONS } from "../../../../desktop/src/main/services/computerUse/proofPlayableVideo";
import { resolveFfmpegTools, runFfmpeg } from "../../../../desktop/src/main/services/demoVideo/ffmpegDemoEngine";
import { getErrorMessage } from "../../../../desktop/src/main/services/shared/utils";
import type { AdeRuntime } from "../../bootstrap";

const gunzipAsync = promisify(gunzip);

/** How much of a transcript's end is read for its citations. */
const SCAN_BYTES = 16 * 1024 * 1024;
/** The longest side of a saved picture, in pixels. */
const MAX_SIDE_PX = 2000;
const WEBP_QUALITY = "80";
/** JPEG's `-q:v` (2 best … 31 worst): about the same text legibility as WebP 80. */
const JPEG_QSCALE = "4";
/** Where a video's still is taken, in seconds; a shorter video gives its first frame. */
const STILL_AT_SECONDS = "1";
/** The CTO's picture extensions, plus BMP, which ffmpeg converts here. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([...PROOF_PICTURE_EXTENSIONS, ".bmp"]);
/** Pictures the server keeps as they are, when nothing here can convert them. */
const ORIGINAL_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * Every proof id a chat's answers cite, oldest first, the newest
 * `CLOUD_CHAT_PROOF_MAX_PER_CHAT`. Answers stream in pieces, so each
 * message's text is joined before it is read. A transcript that is missing
 * or can't be read cites nothing.
 */
async function chatCitedProofIds(transcriptPath: string, maxBytes: number = SCAN_BYTES): Promise<string[]> {
  const text = await readTranscriptEnd(transcriptPath, maxBytes);
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

/**
 * The transcript's last `maxBytes` as text (`.jsonl`, else `.jsonl.gz`), or
 * null. Off the event loop: a packed transcript inflates to many megabytes.
 */
async function readTranscriptEnd(transcriptPath: string, maxBytes: number): Promise<string | null> {
  try {
    const handle = await fs.promises.open(transcriptPath, "r");
    try {
      const size = (await handle.stat()).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    try {
      const raw = await gunzipAsync(await fs.promises.readFile(`${transcriptPath}.gz`), { maxOutputLength: 8 * maxBytes });
      return raw.subarray(Math.max(0, raw.length - maxBytes)).toString("utf8");
    } catch {
      return null;
    }
  }
}

/**
 * Whether a proof file's first bytes are a picture or a video ffmpeg should
 * open: PNG, JPEG, GIF, WebP, BMP, TIFF or HEIC/HEIF (`ftyp`); MP4/MOV (an
 * ISO box: `ftyp`, `moov`, `mdat`, `wide`, `free`, `skip`, `pnot`, `uuid`),
 * WebM/MKV or AVI, or a picture filed as a recording. ffmpeg picks its input
 * format by content, so a playlist named like a picture would make it read
 * other files or URLs.
 */
async function looksLikeProofMedia(filePath: string, source: CloudChatProofSource): Promise<boolean> {
  const head = Buffer.alloc(16);
  try {
    const handle = await fs.promises.open(filePath, "r");
    try {
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
  const box = head.subarray(4, 8).toString("latin1");
  if (cloudChatProofKindOf(head) != null) return true;
  if (source === "image") {
    const magic = head.subarray(0, 4).toString("latin1");
    return magic.startsWith("BM") || magic === "II*\0" || magic === "MM\0*" || box === "ftyp";
  }
  if (["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot", "uuid"].includes(box)) return true;
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;
  return head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "AVI ";
}

/** A transcript's size and time, which change with every new line; null when it is missing. */
function transcriptMark(transcriptPath: string): string | null {
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
function proofSourceOf(artifact: { kind?: string | null; mimeType?: string | null }, filePath: string): CloudChatProofSource | null {
  const extension = path.extname(filePath).toLowerCase();
  const mime = artifact.mimeType?.toLowerCase() ?? "";
  if (artifact.kind === "video_recording" || mime.startsWith("video/") || isProofVideoPath(filePath)) return "video";
  if (mime === "image/svg+xml" || extension === ".svg") return null;
  if (artifact.kind === "screenshot" || mime.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) return "image";
  return null;
}

export type ProofFfmpeg = { path: string; webp: boolean };

/**
 * The ffmpeg on this computer (the cloud template installs one), or ADE's own
 * copy when it is already here. Never a download: the rest save must not wait
 * on one. Null when there is none.
 */
export async function findProofFfmpeg(): Promise<ProofFfmpeg | null> {
  const binary = resolveExecutableFromKnownLocations("ffmpeg")?.path ?? resolveFfmpegTools()?.ffmpegPath ?? null;
  return binary ? { path: binary, webp: await ffmpegHasEncoder(binary, "libwebp") } : null;
}

export type ProofPicture = { bytes: Buffer; contentType: string; via: "webp" | "jpeg" | "original" };

/** The scale that keeps the picture's shape with neither side past `MAX_SIDE_PX` (and never larger than it was). */
const SCALE = `scale='min(${MAX_SIDE_PX},iw)':'min(${MAX_SIDE_PX},ih)':force_original_aspect_ratio=decrease`;

/** One frame of `input` as WebP or JPEG at `output`; true when ffmpeg made it. */
async function convertFrame(binary: string, input: string, output: string, codec: "webp" | "jpeg", source: CloudChatProofSource, timeoutMs: number): Promise<boolean> {
  const encode = codec === "webp"
    ? ["-vf", SCALE, "-c:v", "libwebp", "-quality", WEBP_QUALITY, "-compression_level", "4", "-f", "webp"]
    : ["-vf", `${SCALE}:force_divisible_by=2`, "-pix_fmt", "yuvj420p", "-c:v", "mjpeg", "-q:v", JPEG_QSCALE, "-f", "image2"];
  const run = (seek: boolean) => runFfmpeg({
    binaryPath: binary,
    args: [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      ...(seek ? ["-ss", STILL_AT_SECONDS] : []),
      "-protocol_whitelist", "file", "-i", input, "-frames:v", "1", "-an", ...encode, output,
    ],
    timeoutMs: Math.max(1_000, timeoutMs),
    logger: null,
    label: "proof picture",
  }).then(() => true, () => false);
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
 * a video with no ffmpeg here, or a picture nothing can make small enough.
 * `"pending"` when it may work next time: the time ran out, or the file
 * could not be read just now.
 */
export async function proofPictureFor(input: { filePath: string; source: CloudChatProofSource; ffmpeg: ProofFfmpeg | null; timeoutMs: number }): Promise<ProofPicture | "pending" | null> {
  const { filePath, source, ffmpeg } = input;
  const startedAt = Date.now();
  const left = () => input.timeoutMs - (Date.now() - startedAt);
  const kept = (bytes: Buffer | null, via: ProofPicture["via"]): ProofPicture | null => {
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > CLOUD_CHAT_PROOF_MAX_BYTES) return null;
    const kind = cloudChatProofKindOf(bytes);
    return kind ? { bytes, contentType: CLOUD_CHAT_PROOF_MIME[kind], via } : null;
  };
  // A conversion that used the time up (ffmpeg's own time-out) or never got to start.
  let ranOut = false;
  if (ffmpeg && await looksLikeProofMedia(filePath, source)) {
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
    ranOut = left() <= 1_000;
  }
  if (source !== "image" || !ORIGINAL_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return ranOut ? "pending" : null;
  try {
    if ((await fs.promises.stat(filePath)).size > CLOUD_CHAT_PROOF_MAX_BYTES) return ranOut ? "pending" : null;
    return kept(await fs.promises.readFile(filePath), "original") ?? (ranOut ? "pending" : null);
  } catch {
    return "pending";
  }
}

/** Leads every proof mark: a change to how proof is made sends each file again once. */
const PROOF_MARK_VERSION = "webp2000q80-1";
/** Proof files one save tries at most (each a conversion and an upload); the rest wait for the next save. */
const PROOF_TRIES_PER_SAVE = 40;
/** A conversion starts only with this much of the save's time left. */
const PROOF_MIN_MS = 3_000;
/** One conversion's longest run. */
const PROOF_CONVERT_MS = 30_000;
/**
 * Server refusals that won't change until the file does (too large, not a
 * picture, the chat full) or until the chat gets a new copy (`copy_not_found`:
 * its copy is gone; a new one has a new generation). Not a plain
 * `not_found`: it also answers a computer the server didn't recognize this
 * time (and an older server's missing copy), so the chat's proof stops for
 * this save and goes again at the next one.
 */
const PROOF_SETTLED_CODES: ReadonlySet<string> = new Set(["proof_too_large", "proof_unsupported", "proof_limit", "copy_not_found"]);

export type ChatProofTasks = {
  /** One task per saved chat with a transcript here, run with the save's other uploads. */
  tasks: Array<() => Promise<void>>;
  /** Filled as the tasks run. */
  counts: { sent: number };
};

/**
 * The rest save's tasks that save the proof each saved chat cites: once per
 * file (by `state.proofs` marks), at most `PROOF_TRIES_PER_SAVE` files a
 * save, and none past the save's `deadline`. A chat's citations are read
 * again only when its transcript changed and every one before was settled
 * (`state.proofScans`). An `account_full` refusal stops the rest of this
 * save's proof. No saved chats, no tasks.
 */
export function buildChatProofTasks(input: {
  runtimes: readonly AdeRuntime[];
  /** Chat id → its saved copy's generation: a new copy holds none of the old one's proof. */
  savedChats: ReadonlyMap<string, number> | null;
  state: { proofs?: Record<string, Record<string, string>>; proofScans?: Record<string, string> };
  api: Pick<CloudApiClient, "putSavedChatProof">;
  machineKey: string;
  instanceId: string;
  deadline: number;
  idle: () => boolean;
  findFfmpeg: () => Promise<ProofFfmpeg | null>;
  logger: { warn: (event: string, meta?: Record<string, unknown>) => void };
}): ChatProofTasks {
  const { runtimes, savedChats, state, api, machineKey, instanceId, deadline, idle, logger } = input;
  const result: ChatProofTasks = { tasks: [], counts: { sent: 0 } };
  if (!savedChats?.size) return result;
  const proofs = (state.proofs ??= {});
  const proofScans = (state.proofScans ??= {});
  let tries = 0;
  // Set once the account is full: no more proof this save, and none marked sent.
  let accountFull = false;
  let ffmpeg: Promise<ProofFfmpeg | null> | null = null;
  const tools = () => (ffmpeg ??= input.findFfmpeg().catch(() => null));

  type Broker = NonNullable<AdeRuntime["computerUseArtifactBrokerService"]>;
  /** One chat's cited proof; true when every citation is settled. */
  const saveChat = async (broker: Broker, chatId: string, generation: number, cited: string[], sent: Record<string, string>): Promise<boolean> => {
    let complete = true;
    for (const artifactId of cited) {
      if (!idle() || accountFull || tries >= PROOF_TRIES_PER_SAVE || deadline - Date.now() < PROOF_MIN_MS) return false;
      const artifact = broker.listArtifacts({ artifactId, limit: 1 })[0] ?? null;
      const filePath = artifact ? broker.resolveArtifactFilePath(artifact) : null;
      let stat: fs.Stats | null = null;
      try {
        stat = filePath ? fs.statSync(filePath) : null;
      } catch {
        stat = null;
      }
      const mark = `${PROOF_MARK_VERSION}|g${generation}|${stat ? `${stat.size}|${Math.floor(stat.mtimeMs)}` : "none"}`;
      if (sent[artifactId] === mark) continue;
      const source = artifact && filePath && stat?.isFile() ? proofSourceOf(artifact, filePath) : null;
      // No file here (a link, another computer's proof, deleted) or not a picture or video: nothing to save until it changes.
      if (!source || !filePath) {
        sent[artifactId] = mark;
        continue;
      }
      tries += 1;
      const picture = await proofPictureFor({ filePath, source, ffmpeg: await tools(), timeoutMs: Math.min(PROOF_CONVERT_MS, deadline - Date.now()) });
      // Out of time or a read that failed just now: tried again at the next save.
      if (picture === "pending") {
        complete = false;
        continue;
      }
      if (!picture) {
        sent[artifactId] = mark;
        continue;
      }
      if (!idle() || Date.now() >= deadline) return false;
      try {
        await api.putSavedChatProof(machineKey, chatId, artifactId, instanceId, picture.bytes, {
          source,
          contentType: picture.contentType,
          timeoutMs: deadline - Date.now(),
        });
        sent[artifactId] = mark;
        result.counts.sent += 1;
      } catch (error) {
        const code = error instanceof CloudApiError ? error.code : null;
        logger.warn("cloud.rest_proof_failed", { sessionId: chatId, artifactId, status: error instanceof CloudApiError ? error.status : null, code });
        if (code === "account_full") {
          accountFull = true;
          return false;
        }
        // One conversion, not one per cited file: the rest of the chat waits for the next save.
        if (code === "not_found") return false;
        if (code && PROOF_SETTLED_CODES.has(code)) {
          sent[artifactId] = mark;
          // The chat holds all the proof it may: none more of it this save.
          if (code === "proof_limit") return complete;
          continue;
        }
        // Tried again at the next save; the chat's other proof still goes now.
        complete = false;
      }
    }
    return complete;
  };

  for (const runtime of runtimes) {
    const broker = runtime.computerUseArtifactBrokerService;
    if (!broker) continue;
    let rows: TerminalSessionSummary[] = [];
    try {
      rows = runtime.sessionService.list({ limit: 200, includeArchived: false });
    } catch (error) {
      logger.warn("cloud.rest_save_sessions_read_failed", { error: getErrorMessage(error) });
    }
    for (const row of rows) {
      const generation = savedChats.get(row.id);
      if (!isChatToolType(row.toolType) || generation === undefined) continue;
      result.tasks.push(async () => {
        if (!idle() || accountFull) return;
        try {
          const transcriptPath = path.join(runtime.paths.chatTranscriptsDir, `${row.id}.jsonl`);
          const transcript = transcriptMark(transcriptPath);
          // A new saved copy is read again even with no new line: its proof went with the old copy.
          const scanMark = transcript ? `g${generation}|${transcript}` : null;
          if (!scanMark || proofScans[row.id] === scanMark) return;
          const sent = (proofs[row.id] ??= {});
          if (await saveChat(broker, row.id, generation, await chatCitedProofIds(transcriptPath), sent)) proofScans[row.id] = scanMark;
        } catch (error) {
          logger.warn("cloud.rest_save_proof_failed", { sessionId: row.id, error: getErrorMessage(error) });
        }
      });
    }
  }
  return result;
}
