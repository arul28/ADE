import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubAppUserAuthService,
  judgeStoredAuth,
  resetGitHubAppUserAuthCoordinatorsForTests,
} from "./githubAppUserAuthService";
import { emptyLedger, type StoredAppUserAuth } from "./githubAppUserAuthLedger";
import {
  GitHubOAuthError,
  pollGitHubAppDeviceFlow,
  refreshGitHubAppUserToken,
  startGitHubAppDeviceFlow,
  type GitHubAppUserTokenRecord,
} from "./githubAppUserAuth";
import { GITHUB_APP_USER_AUTH_RENEWING_COPY } from "../../../shared/types";
import {
  GitHubAppUserAuthError,
  classifyAppUserAuthFailure,
} from "./githubAppUserAuthFailure";
import { makeStoredAppUserToken } from "./githubAppUserAuth.testFixtures";

const TOKEN_KEY = "github.appUserToken.v1";

type StoredValues = Record<string, string>;

/**
 * A stand-in for EncryptedFileCredentialStore: several store objects may share
 * one `values` map, which is how the real machine file is shared by the desktop
 * app, the ADE brain and the CLI. `updateKeySync` is the atomic read-modify-write
 * those processes serialize their writes through.
 */
function createFakeStore(values: StoredValues) {
  return {
    getSync: (key: string): string | null => values[key] ?? null,
    setSync: (key: string, value: string): void => {
      values[key] = value;
    },
    deleteSync: (key: string): void => {
      delete values[key];
    },
    updateKeySync: (
      key: string,
      mutator: (current: string | null) => string | null | undefined,
    ): void => {
      const next = mutator(values[key] ?? null);
      if (next === undefined) return;
      if (next === null) delete values[key];
      else values[key] = next;
    },
  };
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function storedRecord(values: StoredValues): Record<string, unknown> | null {
  const raw = values[TOKEN_KEY];
  return raw ? JSON.parse(raw) as Record<string, unknown> : null;
}

function writeRecord(
  values: StoredValues,
  patch: Partial<GitHubAppUserTokenRecord> = {},
): void {
  // The shared fixture already holds the two facts every test here needs: an
  // access token past its life next to a live refresh token. Only the token
  // strings are spelled out, because the assertions name them.
  values[TOKEN_KEY] = makeStoredAppUserToken({
    accessToken: "ghu_old",
    refreshToken: "ghr_live",
    ...patch,
  });
}

/** Writes the record with a refresh ledger already in it. */
function writeRecordWithLedger(values: StoredValues, ledger: Record<string, unknown>): void {
  writeRecord(values);
  values[TOKEN_KEY] = JSON.stringify({
    ...JSON.parse(values[TOKEN_KEY]!) as Record<string, unknown>,
    refresh: ledger,
  });
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_CODE_URL = "https://github.com/login/device/code";

function tokenPostCount(fetchImpl: { mock: { calls: unknown[][] } }): number {
  return fetchImpl.mock.calls.filter((call) => String(call[0]) === TOKEN_URL).length;
}

/** A refresh endpoint that rotates the token and kills the one it replaced. */
function createRotatingRefreshEndpoint() {
  let live = "ghr_live";
  let rotations = 0;
  return {
    get rotations() {
      return rotations;
    },
    respond(body: string | null): Response {
      const sent = new URLSearchParams(body ?? "").get("refresh_token") ?? "";
      if (sent !== live) {
        return jsonResponse({
          error: "bad_refresh_token",
          error_description: "The refresh token passed is incorrect or expired.",
        });
      }
      rotations += 1;
      live = `ghr_rotated_${rotations}`;
      return jsonResponse({
        access_token: `ghu_fresh_${rotations}`,
        token_type: "bearer",
        expires_in: 28_800,
        refresh_token: live,
        refresh_token_expires_in: 15_811_200,
      });
    },
  };
}

let clockNowMs = Date.parse("2026-08-20T12:00:00.000Z");
const now = (): number => clockNowMs;
const advance = (ms: number): void => {
  clockNowMs += ms;
};
// Yields to the event loop without spending wall-clock time, so a coordinator
// that waits for a peer's write still makes progress inside a test.
const sleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let identityCounter = 0;
function nextIdentity(): string {
  identityCounter += 1;
  return `test-store-${identityCounter}`;
}

beforeEach(() => {
  clockNowMs = Date.parse("2026-08-20T12:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => clockNowMs);
  resetGitHubAppUserAuthCoordinatorsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("app user token refresh", () => {
  it("stops retrying a refresh token GitHub has rejected", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: "bad_refresh_token",
      error_description: "The refresh token passed is incorrect or expired.",
    }));
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    await expect(service.getValidTokenForRelay()).rejects.toThrow();
    await expect(service.getValidTokenForRelay()).rejects.toThrow();
    await expect(service.getValidTokenForRelay()).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The record survives so the UI can say "re-authorize" instead of "never
    // connected", which is the difference between a fixable state and a mystery.
    expect(storedRecord(values)).not.toBeNull();
    expect(service.getAuthStatus().credentialState).toBe("needs_reauth");
  });

  it("pauses refreshes for the retry-after window GitHub asked for", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    const fetchImpl = vi.fn(async () => jsonResponse(
      { error: "too_many_requests" },
      { status: 429, headers: { "retry-after": "120" } },
    ));
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    await expect(service.getValidTokenForRelay()).rejects.toThrow();
    const status = service.getAuthStatus();
    expect(status.credentialState).toBe("blocked");
    expect(status.lastRefreshError?.kind).toBe("rate_limited");
    expect(Date.parse(status.refreshBlockedUntil ?? "")).toBe(clockNowMs + 120_000);

    advance(119_000);
    await expect(service.getValidTokenForRelay()).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    advance(2_000);
    await expect(service.getValidTokenForRelay()).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps a whole hour of demand under eight refresh requests", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    const fetchImpl = vi.fn(async () => jsonResponse(
      { error: "server_error" },
      { status: 503 },
    ));
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    // The relay poller asks every 30 seconds; an hour of that is 120 demands.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(service.getValidTokenForRelay()).rejects.toThrow();
      advance(30_000);
    }

    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(8);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });

  it("sends one refresh for every service instance in a process", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    const endpoint = createRotatingRefreshEndpoint();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => endpoint.respond(
      typeof init?.body === "string" ? init.body : null,
    ));
    const identity = nextIdentity();
    const store = createFakeStore(values);
    const build = () => createGitHubAppUserAuthService({
      credentialStore: store,
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: identity,
      now,
      sleep,
    });
    // One service per project scope is what the desktop app and the brain both
    // build, and they all read the same credential record.
    const services = [build(), build(), build(), build()];

    const tokens = await Promise.all(services.map((service) => service.getValidTokenForRelay()));

    expect(endpoint.rotations).toBe(1);
    expect(tokenPostCount(fetchImpl)).toBe(1);
    expect(new Set(tokens)).toEqual(new Set(["ghu_fresh_1"]));
  });

  it("makes a second process wait for the refresh a peer is already running", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    const endpoint = createRotatingRefreshEndpoint();
    let releaseWinner: () => void = () => undefined;
    const winnerReleased = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : null;
      await winnerReleased;
      return endpoint.respond(body);
    });
    const build = (identity: string) => createGitHubAppUserAuthService({
      // A separate store object per process: same file, separate memory.
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: identity,
      now,
      sleep,
    });

    const brain = build(nextIdentity());
    const desktop = build(nextIdentity());
    const winner = brain.getValidTokenForRelay();
    // Let the winner take the lease before the peer looks at the record.
    await Promise.resolve();
    const loser = desktop.getValidTokenForRelay();
    releaseWinner();

    await expect(winner).resolves.toBe("ghu_fresh_1");
    await expect(loser).resolves.toBe("ghu_fresh_1");
    // A second POST would have carried the refresh token the first one just
    // rotated away, and GitHub answers that by killing the credential.
    expect(tokenPostCount(fetchImpl)).toBe(1);
    expect(endpoint.rotations).toBe(1);
  });

  // The "I re-authorized and nothing changed" incident. A refresh POST was
  // already in flight when the user finished the device flow, and its
  // bad_refresh_token answer — about the credential that had just been
  // REPLACED — was written over the brand-new one, which put the account
  // straight back into "re-authorize".
  it("keeps a credential the device flow just wrote when the older refresh POST is rejected", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    let releaseRefresh: () => void = () => undefined;
    const refreshReleased = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (String(url) === DEVICE_CODE_URL) {
        return jsonResponse({
          device_code: "dev_code",
          user_code: "ADE-CODE",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 1,
        });
      }
      if (String(url) === TOKEN_URL && body.includes("grant_type=refresh_token")) {
        await refreshReleased;
        return jsonResponse({
          error: "bad_refresh_token",
          error_description: "The refresh token passed is incorrect or expired.",
        });
      }
      if (String(url) === TOKEN_URL) {
        return jsonResponse({
          access_token: "ghu_after_reauth",
          token_type: "bearer",
          expires_in: 28_800,
          refresh_token: "ghr_after_reauth",
          refresh_token_expires_in: 15_811_200,
        });
      }
      return jsonResponse({ login: "octocat" });
    });
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    const inFlight = service.getValidTokenForRelay();
    // Let the refresh POST reach the (blocked) endpoint before the user
    // finishes authorizing.
    await sleep();
    const session = await service.startDeviceAuth();
    const authorized = await service.pollDeviceAuth({ sessionId: session.sessionId });
    expect(authorized.status).toBe("authorized");
    releaseRefresh();

    await expect(inFlight).resolves.toBe("ghu_after_reauth");
    const status = service.getAuthStatus();
    expect(status.credentialState).toBe("authorized");
    expect(status.lastRefreshError).toBeNull();
    expect(storedRecord(values)).toMatchObject({ accessToken: "ghu_after_reauth" });
  });

  // The same race with a SUCCESSFUL POST, and with the newer credential written
  // by a peer process — so nothing in this process knows the record changed and
  // the refresh token itself is the only evidence.
  it("does not write a successful refresh over a credential a peer authorized meanwhile", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    let releaseRefresh: () => void = () => undefined;
    const refreshReleased = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await refreshReleased;
      return jsonResponse({
        access_token: "ghu_from_stale_refresh",
        token_type: "bearer",
        expires_in: 28_800,
        refresh_token: "ghr_from_stale_refresh",
        refresh_token_expires_in: 15_811_200,
      });
    });
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    const inFlight = service.getValidTokenForRelay();
    // Let the refresh POST reach the (blocked) endpoint, then let another
    // process finish its own device flow into the shared credential file.
    await sleep();
    writeRecord(values, {
      accessToken: "ghu_after_peer_reauth",
      expiresAt: new Date(clockNowMs + 8 * 3_600_000).toISOString(),
      refreshToken: "ghr_after_peer_reauth",
    });
    releaseRefresh();

    await expect(inFlight).resolves.toBe("ghu_after_peer_reauth");
    expect(storedRecord(values)).toMatchObject({ accessToken: "ghu_after_peer_reauth" });
  });

  it("does not resurrect a credential another instance cleared", async () => {
    const values: StoredValues = {};
    writeRecord(values, { expiresAt: new Date(clockNowMs + 3_600_000).toISOString() });
    const store = createFakeStore(values);
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const service = createGitHubAppUserAuthService({
      credentialStore: store,
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    expect(service.getStoredTokenForHealth()).toBe("ghu_old");
    // Another process signed out; the store is the truth, not this instance's
    // last read of it.
    delete values[TOKEN_KEY];

    expect(service.getStoredTokenForHealth()).toBeNull();
    expect(service.getAuthStatus().tokenStored).toBe(false);
    expect(service.getAuthStatus().credentialState).toBe("missing");
  });

  it("refuses a lapsed access token whose refresh token has expired", async () => {
    // The refresh POST succeeds, but a peer replaced the credential while it
    // was in flight, so the write is declined and the store's own record is
    // served instead. That record cannot be renewed by anyone, so the only
    // honest answer is "re-authorize": handing back its lapsed access token
    // produced a GitHub 401 the user had no way to act on.
    const values: StoredValues = {};
    writeRecord(values);
    const fetchImpl = vi.fn(async (input: string) => {
      if (String(input) !== TOKEN_URL) return jsonResponse({});
      values[TOKEN_KEY] = makeStoredAppUserToken({
        accessToken: "ghu_replaced_and_lapsed",
        refreshToken: "ghr_replaced",
        expiresAt: new Date(clockNowMs - 60_000).toISOString(),
        refreshTokenExpiresAt: new Date(clockNowMs - 3_600_000).toISOString(),
      });
      return jsonResponse({
        access_token: "ghu_fresh",
        token_type: "bearer",
        expires_in: 28_800,
        refresh_token: "ghr_rotated",
        refresh_token_expires_in: 15_811_200,
      });
    });
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    await expect(service.getValidTokenForRelay()).rejects.toThrow(/Re-authorize ADE with GitHub/);
    expect(service.getAuthStatus().credentialState).toBe("needs_reauth");
  });
});

