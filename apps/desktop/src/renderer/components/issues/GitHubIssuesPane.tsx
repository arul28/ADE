import React, { useEffect, useMemo, useState } from "react";
import { CircleNotch, MagnifyingGlass } from "@phosphor-icons/react";
import { subscribeIssueCreated } from "../../lib/issueCreateRequests";
import { relativeWhen } from "../../lib/format";
import { LinearAssigneeAvatar } from "../app/LinearIssueBrowserRows";
import { GitHubIssueStateIcon } from "../lanes/githubBrand";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { IssueViewer } from "./IssueViewer";
import {
  useGitHubIssueList,
  type GitHubIssueDetail,
  type GitHubIssueStateFilter,
  type GitHubRepo,
} from "./githubIssueStore";

/**
 * The GitHub Issues pane body: the project's issues on the left, the issue
 * viewer on the right.
 *
 * One list read per state (ETag'd, so a re-open is a free 304) and every filter
 * runs on the loaded rows: GitHub's search API has its own 30-a-minute budget
 * and is easy to exhaust, so the pane never calls it.
 */

const STATE_FILTERS: Array<{ value: GitHubIssueStateFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const ANY = "";

function matches(issue: GitHubIssueDetail, query: string): boolean {
  if (!query) return true;
  const haystack = [
    `#${issue.number}`,
    issue.title,
    issue.author?.login ?? "",
    issue.milestone ?? "",
    ...issue.labels.map((label) => label.name),
    ...issue.assignees.map((entry) => entry.login),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <select
      aria-label={label}
      className="h-7 min-w-0 max-w-[140px] rounded-md border border-[color:var(--kit-rule)] bg-transparent px-1.5 text-[11.5px] text-fg/85 outline-none focus:border-[color:var(--color-accent)]"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value={ANY}>{label}: any</option>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}

export function GitHubIssuesPane({
  repo,
  refreshKey,
}: {
  repo: GitHubRepo;
  /** Bumped by the header's Refresh. */
  refreshKey: number;
}) {
  const [state, setState] = useState<GitHubIssueStateFilter>("open");
  const [query, setQuery] = useState("");
  const [assignee, setAssignee] = useState(ANY);
  const [label, setLabel] = useState(ANY);
  const [milestone, setMilestone] = useState(ANY);
  const [selected, setSelected] = useState<number | null>(null);
  const list = useGitHubIssueList(repo, state);
  const { refresh } = list;

  useEffect(() => {
    if (refreshKey > 0) refresh();
  }, [refresh, refreshKey]);

  // An issue made from this pane's "New" is shown here, in the open list.
  useEffect(() => subscribeIssueCreated((event) => {
    if (event.provider !== "github") return;
    if (event.owner.toLowerCase() !== repo.owner.toLowerCase() || event.repo.toLowerCase() !== repo.name.toLowerCase()) return;
    setState("open");
    setSelected(event.number);
  }), [repo.name, repo.owner]);

  const options = useMemo(() => {
    const assignees = new Set<string>();
    const labels = new Set<string>();
    const milestones = new Set<string>();
    for (const issue of list.issues) {
      for (const entry of issue.assignees) assignees.add(entry.login);
      for (const entry of issue.labels) labels.add(entry.name);
      if (issue.milestone) milestones.add(issue.milestone);
    }
    const sorted = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b));
    return { assignees: sorted(assignees), labels: sorted(labels), milestones: sorted(milestones) };
  }, [list.issues]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return list.issues.filter((issue) =>
      matches(issue, needle)
      && (assignee === ANY || issue.assignees.some((entry) => entry.login === assignee))
      && (label === ANY || issue.labels.some((entry) => entry.name === label))
      && (milestone === ANY || issue.milestone === milestone));
  }, [assignee, label, list.issues, milestone, query]);

  const selectedIssue = visible.find((issue) => issue.number === selected) ?? visible[0] ?? null;

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r border-[color:var(--kit-rule)]">
        <div className="flex shrink-0 flex-col gap-2 border-b border-[color:var(--kit-rule)] p-3">
          <label className="flex h-8 items-center gap-2 rounded-md border border-[color:var(--kit-rule)] px-2 text-[12px] focus-within:border-[color:var(--color-accent)]">
            <MagnifyingGlass size={13} className="shrink-0 text-[color:var(--kit-text-3)]" />
            <input
              className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-[color:var(--kit-text-3)]"
              placeholder="Filter issues…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Filter issues"
            />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="kit-seg" data-case="sentence" role="group" aria-label="Issue state">
              {STATE_FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={state === option.value}
                  onClick={() => setState(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <FilterSelect label="Assignee" value={assignee} options={options.assignees} onChange={setAssignee} />
            <FilterSelect label="Label" value={label} options={options.labels} onChange={setLabel} />
            <FilterSelect label="Milestone" value={milestone} options={options.milestones} onChange={setMilestone} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="Issues">
          {list.status === "error" && list.issues.length === 0 ? (
            <div className="p-2">
              <Banner
                layout="inline"
                model={{
                  id: "github-issues-error",
                  tone: "error",
                  title: "Couldn't load issues",
                  detail: list.error ?? "GitHub request failed.",
                  actions: [{ label: "Retry", onClick: refresh }],
                }}
              />
            </div>
          ) : list.status === "loading" && list.issues.length === 0 ? (
            <div className="flex items-center gap-2 p-3 text-[12px] text-[color:var(--kit-text-3)]">
              <CircleNotch size={13} className="animate-spin" /> Loading issues…
            </div>
          ) : visible.length === 0 ? (
            <p className="p-3 text-[12px] text-[color:var(--kit-text-3)]">No issues match.</p>
          ) : (
            visible.map((issue) => (
              <button
                key={issue.number}
                type="button"
                role="option"
                aria-selected={issue.number === selectedIssue?.number}
                className={cn(
                  "kit-row !items-start !gap-2 !py-2",
                  issue.number === selectedIssue?.number && "!bg-[color:var(--kit-active)]",
                )}
                onClick={() => setSelected(issue.number)}
              >
                <span className="mt-[2px]"><GitHubIssueStateIcon state={issue.state} stateReason={issue.stateReason} /></span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[12.5px] leading-snug text-fg/90">{issue.title}</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[color:var(--kit-text-3)]">
                    <span className="kit-num">#{issue.number}</span>
                    <span>·</span>
                    <span className="shrink-0">{relativeWhen(issue.updatedAt)}</span>
                    {issue.labels.slice(0, 3).map((entry) => (
                      <span
                        key={entry.name}
                        title={entry.name}
                        className="block h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: entry.color ?? "var(--kit-fill)" }}
                      />
                    ))}
                  </span>
                </span>
                {issue.assignees[0] ? (
                  <LinearAssigneeAvatar name={issue.assignees[0].login} avatarUrl={issue.assignees[0].avatarUrl} size={18} />
                ) : null}
              </button>
            ))
          )}
        </div>
        <div className="shrink-0 border-t border-[color:var(--kit-rule)] px-3 py-1.5 text-[11px] text-[color:var(--kit-text-3)]">
          <span className="kit-num">{visible.length}</span> of <span className="kit-num">{list.issues.length}</span> loaded
        </div>
      </div>
      <div className="min-h-0 min-w-0">
        {selectedIssue ? (
          <IssueViewer
            key={selectedIssue.number}
            issueRef={{ provider: "github", owner: repo.owner, repo: repo.name, number: selectedIssue.number, url: selectedIssue.url }}
            variant="pane"
            onOpenRelated={() => undefined}
          />
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-[color:var(--kit-text-3)]">Select an issue.</div>
        )}
      </div>
    </div>
  );
}
