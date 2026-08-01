import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// vi.hoisted mock state
// ---------------------------------------------------------------------------
const mockFetch = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// vi.mock — external dependencies
// ---------------------------------------------------------------------------

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString: () => JSON.stringify({ token: "ghp_mock" }),
    encryptString: (s: string) => Buffer.from(s),
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => Buffer.from("encrypted")),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      chmodSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => Buffer.from("encrypted")),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const runGitMock = vi.hoisted(() => vi.fn());
const originalDisableGhAuthFallback = process.env.ADE_DISABLE_GH_AUTH_FALLBACK;

vi.mock("../git/git", () => ({
  runGit: runGitMock,
}));

// Replace global fetch
vi.stubGlobal("fetch", mockFetch);

import {
  GITHUB_API_BODY_TIMEOUT_MS,
  createGithubService,
  fetchAdeLatestRelease,
} from "./githubService";
import {
  clearGithubCredentialHealth,
  githubCredentialCooldown,
  githubCredentialRepositoryAccess,
  recordGithubCredentialFailure,
} from "./githubCredentialHealth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function resetMocks() {
  clearGithubCredentialHealth();
  vi.clearAllMocks();
  mockFetch.mockReset();
  runGitMock.mockReset();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_CONFIG_DIR;
  delete process.env.ADE_GITHUB_TOKEN;
  delete process.env.ADE_GITHUB_RELAY_API_BASE_URL;
  delete process.env.ADE_GITHUB_RELAY_ACCESS_TOKEN;
  delete process.env.ADE_GITHUB_RELAY_REMOTE_PROJECT_ID;
  process.env.ADE_DISABLE_GH_AUTH_FALLBACK = "1";
}

afterAll(() => {
  if (originalDisableGhAuthFallback == null) {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
  } else {
    process.env.ADE_DISABLE_GH_AUTH_FALLBACK = originalDisableGhAuthFallback;
  }
});

class MemoryCredentialStore {
  values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.getSync(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.setSync(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleteSync(key);
  }

  getSync(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setSync(key: string, value: string): void {
    this.values.set(key, value);
  }

  deleteSync(key: string): void {
    this.values.delete(key);
  }
}

function makeService(options: {
  credentialStore?: MemoryCredentialStore;
  ghAuthTokenProvider?: () =>
    | { token: string | null; ghCliPath: string | null; ghAuthError: string | null }
    | Promise<{ token: string | null; ghCliPath: string | null; ghAuthError: string | null }>;
  githubRelaySecretReader?: (ref: string) => string | null;
  getAccountAccessToken?: () => Promise<string | null>;
} = {}) {
  return createGithubService({
    logger: makeLogger(),
    projectRoot: "/tmp/test-project",
    appDataDir: "/tmp/test-appdata",
    credentialStore: options.credentialStore as any,
    ghAuthTokenProvider: options.ghAuthTokenProvider,
    githubRelaySecretReader: options.githubRelaySecretReader,
    getAccountAccessToken: options.getAccountAccessToken,
  });
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
) {
  const headers = new Headers({ "content-type": "application/json", ...extraHeaders });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("githubService.apiRequest", () => {
  beforeEach(() => {
    resetMocks();
    // Tests assume no ambient token; CI/agents often inject GITHUB_TOKEN globally.
    delete process.env.GITHUB_TOKEN;
    delete process.env.ADE_GITHUB_TOKEN;
  });

  it("returns data and response on success (HTTP 200)", async () => {
    const payload = { id: 1, name: "test-repo" };
    mockFetch.mockResolvedValueOnce(jsonResponse(200, payload));

    const service = makeService();
    const result = await service.apiRequest({
      method: "GET",
      path: "/repos/owner/repo",
      token: "ghp_test123",
    });

    expect(result.data).toEqual(payload);
    expect(result.response).toBeDefined();
    expect(result.response!.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-github-api-version": "2026-03-10",
        }),
      }),
    );
  });

