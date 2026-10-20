import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { HeicConversionErrorCode } from "../../../shared/types/chat";
import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  legacyAttachmentCapMessage,
} from "../../../shared/chatAttachmentLimits";

const execFileAsync = promisify(execFile);
// Converted image bytes arrive in a command payload and are decoded in memory,
// so they carry the legacy ceiling rather than the 50 MB file one.
const MAX_CONVERSION_BYTES = LEGACY_MAX_CHAT_ATTACHMENT_BYTES;
const SIPS_TIMEOUT_MS = 30_000;

type RunSips = (inputPath: string, outputPath: string) => Promise<void>;

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
};

/** A user-presentable conversion failure code. */
export class ImageAttachmentConversionError extends Error {
  constructor(readonly code: HeicConversionErrorCode) {
    super(code);
    this.name = "HeicAttachmentConversionError";
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
  const extension = path.extname(filename).toLowerCase();
  const normalizedMime = mimeType?.trim().toLowerCase();
  const isHeic = [".heic", ".heif"].includes(extension)
    || normalizedMime === "image/heic"
    || normalizedMime === "image/heif";
  const isTiff = [".tif", ".tiff"].includes(extension) || normalizedMime === "image/tiff";
  if (!isHeic && !isTiff) {
    throw new Error("Image conversion requires a HEIC, HEIF, or TIFF image.");
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
  const inputName = isTiff ? "source.tiff" : "source.heic";
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
  } catch {
    throw new ImageAttachmentConversionError("failed");
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

/** Backward-compatible name for existing HEIC attachment callers. */
export const convertHeicBufferToJpeg = convertImageBufferToJpeg;
export {
  ImageAttachmentConversionError as HeicAttachmentConversionError,
};
export type HeicAttachmentConversionResult = ImageAttachmentConversionResult;
export type HeicAttachmentConverterOptions = ImageAttachmentConverterOptions;
