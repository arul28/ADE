import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { createGithubService, fetchAdeLatestRelease } from "./githubService";

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
  vi.clearAllMocks();
  mockFetch.mockReset();
  runGitMock.mockReset();
  delete process.env.GH_TOKEN;
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
  ghAuthTokenProvider?: () => { token: string | null; ghCliPath: string | null; ghAuthError: string | null };
} = {}) {
  return createGithubService({
    logger: makeLogger(),
    projectRoot: "/tmp/test-project",
    appDataDir: "/tmp/test-appdata",
    credentialStore: options.credentialStore as any,
    ghAuthTokenProvider: options.ghAuthTokenProvider,
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

  it("stores and clears GitHub PATs in the shared machine credential store", () => {
    const credentialStore = new MemoryCredentialStore();
    const service = makeService({ credentialStore });

    service.setToken("ghp_saved_token");
    expect(credentialStore.getSync("github.token.v1")).toBe("ghp_saved_token");

    service.clearToken();
    expect(credentialStore.getSync("github.token.v1")).toBeNull();
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
        url_template: "https://ade.app/open?number=<num>",
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
      urlTemplate: "https://ade.app/open?number=<num>",
      isAlphanumeric: false,
    })).resolves.toEqual({
      id: 2,
      keyPrefix: "ADEPR-",
      urlTemplate: "https://ade.app/open?number=<num>",
      isAlphanumeric: false,
    });
    expect(mockFetch.mock.calls[0]?.[0]).toMatch(/\/repos\/acme\/ade\/autolinks/);
    const [, init] = lastFetchCall();
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      key_prefix: "ADEPR-",
      url_template: "https://ade.app/open?number=<num>",
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

  it("classic token with required scopes is connected (no repo probe needed)", async () => {
    stubOriginRemote();
    process.env.GITHUB_TOKEN = "ghp_classic";
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { login: "alice" }, { "x-oauth-scopes": "repo, workflow" }),
    );
    const status = await makeService().getStatus();

    expect(status.tokenStored).toBe(true);
    expect(status.tokenType).toBe("classic");
    expect(status.userLogin).toBe("alice");
    expect(status.scopes).toEqual(["repo", "workflow"]);
    expect(status.repoAccessOk).toBeNull();
    expect(status.connected).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { login: "alice" }));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { full_name: "acme/ade" }));

    const status = await makeService().getStatus();

    expect(status.tokenType).toBe("fine-grained");
    expect(status.repoAccessOk).toBe(true);
    expect(status.connected).toBe(true);
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

  it("reports hasOrigin=true with repo=null when origin is non-GitHub (GitLab/Bitbucket)", async () => {
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

    expect(result).toEqual({ state: "pushed", htmlUrl: "https://github.com/alice/proj" });
    const gitCalls = runGitMock.mock.calls.map((c) => c[0]);
    expect(gitCalls[0]).toEqual(["remote", "get-url", "origin"]);
    expect(gitCalls[1]).toEqual(["remote", "add", "origin", "https://github.com/alice/proj.git"]);
    expect(gitCalls[2]).toEqual(["rev-parse", "--verify", "HEAD"]);
    expect(gitCalls[3]).toEqual(["push", "-u", "origin", "HEAD"]);
  });

  it("returns state=remote_added when the project has no commits yet", async () => {
    runGitMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" }) // get-url origin
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // remote add
      .mockResolvedValueOnce({ exitCode: 128, stdout: "", stderr: "fatal: Needed a single revision" }); // rev-parse HEAD fails

    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
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

    expect(result).toEqual({ state: "remote_added", htmlUrl: "https://github.com/alice/empty" });
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

    expect(result).toEqual({ state: "pushed", htmlUrl: "https://github.com/alice/proj" });
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
