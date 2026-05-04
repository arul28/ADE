import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CloneProjectInput,
  CloneProjectResult,
  CreateProjectInput,
  CreateProjectResult,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  MyGitHubRepoSummary,
} from "../../../shared/types/core";
import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type { createGithubService } from "../github/githubService";

type GithubService = ReturnType<typeof createGithubService>;

const GITIGNORE_CONTENT = [
  "node_modules/",
  "dist/",
  "build/",
  ".DS_Store",
  ".ade/",
  ".env",
  ".env.*",
  "*.log",
  "",
].join("\n");

const REPO_LIST_CACHE_TTL_MS = 60_000;

function validateProjectName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed.length) {
    throw new Error("Project name is required.");
  }
  if (trimmed.length > 100) {
    throw new Error("Project name must be 100 characters or fewer.");
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("Project name cannot contain path separators.");
  }
  if (trimmed.startsWith(".")) {
    throw new Error("Project name cannot start with a dot.");
  }
  if (trimmed.includes("\0")) {
    throw new Error("Project name contains an invalid character.");
  }
  return trimmed;
}

function isDirectoryNonEmpty(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath);
    return entries.length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isGitIdentityError(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes("please tell me who you are") ||
    text.includes("user.email") ||
    text.includes("author identity")
  );
}

