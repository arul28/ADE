import { runGit } from "../git/git";
import { canonicalGitOriginUrl } from "../github/githubSshAlias";
import type { Logger } from "../logging/logger";
import { readGitOriginUrl } from "./recentProjectSummary";

/**
 * Which repository a project is, for code in this app's main process.
 *
 * A project is the repository, not one machine's folder: a window tab can be
 * bound to a copy on another machine, and its binding can lack the origin
 * (a tab restored from older saved state, or one the renderer built from an
 * origin it did not remember yet). So the answer comes, in order, from:
 *
 * 1. the origin the caller already holds (stamped on the binding);
 * 2. this computer's copy: the git config file, then `git config` itself
 *    when the file alone cannot settle it (an `[include]`, per-worktree
 *    config, a quoted value). Git writes `extensions.worktreeConfig` for lane
 *    worktrees, so a strict file read alone refuses ADE's own repository;
 * 3. the machine that holds the copy, from the project list its brain sends.
 *
 * Null means none of them knows an origin: the project has none, or its
 * machine is offline. The result is the canonical form (an SSH alias of
 * GitHub becomes its `github.com` form).
 */
export type ProjectRepoOriginSource = {
  gitOriginUrl?: string | null;
  /** This computer's copy of the project. */
  localRootPath?: string | null;
  /** The copy on another machine, for a tab bound there. */
  remote?: { targetId: string; projectId: string } | null;
};

export type ProjectRepoOriginDeps = {
  /** The brain's project list of a paired machine; throws when it cannot answer. */
  remoteProjects?: (targetId: string) => Promise<ReadonlyArray<{ projectId: string; gitOriginUrl?: string | null }>>;
  logger?: Pick<Logger, "warn">;
};

const GIT_CONFIG_TIMEOUT_MS = 5_000;
const REMOTE_PROJECTS_TIMEOUT_MS = 8_000;

function cleanOrigin(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? canonicalGitOriginUrl(trimmed) : null;
}

/** This computer's copy: the config file first (no process), then git. */
export async function readLocalProjectOrigin(rootPath: string, logger?: Pick<Logger, "warn">): Promise<string | null> {
  const fromFile = readGitOriginUrl(rootPath);
  if (fromFile) return fromFile;
  try {
    const result = await runGit(["config", "--get", "remote.origin.url"], { cwd: rootPath, timeoutMs: GIT_CONFIG_TIMEOUT_MS });
    // Exit 1 means "no such key": a project with no origin, not a failure.
    if (result.exitCode !== 0) return null;
    return cleanOrigin(result.stdout);
  } catch (error) {
    logger?.warn("project_repo_origin.local_git_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function resolveProjectRepoOrigin(
  source: ProjectRepoOriginSource | null | undefined,
  deps: ProjectRepoOriginDeps = {},
): Promise<string | null> {
  if (!source) return null;
  const stamped = cleanOrigin(source.gitOriginUrl);
  if (stamped) return stamped;

  const localRootPath = typeof source.localRootPath === "string" ? source.localRootPath.trim() : "";
  if (localRootPath) return await readLocalProjectOrigin(localRootPath, deps.logger);

  const remote = source.remote;
  if (remote?.targetId && remote.projectId && deps.remoteProjects) {
    try {
      const projects = await withTimeout(deps.remoteProjects(remote.targetId), REMOTE_PROJECTS_TIMEOUT_MS);
      return cleanOrigin(projects.find((project) => project.projectId === remote.projectId)?.gitOriginUrl ?? null);
    } catch (error) {
      // Offline or too old to answer: the project still is the repository,
      // this process just cannot learn which one right now.
      deps.logger?.warn("project_repo_origin.remote_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  return null;
}
