import React, { useEffect, useMemo, useState } from "react";
import { Check, CircleNotch, MagnifyingGlass, Rocket } from "@phosphor-icons/react";
import type { JiraIssueListState, JiraIssueSummary } from "../../../shared/types/jira";
import { parseJiraError, jiraErrorMessage } from "../../../shared/jiraErrors";
import { subscribeIssueCreated } from "../../lib/issueCreateRequests";
import { useJiraIssueList, useJiraProjects } from "./jiraIssueStore";
import { relativeWhen } from "../../lib/format";
import { LinearAssigneeAvatar } from "../app/LinearIssueBrowserRows";
import { JiraStatusIcon } from "../lanes/jiraBrand";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { settingsRouteFor } from "../settings/settingsManifest";
import { useAppStore, useActiveProjectRoot } from "../../state/appStore";
import { ChipPicker } from "./issuePickerChip";
import { buildJiraLaunchIssue } from "../../lib/linearBatchLaunch";
import { useIssueLaunchSelection } from "./useIssueLaunchSelection";

// The viewer (markdown, proof media) loads when an issue is first opened, as in
// the GitHub pane: the Jira button sits in the top bar, which every window loads.
const IssueViewer = React.lazy(() => import("./IssueViewer").then((module) => ({ default: module.IssueViewer })));

