import { importPKCS8, SignJWT } from "jose";

import { authenticate, type CallerTokenEnv } from "./callerToken";
import { logMusicDeveloperTokenRequest } from "./logging";

/**
 * `GET /music/developer-token`: an Apple Music developer token for a signed-in
 * ADE user (README, "Apple Music developer tokens").
 *
 * The token is an ES256 JWT (header `{alg, kid}`, claims `{iss, iat, exp}`)
 * signed with ADE's MusicKit private key. The key lives only here, as the
 * `MUSICKIT_PRIVATE_KEY` secret; the desktop app never ships it. The token is
 * public by design (MusicKit JS hands it to Apple from the page), so one token
 * per isolate serves every caller until it is within `reissueMarginSeconds` of
 * expiry. A player configured with a token keeps it for its whole run, so every
 * token handed out has days left. The account bearer only rations who can ask, the same check the model
 * registry uses.
 *
 * A Worker without the key answers 503 `music_unavailable` rather than failing
 * deploys: Music is optional, the rest of the directory is not.
 */

export const MUSIC_DEVELOPER_TOKEN_PATH = "/music/developer-token";
export const DEFAULT_MUSIC_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Apple's ceiling for a developer token's lifetime (6 months). */
const MAX_TTL_SECONDS = 15_777_000;
/** Hand out a fresh token once the cached one has less than this left (half a short lifetime). */
const reissueMarginSeconds = (ttl: number): number => Math.min(7 * 24 * 60 * 60, Math.floor(ttl / 2));

export type MusicDeveloperTokenEnv = CallerTokenEnv & {
  /** PKCS#8 PEM of the MusicKit `.p8` key. A secret. */
  MUSICKIT_PRIVATE_KEY?: string;
  MUSICKIT_KEY_ID?: string;
  MUSICKIT_TEAM_ID?: string;
  /** Lifetime in seconds; unset or unparseable means 30 days. */
  MUSICKIT_TOKEN_TTL_SECONDS?: string;
};

export const MUSIC_DEVELOPER_TOKEN_ERRORS = {
  unavailable: "music_unavailable",
  methodNotAllowed: "music_method_not_allowed",
} as const;

export function isMusicDeveloperTokenRequest(url: URL): boolean {
  return url.pathname.replace(/\/+$/, "") === MUSIC_DEVELOPER_TOKEN_PATH;
}

let cached: { fingerprint: string; token: string; exp: number } | null = null;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ttlSeconds(raw: string | undefined): number {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 300) return DEFAULT_MUSIC_TOKEN_TTL_SECONDS;
  return Math.min(parsed, MAX_TTL_SECONDS);
}

export async function mintMusicDeveloperToken(
  env: MusicDeveloperTokenEnv,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; exp: number } | null> {
  const pem = env.MUSICKIT_PRIVATE_KEY?.trim();
  const kid = env.MUSICKIT_KEY_ID?.trim();
  const iss = env.MUSICKIT_TEAM_ID?.trim();
  if (!pem || !kid || !iss) return null;
  const ttl = ttlSeconds(env.MUSICKIT_TOKEN_TTL_SECONDS);
  // Rotate the key, the ids or the lifetime and the cache misses on its own.
  const fingerprint = `${kid}:${iss}:${ttl}:${await sha256Hex(pem)}`;
  if (cached && cached.fingerprint === fingerprint && cached.exp - nowSeconds > reissueMarginSeconds(ttl)) {
    return { token: cached.token, exp: cached.exp };
  }
  const key = await importPKCS8(pem, "ES256");
  const exp = nowSeconds + ttl;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(iss)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(exp)
    .sign(key);
  cached = { fingerprint, token, exp };
  return { token, exp };
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

export async function handleMusicDeveloperTokenRequest(
  request: Request,
  env: MusicDeveloperTokenEnv,
): Promise<Response> {
  const startedAt = performance.now();
  const finish = (response: Response, reason?: string): Response => {
    logMusicDeveloperTokenRequest({ status: response.status, reason, durationMs: performance.now() - startedAt });
    return response;
  };
  if (request.method !== "GET") {
    return finish(json({ error: MUSIC_DEVELOPER_TOKEN_ERRORS.methodNotAllowed }, 405, { allow: "GET" }), "method_not_allowed");
  }
  const authentication = await authenticate(request, env);
  if (!authentication.ok) {
    const status = authentication.reason === "authentication unavailable" ? 503 : 401;
    return finish(json({ error: authentication.reason }, status), authentication.reason);
  }
  try {
    const minted = await mintMusicDeveloperToken(env);
    if (!minted) return finish(json({ error: MUSIC_DEVELOPER_TOKEN_ERRORS.unavailable }, 503), "not_configured");
    return finish(json({ token: minted.token, expiresAt: minted.exp * 1000 }, 200));
  } catch {
    // A malformed key. Never echo JOSE's message: it can quote key material.
    return finish(json({ error: MUSIC_DEVELOPER_TOKEN_ERRORS.unavailable }, 503), "sign_failed");
  }
}
