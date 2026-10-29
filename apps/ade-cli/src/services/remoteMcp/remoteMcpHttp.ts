import http from "node:http";
import https from "node:https";

/**
 * The HTTP that ADE MCP answers: one request the relay forwarded over the
 * brain's control socket, and the answer that goes back. Shared by the
 * service's routes (remoteMcpService.ts) and its OAuth routes
 * (remoteMcpOAuthRoutes.ts).
 */

export type RemoteMcpHttpRequest = {
  method: string;
  /** Path under the machine prefix, with query, e.g. `/oauth/authorize?…`. */
  path: string;
  headers: Record<string, string>;
  body: string | null;
  /** Set by the relay when the request came on the account address. */
  mount?: { kind: "account"; key: string };
};

export type RemoteMcpHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type RemoteMcpRelayEndpoint = {
  relayUrl: string;
  /** This computer's relay machine key: its id in the account directory and settings. */
  machineKey: string;
  /** The key in the per-machine URL; not the relay key (see mcpEndpointKeyFor). */
  endpointKey: string;
  connected: boolean;
  /** The owner turned ADE Relay off on this computer. */
  turnedOff?: boolean;
};

export function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function json(status: number, value: unknown, headers: Record<string, string> = {}): RemoteMcpHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    body: JSON.stringify(value),
  };
}

/** A request header by name, whatever its case. */
export function header(request: RemoteMcpHttpRequest, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return "";
}

// ── Brain → relay requests ──────────────────────────────────────────────────

/**
 * Sent with every request one brain makes to another through the relay (a
 * forwarded tool call, a token exchange), so the receiving brain can answer a
 * repeated request with the first one's answer instead of running it twice.
 * A guard, not a licence to retry: see fetchThroughRelayWithRetry.
 */
export const REMOTE_MCP_CALL_ID_HEADER = "x-ade-mcp-call-id";
const CALL_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** The call id a request carries, when it is one this code would send. */
export function requestCallId(request: RemoteMcpHttpRequest): string | null {
  const value = header(request, REMOTE_MCP_CALL_ID_HEADER).trim();
  return CALL_ID_PATTERN.test(value) ? value : null;
}

/** An error the request's own deadline raised. */
export function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

/** The low-level code behind a failed fetch (`ECONNRESET`, `UND_ERR_SOCKET`, `ENOTFOUND`), when there is one. */
export function networkErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Where the request could not go, as one sentence with the cause code: never a bare "fetch failed". */
export function describeNetworkError(error: unknown, target: string): string {
  const code = networkErrorCode(error);
  const suffix = code ? ` (${code})` : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENETUNREACH" || code === "EHOSTUNREACH") {
    return `This computer couldn't reach ADE Relay to get to ${target}${suffix}. Check its internet connection, then try again.`;
  }
  return `The connection to ${target} through ADE Relay dropped${suffix}. Try again in a moment.`;
}

/**
 * Failures that happen before a connection exists (no address, refused,
 * connect timeout), so the request never left this computer. A reset or a
 * closed socket is not one of them: on a reused keep-alive connection the
 * request may already have been written, and the other end may have run it.
 */
const NOTHING_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * One brain-to-relay request, tried a second time when the first fails before
 * any HTTP response. Both tries share one deadline; a timeout is never
 * retried.
 *
 * A failure that proves nothing was sent (`NOTHING_SENT_CODES`) is always
 * retried. Any other one (Cloudflare closing an idle keep-alive connection
 * shows up as a reset or "other side closed") may have reached the other
 * computer, so it is retried only with `retryAfterSend`: a read that is safe
 * to run twice, sent over the shared connection pool. A write or a token
 * exchange is never sent twice, because the call id that lets the receiving
 * brain answer a repeat once only helps when that brain and the relay in
 * between know it (an older ADE, or a relay that drops the header, would run
 * it again). The call id is still sent. Those go through
 * `fetchOnFreshConnection` instead, so they are never written to an idle
 * keep-alive socket the relay has already closed: the failure a retry would
 * have covered can't happen to them.
 */
