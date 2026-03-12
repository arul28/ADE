import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type {
  CtoGetLinearOAuthSessionResult,
  CtoStartLinearOAuthResult,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { LinearCredentialService } from "./linearCredentialService";

const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const CALLBACK_PATH = "/oauth/callback";
const SESSION_TTL_MS = 10 * 60 * 1000;

type LinearOAuthSessionState = {
  id: string;
  state: string;
  redirectUri: string;
  authUrl: string;
  createdAt: number;
  status: CtoGetLinearOAuthSessionResult["status"];
  error: string | null;
  server: http.Server;
};

export function createLinearOAuthService(args: {
  credentials: LinearCredentialService;
  logger?: Logger | null;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const sessions = new Map<string, LinearOAuthSessionState>();

  const finalizeSession = (session: LinearOAuthSessionState, patch: {
    status: LinearOAuthSessionState["status"];
    error?: string | null;
  }) => {
    session.status = patch.status;
    session.error = patch.error ?? null;
    try {
      session.server.close();
    } catch {
      // best effort
    }
  };

  const pruneExpiredSessions = () => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.status === "pending" && now - session.createdAt > SESSION_TTL_MS) {
        finalizeSession(session, {
          status: "expired",
          error: "Linear OAuth session expired before the callback completed.",
        });
      }
      if (session.status !== "pending" && now - session.createdAt > SESSION_TTL_MS * 2) {
        sessions.delete(session.id);
      }
    }
  };

  const exchangeCode = async (session: LinearOAuthSessionState, code: string): Promise<void> => {
    const oauthClient = args.credentials.getOAuthClientCredentials();
    if (!oauthClient) {
      throw new Error("Linear OAuth client credentials are missing. Add them under .ade/secrets/linear-oauth.v1.json.");
    }

    const response = await fetchImpl(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: session.redirectUri,
        client_id: oauthClient.clientId,
        client_secret: oauthClient.clientSecret,
      }),
    });

    const payload = await response.json().catch(() => ({})) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token.trim()) {
      throw new Error(payload.error_description ?? payload.error ?? `Linear OAuth token exchange failed (HTTP ${response.status}).`);
    }

    const expiresAt =
      typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
        : null;

    args.credentials.setOAuthToken({
      accessToken: payload.access_token.trim(),
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token.trim() : null,
      expiresAt,
    });
  };

  const startSession = async (): Promise<CtoStartLinearOAuthResult> => {
    pruneExpiredSessions();
    const oauthClient = args.credentials.getOAuthClientCredentials();
    if (!oauthClient) {
      throw new Error("Linear OAuth client credentials are missing. Add .ade/secrets/linear-oauth.v1.json with clientId and clientSecret.");
    }

    const sessionId = `linear-oauth-${randomUUID()}`;
    const state = randomUUID();

    let session: LinearOAuthSessionState | null = null;
    const server = http.createServer(async (req, res) => {
      if (!session) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("OAuth session not ready.");
        return;
      }

      try {
        const requestUrl = new URL(req.url ?? CALLBACK_PATH, session.redirectUri);
        const returnedState = requestUrl.searchParams.get("state");
        const code = requestUrl.searchParams.get("code");
        const error = requestUrl.searchParams.get("error");
        const errorDescription = requestUrl.searchParams.get("error_description");

        if (returnedState !== session.state) {
          finalizeSession(session, {
            status: "failed",
            error: "OAuth callback state did not match the active Linear session.",
          });
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("OAuth state mismatch.");
          return;
        }

        if (error) {
          finalizeSession(session, {
            status: "failed",
            error: errorDescription ?? error,
          });
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("Linear authorization was declined.");
          return;
        }

        if (!code) {
          finalizeSession(session, {
            status: "failed",
            error: "Linear OAuth callback did not include an authorization code.",
          });
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("Missing authorization code.");
          return;
        }

        await exchangeCode(session, code);
        finalizeSession(session, { status: "completed" });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><html><body style=\"font-family:system-ui;padding:24px\">Linear connected. You can close this window and return to ADE.</body></html>");
      } catch (error) {
        const message = error instanceof Error ? error.message : "OAuth callback failed.";
        finalizeSession(session, { status: "failed", error: message });
        args.logger?.warn("linear_sync.oauth_callback_failed", {
          error: message,
        });
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(message);
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to allocate a loopback port for Linear OAuth.");
    }

    const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
    const authUrl = new URL(LINEAR_AUTHORIZE_URL);
    authUrl.searchParams.set("client_id", oauthClient.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("scope", "read,write");

    session = {
      id: sessionId,
      state,
      redirectUri,
      authUrl: authUrl.toString(),
      createdAt: Date.now(),
      status: "pending",
      error: null,
      server,
    };
    sessions.set(sessionId, session);

    return {
      sessionId,
      authUrl: session.authUrl,
      redirectUri,
    };
  };

  const getSession = (sessionId: string): CtoGetLinearOAuthSessionResult => {
    pruneExpiredSessions();
    const session = sessions.get(sessionId);
    if (!session) {
      return {
        status: "expired",
        error: "Linear OAuth session not found or already expired.",
      };
    }
    return {
      status: session.status,
      error: session.error,
    };
  };

  return {
    startSession,
    getSession,
    dispose() {
      for (const session of sessions.values()) {
        try {
          session.server.close();
        } catch {
          // best effort
        }
      }
      sessions.clear();
    },
  };
}

export type LinearOAuthService = ReturnType<typeof createLinearOAuthService>;
