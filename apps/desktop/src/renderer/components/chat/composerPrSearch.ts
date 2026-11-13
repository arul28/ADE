import type { OpenProjectBinding } from "../../../shared/types";
import type { ComposerPrSuggestion } from "./ChatCommandMenu";

/**
 * The composer's pull-request suggestions from the PR list of the machine
 * `pin` names. An empty query browses; digits match the number; anything else
 * matches the title. A failed read is an empty menu section, not an error.
 */
export async function searchComposerPullRequests(
  pin: OpenProjectBinding,
  query: string,
): Promise<ComposerPrSuggestion[]> {
  try {
    const all = await window.ade.prs.listAll?.(pin);
    if (!all?.length) return [];
    const trimmed = query.trim().toLowerCase();
    const digits = /^\d+$/.test(trimmed);
    const matches = all.filter((pr) => {
      if (pr.detached) return false;
      if (!trimmed) return true;
      if (digits) return String(pr.githubPrNumber).startsWith(trimmed);
      return (pr.title ?? "").toLowerCase().includes(trimmed)
        || String(pr.githubPrNumber).startsWith(trimmed);
    });
    return matches.slice(0, 20).map((pr) => ({
      number: pr.githubPrNumber,
      title: pr.title ?? "",
      state: pr.state,
      url: pr.githubUrl || `https://github.com/${pr.repoOwner}/${pr.repoName}/pull/${pr.githubPrNumber}`,
      repo: pr.repoOwner && pr.repoName ? `${pr.repoOwner}/${pr.repoName}` : undefined,
    }));
  } catch {
    return [];
  }
}