export async function fetchThroughRelayWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
  options: { retryAfterSend: boolean },
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const left = deadline - Date.now();
    if (isTimeoutError(error) || left < 1_000) throw error;
    const code = networkErrorCode(error);
    const nothingSent = code !== null && NOTHING_SENT_CODES.has(code);
    if (!nothingSent && !options.retryAfterSend) throw error;
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(left) });
  }
}

/** Statuses whose response has no body; `new Response` refuses one. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * `fetch` for one request on a connection of its own, closed after it: never
 * a socket from a keep-alive pool. For brain-to-relay writes, which must not
 * be retried (see fetchThroughRelayWithRetry). Built on `node:http(s)` with
 * no agent, so it behaves the same under Electron's Node, standalone Node and
 * on Windows (the bundled undici's own `Agent` is not reachable from either).
 * Covers what those calls use: a string body, headers, a signal. Redirects
 * are returned, not followed, and the body is asked for uncompressed.
 */
export const fetchOnFreshConnection: typeof fetch = (input, init) => new Promise<Response>((resolve, reject) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const signal = init?.signal ?? null;
  if (signal?.aborted) {
    reject(signal.reason);
    return;
  }
  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof URLSearchParams)) {
    reject(new TypeError("fetchOnFreshConnection sends only a string body."));
    return;
  }
  const payload = body === undefined || body === null ? null : Buffer.from(body.toString(), "utf8");
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
  if (payload) headers["content-length"] = String(payload.length);
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!transport) {
    reject(new TypeError(`fetchOnFreshConnection can't fetch ${url.protocol} URLs.`));
    return;
  }
  // No agent: a new connection for this request alone, closed when it ends.
  const request = transport.request(url, { method: init?.method ?? "GET", headers, agent: false });
  const onAbort = (): void => {
    request.destroy();
    reject(signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const done = (): void => signal?.removeEventListener("abort", onAbort);
  request.on("error", (error) => {
    done();
    reject(error);
  });
  request.on("response", (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("error", (error) => {
      done();
      reject(error);
    });
    response.on("end", () => {
      done();
      // Inside a stream listener a throw would be uncaught and take the brain
      // down: `new Response` refuses a status outside 200–599, which the
      // parser accepts, and `Headers` refuses a malformed header.
      try {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
          else if (value !== undefined) responseHeaders.set(key, value);
        }
        const status = response.statusCode ?? 502;
        resolve(new Response(NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks), {
          status,
          statusText: response.statusMessage ?? "",
          headers: responseHeaders,
        }));
      } catch (error) {
        reject(error);
      }
    });
  });
  request.end(payload ?? undefined);
});

/**
 * Answers a repeated request once. A request whose key is in flight waits for
 * the first one's answer; one that finished in the last `ttlMs` gets the same
 * answer again. Keys are scoped by the caller (connection id + call id), so
 * one app never reads another's answer. A failed run is forgotten, so its
 * retry runs again.
 */
export function createRemoteMcpReplayGuard<T>(options: { ttlMs: number; max?: number; now?: () => number }) {
  const now = options.now ?? Date.now;
  const max = options.max ?? 500;
  const entries = new Map<string, { settledAt: number | null; answer: Promise<T> }>();
  const sweep = (): void => {
    const cutoff = now() - options.ttlMs;
    let over = entries.size - max;
    for (const [key, entry] of entries) {
      if (entry.settledAt === null) continue;
      if (entry.settledAt < cutoff || over > 0) {
        entries.delete(key);
        over -= 1;
      }
    }
  };
  return {
    run(key: string, compute: () => Promise<T>): Promise<T> {
      sweep();
      const existing = entries.get(key);
      if (existing) return existing.answer;
      const entry: { settledAt: number | null; answer: Promise<T> } = { settledAt: null, answer: compute() };
      entries.set(key, entry);
      entry.answer.then(
        () => { entry.settledAt = now(); },
        () => { if (entries.get(key) === entry) entries.delete(key); },
      );
      return entry.answer;
    },
  };
}
