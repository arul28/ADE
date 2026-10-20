import path from "node:path";
import { getImageAttachmentMediaType } from "../../../shared/types/chat";
import { sniffImageMimeType } from "../../../shared/imageSniff";
import { MAX_CHAT_ATTACHMENT_BYTES } from "../../../shared/chatAttachmentLimits";
import { readFileWithinRootSecure } from "../shared/utils";
import { imageAttachmentReferenceText, imageNotInlinedText } from "./attachmentInlineGuard";
import {
  fitImageForProviderInline,
  isProviderImageByteMediaType,
  normalizeImageMediaType,
} from "./providerInlineImage";

export type WorkerPathImageSource = {
  path: string;
  resolvedPath?: string;
  rootPath: string;
};

export type WorkerIpcImage =
  | { path: string; mimeType: string; rootPath: string }
  | { data: string; mimeType: string }
  | { url: string };

export type WorkerMaterializedImage =
  | { data: string; mimeType: string }
  | { url: string };

/**
 * Path-only worker-IPC images. Never inline bytes — stuffing screenshot
 * base64 through `child.send` JSON can fill the pipe and stall the turn.
 * Remote URLs are a Cursor-only send shape and stay at that call site;
 * Pi and Droid turn image URLs into prompt text instead.
 */
export function workerPathImagesFromAttachments(
  attachments: readonly WorkerPathImageSource[],
): Array<{ path: string; mimeType: string; rootPath: string }> {
  const images: Array<{ path: string; mimeType: string; rootPath: string }> = [];
  for (const attachment of attachments) {
    const filePath = attachment.resolvedPath?.trim() || attachment.path.trim();
    const rootPath = attachment.rootPath.trim();
    if (!filePath || !rootPath) continue;
    images.push({
      path: filePath,
      rootPath,
      // Empty when the name gives no type: the worker sniffs the bytes.
      mimeType: getImageAttachmentMediaType(filePath) ?? "",
    });
  }
  return images;
}

/**
 * Materializes worker images for the provider. An image that cannot be fitted
 * to the provider limits is left out and returned as a prompt-ready hint in
 * `omittedHints`, so the send does not fail and the caller can append the hint
 * (see `withOmittedImageHints`) for the agent to read the file itself.
 *
 * `maxBytes` caps the file read; it defaults to the attachment cap, because
 * `fitImageForProviderInline` shrinks whatever is read to the provider limits.
 */
export async function materializeWorkerImages(
  images: readonly WorkerIpcImage[] | undefined,
  options?: {
    maxBytes?: number;
    label?: string;
  },
): Promise<{ images: WorkerMaterializedImage[]; omittedHints: string[] }> {
  if (!images?.length) return { images: [], omittedHints: [] };
  const maxBytes = options?.maxBytes ?? MAX_CHAT_ATTACHMENT_BYTES;
  const label = options?.label ?? "Chat worker";
  const out: WorkerMaterializedImage[] = [];
  const omittedHints: string[] = [];
  for (const image of images) {
    const materialized = await materializeOneWorkerImage(image, maxBytes, label);
    if ("omitted" in materialized) {
      omittedHints.push(materialized.omitted);
      continue;
    }
    out.push(materialized);
  }
  return { images: out, omittedHints };
}

/** Appends omitted-image hints to a worker prompt. */
export function withOmittedImageHints(promptText: string, hints: readonly string[]): string {
  return hints.length ? `${promptText}\n\n${hints.join("\n")}` : promptText;
}

async function materializeOneWorkerImage(
  image: WorkerIpcImage,
  maxBytes: number,
  label: string,
): Promise<WorkerMaterializedImage | { omitted: string }> {
  if ("url" in image) {
    const url = image.url.trim();
    if (!url) {
      throw new Error(`${label} image is missing data, path, or url.`);
    }
    const urlPath = url.split(/[?#]/, 1)[0] ?? url;
    const mimeType = getImageAttachmentMediaType(urlPath);
    if (mimeType && !isProviderImageByteMediaType(mimeType)) {
      return { omitted: imageAttachmentReferenceText(url, mimeType) };
    }
    return { url };
  }
  if ("data" in image) {
    const inline = image.data.trim();
    const declaredMimeType = image.mimeType.trim();
    if (!inline || !declaredMimeType) {
      throw new Error(`${label} image is missing mimeType.`);
    }
    const mimeType = normalizeImageMediaType(declaredMimeType);
    if (!mimeType || !isProviderImageByteMediaType(mimeType)) {
      return { omitted: imageAttachmentReferenceText("(image data)", declaredMimeType) };
    }
    return { data: inline, mimeType };
  }
  if ("path" in image) {
    const filePath = image.path.trim();
    const rootPath = image.rootPath.trim();
    if (!filePath || !rootPath) {
      throw new Error(`${label} image is missing data, path, or url.`);
    }
    const declaredMimeType = normalizeImageMediaType(image.mimeType)
      ?? getImageAttachmentMediaType(filePath);
    if (declaredMimeType && !isProviderImageByteMediaType(declaredMimeType)) {
      return { omitted: imageAttachmentReferenceText(filePath, declaredMimeType) };
    }
    const fileLabel = path.basename(filePath);
    let buf: Buffer;
    try {
      buf = readFileWithinRootSecure(rootPath, filePath, { maxBytes });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/too large/i.test(message)) {
        return { omitted: imageNotInlinedText(filePath, "too large to read") };
      }
      throw new Error(`${label} image could not be read: ${fileLabel}`);
    }
    // With no type from the sender or the name, the bytes decide; bytes that
    // are no provider image type stay a path reference.
    const mimeType = declaredMimeType ?? sniffImageMimeType(buf);
    if (!mimeType || !isProviderImageByteMediaType(mimeType)) {
      return { omitted: imageAttachmentReferenceText(filePath, mimeType ?? "unknown type") };
    }
    const fitted = await fitImageForProviderInline(buf, mimeType);
    if (fitted.kind === "omit") {
      return { omitted: imageNotInlinedText(filePath, fitted.reason) };
    }
    return { data: fitted.data.toString("base64"), mimeType: fitted.mediaType };
  }
  const _exhaustive: never = image;
  throw new Error(`${label} image is missing data, path, or url.`);
}