// Every deadline in the ledger is written by a peer process, and a peer whose
// clock is wrong writes one no amount of waiting reaches. Honouring it locks
// every process on the machine out of the refresh until someone deletes the
// credential file by hand.
describe("poisoned deadlines in the shared ledger", () => {
  it("ignores a refresh lease stamped an hour ahead of the longest real one", async () => {
    const values: StoredValues = {};
    writeRecordWithLedger(values, {
      leaseUntil: new Date(clockNowMs + 3_600_000).toISOString(),
      leaseHolder: "peer-with-a-wrong-clock",
    });
    const endpoint = createRotatingRefreshEndpoint();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => endpoint.respond(
      typeof init?.body === "string" ? init.body : null,
    ));
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    await expect(service.getValidTokenForRelay()).resolves.toBe("ghu_fresh_1");
    expect(tokenPostCount(fetchImpl)).toBe(1);
  });

  it("ignores a refresh backoff stamped a year ahead", async () => {
    const values: StoredValues = {};
    writeRecordWithLedger(values, {
      notBeforeAt: new Date(clockNowMs + 365 * 24 * 3_600_000).toISOString(),
      consecutiveFailures: 1,
      lastFailure: {
        kind: "rate_limited",
        message: "GitHub paused this.",
        status: 429,
        at: new Date(clockNowMs).toISOString(),
      },
    });
    const endpoint = createRotatingRefreshEndpoint();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => endpoint.respond(
      typeof init?.body === "string" ? init.body : null,
    ));
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    expect(service.getAuthStatus().credentialState).toBe("authorized");
    await expect(service.getValidTokenForRelay()).resolves.toBe("ghu_fresh_1");
  });

  it("still honours a deadline inside the bounds ADE writes", async () => {
    const values: StoredValues = {};
    writeRecordWithLedger(values, {
      notBeforeAt: new Date(clockNowMs + 120_000).toISOString(),
      consecutiveFailures: 1,
      lastFailure: {
        kind: "rate_limited",
        message: "GitHub paused this.",
        status: 429,
        at: new Date(clockNowMs).toISOString(),
      },
    });
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    expect(service.getAuthStatus().credentialState).toBe("blocked");
    await expect(service.getValidTokenForRelay()).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("refresh lease release", () => {
  // The lease is written before the POST and cleared by whichever outcome gets
  // recorded. A credential store that throws while recording one records
  // nothing — and used to leave the lease behind, which stalls every other
  // process for the full minute for no reason at all.
  it("hands the lease back when the store refuses to record the outcome", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    const base = createFakeStore(values);
    let updates = 0;
    const store = {
      ...base,
      updateKeySync: (
        key: string,
        mutator: (current: string | null) => string | null | undefined,
      ): void => {
        updates += 1;
        // Update 1 takes the lease. Updates 2 and 3 are the two attempts to
        // record an outcome — the refreshed credential, then the failure that
        // first attempt turned into — and the store refuses both.
        if (updates === 2 || updates === 3) throw new Error("credential store write failed");
        base.updateKeySync(key, mutator);
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse({
      access_token: "ghu_fresh",
      token_type: "bearer",
      expires_in: 28_800,
      refresh_token: "ghr_rotated",
      refresh_token_expires_in: 15_811_200,
    }));
    const service = createGitHubAppUserAuthService({
      credentialStore: store,
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    await expect(service.getValidTokenForRelay()).rejects.toThrow("credential store write failed");

    const ledger = storedRecord(values)?.refresh as Record<string, unknown> | undefined;
    expect(ledger?.leaseUntil).toBeNull();
    expect(ledger?.leaseHolder).toBeNull();
  });
});

describe("refresh failure classification", () => {
  const buildService = (values: StoredValues, fetchImpl: unknown) =>
    createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

  // GitHub's secondary rate limits answer 403, sometimes with no body and no
  // retry-after at all. Reading that as a dead grant signed working accounts
  // out and told them to re-authorize against the endpoint doing the limiting.
  it("treats a bare 403 as a pause rather than a dead credential", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    const service = buildService(values, vi.fn(async () => new Response("", { status: 403 })));

    await expect(service.getValidTokenForRelay()).rejects.toThrow();

    const status = service.getAuthStatus();
    expect(status.credentialState).toBe("blocked");
    expect(status.lastRefreshError?.kind).toBe("rate_limited");
    expect(Date.parse(status.refreshBlockedUntil ?? "")).toBeGreaterThan(clockNowMs);
  });

  // A proxy or captive portal answers with HTML and a 4xx. Nothing about that
  // is evidence against the credential.
  it("treats a 400 with a non-OAuth body as unknown rather than a dead credential", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    const service = buildService(values, vi.fn(async () => new Response(
      "<html><body>Bad Request</body></html>",
      { status: 400, headers: { "content-type": "text/html" } },
    )));

    await expect(service.getValidTokenForRelay()).rejects.toThrow();

    const status = service.getAuthStatus();
    expect(status.credentialState).toBe("blocked");
    expect(status.lastRefreshError?.kind).toBe("unknown");
  });

  it("treats a 200 carrying bad_refresh_token as a dead credential", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    const service = buildService(values, vi.fn(async () => jsonResponse({
      error: "bad_refresh_token",
      error_description: "The refresh token passed is incorrect or expired.",
    })));

    await expect(service.getValidTokenForRelay()).rejects.toThrow();

    const status = service.getAuthStatus();
    expect(status.credentialState).toBe("needs_reauth");
    expect(status.lastRefreshError?.kind).toBe("dead_token");
  });
});

describe("app user auth status", () => {
  it("reports a stale access token with a live refresh token as authorized", async () => {
    const values: StoredValues = {};
    writeRecord(values);
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    const status = service.getAuthStatus();
    expect(status.credentialState).toBe("authorized");
    expect(status.refreshBlockedUntil).toBeNull();
    expect(status.lastRefreshError).toBeNull();
  });

  it("keeps serving a still-fresh token that has no renewal left", async () => {
    // A refresh token can expire, or be revoked, while the access token it last
    // minted is still good — and this one lapses in an hour. The token WORKS, so
    // every gate hands it out; the status axis is where ADE asks for a
    // replacement, hours before it lapses.
    const values: StoredValues = {};
    writeRecord(values, {
      accessToken: "ghu_fresh_but_final",
      expiresAt: new Date(clockNowMs + 3_600_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
    });
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    await expect(service.getValidTokenForRelay()).resolves.toBe("ghu_fresh_but_final");
    expect(tokenPostCount(fetchImpl)).toBe(0);
    expect(service.getAuthStatus().credentialState).toBe("needs_reauth");
  });

  it("treats a non-expiring token with no refresh token as authorized", async () => {
    // An App configured for NON-EXPIRING user tokens stores neither an expiry
    // nor a refresh token. That credential never lapses, so the status axis
    // must not ask the user to replace it.
    const values: StoredValues = {};
    writeRecord(values, {
      accessToken: "ghu_never_expires",
      expiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    });
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    await expect(service.getValidTokenForRelay()).resolves.toBe("ghu_never_expires");
    expect(tokenPostCount(fetchImpl)).toBe(0);
    expect(service.getAuthStatus().credentialState).toBe("authorized");
  });

  it("reports an expired refresh token as needing re-authorization", async () => {
    const values: StoredValues = {};
    writeRecord(values, {
      refreshTokenExpiresAt: new Date(clockNowMs - 3_600_000).toISOString(),
    });
    const service = createGitHubAppUserAuthService({
      credentialStore: createFakeStore(values),
      logger: createLogger(),
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      userAgent: "ade-test",
      storeIdentity: nextIdentity(),
      now,
      sleep,
    });

    expect(service.getAuthStatus().credentialState).toBe("needs_reauth");
  });
});

describe("judgeStoredAuth", () => {
  // The ladder four gates share. They used to run their own copies in three
  // different orders, and the orders disagreed: one handed out a lapsed access
  // token whose refresh token had already expired.
  const NOW_MS = Date.parse("2026-08-20T12:00:00.000Z");
  const iso = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();

  function stored(
    token: Partial<GitHubAppUserTokenRecord> | null,
    ledger: Partial<ReturnType<typeof emptyLedger>> = {},
  ): StoredAppUserAuth {
    return {
      token: token
        ? {
          accessToken: "ghu_access",
          tokenType: "bearer",
          scope: null,
          expiresAt: iso(3_600_000),
          refreshToken: "ghr_live",
          refreshTokenExpiresAt: iso(30 * 86_400_000),
          userLogin: "alice",
          updatedAt: iso(-60_000),
          ...token,
        }
        : null,
      refresh: { ...emptyLedger(), ...ledger },
    };
  }

  it("reports missing when nothing is stored", () => {
    expect(judgeStoredAuth(stored(null), NOW_MS)).toEqual({ outcome: "missing" });
  });

  it("serves a fresh token and says it can still be renewed", () => {
    const verdict = judgeStoredAuth(stored({}), NOW_MS);

    expect(verdict.outcome).toBe("fresh");
    if (verdict.outcome !== "fresh") throw new Error("expected fresh");
    expect(verdict.record.accessToken).toBe("ghu_access");
    expect(verdict.renewableRecord?.refreshToken).toBe("ghr_live");
  });

  it("serves a fresh token with no renewal left, and says so", () => {
    // The token WORKS, so no gate may withhold it — but the status axis has to
    // ask for a replacement before it lapses.
    const verdict = judgeStoredAuth(
      stored({ refreshToken: null, refreshTokenExpiresAt: null }),
      NOW_MS,
    );

    expect(verdict.outcome).toBe("fresh");
    if (verdict.outcome !== "fresh") throw new Error("expected fresh");
    expect(verdict.renewableRecord).toBeNull();
  });

  it("reports needs_reauth for a lapsed token whose refresh token expired", () => {
    const failure = {
      kind: "dead_token" as const,
      message: "bad credentials",
      status: 401,
      oauthError: null,
      retryAfterSec: null,
      at: iso(-1_000),
    };
    const verdict = judgeStoredAuth(
      stored(
        { expiresAt: iso(-60_000), refreshTokenExpiresAt: iso(-1_000) },
        { lastFailure: failure },
      ),
      NOW_MS,
    );

    expect(verdict).toEqual({ outcome: "needs_reauth", failure });
  });

  it("reports needs_reauth for a lapsed token the ledger already declared dead", () => {
    const verdict = judgeStoredAuth(
      stored({ expiresAt: iso(-60_000) }, { dead: true }),
      NOW_MS,
    );

    expect(verdict.outcome).toBe("needs_reauth");
  });

  it("reports blocked while a refresh backoff deadline has not passed", () => {
    const verdict = judgeStoredAuth(
      stored({ expiresAt: iso(-60_000) }, { notBeforeAt: iso(30_000) }),
      NOW_MS,
    );

    expect(verdict).toMatchObject({ outcome: "blocked", retryAt: iso(30_000) });
  });

  it("reports refreshable for a lapsed token with a healthy refresh token", () => {
    const verdict = judgeStoredAuth(stored({ expiresAt: iso(-60_000) }), NOW_MS);

    expect(verdict.outcome).toBe("refreshable");
    if (verdict.outcome !== "refreshable") throw new Error("expected refreshable");
    expect(verdict.record.refreshToken).toBe("ghr_live");
  });

  it("treats an access token inside the refresh skew as lapsed", () => {
    // The skew exists so ADE renews BEFORE the token stops working, rather than
    // handing out one that expires mid-request.
    expect(judgeStoredAuth(stored({ expiresAt: iso(30_000) }), NOW_MS).outcome)
      .toBe("refreshable");
  });
});

async function captureError(run: () => Promise<unknown>): Promise<GitHubOAuthError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubOAuthError);
    return error as GitHubOAuthError;
  }
  throw new Error("Expected the call to reject.");
}

