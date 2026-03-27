import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import type http from "node:http";
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

const DEFAULT_CONFIG: OAuthRedirectConfig = {
  enabled: true,
  callbackPaths: [
    "/oauth/callback",
    "/auth/callback",
    "/api/auth/callback",
    "/callback",
  ],
  routingMode: "state-parameter",
};

/**
 * OAuth Redirect Handling Service (Phase 5 W5).
 *
 * Intercepts OAuth callbacks on the lane proxy, extracts the lane ID
 * from the `state` parameter, and forwards the callback to the correct
 * lane's dev server. Zero configuration required for the common case —
 * just encode your OAuth state via `encodeState()` and ADE handles routing.
 */
export function createOAuthRedirectService({
  logger,
  config: userConfig,
  broadcastEvent,
  getRoutes,
  getProxyPort,
  getHostnameSuffix,
  forwardToPort,
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
}) {
  const cfg: OAuthRedirectConfig = { ...DEFAULT_CONFIG, ...userConfig };
  const sessions = new Map<string, OAuthSession>();
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
      const laneId = Buffer.from(rest.slice(signatureEnd + STATE_SEP.length, laneEnd), "base64url").toString("utf-8");
      const originalState = rest.slice(laneEnd + STATE_SEP.length);
      if (!laneId.trim() || !signature) {
        logger.debug("oauth_redirect.decode_error", { reason: "empty laneId or signature" });
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

  // ---------------------------------------------------------------------------
  // Session tracking
  // ---------------------------------------------------------------------------

  function createSession(
    laneId: string,
    callbackPath: string,
  ): OAuthSession {
    const id = `oauth-${randomUUID()}`;
    const session: OAuthSession = {
      id,
      laneId,
      status: "active",
      callbackPath,
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

  // ---------------------------------------------------------------------------
  // Error page
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

  // ---------------------------------------------------------------------------
  // Request interceptor (registered on laneProxyService)
  // ---------------------------------------------------------------------------

  function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): boolean {
    if (!cfg.enabled) return false;

    const urlPath = (req.url ?? "").split("?")[0];
    if (!isOAuthCallback(urlPath)) return false;

    // --- state-parameter routing ---
    if (cfg.routingMode === "state-parameter") {
      const state = extractStateParam(req);
      if (!state) return false; // no state param — fall through to normal routing

      const decoded = decodeState(state);
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

      // Rewrite state back to the original value before forwarding
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
              uris: [`${base}/oauth/callback`],
              instructions:
                "Add this URI in Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client → Authorized redirect URIs.",
            },
          ];
        case "github":
          return [
            {
              provider: "GitHub",
              uris: [`${base}/auth/callback`],
              instructions:
                "Set this as the Authorization callback URL in your GitHub OAuth App settings. GitHub supports one callback URL per app.",
            },
          ];
        case "auth0":
          return [
            {
              provider: "Auth0",
              uris: [
                `${base}/oauth/callback`,
                `${base}/auth/callback`,
              ],
              instructions:
                "Add these URIs to your Auth0 Application → Settings → Allowed Callback URLs (comma-separated).",
            },
          ];
        default:
          break;
      }
    }

    return [
      {
        provider: provider ?? "Generic",
        uris: cfg.callbackPaths.map((p) => `${base}${p}`),
        instructions:
          "Register one of these redirect URIs with your OAuth provider. ADE automatically routes callbacks to the correct lane using the OAuth state parameter.",
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
    },
  };
}
