import { TunnelDurableObject } from "./tunnelDo";
import {
  cloudflareTransientKind,
  fetchDurableObject,
  logCloudflareTransient,
  transientUnavailableResponse,
} from "./cloudflareTransient";
import {
  jsonResponse,
  logTunnel,
  MCP_ACCOUNT_FRONT_PATH,
  MCP_ACCOUNT_PATH,
  MCP_CORS_HEADERS,
  MCP_ENDPOINT_PATH,
  MCP_MACHINE_OFF_DESCRIPTION,
  MCP_MAX_REQUEST_BYTES,
  MCP_MOUNT_HEADER,
  MCP_UNDELIVERED_HEADER,
  mcpAccountObjectName,
  mcpEndpointObjectName,
  mcpErrorResponse,
  readBytesCapped,
  routeMcpPath,
  routeTunnelPath,
  validKey,
  type McpAccountState,
  type TunnelRelayEnv,
  type TunnelRoute,
} from "./relayShared";
import { scrubString } from "./sentryScrub";

export { TunnelDurableObject };
// The Worker entry point's public surface for index.ts and the tests.
export {
  buildHostSignatureBase,
  buildPipeSignatureBase,
  CONNECTION_ID_PATTERN,
  generateConnectionId,
  hmacSha256Hex,
  mcpAccountKeyForSecret,
  routeMcpPath,
  routeTunnelPath,
  verifySignedQuery,
  type TunnelRelayEnv,
} from "./relayShared";

function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Either ADE MCP route: answered with MCP_CORS_HEADERS, OPTIONS by the Worker. */
function isMcpRoute(route: TunnelRoute | null): route is Extract<TunnelRoute, { kind: "mcp" | "mcp-account" }> {
  return route?.kind === "mcp" || route?.kind === "mcp-account";
}

/** The regions Cloudflare accepts as a Durable Object placement hint. */
export type RelayLocationHint = DurableObjectLocationHint;

/**
 * The subset of `request.cf` this router reads, kept looser than Cloudflare's
 * own types: `wrangler dev` omits `cf` entirely and miniflare will hand back
 * whatever a test supplies.
 */
export type RequestPlacementGeo = {
  continent?: string | null;
  longitude?: string | number | null;
};

function parseLongitude(raw: unknown): number | null {
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
  return Number.isFinite(value) && value >= -180 && value <= 180 ? value : null;
}

/**
 * Maps the requester's coarse geography onto a Durable Object location hint.
 * Only the machine's own routes (claim/host) supply one: a Durable Object is
 * placed near whichever request creates it, so without a hint a phone that
 * connects before the brain claims would pin the object next to the phone for
 * the life of the machine key. Cloudflare ignores the hint for an object that
 * already exists, so this only steers brand-new machines.
 */
export function locationHintForGeo(
  geo: RequestPlacementGeo | null | undefined,
): RelayLocationHint | undefined {
  const continent = typeof geo?.continent === "string" ? geo.continent.trim().toUpperCase() : "";
  const longitude = parseLongitude(geo?.longitude);
  // Three continents span more than one Cloudflare region: the Americas and
  // Europe split east/west, and western Asia is served by `me`. Each falls back
  // to its most populous region when the longitude is missing.
  switch (continent) {
    case "NA":
      return longitude != null && longitude <= -100 ? "wnam" : "enam";
    case "SA":
      return "sam";
    case "EU":
      return longitude != null && longitude >= 20 ? "eeur" : "weur";
    case "AF":
      return "afr";
    case "OC":
      return "oc";
    case "AS":
      return longitude != null && longitude < 65 ? "me" : "apac";
    default:
      // Unknown or absent geography: let Cloudflare place the object itself.
      return undefined;
  }
}

const MAX_CACHED_ENDPOINTS = 1_000;
const endpointCache = new Map<string, string>();

async function resolveMcpEndpoint(env: TunnelRelayEnv, endpointKey: string): Promise<string | null> {
  const cached = endpointCache.get(endpointKey);
  if (cached) return cached;
  const id = env.TUNNEL.idFromName(mcpEndpointObjectName(endpointKey));
  const response = await fetchDurableObject(
    () => env.TUNNEL.get(id),
    new Request(`https://relay.internal${MCP_ENDPOINT_PATH}`),
  );
  if (!response.ok) return null;
  const machineKey = ((await response.json()) as { machineKey?: unknown }).machineKey;
  if (typeof machineKey !== "string" || !validKey(machineKey)) return null;
  if (endpointCache.size >= MAX_CACHED_ENDPOINTS) endpointCache.clear();
  endpointCache.set(endpointKey, machineKey);
  return machineKey;
}

