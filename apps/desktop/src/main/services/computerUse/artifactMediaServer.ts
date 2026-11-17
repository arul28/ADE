import { createLinkMeter, linkWantsSlowPath, type LinkMeter } from "../remoteRuntime/remoteLinkMeter";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";

import { parseArtifactMediaPath } from "../../../shared/artifactStreamUrl";
import {
  isRemoteOutcomeUnknownError,
  isRemoteRuntimeConnectionError,
  isRuntimeTransportTimeoutError,
} from "../../../shared/runtimeErrors";
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
  /** The last measured round trip to a machine, to pick the display copy before any chunk arrived. */
  linkRoundTripMs?: (targetId: string) => number | null;
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

/**
 * How one paired computer's proof bytes share its link.
 *
 * Every chunk is one reply on the same connection that carries the chat, the
 * terminal echo and every other call. A 1 MiB chunk is 1.4-1.9 MB on the wire,
 * 11-15 s at 1 Mbit/s, and a keystroke's echo waited behind it; three pictures
 * pulling at once each took longer than a call's 25 s budget, and the pull
 * failed ("could not send this image").
 *
 * So each machine gets its own meter, like a small congestion window:
 * - A chunk is about `REMOTE_CHUNK_TARGET_MS` of the rate chunks arrive at:
 *   1 MiB on a fast link, as before; about 24 KiB at 1 Mbit/s.
 * - Enough chunks are out at once to cover the round trip plus one chunk, so
 *   the link stays full, and other replies queue behind about one chunk.
 * - A chunk that times out or loses its connection is read again from the
 *   same offset, so the bytes already pulled are kept.
 */
const REMOTE_CHUNK_TARGET_MS = 250;
const REMOTE_CHUNK_MIN_BYTES = 16 * 1024;
/** Before any chunk arrived: a size a slow link carries well inside a call's budget. */
const REMOTE_CHUNK_START_BYTES = 32 * 1024;
const REMOTE_CHUNKS_IN_FLIGHT_MIN = 2;
/** Before any chunk arrived: four small ones measure the link within one round trip. */
const REMOTE_CHUNKS_AT_START = 4;
const REMOTE_CHUNKS_IN_FLIGHT_MAX = 8;
/** Recent latencies of chunks with none of ours ahead; the smallest stands for the round trip. */
const REMOTE_LATENCY_SAMPLES = 8;
/** Waits before each new try of one chunk; then the read fails. */
const REMOTE_CHUNK_RETRY_DELAYS_MS = [500, 1_500, 3_000, 6_000] as const;

