/**
 * The bits every token-guarded loopback video server in ADE needs.
 *
 * Two of them exist — the iOS simulator's host encoder and the Mac Desktop
 * display's — and they had independently grown the same seven things: a
 * constant-time token compare, a 4 MiB per-reader backlog ceiling, a 3 s grace
 * after the last reader leaves, the CORS/OPTIONS/404/403 preamble, the
 * `setNoDelay` + `flushHeaders` opening of a chunked body, a listener bound to
 * an ephemeral loopback port with timeouts disabled, and the write-with-backlog
 * accounting. Two copies of a security-shaped detail is one copy that can be
 * fixed and one that cannot, so they live here and both servers import them.
 *
 * Nothing in this module knows about H.264, simulators or lanes: it is the
 * transport's floor, and the framing above it stays each server's own.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A reader this far behind is not going to catch up. Dropping bytes would
 * corrupt every later frame — the encoders emit one IDR per run — so the only
 * honest recovery is to close the response and let the reader reconnect into a
 * fresh keyframe.
 */
export const MAX_CLIENT_BACKLOG_BYTES = 4 * 1024 * 1024;

/**
 * How long an encoder stays warm after its last reader leaves.
 *
 * A page reload drops and re-adds a client inside a few hundred milliseconds;
 * tearing the encoder down for that costs a restart and a fresh keyframe for
 * nothing.
 */
export const ZERO_CLIENT_GRACE_MS = 3_000;

/** Constant-time token compare. Hashed first so the length is never a tell. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Binds one HTTP listener on an ephemeral loopback port.
 *
 * `keepAliveTimeout` and `requestTimeout` are zeroed because a live view that
 * goes quiet — an idle desktop, a paused simulator — is not a stuck request,
 * and Node's defaults would tear it down as if it were.
 */
export async function bindLoopbackServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  options: { bindErrorMessage: string },
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  server.keepAliveTimeout = 0;
  server.headersTimeout = 60_000;
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address.port !== "number") {
    server.close();
    throw new Error(options.bindErrorMessage);
  }
  return { server, port: address.port };
}

/**
 * The preamble every request answers, and whether the caller is done.
 *
 * Returns true when the request was a CORS preflight and has been answered.
 * The renderer's origin is `app:` or `file:`, which is opaque, so a
 * same-origin check would reject the only legitimate caller — the token is
 * what authorises the read, and these headers only stop the browser from
 * hiding the response from it.
 */
export function answerLoopbackPreamble(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "OPTIONS") return false;
  response.writeHead(204, { "Access-Control-Allow-Headers": "*" });
  response.end();
  return true;
}

/**
 * Opens a chunked body for a live reader.
 *
 * `flushHeaders` is not cosmetic: Node holds the head until the first body
 * write, and the first body write waits on the encoder's first keyframe, so
 * without it a reader cannot tell a slow start from a dead server.
 */
export function openStreamBody(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "application/octet-stream",
    Connection: "keep-alive",
  });
  // Nagle trades latency for a saving this bitrate does not need.
  request.socket.setNoDelay(true);
  response.flushHeaders();
}

/** A reader with its own backlog accounting. */
export type BacklogClient = { backlogBytes: number };

/**
 * Writes one chunk to a reader, charging it against that reader's backlog.
 *
 * The write callback fires for a synchronous write too, so releasing in both
 * the caller and the callback would double-count and push the drop threshold
 * far past the ceiling this rule exists to enforce. Release in one place only.
 *
 * Returns false when the reader was dropped instead of written to.
 */
export function writeWithBacklog(
  client: BacklogClient,
  response: ServerResponse,
  chunk: Uint8Array,
  onDrop: (reason: "backlog") => void,
): boolean {
  client.backlogBytes += chunk.byteLength;
  if (client.backlogBytes > MAX_CLIENT_BACKLOG_BYTES) {
    onDrop("backlog");
    return false;
  }
  let released = false;
  response.write(chunk, () => {
    if (released) return;
    released = true;
    client.backlogBytes = Math.max(0, client.backlogBytes - chunk.byteLength);
  });
  return true;
}

/**
 * Copies an upstream socket into a response with the same backlog rule.
 *
 * Used by the server whose encoder is a separate process handing back a TCP
 * port: one upstream connection per reader, so a reader that attaches late
 * gets that helper's own config record and keyframe.
 */
export function pipeWithBacklog(
  upstream: {
    on: (event: "data", handler: (chunk: Buffer) => void) => unknown;
    setNoDelay?: (value: boolean) => unknown;
  },
  client: BacklogClient,
  response: ServerResponse,
  handlers: { onDrop: (reason: "backlog") => void; onBytes?: (byteLength: number) => void },
): void {
  upstream.setNoDelay?.(true);
  upstream.on("data", (chunk: Buffer) => {
    handlers.onBytes?.(chunk.byteLength);
    writeWithBacklog(client, response, chunk, handlers.onDrop);
  });
}
