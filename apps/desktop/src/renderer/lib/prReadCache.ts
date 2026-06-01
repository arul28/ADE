import type { GitHubPrSnapshot, PrSummary } from "../../shared/types";

type InFlightEntry<T> = {
  promise: Promise<T>;
};

const prListInFlight = new Map<string, InFlightEntry<PrSummary[]>>();
const githubSnapshotInFlight = new Map<string, InFlightEntry<GitHubPrSnapshot>>();
const prRefreshInFlight = new Map<string, InFlightEntry<PrSummary[]>>();
const prSurfaceWarmInFlight = new Map<string, InFlightEntry<void>>();

function projectKey(projectRoot: string | null | undefined): string {
  return projectRoot?.trim() || "active";
}

function coalesceInFlight<T>(
  cache: Map<string, InFlightEntry<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing.promise;

  let promise: Promise<T>;
  promise = load().finally(() => {
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
  });
  cache.set(key, { promise });
  return promise;
}

export function listPrsCoalesced(options?: { projectRoot?: string | null }): Promise<PrSummary[]> {
  return coalesceInFlight(
    prListInFlight,
    projectKey(options?.projectRoot),
    () => window.ade.prs.listAll(),
  );
}

export function getGitHubSnapshotCoalesced(
  args: { force?: boolean; includeExternalClosed?: boolean } = {},
  options?: { projectRoot?: string | null },
): Promise<GitHubPrSnapshot> {
  return coalesceInFlight(
    githubSnapshotInFlight,
    JSON.stringify({
      projectRoot: projectKey(options?.projectRoot),
      force: args.force === true,
      includeExternalClosed: args.includeExternalClosed === true,
    }),
    () => window.ade.prs.getGitHubSnapshot(args),
  );
}

export function refreshPrsCoalesced(
  args: { prId?: string; prIds?: string[] } = {},
  options?: { projectRoot?: string | null },
): Promise<PrSummary[]> {
  const prIds = args.prIds?.filter(Boolean).sort() ?? [];
  return coalesceInFlight(
    prRefreshInFlight,
    JSON.stringify({
      projectRoot: projectKey(options?.projectRoot),
      prId: args.prId ?? null,
      prIds,
    }),
    () => window.ade.prs.refresh(args),
  );
}

export function warmPrSurfaceCoalesced(options?: {
  projectRoot?: string | null;
  includeGithubSnapshot?: boolean;
  forceGithubSnapshot?: boolean;
}): Promise<void> {
  const rootKey = projectKey(options?.projectRoot);
  return coalesceInFlight(
    prSurfaceWarmInFlight,
    JSON.stringify({
      projectRoot: rootKey,
      includeGithubSnapshot: options?.includeGithubSnapshot !== false,
      forceGithubSnapshot: options?.forceGithubSnapshot === true,
    }),
    async () => {
      const tasks: Array<Promise<unknown>> = [
        refreshPrsCoalesced({}, { projectRoot: options?.projectRoot }).catch(() => null),
      ];
      if (options?.includeGithubSnapshot !== false) {
        tasks.push(
          getGitHubSnapshotCoalesced(
            { force: options?.forceGithubSnapshot === true },
            { projectRoot: options?.projectRoot },
          ).catch(() => null),
        );
      }
      await Promise.all(tasks);
    },
  );
}

export function clearPrReadInFlightForTest(): void {
  prListInFlight.clear();
  githubSnapshotInFlight.clear();
  prRefreshInFlight.clear();
  prSurfaceWarmInFlight.clear();
}
