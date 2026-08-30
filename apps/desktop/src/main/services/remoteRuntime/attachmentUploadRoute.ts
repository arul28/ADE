import type { PairedRuntimeHelloOkPayload } from "../../../shared/types/pairedRuntime";

export type RemoteAttachmentUploadRoute = {
  /** Absolute URL to POST the attachment body to. */
  url: string;
  /** Host-declared ceiling; the client rejects larger files before uploading. */
  maxBytes: number;
};

/**
 * Where — if anywhere — this paired connection can accept a streamed HTTP
 * attachment upload.
 *
 * Three independent things all have to hold, and each one failing is a normal
 * outcome that falls back to base64 rather than an error:
 *
 * 1. The host advertised `features.attachmentUploadV1`. Hosts older than the
 *    feature omit it, per the additive-capability rule.
 * 2. The socket is a DIRECT one. A relay-routed connection terminates at the
 *    relay, which brokers WebSocket frames and nothing else — an HTTP POST to
 *    that URL would never reach the host's own listener. `connectionTransport`
 *    is the host's own statement about which it is.
 * 3. The endpoint is a `ws:`/`wss:` URL we can map to `http:`/`https:`. The
 *    sync HTTP server and the WebSocket share one port, so the origin is the
 *    endpoint's with the scheme swapped and the path replaced.
 */
export function resolveRemoteAttachmentUploadRoute(args: {
  endpoint: string;
  hello: Pick<PairedRuntimeHelloOkPayload, "features" | "connectionTransport"> | null | undefined;
}): RemoteAttachmentUploadRoute | null {
  const capability = args.hello?.features?.attachmentUploadV1;
  if (capability?.enabled !== true) return null;
  if (args.hello?.connectionTransport === "relay") return null;

  const routePath = typeof capability.path === "string" ? capability.path.trim() : "";
  if (!routePath.startsWith("/")) return null;
  const maxBytes = Number(capability.maxBytes);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return null;

  let url: URL;
  try {
    url = new URL(args.endpoint);
  } catch {
    return null;
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else return null;

  url.pathname = routePath;
  url.search = "";
  url.hash = "";
  return { url: url.toString(), maxBytes: Math.floor(maxBytes) };
}
