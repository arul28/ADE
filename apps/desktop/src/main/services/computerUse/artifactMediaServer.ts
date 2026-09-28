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

async function serveRemote(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: { targetId: string; projectId: string; relativePath: string },
  reader: RemoteArtifactRangeReader | null,
): Promise<void> {
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

  const range = parseRangeHeader(req.headers.range);
  const head = req.method === "HEAD";
  // When the start is known, the first chunk also carries the size. A suffix
  // or a HEAD asks for one byte to learn the size first.
  const knownStart = range?.kind === "suffix" ? null : (range?.start ?? 0);
  let probe: { totalSize: number; bytes: Buffer };
  try {
    probe = await read(knownStart ?? 0, head || knownStart === null ? 1 : REMOTE_ARTIFACT_CHUNK_BYTES);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendText(res, 502, message || "The other computer did not send this file.");
    return;
  }

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
      : serveRemote(req, res, target, deps.remoteReader());
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
