import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runGitMock = vi.hoisted(() => vi.fn());

vi.mock("../git/git", () => ({
  runGit: runGitMock,
}));

import { createProjectScaffoldService } from "./projectScaffoldService";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function makeGithubServiceStub(overrides: Partial<{
  apiRequest: ReturnType<typeof vi.fn>;
  getTokenOrThrow: ReturnType<typeof vi.fn>;
  parseGitHubRepoFromRemoteUrl: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    apiRequest: overrides.apiRequest ?? vi.fn(),
    getTokenOrThrow: overrides.getTokenOrThrow ?? vi.fn(() => "ghp_fake_token_12345"),
    parseGitHubRepoFromRemoteUrl:
      overrides.parseGitHubRepoFromRemoteUrl ??
      vi.fn((url: string) => {
        if (url.startsWith("https://github.com/") || url.startsWith("git@github.com:")) {
          const slug = url.replace(/^https:\/\/github\.com\//, "").replace(/^git@github\.com:/, "").replace(/\.git$/, "");
          const [owner, name] = slug.split("/");
          if (owner && name) return { owner, name };
        }
        return null;
      }),
    parseNextLink: vi.fn(),
  } as any;
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function gitOk(stdout = ""): { exitCode: 0; stdout: string; stderr: string } {
  return { exitCode: 0, stdout, stderr: "" };
}

function gitFail(stderr: string, exitCode = 1): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode, stdout: "", stderr };
}

