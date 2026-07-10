import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function sniffImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47
    && buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return "image/jpeg";
  if (buffer.length >= 6
    && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38
    && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) return "image/gif";
  if (buffer.length >= 12
    && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return "image/webp";
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4D) return "image/bmp";
  if (buffer.length >= 4
    && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return "image/x-icon";
  const head = buffer.slice(0, Math.min(buffer.length, 1024)).toString("utf8");
  const stripped = head.replace(/^﻿/, "").trimStart();
  if ((/^<\?xml\b/i.test(stripped) && /<svg\b/i.test(head)) || /^<svg\b/i.test(stripped)) {
    return "image/svg+xml";
  }
  return null;
}

export async function readImageFileAndSniffMime(filePath: string): Promise<{ data: Buffer; mimeType: string }> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("Path is not a file.");
  if (stat.size > MAX_IMAGE_BYTES) throw new Error("Image must be 10 MB or smaller.");
  const data = await fs.promises.readFile(filePath);
  const mimeType = sniffImageMimeType(data);
  if (!mimeType) throw new Error("Path is not an image.");
  return { data, mimeType };
}

function normalizeImageMime(mime: unknown, filename: string): string {
  const raw = typeof mime === "string" ? mime.trim().toLowerCase() : "";
  const fromExtension = IMAGE_MIME_BY_EXTENSION[path.extname(filename).toLowerCase()];
  const normalized = raw || fromExtension || "";
  if (!Object.values(IMAGE_MIME_BY_EXTENSION).includes(normalized)) {
    throw new Error("Temporary attachment mime must be a supported image type.");
  }
  return normalized;
}

function decodeBase64ImagePayload(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error("Temporary attachment base64 is invalid.");
  }
  const maxEncodedLength = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
  if (compact.length > maxEncodedLength) throw new Error("Temporary attachments must be 10 MB or smaller.");
  const content = Buffer.from(compact, "base64");
  if (content.byteLength > MAX_IMAGE_BYTES) throw new Error("Temporary attachments must be 10 MB or smaller.");
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
    if (content.byteLength > MAX_IMAGE_BYTES) throw new Error("Temporary attachments must be 10 MB or smaller.");
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
  await fs.promises.mkdir(baseDir, { recursive: true });
  const ext = path.extname(filename) || Object.entries(IMAGE_MIME_BY_EXTENSION)
    .find(([, entryMime]) => entryMime === mimeType)?.[0] || ".png";
  const destPath = path.join(baseDir, `${randomUUID()}${ext}`);
  await fs.promises.writeFile(destPath, content);
  return { path: destPath, mimeType, previewDataUrl: null };
}
