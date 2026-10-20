import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sniffImageMimeType } from "../../../shared/imageSniff";
import { isHeicAttachment, type HeicConversionErrorCode } from "../../../shared/types/chat";
import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  legacyAttachmentCapMessage,
} from "../../../shared/chatAttachmentLimits";
import type { Logger } from "../logging/logger";

const execFileAsync = promisify(execFile);
// Converted image bytes arrive in a command payload and are decoded in memory,
// so they carry the legacy ceiling rather than the 50 MB file one.
const MAX_CONVERSION_BYTES = LEGACY_MAX_CHAT_ATTACHMENT_BYTES;
const SIPS_TIMEOUT_MS = 30_000;
const TIFF_MIME_RE = /^image\/tiff(?:;|$)/i;
const TIFF_EXTENSION_RE = /\.tiff?$/i;

type RunSips = (inputPath: string, outputPath: string) => Promise<void>;

/**
 * The format `sips` has to decode before a browser can draw this image, or
 * null when Chromium draws it itself.
 */
function jpegConversionFormat(filename: string, mimeType: string | null | undefined): "tiff" | "heic" | null {
  if (TIFF_EXTENSION_RE.test(filename) || TIFF_MIME_RE.test(mimeType ?? "")) return "tiff";
  return isHeicAttachment(filename, mimeType) ? "heic" : null;
}

/** A converted image and its staged JPEG name. */
export type ImageAttachmentConversionResult = {
  data: Buffer;
  filename: string;
  mimeType: "image/jpeg";
};

/** Platform and temp-file overrides for conversion. */
export type ImageAttachmentConverterOptions = {
  platform?: NodeJS.Platform;
  tempRoot?: string;
  runSips?: RunSips;
  /** Receives the decoder's own error when a conversion fails. */
  logger?: Pick<Logger, "warn">;
};

/** A user-presentable conversion failure code. */
export class ImageAttachmentConversionError extends Error {
  constructor(readonly code: HeicConversionErrorCode) {
    super(code);
    this.name = "ImageAttachmentConversionError";
  }
}

async function runSips(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync(
    "/usr/bin/sips",
    [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "90",
      inputPath,
      "--out",
      outputPath,
    ],
    {
      timeout: SIPS_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
}

function safeAttachmentName(filename: string): string {
  const basename = filename.split(/[\\/]/).pop()?.trim();
  return basename && basename !== "." && basename !== ".."
    ? basename.replace(/[\u0000-\u001f\u007f]/g, "_")
    : "photo.heic";
}

function jpegFilenameFor(filename: string): string {
  const basename = safeAttachmentName(filename);
  const stem = basename.replace(/\.(heic|heif|tif|tiff)$/i, "").trim() || "photo";
  return `${stem}.jpg`;
}

function looksLikeJpeg(data: Buffer): boolean {
  return data.length >= 3 && data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF;
}

/**
 * Convert a HEIC/HEIF or TIFF upload into a JPEG preview or provider image.
 *
 * macOS's bundled `sips` is intentionally the only decoder used here. Other
 * platforms report conversion as unavailable instead of pretending the bytes
 * are a PNG or JPEG. The caller can keep the normal attachment pipeline for
 * the returned JPEG, including remote-machine chats.
 */
export async function convertImageBufferToJpeg(
  content: Buffer,
  filename: string,
  mimeType?: string | null,
  options: ImageAttachmentConverterOptions = {},
): Promise<ImageAttachmentConversionResult> {
  const format = jpegConversionFormat(filename, mimeType);
  if (!format) {
    throw new ImageAttachmentConversionError("failed");
  }
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new ImageAttachmentConversionError("unavailable");
  }
  if (content.byteLength > MAX_CONVERSION_BYTES) {
    throw new Error(legacyAttachmentCapMessage("Temporary attachments"));
  }

  const tempDir = await fs.promises.mkdtemp(
    path.join(options.tempRoot ?? os.tmpdir(), "ade-image-conversion-"),
  );
  // Keep the decoder input name fixed so a malicious or unusual renderer
  // filename can never escape the temporary directory or collide with the
  // output path. The original name is only used for the returned JPEG name.
  const inputName = `source.${format}`;
  const inputPath = path.join(tempDir, inputName);
  const outputPath = path.join(tempDir, "converted.jpg");

  try {
    await fs.promises.writeFile(inputPath, content);
    await (options.runSips ?? runSips)(inputPath, outputPath);
    const converted = await fs.promises.readFile(outputPath);
    if (!converted.byteLength || converted.byteLength > MAX_CONVERSION_BYTES || !looksLikeJpeg(converted)) {
      throw new Error("Converted output is not a valid JPEG.");
    }
    return {
      data: converted,
      filename: jpegFilenameFor(filename),
      mimeType: "image/jpeg",
    };
  } catch (error) {
    options.logger?.warn("chat.image_conversion_failed", {
      format,
      bytes: content.byteLength,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ImageAttachmentConversionError("failed");
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * The data URL a chat or file preview shows for image bytes whose type was
 * sniffed. TIFF and HEIC/HEIF become JPEG first on a host that can decode them,
 * since no Chromium renderer can draw them. A host without a decoder hands the
 * original bytes on: iOS draws them natively, and a desktop thumbnail falls back
 * to its file chip when the picture does not load. A real conversion failure
 * becomes a message a person can read.
 */
export async function imageBytesToDataUrl(
  data: Buffer,
  filename: string,
  mimeType: string,
  options: ImageAttachmentConverterOptions = {},
): Promise<{ dataUrl: string; mimeType: string }> {
  const raw = { dataUrl: `data:${mimeType};base64,${data.toString("base64")}`, mimeType };
  // Decide on the sniffed type alone: a PNG named `.tiff` is still a PNG.
  if (!jpegConversionFormat("", mimeType)) return raw;
  try {
    const converted = await convertImageBufferToJpeg(data, filename, mimeType, options);
    return {
      dataUrl: `data:${converted.mimeType};base64,${converted.data.toString("base64")}`,
      mimeType: converted.mimeType,
    };
  } catch (error) {
    if (error instanceof ImageAttachmentConversionError) {
      if (error.code === "unavailable") return raw;
      throw new Error("Couldn't convert this image for preview.");
    }
    throw error;
  }
}

/**
 * Read an image file after a stat-based size check and sniff its type from the
 * bytes, so a caller can never hand back arbitrary text or binary labelled as an
 * image. Throws when the path is not a regular file, is over the cap, or does
 * not look like a supported image.
 */
export async function readImageFile(
  filePath: string,
  maxBytes: number = MAX_CONVERSION_BYTES,
): Promise<{ data: Buffer; mimeType: string }> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("Path is not a file.");
  if (stat.size > maxBytes) throw new Error(legacyAttachmentCapMessage("Image"));
  const data = await fs.promises.readFile(filePath);
  const mimeType = sniffImageMimeType(data);
  if (!mimeType) throw new Error("Path is not an image.");
  return { data, mimeType };
}

/** Read an image file as the data URL a chat thumbnail shows. */
export async function readImageFileAsDataUrl(
  filePath: string,
  options: ImageAttachmentConverterOptions = {},
): Promise<{ dataUrl: string; mimeType: string }> {
  const { data, mimeType } = await readImageFile(filePath);
  return imageBytesToDataUrl(data, path.basename(filePath), mimeType, options);
}
