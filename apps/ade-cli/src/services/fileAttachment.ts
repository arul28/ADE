import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  attachmentTooLargeMessage,
} from "../../../desktop/src/shared/chatAttachmentLimits";
import {
  projectAttachmentsDir,
  resolveStagedAttachmentExtension,
  stagedAttachmentDestPath,
} from "../../../desktop/src/shared/chatAttachmentStagingFs";

/**
 * Chunked, transport-agnostic staging for *file-shaped* chat attachments
 * (documents, videos, anything that is not an image).
 *
 * Why not the existing routes:
 * - `chat.saveTempAttachment` is base64 in one payload AND image-only: it
 *   sniffs the bytes and rejects anything outside `IMAGE_MIME_BY_EXTENSION`,
 *   and it is capped at `LEGACY_MAX_CHAT_ATTACHMENT_BYTES` (10 MB) because the
 *   whole body is buffered as a string on both ends.
 * - `chat.createAttachmentUpload` streams over HTTP at the product ceiling
 *   (50 MB), but it needs a *direct* HTTP leg to the host's sync listener. A
 *   phone on the cloud relay has a WebSocket and nothing else, so that route is
 *   unreachable for exactly the clients that most need it.
 *
 * So: the same 50 MB product ceiling, reached in bounded base64 chunks over the
 * command channel that every client already has. Each chunk is its own command
 * payload well under the transport's 25 MB cap, the running total is enforced
 * server-side (a client cannot talk its way past it by lying about size), and
 * bytes land in a `.part` file that is renamed only after `finish` — so a torn
 * upload never leaves a half file at the final path.
 *
 * Sessions are held in memory, pruned on every call, TTL-bounded and
 * count-bounded. Nothing here survives a host restart, which is correct: an
 * unfinished upload has no value after one.
 */

/** Raw bytes per chunk. ~683 KiB once base64-inflated, far under the wire cap. */
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;
/** A staging session with no activity for this long is abandoned. */
export const ATTACHMENT_UPLOAD_SESSION_TTL_MS = 300_000;
/** Ceiling on concurrent staging sessions per host, oldest-first eviction. */
const MAX_PENDING_SESSIONS = 16;

/**
 * Extension → MIME for the file kinds a client can preview in-thread. Anything
 * else stages fine and reports `application/octet-stream`; the agent receives a
 * path either way, so an unknown type is not an error.
 */
const FILE_MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".rtf": "application/rtf",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
};

export function attachmentMimeTypeForPath(filePath: string): string {
  return FILE_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

type PendingUpload = {
  uploadId: string;
  partPath: string;
  destPath: string;
  filename: string;
  received: number;
  touchedAtMs: number;
};

export type AttachmentUploadBeginResult = {
  uploadId: string;
  chunkBytes: number;
  maxBytes: number;
};

export type AttachmentUploadAppendResult = { uploadId: string; receivedBytes: number };

export type AttachmentUploadFinishResult = { path: string; mimeType: string; byteLength: number };

export type AttachmentChunkResult = {
  base64: string;
  offset: number;
  byteLength: number;
  totalBytes: number;
  mimeType: string;
  eof: boolean;
};

export type ChunkedAttachmentStagingRegistry = {
  begin(args: { projectRoot: string; filename: unknown; totalBytes?: unknown }): AttachmentUploadBeginResult;
  append(args: { uploadId: unknown; base64: unknown }): Promise<AttachmentUploadAppendResult>;
  finish(args: { uploadId: unknown }): Promise<AttachmentUploadFinishResult>;
  abort(args: { uploadId: unknown }): Promise<{ aborted: boolean }>;
  pendingCount(): number;
};

function requireString(value: unknown, message: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error(message);
  return raw;
}

async function unlinkQuietly(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // An aborted session may never have written a byte.
  }
}

function decodeChunk(base64: unknown): Buffer {
  const raw = typeof base64 === "string" ? base64.replace(/\s+/g, "") : "";
  if (!raw) throw new Error("Attachment chunk is empty.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 === 1) {
    throw new Error("Attachment chunk base64 is invalid.");
  }
  // Reject on the encoded length before allocating, so an oversized frame never
  // becomes a buffer first.
  if (raw.length > Math.ceil((ATTACHMENT_CHUNK_BYTES * 2) / 3) * 4) {
    throw new Error("Attachment chunk is too large.");
  }
  const buffer = Buffer.from(raw, "base64");
  if (buffer.byteLength > ATTACHMENT_CHUNK_BYTES * 2) {
    throw new Error("Attachment chunk is too large.");
  }
  return buffer;
}