export function createProjectScaffoldService({
  logger,
  githubService,
}: {
  logger: Logger;
  githubService: GithubService;
}) {
  let cachedRepos: { tokenPrefix: string; expiresAt: number; repos: MyGitHubRepoSummary[] } | null = null;

  const createLocalProject = async (input: CreateProjectInput): Promise<CreateProjectResult> => {
    const name = validateProjectName(input.name);
    const parentDir = (input.parentDir ?? "").trim();
    if (!parentDir.length) {
      throw new Error("Parent directory is required.");
    }

    const rootPath = path.join(parentDir, name);

    if (fs.existsSync(rootPath) && isDirectoryNonEmpty(rootPath)) {
      throw new Error("target_exists");
    }

    fs.mkdirSync(rootPath, { recursive: true });

    const initRes = await runGit(["init", "--initial-branch=main"], { cwd: rootPath, timeoutMs: 15_000 });
    if (initRes.exitCode !== 0) {
      const fallbackInit = await runGit(["init"], { cwd: rootPath, timeoutMs: 15_000 });
      if (fallbackInit.exitCode !== 0) {
        throw new Error(`git init failed: ${fallbackInit.stderr.trim() || `exit ${fallbackInit.exitCode}`}`);
      }
      const symbolicRef = await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], {
        cwd: rootPath,
        timeoutMs: 5_000,
      });
      if (symbolicRef.exitCode !== 0) {
        logger.warn("project_scaffold.symbolic_ref_failed", {
          rootPath,
          stderr: symbolicRef.stderr.trim(),
        });
      }
    }

    fs.writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`, "utf8");
    fs.writeFileSync(path.join(rootPath, ".gitignore"), GITIGNORE_CONTENT, "utf8");

    const addRes = await runGit(["add", "."], { cwd: rootPath, timeoutMs: 15_000 });
    if (addRes.exitCode !== 0) {
      throw new Error(`git add failed: ${addRes.stderr.trim() || `exit ${addRes.exitCode}`}`);
    }

    const commitRes = await runGit(["commit", "-m", "Initial commit"], { cwd: rootPath, timeoutMs: 15_000 });
    if (commitRes.exitCode !== 0) {
      if (isGitIdentityError(commitRes.stderr)) {
        const retry = await runGit(
          ["commit", "-m", "Initial commit", "--author=ADE <ade@local>"],
          {
            cwd: rootPath,
            timeoutMs: 15_000,
            env: {
              ...process.env,
              GIT_COMMITTER_NAME: "ADE",
              GIT_COMMITTER_EMAIL: "ade@local",
            },
          },
        );
        if (retry.exitCode !== 0) {
          logger.warn("project_scaffold.initial_commit_retry_failed", {
            rootPath,
            stderr: retry.stderr.trim(),
          });
        }
      } else {
        logger.warn("project_scaffold.initial_commit_failed", {
          rootPath,
          stderr: commitRes.stderr.trim(),
        });
      }
    }

    return { rootPath };
  };

  const cloneRepository = async (input: CloneProjectInput): Promise<CloneProjectResult> => {
    const url = (input.url ?? "").trim();
    if (!url) {
      throw new Error("invalid_github_url");
    }
    const repoRef = githubService.parseGitHubRepoFromRemoteUrl(url);
    if (!repoRef) {
      throw new Error("invalid_github_url");
    }

    const parentDir = (input.parentDir ?? "").trim();
    if (!parentDir.length) {
      throw new Error("Parent directory is required.");
    }

    const explicitName = (input.name ?? "").trim();
    const name = validateProjectName(explicitName.length > 0 ? explicitName : repoRef.name);
    const rootPath = path.join(parentDir, name);

    if (fs.existsSync(rootPath) && isDirectoryNonEmpty(rootPath)) {
      throw new Error("target_exists");
    }

    fs.mkdirSync(parentDir, { recursive: true });

    const cloneRes = await runGit(["clone", url, rootPath], {
      cwd: parentDir,
      timeoutMs: 5 * 60_000,
    });
    if (cloneRes.exitCode !== 0) {
      throw new Error(cloneRes.stderr.trim() || `git clone failed (exit ${cloneRes.exitCode})`);
    }

    return { rootPath };
  };

  const listMyGitHubRepos = async (input: ListMyGitHubReposInput): Promise<ListMyGitHubReposResult> => {
    let token: string;
    try {
      token = githubService.getTokenOrThrow();
    } catch (err) {
      const wrapped = new Error("GitHub is not connected. Add a token in Settings.") as Error & { code?: string };
      wrapped.code = "github_not_connected";
      (wrapped as any).cause = err;
      throw wrapped;
    }

    const tokenPrefix = token.slice(0, 8);
    const now = Date.now();
    let repos: MyGitHubRepoSummary[];
    if (cachedRepos && cachedRepos.tokenPrefix === tokenPrefix && cachedRepos.expiresAt > now) {
      repos = cachedRepos.repos;
    } else {
      const collected: MyGitHubRepoSummary[] = [];
      const perPage = 100;
      const maxPages = 5;
      for (let page = 1; page <= maxPages; page += 1) {
        const { data } = await githubService.apiRequest<Array<Record<string, unknown>>>({
          method: "GET",
          path: "/user/repos",
          query: {
            per_page: perPage,
            sort: "pushed",
            affiliation: "owner,collaborator,organization_member",
            page,
          },
        });
        const items = Array.isArray(data) ? data : [];
        for (const item of items) {
          const owner = (item.owner as Record<string, unknown> | undefined)?.login;
          const fullName = item.full_name;
          const repoName = item.name;
          if (typeof owner !== "string" || typeof fullName !== "string" || typeof repoName !== "string") {
            continue;
          }
          collected.push({
            owner,
            name: repoName,
            fullName,
            isPrivate: Boolean(item.private),
            pushedAt: typeof item.pushed_at === "string" ? item.pushed_at : null,
            defaultBranch: typeof item.default_branch === "string" ? item.default_branch : "main",
            htmlUrl: typeof item.html_url === "string" ? item.html_url : "",
            cloneUrl: typeof item.clone_url === "string" ? item.clone_url : "",
            sshUrl: typeof item.ssh_url === "string" ? item.ssh_url : "",
          });
        }
        if (items.length < perPage) break;
      }
      repos = collected;
      cachedRepos = { tokenPrefix, expiresAt: now + REPO_LIST_CACHE_TTL_MS, repos };
    }

    const search = (input.search ?? "").trim().toLowerCase();
    const filtered = search.length > 0
      ? repos.filter((r) => r.fullName.toLowerCase().includes(search))
      : repos;

    return { repos: filtered };
  };

  const getDefaultParentDir = (recentProjects: { rootPath: string }[]): string => {
    const first = recentProjects?.[0]?.rootPath;
    if (typeof first === "string" && first.length > 0) {
      return path.dirname(first);
    }
    return path.join(os.homedir(), "Projects");
  };

  return {
    createLocalProject,
    cloneRepository,
    listMyGitHubRepos,
    getDefaultParentDir,
  };
}

export type ProjectScaffoldService = ReturnType<typeof createProjectScaffoldService>;
