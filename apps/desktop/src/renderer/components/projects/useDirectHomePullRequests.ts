import { useMemo } from "react";
import type { GithubDirectPull } from "../../../shared/types";
import { githubDirectStateCopy } from "../../../shared/github/githubDirectStateCopy";
import { useAccountGithubPulls } from "../../lib/useAccountGithubReads";
import { startGithubAccountAppSignIn } from "../../lib/useGithubAccountApp";
import type { PrsRepoRef } from "../prs/state/prsReader";
import { homePullRequestLists, type HomePr, type HomePullRequests } from "./ProjectWelcomeHome";

/**
 * The pull request card's rows when no computer reads the repository: the
 * account's own GitHub sign-in (`window.ade.githubDirect`), read only. The
 * page of a repository tab with no computer online shows it, so a user with
 * no computer (ADE Web) still sees the project's pull requests.
 *
 * Two reads, open and closed (for "merged this week"), through the shared
 * store: the PRs tab reads the same open list, so the two share one read and
 * one timer (60 s, only while the window shows). With `repo` null it reads
 * nothing.
 */
export function useDirectHomePullRequests(repo: PrsRepoRef | null): HomePullRequests {
  const openRead = useAccountGithubPulls(repo, { state: "open" });
  const closedRead = useAccountGithubPulls(repo, { state: "closed" });
  const openPulls = openRead.pulls;
  const closedPulls = closedRead.pulls;
  const error = openRead.error ?? closedRead.error;
  const loading = openRead.loading || closedRead.loading;
  const refreshing = openRead.refreshing || closedRead.refreshing;
  const refreshOpen = openRead.refresh;
  const refreshClosed = closedRead.refresh;
  const owner = repo?.owner ?? null;
  const name = repo?.name ?? null;
  return useMemo(() => {
    const repoLabel = name ?? "";
    const prs = [...openPulls, ...closedPulls].map((pull) => homePrFromDirectPull(pull, owner ?? "", repoLabel));
    // The copy names the next step (connect GitHub, install the App, wait for
    // the rate limit). `not_found` and `invalid_request` have none: the list is
    // empty.
    const copy = error ? githubDirectStateCopy(error, { owner: owner ?? undefined, name: name ?? undefined }) : null;
    const retry = () => {
      void refreshOpen();
      void refreshClosed();
    };
    const primary = copy?.primary ?? null;
    return {
      ...homePullRequestLists(prs, null),
      loaded: !loading,
      error: copy ? copy.body : null,
      // A browser link or the GitHub sign-in, not a machine action: no pin.
      errorAction: primary
        ? {
          label: primary.label,
          onClick: primary.kind === "connect"
            ? () => { void startGithubAccountAppSignIn(retry); }
            : () => { void window.ade.app.openExternal(primary.url); },
        }
        : null,
      retrying: refreshing,
      retry,
    };
  }, [openPulls, closedPulls, error, loading, refreshing, refreshOpen, refreshClosed, owner, name]);
}

function homePrFromDirectPull(pull: GithubDirectPull, owner: string, repo: string): HomePr {
  const state: HomePr["state"] = pull.merged || pull.mergedAt ? "merged" : pull.state === "closed" ? "closed" : pull.draft ? "draft" : "open";
  return {
    id: `direct:${owner}/${repo}#${pull.number}`,
    number: pull.number,
    title: pull.title,
    repo,
    state,
    isDraft: pull.draft,
    updatedAt: pull.updatedAt ?? pull.createdAt ?? "",
    mergedAt: pull.mergedAt,
    author: pull.user?.login ?? null,
    laneName: null,
    additions: null,
    deletions: null,
    tracked: null,
    htmlUrl: pull.htmlUrl,
  };
}
