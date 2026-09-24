import fs from "node:fs";
import path from "node:path";

import { isPathInside } from "../shared/pathCompare";

/**
 * What every path that serves proof bytes to a `<video>` or `<img>` shares:
 * the `ade-artifact://` handler below, the loopback media server in
 * `artifactMediaServer.ts`, and the broker's preview and range reads. The type
 * table, the Range parse, and the one containment check for files on this
 * computer.
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

/** The type of a proof image or video, or null for any other file. */
export function knownArtifactMimeType(fileName: string): string | null {
  const ext = path.extname(fileName).replace(/^\./, "").toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? null;
}

/** True for the image and video types a preview or a range read may serve. */
export function isStreamableArtifactFile(fileName: string): boolean {
  return knownArtifactMimeType(fileName) !== null;
}

/** The type a proof file is served as, picked so Chromium will play it. */
export function artifactStreamMimeType(fileName: string): string {
  return knownArtifactMimeType(fileName) ?? "application/octet-stream";
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

/**
 * Reads one chunk from a paired computer. The answer is checked with
 * `decodeRemoteArtifactChunk`, so it is typed as unknown here.
 */
export type RemoteArtifactRangeReader = (args: {
  targetId: string;
  projectId: string;
  relativePath: string;
  offset: number;
  length: number;
}) => Promise<unknown>;

/** What the proxy asks for per round trip. Small enough that a poster costs about one. */
export const REMOTE_ARTIFACT_CHUNK_BYTES = 1024 * 1024;

/** Reads one chunk answer. Throws on anything that is not one. */
export function decodeRemoteArtifactChunk(chunk: unknown): { totalSize: number; bytes: Buffer } {
  const record = chunk && typeof chunk === "object" ? chunk as Partial<RemoteArtifactRangeChunk> : null;
  const totalSize = Number(record?.totalSize);
  if (!record || !Number.isSafeInteger(totalSize) || totalSize < 0 || typeof record.data !== "string") {
    throw new Error("The other computer sent an unreadable answer.");
  }
  return { totalSize, bytes: Buffer.from(record.data, "base64") };
}

/**
 * The bytes to send for a file of `size`. Null when the range cannot be
 * satisfied (416), or when there is no range and the file is empty.
 */
export function resolveByteRange(
  range: RequestedByteRange | null,
  size: number,
): { start: number; end: number } | null {
  if (!range) return size > 0 ? { start: 0, end: size - 1 } : null;
  if (range.kind === "suffix") {
    if (!Number.isSafeInteger(range.length) || range.length <= 0 || size === 0) return null;
    return { start: Math.max(0, size - range.length), end: size - 1 };
  }
  const end = Math.min(range.end ?? size - 1, size - 1);
  if (range.start >= size || end < range.start) return null;
  return { start: range.start, end };
}

export type ContainedArtifactFile =
  | { ok: true; filePath: string; size: number }
  | { ok: false; reason: "no-project" | "missing" | "outside" | "not-file"; filePath?: string };

/**
 * The one containment check for serving a file on this computer.
 *
 * `requestedPath` is resolved against the active project root when it is
 * relative (or when `projectRelative` says so), then realpath'd, so a symlink
 * cannot point out. The result must sit inside the active project's artifacts
 * dir, realpath'd the same way. Both the `ade-artifact://` handler and the
 * media server call this, so the two cannot drift.
 */
export function resolveContainedArtifactFile(args: {
  requestedPath: string;
  projectRelative: boolean;
  projectRoot: string | null;
  allowedDir: string | null;
  platform?: NodeJS.Platform;
}): ContainedArtifactFile {
  const platform = args.platform ?? process.platform;
  let filePath = args.requestedPath;
  if (args.projectRelative) {
    if (!args.projectRoot) return { ok: false, reason: "no-project" };
    filePath = path.resolve(args.projectRoot, filePath.replace(/^[/\\]+/, ""));
  }
  // A Windows path out of a URL starts `/C:/...`.
  if (platform === "win32" && /^[/\\][a-zA-Z]:/.test(filePath)) filePath = filePath.slice(1);
  if (!path.isAbsolute(filePath)) {
    if (!args.projectRoot) return { ok: false, reason: "no-project" };
    filePath = path.resolve(args.projectRoot, filePath);
  }
  filePath = path.resolve(filePath);
  let resolvedFile: string;
  let allowed: string;
  try {
    resolvedFile = fs.realpathSync(filePath);
  } catch {
    return { ok: false, reason: "missing", filePath };
  }
  try {
    allowed = args.allowedDir ? fs.realpathSync(args.allowedDir) : "";
  } catch {
    allowed = "";
  }
  if (!allowed || !isPathInside(resolvedFile, allowed, platform)) {
    return { ok: false, reason: "outside", filePath: resolvedFile };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedFile);
  } catch {
    return { ok: false, reason: "missing", filePath: resolvedFile };
  }
  if (!stat.isFile()) return { ok: false, reason: "not-file", filePath: resolvedFile };
  return { ok: true, filePath: resolvedFile, size: stat.size };
}

/** A file, or one inclusive byte span of it, as a web stream for a `Response`. */
function fileWebStream(filePath: string, start?: number, end?: number): ReadableStream<Uint8Array> {
  const fileStream = fs.createReadStream(filePath, start === undefined ? {} : { start, end });
  return new ReadableStream<Uint8Array>({
    start(controller) {
      fileStream.on("data", (chunk) => controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
      fileStream.on("end", () => controller.close());
      fileStream.on("error", (error) => controller.error(error));
    },
    cancel() {
      fileStream.destroy();
    },
  });
}

/**
 * The `ade-artifact://` answer. The path is in the URL:
 * `ade-artifact:///absolute/path/to/file.png` or
 * `ade-artifact://project/<relative path>`. Proof images use it; videos use
 * the media server, which reads the same Range header the same way.
 */
export function respondToArtifactProtocolRequest(
  request: Request,
  scope: { projectRoot: string | null; allowedDir: string | null },
  warn?: (message: string, details: Record<string, unknown>) => void,
): Response {
  const notFound = () => new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent(url.pathname);
  } catch {
    return notFound();
  }
  const file = resolveContainedArtifactFile({
    requestedPath,
    projectRelative: url.hostname === "project",
    projectRoot: scope.projectRoot,
    allowedDir: scope.allowedDir,
  });
  if (!file.ok) {
    if (file.reason === "missing") {
      warn?.("[ade-artifact] realpath failed", { filePath: file.filePath });
    } else if (file.reason === "outside") {
      warn?.("[ade-artifact] rejected path outside artifacts dir", {
        resolvedFile: file.filePath,
        allowedDir: scope.allowedDir,
      });
    }
    return notFound();
  }
  const headers: Record<string, string> = {
    "Content-Type": artifactStreamMimeType(file.filePath),
    "Accept-Ranges": "bytes",
  };
  const range = parseRangeHeader(request.headers.get("Range"));
  const bytes = resolveByteRange(range, file.size);
  if (!bytes) {
    if (range) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
    }
    // An empty file with no Range asked for.
    return new Response(null, { status: 200, headers: { ...headers, "Content-Length": "0" } });
  }
  try {
    headers["Content-Length"] = String(bytes.end - bytes.start + 1);
    if (!range) return new Response(fileWebStream(file.filePath), { status: 200, headers });
    headers["Content-Range"] = `bytes ${bytes.start}-${bytes.end}/${file.size}`;
    return new Response(fileWebStream(file.filePath, bytes.start, bytes.end), { status: 206, headers });
  } catch {
    return notFound();
  }
}
