import {
  DEFAULT_ADE_CLERK_ISSUER,
  DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
  DEVELOPMENT_ADE_CLERK_ISSUER,
  DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
  createAccountDirectoryCorrelationId,
  fetchAccountMachines,
  parseTrustedAccountDirectoryBaseUrl,
  resolveTrustedAccountDirectoryBaseUrl,
  trustedAccountRelayBaseUrls,
} from "../../../shared/accountDirectory";
import type {
  AdeAccountMachine,
  AdeAccountMachineRemovalResult,
  AdeAccountMachinesResult,
} from "../../../shared/types/account";
import {
  BrowserAccountSessionStore,
  type BrowserAccountSessionPersistence,
  type PersistedBrowserAccountSession,
} from "./sessionStore";

const OAUTH_STATE_KEY = "ade-web:account-oauth-state";
const OAUTH_VERIFIER_KEY = "ade-web:account-oauth-verifier";
const OAUTH_RETURN_PATH_KEY = "ade-web:account-oauth-return-path";
const REFRESH_SKEW_MS = 2 * 60_000;
const USERINFO_REQUEST_TIMEOUT_MS = 3_000;
const DIRECTORY_MUTATION_TIMEOUT_MS = 8_000;

type BrowserAccountConfig = {
  issuer: string;
  clientId: string;
  directoryBaseUrl: string;
  relayBaseUrls: string[];
};

type BrowserAccountClientOptions = {
  config?: BrowserAccountConfig | null;
  fetchImpl?: typeof fetch;
  location?: BrowserLocation;
  history?: Pick<History, "replaceState">;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  sessionStore?: BrowserAccountSessionPersistence;
  now?: () => number;
  userinfoRequestTimeoutMs?: number;
};

type BrowserAccountSession = {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number;
  userId: string | null;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
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
  imageUrl: string | null;
  expiresAt: string | null;
  machines: AdeAccountMachine[];
  relayBaseUrls: string[];
  message: string | null;
};

export type BrowserAccountSessionLease = Readonly<{
  userId: string;
  generation: number;
}>;

export function browserAccountIsSignedIn(state: BrowserAccountState): boolean {
  return state === "signed_in" || state === "directory_unavailable";
}

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

type BrowserAccountProfile = Pick<
  BrowserAccountSession,
  "userId" | "email" | "name" | "imageUrl"
>;

function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded) throw new Error("missing claims");
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as unknown;
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

function accessTokenExpiresAtMs(accessToken: string): number | null {
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
  const expiresAtMs = Math.trunc(exp * 1000);
  return Number.isFinite(expiresAtMs) ? expiresAtMs : null;
}

function profileFromRecord(record: Record<string, unknown> | null): BrowserAccountProfile {
  if (!record) return { userId: null, email: null, name: null, imageUrl: null };
  const givenName = stringValue(record.given_name ?? record.first_name);
  const familyName = stringValue(record.family_name ?? record.last_name);
  return {
    userId: stringValue(record.sub),
    email: stringValue(record.email ?? record.primary_email ?? record.email_address),
    name: stringValue(record.name) ?? ([givenName, familyName].filter(Boolean).join(" ") || null),
    imageUrl: stringValue(record.picture ?? record.image_url ?? record.avatar_url),
  };
}