  it("aborts and rejects when the response body never finishes", async () => {
    vi.useFakeTimers();
    let markBodyStarted!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { markBodyStarted = resolve; });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn(() => {
        markBodyStarted();
        return new Promise<string>(() => {});
      }),
      json: vi.fn(),
    } as unknown as Response);
    const service = makeService();
    try {
      const pending = service.apiRequest({
        method: "GET",
        path: "/repos/owner/repo",
        token: "ghp_test123",
      });
      await bodyStarted;
      const result = expect(pending).rejects.toThrow(
        "GitHub API response body timed out",
      );
      await vi.advanceTimersByTimeAsync(GITHUB_API_BODY_TIMEOUT_MS);
      await result;
      const fetchSignal = mockFetch.mock.calls[0]?.[1]?.signal as AbortSignal;
      expect(fetchSignal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws with message from response when errors array is absent", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }));

    const service = makeService();
    await expect(
      service.apiRequest({ method: "GET", path: "/repos/owner/nope", token: "ghp_test123" }),
    ).rejects.toThrow("Not Found");
  });

  it("appends single error detail from errors array", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        message: "Validation Failed",
        errors: [{ message: "A pull request already exists" }],
      }),
    );

    const service = makeService();
    await expect(
      service.apiRequest({ method: "POST", path: "/repos/o/r/pulls", token: "ghp_test123" }),
    ).rejects.toThrow("Validation Failed: A pull request already exists");
  });

  it("joins multiple error details with semicolons", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        message: "Validation Failed",
        errors: [{ message: "err1" }, { message: "err2" }],
      }),
    );

    const service = makeService();
    await expect(
      service.apiRequest({ method: "POST", path: "/repos/o/r/pulls", token: "ghp_test123" }),
    ).rejects.toThrow("Validation Failed: err1; err2");
  });

  it("includes rate limit info and rateLimitResetAtMs when rate-limited", async () => {
    const resetTimestamp = Math.floor(Date.now() / 1000) + 3600;
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        403,
        {
          message: "API rate limit exceeded",
          errors: [{ message: "some detail" }],
        },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetTimestamp),
        },
      ),
    );

    const service = makeService();
    let thrownError: any;
    try {
      await service.apiRequest({ method: "GET", path: "/repos/o/r", token: "ghp_test123" });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect(thrownError.message).toContain("API rate limit exceeded");
    expect(thrownError.message).toContain("some detail");
    expect(thrownError.message).toContain("rate limit exceeded; resets at");
    expect(thrownError.rateLimitResetAtMs).toBe(resetTimestamp * 1000);
  });

  it("keeps Git transport auth usable while REST core access is rate limited", async () => {
    process.env.GITHUB_TOKEN = "ghp_rate_limited_but_valid";
    mockFetch.mockResolvedValueOnce(jsonResponse(403, {
      message: "API rate limit exceeded",
    }, {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000) + 3600),
      "x-ratelimit-resource": "core",
    }));
    const service = makeService();

    await expect(service.apiRequest({ method: "GET", path: "/repos/acme/ade" }))
      .rejects.toThrow("API rate limit exceeded");
    await expect(service.getReadTokenOrThrowAsync()).rejects.toThrow("GitHub auth missing");
    await expect(service.getGitTransportTokenOrThrowAsync())
      .resolves.toBe("ghp_rate_limited_but_valid");
  });

  it("does not use the read-only GitHub App token for Git transport", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    const service = makeService({
      credentialStore,
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    });

    await expect(service.getReadTokenOrThrowAsync()).resolves.toBe("ghu_app_user_token");
    await expect(service.getGitTransportTokenOrThrowAsync()).resolves.toBe("gho_cli_token");
  });

  it("keeps a stored PAT eligible for Git transport when the App is connected", async () => {
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.token.v1", "github_pat_read_only_contents");
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));

    await expect(makeService({ credentialStore }).getGitTransportTokenOrThrowAsync())
      .resolves.toBe("github_pat_read_only_contents");
  });

  it("memoizes credential inventory until authentication changes", async () => {
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    const readStoredCredential = vi.spyOn(credentialStore, "getSync");
    const service = makeService({ credentialStore });

    await service.getReadTokenOrThrowAsync();
    const readsAfterFirstLookup = readStoredCredential.mock.calls.length;
    await service.getReadTokenOrThrowAsync();
    expect(readStoredCredential).toHaveBeenCalledTimes(readsAfterFirstLookup);

    service.setToken("ghp_new_token");
    const readsAfterMutation = readStoredCredential.mock.calls.length;
    await service.getReadTokenOrThrowAsync();
    expect(readStoredCredential.mock.calls.length).toBeGreaterThan(readsAfterMutation);
  });

  it("preserves a primary rate-limit signal when a fallback is forbidden", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    process.env.GITHUB_TOKEN = "ghp_environment_token";
    const resetAtSec = Math.floor(Date.now() / 1_000) + 3_600;
    mockFetch
      .mockResolvedValueOnce(jsonResponse(403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetAtSec),
        "x-ratelimit-resource": "core",
      }))
      .mockResolvedValueOnce(jsonResponse(403, { message: "Resource not accessible" }));
    const service = makeService({
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    });

    await expect(service.apiRequest({
      method: "GET",
      path: "/repos/acme/ade",
      token: "ghp_environment_token",
    })).rejects.toMatchObject({ name: "GitHubRateLimitError" });
    await expect(service.apiRequest({ method: "GET", path: "/repos/acme/ade" }))
      .rejects.toMatchObject({
        name: "GitHubRateLimitError",
        rateLimitResetAtMs: resetAtSec * 1_000,
      });
  });

  it("retries manual-redirect requests with the next healthy credential", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    mockFetch
      .mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse(302, {}, {
        location: "https://productionresultssa.blob.core.windows.net/actions-results/job.zip",
      }));
    const service = makeService({
      credentialStore,
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    });

    const response = await service.requestRawWithCredentialFallback({
      url: "https://api.github.com/repos/acme/ade/actions/jobs/123/logs",
      method: "GET",
      headers: { accept: "application/vnd.github+json" },
      redirect: "manual",
      capability: "read",
      repo: { owner: "acme", name: "ade" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("actions-results/job.zip");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe("Bearer ghu_app_user_token");
    expect(new Headers(mockFetch.mock.calls[1]?.[1]?.headers).get("authorization"))
      .toBe("Bearer gho_cli_token");
    expect(mockFetch.mock.calls[1]?.[1]?.redirect).toBe("manual");
    await response.text();
  });

  it("does not mark a repository accessible after a raw server error", async () => {
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    mockFetch.mockResolvedValueOnce(jsonResponse(503, { message: "Service unavailable" }));
    const repo = { owner: "acme", name: "ade" };
    const candidate = {
      source: "app" as const,
      token: "ghu_app_user_token",
      capabilities: ["read"] as const,
    };

    const response = await makeService({ credentialStore }).requestRawWithCredentialFallback({
      url: "https://api.github.com/repos/acme/ade/actions/jobs/123/logs",
      redirect: "manual",
      repo,
    });

    expect(response.status).toBe(503);
    expect(githubCredentialRepositoryAccess(candidate, repo)).toBeNull();
    await response.text();
  });

  it.each([
    {
      name: "when GitHub also returns a primary reset",
      headers: {
        "retry-after": "30",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "2000000000",
      },
    },
    {
      name: "when GitHub only returns Retry-After",
      headers: {
        "retry-after": "30",
      },
    },
  ] as Array<{ name: string; headers: Record<string, string> }>)(
    "uses Retry-After for secondary rate limits $name",
    async ({ headers }) => {
      const nowMs = Date.parse("2026-07-27T18:00:00.000Z");
      vi.spyOn(Date, "now").mockReturnValue(nowMs);
      mockFetch.mockResolvedValueOnce(
        jsonResponse(429, { message: "Too many requests" }, headers),
      );

      const service = makeService();
      let thrownError: any;
      try {
        await service.apiRequest({ method: "GET", path: "/repos/o/r", token: "ghp_test123" });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(Error);
      expect(thrownError.rateLimitResetAtMs).toBe(nowMs + 30_000);
    },
  );

  it("falls back to generic HTTP message when response body has no message field", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(500, { unexpected: true }));

    const service = makeService();
    await expect(
      service.apiRequest({ method: "GET", path: "/test", token: "ghp_test123" }),
    ).rejects.toThrow("GitHub API request failed (HTTP 500)");
  });

  it("ignores errors array entries without a string message", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        message: "Validation Failed",
        errors: [{ code: "custom" }, { message: "real error" }, { message: 42 }],
      }),
    );

    const service = makeService();
    await expect(
      service.apiRequest({ method: "POST", path: "/repos/o/r/pulls", token: "ghp_test123" }),
    ).rejects.toThrow("Validation Failed: real error");
  });

  it("throws when no token is provided and none is stored", async () => {
    const service = makeService();
    await expect(
      service.apiRequest({ method: "GET", path: "/test" }),
    ).rejects.toThrow("GitHub auth missing");
  });

  it("uses the shared machine credential store token when present", async () => {
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.token.v1", "ghp_machine_token");
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const service = makeService({ credentialStore });
    await service.apiRequest({ method: "GET", path: "/test" });

    const [, init] = mockFetch.mock.calls.at(-1) as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghp_machine_token");
  });

  it("falls back when GraphQL reports a rate limit in an HTTP 200 response", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    const resetAt = Math.floor(Date.now() / 1_000) + 3600;
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, {
        data: null,
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
      }, {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetAt),
        "x-ratelimit-resource": "graphql",
      }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { viewer: { login: "alice" } } }));

    const result = await makeService({
      credentialStore,
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    }).apiRequest<{ data: { viewer: { login: string } } }>({
      method: "POST",
      path: "/graphql",
      capability: "read",
      body: { query: "query { viewer { login } }" },
    });

    expect(result.data.data.viewer.login).toBe("alice");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect((mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer ghu_app_user_token");
    expect((mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer gho_cli_token");
  });

  it("falls back for repository NOT_FOUND and skips the known-negative credential", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    const fallbackData = { data: { repository: { name: "ade" } } };
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, {
        data: { repository: null },
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository with the name 'ade'." }],
      }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { repository: { name: "ade" } } }))
      .mockResolvedValueOnce(jsonResponse(200, fallbackData));
    const service = makeService({
      credentialStore,
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    });

    await expect(service.apiRequest({
      method: "POST",
      path: "/graphql",
      capability: "read",
      repo: { owner: "acme", name: "ade" },
      body: { query: "query { repository(owner: \"acme\", name: \"ade\") { name } }" },
    })).resolves.toMatchObject({ data: { data: { repository: { name: "ade" } } } });
    await expect(service.apiRequest({
      method: "POST",
      path: "/graphql",
      capability: "read",
      repo: { owner: "acme", name: "ade" },
      body: { query: "query { repository(owner: \"acme\", name: \"ade\") { name } }" },
    })).resolves.toMatchObject({ data: fallbackData });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect((mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer ghu_app_user_token");
    expect((mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer gho_cli_token");
    expect((mockFetch.mock.calls[2]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer gho_cli_token");
  });

  it("retries partial credential errors for GraphQL reads", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, {
        data: { repository: { name: "ade" } },
        errors: [{ type: "FORBIDDEN", message: "One field is not accessible" }],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        data: { repository: { name: "ade", mergeQueue: { entries: [] } } },
      }));

    const result = await makeService({
      credentialStore,
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    }).apiRequest({
      method: "POST",
      path: "/graphql",
      capability: "read",
      repo: { owner: "acme", name: "ade" },
      body: { query: "query { repository(owner: \"acme\", name: \"ade\") { name } }" },
    });

    expect(result.data).toEqual({
      data: { repository: { name: "ade", mergeQueue: { entries: [] } } },
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect((mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer gho_cli_token");
  });

  it("does not replay GraphQL mutations after a partial credential error", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    process.env.GITHUB_TOKEN = "ghp_environment_token";
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {
      data: { updatePullRequest: { pullRequest: { id: "PR_1" } } },
      errors: [{ type: "FORBIDDEN", message: "One field is not accessible" }],
    }));

    await expect(makeService({
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    }).apiRequest({
      method: "POST",
      path: "/graphql",
      capability: "write",
      body: { query: "mutation { updatePullRequest(input: {}) { pullRequest { id } } }" },
    })).rejects.toThrow("One field is not accessible");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer ghp_environment_token");
  });

  it("falls back for zero-data repository-scoped GraphQL mutations", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    process.env.GITHUB_TOKEN = "ghp_environment_token";
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, {
        data: null,
        errors: [{ type: "FORBIDDEN", message: "Repository write is not accessible" }],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        data: { resolveReviewThread: { thread: { isResolved: true } } },
      }));
    const service = makeService({
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    });

    await expect(service.apiRequest({
      method: "POST",
      path: "/graphql",
      capability: "write",
      repo: { owner: "acme", name: "ade" },
      body: { query: "mutation { resolveReviewThread(input: {}) { thread { isResolved } } }" },
    })).resolves.toMatchObject({
      data: { data: { resolveReviewThread: { thread: { isResolved: true } } } },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe("Bearer ghp_environment_token");
    expect(new Headers(mockFetch.mock.calls[1]?.[1]?.headers).get("authorization"))
      .toBe("Bearer gho_cli_token");
  });

  it("falls back on repository-scoped 404s without retrying unrelated 404s", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    mockFetch
      .mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse(200, [{ id: 1 }]))
      .mockResolvedValueOnce(jsonResponse(200, [{ number: 2 }]))
      .mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }));
    const service = makeService({
      credentialStore,
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    });

    await expect(service.apiRequest({ method: "GET", path: "/repos/acme/ade/issues" }))
      .resolves.toMatchObject({ data: [{ id: 1 }] });
    await expect(service.apiRequest({ method: "GET", path: "/repos/acme/ade/pulls" }))
      .resolves.toMatchObject({ data: [{ number: 2 }] });
    await expect(service.apiRequest({ method: "GET", path: "/user/emails" }))
      .rejects.toThrow("Not Found");

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect((mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer ghu_app_user_token");
    expect((mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer gho_cli_token");
    expect((mockFetch.mock.calls[2]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer ghu_app_user_token");
    expect((mockFetch.mock.calls[3]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer ghu_app_user_token");
  });

  it("does not fan out a nested 404 after repository access is known", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, { full_name: "acme/ade" }))
      .mockResolvedValueOnce(jsonResponse(404, { message: "Issue not found" }));
    const service = makeService({
      credentialStore,
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    });

    await expect(service.apiRequest({ method: "GET", path: "/repos/acme/ade" }))
      .resolves.toMatchObject({ data: { full_name: "acme/ade" } });
    await expect(service.apiRequest({ method: "GET", path: "/repos/acme/ade/issues/404" }))
      .rejects.toThrow("Issue not found");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect((mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer ghu_app_user_token");
  });

  it("skips the read-only GitHub App for write requests", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await makeService({
      credentialStore,
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    }).apiRequest({ method: "POST", path: "/repos/acme/ade/issues", body: { title: "Test" } });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer gho_cli_token");
  });

  it("keeps conditional response data isolated by credential", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, { value: "first" }, { etag: '"first"' }))
      .mockResolvedValueOnce(jsonResponse(200, { value: "second" }, { etag: '"second"' }))
      .mockResolvedValueOnce(jsonResponse(304, {}));
    const service = makeService();

    await service.apiRequest({ method: "GET", path: "/repos/acme/ade", token: "ghp_first" });
    await service.apiRequest({ method: "GET", path: "/repos/acme/ade", token: "ghp_second" });
    const firstAgain = await service.apiRequest<{ value: string }>({
      method: "GET",
      path: "/repos/acme/ade",
      token: "ghp_first",
    });

    expect(mockFetch.mock.calls[1]?.[1]?.headers).not.toMatchObject({ "if-none-match": '"first"' });
    expect(mockFetch.mock.calls[2]?.[1]?.headers).toMatchObject({ "if-none-match": '"first"' });
    expect(firstAgain.data).toEqual({ value: "first" });
  });

  it("stores and clears GitHub PATs in the shared machine credential store", () => {
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.token.v1", "ghp_old_token");
    const service = makeService({ credentialStore });
    const environment = {
      source: "environment" as const,
      token: "ghp_environment_token",
      capabilities: ["read", "write"] as const,
    };
    const oldPat = {
      source: "pat" as const,
      token: "ghp_old_token",
      capabilities: ["read", "write"] as const,
    };
    const newPat = {
      source: "pat" as const,
      token: "ghp_saved_token",
      capabilities: ["read", "write"] as const,
    };
    const invalid = { kind: "invalid_token" as const, message: "Bad credentials", retryAt: null };
    recordGithubCredentialFailure(environment, invalid, null);
    recordGithubCredentialFailure(oldPat, invalid, null);
    recordGithubCredentialFailure(newPat, invalid, null);

    service.setToken("ghp_saved_token");
    expect(credentialStore.getSync("github.token.v1")).toBe("ghp_saved_token");
    expect(githubCredentialCooldown(oldPat)).toBeNull();
    expect(githubCredentialCooldown(newPat)).toBeNull();
    expect(githubCredentialCooldown(environment)).not.toBeNull();

    recordGithubCredentialFailure(newPat, invalid, null);
    service.clearToken();
    expect(credentialStore.getSync("github.token.v1")).toBeNull();
    expect(githubCredentialCooldown(newPat)).toBeNull();
    expect(githubCredentialCooldown(environment)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue-domain helpers (used by automations polling + issue-action registry)
// ---------------------------------------------------------------------------

describe("githubService issue-domain helpers", () => {
  beforeEach(() => {
    resetMocks();
    process.env.GITHUB_TOKEN = "ghp_env_token";
  });

  function lastFetchCall() {
    const calls = mockFetch.mock.calls;
    return calls[calls.length - 1] as [string, RequestInit];
  }

  it("listRepoIssues builds the correct URL with state/sort/per_page and optional since", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    const service = makeService();

    await service.listRepoIssues("acme", "ade", {
      state: "open",
      sort: "created",
      since: "2026-04-23T10:00:00Z",
    });

    const [url, init] = lastFetchCall();
    expect(url).toContain("/repos/acme/ade/issues");
    expect(url).toContain("state=open");
    expect(url).toContain("sort=created");
    expect(url).toContain("per_page=50");
    // `since` is URL-encoded — colons become %3A.
    expect(url).toMatch(/since=2026-04-23T10%3A00%3A00Z/);
    expect(init.method).toBe("GET");
  });

  it("listRepoIssues defaults state=all/sort=updated/perPage=50 and omits since", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    const service = makeService();

    await service.listRepoIssues("acme", "ade");

    const [url] = lastFetchCall();
    expect(url).toContain("state=all");
    expect(url).toContain("sort=updated");
    expect(url).toContain("per_page=50");
    expect(url).not.toContain("since=");
  });

  it("listRepoIssues returns [] when the API returns a non-array payload", async () => {
    // Defensive: GitHub might return an error envelope we don't recognize.
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { message: "huh" }));
    const service = makeService();

    const result = await service.listRepoIssues("acme", "ade");

    expect(result).toEqual([]);
  });

  it("listRepoIssues follows GitHub pagination links", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, [{ number: 1 }], {
        link: '<https://api.github.com/repos/acme/ade/issues?page=2&per_page=1>; rel="next"',
      }))
      .mockResolvedValueOnce(jsonResponse(200, [{ number: 2 }]));
    const service = makeService();

    const result = await service.listRepoIssues("acme", "ade", { perPage: 1 });

    expect(result.map((issue) => issue.number)).toEqual([1, 2]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]?.[0]).toContain("page=2");
  });

  it("listRepoPulls builds the correct URL with direction=desc", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    const service = makeService();

    await service.listRepoPulls("acme", "ade", { state: "open", sort: "created" });

    const [url] = lastFetchCall();
    expect(url).toContain("/repos/acme/ade/pulls");
    expect(url).toContain("state=open");
    expect(url).toContain("sort=created");
    expect(url).toContain("direction=desc");
  });

  it("listPullRequestReviews reads PR reviews with per_page=100", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [{ id: 1, state: "APPROVED" }]));
    const service = makeService();

    const result = await service.listPullRequestReviews("acme", "ade", 42);

    const [url, init] = lastFetchCall();
    expect(url).toContain("/repos/acme/ade/pulls/42/reviews");
    expect(url).toContain("per_page=100");
    expect(init.method).toBe("GET");
    expect(result).toEqual([{ id: 1, state: "APPROVED" }]);
  });

  it("listIssueComments includes since when provided, omits it otherwise", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    const service = makeService();
    await service.listIssueComments("acme", "ade", 42, { since: "2026-04-23T00:00:00Z" });
    expect(lastFetchCall()[0]).toMatch(/since=2026-04-23T00%3A00%3A00Z/);

    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    await service.listIssueComments("acme", "ade", 42);
    expect(lastFetchCall()[0]).not.toContain("since=");
  });

  it("addIssueComment POSTs to /issues/:n/comments with a JSON body", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: 1, body: "hello" }));
    const service = makeService();

    const result = await service.addIssueComment("acme", "ade", 42, "hello");

    const [url, init] = lastFetchCall();
    expect(url).toContain("/repos/acme/ade/issues/42/comments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ body: "hello" });
    expect(result).toEqual({ id: 1, body: "hello" });
  });

  it("setIssueLabels PUTs a labels array, replacing the existing labels", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [{ name: "triage" }, { name: "bug" }]));
    const service = makeService();

    const result = await service.setIssueLabels("acme", "ade", 42, ["triage", "bug"]);

    const [url, init] = lastFetchCall();
    expect(url).toContain("/repos/acme/ade/issues/42/labels");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ labels: ["triage", "bug"] });
    expect(result).toHaveLength(2);
  });

  it("closeIssue PATCHes state=closed and attaches state_reason when given", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { number: 42, state: "closed" }));
    const service = makeService();

    await service.closeIssue("acme", "ade", 42, "not_planned");

    const [url, init] = lastFetchCall();
    expect(url).toContain("/repos/acme/ade/issues/42");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ state: "closed", state_reason: "not_planned" });
  });

  it("closeIssue omits state_reason when no reason is provided", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { number: 42, state: "closed" }));
    const service = makeService();

    await service.closeIssue("acme", "ade", 42);

    const [, init] = lastFetchCall();
    expect(JSON.parse(init.body as string)).toEqual({ state: "closed" });
  });

  it("reopenIssue PATCHes state=open", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { number: 42, state: "open" }));
    const service = makeService();

    await service.reopenIssue("acme", "ade", 42);

    const [url, init] = lastFetchCall();
    expect(url).toContain("/repos/acme/ade/issues/42");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ state: "open" });
  });

  it("assignIssue POSTs to /issues/:n/assignees with the assignees array", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { number: 42 }));
    const service = makeService();

    await service.assignIssue("acme", "ade", 42, ["alice", "bob"]);

    const [url, init] = lastFetchCall();
    expect(url).toContain("/repos/acme/ade/issues/42/assignees");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ assignees: ["alice", "bob"] });
  });

  it("setIssueTitle PATCHes just the title field", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { number: 42, title: "New" }));
    const service = makeService();

    await service.setIssueTitle("acme", "ade", 42, "New");

    const [, init] = lastFetchCall();
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ title: "New" });
  });

  it("getIssue returns null on 404 rather than throwing", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }));
    const service = makeService();

    const result = await service.getIssue("acme", "ade", 42);

    expect(result).toBeNull();
  });

  it("getIssue returns the issue payload on success", async () => {
    const payload = { number: 42, title: "Shipped", state: "open" };
    mockFetch.mockResolvedValueOnce(jsonResponse(200, payload));
    const service = makeService();

    const result = await service.getIssue("acme", "ade", 42);

    expect(result).toEqual(payload);
  });

  it("listRepoLabels and listRepoCollaborators page through all GitHub pages", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, [{ name: "bug" }], {
        link: '<https://api.github.com/repos/acme/ade/labels?per_page=100&page=2>; rel="next"',
      }))
      .mockResolvedValueOnce(jsonResponse(200, [{ name: "triage" }]));
    const service = makeService();
    const labels = await service.listRepoLabels("acme", "ade");
    expect(labels.map((label) => label.name)).toEqual(["bug", "triage"]);
    expect(mockFetch.mock.calls[0]?.[0]).toMatch(/per_page=100/);
    expect(mockFetch.mock.calls[1]?.[0]).toMatch(/page=2/);

    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, [{ login: "alice" }], {
        link: '<https://api.github.com/repos/acme/ade/collaborators?per_page=100&page=2>; rel="next"',
      }))
      .mockResolvedValueOnce(jsonResponse(200, [{ login: "bob" }]));
    const collaborators = await service.listRepoCollaborators("acme", "ade");
    expect(collaborators.map((user) => user.login)).toEqual(["alice", "bob"]);
    expect(mockFetch.mock.calls[2]?.[0]).toMatch(/per_page=100/);
    expect(lastFetchCall()[0]).toMatch(/page=2/);
  });

  it("lists and creates repository autolinks", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, [{
        id: 1,
        key_prefix: "ADE-",
        url_template: "https://linear.app/acme/issue/ADE-<num>",
        is_alphanumeric: false,
      }]))
      .mockResolvedValueOnce(jsonResponse(201, {
        id: 2,
        key_prefix: "ADEPR-",
        url_template: "https://ade-app.dev/open?number=<num>",
        is_alphanumeric: false,
      }));
    const service = makeService();

    await expect(service.listRepoAutolinks("acme", "ade")).resolves.toEqual([{
      id: 1,
      keyPrefix: "ADE-",
      urlTemplate: "https://linear.app/acme/issue/ADE-<num>",
      isAlphanumeric: false,
    }]);
    await expect(service.createRepoAutolink("acme", "ade", {
      keyPrefix: "ADEPR-",
      urlTemplate: "https://ade-app.dev/open?number=<num>",
      isAlphanumeric: false,
    })).resolves.toEqual({
      id: 2,
      keyPrefix: "ADEPR-",
      urlTemplate: "https://ade-app.dev/open?number=<num>",
      isAlphanumeric: false,
    });
    expect(mockFetch.mock.calls[0]?.[0]).toMatch(/\/repos\/acme\/ade\/autolinks/);
    const [, init] = lastFetchCall();
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      key_prefix: "ADEPR-",
      url_template: "https://ade-app.dev/open?number=<num>",
      is_alphanumeric: false,
    });
  });

  it("keeps following cached pagination links when a page returns 304", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, [{ number: 1 }], {
        etag: '"page-1"',
        link: '<https://api.github.com/repos/acme/ade/issues?page=2&per_page=1>; rel="next"',
      }))
      .mockResolvedValueOnce(jsonResponse(200, [{ number: 2 }], { etag: '"page-2"' }))
      .mockResolvedValueOnce(jsonResponse(304, {}))
      .mockResolvedValueOnce(jsonResponse(304, {}));
    const service = makeService();

    expect((await service.listRepoIssues("acme", "ade", { perPage: 1 })).map((issue) => issue.number)).toEqual([1, 2]);
    expect((await service.listRepoIssues("acme", "ade", { perPage: 1 })).map((issue) => issue.number)).toEqual([1, 2]);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls[2]?.[1]?.headers).toMatchObject({ "if-none-match": '"page-1"' });
    expect(mockFetch.mock.calls[3]?.[0]).toContain("page=2");
  });

  it("does not evict an ETag cache entry while its conditional request is in flight", async () => {
    const service = makeService();
    let protectedCalls = 0;
    let resolveProtected304: ((response: Response) => void) | null = null;
    mockFetch.mockImplementation((rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.pathname === "/protected") {
        protectedCalls += 1;
        if (protectedCalls === 1) {
          return Promise.resolve(jsonResponse(200, { value: "cached" }, { etag: '"protected"' }));
        }
        return new Promise<Response>((resolve) => {
          resolveProtected304 = resolve;
        });
      }
      return Promise.resolve(jsonResponse(200, { value: url.pathname }, { etag: `"${url.pathname}"` }));
    });

    await service.apiRequest({ method: "GET", path: "/protected", token: "ghp_test123" });
    const conditional = service.apiRequest<{ value: string }>({
      method: "GET",
      path: "/protected",
      token: "ghp_test123",
    });
    await Promise.resolve();

    for (let i = 0; i < 205; i += 1) {
      await service.apiRequest({ method: "GET", path: `/repos/acme/repo/issues/${i}`, token: "ghp_test123" });
    }

    const protected304Resolver = resolveProtected304 as ((response: Response) => void) | null;
    if (!protected304Resolver) {
      throw new Error("Expected protected conditional request to be in flight");
    }
    protected304Resolver(jsonResponse(304, {}));

    await expect(conditional).resolves.toMatchObject({ data: { value: "cached" } });
  });

  it("retries an uncached 304 response without a conditional header", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(304, {}))
      .mockResolvedValueOnce(jsonResponse(200, { value: "fresh" }));
    const service = makeService();

    await expect(service.apiRequest({ method: "GET", path: "/uncached", token: "ghp_test123" }))
      .resolves.toMatchObject({ data: { value: "fresh" } });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]?.[1]?.headers).not.toMatchObject({ "if-none-match": expect.anything() });
    expect(mockFetch.mock.calls[1]?.[1]?.headers).not.toMatchObject({ "if-none-match": expect.anything() });
  });

  it("URL-encodes owner/name so special characters don't break the path", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    const service = makeService();

    await service.listRepoIssues("scary owner", "name with space");

    const [url] = lastFetchCall();
    expect(url).toContain("/repos/scary%20owner/name%20with%20space/issues");
  });
});