/** A failure another try of the same chunk can fix: a lost or slow connection. */
function isTransientChunkError(error: unknown): boolean {
  if (isRemoteRuntimeConnectionError(error) || isRuntimeTransportTimeoutError(error) || isRemoteOutcomeUnknownError(error)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /Remote target is not connected|connection failed recently|timed out/i.test(message);
}

function createRemoteLinkMeter(now: () => number = Date.now): LinkMeter {
  return createLinkMeter({
    targetMs: REMOTE_CHUNK_TARGET_MS,
    minBytes: REMOTE_CHUNK_MIN_BYTES,
    startBytes: REMOTE_CHUNK_START_BYTES,
    maxBytes: REMOTE_ARTIFACT_CHUNK_BYTES,
    inFlightMin: REMOTE_CHUNKS_IN_FLIGHT_MIN,
    inFlightMax: REMOTE_CHUNKS_IN_FLIGHT_MAX,
    startInFlight: REMOTE_CHUNKS_AT_START,
    latencySamples: REMOTE_LATENCY_SAMPLES,
    now,
  });
}

type RemoteChunk = { totalSize: number; bytes: Buffer; display: boolean };

/**
 * Reads one chunk of up to `wanted` bytes at `offset` through the machine's
 * meter, trying again from the same offset after a lost or slow connection.
 */
async function readRemoteChunk(
  reader: RemoteArtifactRangeReader,
  meter: LinkMeter,
  target: { targetId: string; projectId: string; relativePath: string; display?: boolean },
  offset: number,
  wanted: number,
  sleep: (ms: number) => Promise<void>,
  /** A near, fast link: before the meter measured it, ask for the whole `wanted`, as on a LAN. */
  nearLink: boolean,
): Promise<RemoteChunk> {
  for (let attempt = 0; ; attempt += 1) {
    await meter.acquire();
    const planned = nearLink && attempt === 0 && meter.rateBytesPerMs() === null ? wanted : meter.chunkBytes();
    const length = Math.max(1, Math.min(wanted, planned));
    const stamp = meter.stamp();
    let failure: unknown;
    try {
      const chunk = decodeRemoteArtifactChunk(await reader({
        targetId: target.targetId,
        projectId: target.projectId,
        relativePath: target.relativePath,
        offset,
        length,
        ...(target.display ? { variant: "display" as const } : {}),
      }));
      meter.delivered(chunk.bytes.length, stamp);
      return chunk;
    } catch (error) {
      failure = error;
    } finally {
      meter.release();
    }
    if (!isTransientChunkError(failure) || attempt >= REMOTE_CHUNK_RETRY_DELAYS_MS.length) throw failure;
    meter.slowDown();
    await sleep(REMOTE_CHUNK_RETRY_DELAYS_MS[attempt]!);
  }
}

type CachedImage = { bytes: Buffer; display: boolean };

type RemoteImageCache = {
  get: (key: string) => CachedImage | null;
  set: (key: string, image: CachedImage) => void;
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
  const entries = new Map<string, CachedImage>();
  let total = 0;
  return {
    inFlight: new Map(),
    pullSlots: createSlots(REMOTE_IMAGE_PULLS_AT_ONCE),
    get(key) {
      const image = entries.get(key);
      if (!image) return null;
      entries.delete(key);
      entries.set(key, image);
      return image;
    },
    set(key, image) {
      if (image.bytes.length > maxBytes) return;
      const previous = entries.get(key);
      if (previous) {
        entries.delete(key);
        total -= previous.bytes.length;
      }
      entries.set(key, image);
      total += image.bytes.length;
      for (const [oldest, old] of entries) {
        if (total <= maxBytes) break;
        entries.delete(oldest);
        total -= old.bytes.length;
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
  /** `display`: the bytes are the picture's display copy, a JPEG. */
  | { kind: "whole"; bytes: Buffer; display: boolean }
  /** Too big to keep: the first chunk, so the stream does not read it again. */
  | { kind: "large"; first: RemoteChunk };

async function pullWholeImage(
  read: (offset: number, length: number) => Promise<RemoteChunk>,
  planChunkBytes: () => number,
  imageCache: RemoteImageCache,
  cacheKey: string,
  abandoned: () => boolean,
): Promise<WholeImagePull> {
  let failed = false;
  const stopIfAbandoned = () => {
    if (failed) throw new Error("Another chunk of this picture failed.");
    if (abandoned()) throw new Error("Nobody is showing this picture any more.");
  };
  stopIfAbandoned();
  const first = await read(0, REMOTE_ARTIFACT_CHUNK_BYTES);
  // Too big to keep: streamed in ranges, never held whole. A display copy
  // counts too: the other machine names its size, and one answer must not be
  // able to make this desktop allocate all of it.
  if (first.totalSize > REMOTE_IMAGE_CACHE_ENTRY_MAX_BYTES) return { kind: "large", first };
  // One buffer of the final size: no list of chunks and second copy to join them.
  const whole = Buffer.alloc(first.totalSize);
  const total = first.totalSize;
  let nextOffset = Math.min(total, first.bytes.copy(whole, 0));
  /** Fills `[offset, offset + length)`; a shorter answer reads the rest. */
  const fillRange = async (offset: number, length: number): Promise<void> => {
    const end = offset + length;
    let at = offset;
    while (at < end) {
      stopIfAbandoned();
      const answer = await read(at, end - at);
      // Every chunk must come from the same copy: the original and the
      // display copy have different bytes and sizes.
      if (answer.display !== first.display || answer.totalSize !== total) {
        throw new Error("The picture changed on the other computer while it was read.");
      }
      const chunk = answer.bytes;
      if (chunk.length === 0) throw new Error("The file ended early on the other computer.");
      at += chunk.copy(whole, at, 0, Math.min(chunk.length, end - at));
    }
  };
  // Several reads in flight keep a slow, far link full: the next chunks are
  // asked for while the one before them is still arriving. The machine's
  // meter decides how many of them, across all its pulls, are out at once.
  const lane = async (): Promise<void> => {
    while (nextOffset < total) {
      stopIfAbandoned();
      const offset = nextOffset;
      const length = Math.min(Math.max(1, planChunkBytes()), total - offset);
      nextOffset += length;
      await fillRange(offset, length);
    }
  };
  const lanes = Array.from({ length: REMOTE_CHUNKS_IN_FLIGHT_MAX }, () => lane());
  await Promise.all(lanes.map((running) => running.catch((error: unknown) => {
    failed = true;
    throw error;
  })));
  imageCache.set(cacheKey, { bytes: whole, display: first.display });
  return { kind: "whole", bytes: whole, display: first.display };
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
  target: { targetId: string; projectId: string; relativePath: string; display?: boolean },
  reader: RemoteArtifactRangeReader | null,
  imageCache: RemoteImageCache,
  meterFor: (targetId: string) => LinkMeter,
  timing: { sleep: (ms: number) => Promise<void> },
  linkRoundTripMs?: (targetId: string) => number | null,
): Promise<void> {
  const image = isImageFile(target.relativePath);
  // Only a picture has a display copy; a video's URL never asks for one.
  // On a fast link the original is as quick and needs no encode there.
  const slowPath = linkWantsSlowPath(meterFor(target.targetId), linkRoundTripMs?.(target.targetId) ?? null);
  const display = image && target.display === true && slowPath;
  const cacheKey = `${target.targetId}\u0000${target.projectId}\u0000${target.relativePath}${display ? "\u0000display" : ""}`;
  /** The served type follows the bytes: a display copy is a JPEG. */
  const servedName = (displayCopy: boolean) => (displayCopy ? `${target.relativePath}.jpg` : target.relativePath);
  const cached = image ? imageCache.get(cacheKey) : null;
  if (cached) {
    serveBuffer(req, res, cached.bytes, servedName(cached.display));
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
  const meter = meterFor(target.targetId);
  const read = (offset: number, length: number) => readRemoteChunk(
    reader,
    meter,
    { ...target, display },
    offset,
    Math.max(1, Math.min(length, REMOTE_ARTIFACT_CHUNK_BYTES)),
    timing.sleep,
    !slowPath,
  );

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
  let probe: RemoteChunk | null = null;

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
        .run(() => pullWholeImage(read, () => meter.chunkBytes(), imageCache, cacheKey, () => created.viewers === 0))
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
      if (!gone) serveBuffer(req, res, pulled.bytes, servedName(pulled.display));
      return;
    }
    if (knownStart === 0) probe = pulled.first;
  }

  probe ??= await readOrFail(knownStart ?? 0, head || knownStart === null ? 1 : REMOTE_ARTIFACT_CHUNK_BYTES);
  if (!probe) return;

  const bytes = writeRangeHead(res, range, probe.totalSize, servedName(probe.display));
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
      if (!chunk) {
        const answer = await read(next, end - next + 1);
        if (answer.display !== probe.display) throw new Error("The file changed on the other computer while it was read.");
        chunk = answer.bytes;
      }
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
  const meters = new Map<string, LinkMeter>();
  const meterFor = (targetId: string): LinkMeter => {
    let meter = meters.get(targetId);
    if (!meter) {
      meter = createRemoteLinkMeter();
      meters.set(targetId, meter);
    }
    return meter;
  };
  const timing = {
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };

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
      : serveRemote(req, res, target, deps.remoteReader(), remoteImageCache, meterFor, timing, deps.linkRoundTripMs);
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
