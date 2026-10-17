import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Apple Music developer token: an ES256 JWT signed with ADE's MusicKit key.
 *
 * Production: the account-directory Worker mints it (`GET /music/developer-token`,
 * signed-in ADE users only) from the key it holds as a secret. The key never
 * ships in the app.
 *
 * Development: an unpackaged build may mint it locally from the `.p8` file, when
 * `ADE_MUSICKIT_KEY_PATH` names it or it sits at the default path below. A
 * packaged build never looks for a local key, whatever the environment says.
 *
 * The token is public by design (MusicKit JS hands it to Apple from the page),
 * so it is kept in memory and refreshed before it runs out. The key's bytes are
 * read only to sign and are never logged; a log line masks a token to its first
 * six characters.
 */

export const MUSICKIT_TEAM_ID = "VQ372F39G6";
export const MUSICKIT_KEY_ID = "3NNQ5Y43RA";
/** Same lifetime the Worker issues. Apple allows up to six months. */
export const DEVELOPER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/**
 * Refresh this long before expiry: a player host keeps the token it started
 * with for its whole run. Half the token's remaining life when it arrived, if
 * that is shorter, so a short-lived token is not fetched again on every call.
 */
const REFRESH_MARGIN_MS = 24 * 60 * 60_000;

export type DeveloperToken = { token: string; expiresAt: number; source: "local" | "worker" };

export class MusicTokenUnavailableError extends Error {
  readonly reason: "signed_out" | "service" | "no_key";
  constructor(message: string, reason: "signed_out" | "service" | "no_key") {
    super(message);
    this.name = "MusicTokenUnavailableError";
    this.reason = reason;
  }
}

export function maskToken(token: string | null | undefined): string {
  if (!token) return "(none)";
  return `${token.slice(0, 6)}…`;
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Sign a MusicKit developer token. Header `{alg:ES256,kid}`, claims `{iss,iat,exp}`. */
export function mintDeveloperToken(args: {
  privateKeyPem: string;
  keyId: string;
  teamId: string;
  ttlSeconds?: number;
  nowMs?: number;
}): { token: string; expiresAt: number } {
  const iat = Math.floor((args.nowMs ?? Date.now()) / 1000);
  const exp = iat + (args.ttlSeconds ?? DEVELOPER_TOKEN_TTL_SECONDS);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: args.keyId }));
  const claims = base64url(JSON.stringify({ iss: args.teamId, iat, exp }));
  const signingInput = `${header}.${claims}`;
  const key = crypto.createPrivateKey(args.privateKeyPem);
  // JWS wants the raw r||s signature, not DER.
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return { token: `${signingInput}.${base64url(signature)}`, expiresAt: exp * 1000 };
}

/** The local key a dev build may sign with, or null. Never consulted when packaged. */
export function resolveLocalMusicKitKey(args: {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  homeDir?: string;
}): { keyPath: string; keyId: string; teamId: string } | null {
  if (args.isPackaged) return null;
  const explicit = args.env.ADE_MUSICKIT_KEY_PATH?.trim();
  const fallback = path.join(args.homeDir ?? os.homedir(), ".ade", "secrets", "musickit", `AuthKey_${MUSICKIT_KEY_ID}.p8`);
  const keyPath = explicit || fallback;
  if (!fs.existsSync(keyPath)) return null;
  const fromName = /AuthKey_([A-Z0-9]{10})\.p8$/i.exec(path.basename(keyPath))?.[1];
  return {
    keyPath,
    keyId: args.env.ADE_MUSICKIT_KEY_ID?.trim() || fromName || MUSICKIT_KEY_ID,
    teamId: args.env.ADE_MUSICKIT_TEAM_ID?.trim() || MUSICKIT_TEAM_ID,
  };
}

export type DeveloperTokenProvider = {
  get: (options?: { forceRefresh?: boolean }) => Promise<DeveloperToken>;
};

export function createDeveloperTokenProvider(args: {
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  /** The account-directory origin, or null when none is configured. */
  directoryBaseUrl: () => string | null;
  /** The signed-in ADE account bearer, or null when signed out. */
  getAccountToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  logger?: { info: (event: string, data?: Record<string, unknown>) => void; warn: (event: string, data?: Record<string, unknown>) => void };
}): DeveloperTokenProvider {
  const env = args.env ?? process.env;
  let cached: DeveloperToken | null = null;
  let refreshMarginMs = REFRESH_MARGIN_MS;
  let inflight: Promise<DeveloperToken> | null = null;
  const local = () => resolveLocalMusicKitKey({ isPackaged: args.isPackaged, env });

  const mintLocal = async (key: NonNullable<ReturnType<typeof local>>): Promise<DeveloperToken> => {
    const privateKeyPem = await fs.promises.readFile(key.keyPath, "utf8");
    const minted = mintDeveloperToken({ privateKeyPem, keyId: key.keyId, teamId: key.teamId });
    args.logger?.info("music.developer_token_minted", { source: "local", token: maskToken(minted.token) });
    return { ...minted, source: "local" };
  };

  const fetchWorker = async (): Promise<DeveloperToken> => {
    const base = args.directoryBaseUrl()?.replace(/\/+$/, "");
    if (!base) throw new MusicTokenUnavailableError("ADE has no account service configured for Music.", "service");
    const bearer = await args.getAccountToken();
    if (!bearer) throw new MusicTokenUnavailableError("Sign in to ADE to use Music.", "signed_out");
    let response: Response;
    try {
      response = await (args.fetchImpl ?? fetch)(`${base}/music/developer-token`, {
        headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new MusicTokenUnavailableError("Couldn't reach ADE's music service. Check your connection.", "service");
    }
    if (response.status === 401) throw new MusicTokenUnavailableError("Sign in to ADE again to use Music.", "signed_out");
    if (!response.ok) throw new MusicTokenUnavailableError(`ADE's music service answered HTTP ${response.status}.`, "service");
    const body = (await response.json()) as { token?: unknown; expiresAt?: unknown };
    if (typeof body.token !== "string" || typeof body.expiresAt !== "number") {
      throw new MusicTokenUnavailableError("ADE's music service sent an unreadable token.", "service");
    }
    args.logger?.info("music.developer_token_fetched", { source: "worker", token: maskToken(body.token) });
    return { token: body.token, expiresAt: body.expiresAt, source: "worker" };
  };

  return {
    get: async (options) => {
      if (!options?.forceRefresh && cached && cached.expiresAt - Date.now() > refreshMarginMs) return cached;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const key = local();
          const next = key ? await mintLocal(key) : await fetchWorker();
          refreshMarginMs = Math.min(REFRESH_MARGIN_MS, Math.max(0, (next.expiresAt - Date.now()) / 2));
          cached = next;
          return next;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
  };
}
