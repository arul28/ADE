/**
 * Base64 in the renderer.
 *
 * `btoa` takes a string of code units below U+0100, so every caller needs the
 * same two steps: widen bytes into a binary string, then encode. Three copies
 * of that loop had grown — one for chat attachments, one for the capture note,
 * one for voice audio — and only the attachment copy chunked, so the other two
 * would have thrown `RangeError` on a large enough input.
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

/** UTF-8 safe: `btoa` alone throws on any character above U+00FF. */
export function encodeUtf8Base64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}
