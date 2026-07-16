import {
  DEFAULT_ADE_CLERK_ISSUER,
  DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
  DEVELOPMENT_ADE_CLERK_ISSUER,
  DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
  fetchAccountMachines,
  parseTrustedAccountDirectoryBaseUrl,
  resolveTrustedAccountDirectoryBaseUrl,
  trustedAccountRelayBaseUrls,
} from "../../../shared/accountDirectory";
import type {
  AdeAccountMachine,
  AdeAccountMachinesResult,
} from "../../../shared/types/account";

const OAUTH_STATE_KEY = "ade-web:account-oauth-state";
const OAUTH_VERIFIER_KEY = "ade-web:account-oauth-verifier";
const OAUTH_RETURN_PATH_KEY = "ade-web:account-oauth-return-path";
const REFRESH_SKEW_MS = 2 * 60_000;

type BrowserAccountConfig = {
  issuer: string;
  clientId: string;
  directoryBaseUrl: string;
  relayBaseUrls: string[];
};

type BrowserAccountSession = {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number;
  userId: string | null;
  email: string | null;
  name: string | null;
};

export type BrowserAccountState =
  | "loading"
  | "signed_out"
  | "signed_in"
  | "auth_expired"
  | "directory_unavailable"
  | "unconfigured";

export type BrowserAccountSnapshot = {
  state: BrowserAccountState;
  userId: string | null;
  email: string | null;
  name: string | null;
  machines: AdeAccountMachine[];
  relayBaseUrls: string[];
  message: string | null;
};

export type BrowserAccountSessionLease = Readonly<{
  userId: string;
  generation: number;
}>;

type TokenPayload = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number;
};

class TokenExchangeError extends Error {
  constructor(message: string, readonly invalidatesSession: boolean) {
    super(message);
  }
}

type BrowserLocation = Pick<Location, "origin" | "pathname" | "search" | "assign">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBase64Url(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

function decodeClaims(accessToken: string): Pick<BrowserAccountSession, "userId" | "email" | "name"> {
  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded) throw new Error("missing claims");
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as unknown;
    if (!isRecord(claims)) throw new Error("invalid claims");
    const givenName = stringValue(claims.given_name ?? claims.first_name);
    const familyName = stringValue(claims.family_name ?? claims.last_name);
    return {
      userId: stringValue(claims.sub),
      email: stringValue(claims.email ?? claims.primary_email ?? claims.email_address),
      name: stringValue(claims.name) ?? ([givenName, familyName].filter(Boolean).join(" ") || null),
    };
  } catch {
    return { userId: null, email: null, name: null };
  }
}

export function readBrowserAccountConfig(env: Record<string, unknown>): BrowserAccountConfig | null {
  const development = env.DEV === true;
  const issuer = parseTrustedAccountDirectoryBaseUrl(
    stringValue(env.VITE_ADE_CLERK_ISSUER)
      ?? (development ? DEVELOPMENT_ADE_CLERK_ISSUER : DEFAULT_ADE_CLERK_ISSUER),
  );
  const directoryOverride = stringValue(env.VITE_ADE_ACCOUNT_DIRECTORY_URL);
  const directoryBaseUrl = development && !directoryOverride
    ? DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL
    : resolveTrustedAccountDirectoryBaseUrl(directoryOverride);
  const clientId = stringValue(env.VITE_ADE_CLERK_OAUTH_CLIENT_ID)
    ?? (development
      ? DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID
      : DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID);
  if (!issuer || !directoryBaseUrl || !clientId) return null;
  const configuredRelayBaseUrls = stringValue(env.VITE_ADE_ACCOUNT_RELAY_URLS)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    ?? [];
  return {
    issuer,
    clientId,
    directoryBaseUrl,
    relayBaseUrls: trustedAccountRelayBaseUrls(configuredRelayBaseUrls),
  };
}

function parseTokenPayload(value: unknown, priorRefreshToken: string | null): TokenPayload | null {
  if (!isRecord(value)) return null;
  const accessToken = stringValue(value.access_token);
  const refreshToken = stringValue(value.refresh_token) ?? priorRefreshToken;
  const expiresInSec = typeof value.expires_in === "number" && Number.isFinite(value.expires_in)
    ? Math.max(1, Math.floor(value.expires_in))
    : 3600;
  return accessToken ? { accessToken, refreshToken, expiresInSec } : null;
}

export class BrowserAccountClient {
  private session: BrowserAccountSession | null = null;
  private sessionGeneration = 0;
  private refreshPromise: Promise<string> | null = null;
  private snapshot: BrowserAccountSnapshot;

