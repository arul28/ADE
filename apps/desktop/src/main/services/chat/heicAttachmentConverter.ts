import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  isHeicAttachment,
  type HeicConversionErrorCode,
} from "../../../shared/types/chat";
import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  legacyAttachmentCapMessage,
} from "../../../shared/chatAttachmentLimits";

const execFileAsync = promisify(execFile);
// A HEIC arrives as base64 in a command payload and is decoded in memory, so it
// carries the legacy ceiling rather than the 50 MB file one.
const MAX_HEIC_BYTES = LEGACY_MAX_CHAT_ATTACHMENT_BYTES;
const SIPS_TIMEOUT_MS = 30_000;

type RunSips = (inputPath: string, outputPath: string) => Promise<void>;

export type HeicAttachmentConversionResult = {
  data: Buffer;
  filename: string;
  mimeType: "image/jpeg";
};

export type HeicAttachmentConverterOptions = {
  platform?: NodeJS.Platform;
  tempRoot?: string;
  runSips?: RunSips;
};

export class HeicAttachmentConversionError extends Error {
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
  const stem = basename.replace(/\.(heic|heif)$/i, "").trim() || "photo";
  return `${stem}.jpg`;
}

function looksLikeJpeg(data: Buffer): boolean {
  return data.length >= 3 && data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF;
}

/**
 * Convert a HEIC/HEIF upload into a provider-safe JPEG.
 *
 * macOS's bundled `sips` is intentionally the only decoder used here. ADE's
 * Windows/Linux builds do not ship a HEIF codec, so those platforms fail with
 * a user-facing conversion instruction instead of pretending the bytes are a
 * PNG or JPEG. The caller can then keep the existing attachment pipeline for
 * the returned JPEG, including remote-machine chats.
 */
export async function convertHeicBufferToJpeg(
  content: Buffer,
  filename: string,
  mimeType?: string | null,
  options: HeicAttachmentConverterOptions = {},
): Promise<HeicAttachmentConversionResult> {
  if (!isHeicAttachment(filename, mimeType)) {
    throw new Error("HEIC conversion requires a .heic or .heif image.");
  }
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new HeicAttachmentConversionError("unavailable");
  }
  if (content.byteLength > MAX_HEIC_BYTES) {
    throw new Error(legacyAttachmentCapMessage("Temporary attachments"));
  }

  const tempDir = await fs.promises.mkdtemp(
    path.join(options.tempRoot ?? os.tmpdir(), "ade-heic-"),
  );
  // Keep the decoder input name fixed so a malicious or unusual renderer
  // filename can never escape the temporary directory or collide with the
  // output path. The original name is only used for the returned JPEG name.
  const inputPath = path.join(tempDir, "source.heic");
  const outputPath = path.join(tempDir, "converted.jpg");

  try {
    await fs.promises.writeFile(inputPath, content);
    await (options.runSips ?? runSips)(inputPath, outputPath);
    const converted = await fs.promises.readFile(outputPath);
    if (!converted.byteLength || converted.byteLength > MAX_HEIC_BYTES || !looksLikeJpeg(converted)) {
      throw new Error("Converted output is not a valid JPEG.");
    }
    return {
      data: converted,
      filename: jpegFilenameFor(filename),
      mimeType: "image/jpeg",
    };
  } catch {
    throw new HeicAttachmentConversionError("failed");
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