describe("refreshGitHubAppUserToken", () => {
  it("rejects an HTTP-200 OAuth error body as a definitive dead-token failure", async () => {
    // GitHub answers a rejected refresh token with HTTP 200 and an error body,
    // which is why "did the response parse" is not the same question as "did the
    // refresh work".
    const fetchImpl = async (): Promise<Response> => jsonResponse({
      error: "bad_refresh_token",
      error_description: "The refresh token passed is incorrect or expired.",
      error_uri: "https://docs.github.com/apps",
    });

    const error = await captureError(() => refreshGitHubAppUserToken({
      refreshToken: "ghr_dead",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
    }));

    expect(error.oauthError).toBe("bad_refresh_token");
    expect(error.status).toBe(200);
    expect(error.message).toContain("refresh token");
  });

  it("carries the status and retry-after of a rate-limited refresh", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse(
      { error: "too_many_requests", error_description: "You have exceeded a secondary rate limit." },
      { status: 429, headers: { "retry-after": "120" } },
    );

    const error = await captureError(() => refreshGitHubAppUserToken({
      refreshToken: "ghr_live",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
    }));

    expect(error.status).toBe(429);
    expect(error.retryAfterSec).toBe(120);
    expect(error.oauthError).toBe("too_many_requests");
  });

  it("returns the rotated refresh token when GitHub rotates it", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({
      access_token: "ghu_new",
      token_type: "bearer",
      expires_in: 28_800,
      refresh_token: "ghr_rotated",
      refresh_token_expires_in: 15_811_200,
    });

    const record = await refreshGitHubAppUserToken({
      refreshToken: "ghr_old",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
    });

    expect(record.accessToken).toBe("ghu_new");
    expect(record.refreshToken).toBe("ghr_rotated");
  });
});

