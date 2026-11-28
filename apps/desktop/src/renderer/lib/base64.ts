/**
 * Base64 in the renderer.
 *
 * `btoa` takes a string of code units below U+0100, so every caller needs the
 * same two steps: widen bytes into a binary string, then encode. Three copies
 * of that loop had grown — one for chat attachments, one for the capture note,
 * one for voice audio — and only the attachment copy chunked, so the other two
 * would have thrown `RangeError` on a large enough input.
 */

import { bytesToBase64 } from "../../shared/base64";

export { bytesToBase64 };

/** Decode base64 into a fresh byte array (no shared or offset buffer). */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** UTF-8 safe: `btoa` alone throws on any character above U+00FF. */
export function encodeUtf8Base64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}
