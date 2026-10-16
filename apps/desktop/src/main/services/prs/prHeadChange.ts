import { asString, getErrorMessage } from "../shared/utils";
import type { GitHubRepoRef } from "../../../shared/types/git";
import type { LandHeadChange } from "../../../shared/types/prs";
import { isHeadModifiedMergeError } from "./resolverUtils";

/**
 * A merge carries the PR head SHA the user looked at (`expectedHeadSha`). When
 * the head has moved past it, nothing may merge: the user has not seen the new
 * commits. This finds that case, says what landed, and refreshes ADE's copy of
 * the PR so the next merge click carries the new head.
 */

/** How many of a moved head's new commits a refused merge reports back. */
const NEW_COMMIT_LIMIT = 10;

export type PrHeadChangeDeps = {
  githubService: {
    apiRequest: <T>(args: {
      method: "GET";
      path: string;
      query?: Record<string, string | number | boolean | undefined | null>;
    }) => Promise<{ data: T }>;
  };
  logger: { warn: (event: string, meta?: Record<string, unknown>) => void };
  fetchPr: (repo: GitHubRepoRef, prNumber: number, options: { fresh: true }) => Promise<any>;
  getRowForRepoPr: (repoOwner: string, repoName: string, prNumber: number) => { id: string } | null;
  refreshOne: (prId: string) => Promise<unknown>;
};

export type PrHeadChangeDetector = {
  /**
   * The head's move past `expectedHeadSha`, or null when it has not moved or
   * no SHA was given. Pass `knownHeadSha` when the caller just read the PR;
   * otherwise this reads it fresh.
   */
  detect: (
    repo: GitHubRepoRef,
    prNumber: number,
    expectedHeadSha: string | null | undefined,
    knownHeadSha?: string | null,
  ) => Promise<LandHeadChange | null>;
  /** The head move behind a merge GitHub refused with `rawMsg`, or null when the refusal was for something else. */
  afterMergeRefusal: (
    repo: GitHubRepoRef,
    prNumber: number,
    expectedHeadSha: string | null | undefined,
    rawMsg: string,
  ) => Promise<LandHeadChange | null>;
};

/** What a merge refused for a moved PR head tells the user. */
export function formatHeadChangeMessage(change: LandHeadChange): string {
  if (change.history === "rewritten") return "The PR branch was rewritten (force-pushed) after you loaded it. Nothing was merged.";
  const count = change.totalNewCommits;
  return count > 0
    ? `${count} new commit${count === 1 ? "" : "s"} landed on the PR after you loaded it. Nothing was merged.`
    : "The PR changed after you loaded it. Nothing was merged.";
}

export function createPrHeadChangeDetector(deps: PrHeadChangeDeps): PrHeadChangeDetector {
  const { githubService, logger } = deps;

  /** Best effort: a garbage-collected old head still yields a usable result. */
  const describe = async (repo: GitHubRepoRef, expectedHeadSha: string, currentHeadSha: string): Promise<LandHeadChange> => {
    const base: LandHeadChange = { expectedHeadSha, currentHeadSha, history: "unknown", newCommits: [], totalNewCommits: 0 };
    const path = `/repos/${repo.owner}/${repo.name}/compare/${expectedHeadSha}...${currentHeadSha}`;
    try {
      const { data } = await githubService.apiRequest<any>({ method: "GET", path });
      let commits: any[] = Array.isArray(data?.commits) ? data.commits : [];
      const total = Number(data?.ahead_by ?? commits.length) || commits.length;
      // An unpaginated compare lists at most 250 commits, oldest first. For a
      // longer push, read the last page so the newest commits are the ones shown.
      if (total > commits.length) {
        const lastPage = Math.ceil(total / NEW_COMMIT_LIMIT);
        const pages = await Promise.all(
          [lastPage - 1, lastPage].filter((page) => page >= 1).map((page) =>
            githubService.apiRequest<any>({ method: "GET", path, query: { per_page: NEW_COMMIT_LIMIT, page } })
              .then(({ data: pageData }) => (Array.isArray(pageData?.commits) ? pageData.commits : []))),
        );
        commits = pages.flat();
      }
      const status = asString(data?.status);
      return {
        ...base,
        // `diverged`: a rebase or force-push. `behind`: the head was reset back.
        history: status === "diverged" || status === "behind" ? "rewritten" : "appended",
        totalNewCommits: total,
        newCommits: commits.slice(-NEW_COMMIT_LIMIT).map((commit) => ({
          sha: asString(commit?.sha),
          title: asString(commit?.commit?.message).split("\n")[0] ?? "",
          author: asString(commit?.author?.login) || asString(commit?.commit?.author?.name) || null,
          committedAt: asString(commit?.commit?.committer?.date) || null,
        })),
      };
    } catch (error) {
      logger.warn("prs.land_head_change_compare_failed", { repo: `${repo.owner}/${repo.name}`, error: getErrorMessage(error) });
      return base;
    }
  };

  const detect: PrHeadChangeDetector["detect"] = async (repo, prNumber, expectedHeadSha, knownHeadSha) => {
    const expected = asString(expectedHeadSha).trim();
    if (!expected) return null;
    const currentHeadSha = knownHeadSha !== undefined
      ? asString(knownHeadSha).trim()
      : asString((await deps.fetchPr(repo, prNumber, { fresh: true }).catch(() => null))?.head?.sha).trim();
    if (!currentHeadSha || currentHeadSha === expected) return null;
    const change = await describe(repo, expected, currentHeadSha);
    const row = deps.getRowForRepoPr(repo.owner, repo.name, prNumber);
    if (row) {
      await deps.refreshOne(row.id).catch((error) => {
        logger.warn("prs.land_head_change_refresh_failed", { prId: row.id, error: getErrorMessage(error) });
      });
    }
    return change;
  };

  return {
    detect,
    afterMergeRefusal: async (repo, prNumber, expectedHeadSha, rawMsg) =>
      isHeadModifiedMergeError(rawMsg) ? await detect(repo, prNumber, expectedHeadSha) : null,
  };
}