const STATE_FILTERS: Array<{ value: JiraIssueListState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

function matches(issue: JiraIssueSummary, query: string): boolean {
  if (!query) return true;
  return `${issue.key} ${issue.title} ${issue.projectKey} ${issue.status.name} ${issue.assignee?.displayName ?? ""} ${issue.labels.join(" ")}`
    .toLowerCase()
    .includes(query);
}

function listError(id: string, title: string, error: string | null, retry: () => void) {
  const parsed = parseJiraError(error);
  const retryAt = parsed?.retryAt ? new Date(parsed.retryAt) : null;
  const retryTime = retryAt && Number.isFinite(retryAt.getTime()) ? retryAt.toLocaleTimeString() : null;
  const actions = [] as Array<{ label: string; onClick: () => void }>;
  let detail = parsed?.message ?? error ?? "Jira request failed.";
  if (parsed?.reason === "not-connected") {
    detail = "Connect this Jira site in Settings to load its issues.";
    actions.push({ label: "Connect Jira", onClick: () => { window.location.hash = `#${settingsRouteFor("integrations.jira")}`; } });
  } else if (parsed?.reason === "unauthenticated") {
    detail = "Update the saved Jira API token in Settings.";
    actions.push({ label: "Jira settings", onClick: () => { window.location.hash = `#${settingsRouteFor("integrations.jira")}`; } });
  } else if (parsed?.reason === "forbidden") {
    detail = "Ask a Jira administrator for access to these projects.";
  } else if (parsed?.reason === "rate-limited") {
    detail = retryTime ? `Try again after ${retryTime}. ${detail}` : detail;
  }
  actions.push({ label: "Retry", onClick: retry });
  return {
    id,
    tone: parsed?.reason === "failed" ? "error" as const : "warning" as const,
    title,
    detail,
    actions,
  };
}

export function JiraIssuesPane({ siteUrl, refreshKey }: { siteUrl: string; refreshKey: number }) {
  const projectRoot = useActiveProjectRoot();
  const project = useAppStore((state) => state.project);
  const [state, setState] = useState<JiraIssueListState>("open");
  const [mine, setMine] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [boundProjectKeys, setBoundProjectKeys] = useState<string[]>([]);
  const [projectConfigError, setProjectConfigError] = useState<string | null>(null);
  const [projectConfigLoaded, setProjectConfigLoaded] = useState(false);
  const [projectConfigRefresh, setProjectConfigRefresh] = useState(0);
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const projectCatalog = useJiraProjects(true, siteUrl);
  const availableProjects = useMemo(() => projectCatalog.projects.length
    ? projectCatalog.projects
    : boundProjectKeys.map((key) => ({ key, name: key, id: key, avatarUrl: null })), [boundProjectKeys, projectCatalog.projects]);
  const projectOptions = useMemo(() => [
    { id: "", label: boundProjectKeys.length ? "Bound projects" : "All projects" },
    ...availableProjects.map((entry) => ({ id: entry.key, label: `${entry.key} · ${entry.name}`, keywords: entry.name })),
  ], [availableProjects, boundProjectKeys.length]);
  const selectedProject = availableProjects.find((entry) => entry.key === selectedProjectKey);
  const projectDisplay = selectedProject?.key || selectedProjectKey || (boundProjectKeys.length ? "Bound projects" : "All projects");
  const projectKeys = selectedProjectKey ? [selectedProjectKey] : boundProjectKeys;
  const filters = useMemo(() => ({
    projectKeys,
    state,
    assignee: mine ? "me" as const : "any" as const,
    query: debouncedQuery,
  }), [boundProjectKeys, debouncedQuery, mine, selectedProjectKey, state]);
  const list = useJiraIssueList(filters, projectConfigLoaded && !projectConfigError, siteUrl);

  useEffect(() => {
    let cancelled = false;
    setProjectConfigLoaded(false);
    setProjectConfigError(null);
    void window.ade.projectConfig.get()
      .then((snapshot) => {
        if (cancelled) return;
        const keys = snapshot.effective.issueTrackers?.jira?.projectKeys ?? [];
        setBoundProjectKeys(keys);
        setProjectConfigLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProjectConfigError(jiraErrorMessage(error, "Couldn't load this project's Jira settings."));
        setProjectConfigLoaded(true);
      });
    return () => { cancelled = true; };
  }, [projectConfigRefresh, projectRoot, project?.rootPath]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (refreshKey > 0) list.refresh();
  }, [list.refresh, refreshKey]);

  useEffect(() => subscribeIssueCreated((issue) => {
    if (issue.provider !== "jira" || issue.siteUrl.toLowerCase() !== siteUrl.toLowerCase()) return;
    setState("open");
    setMine(false);
    setQuery("");
    setDebouncedQuery("");
    if (issue.projectKey) setSelectedProjectKey(issue.projectKey);
    setSelectedKey(issue.key);
  }), [siteUrl]);

  const visible = useMemo(
    () => list.issues.filter((issue) => matches(issue, debouncedQuery)),
    [debouncedQuery, list.issues],
  );
  const {
    selectedCount: launchSelectedCount,
    isSelected: isLaunchSelected,
    toggleAt: toggleLaunchSelection,
    launchSelectedIssues,
  } = useIssueLaunchSelection({
    visibleItems: visible,
    launchItems: list.issues,
    getKey: (issue: JiraIssueSummary) => issue.key,
    toLaunchIssue: (issue: JiraIssueSummary) => buildJiraLaunchIssue(issue, siteUrl),
  });
  const selectedKeyToShow = visible.some((issue) => issue.key === selectedKey)
    ? selectedKey
    : visible[0]?.key ?? selectedKey;
  const selectedIssue = visible.find((issue) => issue.key === selectedKeyToShow) ?? null;

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
      <div className="relative flex min-h-0 flex-col border-r border-[color:var(--kit-rule)]">
        <div className="flex shrink-0 flex-col gap-2 border-b border-[color:var(--kit-rule)] p-3">
          <label className="flex h-8 items-center gap-2 rounded-md border border-[color:var(--kit-rule)] px-2 text-[12px] focus-within:border-[color:var(--color-accent)]">
            <MagnifyingGlass size={13} className="shrink-0 text-[color:var(--kit-text-3)]" />
            <input
              className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-[color:var(--kit-text-3)]"
              placeholder="Filter Jira issues…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Filter Jira issues"
            />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="kit-seg" data-case="sentence" role="group" aria-label="Issue state">
              {STATE_FILTERS.map((option) => (
                <button key={option.value} type="button" aria-pressed={state === option.value} onClick={() => setState(option.value)}>
                  {option.label}
                </button>
              ))}
            </div>
            <ChipPicker
              label="Jira project"
              display={projectDisplay}
              options={projectOptions}
              selected={[selectedProjectKey]}
              placeholder="Project…"
              onPick={setSelectedProjectKey}
            />
            <ChipPicker
              label="Assignee"
              display={mine ? "Mine" : "Anyone"}
              options={[{ id: "any", label: "Anyone" }, { id: "me", label: "Assigned to me" }]}
              selected={[mine ? "me" : "any"]}
              placeholder="Assignee…"
              onPick={(id) => setMine(id === "me")}
            />
          </div>
          {projectConfigError ? (
            <Banner layout="inline" model={{
              id: "jira-project-config-error",
              tone: "warning",
              title: "Couldn't load Jira project bindings",
              detail: projectConfigError,
              actions: [{ label: "Retry", onClick: () => setProjectConfigRefresh((value) => value + 1) }],
            }} />
          ) : null}
          {projectCatalog.error ? (
            <Banner layout="inline" model={{
              id: "jira-projects-error",
              tone: "warning",
              title: "Couldn't load Jira projects",
              detail: projectCatalog.error,
              actions: [{ label: "Retry", onClick: () => { void projectCatalog.refresh().catch(() => {}); } }],
            }} />
          ) : null}
        </div>
        <div className={cn("min-h-0 flex-1 overflow-y-auto p-1.5", launchSelectedCount > 0 && "pb-12")} role="list" aria-label="Jira issues">
          {list.status === "error" && list.issues.length === 0 ? (
            <div className="p-2"><Banner layout="inline" model={listError("jira-issues-error", "Couldn't load Jira issues", list.error, list.refresh)} /></div>
          ) : !projectConfigLoaded || projectCatalog.loading || (list.status === "loading" && list.issues.length === 0) ? (
            <div className="flex items-center gap-2 p-3 text-[12px] text-[color:var(--kit-text-3)]"><CircleNotch size={13} className="animate-spin" /> Loading Jira issues…</div>
          ) : list.status === "error" ? (
            <div className="p-2"><Banner layout="inline" model={listError("jira-issues-refresh-error", "Showing loaded issues; refresh failed", list.error, list.refresh)} /></div>
          ) : visible.length === 0 ? (
            <p className="p-3 text-[12px] text-[color:var(--kit-text-3)]">No Jira issues match.</p>
          ) : (
            visible.map((issue, index) => (
              <div key={issue.key} role="listitem">
                <div className={cn(
                  "group/row kit-row !items-start !gap-2 !py-2",
                  issue.key === selectedKeyToShow && "!bg-[color:var(--kit-active)]",
                  isLaunchSelected(issue.key) && "!bg-[color:var(--kit-hover)]",
                )}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-label={isLaunchSelected(issue.key) ? `Deselect ${issue.key}` : `Select ${issue.key} for launch`}
                    aria-checked={isLaunchSelected(issue.key)}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleLaunchSelection(issue.key, index, event.shiftKey);
                    }}
                    className="-ml-1 grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md outline-none focus-visible:bg-fg/[0.06]"
                  >
                    <span className={cn(
                      "flex h-[14px] w-[14px] items-center justify-center rounded-[3px] border transition-colors",
                      isLaunchSelected(issue.key)
                        ? "border-[color:var(--color-accent,#A78BFA)] bg-[color:var(--color-accent,#A78BFA)]"
                        : launchSelectedCount > 0
                          ? "border-fg/[0.18] bg-transparent group-hover/row:border-white/35"
                          : "border-fg/[0.12] bg-transparent group-hover/row:border-white/35",
                    )}>
                      {isLaunchSelected(issue.key) ? <Check size={10} weight="bold" className="text-accent-fg" /> : null}
                    </span>
                  </button>
                  <button type="button" className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={() => setSelectedKey(issue.key)}>
                    <span className="mt-[2px]"><JiraStatusIcon category={issue.status.category} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[12.5px] leading-snug text-fg/90">{issue.title}</span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[color:var(--kit-text-3)]">
                        <span className="kit-num">{issue.key}</span>
                        <span>·</span>
                        <span className="shrink-0">{relativeWhen(issue.updatedAt)}</span>
                        {issue.labels.slice(0, 3).map((label) => <span key={label} title={label} className="max-w-[72px] truncate rounded-full border border-[color:var(--kit-rule)] px-1">{label}</span>)}
                      </span>
                    </span>
                    {issue.assignee ? <LinearAssigneeAvatar name={issue.assignee.displayName} avatarUrl={issue.assignee.avatarUrl} size={18} /> : null}
                  </button>
                </div>
              </div>
            ))
          )}
          {list.nextCursor ? (
            <button type="button" className="kit-btn kit-btn-ghost mx-auto mt-1 flex" disabled={list.promise != null} onClick={list.loadMore}>
              {list.promise ? <CircleNotch size={12} className="animate-spin" /> : null}
              Load more
            </button>
          ) : null}
        </div>
        {launchSelectedCount > 0 ? (
          <div className="absolute bottom-[30px] left-2 right-2 z-10">
            <div className="kit-card">
              <div className="kit-card-body flex items-center gap-2 px-2 py-1.5" data-flush="true">
                <span className="min-w-0 flex-1 text-[11px] text-[color:var(--kit-text-2)]">{launchSelectedCount} selected</span>
                <button type="button" className="kit-btn kit-btn-ghost h-7 px-2 text-[10.5px]" onClick={() => launchSelectedIssues(false)}>
                  <Rocket size={12} /> Launch agents ({launchSelectedCount})
                </button>
                <button type="button" className="kit-btn kit-btn-ghost h-7 px-2 text-[10.5px]" onClick={() => launchSelectedIssues(true)}>
                  Lanes only ({launchSelectedCount})
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <div className="shrink-0 border-t border-[color:var(--kit-rule)] px-3 py-1.5 text-[11px] text-[color:var(--kit-text-3)]">
          <span className="kit-num">{visible.length}</span> of <span className="kit-num">{list.issues.length}</span> loaded
        </div>
      </div>
      <div className="min-h-0 min-w-0">
        {selectedKeyToShow ? (
          <React.Suspense fallback={null}>
          <IssueViewer
            key={`${siteUrl}:${selectedKeyToShow}`}
            issueRef={{
              provider: "jira",
              siteUrl,
              key: selectedKeyToShow,
              ...(selectedIssue?.url ? { url: selectedIssue.url } : {}),
            }}
            variant="pane"
            onOpenRelated={(ref) => { if (ref.provider === "jira") setSelectedKey(ref.key); }}
          />
          </React.Suspense>
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-[color:var(--kit-text-3)]">Select an issue.</div>
        )}
      </div>
    </div>
  );
}
