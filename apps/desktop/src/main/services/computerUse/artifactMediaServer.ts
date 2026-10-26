import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";

import { parseArtifactMediaPath } from "../../../shared/artifactStreamUrl";
import {
  REMOTE_ARTIFACT_CHUNK_BYTES,
  artifactStreamMimeType,
  decodeRemoteArtifactChunk,
  parseRangeHeader,
  resolveByteRange,
  resolveScopedArtifactFile,
  type ArtifactScopeResolver,
  type ArtifactServeRefusalLogger,
  type RemoteArtifactRangeReader,
  type RequestedByteRange,
} from "./artifactStreamProtocol";

/**
 * Serves proof videos to the renderer over loopback HTTP.
 *
 * Electron's `protocol.handle` cannot serve a seekable video: when an MP4 keeps
 * its index at the end, Chromium asks for `bytes=0-` and then for the tail,
 * and the second read fails with `PIPELINE_ERROR_READ`. A plain Node server
 * answers both, so a long recording loads and seeks.
 *
 * It listens on 127.0.0.1 only, on a port the OS picks, and only once a
 * renderer asks for its base. Every path starts with a random token made at
 * launch, so another local process or a web page cannot read proofs through
 * it. Files on this computer go through the same containment check as the
 * `ade-artifact://` handler. Files on a paired computer are pulled one chunk
 * at a time from its broker, which applies the same check on its side.
 */

export type ArtifactMediaServerDeps = {
  /**
   * The project a local request is served from, read on every request: the
   * project the URL's `root` names, or the focused one when it names none.
   */
  localScope: ArtifactScopeResolver;
  remoteReader: () => RemoteArtifactRangeReader | null;
  warn?: (message: string, details: Record<string, unknown>) => void;
  /** Records a refused local read: reason, project, and the path asked for. */
  onRefused?: ArtifactServeRefusalLogger;
  /** Tests pin the token; the app lets the server make one. */
  token?: string;
};

export type ArtifactMediaServer = {
  /** `http://127.0.0.1:<port>/<token>`, starting the server on first use. */
  baseUrl: () => Promise<string>;
  close: () => Promise<void>;
};

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function sendText(res: http.ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(message)),
    ...extra,
  });
  res.end(message);
}

function sendUnsatisfiable(res: http.ServerResponse, size: number): void {
  res.writeHead(416, { ...SECURITY_HEADERS, "Content-Range": `bytes */${size}`, "Content-Length": "0" });
  res.end();
}

function mediaHeaders(fileName: string, start: number, end: number, size: number, partial: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "Content-Type": artifactStreamMimeType(fileName),
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
  };
  if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return headers;
}

/**
 * Writes the status line for a request against a file of `size`: 416, an
 * empty 200, or the 200/206 head. Returns the bytes to send, or null when the
 * response is already complete.
 */
function writeRangeHead(
  res: http.ServerResponse,
  range: RequestedByteRange | null,
  size: number,
  fileName: string,
): { start: number; end: number } | null {
  const bytes = resolveByteRange(range, size);
  if (!bytes) {
    if (range) sendUnsatisfiable(res, size);
    else {
      // An empty file with no Range asked for.
      res.writeHead(200, mediaHeaders(fileName, 0, -1, 0, false));
      res.end();
    }
    return null;
  }
  res.writeHead(range ? 206 : 200, mediaHeaders(fileName, bytes.start, bytes.end, size, Boolean(range)));
  return bytes;
}

function tokensMatch(expected: Buffer, given: string): boolean {
  const candidate = Buffer.from(given, "utf8");
  // Length is not secret; the bytes are.
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Resolves once the response can take more bytes, or false once the client is gone. */
function waitForDrain(res: http.ServerResponse): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve(ok);
    };
    const onDrain = () => done(true);
    const onClose = () => done(false);
    res.on("drain", onDrain);
    res.on("close", onClose);
  });
}

