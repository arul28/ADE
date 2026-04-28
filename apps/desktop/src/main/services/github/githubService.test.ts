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

const runGitMock = vi.hoisted(() => vi.fn());

vi.mock("../git/git", () => ({
  runGit: runGitMock,
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
    ).rejects.toThrow("GitHub token missing");
  });
});

// ---------------------------------------------------------------------------
// Issue-domain helpers (used by automations polling + issue-action registry)
// ---------------------------------------------------------------------------

describe("githubService issue-domain helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.clearAllMocks();
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
    // Repo probe still runs and we still mock it; the response just decorates the status.
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { full_name: "acme/ade" }));

    const status = await makeService().getStatus();

    expect(status.tokenStored).toBe(true);
    expect(status.tokenType).toBe("classic");
    expect(status.userLogin).toBe("alice");
    expect(status.scopes).toEqual(["repo", "workflow"]);
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
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { full_name: "acme/ade" }));

    const status = await makeService().getStatus();

    expect(status.scopes).toEqual(["read:user"]);
    expect(status.connected).toBe(false);
  });

  it("missing token returns not-connected status with all the new fields populated", async () => {
    stubOriginRemote();
    const status = await makeService().getStatus();

    expect(status.tokenStored).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.repoAccessOk).toBeNull();
    expect(status.repoAccessError).toBeNull();
  });
});
