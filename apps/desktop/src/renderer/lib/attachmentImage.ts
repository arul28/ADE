import type { OpenProjectBinding } from "../../shared/types/core";
import { useAppStore } from "../state/appStore";
import { effectiveRuntimeBinding } from "./chatMachineRouting";

/**
 * Read a chat attachment image as a data URL on the machine that owns it.
 *
 * One rule for every surface that shows or copies an attachment image:
 * - A chat that has its own reader (a personal chat, whose files are not under
 *   any project) reads through it, and only through it.
 * - Otherwise read through the runtime of `pin`. No pin means the machine this
 *   window is bound to; with no project bound, that is this computer's own
 *   reader. When the owner is this computer and the runtime cannot answer (it
 *   is down, or the path is outside its folders but in an OS user folder it
 *   cannot know, like a Desktop moved into OneDrive), ask this computer's
 *   reader too. A runtime answer about the file itself ("Path does not
 *   exist", "not an image", too large) is final: asking again only fails again.
 * - Never read a remote-owned path here. That path names a file on the other
 *   machine, and on this computer it is missing or, worse, a different file.
 */
export async function readAttachmentImageDataUrl(
  path: string,
  pin: OpenProjectBinding | null | undefined,
  options?: {
    /**
     * Set for a path that can be rewritten in place (an image an agent
     * viewed in its workspace): the read is cached per version, so a new view
     * of the same path reads the file again while a remount of the same view
     * does not. Attachments are written once under a fresh name and need none.
     */
    version?: string | null;
    /**
     * The chat's own image reader, for a chat that does not live in a project
     * runtime (a personal chat's attachment store is not under any project).
     * Used in place of the runtime and local readers; `pin` then only names
     * the machine in the cache key. See `useChatImageReader`.
     */
    reader?: ((path: string) => Promise<{ dataUrl: string }>) | null;
  },
): Promise<{ dataUrl: string }> {
  const version = options?.version ? `\u0000${options.version}` : "";
  const reader = options?.reader;
  // The pin names the machine a personal chat lives on: the same path on two
  // machines is two files.
  if (reader) return cachedRead(`chat-reader\u0000${pin?.key ?? "this-computer"}\u0000${path}${version}`, () => reader(path));
  const owner = effectiveRuntimeBinding(pin, useAppStore.getState().projectBinding);
  // One read per owner and path serves every chip that shows the attachment.
  // A virtualized transcript remounts a thumbnail each time its row scrolls
  // back into view, and each uncached read is a multi-megabyte base64 reply on
  // the runtime socket that holds up the transcript pages queued behind it.
  const key = `${owner?.key ?? "this-computer"}\u0000${path}${version}`;
  return cachedRead(key, () => readUncached(path, pin, owner?.kind !== "remote"));
}

function cachedRead(key: string, read: () => Promise<{ dataUrl: string }>): Promise<{ dataUrl: string }> {
  const cached = imageDataUrlCache.get(key);
  if (cached) {
    imageDataUrlCache.delete(key);
    imageDataUrlCache.set(key, cached);
    return cached.read;
  }
  const entry: ImageDataUrlCacheEntry = { read: read(), chars: null };
  imageDataUrlCache.set(key, entry);
  entry.read.then(
    (result) => {
      if (imageDataUrlCache.get(key) !== entry) return;
      entry.chars = result.dataUrl.length;
      imageDataUrlCacheChars += entry.chars;
      trimImageDataUrlCache();
    },
    () => {
      // A failed read is not an answer: the next caller asks again.
      if (imageDataUrlCache.get(key) === entry) imageDataUrlCache.delete(key);
    },
  );
  return entry.read;
}

/** Most data-URL characters kept across cached images (base64 is one byte per char). */
const IMAGE_DATA_URL_CACHE_MAX_CHARS = 48 * 1024 * 1024;
/** `chars` stays null while the read is in flight. */
type ImageDataUrlCacheEntry = { read: Promise<{ dataUrl: string }>; chars: number | null };
/** Insertion order is LRU order: a hit re-inserts at the tail. */
const imageDataUrlCache = new Map<string, ImageDataUrlCacheEntry>();
/** Sum of `chars` over the settled entries. */
let imageDataUrlCacheChars = 0;

function trimImageDataUrlCache(): void {
  for (const [key, entry] of imageDataUrlCache) {
    // Keep the newest entry even when it alone is over budget.
    if (imageDataUrlCacheChars <= IMAGE_DATA_URL_CACHE_MAX_CHARS || imageDataUrlCache.size <= 1) break;
    // Still in flight: its size is unknown and its reader is waiting on it.
    if (entry.chars === null) continue;
    imageDataUrlCache.delete(key);
    imageDataUrlCacheChars -= entry.chars;
  }
}

async function readUncached(
  path: string,
  pin: OpenProjectBinding | null | undefined,
  ownedHere: boolean,
): Promise<{ dataUrl: string }> {
  const runtimeRead = window.ade?.agentChat?.getImageDataUrl;
  const localRead = window.ade?.app?.getImageDataUrl;
  if (runtimeRead) {
    try {
      return await runtimeRead(path, pin ?? undefined);
    } catch (error) {
      if (!ownedHere || !localRead || FINAL_FILE_ANSWER.test(errorText(error))) throw error;
      return await localRead(path).catch(() => {
        throw error;
      });
    }
  }
  if (ownedHere && localRead) return await localRead(path);
  throw new Error("No image reader is available for the machine that owns this attachment.");
}

/** A runtime answer about the file itself, which this computer's reader would repeat. */
const FINAL_FILE_ANSWER = /Path does not exist|not an image|not a file|or smaller\./i;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
