import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubAppUserAuthService,
  resetGitHubAppUserAuthCoordinatorsForTests,
} from "./githubAppUserAuthService";

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

function writeRecord(values: StoredValues, patch: Record<string, unknown> = {}): void {
  values[TOKEN_KEY] = JSON.stringify({
    accessToken: "ghu_old",
    tokenType: "bearer",
    scope: null,
    // Already past its life, so every call has to refresh.
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    refreshToken: "ghr_live",
    refreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 3_600_000).toISOString(),
    userLogin: "octocat",
    updatedAt: new Date().toISOString(),
    ...patch,
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
