import {
  generateConnectionId,
  jsonResponse,
  logTunnel,
  MACHINE_KEY_PATTERN,
  MCP_CORS_HEADERS,
  MCP_MACHINE_OFF_DESCRIPTION,
  MCP_MACHINE_OFFLINE_DESCRIPTION,
  MCP_MAX_REQUEST_BYTES,
  MCP_UNDELIVERED_HEADER,
  mcpErrorResponse,
  readBytesCapped,
} from "./relayShared";

/**
 * ADE MCP on a machine object: HTTP requests forwarded to the brain over its
 * control socket and answered by rid, plus the `mcp-endpoint:<key>` object.
 * Limits are per machine and live in instance memory: a hibernated object has
 * no requests in flight, so nothing is lost by a reset.
 */

const MCP_MAX_IN_FLIGHT = 16;
const MCP_MAX_PER_MINUTE = 300;
// The brain stops a command after 10 minutes; give its answer time to arrive.
const MCP_RESPONSE_TIMEOUT_MS = 11 * 60 * 1000;
// The brain refuses a longer path; refusing it here answers at once instead of
// leaving the request to wait out MCP_RESPONSE_TIMEOUT_MS.
const MCP_MAX_PATH_CHARS = 8_192;
const MCP_FORWARDED_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "user-agent",
  // Set by a brain that forwards a call to another computer on the account; the
  // target refuses a second hop and logs it. A client's copy only stops forwarding.
  "x-ade-mcp-via",
];
const MCP_RETURNED_RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "www-authenticate",
  "location",
  "allow",
  "x-frame-options",
  "content-security-policy",
  "referrer-policy",
  "x-content-type-options",
]);
const MCP_METHODS = new Set(["GET", "POST", "DELETE", "HEAD"]);
const textDecoder = new TextDecoder();

/** Which address an MCP request came in on; absent for the per-machine one. */
export type McpMount = { kind: "account"; key: string };

type PendingMcpRequest = {
  control: WebSocket;
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** One machine object's in-flight requests and rate window. */
export type McpForwarding = {
  pending: Map<string, PendingMcpRequest>;
  windowStart: number;
  windowCount: number;
};

export function createMcpForwarding(): McpForwarding {
  return { pending: new Map(), windowStart: 0, windowCount: 0 };
}

/** The machine's live control socket, as far as ADE MCP cares. */
export type McpControl = {
  socket: WebSocket;
  /** The brain said ADE MCP is on. */
  enabled: boolean;
  /** The account this machine joined on that socket. */
  accountKey: string | undefined;
};

/**
 * Forwards one HTTP request to the brain over its control socket and waits
 * for its answer. The relay understands none of it (MCP, OAuth, tokens all
 * live on the machine); it only refuses early when the machine is offline or
 * has the feature off, and bounds the traffic. `onStaleAccount` is told when
 * an account request arrives for an account this machine is not on.
 */
export async function forwardMcp(
  fwd: McpForwarding,
  request: Request,
  path: string,
  control: McpControl | null,
  mount?: McpMount,
  onStaleAccount?: (accountKey: string) => void,
): Promise<Response> {
  if (!MCP_METHODS.has(request.method)) return mcpErrorResponse(405, "method_not_allowed", "Method not allowed.");
  if (path.length > MCP_MAX_PATH_CHARS) return mcpErrorResponse(414, "uri_too_long", "Request address too long.");
  // On the account address, a refusal the brain never saw tells the Worker
  // it may try the account's next computer.
  const undelivered = (reason: "offline" | "ade_mcp_off"): Record<string, string> => (
    mount ? { [MCP_UNDELIVERED_HEADER]: reason } : {}
  );
  if (!control) {
    return mcpErrorResponse(503, "offline", MCP_MACHINE_OFFLINE_DESCRIPTION, {
      "retry-after": "30",
      ...undelivered("offline"),
    });
  }
  if (!control.enabled) {
    return mcpErrorResponse(404, "ade_mcp_off", MCP_MACHINE_OFF_DESCRIPTION, undelivered("ade_mcp_off"));
  }
  // A machine still listed on an account it has left (or never joined on
  // this socket) does not answer for it.
  if (mount && control.accountKey !== mount.key) {
    onStaleAccount?.(mount.key);
    return mcpErrorResponse(404, "ade_mcp_off", "ADE MCP is off for this account on that computer.", undelivered("ade_mcp_off"));
  }
  const now = Date.now();
  if (now - fwd.windowStart >= 60_000) {
    fwd.windowStart = now;
    fwd.windowCount = 0;
  }
  if (fwd.pending.size >= MCP_MAX_IN_FLIGHT || fwd.windowCount >= MCP_MAX_PER_MINUTE) {
    logTunnel("mcp_rejected", { reason: "rate_limited", inFlight: fwd.pending.size });
    return mcpErrorResponse(429, "rate_limited", "Too many requests to that computer. Retry shortly.", { "retry-after": "5" });
  }
  fwd.windowCount += 1;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MCP_MAX_REQUEST_BYTES) {
    return mcpErrorResponse(413, "too_large", "Request too large.");
  }
  let body: string | null = null;
  if (request.method === "POST") {
    const bytes = request.body ? await readBytesCapped(request.body, MCP_MAX_REQUEST_BYTES) : new ArrayBuffer(0);
    if (bytes === null) return mcpErrorResponse(413, "too_large", "Request too large.");
    body = textDecoder.decode(bytes);
  }
  const headers: Record<string, string> = {};
  for (const name of MCP_FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null && value.length <= 8_192) headers[name] = value;
  }
  const socket = control.socket;
  const rid = generateConnectionId();
  const response = new Promise<Response>((resolve) => {
    const timer = setTimeout(() => {
      fwd.pending.delete(rid);
      resolve(mcpErrorResponse(504, "timeout", "That computer took too long to answer."));
    }, MCP_RESPONSE_TIMEOUT_MS);
    fwd.pending.set(rid, { control: socket, resolve, timer });
  });
  try {
    socket.send(JSON.stringify(mount
      ? { t: "http", rid, method: request.method, path, headers, body, mount }
      : { t: "http", rid, method: request.method, path, headers, body }));
  } catch {
    // A send that throws queued nothing: the brain never saw it.
    settleMcp(fwd, rid, mcpErrorResponse(503, "offline", MCP_MACHINE_OFFLINE_DESCRIPTION, undelivered("offline")));
  }
  return response;
}