function trustedProfileImageUrl(value: string | null, issuer: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.origin === new URL(issuer).origin) return url.toString();
    if (url.origin === "https://img.clerk.com" || url.origin === "https://images.clerk.dev") {
      return url.toString();
    }
    if (
      url.origin === "https://storage.googleapis.com"
      && url.pathname.startsWith("/images.clerk.dev/")
    ) {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function decodeClaims(accessToken: string): BrowserAccountProfile {
  return profileFromRecord(decodeJwtPayload(accessToken));
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
  private readonly options: BrowserAccountClientOptions;
  private readonly sessionStore: BrowserAccountSessionPersistence;

  constructor(options: BrowserAccountClientOptions = {}) {
    this.options = options;
    this.sessionStore = options.sessionStore ?? new BrowserAccountSessionStore();
    const config = this.config;
    this.snapshot = {
      state: config ? "signed_out" : "unconfigured",
      userId: null,
      email: null,
      name: null,
      imageUrl: null,
      expiresAt: null,
      machines: [],
      relayBaseUrls: config?.relayBaseUrls ?? trustedAccountRelayBaseUrls(),
      message: config
        ? null
        : "Account sign-in isn't configured for this web client.",
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
      || !browserAccountIsSignedIn(this.snapshot.state)
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
      return await this.restorePersistedSession(config);
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
      await this.expireSession(
        oauthError
          ? "ADE account sign-in was not completed."
          : "ADE account sign-in could not be verified. Try again.",
      );
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
      await this.setSession(token, config);
      return await this.loadMachines();
    } catch {
      await this.expireSession("ADE account sign-in expired or was rejected. Try again.");
      return this.getSnapshot();
    }
  }

  async startSignIn(): Promise<string> {
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
    const url = authorizeUrl.toString();
    this.location.assign(url);
    return url;
  }

  async signOut(): Promise<BrowserAccountSnapshot> {
    this.session = null;
    this.sessionGeneration += 1;
    this.refreshPromise = null;
    this.clearPendingOAuth();
    this.snapshot = {
      state: this.config ? "signed_out" : "unconfigured",
      userId: null,
      email: null,
      name: null,
      imageUrl: null,
      expiresAt: null,
      machines: [],
      relayBaseUrls: this.config?.relayBaseUrls ?? trustedAccountRelayBaseUrls(),
      message: null,
    };
    await this.clearPersistedSessionBestEffort();
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
    await this.applyDirectoryResult(result);
    return this.getSnapshot();
  }

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const config = this.config;
    const session = this.session;
    if (!config || !session) throw new Error("ADE account sign-in is required.");
    if (
      !options.forceRefresh
      && session.expiresAtMs - (this.options.now?.() ?? Date.now()) > REFRESH_SKEW_MS
    ) {
      return session.accessToken;
    }
    if (!session.refreshToken) {
      if (session.expiresAtMs > (this.options.now?.() ?? Date.now())) {
        return session.accessToken;
      }
      await this.expireSession();
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
      const applied = await this.setSession(token, config, session);
      if (!applied) {
        if (this.session) return await this.getAccessToken();
        throw new Error("ADE account sign-in is required.");
      }
      const refreshed = this.session;
      if (!refreshed) throw new Error("ADE account session expired.");
      if (refreshed.expiresAtMs <= (this.options.now?.() ?? Date.now())) {
        await this.expireSession();
        throw new Error("ADE account session expired.");
      }
      return refreshed.accessToken;
    } catch (error) {
      if (
        error instanceof TokenExchangeError
        && error.invalidatesSession
        && this.session === session
      ) {
        await this.expireSession();
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

  private async fetchUserinfoProfile(
    config: BrowserAccountConfig,
    accessToken: string,
  ): Promise<BrowserAccountProfile | null> {
    const controller = new AbortController();
    const requestedTimeoutMs = this.options.userinfoRequestTimeoutMs;
    const timeoutMs = typeof requestedTimeoutMs === "number"
      && Number.isFinite(requestedTimeoutMs)
      && requestedTimeoutMs > 0
      ? Math.trunc(requestedTimeoutMs)
      : USERINFO_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${config.issuer}/oauth/userinfo`, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const profile = await response.json().catch(() => null);
      if (!isRecord(profile)) return null;
      return profileFromRecord(profile);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async setSession(
    token: TokenPayload,
    config: BrowserAccountConfig,
    expectedSession?: BrowserAccountSession,
  ): Promise<boolean> {
    const claims = decodeClaims(token.accessToken);
    const previous = this.session;
    const now = this.options.now?.() ?? Date.now();
    const expiresAtMs = accessTokenExpiresAtMs(token.accessToken)
      ?? now + token.expiresInSec * 1000;
    // Do not send a near-expiry JWT to userinfo. Install only enough session
    // state to let getAccessToken() refresh it before any authenticated read.
    const userinfo = expiresAtMs - now > REFRESH_SKEW_MS
      ? await this.fetchUserinfoProfile(config, token.accessToken)
      : null;
    if (expectedSession && this.session !== expectedSession) return false;
    const profile: BrowserAccountProfile = {
      userId: claims.userId ?? userinfo?.userId ?? previous?.userId ?? null,
      email: claims.email ?? userinfo?.email ?? previous?.email ?? null,
      name: claims.name ?? userinfo?.name ?? previous?.name ?? null,
      imageUrl: trustedProfileImageUrl(
        userinfo?.imageUrl ?? claims.imageUrl ?? previous?.imageUrl ?? null,
        config.issuer,
      ),
    };
    const machines = previous?.userId === profile.userId
      ? this.snapshot.machines
      : [];
    const nextSession: BrowserAccountSession = {
      ...profile,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAtMs,
    };
    const nextSnapshot: BrowserAccountSnapshot = {
      state: "signed_in",
      ...profile,
      expiresAt: new Date(expiresAtMs).toISOString(),
      machines,
      relayBaseUrls: this.snapshot.relayBaseUrls,
      message: null,
    };
    if (token.refreshToken) {
      await this.sessionStore.save({
        version: 1,
        refreshToken: token.refreshToken,
        issuer: config.issuer,
        clientId: config.clientId,
        ...profile,
      });
    } else {
      await this.sessionStore.clear();
    }
    this.session = nextSession;
    this.sessionGeneration += 1;
    this.snapshot = nextSnapshot;
    return true;
  }

  private async applyDirectoryResult(result: AdeAccountMachinesResult): Promise<void> {
    if (result.state === "auth_expired") {
      await this.expireSession(result.message ?? undefined);
      return;
    }
    const identity = this.session ?? {
      userId: null,
      email: null,
      name: null,
      imageUrl: null,
      expiresAtMs: Number.NaN,
    };
    this.snapshot = {
      state: result.state === "ok" ? "signed_in" : "directory_unavailable",
      userId: identity.userId,
      email: identity.email,
      name: identity.name,
      imageUrl: identity.imageUrl,
      expiresAt: Number.isFinite(identity.expiresAtMs)
        ? new Date(identity.expiresAtMs).toISOString()
        : null,
      machines: result.state === "ok" ? result.machines : [],
      relayBaseUrls: this.snapshot.relayBaseUrls,
      message: result.message,
    };
  }

  private async restorePersistedSession(
    config: BrowserAccountConfig,
  ): Promise<BrowserAccountSnapshot> {
    let persisted: PersistedBrowserAccountSession | null;
    try {
      persisted = await this.sessionStore.load();
    } catch {
      persisted = null;
    }
    if (!persisted) {
      this.snapshot = { ...this.snapshot, state: "signed_out", message: null };
      return this.getSnapshot();
    }
    if (persisted.issuer !== config.issuer || persisted.clientId !== config.clientId) {
      await this.clearPersistedSessionBestEffort();
      this.snapshot = { ...this.snapshot, state: "signed_out", message: null };
      return this.getSnapshot();
    }

    this.session = {
      accessToken: "",
      refreshToken: persisted.refreshToken,
      expiresAtMs: 0,
      userId: persisted.userId,
      email: persisted.email,
      name: persisted.name,
      imageUrl: persisted.imageUrl,
    };
    this.sessionGeneration += 1;
    this.snapshot = {
      ...this.snapshot,
      state: "directory_unavailable",
      userId: persisted.userId,
      email: persisted.email,
      name: persisted.name,
      imageUrl: persisted.imageUrl,
      expiresAt: null,
      machines: [],
      message: null,
    };
    try {
      await this.getAccessToken();
      return await this.loadMachines();
    } catch {
      if (this.snapshot.state === "auth_expired") return this.getSnapshot();
      this.snapshot = {
        ...this.snapshot,
        state: "directory_unavailable",
        machines: [],
        message: "Couldn't refresh your ADE account session. Try again.",
      };
      return this.getSnapshot();
    }
  }

  async removeMachine(machineKeyValue: string): Promise<AdeAccountMachineRemovalResult> {
    const config = this.config;
    const machineKey = machineKeyValue.trim();
    if (!config || !machineKey) throw new Error("A machine is required.");
    const accessToken = await this.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DIRECTORY_MUTATION_TIMEOUT_MS);
    const correlationId = createAccountDirectoryCorrelationId();
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${config.directoryBaseUrl}/account/machines/${encodeURIComponent(machineKey)}`,
        {
          method: "DELETE",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            "x-ade-correlation-id": correlationId,
          },
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        },
      );
      if (response.status === 401 || response.status === 403) {
        await this.expireSession();
        throw new Error("ADE account session expired.");
      }
      if (!response.ok) throw new Error(`Couldn't remove that machine (${response.status}).`);
      await response.body?.cancel().catch(() => undefined);
      this.snapshot = {
        ...this.snapshot,
        machines: this.snapshot.machines.filter((machine) => machine.machineKey !== machineKey),
      };
      return { ok: true, machineKey };
    } finally {
      clearTimeout(timer);
    }
  }

  private async expireSession(
    message = "Your ADE account session expired. Sign in again.",
  ): Promise<void> {
    this.session = null;
    this.sessionGeneration += 1;
    this.refreshPromise = null;
    this.snapshot = {
      state: "auth_expired",
      userId: null,
      email: null,
      name: null,
      imageUrl: null,
      expiresAt: null,
      machines: [],
      relayBaseUrls: this.snapshot.relayBaseUrls,
      message,
    };
    await this.clearPersistedSessionBestEffort();
  }

  private async clearPersistedSessionBestEffort(): Promise<void> {
    try {
      await this.sessionStore.clear();
    } catch {
      // IndexedDB can be unavailable (for example in private browsing). The
      // in-memory sign-out remains authoritative for this browser session.
    }
  }

  private clearPendingOAuth(): void {
    this.storage.removeItem(OAUTH_STATE_KEY);
    this.storage.removeItem(OAUTH_VERIFIER_KEY);
    this.storage.removeItem(OAUTH_RETURN_PATH_KEY);
  }
}
