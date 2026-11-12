import React from "react";
import { ArrowClockwise, CircleNotch, GitPullRequest } from "@phosphor-icons/react";
import type { GithubDirectError, GithubDirectIssue, GithubDirectPull } from "../../../shared/types";
import { githubDirectStateCopy, type GithubDirectStateAction } from "../../../shared/github/githubDirectStateCopy";
import { useAccountGithubIssues, useAccountGithubPulls } from "../../lib/useAccountGithubReads";
import { startGithubAccountAppSignIn, useGithubAccountApp } from "../../lib/useGithubAccountApp";
import { relativeWhen } from "../../lib/format";
import { Banner, noticeKindModel } from "../ui/notice";
import { GitHubIssueStateIcon } from "../lanes/githubBrand";
import type { PrsRepoRef } from "./state/prsReader";

/**
 * Pull requests and issues read with the ADE account's own GitHub sign-in,
 * with no computer (the `direct` reader). Read only: every ADE action (land,
 * lanes, stacks, launch) needs a computer that has the project.
 */

const READ_ONLY_NOTE = "Read-only. Open ADE on a computer that has this project to work on these pull requests.";
const READ_ONLY_ISSUES_NOTE = "Read-only. Open ADE on a computer that has this project to work on these issues.";

function openOnGithub(url: string | null): void {
  // A browser link, not a machine action: no pin.
  if (url) void window.ade.app.openExternal(url);
}

const formatTime = (epochMs: number) => new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The state of a direct read (not connected, app missing, rate limit, GitHub down) as one status notice. */
function DirectGithubStateNotice({ error, repo, items, onRetry }: {
  error: GithubDirectError;
  repo: PrsRepoRef;
  items: "pull requests" | "issues";
  onRetry: () => void;
}) {
  const app = useGithubAccountApp();
  const copy = githubDirectStateCopy(error, {
    owner: repo.owner,
    name: repo.name,
    githubLogin: app.status?.githubLogin ?? null,
    formatTime,
    items,
  });
  // `not_found` and `invalid_request` need no notice: the list is empty.
  if (!copy) return null;
  const action = (entry: GithubDirectStateAction | null, secondary: boolean) => {
    if (!entry) return [];
    return [{
      label: entry.label,
      ...(secondary ? { variant: "secondary" as const } : {}),
      onClick: entry.kind === "connect"
        ? () => { void startGithubAccountAppSignIn(onRetry); }
        : () => openOnGithub(entry.url),
    }];
  };
  return (
    <Banner
      layout="inline"
      model={{
        id: `github-direct-${error.kind}`,
        ...noticeKindModel("status"),
        title: copy.title,
        detail: copy.body,
        actions: [...action(copy.primary, false), ...action(copy.secondary, true)],
      }}
    />
  );
}

type DirectRow = {
  number: number;
  title: string;
  author: string | null;
  updatedAt: string | null;
  url: string | null;
  icon: React.ReactNode;
  tag: string | null;
};