async function serveLocal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: { relativePath: string; projectRoot: string | null },
  deps: ArtifactMediaServerDeps,
): Promise<void> {
  const file = resolveScopedArtifactFile({
    surface: "artifact-media",
    requestedPath: target.relativePath,
    projectRelative: true,
    requestedRoot: target.projectRoot,
    resolveScope: deps.localScope,
    onRefused: deps.onRefused,
  });
  if (!file.ok) {
    sendText(res, 404, "Not found");
    return;
  }
  const bytes = writeRangeHead(res, parseRangeHeader(req.headers.range), file.size, file.filePath);
  if (!bytes) return;
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  // `pipeline` destroys the file stream when the player drops the request.
  await pipeline(fs.createReadStream(file.filePath, { start: bytes.start, end: bytes.end }), res).catch(() => {
    if (!res.destroyed) res.destroy();
  });
}

/**
 * A paired machine's proof pictures, kept in memory once pulled. A chat shows
 * the same picture again on every remount, scroll back and lightbox open, and
 * each of those used to fetch every byte over the other machine's link again.
 * Stored proof is never rewritten in place (a new capture is a new file), so a
 * copy cannot go stale. Memory only, bounded, least recently used out first.
 */
const REMOTE_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
/** Larger pictures stream as before and are not kept. */
const REMOTE_IMAGE_CACHE_ENTRY_MAX_BYTES = 24 * 1024 * 1024;
const REMOTE_IMAGE_PULLS_AT_ONCE = 3;

type RemoteImageCache = {
  get: (key: string) => Buffer | null;
  set: (key: string, bytes: Buffer) => void;
  /**
   * One pull per picture at a time: an answer and the proof drawer often show
   * the same picture at once, and both asked the other machine for every byte.
   */
  inFlight: Map<string, InFlightImagePull>;
  /**
   * Distinct pictures pulled whole at once. Each holds up to 24 MiB until it
   * is kept, and a chat scrolled into view asks for all its pictures together.
   */
  pullSlots: ReturnType<typeof createSlots>;
};

function createRemoteImageCache(maxBytes = REMOTE_IMAGE_CACHE_BYTES): RemoteImageCache {
  const entries = new Map<string, Buffer>();
  let total = 0;
  return {
    inFlight: new Map(),
    pullSlots: createSlots(REMOTE_IMAGE_PULLS_AT_ONCE),
    get(key) {
      const bytes = entries.get(key);
      if (!bytes) return null;
      entries.delete(key);
      entries.set(key, bytes);
      return bytes;
    },
    set(key, bytes) {
      if (bytes.length > maxBytes) return;
      const previous = entries.get(key);
      if (previous) {
        entries.delete(key);
        total -= previous.length;
      }
      entries.set(key, bytes);
      total += bytes.length;
      for (const [oldest, oldBytes] of entries) {
        if (total <= maxBytes) break;
        entries.delete(oldest);
        total -= oldBytes.length;
      }
    },
  };
}

/** Runs at most `limit` tasks at once; the rest wait their turn. */
function createSlots(limit: number): { run: <T>(task: () => Promise<T>) => Promise<T> } {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async run(task) {
      if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        waiting.shift()?.();
      }
    },
  };
}

/**
 * A pull and the showings waiting on it. When every one has gone (a fast
 * scroll past the picture), a pull still queued never starts and a running one
 * stops at its next chunk, so it does not hold a slot a visible picture needs.
 */
type InFlightImagePull = { promise: Promise<WholeImagePull>; viewers: number };

type WholeImagePull =
  | { kind: "whole"; bytes: Buffer }
  /** Too big to keep: the first chunk, so the stream does not read it again. */
  | { kind: "large"; first: { totalSize: number; bytes: Buffer } };

