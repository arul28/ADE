import path from "node:path";

import {
  ARTIFACT_RANGE_READ_MAX_BYTES,
  parseRemoteArtifactStreamUrl,
} from "../../../shared/artifactStreamUrl";

/**
 * Serving `ade-artifact://` bytes to a `<video>` or `<img>`.
 *
 * The local half lives in `main.ts`. This file owns what both halves share,
 * the type table and the Range parse, and the whole remote half:
 * `ade-artifact://remote/<targetId>/<projectId>/<path>` is answered by reading
 * the file in bounded chunks from the paired machine's broker.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  // Chromium refuses `video/quicktime` in a <video>; the same bytes play as MP4.
  mov: "video/mp4",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
};

/** The type a proof file is served as, picked so Chromium will play it. */
export function artifactStreamMimeType(fileName: string): string {
  const ext = path.extname(fileName).replace(/^\./, "").toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** One byte range, inclusive, or `suffix` for `bytes=-N`. */
export type RequestedByteRange =
  | { kind: "from"; start: number; end: number | null }
  | { kind: "suffix"; length: number };

/** Parses the first range of a `Range` header. Null for no header or one we do not read. */
export function parseRangeHeader(header: string | null | undefined): RequestedByteRange | null {
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)/i.exec(header ?? "");
  if (!match) return null;
  const [, startText, endText] = match;
  if (!startText && !endText) return null;
  if (!startText) return { kind: "suffix", length: Number(endText) };
  const start = Number(startText);
  const end = endText ? Number(endText) : null;
  if (!Number.isSafeInteger(start) || (end !== null && !Number.isSafeInteger(end))) return null;
  return { kind: "from", start, end };
}

/** A chunk as the paired machine's `computer_use_artifacts.readArtifactRange` sends it. */
export type RemoteArtifactRangeChunk = {
  totalSize: number;
  offset: number;
  /** Base64 of the bytes read. Empty at or past the end of the file. */
  data: string;
};

export type RemoteArtifactRangeReader = (args: {
  targetId: string;
  projectId: string;
  relativePath: string;
  offset: number;
  length: number;
}) => Promise<RemoteArtifactRangeChunk>;

/** What the proxy asks for per round trip. Small enough that a poster costs about one. */
export const REMOTE_ARTIFACT_CHUNK_BYTES = 1024 * 1024;

let remoteReader: RemoteArtifactRangeReader | null = null;

/** The runtime bridge installs this once it owns the paired connections. */
export function setRemoteArtifactRangeReader(reader: RemoteArtifactRangeReader | null): void {
  remoteReader = reader;
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function decodeChunk(chunk: unknown): { totalSize: number; bytes: Buffer } {
  const record = chunk && typeof chunk === "object" ? chunk as Partial<RemoteArtifactRangeChunk> : null;
  const totalSize = Number(record?.totalSize);
  if (!record || !Number.isSafeInteger(totalSize) || totalSize < 0 || typeof record.data !== "string") {
    throw new Error("The other computer sent an unreadable answer.");
  }
  return { totalSize, bytes: Buffer.from(record.data, "base64") };
}

/**
 * Answers one `ade-artifact://remote/...` request.
 *
 * The body is pulled one chunk at a time, so a `<video preload="metadata">`
 * that reads the header and stops costs one or two round trips, not the file.
 * The Content-Range covers what was asked for; the chunking is invisible to
 * the media stack. Containment is the other machine's job: its broker resolves
 * the path inside its own `.ade/artifacts` and refuses anything else. The
 * parse here only refuses `..` early.
 */
export async function respondToRemoteArtifactRequest(
  request: Request,
  reader: RemoteArtifactRangeReader | null = remoteReader,
): Promise<Response> {
  const target = parseRemoteArtifactStreamUrl(request.url);
  if (!target) return textResponse(404, "Not found");
  if (!reader) return textResponse(503, "Paired computers are not ready yet.");

  const read = async (offset: number, length: number) => decodeChunk(await reader({
    ...target,
    offset,
    length: Math.max(1, Math.min(length, REMOTE_ARTIFACT_CHUNK_BYTES, ARTIFACT_RANGE_READ_MAX_BYTES)),
  }));

  const range = parseRangeHeader(request.headers.get("Range"));
  let start = range?.kind === "from" ? range.start : 0;
  let first: { totalSize: number; bytes: Buffer };
  try {
    if (range?.kind === "suffix") {
      // The size decides where a suffix starts, so ask for it first.
      const probe = await read(0, 1);
      start = Math.max(0, probe.totalSize - range.length);
    }
    first = await read(start, REMOTE_ARTIFACT_CHUNK_BYTES);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResponse(502, message || "The other computer did not send this file.");
  }

  const totalSize = first.totalSize;
  if (start >= totalSize) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${totalSize}` },
    });
  }
  const requestedEnd = range?.kind === "from" && range.end !== null ? range.end : totalSize - 1;
  const end = Math.min(requestedEnd, totalSize - 1);
  if (end < start) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${totalSize}` },
    });
  }

  let next = start;
  let pending: Buffer | null = first.bytes;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let bytes = pending;
        pending = null;
        if (!bytes) bytes = (await read(next, end - next + 1)).bytes;
        if (bytes.length === 0) {
          controller.error(new Error("The file ended early on the other computer."));
          return;
        }
        const slice = bytes.subarray(0, end - next + 1);
        next += slice.length;
        controller.enqueue(new Uint8Array(slice));
        if (next > end) controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  }, { highWaterMark: 0 });

  const headers: Record<string, string> = {
    "Content-Type": artifactStreamMimeType(target.relativePath),
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (range) {
    headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
    return new Response(body, { status: 206, headers });
  }
  return new Response(body, { status: 200, headers });
}
