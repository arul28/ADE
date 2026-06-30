import type { GitHubPrSnapshot, PrSummary } from "../../shared/types";

type InFlightEntry<T> = {
  promise: Promise<T>;
};

const prListInFlight = new Map<string, InFlightEntry<PrSummary[]>>();
const githubSnapshotInFlight = new Map<string, InFlightEntry<GitHubPrSnapshot>>();
const prRefreshInFlight = new Map<string, InFlightEntry<PrSummary[]>>();
const prSurfaceWarmInFlight = new Map<string, InFlightEntry<void>>();
const linkedPrRefreshInFlight = new Map<string, InFlightEntry<PrSummary | null>>();
const linkedPrRecentRefresh = new Map<string, { refreshedAt: number; result: PrSummary | null }>();

export const LINKED_PR_LIVE_REFRESH_COOLDOWN_MS = 5_000;

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

export function refreshLinkedPrCoalesced(
  pr: PrSummary,
  options?: {
    projectRoot?: string | null;
    force?: boolean;
    cooldownMs?: number;
  },
): Promise<PrSummary | null> {
  const prId = String(pr.id ?? "").trim();
  if (!prId) return Promise.resolve(null);

  const key = JSON.stringify({
    projectRoot: projectKey(options?.projectRoot),
    prId,
  });
  const cooldownMs = Math.max(0, options?.cooldownMs ?? LINKED_PR_LIVE_REFRESH_COOLDOWN_MS);
  const recent = linkedPrRecentRefresh.get(key);
  if (!options?.force && recent && Date.now() - recent.refreshedAt < cooldownMs) {
    return Promise.resolve(recent.result);
  }

  return coalesceInFlight(
    linkedPrRefreshInFlight,
    key,
    async () => {
      try {
        const refreshed = await refreshPrsCoalesced({ prIds: [prId] }, { projectRoot: options?.projectRoot });
        const result = refreshed.find((next) => next.id === prId) ?? null;
        linkedPrRecentRefresh.set(key, { refreshedAt: Date.now(), result });
        return result;
      } catch (error) {
        linkedPrRecentRefresh.set(key, { refreshedAt: Date.now(), result: pr });
        throw error;
      }
    },
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
  linkedPrRefreshInFlight.clear();
  linkedPrRecentRefresh.clear();
}
