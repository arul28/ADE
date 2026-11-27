/**
 * Bytes to base64 for code that runs in the renderer, the web client and the
 * main process alike (no Buffer). The renderer's helpers re-export it
 * (`renderer/lib/base64.ts`).
 */

// Spreading a multi-megabyte array into String.fromCharCode exceeds the
// argument limit, so widen in chunks.
const CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE)));
  }
  return btoa(parts.join(""));
}