/** Machines to try for an account request: the front first, then newest-first. */
function mcpAccountCandidates(state: McpAccountState): string[] {
  const newestFirst = [...state.members].reverse();
  if (!state.front || !newestFirst.includes(state.front)) return newestFirst;
  return [state.front, ...newestFirst.filter((key) => key !== state.front)];
}

type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

const MCP_ACCOUNT_OFF_DESCRIPTION =
  "ADE MCP is off for this account. Turn it on in ADE Settings → ADE MCP on one of your computers.";
const MCP_ACCOUNT_UNKNOWN_DESCRIPTION =
  "No computer answers this ADE MCP address. It may be an old address: copy the Server URL from ADE Settings → ADE MCP.";
const MCP_ACCOUNT_OFFLINE_DESCRIPTION =
  "None of your computers with ADE MCP on are online. Open ADE on one of them, or try again shortly.";

/**
 * An account request. Each computer on the account is tried in turn (the one
 * that last answered first, then the newest), and the next is tried only when
 * a machine object refused before its brain could see the request (offline,
 * or ADE MCP off there). Any other answer is final: a request a brain may have
 * received is never sent to a second one. The body is buffered (1 MiB cap) so
 * it can be resent.
 */
async function handleAccountMcp(
  request: Request,
  env: TunnelRelayEnv,
  accountKey: string,
  ctx: WaitUntil | undefined,
): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MCP_MAX_REQUEST_BYTES) {
    return mcpErrorResponse(413, "too_large", "Request too large.");
  }
  // Only a POST body ever reaches the brain; the machine object answers other
  // methods without reading theirs.
  let body: ArrayBuffer | null = null;
  if (request.method === "POST" && request.body) {
    body = await readBytesCapped(request.body, MCP_MAX_REQUEST_BYTES);
    if (body === null) return mcpErrorResponse(413, "too_large", "Request too large.");
  }

  const accountId = env.TUNNEL.idFromName(mcpAccountObjectName(accountKey));
  const stateResponse = await fetchDurableObject(
    () => env.TUNNEL.get(accountId),
    new Request(`https://relay.internal${MCP_ACCOUNT_PATH}`),
  );
  if (!stateResponse.ok) return transientUnavailableResponse(MCP_CORS_HEADERS);
  const state = (await stateResponse.json()) as McpAccountState;
  const candidates = mcpAccountCandidates(state);

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set(MCP_MOUNT_HEADER, `a/${accountKey}`);
  let sawOffline = false;
  let sawOff = false;
  for (const machineKey of candidates) {
    if (!validKey(machineKey)) continue;
    const id = env.TUNNEL.idFromName(machineKey);
    // `manual`: a brain's 302 (the OAuth authorize form's redirect to sign-in)
    // goes back to the client as is. The default, `follow`, made the Worker
    // follow it itself and answer the client with whatever that page said.
    const forwarded = new Request(request.url, { method: request.method, headers, body, redirect: "manual" });
    // May reach a brain: never sent twice, whatever its method.
    const response = await fetchDurableObject(() => env.TUNNEL.get(id), forwarded, { retry: "never" });
    const undelivered = response.headers.get(MCP_UNDELIVERED_HEADER);
    if (
      (response.status === 503 && undelivered === "offline")
      || (response.status === 404 && (undelivered === "ade_mcp_off" || undelivered === "not_member"))
    ) {
      if (undelivered === "offline") sawOffline = true;
      if (undelivered === "ade_mcp_off") sawOff = true;
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (machineKey !== state.front) {
      const recordFront = fetchDurableObject(
        () => env.TUNNEL.get(accountId),
        new Request(`https://relay.internal${MCP_ACCOUNT_FRONT_PATH}`, {
          method: "POST",
          body: JSON.stringify({ machineKey }),
        }),
        { retry: "replayable" },
      ).then(
        async (answer) => {
          // 409: the machine left the account since it was read.
          if (!answer.ok) logTunnel("mcp_account_front_failed", { account: accountKey.slice(0, 8), status: answer.status });
          await answer.body?.cancel();
        },
        (error: unknown) => {
          logTunnel("mcp_account_front_failed", {
            account: accountKey.slice(0, 8),
            error: error instanceof Error ? error.name : "unknown",
          });
        },
      );
      if (ctx) ctx.waitUntil(recordFront);
    }
    return response;
  }
  if (sawOffline) return mcpErrorResponse(503, "offline", MCP_ACCOUNT_OFFLINE_DESCRIPTION, { "retry-after": "30" });
  // Both stay `404 ade_mcp_off` for clients that read the code; `reason` says
  // which. "Off" needs evidence: a computer that answered it is off, or one
  // that left the account because ADE MCP was turned off there. An address
  // nothing ever served, or whose computers all moved to another account (its
  // secret changed), is an old or wrong address.
  if (sawOff || (state.off?.length ?? 0) > 0) {
    return mcpErrorResponse(404, "ade_mcp_off", MCP_ACCOUNT_OFF_DESCRIPTION, {}, { reason: "off" });
  }
  return mcpErrorResponse(404, "ade_mcp_off", MCP_ACCOUNT_UNKNOWN_DESCRIPTION, {}, { reason: "unknown_address" });
}

