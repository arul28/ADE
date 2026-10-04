/**
 * What a browser sees when a tunnel to another machine's port cannot connect.
 *
 * A local forward accepts the browser's TCP connection before it knows whether
 * the remote dial will work, so a failed dial used to close a socket that had
 * never sent a byte. Chromium reports that as `ERR_EMPTY_RESPONSE` on a blank
 * page, which says nothing about where the problem is. When the browser spoke
 * HTTP, the forward answers with a small page instead: what failed, on which
 * machine, and that it retries on its own, so starting the server is enough.
 *
 * Only plain HTTP gets a page. A TLS handshake or any other protocol keeps the
 * old behaviour (the socket closes), because writing HTTP into it would only
 * produce a different, more confusing error.
 */

const HTTP_METHOD_PREFIX = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \S/;
/** Enough of the first chunk to read a method and the start of a target. */
export const FORWARD_FAILURE_SNIFF_BYTES = 16;
/** The page reloads itself, so a server that comes up a moment later just appears. */
const RETRY_SECONDS = 3;

export function looksLikeHttpRequest(firstBytes: Buffer | null | undefined): boolean {
  if (!firstBytes || firstBytes.byteLength === 0) return false;
  return HTTP_METHOD_PREFIX.test(firstBytes.subarray(0, FORWARD_FAILURE_SNIFF_BYTES).toString("latin1"));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A complete `502 Bad Gateway` response, ready to write to the browser socket. */
export function buildForwardFailureResponse(input: {
  remotePort: number;
  machineLabel: string | null;
  reason: string | null;
}): Buffer {
  const machine = input.machineLabel?.trim() || "the connected machine";
  const title = `Nothing is answering on localhost:${input.remotePort} on ${machine}`;
  const reason = input.reason?.trim() || "The connection to that port failed.";
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${RETRY_SECONDS}">
<title>${escapeHtml(`localhost:${input.remotePort} is not running`)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .75rem; }
  p { margin: .5rem 0; opacity: .85; }
  code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: .1rem .35rem; border-radius: 4px; background: color-mix(in srgb, CanvasText 10%, transparent); }
  .reason { opacity: .65; font-size: 12.5px; }
  .retry { margin-top: 1.25rem; font-size: 12.5px; opacity: .6; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>ADE reached ${escapeHtml(machine)}, but no server accepted the connection on port ${input.remotePort}.
Start the dev server there, or check that it is still running.</p>
<p class="reason">${escapeHtml(reason)}</p>
<p class="retry">This page tries again every ${RETRY_SECONDS} seconds.</p>
</main>
</body>
</html>
`;
  const bytes = Buffer.from(body, "utf8");
  const head = [
    "HTTP/1.1 502 Bad Gateway",
    "Content-Type: text/html; charset=utf-8",
    `Content-Length: ${bytes.byteLength}`,
    "Cache-Control: no-store",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  return Buffer.concat([Buffer.from(head, "latin1"), bytes]);
}
