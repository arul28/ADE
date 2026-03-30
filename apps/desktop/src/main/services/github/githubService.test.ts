import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../git/git", () => ({
  runGit: vi.fn(),
}));

// Replace global fetch
vi.stubGlobal("fetch", mockFetch);

import { createGithubService } from "./githubService";

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

function makeService() {
  return createGithubService({
    logger: makeLogger(),
    projectRoot: "/tmp/test-project",
    appDataDir: "/tmp/test-appdata",
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
    vi.clearAllMocks();
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
    ).rejects.toThrow("GitHub token missing");
  });
});