// ---------------------------------------------------------------------------
// getStatus — connection probing (regression for false-CONNECTED bug)
// ---------------------------------------------------------------------------

describe("githubService.getStatus", () => {
  beforeEach(() => {
    resetMocks();
    delete process.env.GITHUB_TOKEN;
    delete process.env.ADE_GITHUB_TOKEN;
  });

  // Mocks `git remote get-url origin` so detectRepo returns acme/ade.
  function stubOriginRemote() {
    runGitMock.mockResolvedValue({
      exitCode: 0,
      stdout: "git@github.com:acme/ade.git\n",
      stderr: "",
    });
  }

  it("keeps repo-capable classic tokens connected while withholding write access", async () => {
    stubOriginRemote();
    process.env.GITHUB_TOKEN = "ghp_classic";
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { login: "alice" }, { "x-oauth-scopes": "repo" }),
    );
    const status = await makeService().getStatus();

    expect(status.tokenStored).toBe(true);
    expect(status.authSource).toBe("environment");
    expect(status.tokenType).toBe("classic");
    expect(status.userLogin).toBe("alice");
    expect(status.scopes).toEqual(["repo"]);
    expect(status.repoAccessOk).toBeNull();
    expect(status.connected).toBe(true);
    expect(status.writeAuthSource).toBe("none");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("uses the GitHub App for reads but reports write access missing when it is the only credential", async () => {
    stubOriginRemote();
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, { login: "alice" }))
      .mockResolvedValueOnce(jsonResponse(200, { full_name: "acme/ade" }));
    const service = makeService({ credentialStore });
    const status = await service.getStatus();

    expect(status).toMatchObject({
      authSource: "app",
      writeAuthSource: "none",
      connected: true,
      patTokenStored: false,
      repoAccessOk: true,
      userLogin: "alice",
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await expect(service.getTokenOrThrowAsync()).rejects.toThrow("GitHub write access is unavailable");
    await expect(service.getReadTokenOrThrowAsync()).resolves.toBe("ghu_app_user_token");
  });

  it("does not advertise an unvalidated lower-precedence write credential", async () => {
    stubOriginRemote();
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, { login: "alice" }))
      .mockResolvedValueOnce(jsonResponse(200, { full_name: "acme/ade" }))
      .mockResolvedValueOnce(jsonResponse(401, { message: "Bad credentials" }));

    const status = await makeService({
      credentialStore,
      ghAuthTokenProvider: () => ({
        token: "gho_invalid_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    }).getStatus();

    expect(status).toMatchObject({
      authSource: "app",
      writeAuthSource: "none",
      connected: true,
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("reports an exhausted GitHub API quota as rate limited instead of missing permissions", async () => {
    stubOriginRemote();
    process.env.GITHUB_TOKEN = "ghp_classic";
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        403,
        { message: "API rate limit exceeded for user ID 123." },
        {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-used": "5000",
          "x-ratelimit-reset": "1785179433",
          "x-ratelimit-resource": "core",
        },
      ),
    );

    const status = await makeService().getStatus();

    expect(status.tokenStored).toBe(true);
    expect(status.authSource).toBe("environment");
    expect(status.authFailure).toEqual({
      kind: "rate_limited",
      message: "API rate limit exceeded for user ID 123.",
      retryAt: "2026-07-27T19:10:33.000Z",
    });
    expect(status.rateLimit).toEqual({
      limit: 5000,
      remaining: 0,
      used: 5000,
      resetAt: "2026-07-27T19:10:33.000Z",
      resource: "core",
    });
    expect(status.userLogin).toBeNull();
    expect(status.scopes).toEqual([]);
    expect(status.connected).toBe(false);
  });

  it("classifies a headerless HTTP 429 as rate limited", async () => {
    stubOriginRemote();
    process.env.GITHUB_TOKEN = "ghp_classic";
    mockFetch.mockResolvedValueOnce(jsonResponse(429, {}));

    const status = await makeService().getStatus();

    expect(status.authFailure).toEqual({
      kind: "rate_limited",
      message: "GitHub token validation failed (HTTP 429)",
      retryAt: null,
    });
    expect(status.rateLimit).toBeNull();
    expect(status.connected).toBe(false);
  });

  it("falls back to gh auth when no PAT or env token is configured", async () => {
    stubOriginRemote();
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const ghAuthTokenProvider = vi.fn(() => ({
      token: "gho_cli_token",
      ghCliPath: "/opt/homebrew/bin/gh",
      ghAuthError: null,
    }));
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { login: "alice" }, { "x-oauth-scopes": "repo, workflow" }),
    );

    const status = await makeService({ ghAuthTokenProvider }).getStatus();

    expect(ghAuthTokenProvider).toHaveBeenCalled();
    expect(status.tokenStored).toBe(true);
    expect(status.patTokenStored).toBe(false);
    expect(status.authSource).toBe("gh");
    expect(status.tokenType).toBe("oauth");
    expect(status.ghCliPath).toBe("/opt/homebrew/bin/gh");
    expect(status.scopes).toEqual(["repo", "workflow"]);
    expect(status.connected).toBe(true);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer gho_cli_token");
  });

  it("reads a cached hosts.yml token synchronously before async status warmup", () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    process.env.GH_CONFIG_DIR = "/tmp/gh-fresh-sync-token";
    vi.mocked(fs.readFileSync).mockImplementationOnce(((filePath: fs.PathOrFileDescriptor) => {
      if (String(filePath).endsWith("hosts.yml")) {
        return "github.com:\n    user: alice\n    oauth_token: gho_hosts_fresh\n";
      }
      return Buffer.from("encrypted");
    }) as typeof fs.readFileSync);

    expect(makeService().getTokenOrThrow()).toBe("gho_hosts_fresh");
    expect(makeService().getTokenOrThrow()).toBe("gho_hosts_fresh");
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    delete process.env.GH_CONFIG_DIR;
  });

  it("does not read or reuse hosts.yml auth when gh fallback is disabled", () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    process.env.GH_CONFIG_DIR = `/tmp/gh-disabled-sync-token-${Date.now()}`;
    vi.mocked(fs.readFileSync).mockImplementation(((filePath: fs.PathOrFileDescriptor) => {
      if (String(filePath).endsWith("hosts.yml")) {
        return "github.com:\n    user: alice\n    oauth_token: gho_hosts_disabled\n";
      }
      return Buffer.from("encrypted");
    }) as typeof fs.readFileSync);

    expect(makeService().getTokenOrThrow()).toBe("gho_hosts_disabled");
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    process.env.ADE_DISABLE_GH_AUTH_FALLBACK = "1";
    vi.mocked(fs.readFileSync).mockClear();

    expect(() => makeService().getTokenOrThrow()).toThrow("GitHub auth missing");
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it("bounds the process-wide hosts.yml token cache", () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const prefix = `/tmp/gh-bounded-token-cache-${Date.now()}`;
    vi.mocked(fs.readFileSync).mockImplementation(((filePath: fs.PathOrFileDescriptor) => {
      if (String(filePath).endsWith("hosts.yml")) {
        return "github.com:\n    user: alice\n    oauth_token: gho_hosts_bounded\n";
      }
      return Buffer.from("encrypted");
    }) as typeof fs.readFileSync);

    for (let index = 0; index <= 32; index += 1) {
      process.env.GH_CONFIG_DIR = `${prefix}-${index}`;
      expect(makeService().getTokenOrThrow()).toBe("gho_hosts_bounded");
    }
    expect(fs.readFileSync).toHaveBeenCalledTimes(33);

    process.env.GH_CONFIG_DIR = `${prefix}-0`;
    expect(makeService().getTokenOrThrow()).toBe("gho_hosts_bounded");
    expect(fs.readFileSync).toHaveBeenCalledTimes(34);
    delete process.env.GH_CONFIG_DIR;
  });

  it("awaits keyring-backed gh auth when no synchronous hosts token exists", async () => {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    let resolveAuth!: (value: { token: string; ghCliPath: string; ghAuthError: null }) => void;
    const ghAuthTokenProvider = vi.fn(() => new Promise<{
      token: string;
      ghCliPath: string;
      ghAuthError: null;
    }>((resolve) => {
      resolveAuth = resolve;
    }));
    const first = makeService({ ghAuthTokenProvider });
    const second = makeService({ ghAuthTokenProvider });

    const firstToken = first.getTokenOrThrowAsync();
    const secondToken = second.getTokenOrThrowAsync();
    await Promise.resolve();
    expect(ghAuthTokenProvider).toHaveBeenCalledTimes(1);

    resolveAuth({
      token: "gho_keyring_token",
      ghCliPath: "/opt/homebrew/bin/gh",
      ghAuthError: null,
    });
    await expect(firstToken).resolves.toBe("gho_keyring_token");
    await expect(secondToken).resolves.toBe("gho_keyring_token");
  });

  it("retries transient status failures after a short shared cooldown", async () => {
    stubOriginRemote();
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const baseNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseNow);
    let resolveAuth!: (value: { token: string; ghCliPath: string; ghAuthError: null }) => void;
    const ghAuthTokenProvider = vi.fn(() => new Promise<{
      token: string;
      ghCliPath: string;
      ghAuthError: null;
    }>((resolve) => {
      resolveAuth = resolve;
    }));
    mockFetch.mockImplementation(async (input: string | URL) => {
      if (String(input).endsWith("/user")) {
        return jsonResponse(200, { login: "alice" });
      }
      const timeout = new Error("request timed out");
      timeout.name = "AbortError";
      throw timeout;
    });
    const first = makeService({ ghAuthTokenProvider });
    const second = makeService({ ghAuthTokenProvider });

    const firstStatus = first.getStatus();
    const secondStatus = second.getStatus();
    await Promise.resolve();
    expect(ghAuthTokenProvider).toHaveBeenCalledTimes(1);

    const resolvedAuth = {
      token: "github_pat_shared_slow_token",
      ghCliPath: "/opt/homebrew/bin/gh",
      ghAuthError: null as null,
    };
    resolveAuth(resolvedAuth);
    ghAuthTokenProvider.mockResolvedValue(resolvedAuth);
    const statuses = await Promise.all([firstStatus, secondStatus]);
    expect(statuses.map((status) => status.repoAccessOk)).toEqual([null, null]);
    expect(statuses.map((status) => status.authFailure?.kind)).toEqual(["network", "network"]);
    expect(mockFetch).toHaveBeenCalledTimes(2); // one /user + one repo probe total

    now.mockReturnValue(baseNow + 31_000);
    const third = await makeService({ ghAuthTokenProvider }).getStatus();
    expect(third.repoAccessOk).toBeNull();
    expect(third.authFailure?.kind).toBe("network");
    expect(ghAuthTokenProvider).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    now.mockRestore();
  });

  it("does not reuse a project-local status after the shared gh token changes", async () => {
    stubOriginRemote();
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    let token = "gho_shared_token_alice";
    const ghAuthTokenProvider = vi.fn(async () => ({
      token,
      ghCliPath: "/opt/homebrew/bin/gh",
      ghAuthError: null,
    }));
    mockFetch.mockImplementation(async (_input: string | URL, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
      return jsonResponse(200, {
        login: authorization.includes("gho_shared_token_bob") ? "bob" : "alice",
      });
    });
    const first = makeService({ ghAuthTokenProvider });
    const second = makeService({ ghAuthTokenProvider });

    await expect(first.getStatus()).resolves.toMatchObject({ userLogin: "alice" });
    token = "gho_shared_token_bob";
    await expect(second.getStatus({ forceRefresh: true })).resolves.toMatchObject({ userLogin: "bob" });
    await expect(first.getStatus()).resolves.toMatchObject({ userLogin: "bob" });

    expect(ghAuthTokenProvider).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("force-refreshes a hosts.yml token instead of reusing the process cache", async () => {
    stubOriginRemote();
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    process.env.GH_CONFIG_DIR = `/tmp/gh-force-refresh-token-${Date.now()}`;
    let hostsToken = "gho_hosts_alice";
    vi.mocked(fs.readFileSync).mockImplementation(((filePath: fs.PathOrFileDescriptor) => {
      if (String(filePath).endsWith("hosts.yml")) {
        return `github.com:\n    user: alice\n    oauth_token: ${hostsToken}\n`;
      }
      return Buffer.from("encrypted");
    }) as typeof fs.readFileSync);
    mockFetch.mockImplementation(async (_input: string | URL, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
      return jsonResponse(
        200,
        { login: authorization.includes("gho_hosts_bob") ? "bob" : "alice" },
        { "x-oauth-scopes": "repo, workflow" },
      );
    });
    const service = makeService();

    await expect(service.getStatus()).resolves.toMatchObject({ userLogin: "alice" });
    hostsToken = "gho_hosts_bob";
    await expect(service.getStatus({ forceRefresh: true })).resolves.toMatchObject({ userLogin: "bob" });

    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect((mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer gho_hosts_bob");
  });

  it("lets a forced status refresh retry a credential after a permission failure", async () => {
    stubOriginRemote();
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    process.env.GITHUB_TOKEN = "ghp_environment_token";
    mockFetch
      .mockResolvedValueOnce(jsonResponse(403, { message: "Resource not accessible" }))
      .mockResolvedValueOnce(jsonResponse(
        200,
        { login: "fallback-user" },
        { "x-oauth-scopes": "repo, workflow" },
      ))
      .mockResolvedValueOnce(jsonResponse(
        200,
        { login: "environment-user" },
        { "x-oauth-scopes": "repo, workflow" },
      ));
    const service = makeService({
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      authSource: "gh",
      userLogin: "fallback-user",
    });
    await expect(service.getStatus({ forceRefresh: true })).resolves.toMatchObject({
      authSource: "environment",
      userLogin: "environment-user",
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect((mockFetch.mock.calls[2]?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer ghp_environment_token");
  });

  it("does not cache generic 403 responses as repository-specific denial", async () => {
    stubOriginRemote();
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, { login: "alice" }))
      .mockResolvedValueOnce(jsonResponse(403, {
        message: "Resource protected by organization SAML enforcement.",
      }))
      .mockResolvedValueOnce(jsonResponse(
        200,
        { login: "fallback-user" },
        { "x-oauth-scopes": "repo, workflow" },
      ))
      .mockResolvedValueOnce(jsonResponse(200, [{ id: 1 }]));
    const service = makeService({
      credentialStore,
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      authSource: "gh",
      userLogin: "fallback-user",
    });
    await expect(service.apiRequest({ method: "GET", path: "/repos/acme/ade/issues" }))
      .resolves.toMatchObject({ data: [{ id: 1 }] });

    expect(new Headers(mockFetch.mock.calls[3]?.[1]?.headers).get("authorization"))
      .toBe("Bearer ghu_app_user_token");
  });

  it("clearing a stored PAT falls back to gh auth", async () => {
    stubOriginRemote();
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.token.v1", "ghp_saved_token");
    const service = makeService({
      credentialStore,
      ghAuthTokenProvider: () => ({
        token: "gho_cli_token",
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
      }),
    });
    service.clearToken();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { login: "alice" }, { "x-oauth-scopes": "repo, workflow" }),
    );

    const status = await service.getStatus({ forceRefresh: true });

    expect(credentialStore.getSync("github.token.v1")).toBeNull();
    expect(status.authSource).toBe("gh");
    expect(status.patTokenStored).toBe(false);
    expect(status.connected).toBe(true);
  });

  it("fine-grained token that authenticates but cannot read the repo is NOT connected", async () => {
    // This is the original bug: /user works, so userLogin is set, but the
    // active repo isn't included in the token's selected repositories. Every
    // PR-tab call would 404. Status must reflect that with connected=false.
    stubOriginRemote();
    process.env.GITHUB_TOKEN = "github_pat_finegrained";
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { login: "alice" }));
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }));

    const status = await makeService().getStatus();

    expect(status.tokenType).toBe("fine-grained");
    expect(status.userLogin).toBe("alice");
    expect(status.repoAccessOk).toBe(false);
    expect(status.repoAccessError).toContain("404");
    expect(status.connected).toBe(false);
  });

  it("fine-grained token with successful repo probe is connected", async () => {
    stubOriginRemote();
    process.env.GITHUB_TOKEN = "github_pat_finegrained";
    mockFetch.mockResolvedValueOnce(jsonResponse(
      200,
      { login: "alice" },
      {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "1",
        "x-ratelimit-used": "4999",
      },
    ));
    mockFetch.mockResolvedValueOnce(jsonResponse(
      200,
      { full_name: "acme/ade" },
      {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-used": "5000",
      },
    ));

    const status = await makeService().getStatus();

    expect(status.tokenType).toBe("fine-grained");
    expect(status.repoAccessOk).toBe(true);
    expect(status.rateLimit).toEqual({
      limit: 5000,
      remaining: 0,
      used: 5000,
      resetAt: null,
      resource: null,
    });
    expect(status.connected).toBe(true);
    expect(status.writeAuthSource).toBe("environment");
  });

  it("drops a cached writer when that credential disappears", async () => {
    stubOriginRemote();
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.token.v1", "ghp_stored_token");
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "alice",
      updatedAt: new Date().toISOString(),
    }));
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, { login: "alice" }))
      .mockResolvedValueOnce(jsonResponse(200, { full_name: "acme/ade" }))
      .mockResolvedValueOnce(jsonResponse(
        200,
        { login: "alice" },
        { "x-oauth-scopes": "repo, workflow" },
      ))
      .mockResolvedValueOnce(jsonResponse(200, { login: "alice" }));
    const service = makeService({
      credentialStore,
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      authSource: "app",
      writeAuthSource: "pat",
      connected: true,
    });
    service.clearToken();
    await expect(service.getStatus()).resolves.toMatchObject({
      authSource: "app",
      writeAuthSource: "none",
      connected: true,
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("reports rate limiting during a fine-grained repo probe instead of missing repo access", async () => {
    stubOriginRemote();
    process.env.GITHUB_TOKEN = "github_pat_finegrained";
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { login: "alice" }));
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        403,
        { message: "API rate limit exceeded." },
        {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1785179433",
        },
      ),
    );

    const status = await makeService().getStatus();

    expect(status.authFailure?.kind).toBe("rate_limited");
    expect(status.authFailure?.retryAt).toBe("2026-07-27T19:10:33.000Z");
    expect(status.repoAccessOk).toBeNull();
    expect(status.repoAccessError).toBeNull();
    expect(status.connected).toBe(false);
  });

  it("classic token without required scopes is NOT connected", async () => {
    stubOriginRemote();
    process.env.GITHUB_TOKEN = "ghp_classic";
    // Token has only `read:user` (insufficient).
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { login: "alice" }, { "x-oauth-scopes": "read:user" }),
    );
    const status = await makeService().getStatus();

    expect(status.scopes).toEqual(["read:user"]);
    expect(status.connected).toBe(false);
    expect(status.repoAccessOk).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("missing token returns not-connected status with all the new fields populated", async () => {
    stubOriginRemote();
    const status = await makeService().getStatus();

    expect(status.tokenStored).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.repoAccessOk).toBeNull();
    expect(status.repoAccessError).toBeNull();
  });

  it("reports hasOrigin=true with repo=null when origin is non-GitHub or a GitHub lookalike", async () => {
    runGitMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "git@gitlab.com:acme/internal.git\n",
      stderr: "",
    });
    process.env.GITHUB_TOKEN = "ghp_classic";
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { login: "alice" }, { "x-oauth-scopes": "repo, workflow" }),
    );

    const status = await makeService().getStatus();

    expect(status.repo).toBeNull();
    expect(status.hasOrigin).toBe(true);

    runGitMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "https://notgithub.com/acme/internal.git\n",
      stderr: "",
    });
    const lookalike = await makeService().getRemoteStatus();
    expect(lookalike.repo).toBeNull();
    expect(lookalike.hasOrigin).toBe(true);
  });

  it("reports hasOrigin=false when no origin remote is configured", async () => {
    runGitMock.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "fatal: no origin" });

    const status = await makeService().getStatus();

    expect(status.repo).toBeNull();
    expect(status.hasOrigin).toBe(false);
  });

  it("reports hasOrigin=true with repo populated for GitHub origin", async () => {
    stubOriginRemote();
    process.env.GITHUB_TOKEN = "ghp_classic";
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { login: "alice" }, { "x-oauth-scopes": "repo, workflow" }),
    );
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { full_name: "acme/ade" }));

    const status = await makeService().getStatus();

    expect(status.repo).toEqual({ owner: "acme", name: "ade" });
    expect(status.hasOrigin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createRepository — POST /user/repos
// ---------------------------------------------------------------------------

describe("githubService.createRepository", () => {
  beforeEach(() => {
    resetMocks();
    process.env.GITHUB_TOKEN = "ghp_env_token";
  });

  function lastFetchCall() {
    const calls = mockFetch.mock.calls;
    return calls[calls.length - 1] as [string, RequestInit];
  }

  it("POSTs the canonical body shape and parses the response", async () => {
    mockFetch.mockResolvedValueOnce(
	      jsonResponse(201, {
	        owner: { login: "alice" },
	        name: "test",
	        full_name: "alice/test",
	        clone_url: "https://github.com/alice/test.git",
        ssh_url: "git@github.com:alice/test.git",
        html_url: "https://github.com/alice/test",
        default_branch: "main",
      }),
    );

    const result = await makeService().createRepository({
      name: "test",
      description: "hello world",
      isPrivate: true,
    });

    const [url, init] = lastFetchCall();
    expect(url).toContain("/user/repos");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "test",
      description: "hello world",
      private: true,
      auto_init: false,
    });
	    expect(result).toEqual({
	      owner: "alice",
	      name: "test",
	      fullName: "alice/test",
	      cloneUrl: "https://github.com/alice/test.git",
      sshUrl: "git@github.com:alice/test.git",
      htmlUrl: "https://github.com/alice/test",
      defaultBranch: "main",
    });
  });

  it("omits the description field when blank", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        clone_url: "https://github.com/alice/test.git",
        ssh_url: "git@github.com:alice/test.git",
        html_url: "https://github.com/alice/test",
        default_branch: "main",
      }),
    );

    await makeService().createRepository({ name: "test", isPrivate: false });

    const [, init] = lastFetchCall();
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("description");
    expect(body.private).toBe(false);
  });

  it("propagates GitHub error messages on 4xx", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        message: "Validation Failed",
        errors: [{ message: "name already exists on this account" }],
      }),
    );

    await expect(
      makeService().createRepository({ name: "existing", isPrivate: true }),
    ).rejects.toThrow(/validation failed.*already exists/i);
  });
});

