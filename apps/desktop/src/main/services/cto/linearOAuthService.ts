import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type {
  CtoGetLinearOAuthSessionResult,
  CtoStartLinearOAuthResult,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { LinearCredentialService } from "./linearCredentialService";
import { createPkcePair } from "../shared/utils";

const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const CALLBACK_PATH = "/oauth/callback";
const OAUTH_HOST = "127.0.0.1";
const OAUTH_PORT = 19836;
const LOOPBACK_SESSION_TTL_MS = 10 * 60 * 1000;
const EXTERNAL_SESSION_TTL_MS = 5 * 60 * 1000;

export const LINEAR_MOBILE_OAUTH_REDIRECT_URI =
  "https://ade-github-webhook-relay.arulsharma1028.workers.dev/linear/oauth/callback";

type LinearOAuthSessionState = {
  id: string;
  state: string;
  redirectUri: string;
  authUrl: string;
  codeVerifier: string | null;
  createdAt: number;
  status: CtoGetLinearOAuthSessionResult["status"];
  error: string | null;
  callbackClaimed: boolean;
  server: http.Server;
  abortController: AbortController;
  closePromise: Promise<void> | null;
};

type LinearExternalOAuthSessionState = {
  id: string;
  state: string;
  redirectUri: string;
  authorizeUrl: string;
  codeVerifier: string;
  createdAt: number;
  expiresAt: string;
  completionInFlight: Promise<LinearExternalOAuthCompleteResult> | null;
};

export type LinearExternalOAuthStartResult = {
  sessionId: string;
  authorizeUrl: string;
  expiresAt: string;
};

export type LinearExternalOAuthCompleteResult =
  | { ok: true }
  | { ok: false; message: string };

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "EADDRINUSE") return true;
  return error instanceof Error && (
    error.message.includes("EADDRINUSE") || error.message.includes("address already in use")
  );
}

function createOAuthPortInUseError(): Error {
  const error = new Error(
    `Linear OAuth cannot start because callback port ${OAUTH_PORT} is already in use on ${OAUTH_HOST}. ` +
    `Stop the other ADE process or local app using that port, then try Sign in with Linear again.`,
  ) as Error & { code?: string };
  error.code = "EADDRINUSE";
  return error;
}

