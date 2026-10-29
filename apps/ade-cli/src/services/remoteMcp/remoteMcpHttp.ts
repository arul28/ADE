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
