import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { MAX_CHAT_ATTACHMENT_BYTES } from "../../../../desktop/src/shared/chatAttachmentLimits";
import {
  projectAttachmentsDir,
  safeAttachmentExtension,
  stagedAttachmentDestPath,
} from "../../../../desktop/src/shared/chatAttachmentStagingFs";

/**
 * Streamed HTTP attachment upload for paired sync clients.
 *
 * The sync stack has no HTTP authentication of its own — the only request the
 * listener answered before this route existed was an unconditional 426. So
 * authorization here is DELEGATED to the already-authenticated WebSocket
 * session: a peer that finished `hello` mints a short-lived, single-use ticket
 * over the command channel (`chat.createAttachmentUpload`) and presents it as
 * an HTTP bearer. The HTTP leg carries no standing authority — a ticket names
 * one project root, one extension, expires in two minutes, and is consumed on
 * first use, so a replay cannot resume a partially uploaded body.
 *
 * The destination basename is always a fresh UUID. The client-supplied filename
 * only ever contributes a validated extension, resolved once at issue time, so
 * a ticket cannot smuggle a path fragment through to the write.
 */

export const ATTACHMENT_UPLOAD_PATH = "/ade-attachments/upload";
export const ATTACHMENT_UPLOAD_TICKET_TTL_MS = 120_000;

export type AttachmentUploadTicket = {
  ticket: string;
  expiresAtMs: number;
  maxBytes: number;
  /** The upload path, so clients never hardcode it. */
  path: string;
};

export type AttachmentUploadRegistry = {
  issue(args: { projectRoot: string; filename: string; deviceId?: string | null }): AttachmentUploadTicket;
  /** True when this request was an upload request (handled, success or failure). */
  handleRequest(request: http.IncomingMessage, response: http.ServerResponse): boolean;
  /** Test/diagnostic seam. */
  pendingCount(): number;
  dispose(): void;
};

type PendingTicket = {
  ticket: string;
  projectRoot: string;
  ext: string;
  expiresAtMs: number;
  deviceId: string | null;
};

/**
 * Same `(event, fields)` shape the rest of the sync stack logs with, so a
 * `SharedSyncListenerLogger` or a host `Logger` can be passed straight through.
 * A looser `(...args: unknown[]) => void` also satisfies it.
 */
type AttachmentUploadLogger = {
  debug?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
};

