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
 * retried request with the first one's answer instead of running it twice.
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
 * One brain-to-relay request, tried a second time when the first fails before
 * any HTTP response. Cloudflare closes idle keep-alive connections, and a
 * request written to one that was already closed fails at once with "fetch
 * failed"; the HTTP client drops that connection, so the retry gets a fresh
 * one. Both tries share one deadline. Safe for writes because both carry the
 * same call id, which the receiving brain answers once.
 */
export async function fetchThroughRelayWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const left = deadline - Date.now();
    if (isTimeoutError(error) || left < 1_000) throw error;
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(left) });
  }
}

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
