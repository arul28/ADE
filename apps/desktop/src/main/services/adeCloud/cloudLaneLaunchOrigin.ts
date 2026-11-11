import type { CloudLaneLaunchCallRequest } from "../../../shared/cloudLaneLaunch";
import type { RemoteRuntimeProjectRecord } from "../../../shared/types/remoteRuntime";
import { runGit } from "../git/git";
import { readGitOriginUrlWithoutGit } from "../projects/recentProjectSummary";
import { getErrorMessage, isRecord } from "../shared/utils";
import type { Logger } from "../logging/logger";

/** Long enough for a slow machine to answer, short enough that Send never hangs on it. */
const ORIGIN_READ_TIMEOUT_MS = 5_000;
/** A launch list reads the origin each time; an answer is reused this long. */
const ORIGIN_CACHE_MS = 30_000;
const ORIGIN_CACHE_LIMIT = 64;

type CachedOrigin = { url: string | null; at: number };

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * The project's git origin for an ADE Cloud launch call, read one way for
 * every method (`start`, `list`), in this order:
 *
 * 1. the origin the launch carries (`args.cloud.originUrl`: what the
 *    composer checked before Send), so composer and main agree;
 * 2. the origin stamped on the source binding;
 * 3. a project on this computer: its git config file, else git's own answer
 *    (`git config --get remote.origin.url`, async, so a per-worktree config,
 *    an include or a quoted value never reads as "no origin");
 * 4. a project on another computer: that computer's own project list,
 *    through the binding's target (the machine the project lives on).
 *
 * Null when none of them names one. Never throws.
 */
export function createCloudLaneLaunchOriginReader(deps: {
  listProjects: (targetId: string) => Promise<RemoteRuntimeProjectRecord[]>;
  logger: Logger;
}) {
  const cache = new Map<string, CachedOrigin>();

  const cached = async (key: string, read: () => Promise<string | null>): Promise<string | null> => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ORIGIN_CACHE_MS) return hit.url;
    const url = await read();
    if (cache.size >= ORIGIN_CACHE_LIMIT) cache.clear();
    cache.set(key, { url, at: Date.now() });
    return url;
  };

  const readLocal = (rootPath: string): Promise<string | null> => {
    const fromFile = readGitOriginUrlWithoutGit(rootPath);
    if (fromFile !== undefined) return Promise.resolve(fromFile);
    return cached(`local:${rootPath}`, async () => {
      try {
        const result = await runGit(["config", "--get", "remote.origin.url"], {
          cwd: rootPath,
          timeoutMs: ORIGIN_READ_TIMEOUT_MS,
        });
        // Exit 1: no origin set at all.
        return result.exitCode === 0 ? trimmed(result.stdout) : null;
      } catch (error) {
        deps.logger.warn("cloud_lane_launch.origin_read_failed", { where: "local", error: getErrorMessage(error) });
        return null;
      }
    });
  };

  const readRemote = (project: { targetId: string; projectId: string }): Promise<string | null> =>
    cached(`remote:${project.targetId}:${project.projectId}`, async () => {
      try {
        const projects = await withTimeout(deps.listProjects(project.targetId), ORIGIN_READ_TIMEOUT_MS);
        return trimmed(projects.find((candidate) => candidate.projectId === project.projectId)?.gitOriginUrl);
      } catch (error) {
        deps.logger.warn("cloud_lane_launch.origin_read_failed", { where: "remote", error: getErrorMessage(error) });
        return null;
      }
    });

  return async (request: Partial<CloudLaneLaunchCallRequest>): Promise<string | null> => {
    const carried = isRecord(request.args) && isRecord(request.args.cloud) ? trimmed(request.args.cloud.originUrl) : null;
    if (carried) return carried;
    const source = isRecord(request.source) ? request.source : null;
    const stamped = trimmed(source?.gitOriginUrl);
    if (stamped) return stamped;
    const localRootPath = trimmed(source?.localRootPath);
    if (localRootPath) return readLocal(localRootPath);
    const remote = isRecord(source?.remoteProject) ? source.remoteProject : null;
    const targetId = trimmed(remote?.targetId);
    const projectId = trimmed(remote?.projectId);
    if (targetId && projectId) return readRemote({ targetId, projectId });
    return null;
  };
}
