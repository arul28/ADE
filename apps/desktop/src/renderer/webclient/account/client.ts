import { encodeCodedErrorMessage, parseCodedErrorMessage } from "../../../shared/codedError";
import { fetchDevTestSessionToken } from "./devTestSession";
import { CLOUD_PATHS } from "../../../../../account-directory/src/cloud/contract";
import { LATEST_RELEASES_PATH, type LatestReleasesResponse } from "../../../../../account-directory/src/latestReleasesContract";
import { ACCOUNT_DELETE_PATH } from "../../../../../account-directory/src/clientMinimumContract";
import { validVersionOn } from "../../../shared/latestByTrack";
import { captureError } from "../../../shared/sentry/capture";
import { forwardSignalToSentry } from "../../../shared/sentry/logBridge";
// Loaded on the first read, so the signed-out page does not pay for it.
import type { AccountProjectChangeResult, AccountProjectListResult } from "../../../shared/accountProject";
import { createCloudApiClient, type CloudApiClient } from "../../../shared/cloudApiClient";
import {
  DEFAULT_ADE_CLERK_ISSUER,
  DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
  DEVELOPMENT_ADE_CLERK_ISSUER,
  DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
  createAccountDirectoryCorrelationId,
  fetchAccountMachines,
  parseAccountMachine,
  parseTrustedAccountDirectoryBaseUrl,
  readBoundedAccountDirectoryJson,
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
  usablePersistedAccessToken,
  type BrowserAccountSessionPersistence,
  type PersistedBrowserAccountSession,
} from "./sessionStore";

// The pending-authorization stash lives in localStorage, not sessionStorage.
// Embedded browsers (ADE's own built-in browser included) do not guarantee that
// the OAuth round trip ends in the same session-storage namespace it started
// in, which silently strips the PKCE verifier and makes every callback fail.
//
// One stash per `state`, not one globally: two tabs signing in at once each
// need their own PKCE verifier, and a single slot let the second tab's stash
// overwrite the first tab's, failing that tab's callback with a bogus
// verification error.
const OAUTH_PENDING_KEY = "ade-web:account-oauth-pending";
const OAUTH_PENDING_TTL_MS = 10 * 60_000;
// Set by "Sign out", cleared by the next completed sign-in. Signing out drops
// ADE's tokens but not the browser's Clerk session, so without `prompt=login`
// the next sign-in finishes on its own as the account that just signed out.
const SIGNED_OUT_BY_USER_KEY = "ade-web:account-signed-out-by-user";
// A marker the landing site (ade-app.dev, apps/web) reads to send a signed-in
// visitor from "/" straight to ADE Web. It carries no token and grants
// nothing; the app still checks its own session. Its name and rules are a
// contract with apps/web/index.html: change both together.
const SIGNED_IN_MARKER_COOKIE = "ade_signed_in";
const SIGNED_IN_MARKER_DOMAIN = "ade-app.dev";
const SIGNED_IN_MARKER_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const REFRESH_SKEW_MS = 2 * 60_000;
const USERINFO_REQUEST_TIMEOUT_MS = 3_000;
const DIRECTORY_MUTATION_TIMEOUT_MS = 8_000;
/** The desktop waits as long for ADE Cloud (`cloudServerProvider.ts`). */
const CLOUD_REQUEST_TIMEOUT_MS = 20_000;
const CLOUD_BILLING_PATHS: ReadonlySet<string> = new Set([
  CLOUD_PATHS.billingCheckout,
  CLOUD_PATHS.billingPortal,
  CLOUD_PATHS.billingFreeUnlock,
  CLOUD_PATHS.billingExtraHours,
  CLOUD_PATHS.billingPlanCleanup,
]);
const REMOVAL_TIMEOUT_MESSAGE =
  "Removal timed out. Refresh Your computers — if it's still listed, try again.";
const ACTIVITY_PURGE_FAILED_MESSAGE =
  "Removed from your account, but its Activity could not be cleared. Try removing it again to finish.";

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
}

function isConfirmedActivityPurgeFailure(value: unknown): boolean {
  return isRecord(value)
    && value.code === "activity_purge_failed"
    && value.machineRemoved === true;
}

/**
 * `key`/`length` are optional: they are only needed to sweep abandoned stashes,
 * and a caller supplying a minimal storage stub simply keeps them until their
 * TTL makes them unreadable.
 */
type PendingOAuthStorage =
  Pick<Storage, "getItem" | "setItem" | "removeItem">
  & Partial<Pick<Storage, "key" | "length">>;

function pendingOAuthKeyFor(state: string): string {
  return `${OAUTH_PENDING_KEY}:${state}`;
}

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
  storage?: PendingOAuthStorage;
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

type PendingOAuth = {
  state: string;
  verifier: string;
  returnPath: string;
  createdAtMs: number;
};

/**
 * `expectedState` is the state the stash was filed under. A record whose own
 * `state` disagrees with its key has been tampered with or written by a build
 * with a different key scheme; either way its verifier is not the one this
 * callback is completing, so it is rejected rather than trusted.
 */
