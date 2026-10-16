/**
 * Browser sign-in for a registry MCP server, done once by ADE for every agent.
 *
 * A remote MCP server that wants a sign-in answers an unauthenticated request
 * with `401` and a `WWW-Authenticate: Bearer resource_metadata=...` header (the
 * MCP authorization spec). Provider CLIs each run that flow themselves, into
 * their own credential stores, so a server signed in for Claude is still
 * signed out for Codex. ADE runs it here instead and keeps the token in the
 * account vault; the launch path hands it to every provider as an
 * `Authorization` header (`mcpRegistryToCallerServers`).
 *
 * The flow, all of it standard OAuth 2.1 for a public client:
 *
 * 1. Discover: the server's protected-resource metadata names its
 *    authorization server; that server's metadata names its endpoints.
 * 2. Register ADE with dynamic client registration, for this sign-in's
 *    loopback redirect.
 * 3. Open the browser on the authorize URL (PKCE S256, `state`, `resource`),
 *    and wait on `127.0.0.1:<random port>/callback`.
 * 4. Exchange the code for a token.
 *
 * The browser and the loopback listener must be on the same computer, so this
 * runs in the desktop's main process, never on a remote brain. The token goes
 * to the account vault, which every computer of the account reads.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

import type { McpOAuthToken } from "../../../shared/mcpRegistry";
import { createPkcePair } from "../shared/utils";

const CALLBACK_PATH = "/callback";
const LOOPBACK_HOST = "127.0.0.1";
/** How long a sign-in waits for the browser. The IPC call that runs one outlasts it (`ipcTimeouts.ts`). */
export const MCP_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export type McpFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What a server needs before an agent can use it, as far as an unauthenticated request can tell. */
export type McpAuthProbe =
  | { kind: "open" }
  | { kind: "sign-in"; resourceMetadataUrl: string | null; scope: string | null }
  | { kind: "unknown"; message: string };

type AuthServerMetadata = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopes: string[];
};

export type McpOAuthOutcome =
  | { ok: true; token: McpOAuthToken }
  | { ok: false; cancelled?: boolean; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

/**
 * Every request in a sign-in: bounded in time, stopped with the sign-in it
 * belongs to, and never following a redirect. A redirect on a token request
 * would carry the code and verifier to wherever the server pointed.
 */
function request(init: RequestInit, signal: AbortSignal | undefined): RequestInit {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Whether ADE may send a sign-in request to a URL the server's metadata named.
 * The metadata is the server's word, so it is held to HTTPS with no embedded
 * credentials. Plain HTTP is allowed only for a server the user runs on this
 * computer, and then only to this computer: that is what a local dev server
 * looks like, and it cannot point ADE at the rest of the network.
 */
/** True when `raw` names `mcpUrl` itself or a path above it on the same origin. */
function isResourceForServer(raw: string, mcpUrl: URL): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.origin !== mcpUrl.origin) return false;
  const base = url.pathname.replace(/\/+$/, "");
  const path = mcpUrl.pathname.replace(/\/+$/, "");
  return base === "" || path === base || path.startsWith(`${base}/`);
}

export function isAllowedMcpAuthEndpoint(raw: string, mcpUrl: URL): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname)
    && mcpUrl.protocol === "http:" && isLoopbackHost(mcpUrl.hostname);
}

/** One parameter of a `WWW-Authenticate: Bearer a="b", c="d"` header. */
export function bearerChallengeParam(header: string | null, name: string): string | null {
  if (!header || !/^\s*bearer\b/i.test(header)) return null;
  const match = new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*(?:"([^"]*)"|([^\\s,]+))`, "i").exec(header);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/**
 * Asks the server, with no credentials, whether it wants a sign-in. An MCP
 * `initialize` is the request every client sends first, so a server that
 * gates on auth answers it with its challenge.
 */
export async function probeMcpAuth(url: string, fetchImpl: McpFetch = fetch, signal?: AbortSignal): Promise<McpAuthProbe> {
  let response: Response;
  try {
    // The user's own URL, with no credentials on it: following its redirect
    // (a trailing slash, http to https) is safe, and refusing it would read
    // as "unreachable".
    response = await fetchImpl(url, { ...request({
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ADE", version: "1" } },
      }),
    }, signal), redirect: "follow" });
  } catch (error) {
    return { kind: "unknown", message: error instanceof Error ? error.message : String(error) };
  }
  // The body is not needed, and an unread SSE stream would hold the socket.
  void response.body?.cancel().catch(() => undefined);
  if (response.status !== 401) return response.status < 500 ? { kind: "open" } : { kind: "unknown", message: `The server answered ${response.status}.` };
  const challenge = response.headers.get("www-authenticate");
  return {
    kind: "sign-in",
    resourceMetadataUrl: bearerChallengeParam(challenge, "resource_metadata"),
    scope: bearerChallengeParam(challenge, "scope"),
  };
}