describe("device flow transport", () => {
  it("carries the status and retry-after of a rate-limited device-code request", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse(
      { error: "too_many_requests" },
      { status: 429, headers: { "retry-after": "60" } },
    );

    const error = await captureError(() => startGitHubAppDeviceFlow({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
    }));

    expect(error.status).toBe(429);
    expect(error.retryAfterSec).toBe(60);
  });

  it("keeps reporting HTTP-200 device-flow errors as poll results", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ error: "authorization_pending" });

    const result = await pollGitHubAppDeviceFlow({
      deviceCode: "device",
      intervalSec: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: "ade-test",
    });

    expect(result.status).toBe("pending");
  });
});

const RETRY_AT = "2026-08-20T12:00:30.000Z";

describe("classifyAppUserAuthFailure", () => {
  it("reports ADE's own refresh lease as renewing rather than a failed check", () => {
    // `blocked` with nothing refused is one ADE process renewing the credential
    // while the rest wait. The repo axis already said so; the credential
    // inventory called the same wait a failed authentication check.
    const failure = classifyAppUserAuthFailure(new GitHubAppUserAuthError(
      "GitHub paused ADE's authorization renewal. ADE retries on its own.",
      "blocked",
      RETRY_AT,
      null,
    ));

    expect(failure.authFailure).toEqual({
      kind: "renewing",
      message: GITHUB_APP_USER_AUTH_RENEWING_COPY,
      retryAt: RETRY_AT,
    });
  });

  it("keeps GitHub's own refusal when the pause carries one", () => {
    const failure = classifyAppUserAuthFailure(new GitHubAppUserAuthError(
      "GitHub paused ADE's authorization renewal. ADE retries on its own.",
      "blocked",
      RETRY_AT,
      { kind: "rate_limited", status: 429, oauthError: null },
    ));

    expect(failure.authFailure.kind).toBe("rate_limited");
    expect(failure.authFailure.retryAt).toBe(RETRY_AT);
  });

  it("asks for re-authorization when the refresh token is gone", () => {
    const failure = classifyAppUserAuthFailure(new GitHubAppUserAuthError(
      "ADE GitHub App authorization expired. Re-authorize ADE with GitHub.",
      "needs_reauth",
      null,
      { kind: "dead_token", status: 401, oauthError: "bad_refresh_token" },
    ));

    expect(failure.authFailure.kind).toBe("invalid_token");
    expect(failure.authFailure.retryAt).toBeNull();
  });
});
