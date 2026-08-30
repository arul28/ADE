import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { RemoteAttachmentUploadRoute } from "./attachmentUploadRoute";

/** Ticket a host mints over the authenticated sync socket for one upload. */
export type RemoteAttachmentUploadTicket = {
  ticket: string;
  expiresAtMs: number;
  maxBytes: number;
  path: string;
};

export function parseRemoteAttachmentUploadTicket(value: unknown): RemoteAttachmentUploadTicket | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const ticket = typeof record.ticket === "string" ? record.ticket.trim() : "";
  const routePath = typeof record.path === "string" ? record.path.trim() : "";
  const maxBytes = Number(record.maxBytes);
  const expiresAtMs = Number(record.expiresAtMs);
  if (!ticket || !routePath.startsWith("/")) return null;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return null;
  return {
    ticket,
    path: routePath,
    maxBytes: Math.floor(maxBytes),
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
  };
}

const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/**
 * Stream one file to a paired host's attachment-upload route.
 *
 * The body is piped from disk, never buffered: the whole point of this leg is
 * that a 50 MB attachment does not become a 67 MB base64 string in two
 * processes' heaps. Authorization is the single-use ticket the host minted over
 * the already-authenticated sync socket; this request carries no other
 * credential and grants nothing on its own.
 */
export async function uploadRemoteAttachment(args: {
  route: RemoteAttachmentUploadRoute;
  ticket: RemoteAttachmentUploadTicket;
  sourcePath: string;
  timeoutMs?: number;
}): Promise<{ path: string }> {
  const absolute = path.resolve(args.sourcePath);
  const stat = await fs.promises.stat(absolute);
  if (!stat.isFile()) throw new Error("Attachment path is not a file.");
  const limit = Math.min(args.route.maxBytes, args.ticket.maxBytes);
  if (stat.size > limit) {
    throw new Error(`Attachment is larger than the machine accepts (${limit} bytes).`);
  }

  // The ticket names the route path; the capability names the origin. Compose
  // them rather than trusting either alone, so a host that moves the route in a
  // later version is followed without a client change.
  const url = new URL(args.route.url);
  url.pathname = args.ticket.path;
  const transport = url.protocol === "https:" ? https : http;

  return await new Promise<{ path: string }>((resolve, reject) => {
    const body = fs.createReadStream(absolute);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      body.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.ticket.ticket}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(stat.size),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          // Bound the response read: a well-behaved host answers with a small
          // JSON object, and a misbehaving one must not be able to stream into
          // this process's memory.
          if (chunks.length < 64) chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            let message = `Attachment upload failed (HTTP ${status}).`;
            try {
              const parsed = JSON.parse(text) as { error?: unknown };
              if (typeof parsed.error === "string" && parsed.error.trim()) {
                message = parsed.error.trim();
              }
            } catch {
              // Non-JSON body: keep the status-only message.
            }
            fail(new Error(message));
            return;
          }
          let uploadedPath = "";
          try {
            const parsed = JSON.parse(text) as { path?: unknown };
            uploadedPath = typeof parsed.path === "string" ? parsed.path.trim() : "";
          } catch {
            fail(new Error("The machine returned an unreadable upload response."));
            return;
          }
          if (!uploadedPath) {
            fail(new Error("The machine did not return an attachment path."));
            return;
          }
          settled = true;
          resolve({ path: uploadedPath });
        });
        response.on("error", fail);
      },
    );

    request.setTimeout(args.timeoutMs ?? UPLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error("Attachment upload timed out."));
    });
    request.on("error", fail);
    body.on("error", fail);
    body.pipe(request);
  });
}
