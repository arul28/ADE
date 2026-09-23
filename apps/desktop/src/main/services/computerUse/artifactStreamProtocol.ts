import fs from "node:fs";
import path from "node:path";

import { isPathInside } from "../shared/pathCompare";

/**
 * What every path that serves proof bytes to a `<video>` or `<img>` shares:
 * the `ade-artifact://` handler in `main.ts` and the loopback media server in
 * `artifactMediaServer.ts`. The type table, the Range parse, the one
 * containment check both use for files on this computer, and the reader the
 * runtime bridge installs for files on a paired computer.
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

/** The installed reader, or null before the runtime bridge is up. */
export function getRemoteArtifactRangeReader(): RemoteArtifactRangeReader | null {
  return remoteReader;
}

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