function parsePendingOAuth(
  raw: string | null,
  nowMs: number,
  expectedState?: string,
): PendingOAuth | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const state = stringValue(parsed.state);
  const verifier = stringValue(parsed.verifier);
  const returnPath = stringValue(parsed.returnPath);
  const createdAtMs = typeof parsed.createdAtMs === "number" && Number.isFinite(parsed.createdAtMs)
    ? parsed.createdAtMs
    : null;
  if (!state || !verifier || createdAtMs === null) return null;
  if (expectedState !== undefined && state !== expectedState) return null;
  // A verifier is single-use and short-lived. Anything older than the TTL is a
  // stale stash from an abandoned attempt, not the round trip we are completing.
  if (nowMs - createdAtMs > OAUTH_PENDING_TTL_MS || createdAtMs - nowMs > OAUTH_PENDING_TTL_MS) {
    return null;
  }
  return {
    state,
    verifier,
    returnPath: returnPath?.startsWith("/") ? returnPath : "/",
    createdAtMs,
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

/**
 * What the screen shows of the account's machines, sleep included (an asleep
 * cloud computer is not connected in the background). `lastSeenAt` moves on
 * every read and is left out.
 */
function machinesSignature(machines: readonly AdeAccountMachine[]): string {
  return machines
    .map((machine) => [
      machine.machineKey,
      machine.deviceId ?? "",
      machine.online ? 1 : 0,
      machine.sleepState ?? "",
      machine.sleepStateAt ?? "",
      machine.customName ?? "",
      machine.name ?? "",
    ].join("\u0000"))
    .join("\u0001");
}

/**
 * Dev only: the sessions of the dev server's test account (`devTestSession.ts`).
 * Null in a production build, so the bundler removes it and the code below.
 */
const devTestSessions: WeakSet<BrowserAccountSession> | null = import.meta.env.DEV ? new WeakSet() : null;

type DevTestSession = { session: BrowserAccountSession; claims: ReturnType<typeof decodeClaims>; expiresAtMs: number };

/** Dev only: a session from a test account token. It stores nothing, so a real sign-in in this browser stays. */
function devTestSessionOf(token: string, nowMs: number): DevTestSession {
  const claims = decodeClaims(token);
  const expiresAtMs = accessTokenExpiresAtMs(token) ?? nowMs + 30_000;
  return { session: { ...claims, accessToken: token, refreshToken: null, expiresAtMs }, claims, expiresAtMs };
}

/** Dev only: the signed-in snapshot of a test account session. */
function devTestSnapshotOf(dev: DevTestSession, previous: BrowserAccountSnapshot, first: boolean): BrowserAccountSnapshot {
  return {
    state: "signed_in",
    ...dev.claims,
    expiresAt: new Date(dev.expiresAtMs).toISOString(),
    machines: first ? [] : previous.machines,
    relayBaseUrls: previous.relayBaseUrls,
    message: null,
  };
}

/** How long one `/releases/latest` answer is reused. */
const LATEST_RELEASES_REUSE_MS = 10 * 60_000;

export class BrowserAccountClient {
  private session: BrowserAccountSession | null = null;
  private sessionGeneration = 0;
  private refreshPromise: Promise<string> | null = null;
  private currentSnapshot: BrowserAccountSnapshot;
  private readonly options: BrowserAccountClientOptions;
  private readonly sessionStore: BrowserAccountSessionPersistence;
  private readonly machinesListeners = new Set<() => void>();

  constructor(options: BrowserAccountClientOptions = {}) {
    this.options = options;
    this.sessionStore = options.sessionStore ?? new BrowserAccountSessionStore();
    const config = this.config;
    // The backing field, not the setter: the marker cookie is left alone until
    // the stored session has actually been read.
    this.currentSnapshot = {
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

  private get snapshot(): BrowserAccountSnapshot {
    return this.currentSnapshot;
  }

  /** Every account state change passes here, so the marker cookie follows it. */
  private set snapshot(next: BrowserAccountSnapshot) {
    const wasSignedIn = browserAccountIsSignedIn(this.currentSnapshot.state);
    this.currentSnapshot = next;
    const signedIn = browserAccountIsSignedIn(next.state);
    if (signedIn !== wasSignedIn || (!signedIn && next.state !== "loading")) {
      this.writeSignedInMarker(signedIn);
    }
  }

  /**
   * Sets or deletes the `ade_signed_in` marker on `.ade-app.dev`. Only pages
   * served from ade-app.dev may write that domain, so localhost and the Pages
   * preview URL skip it.
   */
  private writeSignedInMarker(signedIn: boolean): void {
    if (typeof document === "undefined") return;
    let hostname: string;
    try {
      hostname = new URL(this.location.origin).hostname;
    } catch {
      return;
    }
    if (hostname !== SIGNED_IN_MARKER_DOMAIN && !hostname.endsWith(`.${SIGNED_IN_MARKER_DOMAIN}`)) return;
    const value = signedIn ? "1" : "";
    const maxAge = signedIn ? SIGNED_IN_MARKER_MAX_AGE_SEC : 0;
    try {
      document.cookie = `${SIGNED_IN_MARKER_COOKIE}=${value}; Domain=.${SIGNED_IN_MARKER_DOMAIN}; Path=/; Secure; SameSite=Lax; Max-Age=${maxAge}`;
    } catch {
      // Best effort: without the marker the landing page simply shows.
    }
  }

  private get config(): BrowserAccountConfig | null {
    return this.options.config === undefined
      ? readBrowserAccountConfig(import.meta.env as Record<string, unknown>)
      : this.options.config;
  }

  private get location(): BrowserLocation {
    return this.options.location ?? window.location;
  }

  private get storage(): PendingOAuthStorage {
    if (this.options.storage) return this.options.storage;
    try {
      return window.localStorage;
    } catch {
      // Some embedded/private contexts throw on localStorage access. A pending
      // sign-in that only survives in sessionStorage is still better than none.
      return window.sessionStorage;
    }
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

  /**
   * Calls `listener` after a directory read changes which machines the
   * account has, or their names or online state. Any caller can read the
   * directory (a background connect does), so the screen follows the list
   * here instead of only where it read it itself.
   */
  onMachinesChanged(listener: () => void): () => void {
    this.machinesListeners.add(listener);
    return () => {
      this.machinesListeners.delete(listener);
    };
  }

  /** The account directory this browser signs in to, or null when none is configured. */
  getDirectoryBaseUrl(): string | null {
    return this.config?.directoryBaseUrl ?? null;
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

  /** The signed-in account's id, or null; a token refresh keeps it, another sign-in changes it. */
  private sessionUserId(): string | null {
    return this.session?.userId?.trim() || null;
  }

  isSessionLeaseCurrent(lease: BrowserAccountSessionLease): boolean {
    const current = this.captureSessionLease();
    return current?.userId === lease.userId && current.generation === lease.generation;
  }

  /**
   * Whether a refresh session is stored for this origin. A read only: it neither
   * refreshes nor clears anything, so the shell can start downloading the
   * signed-in workspace while `bootstrap()` restores the session.
   */
  async hasPersistedSession(): Promise<boolean> {
    if (!this.config) return false;
    try {
      return (await this.sessionStore.load()) !== null;
    } catch {
      return false;
    }
  }

  async bootstrap(): Promise<BrowserAccountSnapshot> {
    const config = this.config;
    if (!config) return this.getSnapshot();
    if (import.meta.env.DEV) {
      const devToken = await fetchDevTestSessionToken();
      if (devToken) {
        const dev = devTestSessionOf(devToken, this.options.now?.() ?? Date.now());
        devTestSessions?.add(dev.session);
        this.session = dev.session;
        this.sessionGeneration += 1;
        this.snapshot = devTestSnapshotOf(dev, this.snapshot, true);
        return await this.loadMachines();
      }
    }
    const params = new URLSearchParams(this.location.search);
    if (this.location.pathname !== "/account/callback") {
      return await this.restorePersistedSession(config);
    }

    const actualState = params.get("state");
    // Looking the stash up BY the returned state is the CSRF check: a state we
    // never issued has no stash, so there is no verifier to exchange with.
    const pending = this.readPendingOAuth(actualState);
    const otherAttemptsPending = pending == null && this.pendingOAuthKeys().length > 0;
    const code = params.get("code");
    const oauthError = params.get("error");
    const returnPath = pending?.returnPath ?? "/";
    // Only this attempt is consumed; a sign-in running in another tab keeps its
    // own stash.
    this.clearPendingOAuthAttempt(actualState);
    (this.options.history ?? window.history).replaceState(null, "", returnPath);

    if (oauthError || !code) {
      await this.expireSession("ADE account sign-in was not completed.");
      return this.getSnapshot();
    }
    if (!pending) {
      // Other attempts still stashed means this callback carried a state we
      // never issued (or already consumed) — a verification failure, not a
      // browser that discarded our storage.
      await this.expireSession(
        otherAttemptsPending
          ? "ADE account sign-in could not be verified. Try again."
          : "Sign-in couldn't complete in this browser: it discarded the pending sign-in before the redirect returned. Try signing in again, or use your system browser.",
      );
      return this.getSnapshot();
    }

    try {
      const token = await this.postToken(config, {
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        code_verifier: pending.verifier,
        redirect_uri: `${this.location.origin}/account/callback`,
      }, null);
      await this.setSession(token, config);
      this.writeSignedOutByUser(false);
      return await this.loadMachines();
    } catch {
      await this.expireSession("ADE account sign-in expired or was rejected. Try again.");
      return this.getSnapshot();
    }
  }

  /** Clerk's Frontend API origin (the OAuth issuer), for ADE's own sign-in card. */
  clerkFrontendApiBase(): string | null {
    return this.config?.issuer ?? null;
  }

  /**
   * The desktop or CLI sign-in this page was opened to finish, read from
   * `?continue=`. Only this client's own authorize endpoint, with its own
   * client id and a `127.0.0.1` redirect, is accepted: the page never forwards a
   * browser anywhere else. `prompt=login` is taken off the URL and returned as
   * `fresh`, because the card asks for the sign-in itself; left on, Clerk would
   * ask again on its own page.
   */
  signInHandoff(search: string): { continueUrl: string; hostedUrl: string; fresh: boolean } | null {
    const config = this.config;
    if (!config) return null;
    const raw = new URLSearchParams(search).get("continue");
    if (!raw) return null;
    let target: URL;
    let issuer: URL;
    try {
      target = new URL(raw);
      issuer = new URL(config.issuer);
    } catch {
      return null;
    }
    const expectedPath = `${issuer.pathname.replace(/\/+$/, "")}/oauth/authorize`;
    if (target.origin !== issuer.origin || target.pathname !== expectedPath) return null;
    if (target.searchParams.get("client_id") !== config.clientId) return null;
    let redirect: URL;
    try {
      redirect = new URL(target.searchParams.get("redirect_uri") ?? "");
    } catch {
      return null;
    }
    // The computer's listener binds 127.0.0.1 only (`localhost` can resolve to ::1).
    const loopback = redirect.protocol === "http:" && redirect.hostname === "127.0.0.1"
      && !redirect.username && !redirect.password;
    if (!loopback) return null;
    // `hostedUrl` keeps `prompt`: it is the card's fallback, Clerk's own page.
    const hostedUrl = target.toString();
    const fresh = target.searchParams.get("prompt") === "login";
    target.searchParams.delete("prompt");
    return { continueUrl: target.toString(), hostedUrl, fresh };
  }

  /**
   * `clerkSessionReady`: ADE's own card has just signed this browser in to
   * Clerk, so the authorize step must pass straight through. `prompt=login`
   * would send the person to Clerk's page to sign in a second time.
   * `decorateAuthorizeUrl` adds what that session needs on the URL (a
   * development instance's dev-browser id).
   */
  async startSignIn(options: {
    clerkSessionReady?: boolean;
    decorateAuthorizeUrl?: (url: string) => string;
  } = {}): Promise<string> {
    const config = this.config;
    if (!config) throw new Error("Account sign-in isn't configured for this hosted client.");
    const verifier = randomBase64Url(48);
    const state = randomBase64Url(24);
    const challenge = await pkceChallenge(verifier);
    const returnPath = this.location.pathname === "/account/callback"
      ? "/"
      : `${this.location.pathname}${this.location.search}`;
    this.writePendingOAuth({
      state,
      verifier,
      returnPath,
      createdAtMs: this.options.now?.() ?? Date.now(),
    });
    const authorizeUrl = new URL(`${config.issuer}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("redirect_uri", `${this.location.origin}/account/callback`);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("scope", "openid profile email offline_access");
    if (!options.clerkSessionReady && this.signedOutByUser()) authorizeUrl.searchParams.set("prompt", "login");
    const url = options.decorateAuthorizeUrl?.(authorizeUrl.toString()) ?? authorizeUrl.toString();
    this.location.assign(url);
    return url;
  }

  async signOut(): Promise<BrowserAccountSnapshot> {
    this.session = null;
    this.sessionGeneration += 1;
    this.refreshPromise = null;
    this.clearAllPendingOAuth();
    this.writeSignedOutByUser(true);
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

  /**
   * Deletes the signed-in account (`POST /account/delete`), then signs this
   * browser out. Throws a sentence to show when the account was not deleted;
   * the session stays then.
   */
  async deleteAccount(): Promise<BrowserAccountSnapshot> {
    let answer: { status: number; body: unknown };
    try {
      answer = await this.allowedDirectoryRequest({ method: "POST", path: ACCOUNT_DELETE_PATH, body: { confirm: "delete" } });
    } catch (cause) {
      if (parseCodedErrorMessage(cause).code === "signed_out") throw new Error("Sign in to ADE to delete your account.");
      throw new Error("ADE couldn't reach your account. Check your connection and try again.");
    }
    const body = answer.body && typeof answer.body === "object" ? answer.body as Record<string, unknown> : {};
    if (answer.status < 200 || answer.status >= 300 || body.deleted !== true) {
      const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
      throw new Error(typeof error.message === "string" && error.message.trim() ? error.message : "Your account was not deleted. Try again.");
    }
    return await this.signOut();
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
    const result = await this.readMachinesWith(config, accessToken);
    await this.applyDirectoryResult(result);
    return this.getSnapshot();
  }

  private async readMachinesWith(config: BrowserAccountConfig, accessToken: string): Promise<AdeAccountMachinesResult> {
    return await fetchAccountMachines({
      baseUrl: config.directoryBaseUrl,
      accessToken,
      fetchImpl: this.options.fetchImpl,
    });
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
    if (import.meta.env.DEV && devTestSessions?.has(session)) {
      const devToken = await fetchDevTestSessionToken();
      if (!devToken) throw new Error("The dev test sign-in gave no token.");
      const dev = devTestSessionOf(devToken, this.options.now?.() ?? Date.now());
      devTestSessions.add(dev.session);
      this.session = dev.session;
      this.snapshot = devTestSnapshotOf(dev, this.snapshot, false);
      return devToken;
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
        accessToken: token.accessToken,
        accessTokenExpiresAtMs: expiresAtMs,
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
    const before = machinesSignature(this.snapshot.machines);
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
    if (machinesSignature(this.snapshot.machines) === before) return;
    for (const listener of [...this.machinesListeners]) {
      try {
        listener();
      } catch (error) {
        // A listener's failure is its own; the directory read still succeeded.
        captureError(error, { fingerprint: ["web", "account_machines_listener"], tags: { area: "account_machines" }, handled: true });
      }
    }
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

    // A reload within the stored access token's life skips the refresh and the
    // profile read: the directory read below is the only round trip.
    const stored = usablePersistedAccessToken(persisted, this.options.now?.() ?? Date.now(), REFRESH_SKEW_MS);
    this.session = {
      accessToken: stored?.accessToken ?? "",
      refreshToken: persisted.refreshToken,
      expiresAtMs: stored?.expiresAtMs ?? 0,
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
      if (stored) {
        const result = await this.readMachinesWith(config, stored.accessToken);
        // The directory turned the stored token down (revoked, or a clock
        // that disagrees): refresh once, as a reload without one would.
        if (result.state !== "auth_expired") {
          await this.applyDirectoryResult(result);
          return this.getSnapshot();
        }
        if (this.session) this.session = { ...this.session, accessToken: "", expiresAtMs: 0 };
      }
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

  /**
   * One lane sharing call to the account directory with this browser's own
   * account token (the guest's side of lane sharing). Only `/lane-shares`
   * paths, and never the host-only routes: the token goes to the directory
   * and nowhere else. Answers the status and the parsed body; throws a coded
   * error (`signed_out`, `no_directory`, `unavailable`) when it could not ask.
   */
  async laneShareRequest(request: {
    method: "GET" | "POST";
    path: string;
    body?: Record<string, unknown>;
  }): Promise<{ status: number; body: unknown }> {
    if (!/^\/lane-shares(\/|$)/.test(request.path) || request.path.startsWith("/lane-shares/host")) {
      throw new Error(encodeCodedErrorMessage("invalid_args", "That account call is not allowed here."));
    }
    return await this.allowedDirectoryRequest(request);
  }

  /**
   * One call for the ADE account's GitHub App sign-in, with this browser's
   * own account token: start a sign-in, read how it ended, the status, and
   * disconnect. Only those paths. The token route is not here: the direct
   * GitHub reads get their token through `webclient/github/accountCredential.ts`,
   * which keeps it in memory only, and `/adopt` and `/retire` belong to machines.
   */
  async githubAppRequest(request: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
  }): Promise<{ status: number; body: unknown }> {
    const allowed = (request.method === "POST" && request.path === "/github/app/sign-in")
      || (request.method === "GET" && /^\/github\/app\/sign-in\/gs_[0-9a-f]{32}$/.test(request.path))
      || (request.method === "GET" && request.path === "/github/app/status")
      || (request.method === "DELETE" && request.path === "/github/app/grant");
    if (!allowed) throw new Error(encodeCodedErrorMessage("invalid_args", "That account call is not allowed here."));
    return await this.allowedDirectoryRequest(request);
  }

  /**
   * One ADE Cloud call with this browser's own account token: the account's
   * access and plan reads, and the plan and billing calls (Stripe's checkout,
   * the billing portal, the free plan's card, extra hours and disk, a plan's
   * cleanup pick). Only those paths: the rest of ADE Cloud goes through a
   * connected computer (`adapter/cloud.ts`). The cloud provider's own key
   * stays on the server; this token is the account's, as on the desktop.
   */
  async cloudRequest(request: {
    method: "GET" | "POST";
    path: string;
    body?: Record<string, unknown>;
  }): Promise<{ status: number; body: unknown }> {
    const allowed = request.method === "GET"
      ? request.path === CLOUD_PATHS.access || request.path === CLOUD_PATHS.account
      : CLOUD_BILLING_PATHS.has(request.path);
    if (!allowed) throw new Error(encodeCodedErrorMessage("invalid_args", "That account call is not allowed here."));
    // A checkout asks Stripe several things in a row; 8 s is too short for it.
    return await this.allowedDirectoryRequest(request, { timeoutMs: CLOUD_REQUEST_TIMEOUT_MS });
  }

  /**
   * Adds a GitHub repository to the account's project list (S13), from this
   * browser with its own account token: the web's Add project, which needs
   * no computer. The same answer shape as the desktop's `project.accountAdd`.
   */
  async addAccountProject(origin: string): Promise<AccountProjectChangeResult> {
    const { ACCOUNT_PROJECT_PATHS, accountProjectAddRequestForOrigin, coerceAccountProjectView } = await import("../../../shared/accountProject");
    const request = accountProjectAddRequestForOrigin(origin);
    if (!request) return { ok: false, code: "invalid_repository", message: "That is not a GitHub repository." };
    let answer: { status: number; body: unknown };
    try {
      answer = await this.allowedDirectoryRequest({ method: "POST", path: ACCOUNT_PROJECT_PATHS.root, body: { ...request } });
    } catch (error) {
      const code = parseCodedErrorMessage(error).code === "signed_out" ? "signed_out" : "unavailable";
      return { ok: false, code, message: code === "signed_out" ? "Sign in to ADE to change your projects." : "ADE couldn't reach your account. Try again." };
    }
    const body = answer.body && typeof answer.body === "object" ? answer.body as Record<string, unknown> : {};
    if (answer.status < 200 || answer.status >= 300) {
      const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
      return {
        ok: false,
        code: typeof error.code === "string" ? error.code : `http_${answer.status}`,
        message: typeof error.message === "string" && error.message.trim() ? error.message : "Your account refused the change.",
      };
    }
    const raw = body.project && typeof body.project === "object" ? body.project as Record<string, unknown> : null;
    const project = raw ? coerceAccountProjectView({ ...raw, removedAt: null, mergedInto: null }) : null;
    if (!project) return { ok: false, code: "bad_answer", message: "Your account sent an answer ADE can't read." };
    return { ok: true, project, created: body.created === true, revived: body.revived === true };
  }

  /**
   * ADE Cloud's server routes for a browser with no computer (launches, their
   * queued messages, the account's cloud sign-ins, the model list), with this
   * browser's own account token. The token goes to the account directory and
   * nowhere else; null when sign-in isn't configured.
   */
  cloudApi(): CloudApiClient | null {
    const config = this.config;
    if (!config) return null;
    if (this.cloudApiClient?.baseUrl === config.directoryBaseUrl) return this.cloudApiClient.client;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const client = createCloudApiClient({
      baseUrl: config.directoryBaseUrl,
      accessToken: async () => {
        const startedFor = this.sessionUserId();
        try {
          const token = await this.getAccessToken();
          // Another account signed in while the token refreshed: this request belongs to the first one.
          return this.sessionUserId() === startedFor ? token : null;
        } catch (error) {
          // No token: the server answers 401 and the caller says "sign in".
          forwardSignalToSentry("web.cloud_api_token_failed", { message: error instanceof Error ? error.message : String(error) }, "cloud_api_token_failed", "info");
          return null;
        }
      },
      fetch: async (input, init) => {
        const send = (headers: Record<string, string> | undefined) => fetchImpl(input, {
          ...init,
          headers: { ...headers, "x-ade-correlation-id": createAccountDirectoryCorrelationId() },
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "error",
        });
        const headers = init?.headers as Record<string, string> | undefined;
        const sentFor = this.sessionUserId();
        const response = await send(headers);
        if (response.status !== 401 || !headers?.authorization) return response;
        // The directory refused a token that has not expired here: refresh it once, as the directory reads do.
        const fresh = await this.getAccessToken({ forceRefresh: true }).catch(() => null);
        // Another account signed in meanwhile: its token never carries this account's request.
        if (!fresh || this.sessionUserId() !== sentFor) return response;
        return await send({ ...headers, authorization: `Bearer ${fresh}` });
      },
      timeoutMs: CLOUD_REQUEST_TIMEOUT_MS,
    });
    this.cloudApiClient = { baseUrl: config.directoryBaseUrl, client };
    return client;
  }

  private cloudApiClient: { baseUrl: string; client: CloudApiClient } | null = null;

  /** A directory call whose path the caller already checked; one retry after a 401. */
  private async allowedDirectoryRequest(request: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
  }, options: { timeoutMs?: number } = {}): Promise<{ status: number; body: unknown }> {
    const config = this.config;
    if (!config) throw new Error(encodeCodedErrorMessage("no_directory", "Account sign-in isn't configured for this web client."));
    const signedOut = () => new Error(encodeCodedErrorMessage("signed_out", "Sign in to your ADE account."));
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch {
      throw signedOut();
    }
    const send = async (accessToken: string): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DIRECTORY_MUTATION_TIMEOUT_MS);
      try {
        return await (this.options.fetchImpl ?? fetch)(`${config.directoryBaseUrl}${request.path}`, {
          method: request.method,
          headers: {
            accept: "application/json",
            ...(request.body ? { "content-type": "application/json" } : {}),
            authorization: `Bearer ${accessToken}`,
            "x-ade-correlation-id": createAccountDirectoryCorrelationId(),
          },
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };
    const sentFor = this.sessionUserId();
    let response: Response;
    try {
      response = await send(token);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        let refreshed: string;
        try {
          refreshed = await this.getAccessToken({ forceRefresh: true });
        } catch {
          throw signedOut();
        }
        // Another account signed in meanwhile: its token never carries this account's request.
        if (this.sessionUserId() !== sentFor) throw signedOut();
        response = await send(refreshed);
      }
    } catch (cause) {
      if (parseCodedErrorMessage(cause).code === "signed_out") throw cause;
      throw new Error(encodeCodedErrorMessage("unavailable", "The account directory could not be reached."));
    }
    let body: unknown;
    try {
      body = await readBoundedAccountDirectoryJson(response);
    } catch {
      body = undefined;
      await response.body?.cancel().catch(() => undefined);
    }
    return { status: response.status, body };
  }

  /**
   * The newest ADE build on each track (`GET /releases/latest`), for "Update &
   * restart" on another machine. A browser cannot read GitHub's release
   * downloads, so the account directory reads them. One read per ten minutes;
   * null for a track never read. Never rejects.
   */
  /** The last `readLatestReleases` answer, without a read. */
  peekLatestReleases(): LatestReleasesResponse {
    return this.latestReleases?.value ?? { stable: null, beta: null };
  }

  async readLatestReleases(): Promise<LatestReleasesResponse> {
    const empty: LatestReleasesResponse = { stable: null, beta: null };
    const config = this.config;
    if (!config || !browserAccountIsSignedIn(this.snapshot.state)) return this.latestReleases?.value ?? empty;
    if (this.latestReleases && Date.now() - this.latestReleases.atMs < LATEST_RELEASES_REUSE_MS) return this.latestReleases.value;
    this.latestReleasesRead ??= (async () => {
      try {
        const token = await this.getAccessToken();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DIRECTORY_MUTATION_TIMEOUT_MS);
        try {
          const response = await (this.options.fetchImpl ?? fetch)(`${config.directoryBaseUrl}${LATEST_RELEASES_PATH}`, {
            method: "GET",
            headers: { accept: "application/json", authorization: `Bearer ${token}` },
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) {
            forwardSignalToSentry("web.latest_releases_read_failed", { status: response.status }, "latest_releases_read_failed", "info");
            return this.latestReleases?.value ?? empty;
          }
          const body = await response.json().catch(() => null) as Record<string, unknown> | null;
          if (!body || typeof body !== "object") {
            forwardSignalToSentry("web.latest_releases_read_failed", { status: response.status, reason: "unreadable" }, "latest_releases_read_failed", "info");
          }
          const read = (raw: unknown) => (typeof raw === "string" ? raw : null);
          const value: LatestReleasesResponse = {
            stable: validVersionOn("stable", read(body?.stable)) ?? this.latestReleases?.value.stable ?? null,
            beta: validVersionOn("beta", read(body?.beta)) ?? this.latestReleases?.value.beta ?? null,
          };
          this.latestReleases = { value, atMs: Date.now() };
          return value;
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        forwardSignalToSentry("web.latest_releases_read_failed", { message: error instanceof Error ? error.message : String(error) }, "latest_releases_read_failed", "info");
        return this.latestReleases?.value ?? empty;
      } finally {
        this.latestReleasesRead = null;
      }
    })();
    return await this.latestReleasesRead;
  }

  private latestReleases: { value: LatestReleasesResponse; atMs: number } | null = null;
  private latestReleasesRead: Promise<LatestReleasesResponse> | null = null;

  /**
   * The account's project list, read from the account directory (S14). The
   * hosted client has no brain, so it reads the directory itself: the whole
   * list once, then only the changes (`since` the last cursor), merged here.
   * Removed and merged rows are kept as `retired`, so a link that names one
   * is followed or told. One read per call; the caller decides when.
   */
  async readAccountProjects(): Promise<AccountProjectListResult> {
    const config = this.config;
    const userId = this.snapshot.userId;
    if (!config || !userId || !browserAccountIsSignedIn(this.snapshot.state)) return { state: "signed_out", projects: [] };
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch {
      return { state: "signed_out", projects: [] };
    }
    const { ACCOUNT_PROJECT_PATHS, coerceAccountProjectListResult } = await import("../../../shared/accountProject");
    const cached = () => this.cachedAccountProjects(userId, coerceAccountProjectListResult);
    const cache = this.accountProjects?.userId === userId ? this.accountProjects : null;
    const path = `${ACCOUNT_PROJECT_PATHS.root}${cache ? `?since=${cache.cursor}` : ""}`;
    const send = async (accessToken: string): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DIRECTORY_MUTATION_TIMEOUT_MS);
      try {
        return await (this.options.fetchImpl ?? fetch)(`${config.directoryBaseUrl}${path}`, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            "x-ade-correlation-id": createAccountDirectoryCorrelationId(),
          },
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };
    let body: unknown;
    try {
      let response = await send(token);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        response = await send(await this.getAccessToken({ forceRefresh: true }));
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return response.status === 401 ? { state: "signed_out", projects: [] } : cached();
      }
      body = await readBoundedAccountDirectoryJson(response);
    } catch {
      return cached();
    }
    if (this.snapshot.userId !== userId) return { state: "not_loaded", projects: [] };
    const answer = body && typeof body === "object" ? body as Record<string, unknown> : null;
    if (!answer || typeof answer.cursor !== "number" || !Array.isArray(answer.projects)) return cached();
    const rows = answer.reset === true || !cache ? new Map<string, Record<string, unknown>>() : new Map(cache.rows);
    for (const row of answer.projects) {
      if (row && typeof row === "object" && typeof (row as Record<string, unknown>).id === "string") {
        rows.set((row as Record<string, unknown>).id as string, row as Record<string, unknown>);
      }
    }
    this.accountProjects = { userId, cursor: answer.cursor, rows };
    return cached();
  }

  private accountProjects: { userId: string; cursor: number; rows: Map<string, Record<string, unknown>> } | null = null;

  /** The merged list as the last read left it; `not_loaded` before the first read. */
  private cachedAccountProjects(
    userId: string,
    coerce: (value: unknown) => AccountProjectListResult,
  ): AccountProjectListResult {
    const cache = this.accountProjects?.userId === userId ? this.accountProjects : null;
    if (!cache) return { state: "not_loaded", projects: [] };
    const all = [...cache.rows.values()];
    const live = all.filter((row) => row.removedAt == null && row.mergedInto == null);
    const retired = all
      .filter((row) => row.removedAt != null || row.mergedInto != null)
      .map((row) => ({
        id: row.id,
        name: row.name,
        mergedInto: typeof row.mergedInto === "string" ? row.mergedInto : null,
        removedAt: typeof row.removedAt === "number" ? row.removedAt : null,
      }));
    return coerce({ state: "ready", cursor: cache.cursor, projects: live, retired });
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
      if (!response.ok) {
        let payload: unknown = null;
        try {
          payload = await readBoundedAccountDirectoryJson(response);
        } catch {
          // Preserve the local row when the directory does not prove that the
          // account-side removal completed.
        }
        if (isConfirmedActivityPurgeFailure(payload)) {
          // The directory row is gone, but Activity still needs a retry. This
          // is the only non-2xx response that authorizes local cleanup.
          this.snapshot = {
            ...this.snapshot,
            machines: this.snapshot.machines.filter((machine) => machine.machineKey !== machineKey),
          };
          throw new Error(ACTIVITY_PURGE_FAILED_MESSAGE);
        }
        throw new Error(`Couldn't remove that machine (${response.status}).`);
      }
      await response.body?.cancel().catch(() => undefined);
      this.snapshot = {
        ...this.snapshot,
        machines: this.snapshot.machines.filter((machine) => machine.machineKey !== machineKey),
      };
      return { ok: true, machineKey };
    } catch (cause) {
      if (isAbortError(cause) || controller.signal.aborted) {
        throw new Error(REMOVAL_TIMEOUT_MESSAGE);
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }

  async renameMachine(
    machineKeyValue: string,
    customNameValue: string | null,
  ): Promise<AdeAccountMachine> {
    const config = this.config;
    const machineKey = machineKeyValue.trim();
    const customName = customNameValue?.trim() || null;
    if (!config || !machineKey) throw new Error("A machine is required.");
    if (customName && customName.length > 80) {
      throw new Error("Machine name must be 80 characters or fewer.");
    }
    const accessToken = await this.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DIRECTORY_MUTATION_TIMEOUT_MS);
    const correlationId = createAccountDirectoryCorrelationId();
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${config.directoryBaseUrl}/account/machines/${encodeURIComponent(machineKey)}`,
        {
          method: "PATCH",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "x-ade-correlation-id": correlationId,
          },
          body: JSON.stringify({ customName }),
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
      if (!response.ok) throw new Error(`Couldn't rename that machine (${response.status}).`);
      const machine = parseAccountMachine(
        await readBoundedAccountDirectoryJson(response),
      );
      if (!machine) throw new Error("The machine directory returned unreadable data.");
      this.snapshot = {
        ...this.snapshot,
        machines: this.snapshot.machines.map((entry) =>
          entry.machineKey === machine.machineKey ? machine : entry
        ),
      };
      return machine;
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

  /** Every pending-stash key currently in storage, newest-first order unspecified. */
  private pendingOAuthKeys(): string[] {
    const store = this.storage;
    if (typeof store.key !== "function" || typeof store.length !== "number") return [];
    const prefix = `${OAUTH_PENDING_KEY}:`;
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }

  private readPendingOAuth(state: string | null): PendingOAuth | null {
    if (!state) return null;
    return parsePendingOAuth(
      this.storage.getItem(pendingOAuthKeyFor(state)),
      this.options.now?.() ?? Date.now(),
      state,
    );
  }

  private writePendingOAuth(pending: PendingOAuth): void {
    // Sweep stashes whose TTL has run out so an abandoned sign-in does not
    // accumulate in localStorage for the life of the origin.
    const nowMs = this.options.now?.() ?? Date.now();
    for (const key of this.pendingOAuthKeys()) {
      if (!parsePendingOAuth(this.storage.getItem(key), nowMs)) this.storage.removeItem(key);
    }
    this.storage.setItem(pendingOAuthKeyFor(pending.state), JSON.stringify(pending));
  }

  /**
   * Consume exactly one attempt's stash.
   *
   * A no-op when the state is null — an IdP that redirects back with an error
   * and no `state` echo names no attempt, and treating that as "clear
   * everything" wiped the stash of every OTHER tab mid-sign-in, which is the
   * failure the per-state stash exists to prevent.
   */
  private clearPendingOAuthAttempt(state: string | null): void {
    if (!state) return;
    this.storage.removeItem(pendingOAuthKeyFor(state));
  }

  /** The person pressed "Sign out" here and has not signed in since. */
  signedOutByUser(): boolean {
    try {
      return this.storage.getItem(SIGNED_OUT_BY_USER_KEY) != null;
    } catch {
      return false;
    }
  }

  private writeSignedOutByUser(signedOut: boolean): void {
    try {
      if (signedOut) this.storage.setItem(SIGNED_OUT_BY_USER_KEY, "1");
      else this.storage.removeItem(SIGNED_OUT_BY_USER_KEY);
    } catch {
      // Best effort: at worst the next sign-in reuses the browser's session.
    }
  }

  /** Drop every attempt. Sign-out only — never a callback path. */
  private clearAllPendingOAuth(): void {
    for (const key of this.pendingOAuthKeys()) this.storage.removeItem(key);
  }
}
