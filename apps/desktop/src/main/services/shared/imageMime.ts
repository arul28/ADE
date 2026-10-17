/**
 * Image type from the first bytes, for bodies a server labelled vaguely (or
 * wrongly). Shared by favicon and Now Playing artwork fetches.
 */
export function sniffFaviconMime(body: Buffer): string | null {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length >= 6 && /^GIF8[79]a$/.test(body.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (body.length >= 12 && body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  if (body.length >= 6 && body[0] === 0 && body[1] === 0 && (body[2] === 1 || body[2] === 2) && body[3] === 0) {
    return "image/x-icon";
  }
  const head = body.subarray(0, 1_024).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}