export function createChunkedAttachmentStagingRegistry(options?: {
  now?: () => number;
  ttlMs?: number;
  maxBytes?: number;
}): ChunkedAttachmentStagingRegistry {
  const now = options?.now ?? Date.now;
  const ttlMs = Math.max(1_000, options?.ttlMs ?? ATTACHMENT_UPLOAD_SESSION_TTL_MS);
  const maxBytes = Math.max(1, options?.maxBytes ?? MAX_CHAT_ATTACHMENT_BYTES);
  const pending = new Map<string, PendingUpload>();

  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of pending) {
      if (entry.touchedAtMs <= cutoff) {
        pending.delete(key);
        void unlinkQuietly(entry.partPath);
      }
    }
    while (pending.size > MAX_PENDING_SESSIONS) {
      const oldestKey = [...pending.entries()].sort((a, b) => a[1].touchedAtMs - b[1].touchedAtMs)[0]?.[0];
      if (!oldestKey) break;
      const evicted = pending.get(oldestKey);
      pending.delete(oldestKey);
      if (evicted) void unlinkQuietly(evicted.partPath);
    }
  };

  const require_ = (uploadId: unknown): PendingUpload => {
    const id = requireString(uploadId, "Missing attachment upload id.");
    const entry = pending.get(id);
    if (!entry) throw new Error("This attachment upload expired. Attach the file again.");
    return entry;
  };

  return {
    begin({ projectRoot, filename, totalBytes }): AttachmentUploadBeginResult {
      const root = requireString(projectRoot, "Attachment upload requires a project root.");
      const name = typeof filename === "string" && filename.trim() ? filename.trim() : "attachment";
      if (typeof totalBytes === "number" && Number.isFinite(totalBytes) && totalBytes > maxBytes) {
        throw new Error(attachmentTooLargeMessage(name, totalBytes, maxBytes));
      }
      prune();
      const attachmentsDir = path.resolve(projectAttachmentsDir(root));
      // Same UUID-basename rule as every other staging path: the client's name
      // contributes a validated extension and nothing else.
      const destPath = stagedAttachmentDestPath(
        attachmentsDir,
        resolveStagedAttachmentExtension(name, null),
      );
      const uploadId = randomUUID();
      pending.set(uploadId, {
        uploadId,
        partPath: `${destPath}.part`,
        destPath,
        filename: name,
        received: 0,
        touchedAtMs: now(),
      });
      return { uploadId, chunkBytes: ATTACHMENT_CHUNK_BYTES, maxBytes };
    },

    async append({ uploadId, base64 }): Promise<AttachmentUploadAppendResult> {
      prune();
      const entry = require_(uploadId);
      const chunk = decodeChunk(base64);
      if (entry.received + chunk.byteLength > maxBytes) {
        pending.delete(entry.uploadId);
        await unlinkQuietly(entry.partPath);
        throw new Error(
          attachmentTooLargeMessage(entry.filename, entry.received + chunk.byteLength, maxBytes),
        );
      }
      await fs.promises.mkdir(path.dirname(entry.partPath), { recursive: true });
      await fs.promises.appendFile(entry.partPath, chunk);
      entry.received += chunk.byteLength;
      entry.touchedAtMs = now();
      return { uploadId: entry.uploadId, receivedBytes: entry.received };
    },

    async finish({ uploadId }): Promise<AttachmentUploadFinishResult> {
      const entry = require_(uploadId);
      pending.delete(entry.uploadId);
      if (entry.received <= 0) {
        await unlinkQuietly(entry.partPath);
        throw new Error("This attachment was empty.");
      }
      try {
        await fs.promises.rename(entry.partPath, entry.destPath);
      } catch (error) {
        await unlinkQuietly(entry.partPath);
        throw error instanceof Error ? error : new Error("Unable to store the attachment.");
      }
      return {
        path: entry.destPath,
        mimeType: attachmentMimeTypeForPath(entry.destPath),
        byteLength: entry.received,
      };
    },

    async abort({ uploadId }): Promise<{ aborted: boolean }> {
      const id = typeof uploadId === "string" ? uploadId.trim() : "";
      const entry = id ? pending.get(id) : undefined;
      if (!entry) return { aborted: false };
      pending.delete(id);
      await unlinkQuietly(entry.partPath);
      return { aborted: true };
    },

    pendingCount(): number {
      return pending.size;
    },
  };
}

/**
 * Read one bounded slice of a staged attachment, so a client can pull a PDF or
 * a video back for preview without a 50 MB payload. The mirror of
 * {@link createChunkedAttachmentStagingRegistry}: same chunk size, same
 * "the server owns the bound" rule.
 *
 * Unlike `chat.getImageDataUrl` this does not sniff for an image MIME — that is
 * the whole point — so the caller must have already constrained `filePath` to
 * the project root.
 */
export async function readAttachmentChunk(
  filePath: string,
  rawOffset: unknown,
  rawLength: unknown,
): Promise<AttachmentChunkResult> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("Path is not a file.");
  if (stat.size > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error(attachmentTooLargeMessage(path.basename(filePath), stat.size, MAX_CHAT_ATTACHMENT_BYTES));
  }
  const offset = typeof rawOffset === "number" && Number.isFinite(rawOffset) && rawOffset > 0
    ? Math.min(Math.floor(rawOffset), stat.size)
    : 0;
  const requested = typeof rawLength === "number" && Number.isFinite(rawLength) && rawLength > 0
    ? Math.floor(rawLength)
    : ATTACHMENT_CHUNK_BYTES;
  const length = Math.max(0, Math.min(requested, ATTACHMENT_CHUNK_BYTES, stat.size - offset));
  const buffer = Buffer.alloc(length);
  if (length > 0) {
    const handle = await fs.promises.open(filePath, "r");
    try {
      await handle.read(buffer, 0, length, offset);
    } finally {
      await handle.close();
    }
  }
  return {
    base64: buffer.toString("base64"),
    offset,
    byteLength: length,
    totalBytes: stat.size,
    mimeType: attachmentMimeTypeForPath(filePath),
    eof: offset + length >= stat.size,
  };
}