describe("githubService.createSecretGist", () => {
  beforeEach(() => {
    resetMocks();
    process.env.GITHUB_TOKEN = "ghp_env_token";
  });

  function lastFetchCall() {
    const calls = mockFetch.mock.calls;
    return calls[calls.length - 1] as [string, RequestInit];
  }

  it("POSTs a secret gist with markdown files", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        id: "gist-1",
        html_url: "https://gist.github.com/alice/gist-1",
      }),
    );

    const result = await makeService().createSecretGist({
      description: "ADE transcript",
      files: {
        "README.md": { content: "# Transcript\n" },
      },
    });

    const [url, init] = lastFetchCall();
    expect(url).toContain("/gists");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      description: "ADE transcript",
      public: false,
      files: {
        "README.md": { content: "# Transcript\n" },
      },
    });
    expect(result).toEqual({
      id: "gist-1",
      htmlUrl: "https://gist.github.com/alice/gist-1",
    });
  });
});

// ---------------------------------------------------------------------------
// publishCurrentProject — orchestrates createRepo + remote add + push
// ---------------------------------------------------------------------------

describe("githubService.publishCurrentProject", () => {
  beforeEach(() => {
    resetMocks();
    process.env.GITHUB_TOKEN = "ghp_env_token";
  });

  it("returns state=pushed when HEAD exists, after creating the repo and pushing", async () => {
    runGitMock
      // get-url origin: no remote yet
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "fatal: No such remote 'origin'" })
      // remote add origin: ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      // rev-parse HEAD: ok (commit exists)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc123\n", stderr: "" })
      // push -u origin HEAD: ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

	    mockFetch.mockResolvedValueOnce(
	      jsonResponse(201, {
	        owner: { login: "alice" },
	        name: "proj",
	        full_name: "alice/proj",
	        clone_url: "https://github.com/alice/proj.git",
	        ssh_url: "git@github.com:alice/proj.git",
	        html_url: "https://github.com/alice/proj",
        default_branch: "main",
      }),
    );

    const result = await makeService().publishCurrentProject({
      name: "proj",
      isPrivate: true,
	    });

	    expect(result).toEqual({
	      state: "pushed",
	      owner: "alice",
	      name: "proj",
	      fullName: "alice/proj",
	      htmlUrl: "https://github.com/alice/proj",
	    });
	    const gitCalls = runGitMock.mock.calls.map((c) => c[0]);
	    expect(gitCalls[0]).toEqual(["remote", "get-url", "origin"]);
	    expect(gitCalls[1]).toEqual(["remote", "add", "origin", "https://github.com/alice/proj.git"]);
	    expect(gitCalls[2]).toEqual(["rev-parse", "--verify", "HEAD"]);
	    expect(gitCalls[3]).toEqual(["push", "-u", "origin", "HEAD"]);
	  });

	  it("creates a repository in the requested GitHub org", async () => {
	    runGitMock
	      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "fatal: No such remote 'origin'" })
	      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
	      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc123\n", stderr: "" })
	      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

	    // The publish path resolves the authenticated login (GET /user) so it can
	    // tell a personal account from an org owner. Here the login (`alice`)
	    // differs from the requested owner (`acme-inc`), so the org route is used.
	    mockFetch.mockImplementation((rawUrl: string) => {
	      const url = new URL(rawUrl);
	      if (url.pathname === "/user") {
	        return Promise.resolve(jsonResponse(200, { login: "alice" }));
	      }
	      return Promise.resolve(
	        jsonResponse(201, {
	          owner: { login: "acme-inc" },
	          name: "proj",
	          full_name: "acme-inc/proj",
	          clone_url: "https://github.com/acme-inc/proj.git",
	          ssh_url: "git@github.com:acme-inc/proj.git",
	          html_url: "https://github.com/acme-inc/proj",
	          default_branch: "main",
	        }),
	      );
	    });

	    const result = await makeService().publishCurrentProject({
	      owner: "acme-inc",
	      name: "proj",
	      isPrivate: true,
	    });

	    const createRepoCall = mockFetch.mock.calls.find(([rawUrl]) =>
	      String(rawUrl).includes("/repos"),
	    );
	    expect(String(createRepoCall?.[0])).toContain("/orgs/acme-inc/repos");
	    expect(result).toEqual({
	      state: "pushed",
	      owner: "acme-inc",
	      name: "proj",
	      fullName: "acme-inc/proj",
	      htmlUrl: "https://github.com/acme-inc/proj",
	    });
	    expect(runGitMock.mock.calls.map((c) => c[0])).toContainEqual([
	      "remote",
	      "add",
	      "origin",
	      "https://github.com/acme-inc/proj.git",
	    ]);
	  });

	  it("uses /user/repos when the requested owner is the authenticated user", async () => {
	    runGitMock
	      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "fatal: No such remote 'origin'" })
	      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
	      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc123\n", stderr: "" })
	      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

	    mockFetch.mockImplementation((rawUrl: string) => {
	      const url = new URL(rawUrl);
	      if (url.pathname === "/user") {
	        return Promise.resolve(jsonResponse(200, { login: "alice" }));
	      }
	      return Promise.resolve(
	        jsonResponse(201, {
	          owner: { login: "alice" },
	          name: "proj",
	          full_name: "alice/proj",
	          clone_url: "https://github.com/alice/proj.git",
	          ssh_url: "git@github.com:alice/proj.git",
	          html_url: "https://github.com/alice/proj",
	          default_branch: "main",
	        }),
	      );
	    });

	    await makeService().publishCurrentProject({
	      owner: "alice",
	      name: "proj",
	      isPrivate: true,
	    });

	    const createRepoCall = mockFetch.mock.calls.find(([rawUrl]) =>
	      String(rawUrl).includes("/repos"),
	    );
	    expect(String(createRepoCall?.[0])).toContain("/user/repos");
	    expect(String(createRepoCall?.[0])).not.toContain("/orgs/");
	  });

  it("returns state=remote_added when the project has no commits yet", async () => {
    runGitMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" }) // get-url origin
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // remote add
      .mockResolvedValueOnce({ exitCode: 128, stdout: "", stderr: "fatal: Needed a single revision" }); // rev-parse HEAD fails

	    mockFetch.mockResolvedValueOnce(
	      jsonResponse(201, {
	        owner: { login: "alice" },
	        name: "empty",
	        full_name: "alice/empty",
	        clone_url: "https://github.com/alice/empty.git",
	        ssh_url: "git@github.com:alice/empty.git",
        html_url: "https://github.com/alice/empty",
        default_branch: "main",
      }),
    );

    const result = await makeService().publishCurrentProject({
      name: "empty",
      isPrivate: true,
    });

	    expect(result).toEqual({
	      state: "remote_added",
	      owner: "alice",
	      name: "empty",
	      fullName: "alice/empty",
	      htmlUrl: "https://github.com/alice/empty",
	    });
    // Should NOT have called push
    expect(runGitMock.mock.calls.map((c) => (c[0] as string[])[0])).not.toContain("push");
  });

  it("throws remote_already_exists when origin is already configured", async () => {
    runGitMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "git@github.com:someone/already.git\n",
      stderr: "",
    });

    let caught: any;
    try {
      await makeService().publishCurrentProject({ name: "x", isPrivate: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("remote_already_exists");
    // Must NOT have hit the API
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws github_not_connected when no token is stored", async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.ADE_GITHUB_TOKEN;

    let caught: any;
    try {
      await makeService().publishCurrentProject({ name: "x", isPrivate: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("github_not_connected");
    expect(runGitMock).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("surfaces a clear error when the push step fails", async () => {
    runGitMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "Authentication failed" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // best-effort remote remove

    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        clone_url: "https://github.com/alice/proj.git",
        ssh_url: "git@github.com:alice/proj.git",
        html_url: "https://github.com/alice/proj",
        default_branch: "main",
      }),
    );

    await expect(
      makeService().publishCurrentProject({ name: "proj", isPrivate: true }),
    ).rejects.toThrow(/authentication failed/i);
  });

  it("removes the local origin when push fails so retry isn't blocked by remote_already_exists", async () => {
    runGitMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" }) // get-url origin
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // remote add origin
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc\n", stderr: "" }) // rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "fatal: auth" }) // push fails
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // remote remove origin

    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        clone_url: "https://github.com/alice/proj.git",
        ssh_url: "git@github.com:alice/proj.git",
        html_url: "https://github.com/alice/proj",
        default_branch: "main",
      }),
    );

    await expect(
      makeService().publishCurrentProject({ name: "proj", isPrivate: true }),
    ).rejects.toThrow();

    const gitCalls = runGitMock.mock.calls.map((c) => c[0]);
    expect(gitCalls).toContainEqual(["remote", "remove", "origin"]);
  });

  it("removes the local origin when remote add fails after createRepository succeeded", async () => {
    runGitMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" }) // get-url origin
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "fatal: cannot lock" }) // remote add fails
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // remote remove origin

    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        clone_url: "https://github.com/alice/proj.git",
        ssh_url: "git@github.com:alice/proj.git",
        html_url: "https://github.com/alice/proj",
        default_branch: "main",
      }),
    );

    await expect(
      makeService().publishCurrentProject({ name: "proj", isPrivate: true }),
    ).rejects.toThrow(/Failed to add origin remote/);

    const gitCalls = runGitMock.mock.calls.map((c) => c[0]);
    expect(gitCalls).toContainEqual(["remote", "remove", "origin"]);
  });

  it("recovers from 'name already exists' by reusing an empty existing repo", async () => {
    runGitMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" }) // get-url origin
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // remote add origin
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc\n", stderr: "" }) // rev-parse HEAD
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // push

    // 1) createRepository → 422 already exists
    mockFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        message: "Repository creation failed",
        errors: [{ message: "name already exists on this account" }],
      }),
    );
    // 2) validateToken /user → returns owner login
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { login: "alice" }));
    // 3) getRepository /repos/alice/proj → empty repo
	    mockFetch.mockResolvedValueOnce(
	      jsonResponse(200, {
	        owner: { login: "alice" },
	        name: "proj",
	        full_name: "alice/proj",
	        clone_url: "https://github.com/alice/proj.git",
        ssh_url: "git@github.com:alice/proj.git",
        html_url: "https://github.com/alice/proj",
        default_branch: "main",
        size: 0,
      }),
    );

    const result = await makeService().publishCurrentProject({
      name: "proj",
      isPrivate: true,
    });

	    expect(result).toEqual({
	      state: "pushed",
	      owner: "alice",
	      name: "proj",
	      fullName: "alice/proj",
	      htmlUrl: "https://github.com/alice/proj",
	    });
  });

  it("throws repo_name_taken when the existing repo has commits", async () => {
    runGitMock.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" }); // get-url origin

    mockFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        message: "Repository creation failed",
        errors: [{ message: "name already exists on this account" }],
      }),
    );
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { login: "alice" }));
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        clone_url: "https://github.com/alice/proj.git",
        html_url: "https://github.com/alice/proj",
        default_branch: "main",
        size: 1234,
      }),
    );

    let caught: any;
    try {
      await makeService().publishCurrentProject({ name: "proj", isPrivate: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("repo_name_taken");
  });
});

