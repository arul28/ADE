import { ADE_GIT_CREDENTIAL_HELPER, ADE_GIT_CREDENTIAL_HELPER_KEY } from "../../../../../ade-cli/src/services/github/gitCredentialHelper";
import crypto from "node:crypto";
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
import { codedError } from "../../../shared/codedError";
import { AdeExpectedError } from "../../../shared/expectedError";
import { isFsAccessRefusal } from "../../../shared/fsAccessRefusal";
import { gitCommandError, runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type { createGithubService } from "../github/githubService";
import { canonicalGitOriginUrl, resolveGithubRemoteRepo } from "../github/githubSshAlias";
import { githubRepoSlugsEqual, parseGithubRemoteUrl, type GithubRepoSlug } from "../../../shared/githubRemote";
import { pathKey } from "../shared/pathCompare";
import { readGitConfigOriginUrl } from "./recentProjectSummary";
import { resolveGitMetadataDirectory } from "./worktreeParent";
import { initializeOrRepairAdeProject } from "./adeProjectService";
import { ensureProjectLocalDatabase } from "./projectLocalDatabase";
import { redactGitOutput } from "../../utils/redaction";

type GithubService = ReturnType<typeof createGithubService>;

const GITIGNORE_CONTENT = [
  "node_modules/",
  "dist/",
  "build/",
  ".DS_Store",
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
    if (isFsAccessRefusal(error)) {
      throw new AdeExpectedError(`ADE can't read the folder ${dirPath}. Choose a folder you can open.`, "user", { cause: error });
    }
    throw error;
  }
}

function isExistingDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Make sure `dirPath` is a folder, creating it and its parents when it is not.
 * On Windows, Node's recursive mkdir of a drive root that is there (`D:\`)
 * fails with EPERM, so a folder that exists is never made again; a folder this
 * account may not create is a plain answer naming it.
 */
function ensureDirectory(dirPath: string): void {
  if (isExistingDirectory(dirPath)) return;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    // Made meanwhile by someone else, or a root Node refused to make: it is there.
    if (isExistingDirectory(dirPath)) return;
    if (isFsAccessRefusal(error)) throw new AdeExpectedError(folderRefusalMessage(dirPath, error), "user", { cause: error });
    throw error;
  }
}

/**
 * Name the folder the refusal was about: the deepest one that is there, where
 * the new folder would have gone. A drive that is not there (`D:\projects` with
 * no `D:`) is named as missing.
 */
