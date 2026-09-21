/**
 * Shared GitHub REST Link-pagination budget.
 *
 * Historical issue/PR lists on a busy repo are thousands of pages. Both GitHub
 * service owners (desktop `githubService` and the runtime
 * `createHeadlessGitHubService`) must stop at the same cap, or a background
 * indexer / automation poller can spend the hourly quota on one walk.
 */

export const GITHUB_REST_LIST_MAX_PAGES = 10;
/** Default for `/issues` and `/pulls` lists; labels/collaborators keep the harder cap. */
export const GITHUB_REST_ISSUE_PR_LIST_MAX_PAGES = 5;

export function clampGithubRestListMaxPages(
  maxPages?: number,
  fallback: number = GITHUB_REST_LIST_MAX_PAGES,
): number {
  const raw = maxPages == null || !Number.isFinite(maxPages) ? fallback : Math.floor(maxPages);
  return Math.max(1, Math.min(raw, GITHUB_REST_LIST_MAX_PAGES));
}

/** True when a walk used every allowed page, so GitHub may still have more rows. */
export function githubRestListWalkFilledBudget(
  itemCount: number,
  perPage: number,
  maxPages: number,
): boolean {
  const size = Math.max(1, Math.floor(perPage));
  const pages = clampGithubRestListMaxPages(maxPages);
  return Number.isFinite(itemCount) && itemCount >= size * pages;
}

export function githubRestListPageReachedUpdatedBefore(
  batch: readonly unknown[],
  stopWhenUpdatedBefore?: string | null,
): boolean {
  if (!stopWhenUpdatedBefore) return false;
  const boundaryMs = Date.parse(stopWhenUpdatedBefore);
  if (!Number.isFinite(boundaryMs)) return false;
  return batch.some((item) => {
    if (!item || typeof item !== "object") return false;
    const updatedAt = (item as { updated_at?: unknown }).updated_at;
    if (typeof updatedAt !== "string" || !updatedAt) return false;
    const updatedAtMs = Date.parse(updatedAt);
    return Number.isFinite(updatedAtMs) && updatedAtMs <= boundaryMs;
  });
}

export async function collectGithubRestPages<T>(args: {
  fetchFirst: () => Promise<{ data: T[] | unknown; nextUrl: string | null }>;
  fetchNext: (nextUrl: string) => Promise<{ data: T[] | unknown; nextUrl: string | null }>;
  maxPages?: number;
  stopWhenUpdatedBefore?: string | null;
  sort?: string | number | boolean | null;
  direction?: string | number | boolean | null;
}): Promise<T[]> {
  const maxPages = clampGithubRestListMaxPages(args.maxPages);
  const deltaEnabled = args.sort === "updated" && args.direction === "desc";
  const first = await args.fetchFirst();
  const out: T[] = Array.isArray(first.data) ? [...first.data] : [];
  if (deltaEnabled && githubRestListPageReachedUpdatedBefore(out, args.stopWhenUpdatedBefore)) {
    return out;
  }
  let nextUrl = first.nextUrl;
  let pages = 1;
  while (nextUrl && pages < maxPages) {
    const next = await args.fetchNext(nextUrl);
    const batch = Array.isArray(next.data) ? next.data : [];
    out.push(...batch);
    pages += 1;
    if (deltaEnabled && githubRestListPageReachedUpdatedBefore(batch, args.stopWhenUpdatedBefore)) {
      break;
    }
    nextUrl = next.nextUrl;
  }
  return out;
}
