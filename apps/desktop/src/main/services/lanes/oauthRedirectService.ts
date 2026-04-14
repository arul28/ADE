import http from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import type {
  OAuthRedirectConfig,
  OAuthRedirectStatus,
  OAuthRedirectEvent,
  OAuthSession,
  OAuthSessionStatus,
  RedirectUriInfo,
  ProxyRoute,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";

const STATE_PREFIX = "ade";
const STATE_SEP = ":";
const FIXED_CALLBACK_PATH = "/oauth/callback";
const FINALIZE_CALLBACK_PATH = "/__ade/oauth/finalize";
const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const AUTH_START_PATH_PREFIXES = ["/api/auth/", "/auth/", "/oauth/"];
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type UpstreamResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

type PendingOAuthStartSession = {
  encodedState: string;
  laneId: string;
  laneHostname: string;
  targetPort: number;
  originalState: string;
  originalCallbackPath: string;
  cookiePairs: string[];
  createdAtMs: number;
  provider?: string;
  sessionId: string;
};

type PendingFinalizeSession = {
  token: string;
  laneId: string;
  laneHostname: string;
  response: UpstreamResponse;
  createdAtMs: number;
  sessionId: string;
};

const DEFAULT_CONFIG: OAuthRedirectConfig = {
  enabled: true,
  callbackPaths: [
    "/oauth/callback",
    "/auth/callback",
    "/api/auth/callback",
    "/api/auth/google/callback",
    "/callback",
  ],
  routingMode: "state-parameter",
};

/**
 * OAuth Redirect Handling Service (Phase 5 W5).
 *
 * The stable ADE-managed callback flow works like this:
 * 1. A sign-in starts from the lane preview URL.
 * 2. ADE rewrites the provider redirect_uri to a single stable proxy callback.
 * 3. ADE stores the lane-bound cookies needed for the callback.
 * 4. The provider returns to the stable callback.
 * 5. ADE forwards the callback to the correct lane app and replays the final
 *    response back on the lane preview host so cookies remain isolated.
 */
export function createOAuthRedirectService({
  logger,
  config: userConfig,
  broadcastEvent,
  getRoutes,
  getProxyPort,
  getHostnameSuffix,
  forwardToPort,
  requestUpstream,
}: {
  logger: Logger;
  config?: Partial<OAuthRedirectConfig>;
  broadcastEvent: (ev: OAuthRedirectEvent) => void;
  /** Return all active proxy routes. */
  getRoutes: () => ProxyRoute[];
  /** Return the current proxy listen port. */
  getProxyPort: () => number;
  /** Return the hostname suffix (e.g. ".localhost"). */
  getHostnameSuffix: () => string;
  /** Forward an HTTP request to a target port (reuses proxy logic). */
  forwardToPort: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    targetPort: number,
  ) => void;
  /** Optional injectable request helper for tests and advanced proxy flows. */
  requestUpstream?: (args: {
    req: http.IncomingMessage;
    targetPort: number;
    overridePath?: string;
    overrideHeaders?: http.OutgoingHttpHeaders;
  }) => Promise<UpstreamResponse>;
}) {
  void getHostnameSuffix;
  const cfg: OAuthRedirectConfig = { ...DEFAULT_CONFIG, ...userConfig };
  const sessions = new Map<string, OAuthSession>();
  const pendingStarts = new Map<string, PendingOAuthStartSession>();
  const pendingFinalize = new Map<string, PendingFinalizeSession>();
  const stateSecret = randomBytes(32);

  // ---------------------------------------------------------------------------
  // State-parameter encoding
  // ---------------------------------------------------------------------------

  function signState(laneId: string, originalState: string): string {
    return createHmac("sha256", stateSecret)
      .update(laneId)
      .update("\0")
      .update(originalState)
      .digest("base64url");
  }

  function encodeState(laneId: string, originalState: string): string {
    if (!laneId.trim()) {
      throw new Error("OAuth laneId must be a non-empty string");
    }
    const b64Lane = Buffer.from(laneId).toString("base64url");
    const signature = signState(laneId, originalState);
    return `${STATE_PREFIX}${STATE_SEP}${signature}${STATE_SEP}${b64Lane}${STATE_SEP}${originalState}`;
  }

  function decodeState(
    encoded: string,
  ): { laneId: string; originalState: string } | null {
    const prefix = `${STATE_PREFIX}${STATE_SEP}`;
    if (!encoded.startsWith(prefix)) return null;

    const rest = encoded.slice(prefix.length);
    const signatureEnd = rest.indexOf(STATE_SEP);
    if (signatureEnd < 0) return null;

    const laneEnd = rest.indexOf(STATE_SEP, signatureEnd + STATE_SEP.length);
    if (laneEnd < 0) return null;

    try {
      const signature = rest.slice(0, signatureEnd);
      const laneId = Buffer.from(
        rest.slice(signatureEnd + STATE_SEP.length, laneEnd),
        "base64url",
      ).toString("utf-8");
      const originalState = rest.slice(laneEnd + STATE_SEP.length);
      if (!laneId.trim() || !signature) {
        logger.debug("oauth_redirect.decode_error", {
          reason: "empty laneId or signature",
        });
        return null;
      }

      const expectedSignature = signState(laneId, originalState);
      const actualBytes = Buffer.from(signature);
      const expectedBytes = Buffer.from(expectedSignature);
      if (
        actualBytes.length !== expectedBytes.length ||
        !timingSafeEqual(actualBytes, expectedBytes)
      ) {
        logger.warn("oauth_redirect.signature_mismatch", { laneId });
        return null;
      }

      return { laneId, originalState };
    } catch (err) {
      logger.debug("oauth_redirect.decode_error", { error: String(err) });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Callback detection
  // ---------------------------------------------------------------------------

  function isOAuthCallback(urlPath: string): boolean {
    const normalized = urlPath.split("?")[0].toLowerCase();
    return cfg.callbackPaths.some((p) => normalized === p.toLowerCase());
  }

  function isPotentialAuthStartPath(urlPath: string): boolean {
    const normalized = urlPath.split("?")[0].toLowerCase();
    return AUTH_START_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }

  function extractStateParam(req: http.IncomingMessage): string | null {
    try {
      const url = new URL(
        req.url ?? "",
        `http://${req.headers.host ?? "localhost"}`,
      );
      return url.searchParams.get("state");
    } catch {
      return null;
    }
  }

  function rewriteStateParam(originalUrl: string, newState: string): string {
    try {
      const url = new URL(originalUrl, "http://placeholder");
      url.searchParams.set("state", newState);
      return url.pathname + url.search;
    } catch {
      return originalUrl;
    }
  }

  function normalizeHostHeader(hostHeader: string): string {
    const trimmed = hostHeader.trim();
    if (!trimmed.length) return "";
    if (trimmed.startsWith("[")) {
      const end = trimmed.indexOf("]");
      return (end >= 0 ? trimmed.slice(1, end) : trimmed).toLowerCase();
    }
    return trimmed.split(":")[0].toLowerCase();
  }

  function findRouteByHostHeader(hostHeader: string | undefined): ProxyRoute | null {
    const hostname = normalizeHostHeader(hostHeader ?? "");
    if (!hostname) return null;
    return getRoutes().find(
      (route) => route.hostname.toLowerCase() === hostname && route.status === "active",
    ) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Session tracking
  // ---------------------------------------------------------------------------

  function createSession(
    laneId: string,
    callbackPath: string,
    options?: { status?: OAuthSessionStatus; provider?: string },
  ): OAuthSession {
    const id = `oauth-${randomUUID()}`;
    const session: OAuthSession = {
      id,
      laneId,
      status: options?.status ?? "active",
      callbackPath,
      ...(options?.provider ? { provider: options.provider } : {}),
      createdAt: new Date().toISOString(),
    };
    sessions.set(id, session);
    broadcastEvent({
      type: "oauth-session-started",
      session,
      status: buildStatus(),
    });
    return session;
  }

  function markSessionActive(session: OAuthSession): void {
    if (session.status === "active") return;
    session.status = "active";
    broadcastEvent({
      type: "oauth-callback-routed",
      session,
      status: buildStatus(),
    });
  }

  function completeSession(
    session: OAuthSession,
    status: OAuthSessionStatus,
    error?: string,
  ): void {
    session.status = status;
    session.completedAt = new Date().toISOString();
    if (error) session.error = error;

    broadcastEvent({
      type: status === "completed" ? "oauth-session-completed" : "oauth-session-failed",
      session,
      status: buildStatus(),
      error,
    });
  }

  function sessionById(sessionId: string): OAuthSession | null {
    return sessions.get(sessionId) ?? null;
  }

  function completeSessionFromResponse(
    session: OAuthSession,
    res: http.ServerResponse,
  ): (status: OAuthSessionStatus, error?: string) => void {
    let finished = false;

    const finalize = (status: OAuthSessionStatus, error?: string) => {
      if (finished) return;
      finished = true;
      completeSession(session, status, error);
      if (status === "completed") {
        broadcastEvent({
          type: "oauth-callback-routed",
          session,
          status: buildStatus(),
        });
      }
    };

    res.once("finish", () => {
      if ((res.statusCode ?? 200) >= 400) {
        finalize(
          "failed",
          `OAuth callback forwarding failed with status ${res.statusCode}.`,
        );
        return;
      }
      finalize("completed");
    });

    res.once("close", () => {
      if (finished || res.writableEnded) return;
      finalize("failed", "OAuth callback connection closed before completion.");
    });

    return finalize;
  }

  function buildStatus(): OAuthRedirectStatus {
    return {
      enabled: cfg.enabled,
      routingMode: cfg.routingMode,
      activeSessions: Array.from(sessions.values()).filter(
        (s) => s.status === "active" || s.status === "pending",
      ),
      callbackPaths: [...cfg.callbackPaths],
    };
  }

  function removeExpiredPendingSessions(): void {
    const cutoff = Date.now() - OAUTH_SESSION_TTL_MS;
    for (const [encodedState, session] of pendingStarts.entries()) {
      if (session.createdAtMs >= cutoff) continue;
      pendingStarts.delete(encodedState);
      const tracked = sessionById(session.sessionId);
      if (tracked && tracked.status !== "completed" && tracked.status !== "failed") {
        completeSession(
          tracked,
          "failed",
          "OAuth callback did not return before the ADE session expired.",
        );
      }
    }
    for (const [token, session] of pendingFinalize.entries()) {
      if (session.createdAtMs >= cutoff) continue;
      pendingFinalize.delete(token);
      const tracked = sessionById(session.sessionId);
      if (tracked && tracked.status !== "completed" && tracked.status !== "failed") {
        completeSession(
          tracked,
          "failed",
          "OAuth finalize response expired before the browser completed the redirect.",
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Error pages
  // ---------------------------------------------------------------------------

  function esc(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function errorPage(laneId: string, message: string): string {
    return `<!DOCTYPE html>
<html><head><title>OAuth Routing Error — ADE</title>
<style>
body{font-family:Geist,-apple-system,BlinkMacSystemFont,sans-serif;background:#09080C;color:#FAFAFA;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{background:#181423;border:1px solid #2D2840;padding:32px;max-width:520px}
h1{font-size:16px;color:#EF4444;margin:0 0 12px}
p{font-size:13px;color:#A1A1AA;line-height:1.5;margin:0 0 8px}
code{background:#0B0A0F;padding:2px 6px;font-size:12px;color:#A78BFA;font-family:inherit}
.h{font-size:11px;color:#5A5670;margin-top:16px}
</style></head><body><div class="c">
<h1>OAuth Callback Routing Failed</h1>
<p>${esc(message)}</p>
<p class="h">Lane: <code>${esc(laneId)}</code></p>
</div></body></html>`;
  }

  function proxyErrorPage(message: string): string {
    return `<!DOCTYPE html>
<html><head><title>Preview Error — ADE</title>
<style>
body{font-family:Geist,-apple-system,BlinkMacSystemFont,sans-serif;background:#09080C;color:#FAFAFA;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{background:#181423;border:1px solid #2D2840;padding:32px;max-width:560px}
h1{font-size:16px;color:#EF4444;margin:0 0 12px}
p{font-size:13px;color:#A1A1AA;line-height:1.5;margin:0 0 8px}
</style></head><body><div class="c">
<h1>Preview Request Failed</h1>
<p>${esc(message)}</p>
</div></body></html>`;
  }

  // ---------------------------------------------------------------------------
  // Upstream request helpers
  // ---------------------------------------------------------------------------

  function defaultRequestUpstream(args: {
    req: http.IncomingMessage;
    targetPort: number;
    overridePath?: string;
    overrideHeaders?: http.OutgoingHttpHeaders;
  }): Promise<UpstreamResponse> {
    const headers: http.OutgoingHttpHeaders = {
      ...args.req.headers,
      ...args.overrideHeaders,
    };

    return new Promise((resolve, reject) => {
      const timeoutMs = 30_000;
      const controller = new AbortController();
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let bodyChunks: Buffer[] | null = null;
      const shouldBufferBody = args.req.method !== "GET" && args.req.method !== "HEAD";

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        args.req.off("aborted", onRequestAborted);
        args.req.off("close", onRequestClose);
        args.req.off("error", onRequestError);
        if (shouldBufferBody) {
          args.req.off("data", onRequestData);
          args.req.off("end", onRequestEnd);
        }
      };

      const settleResolve = (value: UpstreamResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const abortWithTimeout = () => {
        const timeoutError = new Error("Upstream OAuth request timed out after 30 seconds.");
        timeoutError.name = "TimeoutError";
        settled = true;
        cleanup();
        controller.abort(timeoutError);
        reject(timeoutError);
      };

      const onRequestAborted = () => {
        if (settled) return;
        const abortError = new Error("Client request was aborted before the upstream OAuth request completed.");
        abortError.name = "AbortError";
        settleReject(abortError);
        controller.abort(abortError);
      };

      const onRequestClose = () => {
        if (settled || args.req.complete) return;
        const closeError = new Error("Client request closed before the upstream OAuth request completed.");
        closeError.name = "AbortError";
        settleReject(closeError);
        controller.abort(closeError);
      };

      const onRequestError = (error: Error) => {
        settleReject(error);
        controller.abort(error);
      };

      const onRequestData = (chunk: Buffer | string) => {
        if (!bodyChunks) bodyChunks = [];
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      };

      const onRequestEnd = () => {
        if (settled) return;
        upstreamReq.end(bodyChunks ? Buffer.concat(bodyChunks) : undefined);
      };

      timeoutHandle = setTimeout(abortWithTimeout, timeoutMs);
      const upstreamReq = http.request(
        {
          hostname: "127.0.0.1",
          port: args.targetPort,
          path: args.overridePath ?? args.req.url,
          method: args.req.method,
          headers,
          signal: controller.signal,
        },
        (upstreamRes) => {
          const chunks: Buffer[] = [];
          upstreamRes.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          upstreamRes.on("end", () => {
            settleResolve({
              statusCode: upstreamRes.statusCode ?? 502,
              headers: upstreamRes.headers,
              body: Buffer.concat(chunks),
            });
          });
          upstreamRes.once("error", settleReject);
        },
      );

      upstreamReq.once("error", settleReject);

      if (!shouldBufferBody) {
        upstreamReq.end();
        return;
      }

      args.req.once("aborted", onRequestAborted);
      args.req.once("close", onRequestClose);
      args.req.once("error", onRequestError);
      args.req.on("data", onRequestData);
      args.req.once("end", onRequestEnd);
    });
  }

  const sendUpstreamRequest = requestUpstream ?? defaultRequestUpstream;

  function cookiePairsFromSetCookie(header: string | string[] | undefined): string[] {
    const values = Array.isArray(header) ? header : header ? [header] : [];
    return values
      .map((value) => value.split(";")[0]?.trim() ?? "")
      .filter((value) => value.length > 0);
  }

  function cookiePairsFromHeader(cookieHeader: string | string[] | undefined): string[] {
    const raw = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader ?? "";
    return raw
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.includes("="));
  }

  function mergeCookiePairs(...sources: string[][]): string[] {
    const next = new Map<string, string>();
    for (const source of sources) {
      for (const pair of source) {
        const equals = pair.indexOf("=");
        if (equals <= 0) continue;
        next.set(pair.slice(0, equals), pair);
      }
    }
    return Array.from(next.values());
  }

  function buildCookieHeader(cookiePairs: string[]): string | undefined {
    return cookiePairs.length > 0 ? cookiePairs.join("; ") : undefined;
  }

  function copyResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const next: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) continue;
      if (HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
      next[key] = value;
    }
    return next;
  }

  function sendUpstreamResponse(
    res: http.ServerResponse,
    upstream: UpstreamResponse,
    overrides?: { headers?: http.OutgoingHttpHeaders; statusCode?: number },
  ): void {
    const headers = {
      ...copyResponseHeaders(upstream.headers),
      ...(overrides?.headers ?? {}),
    };
    res.writeHead(overrides?.statusCode ?? upstream.statusCode, headers);
    res.end(upstream.body);
  }

  function detectProvider(location: URL): string | undefined {
    const host = location.hostname.toLowerCase();
    if (host.includes("google.")) return "Google";
    if (host === "github.com" || host.endsWith(".github.com")) return "GitHub";
    if (host.includes("auth0.com")) return "Auth0";
    return undefined;
  }

  function parseOauthStartRedirect(locationHeader: string): {
    authUrl: URL;
    originalState: string;
    originalRedirectUri: URL;
    provider?: string;
  } | null {
    let authUrl: URL;
    try {
      authUrl = new URL(locationHeader);
    } catch {
      return null;
    }
    if (!["http:", "https:"].includes(authUrl.protocol)) return null;
    const originalState = authUrl.searchParams.get("state");
    const redirectUri = authUrl.searchParams.get("redirect_uri");
    if (!originalState || !redirectUri) return null;
    let originalRedirectUri: URL;
    try {
      originalRedirectUri = new URL(redirectUri);
    } catch {
      return null;
    }
    return {
      authUrl,
      originalState,
      originalRedirectUri,
      provider: detectProvider(authUrl),
    };
  }

  function stableCallbackUrl(): string {
    return `http://localhost:${getProxyPort()}${FIXED_CALLBACK_PATH}`;
  }

  function rewriteOauthStartRedirect(
    locationHeader: string,
    encodedState: string,
  ): string | null {
    const parsed = parseOauthStartRedirect(locationHeader);
    if (!parsed) return null;
    parsed.authUrl.searchParams.set("state", encodedState);
    parsed.authUrl.searchParams.set("redirect_uri", stableCallbackUrl());
    return parsed.authUrl.toString();
  }

  function buildForwardedHeaders(
    req: http.IncomingMessage,
    laneHostname: string,
    cookiePairs?: string[],
  ): http.OutgoingHttpHeaders {
    const proxyPort = getProxyPort();
    return {
      ...req.headers,
      host: `${laneHostname}:${proxyPort}`,
      "x-forwarded-host": `${laneHostname}:${proxyPort}`,
      "x-forwarded-port": String(proxyPort),
      "x-forwarded-proto": "http",
      ...(cookiePairs?.length ? { cookie: buildCookieHeader(cookiePairs) } : {}),
    };
  }

  function buildForwardCallbackPath(
    pending: PendingOAuthStartSession,
    req: http.IncomingMessage,
  ): string {
    const incoming = new URL(
      req.url ?? FIXED_CALLBACK_PATH,
      `http://${req.headers.host ?? "localhost"}`,
    );
    const forwardUrl = new URL(pending.originalCallbackPath, "http://placeholder");
    const params = new URLSearchParams(forwardUrl.search);
    incoming.searchParams.forEach((value, key) => {
      params.set(key, value);
    });
    params.set("state", pending.originalState);
    forwardUrl.search = params.toString();
    return `${forwardUrl.pathname}${forwardUrl.search ? `?${forwardUrl.search}` : ""}`;
  }

  function finalizeRedirectUrl(hostname: string, token: string): string {
    return `http://${hostname}:${getProxyPort()}${FINALIZE_CALLBACK_PATH}?token=${encodeURIComponent(token)}`;
  }

  // ---------------------------------------------------------------------------
  // Async request handlers
  // ---------------------------------------------------------------------------

  async function handleAuthStartRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: ProxyRoute,
  ): Promise<void> {
    const upstream = await sendUpstreamRequest({
      req,
      targetPort: route.targetPort,
      overrideHeaders: buildForwardedHeaders(req, route.hostname),
    });

    const locationHeader = Array.isArray(upstream.headers.location)
      ? upstream.headers.location[0]
      : upstream.headers.location;
    const parsedRedirect = typeof locationHeader === "string"
      ? parseOauthStartRedirect(locationHeader)
      : null;

    if (!parsedRedirect) {
      sendUpstreamResponse(res, upstream);
      return;
    }

    const encodedState = encodeState(route.laneId, parsedRedirect.originalState);
    const session = createSession(route.laneId, FIXED_CALLBACK_PATH, {
      status: "pending",
      ...(parsedRedirect.provider ? { provider: parsedRedirect.provider } : {}),
    });

    pendingStarts.set(encodedState, {
      encodedState,
      laneId: route.laneId,
      laneHostname: route.hostname,
      targetPort: route.targetPort,
      originalState: parsedRedirect.originalState,
      originalCallbackPath: `${parsedRedirect.originalRedirectUri.pathname}${parsedRedirect.originalRedirectUri.search}`,
      cookiePairs: mergeCookiePairs(
        cookiePairsFromHeader(req.headers.cookie),
        cookiePairsFromSetCookie(upstream.headers["set-cookie"]),
      ),
      createdAtMs: Date.now(),
      ...(parsedRedirect.provider ? { provider: parsedRedirect.provider } : {}),
      sessionId: session.id,
    });

    const rewrittenLocation = rewriteOauthStartRedirect(locationHeader!, encodedState);
    sendUpstreamResponse(res, upstream, {
      headers: rewrittenLocation ? { location: rewrittenLocation } : undefined,
    });
  }

  async function handleManagedCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pending: PendingOAuthStartSession,
  ): Promise<void> {
    const activeRoute = getRoutes().find(
      (route) => route.laneId === pending.laneId && route.status === "active",
    );
    const route = activeRoute ?? {
      laneId: pending.laneId,
      hostname: pending.laneHostname,
      targetPort: pending.targetPort,
      status: "active" as const,
      createdAt: new Date().toISOString(),
    };

    const trackedSession = sessionById(pending.sessionId);
    if (trackedSession) {
      markSessionActive(trackedSession);
    }

    const upstream = await sendUpstreamRequest({
      req,
      targetPort: route.targetPort,
      overridePath: buildForwardCallbackPath(pending, req),
      overrideHeaders: buildForwardedHeaders(req, route.hostname, pending.cookiePairs),
    });

    const finalizeToken = `oauth-finalize-${randomUUID()}`;
    pendingFinalize.set(finalizeToken, {
      token: finalizeToken,
      laneId: pending.laneId,
      laneHostname: route.hostname,
      response: upstream,
      createdAtMs: Date.now(),
      sessionId: pending.sessionId,
    });
    pendingStarts.delete(pending.encodedState);

    res.writeHead(302, {
      location: finalizeRedirectUrl(route.hostname, finalizeToken),
      "cache-control": "no-store",
    });
    res.end();
  }

  function handleFinalizeRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const requestUrl = new URL(
      req.url ?? FINALIZE_CALLBACK_PATH,
      `http://${req.headers.host ?? "localhost"}`,
    );
    const token = requestUrl.searchParams.get("token");
    if (!token) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(proxyErrorPage("OAuth finalize request is missing its ADE token."));
      return;
    }

    const pending = pendingFinalize.get(token);
    if (!pending) {
      res.writeHead(410, { "Content-Type": "text/html" });
      res.end(proxyErrorPage("This ADE OAuth finalize token has expired. Start the sign-in flow again from the lane preview URL."));
      return;
    }

    pendingFinalize.delete(token);
    const trackedSession = sessionById(pending.sessionId);
    if (trackedSession) {
      completeSession(trackedSession, "completed");
    }
    sendUpstreamResponse(res, pending.response);
  }

  // ---------------------------------------------------------------------------
  // Request interceptor (registered on laneProxyService)
  // ---------------------------------------------------------------------------

  function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): boolean {
    if (!cfg.enabled) return false;
    removeExpiredPendingSessions();

    const requestUrl = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (requestUrl.pathname === FINALIZE_CALLBACK_PATH) {
      handleFinalizeRequest(req, res);
      return true;
    }

    const state = extractStateParam(req);
    const decoded = state ? decodeState(state) : null;
    if (decoded) {
      const pending = pendingStarts.get(state!);
      if (pending) {
        void handleManagedCallback(req, res, pending).catch((error) => {
          const trackedSession = sessionById(pending.sessionId);
          const message =
            error instanceof Error
              ? error.message
              : "ADE could not forward the OAuth callback back to the lane.";
          if (trackedSession) {
            completeSession(trackedSession, "failed", message);
          }
          pendingStarts.delete(pending.encodedState);
          logger.warn("oauth_redirect.managed_callback_failed", {
            laneId: pending.laneId,
            error: message,
          });
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/html" });
          }
          res.end(errorPage(pending.laneId, message));
        });
        return true;
      }
    }

    const routeForHost = findRouteByHostHeader(req.headers.host);
    if (
      routeForHost &&
      (req.method === "GET" || req.method === "HEAD") &&
      isPotentialAuthStartPath(requestUrl.pathname)
    ) {
      void handleAuthStartRequest(req, res, routeForHost).catch((error) => {
        const message =
          error instanceof Error
            ? error.message
            : "ADE could not inspect the auth start response from the lane preview.";
        logger.warn("oauth_redirect.auth_start_failed", {
          laneId: routeForHost.laneId,
          error: message,
        });
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/html" });
        }
        res.end(proxyErrorPage(message));
      });
      return true;
    }

    const urlPath = requestUrl.pathname;
    if (!isOAuthCallback(urlPath)) return false;

    // --- state-parameter routing ---
    if (cfg.routingMode === "state-parameter") {
      if (!state) return false; // no state param — fall through to normal routing
      if (!decoded) return false; // not ADE-encoded — fall through

      const route = getRoutes().find(
        (r) => r.laneId === decoded.laneId && r.status === "active",
      );

      if (!route) {
        const session = createSession(decoded.laneId, urlPath);
        const msg = `Lane "${decoded.laneId}" received an OAuth callback but has no active proxy route. Check that the lane's dev server is running.`;
        completeSession(session, "failed", msg);
        logger.warn("oauth_redirect.no_route", { laneId: decoded.laneId });

        res.writeHead(502, { "Content-Type": "text/html" });
        res.end(errorPage(decoded.laneId, msg));
        return true;
      }

      const rewrittenUrl = rewriteStateParam(
        req.url ?? "",
        decoded.originalState,
      );

      const session = createSession(decoded.laneId, urlPath);
      const finalizeSession = completeSessionFromResponse(session, res);

      logger.info("oauth_redirect.routing", {
        laneId: decoded.laneId,
        targetPort: route.targetPort,
        callbackPath: urlPath,
      });

      const origUrl = req.url;
      try {
        req.url = rewrittenUrl;
        forwardToPort(req, res, route.targetPort);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "OAuth callback forwarding failed unexpectedly.";
        finalizeSession("failed", message);
        logger.warn("oauth_redirect.forward_failed", {
          laneId: decoded.laneId,
          error: message,
        });
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/html" });
        }
        res.end(errorPage(decoded.laneId, message));
        return true;
      } finally {
        req.url = origUrl;
      }
      return true;
    }

    // hostname-based routing is handled by normal proxy hostname resolution
    return false;
  }

  // ---------------------------------------------------------------------------
  // Redirect URI generation (copy-helper)
  // ---------------------------------------------------------------------------

  function generateRedirectUris(provider?: string): RedirectUriInfo[] {
    const port = getProxyPort();
    const base = `http://localhost:${port}`;

    if (provider) {
      switch (provider.toLowerCase()) {
        case "google":
          return [
            {
              provider: "Google",
              uris: [`${base}${FIXED_CALLBACK_PATH}`],
              instructions:
                "Add this URI in Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client → Authorized redirect URIs. Start sign-in from the lane preview URL so ADE can route the callback back to the correct lane.",
            },
          ];
        case "github":
          return [
            {
              provider: "GitHub",
              uris: [`${base}${FIXED_CALLBACK_PATH}`],
              instructions:
                "Set this as the Authorization callback URL in your GitHub OAuth App settings. Start sign-in from the lane preview URL so ADE can route the callback back to the correct lane.",
            },
          ];
        case "auth0":
          return [
            {
              provider: "Auth0",
              uris: [`${base}${FIXED_CALLBACK_PATH}`],
              instructions:
                "Add this URI to your Auth0 Application → Settings → Allowed Callback URLs. Start sign-in from the lane preview URL so ADE can route the callback back to the correct lane.",
            },
          ];
        default:
          break;
      }
    }

    return [
      {
        provider: provider ?? "Generic",
        uris: [`${base}${FIXED_CALLBACK_PATH}`],
        instructions:
          "Register this ADE-managed callback URL with your OAuth provider. Start sign-in from the lane preview URL so ADE can route the callback back to the correct lane.",
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    /** Encode a lane ID into an OAuth state parameter. */
    encodeState,

    /** Decode a lane ID from an ADE-encoded OAuth state parameter. */
    decodeState,

    /** Check whether a URL path looks like an OAuth callback. */
    isOAuthCallback,

    /**
     * Request interceptor — call from laneProxyService.
     * Returns true if the request was handled (OAuth callback routed).
     */
    handleRequest,

    /** Current service status. */
    getStatus(): OAuthRedirectStatus {
      return buildStatus();
    },

    /** Current config. */
    getConfig(): OAuthRedirectConfig {
      return { ...cfg };
    },

    /** Update config at runtime. */
    updateConfig(updates: Partial<OAuthRedirectConfig>): void {
      if (updates.enabled != null) {
        if (typeof updates.enabled !== "boolean") {
          throw new Error("OAuth redirect enabled flag must be boolean");
        }
        cfg.enabled = updates.enabled;
      }

      if (updates.callbackPaths != null) {
        if (!Array.isArray(updates.callbackPaths)) {
          throw new Error("OAuth callback paths must be an array of strings");
        }
        const nextPaths = updates.callbackPaths.map((p) => p.trim()).filter(Boolean);
        if (!nextPaths.length) throw new Error("OAuth callback paths cannot be empty");
        if (nextPaths.some((p) => !p.startsWith("/"))) {
          throw new Error("OAuth callback paths must start with '/'");
        }
        cfg.callbackPaths = nextPaths;
      }

      if (updates.routingMode != null) {
        if (updates.routingMode !== "state-parameter" && updates.routingMode !== "hostname") {
          throw new Error("OAuth routing mode is invalid");
        }
        cfg.routingMode = updates.routingMode;
      }

      broadcastEvent({ type: "oauth-config-changed", status: buildStatus() });
    },

    /** Generate redirect URIs for a provider (copy-helper). */
    generateRedirectUris,

    /** List all tracked OAuth sessions. */
    listSessions(): OAuthSession[] {
      return Array.from(sessions.values());
    },

    /** Clean up. */
    dispose(): void {
      sessions.clear();
      pendingStarts.clear();
      pendingFinalize.clear();
    },
  };
}
