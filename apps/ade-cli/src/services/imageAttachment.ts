import fs from "node:fs";
import path from "node:path";
import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  legacyAttachmentCapMessage,
  maxBase64EncodedLength,
} from "../../../desktop/src/shared/chatAttachmentLimits";
import {
  resolveStagedAttachmentExtension,
  stagedAttachmentDestPath,
} from "../../../desktop/src/shared/chatAttachmentStagingFs";
import { sniffImageMimeType } from "../../../desktop/src/shared/imageSniff";
import { IMAGE_ATTACHMENT_MEDIA_TYPES } from "../../../desktop/src/shared/types/chat";
import { imageBytesToDataUrl } from "../../../desktop/src/main/services/chat/imageAttachmentConverter";
import type { Logger } from "../../../desktop/src/main/services/logging/logger";

// The base64/in-memory ceiling, single-sourced so the constant and every
// rejection message that renders it stay in step.
const MAX_IMAGE_BYTES = LEGACY_MAX_CHAT_ATTACHMENT_BYTES;

/**
 * Read an image file as the data URL a chat thumbnail shows. The type comes
 * from the bytes, and TIFF or HEIC is converted to JPEG on the way, since no
 * client can draw those formats.
 */
export async function readImageFileAsDataUrl(
  filePath: string,
  logger?: Pick<Logger, "warn">,
): Promise<{ dataUrl: string; mimeType: string }> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("Path is not a file.");
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(legacyAttachmentCapMessage("Image"));
  const data = await fs.promises.readFile(filePath);
  const mimeType = sniffImageMimeType(data);
  if (!mimeType) throw new Error("Path is not an image.");
  return imageBytesToDataUrl(data, path.basename(filePath), mimeType, { logger });
}

function normalizeImageMime(mime: unknown, filename: string): string {
  const raw = typeof mime === "string" ? mime.trim().toLowerCase() : "";
  const fromExtension = IMAGE_ATTACHMENT_MEDIA_TYPES[path.extname(filename).toLowerCase()];
  const normalized = raw || fromExtension || "";
  if (!Object.values(IMAGE_ATTACHMENT_MEDIA_TYPES).includes(normalized)) {
    throw new Error("Temporary attachment mime must be a supported image type.");
  }
  return normalized;
}

function decodeBase64ImagePayload(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error("Temporary attachment base64 is invalid.");
  }
  const maxEncodedLength = maxBase64EncodedLength(MAX_IMAGE_BYTES);
  if (compact.length > maxEncodedLength) throw new Error(legacyAttachmentCapMessage("Temporary attachments"));
  const content = Buffer.from(compact, "base64");
  if (content.byteLength > MAX_IMAGE_BYTES) throw new Error(legacyAttachmentCapMessage("Temporary attachments"));
  return content;
}

function parseTempAttachmentPayload(payload: Record<string, unknown>) {
  const dataUrl = typeof payload.dataUrl === "string" ? payload.dataUrl.trim() : "";
  const filename = typeof payload.filename === "string" && payload.filename.trim()
    ? payload.filename.trim()
    : "attachment.png";
  if (dataUrl) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
    if (!match) throw new Error("Temporary attachment dataUrl is invalid.");
    const mimeType = normalizeImageMime(match[1], filename);
    const content = match[2] === ";base64"
      ? decodeBase64ImagePayload(match[3] ?? "")
      : Buffer.from(decodeURIComponent(match[3] ?? ""), "utf8");
    if (content.byteLength > MAX_IMAGE_BYTES) throw new Error(legacyAttachmentCapMessage("Temporary attachments"));
    if (sniffImageMimeType(content) !== mimeType) throw new Error("Temporary attachment MIME type does not match payload.");
    return { content, filename, mimeType };
  }
  const base64 = typeof payload.base64 === "string"
    ? payload.base64
    : typeof payload.data === "string" ? payload.data : "";
  const mimeType = normalizeImageMime(payload.mime ?? payload.mimeType, filename);
  const content = decodeBase64ImagePayload(base64);
  if (sniffImageMimeType(content) !== mimeType) throw new Error("Temporary attachment MIME type does not match payload.");
  return { content, filename, mimeType };
}

export async function saveImageTempAttachment(
  baseDir: string,
  payload: Record<string, unknown>,
): Promise<{ path: string; mimeType: string; previewDataUrl: string | null }> {
  const { content, filename, mimeType } = parseTempAttachmentPayload(payload);
  const attachmentsDir = path.resolve(baseDir);
  await fs.promises.mkdir(attachmentsDir, { recursive: true });
  // The display name is remote-controlled on this path (`chat.saveTempAttachment`
  // over sync), and unlike the generic byte-staging helper this route has
  // already sniffed the bytes and verified them against a declared image MIME.
  // So the bytes name the file, not the caller: a real PNG called `run.cmd`
  // stages as `.png`. The caller's extension is honoured only where the table
  // agrees it names this exact MIME, which is what keeps a `.jpg` from being
  // rewritten to the table's first `image/jpeg` entry.
  const namedExtension = resolveStagedAttachmentExtension(filename, null);
  const ext = namedExtension && IMAGE_ATTACHMENT_MEDIA_TYPES[namedExtension] === mimeType
    ? namedExtension
    : Object.entries(IMAGE_ATTACHMENT_MEDIA_TYPES)
      .find(([, entryMime]) => entryMime === mimeType)?.[0] || ".png";
  const destPath = stagedAttachmentDestPath(attachmentsDir, ext);
  await fs.promises.writeFile(destPath, content);
  return { path: destPath, mimeType, previewDataUrl: null };
}
