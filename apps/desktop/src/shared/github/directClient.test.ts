import { describe, expect, it } from "vitest";
import { buildGithubDirectRequest, classifyGithubDirectResponse, diagnoseRepositoryAccess } from "./directClient";

// The request builder is the fence that keeps the account's GitHub token on
// the allowed reads, and the classifier is the L12 contract the web, the
// desktop and the iPhone port all show. Both are pure.

const headers = (values: Record<string, string> = {}) => new Headers(values);
const NOW = 1_800_000_000_000;

describe("buildGithubDirectRequest", () => {
  it.each([
    ["listPulls", { op: "listPulls", params: { owner: "dorg", name: "widgets" } }, ["/repos/dorg/widgets/pulls"]],
    ["listIssues closed", { op: "listIssues", params: { owner: "dorg", name: "w.x_y-z", state: "closed" } }, ["/repos/dorg/w.x_y-z/issues"]],
    ["getPull", { op: "getPull", params: { owner: "dorg", name: "widgets", number: 7 } }, ["/repos/dorg/widgets/pulls/7"]],
    ["listComments", { op: "listComments", params: { owner: "dorg", name: "widgets", number: 7 } }, ["/repos/dorg/widgets/issues/7/comments", "/repos/dorg/widgets/pulls/7/comments"]],
    ["listChecks", { op: "listChecks", params: { owner: "dorg", name: "widgets", sha: "ABCDEF1" } }, ["/repos/dorg/widgets/commits/abcdef1/check-runs", "/repos/dorg/widgets/commits/abcdef1/status"]],
    ["listRepositories", { op: "listRepositories" }, ["/user/repos"]],
  ])("builds %s", (_label, request, paths) => {
    const built = buildGithubDirectRequest(request);
    expect(built.ok && built.steps.map((step) => step.path)).toEqual(paths);
  });

  it.each([
    ["an unknown op", { op: "deleteRepo", params: { owner: "dorg", name: "widgets" } }],
    ["a path in the owner", { op: "listPulls", params: { owner: "../orgs", name: "widgets" } }],
    ["a slash in the name", { op: "listPulls", params: { owner: "dorg", name: "a/b" } }],
    ["a dot-dot name", { op: "listPulls", params: { owner: "dorg", name: ".." } }],
    ["an owner that starts with a dash", { op: "listPulls", params: { owner: "-dorg", name: "widgets" } }],
    ["a number that is not whole", { op: "getPull", params: { owner: "dorg", name: "widgets", number: 1.5 } }],
    ["a number as text", { op: "getPull", params: { owner: "dorg", name: "widgets", number: "7" } }],
    ["a branch name for a SHA", { op: "listChecks", params: { owner: "dorg", name: "widgets", sha: "main" } }],
    ["an unknown list state", { op: "listPulls", params: { owner: "dorg", name: "widgets", state: "merged" } }],
    ["no op", { params: {} }],
  ])("refuses %s", (_label, request) => {
    const built = buildGithubDirectRequest(request);
    expect(built.ok ? null : built.error.kind).toBe("invalid_request");
  });

  it("caps the page count at 10", () => {
    const built = buildGithubDirectRequest({ op: "listPulls", params: { owner: "dorg", name: "widgets", maxPages: 500 } });
    expect(built.ok && built.steps[0]!.maxPages).toBe(10);
  });
});

describe("classifyGithubDirectResponse", () => {
  it.each([
    ["200", 200, {}, null, null],
    ["304", 304, {}, null, null],
    ["401", 401, {}, null, "sign_in_expired"],
    ["403 with no requests left", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800003600" }, { message: "API rate limit exceeded" }, "rate_limited"],
    ["403 with retry-after", 403, { "retry-after": "30" }, { message: "You have exceeded a secondary rate limit." }, "rate_limited"],
    ["429", 429, {}, null, "rate_limited"],
    ["403 with SSO", 403, { "x-github-sso": "required; url=https://github.com/orgs/o/sso" }, { message: "Resource protected by organization SAML enforcement." }, "repo_not_reachable"],
    ["403 not accessible by integration", 403, {}, { message: "Resource not accessible by integration" }, "rights_not_accepted"],
    ["403 other", 403, {}, { message: "Must have admin rights" }, "forbidden"],
    ["404", 404, {}, { message: "Not Found" }, "not_found"],
    ["422", 422, {}, null, "invalid_request"],
    ["502", 502, {}, null, "github_unavailable"],
  ])("%s", (_label, status, headerValues, body, kind) => {
    const error = classifyGithubDirectResponse({ status, headers: headers(headerValues), body, now: NOW });
    expect(error?.kind ?? null).toBe(kind);
  });

  it("dates a rate limit by the reset header, and a secondary limit by retry-after", () => {
    const primary = classifyGithubDirectResponse({ status: 403, headers: headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800003600" }), body: null, now: NOW });
    const secondary = classifyGithubDirectResponse({ status: 403, headers: headers({ "retry-after": "30" }), body: null, now: NOW });
    expect([primary?.retryAt, primary?.secondary, secondary?.retryAt, secondary?.secondary]).toEqual([1_800_003_600_000, false, NOW + 30_000, true]);
  });
});

describe("diagnoseRepositoryAccess", () => {
  const repo = { owner: "dorg", name: "widgets" };
  // The body of `GET /user/installations`.
  const install = (permissions: Record<string, string>) => ({
    installations: [{ id: 5, account: { login: "dorg", type: "Organization" }, permissions: { metadata: "read", ...permissions } }],
  });
  const none = { installations: [] };
  const full = { contents: "write", pull_requests: "write", issues: "write" };
  it.each([
    ["no installation, repository hidden", none, { status: 404, private: null, sso: false }, "app_not_installed"],
    ["no installation, public repository", none, { status: 200, private: false, sso: false }, "read_only"],
    ["installed, repository hidden", install(full), { status: 404, private: null, sso: false }, "repo_not_reachable"],
    ["installed with old rights, repository hidden", install({ contents: "read" }), { status: 404, private: null, sso: false }, "repo_not_reachable"],
    ["installed with old rights, repository reachable", install({ contents: "read" }), { status: 200, private: true, sso: false }, "rights_not_accepted"],
    ["installed, repository reachable", install(full), { status: 200, private: true, sso: false }, "ok"],
  ])("%s", (_label, installations, repoAnswer, state) => {
    expect(diagnoseRepositoryAccess({ repo, installations, repoAnswer }).state).toBe(state);
  });
});
