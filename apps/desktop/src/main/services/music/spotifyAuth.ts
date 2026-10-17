import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { MUSIC_SPOTIFY_CALLBACK_PORT } from "../../../shared/types/music";

/**
 * Spotify sign-in for a desktop app: Authorization Code with PKCE, no client
 * secret, the consent page in the user's default browser, and the answer on a
 * one-shot loopback listener.
 *
 * - The Client ID is the user's own Spotify app (developer.spotify.com). ADE
 *   cannot ship one: a Development Mode app takes five allow-listed users, and
 *   Extended Quota is for organisations with 250k monthly users.
 * - The redirect is `http://127.0.0.1:43219/spotify/callback`
 *   (`MUSIC_SPOTIFY_REDIRECT_URI`). Spotify's docs allow a portless loopback
 *   URI matched with any port, but its dashboard rejects one as "not secure",
 *   so the port is fixed and the user registers it as is.
 * - The listener binds 127.0.0.1 only, answers one `GET /spotify/callback`
 *   whose `state` matches, and closes. Everything else gets a 404.
 * - Tokens never reach a log. The refresh token is persisted by the caller
 *   (safeStorage); the access token lives in memory for its hour.
 */

export const SPOTIFY_SCOPES = [
  // Playing inside ADE (the Web Playback SDK needs all three).
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
] as const;

const ACCOUNTS = "https://accounts.spotify.com";
const CALLBACK_PATH = "/spotify/callback";
export const SPOTIFY_AUTHORIZE_TIMEOUT_MS = 10 * 60_000;

export type SpotifyTokens = {
  accessToken: string;
  /** Epoch ms when the access token stops working. */
  expiresAt: number;
  refreshToken: string;
  scope: string;
};

export class SpotifyAuthError extends Error {
  readonly code: "cancelled" | "denied" | "timeout" | "state_mismatch" | "exchange_failed" | "invalid_grant" | "network";
  constructor(message: string, code: SpotifyAuthError["code"]) {
    super(message);
    this.name = "SpotifyAuthError";
    this.code = code;
  }
}

/** A Spotify Client ID: 32 hex characters. */
export function normalizeSpotifyClientId(value: string | null | undefined): string | null {
  const id = (value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}

const base64url = (buffer: Buffer): string =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  `<meta name="color-scheme" content="light dark"><style>body{font:15px system-ui,sans-serif;margin:15vh auto;max-width:28rem;padding:0 1.5rem;line-height:1.5}</style>` +
  `</head><body><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`;

type TokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(
  params: Record<string, string>,
  fetchImpl: typeof fetch,
  previousRefreshToken?: string,
): Promise<SpotifyTokens> {
  let response: Response;
  try {
    response = await fetchImpl(`${ACCOUNTS}/api/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SpotifyAuthError("Couldn't reach Spotify. Check your connection.", "network");
  }
  const body = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !body.access_token) {
    // A refresh token Spotify no longer accepts (revoked, app changed): sign in again.
    if (body.error === "invalid_grant" || body.error === "invalid_client") {
      throw new SpotifyAuthError("Spotify needs you to connect again.", "invalid_grant");
    }
    throw new SpotifyAuthError(`Spotify sign-in failed (HTTP ${response.status}).`, "exchange_failed");
  }
  const refreshToken = body.refresh_token ?? previousRefreshToken;
  if (!refreshToken) throw new SpotifyAuthError("Spotify didn't return a sign-in that ADE can keep.", "exchange_failed");
  return {
    accessToken: body.access_token,
    // A minute early, so a call never leaves with a token that dies in flight.
    expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000,
    refreshToken,
    scope: body.scope ?? "",
  };
}

/** Trade a refresh token for a fresh access token. Spotify may rotate the refresh token too. */
export function refreshSpotifyTokens(args: {
  clientId: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<SpotifyTokens> {
  return tokenRequest(
    { grant_type: "refresh_token", refresh_token: args.refreshToken, client_id: args.clientId },
    args.fetchImpl ?? fetch,
    args.refreshToken,
  );
}

export type SpotifySignIn = {
  /** The consent page; open it in the default browser (again, for "show sign-in"). */
  authorizeUrl: string;
  /** Resolves with tokens once Spotify redirects back; rejects on deny, cancel or timeout. */
  result: Promise<SpotifyTokens>;
  cancel: () => void;
};

/**
 * Start a sign-in: bind the loopback listener, build the consent URL. The
 * caller opens `authorizeUrl` and waits on `result`.
 */
export async function startSpotifySignIn(args: {
  clientId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SpotifySignIn> {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(24));

  let settle: { resolve: (tokens: SpotifyTokens) => void; reject: (error: Error) => void } | null = null;
  const result = new Promise<SpotifyTokens>((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => {});

  let done = false;
  /** The one callback that counts has arrived; later ones are refused. */
  let consumed = false;
  let timer: NodeJS.Timeout | null = null;
  const server = http.createServer();
  const finish = (outcome: { tokens: SpotifyTokens } | { error: Error }) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    server.close();
    // Browsers keep the connection alive; do not let it hold the listener open.
    server.closeAllConnections?.();
    if ("tokens" in outcome) settle!.resolve(outcome.tokens);
    else settle!.reject(outcome.error);
  };

  let redirectUri = "";
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || done || consumed) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    const returnedState = url.searchParams.get("state") ?? "";
    if (!sameSecret(returnedState, state)) {
      // Not our sign-in (a stale tab, another page): ignore it and keep waiting.
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(page("This sign-in link is out of date", "Go back to ADE and press Connect Spotify again."));
      return;
    }
    // From here this sign-in is decided by this request: a reload or a second
    // tab cannot start another code exchange.
    consumed = true;
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" };
    if (error || !code) {
      res.writeHead(200, headers).end(page("Spotify wasn't connected", "You can close this tab and go back to ADE."));
      finish({
        error: error === "access_denied"
          ? new SpotifyAuthError("Sign-in was cancelled.", "denied")
          : new SpotifyAuthError("Spotify didn't finish the sign-in.", "exchange_failed"),
      });
      return;
    }
    // The page answers once the exchange has, so it never claims a sign-in that failed.
    tokenRequest(
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: args.clientId,
        code_verifier: verifier,
      },
      args.fetchImpl ?? fetch,
    ).then(
      (tokens) => {
        res.writeHead(200, headers).end(page("Spotify sign-in received", "You can close this tab and go back to ADE."));
        finish({ tokens });
      },
      (exchangeError: Error) => {
        res.writeHead(200, headers).end(page("Spotify wasn't connected", "Go back to ADE to see why and try again."));
        finish({ error: exchangeError });
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    const port = MUSIC_SPOTIFY_CALLBACK_PORT;
    const onError = (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE"
        ? new SpotifyAuthError(`Another app is using port ${port}, which Spotify sign-in needs. Close it and try again.`, "network")
        : error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  timer = setTimeout(
    () => finish({ error: new SpotifyAuthError("Spotify sign-in timed out.", "timeout") }),
    args.timeoutMs ?? SPOTIFY_AUTHORIZE_TIMEOUT_MS,
  );
  timer.unref?.();

  const authorizeUrl = `${ACCOUNTS}/authorize?${new URLSearchParams({
    client_id: args.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SPOTIFY_SCOPES.join(" "),
  }).toString()}`;

  return {
    authorizeUrl,
    result,
    cancel: () => finish({ error: new SpotifyAuthError("Sign-in was cancelled.", "cancelled") }),
  };
}