function DirectList({
  repo,
  note,
  noun,
  rows,
  error,
  loading,
  refreshing,
  truncated,
  onRefresh,
}: {
  repo: PrsRepoRef;
  note: string;
  noun: "pull requests" | "issues";
  rows: DirectRow[];
  error: GithubDirectError | null;
  loading: boolean;
  refreshing: boolean;
  truncated: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="github-direct-list">
      <div className="flex shrink-0 items-start gap-3 border-b border-[color:var(--kit-rule)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">{repo.owner}/{repo.name}</div>
          <p className="mt-0.5 text-[12px] text-[color:var(--kit-text-3)]">{note}</p>
        </div>
        <button
          type="button"
          className="kit-icon-btn shrink-0"
          aria-label={`Refresh ${noun}`}
          title={`Refresh ${noun}`}
          disabled={loading || refreshing}
          onClick={onRefresh}
        >
          {refreshing ? <CircleNotch size={14} className="animate-spin" /> : <ArrowClockwise size={14} />}
        </button>
      </div>
      {error ? (
        <div className="shrink-0 px-4 pt-3">
          <DirectGithubStateNotice error={error} repo={repo} items={noun} onRetry={onRefresh} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5" role="list" aria-label={noun}>
        {loading && rows.length === 0 ? (
          <div className="flex items-center gap-2 p-3 text-[12px] text-[color:var(--kit-text-3)]">
            <CircleNotch size={13} className="animate-spin" /> Loading {noun}…
          </div>
        ) : rows.length === 0 ? (
          error ? null : <p className="p-3 text-[12px] text-[color:var(--kit-text-3)]">No open {noun}.</p>
        ) : (
          rows.map((row) => (
            <div key={row.number} role="listitem">
              <button
                type="button"
                className="kit-row !items-start !gap-2 !py-2 w-full text-left"
                title={row.url ? "Open on GitHub" : undefined}
                disabled={!row.url}
                onClick={() => openOnGithub(row.url)}
              >
                <span className="mt-[2px] shrink-0">{row.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[12.5px] leading-snug text-fg/90">{row.title}</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[color:var(--kit-text-3)]">
                    <span className="kit-num">#{row.number}</span>
                    {row.author ? <span className="truncate">{row.author}</span> : null}
                    {row.updatedAt ? <span className="shrink-0">updated {relativeWhen(row.updatedAt)}</span> : null}
                    {row.tag ? <span className="kit-tag shrink-0">{row.tag}</span> : null}
                  </span>
                </span>
              </button>
            </div>
          ))
        )}
        {truncated && rows.length > 0 ? (
          <p className="p-3 text-[11px] text-[color:var(--kit-text-3)]">Showing the newest {rows.length}. Open GitHub to see all of them.</p>
        ) : null}
      </div>
    </div>
  );
}

function pullRow(pull: GithubDirectPull): DirectRow {
  return {
    number: pull.number,
    title: pull.title,
    author: pull.user?.login ?? null,
    updatedAt: pull.updatedAt,
    url: pull.htmlUrl,
    icon: <GitPullRequest size={14} className={pull.draft ? "text-[color:var(--kit-text-3)]" : "text-[color:var(--color-success,#3FB950)]"} />,
    tag: pull.draft ? "Draft" : null,
  };
}

function issueRow(issue: GithubDirectIssue): DirectRow {
  return {
    number: issue.number,
    title: issue.title,
    author: issue.user?.login ?? null,
    updatedAt: issue.updatedAt,
    url: issue.htmlUrl,
    icon: <GitHubIssueStateIcon state={issue.state} stateReason={null} />,
    tag: null,
  };
}

/** The open pull requests of `repo`; a null repo reads nothing (the page is hidden). */
export function DirectPrsList({ repo }: { repo: PrsRepoRef | null }) {
  const read = useAccountGithubPulls(repo, { state: "open" });
  const rows = React.useMemo(() => read.pulls.map(pullRow), [read.pulls]);
  if (!repo) return null;
  return (
    <DirectList
      repo={repo}
      note={READ_ONLY_NOTE}
      noun="pull requests"
      rows={rows}
      error={read.error}
      loading={read.loading}
      refreshing={read.refreshing}
      truncated={read.truncated}
      onRefresh={() => void read.refresh()}
    />
  );
}

/** The open issues of `repo`; a null repo reads nothing. */
export function DirectIssuesList({ repo }: { repo: PrsRepoRef | null }) {
  const read = useAccountGithubIssues(repo, { state: "open" });
  const rows = React.useMemo(() => read.issues.map(issueRow), [read.issues]);
  if (!repo) return null;
  return (
    <DirectList
      repo={repo}
      note={READ_ONLY_ISSUES_NOTE}
      noun="issues"
      rows={rows}
      error={read.error}
      loading={read.loading}
      refreshing={read.refreshing}
      truncated={read.truncated}
      onRefresh={() => void read.refresh()}
    />
  );
}