/**
 * Durable Objects restart under Cloudflare now and then ("storage is no longer
 * accessible", "instance is no longer active", "internal error; reference =
 * …"). A request that can be sent twice gets one more try on a fresh stub
 * (`fetchDurableObject`); anything still failing, including every WebSocket
 * upgrade, is answered 503 with Retry-After instead of an unhandled 500. The
 * brain's control socket and the phone both reconnect on a failed upgrade with
 * their usual backoff, whatever its status.
 */
export async function handleRequest(request: Request, env: TunnelRelayEnv, ctx?: WaitUntil): Promise<Response> {
  try {
    return await routeRequest(request, env, ctx);
  } catch (error) {
    const kind = cloudflareTransientKind(error);
    if (!kind) throw error;
    const url = new URL(request.url);
    logCloudflareTransient("ade-tunnel-relay", kind, scrubString(url.pathname), error);
    const mcp = isMcpRoute(routeTunnelPath(url.pathname) ?? routeMcpPath(url));
    return transientUnavailableResponse(mcp ? MCP_CORS_HEADERS : {});
  }
}

async function routeRequest(request: Request, env: TunnelRelayEnv, ctx?: WaitUntil): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    const { id, tag, timestamp } = env.CF_VERSION_METADATA;
    return jsonResponse({
      ok: true,
      service: "ade-tunnel-relay",
      protocolVersion: 2,
      workerVersion: { id, tag, timestamp },
    });
  }

  const route = routeTunnelPath(url.pathname) ?? routeMcpPath(url);
  if (!route) return textResponse("not found", 404);
  if (isMcpRoute(route) && request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
  }
  // The mount header is the Worker's own; a client's copy never goes further.
  if (isMcpRoute(route) && request.headers.has(MCP_MOUNT_HEADER)) {
    const headers = new Headers(request.headers);
    headers.delete(MCP_MOUNT_HEADER);
    request = new Request(request, { headers });
  }
  // A brain's redirect goes back to the client as is. An incoming request is
  // already `manual`; one built inside the Worker (or a test) defaults to
  // `follow`, which would follow the redirect here instead.
  if (isMcpRoute(route) && request.redirect !== "manual") {
    request = new Request(request, { redirect: "manual" });
  }
  if (route.kind === "mcp-account") return await handleAccountMcp(request, env, route.accountKey, ctx);
  if (route.kind === "mcp") {
    const machineKey = await resolveMcpEndpoint(env, route.machineKey);
    if (!machineKey) {
      return mcpErrorResponse(404, "ade_mcp_off", MCP_MACHINE_OFF_DESCRIPTION);
    }
    // An MCP call is forwarded to the brain and may run a tool or open a
    // stream, whatever its method: never sent twice.
    const id = env.TUNNEL.idFromName(machineKey);
    return await fetchDurableObject(() => env.TUNNEL.get(id), request, { retry: "never" });
  }

  // Every route is scoped to a single machine → a single Durable Object
  // instance. The DO owns the claim secret, signature verification, and the
  // per-connection socket pairing; the worker is a thin, stateless router.
  const id = env.TUNNEL.idFromName(route.machineKey);
  // Only the machine's own routes may influence placement — a travelling phone
  // must never drag a machine's object across the planet.
  const locationHint = route.kind === "claim" || route.kind === "host"
    ? locationHintForGeo((request as { cf?: RequestPlacementGeo | null }).cf)
    : undefined;
  // A claim stores the secret first-writer-wins, so sending it twice is safe.
  return await fetchDurableObject(
    () => (locationHint ? env.TUNNEL.get(id, { locationHint }) : env.TUNNEL.get(id)),
    request,
    route.kind === "claim" ? { retry: "replayable" } : {},
  );
}
