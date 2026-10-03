import type { OpenProjectBinding } from "../../shared/types/core";
import { useAppStore } from "../state/appStore";
import { effectiveRuntimeBinding } from "./chatMachineRouting";

/**
 * Read a chat attachment image as a data URL on the machine that owns it.
 *
 * One rule for every surface that shows or copies an attachment image:
 * - Read through the runtime of `pin`. No pin means the machine this window is
 *   bound to.
 * - Fall back to this computer's own reader only when the owner is this
 *   computer: a local pin, or no pin in a window bound to a local project (or
 *   to no project).
 * - Never read a remote-owned path here. That path names a file on the other
 *   machine, and on this computer it is missing or, worse, a different file.
 */
export async function readAttachmentImageDataUrl(
  path: string,
  pin: OpenProjectBinding | null | undefined,
): Promise<{ dataUrl: string }> {
  const owner = effectiveRuntimeBinding(pin, useAppStore.getState().projectBinding);
  // Attachment files are written once under a fresh name and never rewritten,
  // so one read per owner and path serves every chip that shows it. A
  // virtualized transcript remounts a thumbnail each time its row scrolls back
  // into view, and each uncached read is a multi-megabyte base64 reply on the
  // runtime socket that holds up the transcript pages queued behind it.
  const key = `${owner?.key ?? "this-computer"}\u0000${path}`;
  const cached = imageDataUrlCache.get(key);
  if (cached) {
    imageDataUrlCache.delete(key);
    imageDataUrlCache.set(key, cached);
    return cached;
  }
  const read = readUncached(path, pin, owner?.kind !== "remote");
  imageDataUrlCache.set(key, read);
  read.then(
    (result) => {
      imageDataUrlCacheChars.set(key, result.dataUrl.length);
      trimImageDataUrlCache();
    },
    () => {
      // A failed read is not an answer: the next caller asks again.
      if (imageDataUrlCache.get(key) === read) imageDataUrlCache.delete(key);
    },
  );
  return read;
}

/** Most data-URL characters kept across cached images (base64 is one byte per char). */
const IMAGE_DATA_URL_CACHE_MAX_CHARS = 48 * 1024 * 1024;
/** Insertion order is LRU order: a hit re-inserts at the tail. */
const imageDataUrlCache = new Map<string, Promise<{ dataUrl: string }>>();
const imageDataUrlCacheChars = new Map<string, number>();

function trimImageDataUrlCache(): void {
  let total = 0;
  for (const chars of imageDataUrlCacheChars.values()) total += chars;
  for (const key of imageDataUrlCache.keys()) {
    // Keep the newest entry even when it alone is over budget.
    if (total <= IMAGE_DATA_URL_CACHE_MAX_CHARS || imageDataUrlCache.size <= 1) break;
    const chars = imageDataUrlCacheChars.get(key);
    // Still in flight: its size is unknown and its reader is waiting on it.
    if (chars === undefined) continue;
    imageDataUrlCache.delete(key);
    imageDataUrlCacheChars.delete(key);
    total -= chars;
  }
}

async function readUncached(
  path: string,
  pin: OpenProjectBinding | null | undefined,
  ownedHere: boolean,
): Promise<{ dataUrl: string }> {
  const runtimeRead = window.ade?.agentChat?.getImageDataUrl;
  const localRead = window.ade?.app?.getImageDataUrl;
  if (!runtimeRead) {
    if (ownedHere && localRead) return await localRead(path);
    throw new Error("No image reader is available for the machine that owns this attachment.");
  }
  try {
    return await runtimeRead(path, pin ?? undefined);
  } catch (error) {
    if (!ownedHere || !localRead) throw error;
    return await localRead(path);
  }
}