async function getJson(url: string, fetchImpl: McpFetch, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(url, request({ headers: { accept: "application/json" } }, signal));
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/** RFC 8414 / RFC 9728 well-known URLs: the suffix goes between the origin and the path. */
function wellKnown(base: URL, suffix: string): string[] {
  const path = base.pathname.replace(/\/+$/, "");
  return path && path !== "/" ? [`${base.origin}/.well-known/${suffix}${path}`, `${base.origin}/.well-known/${suffix}`] : [`${base.origin}/.well-known/${suffix}`];
}

async function discoverAuthServer(
  mcpUrl: URL,
  probe: Extract<McpAuthProbe, { kind: "sign-in" }>,
  fetchImpl: McpFetch,
  signal: AbortSignal,
): Promise<{ metadata: AuthServerMetadata; resource: string } | string> {
  const refused = "The server pointed its sign-in at an address ADE won't send it to.";
  if (probe.resourceMetadataUrl && !isAllowedMcpAuthEndpoint(probe.resourceMetadataUrl, mcpUrl)) return refused;
  let resourceMetadata: Record<string, unknown> | null = null;
  for (const candidate of probe.resourceMetadataUrl ? [probe.resourceMetadataUrl] : wellKnown(mcpUrl, "oauth-protected-resource")) {
    resourceMetadata = await getJson(candidate, fetchImpl, signal);
    if (resourceMetadata) break;
  }
  const servers = Array.isArray(resourceMetadata?.authorization_servers) ? resourceMetadata.authorization_servers : [];
  const issuer = str(servers[0]) ?? mcpUrl.origin;
  const resource = str(resourceMetadata?.resource) ?? mcpUrl.toString();
  // RFC 9728: the metadata must describe this server. A token minted for
  // another resource would otherwise be handed to this one.
  if (!isResourceForServer(resource, mcpUrl)) return "The server's sign-in settings name a different server.";
  if (!isAllowedMcpAuthEndpoint(issuer, mcpUrl)) return refused;
  const issuerUrl = new URL(issuer);
  let raw: Record<string, unknown> | null = null;
  for (const candidate of [...wellKnown(issuerUrl, "oauth-authorization-server"), ...wellKnown(issuerUrl, "openid-configuration")]) {
    raw = await getJson(candidate, fetchImpl, signal);
    if (raw) break;
  }
  const scopes = [
    ...(probe.scope ? probe.scope.split(/\s+/) : []),
    ...(Array.isArray(resourceMetadata?.scopes_supported) && !probe.scope
      ? resourceMetadata.scopes_supported.filter((entry): entry is string => typeof entry === "string")
      : []),
  ].filter(Boolean);
  if (!raw) {
    // Servers from before authorization-server metadata: the spec's fixed paths on the issuer.
    return {
      resource,
      metadata: {
        authorizationEndpoint: `${issuerUrl.origin}/authorize`,
        tokenEndpoint: `${issuerUrl.origin}/token`,
        registrationEndpoint: `${issuerUrl.origin}/register`,
        scopes,
      },
    };
  }
  const authorizationEndpoint = str(raw.authorization_endpoint);
  const tokenEndpoint = str(raw.token_endpoint);
  const registrationEndpoint = str(raw.registration_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) return "The server's sign-in settings are incomplete.";
  if ([authorizationEndpoint, tokenEndpoint, registrationEndpoint].some((endpoint) => endpoint && !isAllowedMcpAuthEndpoint(endpoint, mcpUrl))) {
    return refused;
  }
  const methods = Array.isArray(raw.code_challenge_methods_supported) ? raw.code_challenge_methods_supported : null;
  if (methods && !methods.includes("S256")) return "The server's sign-in does not support the secure browser flow ADE uses.";
  return {
    resource,
    metadata: { authorizationEndpoint, tokenEndpoint, registrationEndpoint, scopes },
  };
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl: McpFetch,
  signal: AbortSignal,
): Promise<{ clientId: string; clientSecret: string | null } | string> {
  try {
    const response = await fetchImpl(registrationEndpoint, request({
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "ADE",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }, signal));
    const body: unknown = await response.json().catch(() => null);
    const clientId = isRecord(body) ? str(body.client_id) : null;
    if (!response.ok || !clientId) return `The server would not register ADE (${response.status}).`;
    return { clientId, clientSecret: isRecord(body) ? str(body.client_secret) : null };
  } catch (error) {
    return `The server would not register ADE: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** A token endpoint's answer as the record the vault keeps. */
async function requestToken(
  tokenEndpoint: string,
  params: Record<string, string>,
  base: Omit<McpOAuthToken, "accessToken" | "refreshToken" | "expiresAt" | "scope">,
  previousRefreshToken: string | null,
  fetchImpl: McpFetch,
  signal?: AbortSignal,
): Promise<McpOAuthToken | string> {
  try {
    const response = await fetchImpl(tokenEndpoint, request({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    }, signal));
    const body: unknown = await response.json().catch(() => null);
    const accessToken = isRecord(body) ? str(body.access_token) : null;
    if (!response.ok || !accessToken || !isRecord(body)) {
      const reason = isRecord(body) ? str(body.error_description) ?? str(body.error) : null;
      return `The server did not give ADE a token${reason ? `: ${reason}` : ` (${response.status})`}.`;
    }
    const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
    return {
      ...base,
      accessToken,
      refreshToken: str(body.refresh_token) ?? previousRefreshToken,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scope: str(body.scope),
    };
  } catch (error) {
    return `The server did not give ADE a token: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** A new access token from a saved refresh token, or a sentence when the server would not give one. */
export async function refreshMcpOAuthToken(token: McpOAuthToken, fetchImpl: McpFetch = fetch): Promise<McpOAuthToken | string> {
  if (!token.refreshToken) return "This sign-in can't be renewed.";
  const { accessToken: _a, refreshToken: _r, expiresAt: _e, scope: _s, ...base } = token;
  return await requestToken(token.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: token.clientId,
    ...(token.clientSecret ? { client_secret: token.clientSecret } : {}),
    resource: token.resource,
  }, base, token.refreshToken, fetchImpl);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;line-height:1.5">`
    + `<h2 style="margin:0 0 8px">${title}</h2><p style="margin:0;color:#555">${body}</p></body></html>`;
}

const CANCELLED: McpOAuthOutcome = { ok: false, cancelled: true, message: "Sign-in was cancelled." };

/**
 * One sign-in at a time per server. Starting a second one for the same server
 * cancels the first, and a cancelled one stops wherever it is, its token
 * exchange included, so a browser tab left open from an earlier try cannot
 * complete into the vault after a newer one or after Cancel.
 */
export function createMcpOAuthSignIns(options: {
  openUrl: (url: string) => Promise<void>;
  fetch?: McpFetch;
  timeoutMs?: number;
}) {
  const fetchImpl = options.fetch ?? fetch;
  const active = new Map<string, AbortController>();

  const cancel = (serverName: string): boolean => {
    const attempt = active.get(serverName);
    if (!attempt) return false;
    active.delete(serverName);
    attempt.abort();
    return true;
  };

  const run = async (server: { name: string; url: string }, mcpUrl: URL, signal: AbortSignal): Promise<McpOAuthOutcome> => {
    const probe = await probeMcpAuth(server.url, fetchImpl, signal);
    if (signal.aborted) return CANCELLED;
    if (probe.kind === "open") return { ok: false, message: `${server.name} did not ask for a sign-in. Agents can use it as it is.` };
    if (probe.kind === "unknown") return { ok: false, message: `ADE could not reach ${server.name}: ${probe.message}` };
    const discovered = await discoverAuthServer(mcpUrl, probe, fetchImpl, signal);
    if (signal.aborted) return CANCELLED;
    if (typeof discovered === "string") return { ok: false, message: discovered };
    const { metadata, resource } = discovered;
    const registrationEndpoint = metadata.registrationEndpoint;
    if (!registrationEndpoint) {
      return { ok: false, message: `${server.name} does not let apps register themselves for a sign-in, so ADE can't sign in to it. Add its API key as a header instead.` };
    }

    return await new Promise<McpOAuthOutcome>((resolve) => {
      const state = randomUUID();
      const pkce = createPkcePair();
      let redirectUri = "";
      let client: { clientId: string; clientSecret: string | null } | null = null;
      // The browser has come back once. A code is single-use, so a second
      // callback is refused even while the first one's exchange runs.
      let callbackClaimed = false;
      let done = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (outcome: McpOAuthOutcome) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        httpServer.close();
        httpServer.closeAllConnections();
        resolve(signal.aborted ? CANCELLED : outcome);
      };
      const onAbort = () => finish(CANCELLED);

      const httpServer = http.createServer((req, res) => {
        const requestUrl = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
        if (requestUrl.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end();
          return;
        }
        if (requestUrl.searchParams.get("state") !== state || callbackClaimed || done || !client) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" })
            .end(page("This sign-in is no longer active", "Go back to ADE and press Sign in again."));
          return;
        }
        callbackClaimed = true;
        const error = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code");
        if (error || !code) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" })
            .end(page("Sign-in was not completed", "You can close this tab and go back to ADE."));
          finish({ ok: false, message: requestUrl.searchParams.get("error_description") ?? (error ? `The server said: ${error}` : "The server sent no code.") });
          return;
        }
        const claimed = client;
        void requestToken(metadata.tokenEndpoint, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: claimed.clientId,
          ...(claimed.clientSecret ? { client_secret: claimed.clientSecret } : {}),
          code_verifier: pkce.verifier,
          resource,
        }, {
          v: 1,
          url: server.url,
          clientId: claimed.clientId,
          clientSecret: claimed.clientSecret,
          tokenEndpoint: metadata.tokenEndpoint,
          resource,
        }, null, fetchImpl, signal).then((token) => {
          // Cancelled while the exchange ran: the token is dropped, not saved.
          const ok = typeof token !== "string" && !signal.aborted;
          res.writeHead(ok ? 200 : 502, { "content-type": "text/html; charset=utf-8" }).end(ok
            ? page(`Signed in to ${server.name}`, "Every ADE agent can use it now. You can close this tab.")
            : page("Sign-in did not finish", "Go back to ADE to see why."));
          finish(typeof token === "string" ? { ok: false, message: token } : { ok: true, token });
        });
      });

      signal.addEventListener("abort", onAbort);
      httpServer.once("error", (error) => finish({ ok: false, message: `ADE could not wait for the browser: ${error.message}` }));
      httpServer.listen(0, LOOPBACK_HOST, () => {
        // Cancelled before the port was bound: close() then had nothing to close.
        if (done) {
          httpServer.close();
          return;
        }
        void (async () => {
          const address = httpServer.address();
          if (!address || typeof address === "string") {
            finish({ ok: false, message: "ADE could not wait for the browser." });
            return;
          }
          redirectUri = `http://${LOOPBACK_HOST}:${address.port}${CALLBACK_PATH}`;
          const registered = await registerClient(registrationEndpoint, redirectUri, fetchImpl, signal);
          if (done) return;
          if (typeof registered === "string") {
            finish({ ok: false, message: registered });
            return;
          }
          client = registered;
          const authorize = new URL(metadata.authorizationEndpoint);
          authorize.searchParams.set("response_type", "code");
          authorize.searchParams.set("client_id", registered.clientId);
          authorize.searchParams.set("redirect_uri", redirectUri);
          authorize.searchParams.set("code_challenge", pkce.challenge);
          authorize.searchParams.set("code_challenge_method", "S256");
          authorize.searchParams.set("state", state);
          authorize.searchParams.set("resource", resource);
          if (metadata.scopes.length) authorize.searchParams.set("scope", metadata.scopes.join(" "));
          timer = setTimeout(
            () => finish({ ok: false, message: "The browser sign-in was not finished in time. Press Sign in to try again." }),
            options.timeoutMs ?? MCP_SIGN_IN_TIMEOUT_MS,
          );
          try {
            await options.openUrl(authorize.toString());
          } catch (error) {
            finish({ ok: false, message: `ADE could not open your browser: ${error instanceof Error ? error.message : String(error)}` });
          }
        })();
      });
    });
  };

  const signIn = async (server: { name: string; url: string }): Promise<McpOAuthOutcome> => {
    let mcpUrl: URL;
    try {
      mcpUrl = new URL(server.url);
    } catch {
      return { ok: false, message: "That server's URL can't be read." };
    }
    // Registered before the first await, so Cancel and a newer sign-in reach
    // this one from its very first request.
    cancel(server.name);
    const attempt = new AbortController();
    active.set(server.name, attempt);
    try {
      const outcome = await run(server, mcpUrl, attempt.signal);
      return attempt.signal.aborted ? CANCELLED : outcome;
    } finally {
      if (active.get(server.name) === attempt) active.delete(server.name);
    }
  };

  return {
    signIn,
    cancel,
    dispose: () => {
      for (const name of [...active.keys()]) cancel(name);
    },
  };
}