describe("githubService.getAppInstallationStatus", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("reports that GitHub App user authorization is required before checking the hosted relay", async () => {
    const status = await makeService().getAppInstallationStatus({ owner: "acme", name: "repo" });

    expect(status).toMatchObject({
      repo: { owner: "acme", name: "repo" },
      relayConfigured: true,
      installed: false,
      state: "error",
      error: "Authorize the ADE GitHub App with GitHub before using the hosted relay.",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not use the user's existing GitHub token for hosted relay checks", async () => {
    process.env.ADE_GITHUB_TOKEN = "ghp_user_token";

    const status = await makeService().getAppInstallationStatus({ owner: "acme", name: "repo" });

    expect(status).toMatchObject({
      repo: { owner: "acme", name: "repo" },
      relayConfigured: true,
      installed: false,
      state: "error",
      error: "Authorize the ADE GitHub App with GitHub before using the hosted relay.",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("checks the hosted relay with only the signed-in account credential", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {
      installed: true,
      state: "configured",
      installationId: 123,
      repositorySelection: "selected",
      checkedAt: "2026-06-30T00:00:01.000Z",
    }));

    const status = await makeService({
      getAccountAccessToken: async () => "clerk-account-token",
    }).getAppInstallationStatus({ owner: "acme", name: "repo" });

    expect(status.installed).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/acme/repo/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-ade-account-token": "clerk-account-token",
        }),
      }),
    );
    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("checks the hosted relay with a GitHub App user token", async () => {
    process.env.ADE_GITHUB_TOKEN = "ghp_user_token";
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: "2999-01-01T00:00:00.000Z",
      refreshToken: "ghr_refresh_token",
      refreshTokenExpiresAt: "2999-06-01T00:00:00.000Z",
      userLogin: "octocat",
      updatedAt: "2026-06-30T00:00:00.000Z",
    }));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {
      installed: true,
      state: "configured",
      installationId: 123,
      repositorySelection: "selected",
      lastSeenAt: "2026-06-30T00:00:00.000Z",
      checkedAt: "2026-06-30T00:00:01.000Z",
    }));

    const status = await makeService({
      credentialStore,
    }).getAppInstallationStatus({ owner: "acme", name: "repo" });

    expect(status).toMatchObject({
      repo: { owner: "acme", name: "repo" },
      relayConfigured: true,
      installed: true,
      state: "configured",
      installationId: 123,
      repositorySelection: "selected",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/acme/repo/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer ghu_app_user_token",
        }),
      }),
    );
  });

  it("keeps supporting legacy project-token relay installation checks", async () => {
    process.env.ADE_GITHUB_TOKEN = "ghp_user_token";
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {
      installed: true,
      state: "configured",
      installationId: 123,
      repositorySelection: "all",
      lastSeenAt: "2026-06-30T00:00:00.000Z",
      checkedAt: "2026-06-30T00:00:01.000Z",
    }));
    const service = makeService({
      githubRelaySecretReader: (ref) => {
        if (ref === "automations.githubRelay.apiBaseUrl") return "https://relay.example.com/";
        if (ref === "automations.githubRelay.accessToken") return "relay-token";
        if (ref === "automations.githubRelay.remoteProjectId") return "project-1";
        return null;
      },
    });

    const status = await service.getAppInstallationStatus({ owner: "acme", name: "repo" });

    expect(status).toMatchObject({
      repo: { owner: "acme", name: "repo" },
      relayConfigured: true,
      installed: true,
      state: "configured",
      installationId: 123,
      repositorySelection: "all",
      lastSeenAt: "2026-06-30T00:00:00.000Z",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://relay.example.com/projects/project-1/github/repos/acme/repo/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Bearer ade_proj_[0-9a-f]{64}$/),
        }),
      }),
    );
  });

  it("asks the legacy relay for a live GitHub App status refresh when forced", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {
      installed: false,
      state: "not_installed",
      checkedAt: "2026-06-30T00:00:01.000Z",
    }));
    const service = makeService({
      githubRelaySecretReader: (ref) => {
        if (ref === "automations.githubRelay.apiBaseUrl") return "https://relay.example.com/";
        if (ref === "automations.githubRelay.accessToken") return "relay-token";
        if (ref === "automations.githubRelay.remoteProjectId") return "project-1";
        return null;
      },
    });

    await service.getAppInstallationStatus({ owner: "acme", name: "repo", forceRefresh: true });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://relay.example.com/projects/project-1/github/repos/acme/repo/status?refresh=1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Bearer ade_proj_[0-9a-f]{64}$/),
        }),
      }),
    );
  });
});