function closeServerAndWait(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function writeResponse(
  response: http.ServerResponse,
  status: number,
  contentType: string,
  body: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off("finish", finish);
      response.off("close", finish);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    response.once("finish", finish);
    response.once("close", finish);
    try {
      response.writeHead(status, { "content-type": contentType });
      response.end(body);
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

export function createLinearOAuthService(args: {
  credentials: LinearCredentialService;
  logger?: Logger | null;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const sessions = new Map<string, LinearOAuthSessionState>();
  const externalSessions = new Map<string, LinearExternalOAuthSessionState>();
  let disposed = false;
  let startingServer: http.Server | null = null;
  let disposeInFlight: Promise<void> | null = null;

  const assertActive = (): void => {
    if (disposed) throw new Error("Linear OAuth service is no longer active.");
  };

  const markSessionTerminal = (session: LinearOAuthSessionState, patch: {
    status: LinearOAuthSessionState["status"];
    error?: string | null;
  }): void => {
    session.status = patch.status;
    session.error = patch.error ?? null;
    session.abortController.abort();
  };

  const beginServerClose = (session: LinearOAuthSessionState): Promise<void> => {
    const closed = closeServerAndWait(session.server);
    session.server.closeIdleConnections();
    return closed;
  };

  const closeSessionServer = (session: LinearOAuthSessionState): Promise<void> => {
    if (!session.closePromise) session.closePromise = beginServerClose(session);
    return session.closePromise;
  };

  const forceCloseSessionServer = (session: LinearOAuthSessionState): Promise<void> => {
    const closed = closeSessionServer(session);
    session.server.closeAllConnections();
    return closed;
  };

  const finalizeSession = (session: LinearOAuthSessionState, patch: {
    status: LinearOAuthSessionState["status"];
    error?: string | null;
  }): Promise<void> => {
    markSessionTerminal(session, patch);
    return patch.status === "expired"
      ? forceCloseSessionServer(session)
      : closeSessionServer(session);
  };

  const respondAndFinalizeSession = (
    session: LinearOAuthSessionState,
    patch: {
      status: LinearOAuthSessionState["status"];
      error?: string | null;
    },
    response: http.ServerResponse,
    reply: {
      status: number;
      contentType: string;
      body: string;
    },
  ): Promise<void> => {
    markSessionTerminal(session, patch);
    return writeResponse(response, reply.status, reply.contentType, reply.body)
      .then(() => closeSessionServer(session));
  };

  const respondAlreadyFinished = (response: http.ServerResponse): Promise<void> => (
    writeResponse(
      response,
      409,
      "text/plain; charset=utf-8",
      "This Linear sign-in has already finished. Return to ADE to continue.",
    )
  );

  const respondAlreadyFinishedAndClose = async (
    session: LinearOAuthSessionState,
    response: http.ServerResponse,
  ): Promise<void> => {
    try {
      await respondAlreadyFinished(response);
    } catch (error) {
      args.logger?.warn("linear_sync.oauth_callback_fallback_response_failed", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await forceCloseSessionServer(session);
    }
  };

  const respondCallbackInProgress = (response: http.ServerResponse): Promise<void> => (
    writeResponse(
      response,
      409,
      "text/plain; charset=utf-8",
      "This Linear sign-in is already being completed. Return to ADE to continue.",
    )
  );

  const pruneExpiredSessions = () => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.status === "pending" && now - session.createdAt > LOOPBACK_SESSION_TTL_MS) {
        void finalizeSession(session, {
          status: "expired",
          error: "Linear OAuth session expired before the callback completed.",
        });
      }
      if (session.status !== "pending" && now - session.createdAt > LOOPBACK_SESSION_TTL_MS * 2) {
        sessions.delete(session.id);
      }
    }
  };

  const pruneExpiredExternalSessions = () => {
    const now = Date.now();
    for (const session of externalSessions.values()) {
      if (now - session.createdAt >= EXTERNAL_SESSION_TTL_MS) {
        externalSessions.delete(session.id);
      }
    }
  };

  const buildAuthorizeUrl = (input: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge?: string | null;
  }): string => {
    const authorizeUrl = new URL(LINEAR_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("client_id", input.clientId);
    authorizeUrl.searchParams.set("redirect_uri", input.redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", input.state);
    // The ADE app's data-change webhooks only deliver for a workspace whose
    // authorization carries the admin scope (Linear's OAuth-app webhook rule).
    // Custom OAuth clients keep the narrower grant.
    authorizeUrl.searchParams.set(
      "scope",
      args.credentials.getOAuthClientSource() === "ade-app" ? "read,write,admin" : "read,write",
    );
    // Keep authorization user-scoped. This is Linear's default, but making it
    // explicit keeps the desktop and mobile authorize URLs byte-for-byte aligned.
    authorizeUrl.searchParams.set("actor", "user");
    // Ask Linear for a consent screen; Linear still resolves the workspace
    // from the user's active browser session/workspace switcher.
    authorizeUrl.searchParams.set("prompt", "consent");
    if (input.codeChallenge) {
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("code_challenge", input.codeChallenge);
    }
    return authorizeUrl.toString();
  };

  const exchangeCode = async (
    session: Pick<LinearOAuthSessionState, "redirectUri" | "codeVerifier">,
    code: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const oauthClient = args.credentials.getOAuthClientCredentials();
    if (!oauthClient) {
      throw new Error("Linear OAuth is not configured. Configure it in Settings > Linear.");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: session.redirectUri,
      client_id: oauthClient.clientId,
    });
    if (oauthClient.clientSecret?.trim()) {
      body.set("client_secret", oauthClient.clientSecret.trim());
    }
    if (session.codeVerifier) {
      body.set("code_verifier", session.codeVerifier);
    }

    const response = await fetchImpl(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal,
    });

    const payload = await response.json().catch(() => ({})) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Linear OAuth session was cancelled.");
    }

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

  const startSessionOnce = async (): Promise<CtoStartLinearOAuthResult> => {
    assertActive();
    pruneExpiredSessions();
    // Close any leftover pending sessions so the fixed port is available.
    // This handles the case where the user closed the browser tab without
    // completing or cancelling the previous OAuth flow.
    const supersededSessions: Promise<void>[] = [];
    for (const prev of sessions.values()) {
      if (prev.status === "pending") {
        supersededSessions.push(finalizeSession(prev, {
          status: "expired",
          error: "Superseded by a new OAuth attempt.",
        }));
      } else if (prev.closePromise) {
        supersededSessions.push(prev.closePromise);
      }
    }
    await Promise.all(supersededSessions);
    assertActive();
    const oauthClient = args.credentials.getOAuthClientCredentials();
    if (!oauthClient) {
      throw new Error("Linear OAuth is not configured. Configure it in Settings > Linear.");
    }

    const sessionId = `linear-oauth-${randomUUID()}`;
    const state = randomUUID();
    const pkce = oauthClient.clientSecret?.trim().length ? null : createPkcePair();

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
          args.logger?.warn("linear_sync.oauth_callback_state_mismatch", {
            sessionId: session.id,
            hasReturnedState: returnedState != null,
          });
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("OAuth state mismatch. Return to ADE and continue the active Linear sign-in.");
          return;
        }

        if (session.status !== "pending") {
          await respondAlreadyFinished(res);
          return;
        }
        if (session.callbackClaimed) {
          await respondCallbackInProgress(res);
          return;
        }
        // Authorization codes are single-use. Claim the callback synchronously
        // before the token exchange yields so a duplicate request cannot race
        // the owning callback or change its terminal outcome.
        session.callbackClaimed = true;

        if (error) {
          await respondAndFinalizeSession(
            session,
            { status: "failed", error: errorDescription ?? error },
            res,
            {
              status: 400,
              contentType: "text/plain; charset=utf-8",
              body: "Linear authorization was declined.",
            },
          );
          return;
        }

        if (!code) {
          await respondAndFinalizeSession(
            session,
            {
              status: "failed",
              error: "Linear OAuth callback did not include an authorization code.",
            },
            res,
            {
              status: 400,
              contentType: "text/plain; charset=utf-8",
              body: "Missing authorization code.",
            },
          );
          return;
        }

        await exchangeCode(session, code, session.abortController.signal);
        if (session.status !== "pending") {
          await respondAlreadyFinishedAndClose(session, res);
          return;
        }
        await respondAndFinalizeSession(
          session,
          { status: "completed" },
          res,
          {
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: "<!doctype html><html><body style=\"font-family:Geist,-apple-system,BlinkMacSystemFont,sans-serif;padding:24px\">Linear connected. You can close this window and return to ADE.</body></html>",
          },
        );
      } catch (error) {
        if (session.status !== "pending") {
          await respondAlreadyFinishedAndClose(session, res);
          return;
        }
        const message = error instanceof Error ? error.message : "OAuth callback failed.";
        args.logger?.warn("linear_sync.oauth_callback_failed", {
          error: message,
        });
        await respondAndFinalizeSession(
          session,
          { status: "failed", error: message },
          res,
          {
            status: 500,
            contentType: "text/plain; charset=utf-8",
            body: message,
          },
        );
      }
    });
    startingServer = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          server.off("error", onError);
          server.off("close", onClose);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          reject(new Error("Linear OAuth callback server closed before it started."));
        };
        server.once("error", onError);
        server.once("close", onClose);
        server.listen(OAUTH_PORT, OAUTH_HOST, () => {
          cleanup();
          resolve();
        });
      });
    } catch (error) {
      if (startingServer === server) startingServer = null;
      try {
        server.close();
      } catch {
        // best effort
      }

      if (disposed) assertActive();

      if (isAddressInUseError(error)) {
        args.logger?.warn("linear_sync.oauth_callback_port_in_use", {
          host: OAUTH_HOST,
          port: OAUTH_PORT,
          error: error instanceof Error ? error.message : String(error),
        });
        throw createOAuthPortInUseError();
      }
      throw error;
    }
    if (disposed) {
      if (startingServer === server) startingServer = null;
      const closed = closeServerAndWait(server);
      server.closeAllConnections();
      await closed;
      assertActive();
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to allocate a loopback port for Linear OAuth.");
    }

    const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
    const authUrl = buildAuthorizeUrl({
      clientId: oauthClient.clientId,
      redirectUri,
      state,
      codeChallenge: pkce?.challenge,
    });

    session = {
      id: sessionId,
      state,
      redirectUri,
      authUrl,
      codeVerifier: pkce?.verifier ?? null,
      createdAt: Date.now(),
      status: "pending",
      error: null,
      callbackClaimed: false,
      server,
      abortController: new AbortController(),
      closePromise: null,
    };
    sessions.set(sessionId, session);
    if (startingServer === server) startingServer = null;

    return {
      sessionId,
      authUrl: session.authUrl,
      redirectUri,
    };
  };

  let startSessionInFlight: Promise<CtoStartLinearOAuthResult> | null = null;
  const startSession = (): Promise<CtoStartLinearOAuthResult> => {
    if (disposed) return Promise.reject(new Error("Linear OAuth service is no longer active."));
    if (startSessionInFlight) return startSessionInFlight;
    const work = startSessionOnce().finally(() => {
      if (startSessionInFlight === work) startSessionInFlight = null;
    });
    startSessionInFlight = work;
    return work;
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

  const startExternalSession = async (input: {
    redirectUri: string;
  }): Promise<LinearExternalOAuthStartResult> => {
    pruneExpiredExternalSessions();
    const oauthClient = args.credentials.getOAuthClientCredentials();
    if (!oauthClient) {
      throw new Error("Linear OAuth is not configured. Configure it in Settings > Linear.");
    }

    const sessionId = `linear-oauth-${randomUUID()}`;
    const state = randomUUID();
    const pkce = createPkcePair();
    const createdAt = Date.now();
    const expiresAt = new Date(createdAt + EXTERNAL_SESSION_TTL_MS).toISOString();
    const authorizeUrl = buildAuthorizeUrl({
      clientId: oauthClient.clientId,
      redirectUri: input.redirectUri,
      state,
      codeChallenge: pkce.challenge,
    });

    externalSessions.set(sessionId, {
      id: sessionId,
      state,
      redirectUri: input.redirectUri,
      authorizeUrl,
      codeVerifier: pkce.verifier,
      createdAt,
      expiresAt,
      completionInFlight: null,
    });

    return { sessionId, authorizeUrl, expiresAt };
  };

  const completeExternalSession = async (input: {
    sessionId: string;
    code: string;
    state: string;
  }): Promise<LinearExternalOAuthCompleteResult> => {
    pruneExpiredExternalSessions();
    const session = externalSessions.get(input.sessionId);
    if (!session) {
      return {
        ok: false,
        message: "Linear OAuth session was not found or has expired. Start a new sign-in and try again.",
      };
    }
    if (input.state !== session.state) {
      args.logger?.warn("linear_sync.external_oauth_state_mismatch", {
        sessionId: session.id,
        hasReturnedState: input.state.length > 0,
      });
      return {
        ok: false,
        message: "Linear OAuth state did not match the active sign-in. Start a new sign-in and try again.",
      };
    }
    if (session.completionInFlight) return session.completionInFlight;

    const completion = exchangeCode(session, input.code)
      .then<LinearExternalOAuthCompleteResult>(() => {
        externalSessions.delete(session.id);
        return { ok: true };
      })
      .catch<LinearExternalOAuthCompleteResult>((error: unknown) => {
        const message = error instanceof Error && error.message
          ? error.message
          : "Linear OAuth token exchange failed.";
        args.logger?.warn("linear_sync.external_oauth_exchange_failed", {
          sessionId: session.id,
          error: message,
        });
        return { ok: false, message };
      })
      .finally(() => {
        if (session.completionInFlight === completion) session.completionInFlight = null;
      });
    session.completionInFlight = completion;
    return completion;
  };

  return {
    startSession,
    getSession,
    startExternalSession,
    completeExternalSession,
    dispose(): Promise<void> {
      if (disposeInFlight) return disposeInFlight;
      disposed = true;
      const closePromises: Promise<void>[] = [];
      if (startingServer) {
        const server = startingServer;
        startingServer = null;
        closePromises.push(closeServerAndWait(server));
        server.closeAllConnections();
      }
      for (const session of sessions.values()) {
        closePromises.push(finalizeSession(session, {
          status: "expired",
          error: "Linear OAuth service stopped.",
        }));
      }
      sessions.clear();
      externalSessions.clear();
      disposeInFlight = Promise.all(closePromises).then(() => undefined);
      return disposeInFlight;
    },
  };
}

export type LinearOAuthService = ReturnType<typeof createLinearOAuthService>;