  constructor(private readonly options: {
    config?: BrowserAccountConfig | null;
    fetchImpl?: typeof fetch;
    location?: BrowserLocation;
    history?: Pick<History, "replaceState">;
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    now?: () => number;
  } = {}) {
    const config = this.config;
    this.snapshot = {
      state: config ? "signed_out" : "unconfigured",
      userId: null,
      email: null,
      name: null,
      machines: [],
      relayBaseUrls: config?.relayBaseUrls ?? trustedAccountRelayBaseUrls(),
      message: config
        ? null
        : "Account sign-in isn't configured for this web client. Direct pairing is still available.",
    };
  }

  private get config(): BrowserAccountConfig | null {
    return this.options.config === undefined
      ? readBrowserAccountConfig(import.meta.env as Record<string, unknown>)
      : this.options.config;
  }

  private get location(): BrowserLocation {
    return this.options.location ?? window.location;
  }

  private get storage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
    return this.options.storage ?? window.sessionStorage;
  }

  getSnapshot(): BrowserAccountSnapshot {
    return {
      ...this.snapshot,
      machines: [...this.snapshot.machines],
      relayBaseUrls: [...this.snapshot.relayBaseUrls],
    };
  }

  getRelayBaseUrls(): string[] {
    return [...this.snapshot.relayBaseUrls];
  }

  captureSessionLease(): BrowserAccountSessionLease | null {
    const userId = this.session?.userId?.trim() ?? "";
    if (
      !userId
      || (this.snapshot.state !== "signed_in" && this.snapshot.state !== "directory_unavailable")
    ) {
      return null;
    }
    return { userId, generation: this.sessionGeneration };
  }

  isSessionLeaseCurrent(lease: BrowserAccountSessionLease): boolean {
    const current = this.captureSessionLease();
    return current?.userId === lease.userId && current.generation === lease.generation;
  }

  async bootstrap(): Promise<BrowserAccountSnapshot> {
    const config = this.config;
    if (!config) return this.getSnapshot();
    const params = new URLSearchParams(this.location.search);
    if (this.location.pathname !== "/account/callback") {
      this.snapshot = { ...this.snapshot, state: "signed_out", message: null };
      return this.getSnapshot();
    }

    const expectedState = this.storage.getItem(OAUTH_STATE_KEY);
    const verifier = this.storage.getItem(OAUTH_VERIFIER_KEY);
    const actualState = params.get("state");
    const code = params.get("code");
    const oauthError = params.get("error");
    const returnPath = this.storage.getItem(OAUTH_RETURN_PATH_KEY) || "/";
    this.clearPendingOAuth();
    (this.options.history ?? window.history).replaceState(null, "", returnPath.startsWith("/") ? returnPath : "/");

    if (oauthError || !code || !expectedState || actualState !== expectedState || !verifier) {
      this.snapshot = {
        ...this.snapshot,
        state: "auth_expired",
        message: oauthError ? "ADE account sign-in was not completed." : "ADE account sign-in could not be verified. Try again.",
      };
      return this.getSnapshot();
    }

    try {
      const token = await this.postToken(config, {
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: `${this.location.origin}/account/callback`,
      }, null);
      this.setSession(token);
      return await this.loadMachines();
    } catch {
      this.session = null;
      this.sessionGeneration += 1;
      this.snapshot = {
        ...this.snapshot,
        state: "auth_expired",
        machines: [],
        message: "ADE account sign-in expired or was rejected. Try again.",
      };
      return this.getSnapshot();
    }
  }

  async startSignIn(): Promise<void> {
    const config = this.config;
    if (!config) throw new Error("Account sign-in isn't configured for this hosted client.");
    const verifier = randomBase64Url(48);
    const state = randomBase64Url(24);
    const challenge = await pkceChallenge(verifier);
    this.storage.setItem(OAUTH_STATE_KEY, state);
    this.storage.setItem(OAUTH_VERIFIER_KEY, verifier);
    const returnPath = this.location.pathname === "/account/callback"
      ? "/"
      : `${this.location.pathname}${this.location.search}`;
    this.storage.setItem(OAUTH_RETURN_PATH_KEY, returnPath);
    const authorizeUrl = new URL(`${config.issuer}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("redirect_uri", `${this.location.origin}/account/callback`);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("scope", "openid profile email offline_access");
    this.location.assign(authorizeUrl.toString());
  }

  signOut(): BrowserAccountSnapshot {
    this.session = null;
    this.sessionGeneration += 1;
    this.refreshPromise = null;
    this.clearPendingOAuth();
    this.snapshot = {
      state: this.config ? "signed_out" : "unconfigured",
      userId: null,
      email: null,
      name: null,
      machines: [],
      relayBaseUrls: this.config?.relayBaseUrls ?? trustedAccountRelayBaseUrls(),
      message: null,
    };
    return this.getSnapshot();
  }

  async loadMachines(): Promise<BrowserAccountSnapshot> {
    const config = this.config;
    if (!config) return this.getSnapshot();
    let accessToken: string;
    try {
      accessToken = await this.getAccessToken();
    } catch {
      return this.getSnapshot();
    }
    const result = await fetchAccountMachines({
      baseUrl: config.directoryBaseUrl,
      accessToken,
      fetchImpl: this.options.fetchImpl,
    });
    this.applyDirectoryResult(result);
    return this.getSnapshot();
  }

  async getAccessToken(): Promise<string> {
    const config = this.config;
    const session = this.session;
    if (!config || !session) throw new Error("ADE account sign-in is required.");
    if (session.expiresAtMs - (this.options.now?.() ?? Date.now()) > REFRESH_SKEW_MS) {
      return session.accessToken;
    }
    if (!session.refreshToken) {
      this.expireSession();
      throw new Error("ADE account session expired.");
    }
    if (this.refreshPromise) return await this.refreshPromise;
    const refreshPromise = this.refreshSession(config, session).finally(() => {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = null;
    });
    this.refreshPromise = refreshPromise;
    return await refreshPromise;
  }

  private async refreshSession(
    config: BrowserAccountConfig,
    session: BrowserAccountSession,
  ): Promise<string> {
    try {
      const token = await this.postToken(config, {
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: session.refreshToken!,
      }, session.refreshToken);
      if (this.session !== session) {
        if (this.session) return this.session.accessToken;
        throw new Error("ADE account sign-in is required.");
      }
      this.setSession(token);
      const refreshed = this.session;
      if (!refreshed) throw new Error("ADE account session expired.");
      return refreshed.accessToken;
    } catch (error) {
      if (
        error instanceof TokenExchangeError
        && error.invalidatesSession
        && this.session === session
      ) {
        this.expireSession();
        throw new Error("ADE account session expired.");
      }
      throw error;
    }
  }

  private async postToken(
    config: BrowserAccountConfig,
    body: Record<string, string>,
    priorRefreshToken: string | null,
  ): Promise<TokenPayload> {
    const response = await (this.options.fetchImpl ?? fetch)(`${config.issuer}/oauth/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
    });
    const payload = await response.json().catch(() => null);
    const token = parseTokenPayload(payload, priorRefreshToken);
    if (!response.ok || !token) {
      const errorCode = isRecord(payload) ? stringValue(payload.error) : null;
      throw new TokenExchangeError(
        "Token exchange failed.",
        response.status === 401
          || response.status === 403
          || errorCode === "invalid_grant"
          || errorCode === "invalid_token",
      );
    }
    return token;
  }

  private setSession(token: TokenPayload): void {
    const claims = decodeClaims(token.accessToken);
    const machines = this.session?.userId === claims.userId
      ? this.snapshot.machines
      : [];
    this.session = {
      ...claims,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAtMs: (this.options.now?.() ?? Date.now()) + token.expiresInSec * 1000,
    };
    this.sessionGeneration += 1;
    this.snapshot = {
      state: "signed_in",
      ...claims,
      machines,
      relayBaseUrls: this.snapshot.relayBaseUrls,
      message: null,
    };
  }

  private applyDirectoryResult(result: AdeAccountMachinesResult): void {
    if (result.state === "auth_expired") {
      this.expireSession();
      return;
    }
    const identity = this.session ?? { userId: null, email: null, name: null };
    this.snapshot = {
      state: result.state === "ok" ? "signed_in" : "directory_unavailable",
      userId: identity.userId,
      email: identity.email,
      name: identity.name,
      machines: result.state === "ok" ? result.machines : [],
      relayBaseUrls: this.snapshot.relayBaseUrls,
      message: result.message,
    };
  }

  private expireSession(): void {
    this.session = null;
    this.sessionGeneration += 1;
    this.refreshPromise = null;
    this.snapshot = {
      ...this.snapshot,
      state: "auth_expired",
      machines: [],
      message: "Your ADE account session expired. Sign in again.",
    };
  }

  private clearPendingOAuth(): void {
    this.storage.removeItem(OAUTH_STATE_KEY);
    this.storage.removeItem(OAUTH_VERIFIER_KEY);
    this.storage.removeItem(OAUTH_RETURN_PATH_KEY);
  }
}
