import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CircleNotch, GithubLogo, MagnifyingGlass } from "@phosphor-icons/react";

import {
  githubIssueIdentifier,
  githubIssueToLaneIssue,
} from "../../../shared/laneGitHubIssue";
import type { LaneGitHubIssue } from "../../../shared/types";
import { canOpenInAdeBrowser, openExternalUrl, openUrlInAdeBrowser } from "../../lib/openExternal";
import { cn } from "../ui/cn";
import { GITHUB_BRAND } from "../lanes/githubBrand";

type IssueStateFilter = "open" | "closed" | "all";

function matchesQuery(issue: LaneGitHubIssue, query: string): boolean {
  if (!query) return true;
  const haystack = [
    githubIssueIdentifier(issue),
    `#${issue.number}`,
    issue.title,
    issue.authorLogin ?? "",
    ...issue.labels,
    ...issue.assignees,
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

export function GitHubIssueBrowser({
  selectedIssue,
  mode,
  actionLabel = "Attach issue",
  actionDisabled = false,
  refreshKey = 0,
  onLoadingChange,
  onRepoChange,
  onIssueAction,
  onRemoveIssue,
}: {
  selectedIssue: LaneGitHubIssue | null;
  mode: "attach" | "details";
  actionLabel?: string;
  actionDisabled?: boolean;
  refreshKey?: number;
  onLoadingChange?: (loading: boolean) => void;
  onRepoChange?: (repo: { owner: string; name: string } | null) => void;
  onIssueAction: (issue: LaneGitHubIssue) => void;
  onRemoveIssue?: (issue: LaneGitHubIssue) => void;
}) {
  const [repo, setRepo] = useState<{ owner: string; name: string } | null>(null);
  const [issues, setIssues] = useState<LaneGitHubIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<IssueStateFilter>("open");
  const [focusedIssueId, setFocusedIssueId] = useState<string | null>(selectedIssue?.id ?? null);

  const setBusy = useCallback((next: boolean) => {
    setLoading(next);
    onLoadingChange?.(next);
  }, [onLoadingChange]);

  const load = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const detected = await window.ade.github.detectRepo();
      setRepo(detected);
      onRepoChange?.(detected);
      if (!detected) {
        setIssues(selectedIssue ? [selectedIssue] : []);
        return;
      }
      const rows = await window.ade.github.listRepoIssues({
        owner: detected.owner,
        name: detected.name,
        state: stateFilter,
      });
      const mapped = rows
        .map((row) => githubIssueToLaneIssue(detected.owner, detected.name, row))
        .filter((issue): issue is LaneGitHubIssue => Boolean(issue));
      setIssues(
        selectedIssue && !mapped.some((issue) => issue.id === selectedIssue.id)
          ? [selectedIssue, ...mapped]
          : mapped,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setIssues(selectedIssue ? [selectedIssue] : []);
    } finally {
      setBusy(false);
    }
  }, [onRepoChange, selectedIssue, setBusy, stateFilter]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    setFocusedIssueId(selectedIssue?.id ?? null);
  }, [selectedIssue?.id]);

  const visibleIssues = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return issues.filter((issue) => matchesQuery(issue, normalized));
  }, [issues, query]);

  const focusedIssue = visibleIssues.find((issue) => issue.id === focusedIssueId)
    ?? selectedIssue
    ?? visibleIssues[0]
    ?? null;

  if (mode === "details") {
    if (!selectedIssue) {
      return (
        <div className="flex h-full items-center justify-center text-[13px] text-muted-fg/60">
          No GitHub issue selected.
        </div>
      );
    }
    return (
      <IssueDetails
        issue={selectedIssue}
        onRemove={onRemoveIssue ? () => onRemoveIssue(selectedIssue) : undefined}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlass
            size={12}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-fg/45"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={repo ? `Search ${repo.owner}/${repo.name} issues` : "Search GitHub issues"}
            className="h-8 w-full rounded-md border border-white/10 bg-white/[0.04] pl-7 pr-3 text-[12px] text-fg outline-none placeholder:text-muted-fg/35"
          />
        </div>
        <div className="flex shrink-0 rounded-md border border-white/10 p-0.5">
          {(["open", "closed", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={cn(
                "rounded px-2 py-1 text-[11px] capitalize",
                stateFilter === value ? "bg-white/10 text-fg" : "text-muted-fg/60",
              )}
              onClick={() => setStateFilter(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <div className="border-b border-red-400/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-200/85">
          {error}
        </div>
      ) : null}
      {!repo && !loading ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-fg/60">
          GitHub issue attach is available on project chats with a detected repository.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {loading && issues.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted-fg/50">
              <CircleNotch size={12} className="animate-spin" />
              Loading issues…
            </div>
          ) : visibleIssues.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-muted-fg/45">No issues match this search.</div>
          ) : (
            visibleIssues.map((issue) => {
              const active = issue.id === focusedIssue?.id;
              return (
                <button
                  key={issue.id}
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-2 text-left",
                    active ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
                  )}
                  onClick={() => setFocusedIssueId(issue.id)}
                  onDoubleClick={() => {
                    if (!actionDisabled) onIssueAction(issue);
                  }}
                >
                  <span
                    className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded"
                    style={{ background: GITHUB_BRAND.surfaceHover, color: GITHUB_BRAND.primaryBright }}
                  >
                    <GithubLogo size={11} weight="fill" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-fg/80">{githubIssueIdentifier(issue)}</span>
                      <span className="rounded px-1.5 py-0.5 text-[10px] capitalize text-muted-fg/70" style={{ background: "rgba(255,255,255,0.06)" }}>
                        {issue.state}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-fg/90">{issue.title}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/10 px-3 py-2">
        <button
          type="button"
          className="ade-shell-control inline-flex h-7 items-center rounded-md px-2.5 text-[12px]"
          disabled={actionDisabled || !focusedIssue}
          onClick={() => {
            if (focusedIssue && !actionDisabled) onIssueAction(focusedIssue);
          }}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

function IssueDetails({
  issue,
  onRemove,
}: {
  issue: LaneGitHubIssue;
  onRemove?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="flex items-center gap-2">
          <span
            className="grid h-6 w-6 place-items-center rounded-md"
            style={{ background: GITHUB_BRAND.surfaceHover, color: GITHUB_BRAND.primaryBright }}
          >
            <GithubLogo size={13} weight="fill" />
          </span>
          <span className="font-mono text-[12px] text-fg/80">{githubIssueIdentifier(issue)}</span>
          <span className="rounded px-1.5 py-0.5 text-[10px] capitalize text-muted-fg/70" style={{ background: "rgba(255,255,255,0.06)" }}>
            {issue.state}
          </span>
        </div>
        <h2 className="mt-3 text-[18px] font-semibold text-fg">{issue.title}</h2>
        {issue.labels.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {issue.labels.map((label) => (
              <span key={label} className="rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-fg/80" style={{ background: "rgba(255,255,255,0.06)" }}>
                {label}
              </span>
            ))}
          </div>
        ) : null}
        {issue.body?.trim() ? (
          <pre className="mt-4 whitespace-pre-wrap font-sans text-[13px] leading-6 text-fg/80">{issue.body}</pre>
        ) : (
          <p className="mt-4 text-[13px] text-muted-fg/50">No description.</p>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/10 px-3 py-2">
        <button
          type="button"
          className="ade-shell-control inline-flex h-7 items-center rounded-md px-2.5 text-[12px]"
          data-variant="ghost"
          onClick={() => {
            if (canOpenInAdeBrowser(issue.url)) openUrlInAdeBrowser(issue.url);
            else openExternalUrl(issue.url);
          }}
        >
          Open
        </button>
        {onRemove ? (
          <button
            type="button"
            className="ade-shell-control inline-flex h-7 items-center rounded-md px-2.5 text-[12px]"
            data-variant="ghost"
            onClick={onRemove}
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}
