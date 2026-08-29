import path from "node:path";
import { getImageAttachmentMediaType } from "../../../shared/types/chat";
import { readFileWithinRootSecure } from "../shared/utils";

/** Match the composer temp-attachment cap so IPC and disk agree. */
export const WORKER_MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;

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
 * Remote URLs are a Cursor-only send shape and stay at that call site.
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
  options?: { maxBytes?: number; label?: string },
): Promise<WorkerMaterializedImage[]> {
  if (!images?.length) return [];
  const maxBytes = options?.maxBytes ?? WORKER_MAX_IMAGE_FILE_BYTES;
  const label = options?.label ?? "Chat worker";
  const out: WorkerMaterializedImage[] = [];
  for (const image of images) {
    out.push(materializeOneWorkerImage(image, maxBytes, label));
  }
  return out;
}

function materializeOneWorkerImage(
  image: WorkerIpcImage,
  maxBytes: number,
  label: string,
): WorkerMaterializedImage {
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
    try {
      const buf = readFileWithinRootSecure(rootPath, filePath, { maxBytes });
      return { data: buf.toString("base64"), mimeType };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/too large/i.test(message)) {
        throw new Error(`${label} image is too large: ${fileLabel}`);
      }
      throw new Error(`${label} image could not be read: ${fileLabel}`);
    }
  }
  const _exhaustive: never = image;
  throw new Error(`${label} image is missing data, path, or url.`);
}