function settleMcp(fwd: McpForwarding, rid: string, response: Response): void {
  const pending = fwd.pending.get(rid);
  if (!pending) return;
  fwd.pending.delete(rid);
  clearTimeout(pending.timer);
  pending.resolve(response);
}

/** The brain's `http_res`: only the socket the request went out on may answer it. */
export function answerMcp(fwd: McpForwarding, control: WebSocket, parsed: Record<string, unknown>): void {
  const rid = parsed.rid;
  if (typeof rid !== "string" || fwd.pending.get(rid)?.control !== control) return;
  settleMcp(fwd, rid, mcpResponseFromBrain(parsed));
}

/** Builds the client's response from the brain's answer, keeping only known headers. */
function mcpResponseFromBrain(parsed: Record<string, unknown>): Response {
  const status = typeof parsed.status === "number" && Number.isInteger(parsed.status)
    && parsed.status >= 200 && parsed.status <= 599
    ? parsed.status
    : 502;
  const headers = new Headers(MCP_CORS_HEADERS);
  if (parsed.headers && typeof parsed.headers === "object" && !Array.isArray(parsed.headers)) {
    for (const [key, value] of Object.entries(parsed.headers as Record<string, unknown>)) {
      const name = key.toLowerCase();
      if (MCP_RETURNED_RESPONSE_HEADERS.has(name) && typeof value === "string" && !/[\r\n]/.test(value)) {
        headers.set(name, value);
      }
    }
  }
  const body = typeof parsed.body === "string" ? parsed.body : "";
  const empty = status === 204 || status === 304 || (status === 202 && body === "");
  return new Response(empty ? null : body, { status, headers });
}

/** A control socket went away: nothing it was asked can be answered now. */
export function failMcpForControl(fwd: McpForwarding, control: WebSocket): void {
  for (const [rid, pending] of fwd.pending) {
    if (pending.control !== control) continue;
    settleMcp(fwd, rid, mcpErrorResponse(503, "offline", "That computer went offline before it answered."));
  }
}

/** The `mcp-endpoint:<key>` object: which machine an MCP endpoint key belongs to. */
export async function handleMcpEndpoint(storage: DurableObjectStorage, request: Request): Promise<Response> {
  const stored = await storage.get<string>("mcpEndpointMachineKey");
  if (request.method === "GET") {
    return stored ? jsonResponse({ machineKey: stored }) : jsonResponse({ error: "unknown" }, { status: 404 });
  }
  if (request.method !== "PUT") return new Response("method not allowed", { status: 405 });
  const machineKey = (await request.text()).trim();
  if (!MACHINE_KEY_PATTERN.test(machineKey)) return new Response("bad machine key", { status: 400 });
  if (stored && stored !== machineKey) {
    logTunnel("mcp_endpoint_conflict", {});
    return new Response("endpoint key already registered", { status: 409 });
  }
  if (!stored) await storage.put("mcpEndpointMachineKey", machineKey);
  return new Response(null, { status: 204 });
}
