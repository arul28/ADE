import path from "node:path";
import { getImageAttachmentMediaType } from "../../../shared/types/chat";
import { MAX_CHAT_ATTACHMENT_BYTES } from "../../../shared/chatAttachmentLimits";
import { readFileWithinRootSecure } from "../shared/utils";
import { imageNotInlinedText } from "./attachmentInlineGuard";
import { fitImageForProviderInline } from "./providerInlineImage";

/**
 * Ceiling for an image file the worker reads. Anything that size may be
 * attached, and `fitImageForProviderInline` shrinks it to what the provider
 * accepts inline before it is base64'd into the request.
 */
const WORKER_MAX_IMAGE_FILE_BYTES = MAX_CHAT_ATTACHMENT_BYTES;

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
      mimeType: getImageAttachmentMediaType(filePath) ?? "image/jpeg",
    });
  }
  return images;
}

export async function materializeWorkerImages(
  images: readonly WorkerIpcImage[] | undefined,
  options?: {
    maxBytes?: number;
    label?: string;
    /**
     * Called with a prompt-ready hint for each path image that cannot be fitted
     * to the provider limits. The image is left out instead of failing the
     * send; the caller appends the hint so the agent can read the file itself.
     */
    onOmitted?: (hint: string) => void;
  },
): Promise<WorkerMaterializedImage[]> {
  if (!images?.length) return [];
  const maxBytes = options?.maxBytes ?? WORKER_MAX_IMAGE_FILE_BYTES;
  const label = options?.label ?? "Chat worker";
  const out: WorkerMaterializedImage[] = [];
  for (const image of images) {
    const materialized = await materializeOneWorkerImage(image, maxBytes, label);
    if ("omitted" in materialized) {
      if (!options?.onOmitted) {
        throw new Error(`${label} image could not be inlined: ${materialized.omitted}`);
      }
      options.onOmitted(materialized.omitted);
      continue;
    }
    out.push(materialized);
  }
  return out;
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
    return { url };
  }
  if ("data" in image) {
    const inline = image.data.trim();
    const mimeType = image.mimeType.trim();
    if (!inline || !mimeType) {
      throw new Error(`${label} image is missing mimeType.`);
    }
    return { data: inline, mimeType };
  }
  if ("path" in image) {
    const filePath = image.path.trim();
    const rootPath = image.rootPath.trim();
    if (!filePath || !rootPath) {
      throw new Error(`${label} image is missing data, path, or url.`);
    }
    const mimeType = image.mimeType.trim()
      || getImageAttachmentMediaType(filePath)
      || "image/jpeg";
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
    const fitted = await fitImageForProviderInline(buf, mimeType);
    if (fitted.kind === "omit") {
      return { omitted: imageNotInlinedText(filePath, fitted.reason) };
    }
    return { data: fitted.data.toString("base64"), mimeType: fitted.mediaType };
  }
  const _exhaustive: never = image;
  throw new Error(`${label} image is missing data, path, or url.`);
}