describe("githubService GitHub App user authorization", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("stores the GitHub App user token returned by device flow polling", async () => {
    const credentialStore = new MemoryCredentialStore();
    const service = makeService({ credentialStore });
    const appCandidate = {
      source: "app" as const,
      token: "ghu_app_user_token",
      capabilities: ["read"] as const,
    };
    const environmentCandidate = {
      source: "environment" as const,
      token: "ghp_environment_token",
      capabilities: ["read", "write"] as const,
    };
    const invalid = { kind: "invalid_token" as const, message: "Bad credentials", retryAt: null };
    recordGithubCredentialFailure(appCandidate, invalid, null);
    recordGithubCredentialFailure(environmentCandidate, invalid, null);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, {
        device_code: "device-code",
        user_code: "ADE-CODE",
        verification_uri: "https://github.com/login/device",
        verification_uri_complete: "https://github.com/login/device?user_code=ADE-CODE",
        expires_in: 900,
        interval: 1,
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        access_token: "ghu_app_user_token",
        token_type: "bearer",
        expires_in: 28_800,
        refresh_token: "ghr_refresh_token",
        refresh_token_expires_in: 15_552_000,
      }))
      .mockResolvedValueOnce(jsonResponse(200, { login: "octocat" }));

    const start = await service.startAppUserDeviceAuth();
    const poll = await service.pollAppUserDeviceAuth({ sessionId: start.sessionId });

    expect(start).toMatchObject({
      userCode: "ADE-CODE",
      verificationUri: "https://github.com/login/device",
      intervalSec: 1,
    });
    expect(poll).toMatchObject({
      status: "authorized",
      authStatus: {
        tokenStored: true,
        userLogin: "octocat",
      },
    });
    expect(JSON.parse(credentialStore.getSync("github.appUserToken.v1") ?? "{}")).toMatchObject({
      accessToken: "ghu_app_user_token",
      refreshToken: "ghr_refresh_token",
      userLogin: "octocat",
    });
    expect(githubCredentialCooldown(appCandidate)).toBeNull();
    expect(githubCredentialCooldown(environmentCandidate)).not.toBeNull();
  });

  it("refreshes an expiring GitHub App user token before using it for the relay", async () => {
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_old_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
      refreshToken: "ghr_refresh_token",
      refreshTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      userLogin: "octocat",
      updatedAt: new Date().toISOString(),
    }));
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, {
        access_token: "ghu_new_token",
        token_type: "bearer",
        expires_in: 28_800,
        refresh_token: "ghr_new_refresh_token",
        refresh_token_expires_in: 15_552_000,
      }))
      .mockResolvedValueOnce(jsonResponse(200, { login: "octocat" }));

    await expect(makeService({ credentialStore }).getAppUserTokenForRelay()).resolves.toBe("ghu_new_token");
    expect(JSON.parse(credentialStore.getSync("github.appUserToken.v1") ?? "{}")).toMatchObject({
      accessToken: "ghu_new_token",
      refreshToken: "ghr_new_refresh_token",
    });
  });

  it("shares a single refresh across concurrent relay token requests", async () => {
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_old_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
      refreshToken: "ghr_refresh_token",
      refreshTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      userLogin: "octocat",
      updatedAt: new Date().toISOString(),
    }));
    let refreshCalls = 0;
    mockFetch.mockImplementation(async (input: unknown) => {
      if (String(input) === "https://github.com/login/oauth/access_token") {
        refreshCalls += 1;
        return jsonResponse(200, {
          access_token: "ghu_new_token",
          token_type: "bearer",
          expires_in: 28_800,
          refresh_token: "ghr_new_refresh_token",
          refresh_token_expires_in: 15_552_000,
        });
      }
      return jsonResponse(200, { login: "octocat" });
    });

    const service = makeService({ credentialStore });
    const [first, second] = await Promise.all([
      service.getAppUserTokenForRelay(),
      service.getAppUserTokenForRelay(),
    ]);

    expect(first).toBe("ghu_new_token");
    expect(second).toBe("ghu_new_token");
    expect(refreshCalls).toBe(1);
    expect(JSON.parse(credentialStore.getSync("github.appUserToken.v1") ?? "{}")).toMatchObject({
      accessToken: "ghu_new_token",
    });
  });

  it("neither persists nor returns a refreshed token after the user clears authorization", async () => {
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_old_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
      refreshToken: "ghr_refresh_token",
      refreshTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      userLogin: "octocat",
      updatedAt: new Date().toISOString(),
    }));
    let resolveRefresh!: (response: Response) => void;
    const pendingRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    mockFetch.mockImplementation((input: unknown) => {
      if (String(input) === "https://github.com/login/oauth/access_token") return pendingRefresh;
      return Promise.resolve(jsonResponse(200, { login: "octocat" }));
    });

    const service = makeService({ credentialStore });
    const appCandidate = {
      source: "app" as const,
      token: "ghu_old_token",
      capabilities: ["read"] as const,
    };
    const environmentCandidate = {
      source: "environment" as const,
      token: "ghp_environment_token",
      capabilities: ["read", "write"] as const,
    };
    const invalid = { kind: "invalid_token" as const, message: "Bad credentials", retryAt: null };
    recordGithubCredentialFailure(appCandidate, invalid, null);
    recordGithubCredentialFailure(environmentCandidate, invalid, null);
    const tokenPromise = service.getAppUserTokenForRelay();
    service.clearAppUserAuth();
    resolveRefresh(jsonResponse(200, {
      access_token: "ghu_new_token",
      token_type: "bearer",
      expires_in: 28_800,
      refresh_token: "ghr_new_refresh_token",
      refresh_token_expires_in: 15_552_000,
    }));

    await expect(tokenPromise).rejects.toThrow(
      "Authorize the ADE GitHub App with GitHub before using the hosted relay.",
    );
    expect(credentialStore.getSync("github.appUserToken.v1")).toBeNull();
    expect(service.getAppUserAuthStatus()).toMatchObject({ tokenStored: false, userLogin: null });
    expect(githubCredentialCooldown(appCandidate)).toBeNull();
    expect(githubCredentialCooldown(environmentCandidate)).not.toBeNull();
  });
});