function folderRefusalMessage(dirPath: string, error: unknown): string {
  let existing = path.resolve((error as NodeJS.ErrnoException | null)?.path || dirPath);
  while (!isExistingDirectory(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return `ADE can't find ${existing} on this computer. Pick another location.`;
    existing = parent;
  }
  return `ADE can't create a folder in ${existing}. Pick another location.`;
}

type CloneTarget = {
  url: string;
  repo: GithubRepoSlug;
  parentDir: string;
  rootPath: string;
};

/** Where a clone of `input` lands, with the same checks and coded errors as the clone itself. */
async function resolveCloneTarget(input: CloneProjectInput): Promise<CloneTarget> {
  const url = (input.url ?? "").trim();
  if (!url) {
    throw codedError("Enter a GitHub repository URL.", "invalid_github_url");
  }
  const repo = await resolveGithubRemoteRepo(url);
  if (!repo) {
    throw codedError("Only GitHub repository URLs are supported.", "invalid_github_url");
  }
  const parentDir = (input.parentDir ?? "").trim();
  if (!parentDir.length) {
    throw new Error("Parent directory is required.");
  }
  const explicitName = (input.name ?? "").trim();
  const name = validateProjectName(explicitName.length > 0 ? explicitName : repo.repo);
  return { url, repo, parentDir, rootPath: path.join(parentDir, name) };
}

export type CloneRepositoryOptions = {
  /**
   * A folder that already holds a complete checkout of this repository is
   * the answer, with no clone. Without it, any folder there is `target_exists`.
   */
  reuseExistingCheckout?: boolean;
  /** Runs before a real clone only (not before a reuse or a join): a storage preflight. */
  beforeClone?: () => Promise<void>;
  /** Wraps a real clone only: a keep-awake hold. */
  wrapClone?: <T>(run: () => Promise<T>) => Promise<T>;
};

/**
 * Clones running in this process, by target folder. Module-wide because every
 * caller (desktop IPC, phone, CLI, brain RPC) makes its own service, and two
 * clones into one folder would race: the loser's rollback deletes the
 * winner's folder mid-clone.
 */
const clonesInFlight = new Map<string, { repo: GithubRepoSlug; result: Promise<CloneProjectResult> }>();

/**
 * True when `rootPath` is itself a complete checkout whose `origin` is `repo`
 * (https, ssh or an alias, any case). A clone killed part-way is not one.
 */
async function isCompleteCheckoutOf(rootPath: string, repo: GithubRepoSlug, logger: Logger): Promise<boolean> {
  // Reads `rootPath/.git` only, so a plain folder inside another checkout never
  // answers with that checkout's origin.
  const origin = readGitConfigOriginUrl(rootPath);
  if (!githubRepoSlugsEqual(parseGithubRemoteUrl(canonicalGitOriginUrl(origin)), repo)) return false;
  // `git clone` writes HEAD before it checks files out; the index appears only
  // when the checkout finishes, and `index.lock` is there while it runs.
  const gitDir = resolveGitMetadataDirectory(rootPath);
  if (!gitDir || !fs.existsSync(path.join(gitDir, "index")) || fs.existsSync(path.join(gitDir, "index.lock"))) return false;
  try {
    const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: rootPath, timeoutMs: 10_000 });
    return head.exitCode === 0;
  } catch (error) {
    // A real checkout then answers target_exists; say why.
    logger.warn("project_scaffold.clone_reuse_check_failed", {
      rootPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function createProjectScaffoldService({
  logger,
  githubService,
}: {
  logger: Logger;
  githubService: GithubService;
}) {
  let cachedRepos: { tokenHash: string; expiresAt: number; repos: MyGitHubRepoSummary[] } | null = null;

  const warmLocalDatabase = async (rootPath: string, eventName: string): Promise<void> => {
    try {
      await ensureProjectLocalDatabase(rootPath, logger);
    } catch (dbErr) {
      logger.warn(eventName, {
        rootPath,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
  };

  const createLocalProject = async (input: CreateProjectInput): Promise<CreateProjectResult> => {
    const name = validateProjectName(input.name);
    const parentDir = (input.parentDir ?? "").trim();
    if (!parentDir.length) {
      throw new Error("Parent directory is required.");
    }

    const rootPath = path.join(parentDir, name);

    if (fs.existsSync(rootPath) && isDirectoryNonEmpty(rootPath)) {
      throw codedError("A folder already exists at that path.", "target_exists");
    }

    // Track whether WE created the dir so failures only roll back our own work.
    // Without this, a partial scaffold (git init or README write) leaves a
    // non-empty dir that the `target_exists` guard rejects on retry.
    const preexisted = fs.existsSync(rootPath);
    ensureDirectory(rootPath);

    try {
      const initRes = await runGit(["init", "--initial-branch=main"], { cwd: rootPath, timeoutMs: 15_000 });
      if (initRes.exitCode !== 0) {
        const fallbackInit = await runGit(["init"], { cwd: rootPath, timeoutMs: 15_000 });
        if (fallbackInit.exitCode !== 0) {
          const raw = fallbackInit.stderr.trim();
          throw gitCommandError(raw, `git init failed: ${redactGitOutput(raw) || `exit ${fallbackInit.exitCode}`}`);
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
      initializeOrRepairAdeProject(rootPath, { logger, mode: "shared" });
      await warmLocalDatabase(rootPath, "project_scaffold.local_db_warm_failed");

      return { rootPath };
    } catch (err) {
      if (!preexisted) {
        try {
          fs.rmSync(rootPath, { recursive: true, force: true });
        } catch (cleanupErr) {
          logger.warn("project_scaffold.create_rollback_failed", {
            rootPath,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }
      throw err;
    }
  };

  /**
   * Clone `input` into its folder. A second clone into a folder whose clone
   * is still running waits for that one and gets the same folder (another
   * repository there is `target_exists`). `options` say what a real clone
   * needs; a join uses the running clone's.
   */
  const cloneRepository = async (
    input: CloneProjectInput,
    options: CloneRepositoryOptions = {},
  ): Promise<CloneProjectResult> => {
    const target = await resolveCloneTarget(input);
    return await joinOrClone(input, target, options, true);
  };

  const joinOrClone = async (
    input: CloneProjectInput,
    target: CloneTarget,
    options: CloneRepositoryOptions,
    retryAfterFailedJoin: boolean,
  ): Promise<CloneProjectResult> => {
    const key = pathKey(path.resolve(target.rootPath));
    const running = clonesInFlight.get(key);
    if (running) {
      if (!githubRepoSlugsEqual(running.repo, target.repo)) {
        throw codedError("A folder already exists at that path.", "target_exists");
      }
      if (!retryAfterFailedJoin) return await running.result;
      try {
        return await running.result;
      } catch (error) {
        // The joined clone failed with its own settings (another GitHub
        // sign-in, say). This request runs once with its own, and never again.
        logger.info("project_scaffold.clone_join_failed_retrying", {
          rootPath: target.rootPath,
          error: error instanceof Error ? error.message : String(error),
        });
        if (clonesInFlight.get(key) === running) clonesInFlight.delete(key);
        return await joinOrClone(input, target, options, false);
      }
    }
    const wrapClone = options.wrapClone ?? (<T,>(run: () => Promise<T>) => run());
    // No await between the lookup above and the set below, so two clones can't both start.
    const entry = {
      repo: target.repo,
      result: (async (): Promise<CloneProjectResult> => {
        if (options.reuseExistingCheckout && await isCompleteCheckoutOf(target.rootPath, target.repo, logger)) {
          return { rootPath: target.rootPath };
        }
        return await wrapClone(async () => {
          await options.beforeClone?.();
          return await cloneIntoTarget(input, target);
        });
      })(),
    };
    clonesInFlight.set(key, entry);
    try {
      return await entry.result;
    } finally {
      // A failure is shared with whoever joined, then forgotten, so a retry clones again.
      if (clonesInFlight.get(key) === entry) clonesInFlight.delete(key);
    }
  };

  const cloneIntoTarget = async (input: CloneProjectInput, target: CloneTarget): Promise<CloneProjectResult> => {
    const { url, parentDir, rootPath } = target;

    if (fs.existsSync(rootPath) && isDirectoryNonEmpty(rootPath)) {
      throw codedError("A folder already exists at that path.", "target_exists");
    }

    ensureDirectory(parentDir);

    // `git clone` may create rootPath and partially populate it before failing
    // (auth prompt aborted, network drop, signature check). Without rollback,
    // the partial dir trips `target_exists` on retry. Only clean up dirs we
    // created ourselves.
    const preexistedRoot = fs.existsSync(rootPath);

    // Inject the available GitHub token via http.extraheader so private-repo
    // clones work in environments without a system credential helper. Using
    // the basic-auth shape (x-access-token:<token>) is the GitHub-recommended
    // form and avoids leaking the token via the URL in process listings.
    let authHeader = (input.githubAuthHeader ?? "").trim();
    if (!authHeader) {
      try {
        const storedToken = await githubService.getGitTransportTokenOrThrowAsync();
        const basic = Buffer.from(`x-access-token:${storedToken}`, "utf8").toString("base64");
        authHeader = `basic ${basic}`;
      } catch {
        authHeader = "";
      }
    }

    // The header goes to this one command through Git's config environment
    // (`GIT_CONFIG_COUNT`/`KEY`/`VALUE`, Git 2.31+, the same on every
    // platform), never as `git clone -c …`: that form saves it in the new
    // repository's .git/config, where any process, agent or copy of the
    // folder can read the token. It also stays out of the command line that
    // process listings show. Later fetches and pushes sign in on their own
    // (`runGitWithGithubAuthFallback` passes ADE's token the same way).
    const cloneEnv: NodeJS.ProcessEnv = authHeader
      ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: ${authHeader}`,
      }
      : {};
    // `--` so a URL that starts with "-" cannot be read as a git option.
    const cloneArgs: string[] = ["clone", "--", url, rootPath];

    try {
      const cloneRes = await runGit(cloneArgs, {
        cwd: parentDir,
        timeoutMs: 5 * 60_000,
        env: cloneEnv,
      });
      if (cloneRes.exitCode !== 0) {
        // Git repeats the clone URL, query and all, so a token in it would reach the banner.
        throw new Error(redactGitOutput(cloneRes.stderr.trim()) || `git clone failed (exit ${cloneRes.exitCode})`);
      }

      if (authHeader) {
        // No token in the clone; a plain `git push` in a terminal there asks
        // ADE for it when it runs (`ade git credential`). Best effort: ADE's
        // own fetch, pull and push pass the token per command anyway.
        const helper = await runGit(["config", "--local", ADE_GIT_CREDENTIAL_HELPER_KEY, ADE_GIT_CREDENTIAL_HELPER], { cwd: rootPath, timeoutMs: 10_000 })
          .catch((error: unknown) => ({ exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }));
        if (helper.exitCode !== 0) logger.warn("project_scaffold.clone_credential_helper_failed", { error: redactGitOutput(String(helper.stderr ?? "")).slice(0, 200) });
      }

      initializeOrRepairAdeProject(rootPath, { logger, mode: "shared" });
      await warmLocalDatabase(rootPath, "project_scaffold.clone_local_db_warm_failed");

      return { rootPath };
    } catch (err) {
      if (!preexistedRoot) {
        try {
          fs.rmSync(rootPath, { recursive: true, force: true });
        } catch (cleanupErr) {
          logger.warn("project_scaffold.clone_rollback_failed", {
            rootPath,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }
      throw err;
    }
  };

  const listMyGitHubRepos = async (input: ListMyGitHubReposInput): Promise<ListMyGitHubReposResult> => {
    let token: string;
    try {
      token = await githubService.getReadTokenOrThrowAsync();
    } catch (err) {
      const wrapped = new Error("GitHub is not connected. Run gh auth login or add a PAT in Settings.") as Error & { code?: string };
      wrapped.code = "github_not_connected";
      (wrapped as any).cause = err;
      throw wrapped;
    }

    const tokenHash = hashToken(token);
    const now = Date.now();
    let repos: MyGitHubRepoSummary[];
    if (cachedRepos && cachedRepos.tokenHash === tokenHash && cachedRepos.expiresAt > now) {
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
      cachedRepos = { tokenHash, expiresAt: now + REPO_LIST_CACHE_TTL_MS, repos };
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