function bearerTokenFrom(request: http.IncomingMessage): string | null {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

/**
 * Belt and braces over the `Map.get` above it, NOT a constant-time lookup.
 *
 * The hash lookup that finds the ticket is not constant time, so this
 * comparison does not make the whole check constant time and is not claimed to.
 * What protects the ticket is its shape: 32 bytes from `randomBytes`, so there
 * is no low-entropy prefix for a timing oracle to walk toward. This runs anyway
 * because it is free, and because it fails closed if the lookup key and the
 * stored ticket ever stop being the same string.
 */
function equalsStoredTicket(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function writeJson(response: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.headersSent || response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function parseContentLength(request: http.IncomingMessage): number | null {
  const header = request.headers["content-length"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function unlinkQuietly(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // A torn upload may never have created the file; nothing to clean up.
  }
}

type BodyResult = { ok: true } | { ok: false; reason: "too_large" | "io"; message: string };

/**
 * Stream the request body into `partPath`, aborting the moment the running
 * total passes `maxBytes`. A chunked upload with no Content-Length is capped
 * here and nowhere else, so this counter is the real ceiling.
 */
function streamBodyToFile(
  request: http.IncomingMessage,
  partPath: string,
  maxBytes: number,
): Promise<BodyResult> {
  return new Promise<BodyResult>((resolve) => {
    const out = fs.createWriteStream(partPath);
    let total = 0;
    let settled = false;
    let outcome: BodyResult | null = null;
    // Settle only on the write stream's `close`. `createWriteStream` opens its
    // fd asynchronously, so resolving on the abort itself would let the caller
    // unlink the `.part` file BEFORE the open completed — and the open would
    // then recreate it. Waiting for `close` also guarantees the fd is released
    // before the rename, which Windows requires.
    const settle = (result: BodyResult) => {
      if (outcome) return;
      outcome = result;
      out.destroy();
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        request.pause();
        settle({
          ok: false,
          reason: "too_large",
          message: "Attachment exceeds the maximum upload size.",
        });
        return;
      }
      if (!out.write(chunk)) {
        request.pause();
        out.once("drain", () => {
          if (!settled && !outcome) request.resume();
        });
      }
    };
    const onEnd = () => {
      out.end();
    };
    const onRequestError = (error: Error) => {
      settle({ ok: false, reason: "io", message: error.message });
    };
    const onAborted = () => {
      settle({ ok: false, reason: "io", message: "Upload aborted." });
    };
    out.on("error", (error: Error) => {
      settle({ ok: false, reason: "io", message: error.message });
    });
    out.on("close", () => {
      if (settled) return;
      settled = true;
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onRequestError);
      request.off("aborted", onAborted);
      resolve(outcome ?? { ok: true });
    });
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onRequestError);
    request.on("aborted", onAborted);
  });
}

export function createAttachmentUploadRegistry(options?: {
  now?: () => number;
  ttlMs?: number;
  maxBytes?: number;
  logger?: AttachmentUploadLogger;
}): AttachmentUploadRegistry {
  const now = options?.now ?? Date.now;
  const ttlMs = Math.max(1_000, options?.ttlMs ?? ATTACHMENT_UPLOAD_TICKET_TTL_MS);
  const maxBytes = Math.max(1, options?.maxBytes ?? MAX_CHAT_ATTACHMENT_BYTES);
  const logger = options?.logger;
  const pending = new Map<string, PendingTicket>();
  let disposed = false;

  // No timers: the map is swept on every issue and every request, which is the
  // only moment a stale ticket could matter. A timer here would also have to be
  // unref'd to keep short-lived CLI processes from hanging on exit.
  const prune = () => {
    const cutoff = now();
    for (const [key, entry] of pending) {
      if (entry.expiresAtMs <= cutoff) pending.delete(key);
    }
  };

  const respondAndDrop = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    status: number,
    message: string,
  ) => {
    writeJson(response, status, { error: message });
    // The client may still be pushing a body we refuse to read. Let the
    // response flush first, then drop the socket instead of draining megabytes.
    if (response.writableEnded) {
      request.destroy();
      return;
    }
    response.once("finish", () => {
      request.destroy();
    });
    response.once("close", () => {
      request.destroy();
    });
  };

  const run = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    if (disposed) {
      respondAndDrop(request, response, 503, "Attachment upload is not available.");
      return;
    }
    if ((request.method ?? "").toUpperCase() !== "POST") {
      respondAndDrop(request, response, 405, "Method not allowed.");
      return;
    }
    prune();
    const presented = bearerTokenFrom(request);
    if (!presented) {
      respondAndDrop(request, response, 401, "Missing upload ticket.");
      return;
    }
    // The map lookup — not the comparison below it — is what decides whether a
    // ticket is known, and a hash lookup is not constant time. That is fine
    // here: the key is 32 random bytes, so there is no prefix to walk.
    const entry = pending.get(presented);
    // Single use: consume before a single body byte is read, so a replay can
    // never resume a partial upload.
    if (entry) pending.delete(presented);
    if (!entry || !equalsStoredTicket(presented, entry.ticket) || entry.expiresAtMs <= now()) {
      respondAndDrop(request, response, 401, "Invalid or expired upload ticket.");
      return;
    }

    const declaredLength = parseContentLength(request);
    if (declaredLength != null && declaredLength > maxBytes) {
      respondAndDrop(request, response, 413, "Attachment exceeds the maximum upload size.");
      return;
    }

    const attachmentsDir = path.resolve(projectAttachmentsDir(entry.projectRoot));
    // Same UUID-basename + containment-recheck rule the local copy path uses,
    // from the one shared helper, so the two cannot name destinations
    // differently. It throws rather than returns on a containment failure,
    // which the basename being a UUID makes unreachable today.
    let destPath: string;
    try {
      destPath = stagedAttachmentDestPath(attachmentsDir, entry.ext);
    } catch {
      respondAndDrop(request, response, 400, "Invalid upload destination.");
      return;
    }

    const partPath = `${destPath}.part`;
    try {
      await fs.promises.mkdir(attachmentsDir, { recursive: true });
    } catch (error) {
      logger?.warn?.("attachment_upload.mkdir_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      respondAndDrop(request, response, 500, "Unable to prepare the attachment directory.");
      return;
    }

    const result = await streamBodyToFile(request, partPath, maxBytes);
    if (!result.ok) {
      await unlinkQuietly(partPath);
      if (result.reason === "too_large") {
        respondAndDrop(request, response, 413, "Attachment exceeds the maximum upload size.");
        return;
      }
      logger?.debug?.("attachment_upload.body_failed", { error: result.message });
      // The socket is usually already gone on an aborted upload; writeJson
      // no-ops if it is.
      writeJson(response, 400, { error: "Upload failed." });
      return;
    }

    try {
      // Rename only after the full body landed, so a torn upload never leaves a
      // half file at the final path for the chat to pick up.
      await fs.promises.rename(partPath, destPath);
    } catch (error) {
      await unlinkQuietly(partPath);
      logger?.warn?.("attachment_upload.rename_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      writeJson(response, 500, { error: "Unable to store the attachment." });
      return;
    }
    logger?.debug?.("attachment_upload.stored", { deviceId: entry.deviceId, ext: entry.ext });
    writeJson(response, 200, { path: destPath });
  };

  return {
    issue({ projectRoot, filename, deviceId }): AttachmentUploadTicket {
      if (disposed) throw new Error("Attachment upload is not available on this host.");
      const root = typeof projectRoot === "string" ? projectRoot.trim() : "";
      if (!root) throw new Error("Attachment upload requires a project root.");
      prune();
      const ticket = randomBytes(32).toString("base64url");
      const expiresAtMs = now() + ttlMs;
      pending.set(ticket, {
        ticket,
        projectRoot: root,
        ext: safeAttachmentExtension(typeof filename === "string" ? filename : ""),
        expiresAtMs,
        deviceId: typeof deviceId === "string" && deviceId.trim() ? deviceId.trim() : null,
      });
      return { ticket, expiresAtMs, maxBytes, path: ATTACHMENT_UPLOAD_PATH };
    },

    handleRequest(request: http.IncomingMessage, response: http.ServerResponse): boolean {
      let pathname: string;
      try {
        // Parsed, never string-compared: a query string or a `//` prefix must
        // not slip past into the 426 fall-through (or vice versa).
        pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      } catch {
        return false;
      }
      if (pathname !== ATTACHMENT_UPLOAD_PATH) return false;
      void run(request, response).catch((error: unknown) => {
        logger?.warn?.("attachment_upload.unhandled_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        writeJson(response, 500, { error: "Upload failed." });
      });
      return true;
    },

    pendingCount(): number {
      return pending.size;
    },

    dispose(): void {
      disposed = true;
      pending.clear();
    },
  };
}
