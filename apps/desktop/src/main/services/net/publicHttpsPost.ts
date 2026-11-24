import https from "node:https";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { isLocalHostname, isPrivateIpAddress, isPublicIpAddress, pinnedLookup } from "./publicHostGuard";

/**
 * POSTs to a URL someone outside ADE gave (a webhook, a notify URL) without
 * letting it reach this computer or a private network. Shared by chat
 * webhooks (`chatWebhookRegistry.ts`) and ADE MCP Events webhooks.
 */

/** Why a URL can't be posted to; each caller words it for its own field. */
export type PublicHttpsUrlProblem = "invalid" | "not_https" | "credentials" | "private";

/** A public https URL, or why it can't be one. Names are resolved and checked again before each POST. */
export function publicHttpsUrlProblem(value: string): PublicHttpsUrlProblem | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "https:") return "not_https";
  if (url.username || url.password) return "credentials";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return (net.isIP(host) ? isPrivateIpAddress(host) : isLocalHostname(host)) ? "private" : null;
}

export type PublicHttpsPostError =
  /** The name resolved to this computer or a private network. */
  | "private_address"
  /** The name did not resolve. */
  | "unresolved"
  | "timeout"
  | "tls_error"
  | "connection_failed";

export type PublicHttpsPostResult = {
  /** The HTTP status; 0 when no answer came. */
  status: number;
  /** At most `maxBodyBytes` of the answer, when `maxBodyBytes` was given. */
  body?: string;
  error?: PublicHttpsPostError;
};

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i;

/**
 * POSTs to the address the name resolved to, checked public, so DNS can't
 * swap in a private one between the check and the request. Never follows a
 * redirect. `timeoutMs` bounds the whole request, not only a silent socket, so
 * an endpoint that sends a byte now and then can't hold the caller.
 */
export async function postToPublicHttps(
  rawUrl: string,
  headers: Record<string, string>,
  body: string,
  options: { timeoutMs: number; maxBodyBytes?: number },
): Promise<PublicHttpsPostResult> {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let target: { address: string; family: number };
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
      return { status: 0, error: "private_address" };
    }
    target = addresses[0]!;
  } catch {
    return { status: 0, error: "unresolved" };
  }
  return await new Promise<PublicHttpsPostResult>((resolve) => {
    let settled = false;
    const finish = (value: PublicHttpsPostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    const request = https.request(url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      lookup: pinnedLookup(target.address, target.family === 6 ? 6 : 4),
      timeout: options.timeoutMs,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const maxBytes = options.maxBodyBytes;
      if (maxBytes === undefined) {
        // Only the status counts: close now, so a body sent a byte at a time can't hold the socket.
        finish({ status });
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        if (size >= maxBytes) return;
        chunks.push(chunk);
        size += chunk.length;
        if (size >= maxBytes) response.destroy();
      });
      const done = () => finish({ status, body: Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8") });
      response.on("end", done);
      response.on("close", done);
    });
    const deadline = setTimeout(() => {
      finish({ status: 0, error: "timeout" });
      request.destroy();
    }, options.timeoutMs);
    deadline.unref?.();
    request.on("timeout", () => {
      finish({ status: 0, error: "timeout" });
      request.destroy();
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      finish({ status: 0, error: TLS_CODES.test(error.code ?? "") ? "tls_error" : "connection_failed" });
    });
    request.end(body);
  });
}