async function pullWholeImage(
  read: (offset: number, length: number) => Promise<{ totalSize: number; bytes: Buffer }>,
  imageCache: RemoteImageCache,
  cacheKey: string,
  abandoned: () => boolean,
): Promise<WholeImagePull> {
  const stopIfAbandoned = () => {
    if (abandoned()) throw new Error("Nobody is showing this picture any more.");
  };
  stopIfAbandoned();
  const first = await read(0, REMOTE_ARTIFACT_CHUNK_BYTES);
  if (first.totalSize > REMOTE_IMAGE_CACHE_ENTRY_MAX_BYTES) return { kind: "large", first };
  // One buffer of the final size: no list of chunks and second copy to join them.
  const whole = Buffer.alloc(first.totalSize);
  let received = first.bytes.copy(whole, 0);
  while (received < first.totalSize) {
    stopIfAbandoned();
    const chunk = (await read(received, first.totalSize - received)).bytes;
    if (chunk.length === 0) throw new Error("The file ended early on the other computer.");
    received += chunk.copy(whole, received);
  }
  imageCache.set(cacheKey, whole);
  return { kind: "whole", bytes: whole };
}

function isImageFile(fileName: string): boolean {
  return artifactStreamMimeType(fileName).startsWith("image/");
}

function serveBuffer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bytes: Buffer,
  fileName: string,
): void {
  const range = writeRangeHead(res, parseRangeHeader(req.headers.range), bytes.length, fileName);
  if (!range) return;
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(bytes.subarray(range.start, range.end + 1));
}

async function serveRemote(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: { targetId: string; projectId: string; relativePath: string },
  reader: RemoteArtifactRangeReader | null,
  imageCache: RemoteImageCache,
): Promise<void> {
  const image = isImageFile(target.relativePath);
  const cacheKey = `${target.targetId}\u0000${target.projectId}\u0000${target.relativePath}`;
  const cached = image ? imageCache.get(cacheKey) : null;
  if (cached) {
    serveBuffer(req, res, cached, target.relativePath);
    return;
  }
  if (!reader) {
    sendText(res, 503, "Paired computers are not ready yet.");
    return;
  }
  let gone = false;
  res.on("close", () => {
    gone = true;
  });
  const read = async (offset: number, length: number) => decodeRemoteArtifactChunk(await reader({
    ...target,
    offset,
    length: Math.max(1, Math.min(length, REMOTE_ARTIFACT_CHUNK_BYTES)),
  }));

  // A failed read is the 502 the player shows.
  const sendReadFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    sendText(res, 502, message || "The other computer did not send this file.");
  };
  const readOrFail = async (offset: number, length: number) => {
    try {
      return await read(offset, length);
    } catch (error) {
      sendReadFailure(error);
      return null;
    }
  };

  const range = parseRangeHeader(req.headers.range);
  const head = req.method === "HEAD";
  // When the start is known, the first chunk also carries the size. A suffix
  // or a HEAD asks for one byte to learn the size first.
  const knownStart = range?.kind === "suffix" ? null : (range?.start ?? 0);
  let probe: { totalSize: number; bytes: Buffer } | null = null;

  // A picture is read whole, kept, then served, so the next showing costs no
  // round trip. One too big to keep streams below like a video, starting from
  // the chunk this already read.
  if (image && req.method === "GET") {
    let joined = imageCache.inFlight.get(cacheKey);
    if (joined) {
      joined.viewers += 1;
    } else {
      // Counted before the pull starts: a free slot runs it at once.
      const created: InFlightImagePull = { promise: Promise.resolve(null as never), viewers: 1 };
      created.promise = imageCache.pullSlots
        .run(() => pullWholeImage(read, imageCache, cacheKey, () => created.viewers === 0))
        .finally(() => {
          if (imageCache.inFlight.get(cacheKey) === created) imageCache.inFlight.delete(cacheKey);
        });
      imageCache.inFlight.set(cacheKey, created);
      joined = created;
    }
    const pull = joined;
    let watching = true;
    const leave = () => {
      if (!watching) return;
      watching = false;
      pull.viewers -= 1;
    };
    res.once("close", leave);
    let pulled: WholeImagePull;
    try {
      pulled = await pull.promise;
    } catch (error) {
      if (!gone) sendReadFailure(error);
      return;
    } finally {
      leave();
      res.off("close", leave);
    }
    if (pulled.kind === "whole") {
      if (!gone) serveBuffer(req, res, pulled.bytes, target.relativePath);
      return;
    }
    if (knownStart === 0) probe = pulled.first;
  }

  probe ??= await readOrFail(knownStart ?? 0, head || knownStart === null ? 1 : REMOTE_ARTIFACT_CHUNK_BYTES);
  if (!probe) return;

  const bytes = writeRangeHead(res, range, probe.totalSize, target.relativePath);
  if (!bytes) return;
  const { start, end } = bytes;
  if (head || gone) {
    res.end();
    return;
  }

  // One chunk per round trip, and the next only once the socket drained, so a
  // `<video preload="metadata">` that stops reading stops the pulls too.
  let next = start;
  let pending: Buffer | null = knownStart === null ? null : probe.bytes;
  try {
    while (next <= end && !gone) {
      let chunk = pending;
      pending = null;
      if (!chunk) chunk = (await read(next, end - next + 1)).bytes;
      if (gone) return;
      if (chunk.length === 0) throw new Error("The file ended early on the other computer.");
      const slice = chunk.subarray(0, end - next + 1);
      next += slice.length;
      if (!res.write(slice) && next <= end && !(await waitForDrain(res))) return;
    }
    res.end();
  } catch {
    // Headers are out, so the only honest signal left is a cut connection.
    res.destroy();
  }
}