afterEach(() => {
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("createLocalProject", () => {
  beforeEach(() => {
    runGitMock.mockReset();
  });

  it("creates README + .gitignore and runs init/add/commit on main", async () => {
    runGitMock.mockResolvedValue(gitOk());
    const parentDir = makeTempDir("ade-scaffold-create-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    const result = await service.createLocalProject({ name: "my-project", parentDir });

    expect(result.rootPath).toBe(path.join(parentDir, "my-project"));
    expect(fs.readFileSync(path.join(result.rootPath, "README.md"), "utf8")).toBe("# my-project\n");
    const gitignore = fs.readFileSync(path.join(result.rootPath, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).not.toContain(".ade/");
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("*.log");
    expect(fs.existsSync(path.join(result.rootPath, ".ade", ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(result.rootPath, ".ade", "ade.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(result.rootPath, ".ade", "cto", "identity.yaml"))).toBe(true);

    const argsList = runGitMock.mock.calls.map((c) => c[0] as string[]);
    expect(argsList[0]).toEqual(["init", "--initial-branch=main"]);
    expect(argsList).toContainEqual(["add", "."]);
    expect(argsList).toContainEqual(["commit", "-m", "Initial commit"]);
  });

  it("falls back to plain init + symbolic-ref when --initial-branch is unsupported", async () => {
    runGitMock
      .mockResolvedValueOnce(gitFail("error: unknown option `initial-branch'"))
      .mockResolvedValueOnce(gitOk()) // git init (plain)
      .mockResolvedValueOnce(gitOk()) // symbolic-ref
      .mockResolvedValueOnce(gitOk()) // add .
      .mockResolvedValueOnce(gitOk()); // commit

    const parentDir = makeTempDir("ade-scaffold-fallback-init-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    await service.createLocalProject({ name: "legacy-git", parentDir });

    const argsList = runGitMock.mock.calls.map((c) => c[0] as string[]);
    expect(argsList[0]).toEqual(["init", "--initial-branch=main"]);
    expect(argsList[1]).toEqual(["init"]);
    expect(argsList[2]).toEqual(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  it("retries the initial commit with the ADE author when git identity is missing", async () => {
    runGitMock
      .mockResolvedValueOnce(gitOk()) // init --initial-branch=main
      .mockResolvedValueOnce(gitOk()) // add .
      .mockResolvedValueOnce(gitFail("Please tell me who you are."))
      .mockResolvedValueOnce(gitOk()); // retry commit

    const parentDir = makeTempDir("ade-scaffold-author-fallback-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    await service.createLocalProject({ name: "no-config-project", parentDir });

    const calls = runGitMock.mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[2]?.[0]).toEqual(["commit", "-m", "Initial commit"]);
    expect(calls[3]?.[0]).toEqual([
      "commit",
      "-m",
      "Initial commit",
      "--author=ADE <ade@local>",
    ]);
    const retryEnv = (calls[3]?.[1] as { env?: Record<string, string> }).env ?? {};
    expect(retryEnv.GIT_COMMITTER_NAME).toBe("ADE");
    expect(retryEnv.GIT_COMMITTER_EMAIL).toBe("ade@local");
  });

  it("does not throw when the author-fallback commit also fails (best-effort)", async () => {
    runGitMock
      .mockResolvedValueOnce(gitOk())
      .mockResolvedValueOnce(gitOk())
      .mockResolvedValueOnce(gitFail("Please tell me who you are."))
      .mockResolvedValueOnce(gitFail("still no identity"));

    const parentDir = makeTempDir("ade-scaffold-author-retry-fail-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    await expect(
      service.createLocalProject({ name: "uncommittable", parentDir }),
    ).resolves.toEqual({ rootPath: path.join(parentDir, "uncommittable") });
  });

  it("rejects names with path separators", async () => {
    const parentDir = makeTempDir("ade-scaffold-name-sep-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    await expect(
      service.createLocalProject({ name: "bad/name", parentDir }),
    ).rejects.toThrow(/path separators/i);
    await expect(
      service.createLocalProject({ name: "bad\\name", parentDir }),
    ).rejects.toThrow(/path separators/i);
  });

  it("rejects empty/dotted/oversized names", async () => {
    const parentDir = makeTempDir("ade-scaffold-name-edge-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    await expect(service.createLocalProject({ name: "  ", parentDir })).rejects.toThrow(/required/i);
    await expect(service.createLocalProject({ name: ".hidden", parentDir })).rejects.toThrow(/dot/i);
    await expect(
      service.createLocalProject({ name: "a".repeat(101), parentDir }),
    ).rejects.toThrow(/100/);
  });

  it("rejects when target directory already exists and is non-empty", async () => {
    const parentDir = makeTempDir("ade-scaffold-target-exists-");
    const collision = path.join(parentDir, "collision");
    fs.mkdirSync(collision);
    fs.writeFileSync(path.join(collision, "preexisting.txt"), "hi");

    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    let caught: any;
    try {
      await service.createLocalProject({ name: "collision", parentDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("target_exists");
  });

  it("allows reusing an empty existing directory as the target", async () => {
    runGitMock.mockResolvedValue(gitOk());
    const parentDir = makeTempDir("ade-scaffold-target-empty-");
    const empty = path.join(parentDir, "empty-target");
    fs.mkdirSync(empty);

    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    await expect(
      service.createLocalProject({ name: "empty-target", parentDir }),
    ).resolves.toEqual({ rootPath: empty });
  });

  it("rolls back the created directory when a step after mkdir fails", async () => {
    // init ok, then `git add .` fails after README/.gitignore are written.
    runGitMock
      .mockResolvedValueOnce(gitOk())
      .mockResolvedValueOnce(gitFail("fatal: not a git repository", 128));

    const parentDir = makeTempDir("ade-scaffold-rollback-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    const rootPath = path.join(parentDir, "doomed");
    await expect(
      service.createLocalProject({ name: "doomed", parentDir }),
    ).rejects.toThrow();

    // The directory we created must be gone so a retry isn't blocked by target_exists.
    expect(fs.existsSync(rootPath)).toBe(false);
  });

  it("does not roll back a pre-existing empty directory on failure", async () => {
    runGitMock
      .mockResolvedValueOnce(gitOk())
      .mockResolvedValueOnce(gitFail("boom", 128));

    const parentDir = makeTempDir("ade-scaffold-rollback-preexist-");
    const rootPath = path.join(parentDir, "user-made");
    fs.mkdirSync(rootPath);

    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    await expect(
      service.createLocalProject({ name: "user-made", parentDir }),
    ).rejects.toThrow();

    expect(fs.existsSync(rootPath)).toBe(true);
  });
});

describe("cloneRepository", () => {
  beforeEach(() => {
    runGitMock.mockReset();
  });

  it("rejects URLs that are not GitHub", async () => {
    const parentDir = makeTempDir("ade-scaffold-clone-bad-url-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub({
        parseGitHubRepoFromRemoteUrl: vi.fn(() => null),
      }),
    });

    let caught: any;
    try {
      await service.cloneRepository({ url: "https://gitlab.com/foo/bar.git", parentDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("invalid_github_url");
  });

  it("rejects empty URLs", async () => {
    const parentDir = makeTempDir("ade-scaffold-clone-empty-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    let caught: any;
    try {
      await service.cloneRepository({ url: "", parentDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("invalid_github_url");
  });

  it("invokes git clone with the URL and target path, deriving name from the URL", async () => {
    runGitMock.mockResolvedValue(gitOk());
    const parentDir = makeTempDir("ade-scaffold-clone-default-name-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    const result = await service.cloneRepository({
      url: "https://github.com/octocat/Hello-World",
      parentDir,
    });

    expect(result.rootPath).toBe(path.join(parentDir, "Hello-World"));
    const cloneCall = runGitMock.mock.calls.find((c) => (c[0] as string[])[0] === "clone");
    const args = cloneCall?.[0] as string[];
    expect(args.slice(-2)).toEqual([
      "https://github.com/octocat/Hello-World",
      path.join(parentDir, "Hello-World"),
    ]);
  });

  it("uses the explicit name override when provided", async () => {
    runGitMock.mockResolvedValue(gitOk());
    const parentDir = makeTempDir("ade-scaffold-clone-override-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    const result = await service.cloneRepository({
      url: "https://github.com/octocat/Hello-World",
      parentDir,
      name: "renamed-checkout",
    });

    expect(result.rootPath).toBe(path.join(parentDir, "renamed-checkout"));
  });

  it("rejects when the target directory already exists and is non-empty", async () => {
    const parentDir = makeTempDir("ade-scaffold-clone-collision-");
    const dest = path.join(parentDir, "Hello-World");
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, "x"), "x");

    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    let caught: any;
    try {
      await service.cloneRepository({ url: "https://github.com/octocat/Hello-World", parentDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("target_exists");
  });

  it("surfaces git clone failures with stderr", async () => {
    runGitMock.mockResolvedValue(gitFail("Repository not found"));
    const parentDir = makeTempDir("ade-scaffold-clone-fail-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    await expect(
      service.cloneRepository({ url: "https://github.com/octocat/Hello-World", parentDir }),
    ).rejects.toThrow(/repository not found/i);
  });

  it("injects the stored GitHub token via http.extraheader so private clones succeed without a credential helper", async () => {
    runGitMock.mockResolvedValue(gitOk());
    const parentDir = makeTempDir("ade-scaffold-clone-auth-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub({
        getTokenOrThrow: vi.fn(() => "ghp_secret_token"),
      }),
    });

    await service.cloneRepository({
      url: "https://github.com/octocat/Hello-World",
      parentDir,
    });

    const cloneCall = runGitMock.mock.calls.find((c) => (c[0] as string[])[0] === "clone");
    expect(cloneCall).toBeDefined();
    const args = cloneCall?.[0] as string[];
    const expectedBasic = Buffer.from("x-access-token:ghp_secret_token", "utf8").toString("base64");
    expect(args).toEqual([
      "clone",
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${expectedBasic}`,
      "https://github.com/octocat/Hello-World",
      path.join(parentDir, "Hello-World"),
    ]);
  });

  it("falls back to a plain clone (no extraheader) when no token is stored", async () => {
    runGitMock.mockResolvedValue(gitOk());
    const parentDir = makeTempDir("ade-scaffold-clone-no-token-");
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub({
        getTokenOrThrow: vi.fn(() => {
          throw new Error("GitHub token missing. Set it in Settings.");
        }),
      }),
    });

    await service.cloneRepository({
      url: "https://github.com/octocat/Hello-World",
      parentDir,
    });

    const cloneCall = runGitMock.mock.calls.find((c) => (c[0] as string[])[0] === "clone");
    const args = cloneCall?.[0] as string[];
    expect(args).toEqual([
      "clone",
      "https://github.com/octocat/Hello-World",
      path.join(parentDir, "Hello-World"),
    ]);
    expect(args.some((a) => a.includes("extraheader"))).toBe(false);
  });

  it("rolls back a partial clone directory so retry isn't blocked by target_exists", async () => {
    const parentDir = makeTempDir("ade-scaffold-clone-rollback-");
    const rootPath = path.join(parentDir, "Hello-World");

    // Simulate `git clone` partially populating the dir then failing.
    runGitMock.mockImplementationOnce(async () => {
      fs.mkdirSync(rootPath);
      fs.writeFileSync(path.join(rootPath, "partial"), "x");
      return gitFail("fatal: authentication failed");
    });

    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    await expect(
      service.cloneRepository({ url: "https://github.com/octocat/Hello-World", parentDir }),
    ).rejects.toThrow();

    expect(fs.existsSync(rootPath)).toBe(false);
  });
});

describe("listMyGitHubRepos", () => {
  it("throws github_not_connected when no token is available", async () => {
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub({
        getTokenOrThrow: vi.fn(() => {
          throw new Error("GitHub token missing. Set it in Settings.");
        }),
      }),
    });

    let caught: any;
    try {
      await service.listMyGitHubRepos({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("github_not_connected");
  });

  it("paginates the GitHub /user/repos endpoint and stops on partial pages", async () => {
    const apiRequest = vi.fn();

    const makeRepo = (id: number) => ({
      owner: { login: "alice" },
      name: `repo-${id}`,
      full_name: `alice/repo-${id}`,
      private: id % 2 === 0,
      pushed_at: "2026-04-01T12:00:00Z",
      default_branch: "main",
      html_url: `https://github.com/alice/repo-${id}`,
      clone_url: `https://github.com/alice/repo-${id}.git`,
      ssh_url: `git@github.com:alice/repo-${id}.git`,
    });

    const fullPage = Array.from({ length: 100 }, (_, i) => makeRepo(i));
    const partialPage = [makeRepo(100), makeRepo(101)];

    apiRequest
      .mockResolvedValueOnce({ data: fullPage, response: null })
      .mockResolvedValueOnce({ data: partialPage, response: null });

    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub({ apiRequest }),
    });

    const result = await service.listMyGitHubRepos({});

    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(apiRequest.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/user/repos",
      query: expect.objectContaining({
        per_page: 100,
        sort: "pushed",
        affiliation: "owner,collaborator,organization_member",
        page: 1,
      }),
    });
    expect(apiRequest.mock.calls[1]?.[0]).toMatchObject({
      query: expect.objectContaining({ page: 2 }),
    });
    expect(result.repos).toHaveLength(102);
    expect(result.repos[0]).toMatchObject({
      owner: "alice",
      name: "repo-0",
      fullName: "alice/repo-0",
      isPrivate: true,
      defaultBranch: "main",
    });
  });

  it("filters by case-insensitive substring on fullName", async () => {
    const apiRequest = vi.fn().mockResolvedValueOnce({
      data: [
        { owner: { login: "alice" }, name: "ade", full_name: "alice/ade", private: false, pushed_at: null, default_branch: "main", html_url: "", clone_url: "", ssh_url: "" },
        { owner: { login: "alice" }, name: "infra", full_name: "alice/infra", private: false, pushed_at: null, default_branch: "main", html_url: "", clone_url: "", ssh_url: "" },
        { owner: { login: "alice" }, name: "ADE-tools", full_name: "alice/ADE-tools", private: true, pushed_at: null, default_branch: "main", html_url: "", clone_url: "", ssh_url: "" },
      ],
      response: null,
    });

    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub({ apiRequest }),
    });

    const result = await service.listMyGitHubRepos({ search: "ADE" });
    expect(result.repos.map((r) => r.fullName)).toEqual(["alice/ade", "alice/ADE-tools"]);
  });

  it("returns cached results within the 60s window without re-hitting the API", async () => {
    const apiRequest = vi.fn().mockResolvedValueOnce({
      data: [
        { owner: { login: "alice" }, name: "cached", full_name: "alice/cached", private: false, pushed_at: null, default_branch: "main", html_url: "", clone_url: "", ssh_url: "" },
      ],
      response: null,
    });

    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub({ apiRequest }),
    });

    await service.listMyGitHubRepos({});
    await service.listMyGitHubRepos({});

    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("invalidates the cache when the token changes (fine-grained PATs share the same prefix)", async () => {
    const apiRequest = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          { owner: { login: "alice" }, name: "first", full_name: "alice/first", private: false, pushed_at: null, default_branch: "main", html_url: "", clone_url: "", ssh_url: "" },
        ],
        response: null,
      })
      .mockResolvedValueOnce({
        data: [
          { owner: { login: "bob" }, name: "second", full_name: "bob/second", private: false, pushed_at: null, default_branch: "main", html_url: "", clone_url: "", ssh_url: "" },
        ],
        response: null,
      });

    const getTokenOrThrow = vi
      .fn<[], string>()
      .mockReturnValueOnce("github_pat_AAAAAAAA_one")
      .mockReturnValueOnce("github_pat_BBBBBBBB_two");

    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub({ apiRequest, getTokenOrThrow }),
    });

    const first = await service.listMyGitHubRepos({});
    const second = await service.listMyGitHubRepos({});

    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(first.repos.map((r) => r.fullName)).toEqual(["alice/first"]);
    expect(second.repos.map((r) => r.fullName)).toEqual(["bob/second"]);
  });

  it("stops paginating after 5 pages even if every page is full", async () => {
    const apiRequest = vi.fn();
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      owner: { login: "alice" },
      name: `repo-${i}`,
      full_name: `alice/repo-${i}`,
      private: false,
      pushed_at: null,
      default_branch: "main",
      html_url: "",
      clone_url: "",
      ssh_url: "",
    }));
    apiRequest.mockResolvedValue({ data: fullPage, response: null });

    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub({ apiRequest }),
    });

    const result = await service.listMyGitHubRepos({});

    expect(apiRequest).toHaveBeenCalledTimes(5);
    expect(result.repos).toHaveLength(500);
  });
});

describe("getDefaultParentDir", () => {
  it("returns the parent of the most recent project's rootPath", () => {
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    const result = service.getDefaultParentDir([
      { rootPath: "/Users/alice/code/ade" },
      { rootPath: "/Users/alice/work/other" },
    ]);

    expect(result).toBe("/Users/alice/code");
  });

  it("falls back to ~/Projects when no recent projects are available", () => {
    const service = createProjectScaffoldService({
      logger: makeLogger(),
      githubService: makeGithubServiceStub(),
    });

    expect(service.getDefaultParentDir([])).toBe(path.join(os.homedir(), "Projects"));
  });
});