describe("fetchAdeLatestRelease", () => {
  function releaseResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => body,
    } as unknown as Response;
  }

  it("parses the latest release and strips the leading v from the version", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      releaseResponse(200, {
        tag_name: "v1.2.0",
        html_url: "https://github.com/arul28/ADE/releases/tag/v1.2.0",
        published_at: "2026-05-20T00:00:00Z",
      }),
    );
    const release = await fetchAdeLatestRelease({ fetchImpl });
    expect(release).toEqual({
      version: "1.2.0",
      tagName: "v1.2.0",
      htmlUrl: "https://github.com/arul28/ADE/releases/tag/v1.2.0",
      publishedAt: "2026-05-20T00:00:00Z",
    });
    // version is normalized so compareUpdateVersions(release.version, installed) works
    expect(release?.version.startsWith("v")).toBe(false);
  });

  it("sends a bearer header only when a token is provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse(200, { tag_name: "1.0.0" }));
    await fetchAdeLatestRelease({ fetchImpl, token: "ghp_secret" });
    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ghp_secret");

    fetchImpl.mockClear();
    await fetchAdeLatestRelease({ fetchImpl });
    const noAuthHeaders = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(noAuthHeaders.authorization).toBeUndefined();
  });

  it("returns null on non-ok responses (e.g. private repo without auth)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse(404, { message: "Not Found" }));
    expect(await fetchAdeLatestRelease({ fetchImpl })).toBeNull();
  });

  it("returns null when the payload has no tag", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse(200, { html_url: "x" }));
    expect(await fetchAdeLatestRelease({ fetchImpl })).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await fetchAdeLatestRelease({ fetchImpl })).toBeNull();
  });

  it("nulls out empty html_url / published_at", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      releaseResponse(200, { tag_name: "2.0.0", html_url: "", published_at: "" }),
    );
    const release = await fetchAdeLatestRelease({ fetchImpl });
    expect(release).toEqual({ version: "2.0.0", tagName: "2.0.0", htmlUrl: null, publishedAt: null });
  });
});