export function createArtifactMediaServer(deps: ArtifactMediaServerDeps): ArtifactMediaServer {
  const token = deps.token ?? randomBytes(32).toString("base64url");
  const expectedToken = Buffer.from(token, "utf8");
  let server: http.Server | null = null;
  let starting: Promise<string> | null = null;
  /** Bumped by `close()`, so a start still binding knows it was cancelled. */
  let generation = 0;
  let hostHeader = "";
  const remoteImageCache = createRemoteImageCache();

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // `req.url` is the raw request target, never folded, so `..` arrives as sent.
    const raw = req.url ?? "";
    const slash = raw.indexOf("/", 1);
    const given = raw.startsWith("/") && slash > 1 ? raw.slice(1, slash) : "";
    // A DNS-rebound page would send its own host name here.
    if (!given || req.headers.host !== hostHeader || !tokensMatch(expectedToken, given)) {
      sendText(res, 404, "Not found");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
      return;
    }
    const target = parseArtifactMediaPath(raw.slice(slash + 1));
    if (!target) {
      sendText(res, 404, "Not found");
      return;
    }
    const served = target.kind === "project"
      ? serveLocal(req, res, target, deps)
      : serveRemote(req, res, target, deps.remoteReader(), remoteImageCache);
    served.catch((error: unknown) => {
      deps.warn?.("[artifact-media] request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) sendText(res, 500, "Could not read this file.");
      else res.destroy();
    });
  };

  const start = (): Promise<string> => new Promise((resolve, reject) => {
    const startedIn = generation;
    const next = http.createServer(handle);
    next.once("error", reject);
    next.listen(0, "127.0.0.1", () => {
      next.off("error", reject);
      // `close()` ran while this was still binding.
      if (startedIn !== generation) {
        next.close();
        reject(new Error("The media server is closed."));
        return;
      }
      const { port } = next.address() as AddressInfo;
      hostHeader = `127.0.0.1:${port}`;
      server = next;
      resolve(`http://${hostHeader}/${token}`);
    });
  });

  return {
    baseUrl() {
      if (!starting) {
        const attempt: Promise<string> = start().catch((error: unknown) => {
          // Let the next caller try again rather than caching a failure.
          if (starting === attempt) starting = null;
          throw error;
        });
        starting = attempt;
      }
      return starting;
    },
    async close() {
      generation += 1;
      const current = server;
      server = null;
      starting = null;
      if (!current) return;
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        current.closeAllConnections();
      });
    },
  };
}
