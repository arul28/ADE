import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AgentChatContextAttachment, GitHubIssueTypeOption, GitHubIssueWriteAccess, GitHubRepoIssueSummary, LaneGitHubIssue } from "../../../shared/types";
import type { GitHubIssueTemplateSet } from "../../../shared/githubIssueTemplates";
import { makeGitHubIssueContextAttachment } from "../../../shared/chatContextAttachments";
import { githubIssueId, type GitHubIssueCommentLike, type GitHubIssueLike, type GitHubIssuePatch } from "../../../shared/laneGitHubIssue";
import { createIssueEntryCache, errorMessage, type IssueEntry } from "./issueEntryCache";
import { useActiveProjectRoot } from "../../state/appStore";

/**
 * GitHub issues, read the way the issue viewer needs them, inside GitHub's
 * request budget.
 *
 * - An issue and its comments are REST GETs, which the main process sends
 *   with the last ETag: an unchanged issue answers 304 and costs no quota.
 * - A list is one GraphQL page (one point), cached for `LIST_STALE_MS`.
 * - Nothing polls. An entry is read when a view asks, again when it is older
 *   than `STALE_MS` and a view asks again, and on Refresh.
 * - The top-bar badge comes from one GraphQL point (`getRepoIssueSummary`),
 *   kept on disk and re-read at most every `SUMMARY_STALE_MS`.
 */

const STALE_MS = 60_000;
const LIST_STALE_MS = 60_000;
const SUMMARY_STALE_MS = 15 * 60_000;
const MAX_ENTRIES = 80;

export type GitHubRepo = { owner: string; name: string };

export type GitHubIssueLabel = { name: string; color: string | null };
export type GitHubIssuePerson = { login: string; avatarUrl: string | null };

export type GitHubIssueDetail = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed";
  /** `completed`, `not_planned`, `duplicate`, `reopened`, or null. */
  stateReason: string | null;
  labels: GitHubIssueLabel[];
  assignees: GitHubIssuePerson[];
  author: GitHubIssuePerson | null;
  milestone: string | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** GitHub numbers issues and pull requests from one sequence. */
  isPullRequest: boolean;
};

export type GitHubIssueComment = {
  id: number;
  body: string;
  url: string | null;
  author: GitHubIssuePerson | null;
  createdAt: string;
};

function person(value: { login?: string; avatar_url?: string | null } | null | undefined): GitHubIssuePerson | null {
  const login = value?.login?.trim();
  return login ? { login, avatarUrl: value?.avatar_url ?? null } : null;
}

export function normalizeGitHubIssue(owner: string, repo: string, raw: GitHubIssueLike | null | undefined): GitHubIssueDetail | null {
  if (!raw || typeof raw.number !== "number" || !raw.title || !raw.html_url) return null;
  const labels = (raw.labels ?? [])
    .map((label) => (typeof label === "string"
      ? { name: label, color: null }
      : label?.name ? { name: label.name, color: label.color ? `#${label.color.replace(/^#/, "")}` : null } : null))
    .filter((label): label is GitHubIssueLabel => label != null);
  return {
    owner,
    repo,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    url: raw.html_url,
    state: raw.state === "closed" ? "closed" : "open",
    stateReason: raw.state_reason ?? null,
    labels,
    assignees: (raw.assignees ?? []).map(person).filter((entry): entry is GitHubIssuePerson => entry != null),
    author: person(raw.user),
    milestone: raw.milestone?.title ?? null,
    commentCount: typeof raw.comments === "number" ? raw.comments : 0,
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    closedAt: raw.closed_at ?? null,
    isPullRequest: raw.pull_request != null,
  };
}

/** The lane-issue shape chat attachments and lane links carry. */
export function githubIssueDetailToLaneIssue(issue: GitHubIssueDetail): LaneGitHubIssue {
  return {
    id: githubIssueId(issue.owner, issue.repo, issue.number),
    number: issue.number,
    owner: issue.owner,
    repo: issue.repo,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: issue.state,
    stateReason: issue.stateReason,
    labels: issue.labels.map((label) => label.name),
    assignees: issue.assignees.map((entry) => entry.login),
    authorLogin: issue.author?.login ?? null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

export function githubIssueToContextAttachment(issue: GitHubIssueDetail): AgentChatContextAttachment {
  return makeGitHubIssueContextAttachment(githubIssueDetailToLaneIssue(issue));
}

function normalizeComment(raw: GitHubIssueCommentLike): GitHubIssueComment | null {
  if (typeof raw.id !== "number" || !raw.created_at) return null;
  return {
    id: raw.id,
    body: raw.body ?? "",
    url: raw.html_url ?? null,
    author: person(raw.user),
    createdAt: raw.created_at,
  };
}


const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ── One issue ─────────────────────────────────────────────────────────── */

export type GitHubIssueEntry = IssueEntry<GitHubIssueDetail>;

const entries = createIssueEntryCache<GitHubIssueDetail>({ maxEntries: MAX_ENTRIES, staleMs: STALE_MS, notify });

function issueKey(projectRoot: string | null, owner: string, repo: string, number: number): string {
  return `${projectRoot ?? ""}::${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

/** Store a copy read elsewhere (a list row, a create), so it shows at once. */
export function primeGitHubIssue(
  projectRoot: string | null,
  issue: GitHubIssueDetail,
  options: { partial?: boolean } = {},
): void {
  const key = issueKey(projectRoot, issue.owner, issue.repo, issue.number);
  const current = entries.peek(key);
  if (current && current.updatedAt >= issue.updatedAt) return;
  // A list row carries only the first labels and assignees. It shows at once,
  // but counts as never read (`fetchedAt: 0`): opening it reads the whole issue,
  // and edits that replace a set wait for that read.
  entries.write(key, { status: "ready", issue, error: null, fetchedAt: options.partial ? 0 : Date.now() });
}

/** Whether the held copy is a whole issue (read on its own), not a list row. */
export function isCompleteGitHubIssue(entry: { fetchedAt: number }): boolean {
  return entry.fetchedAt > 0;
}

export function loadGitHubIssue(
  projectRoot: string | null,
  owner: string,
  repo: string,
  number: number,
  options: { force?: boolean } = {},
): Promise<GitHubIssueDetail | null> {
  const read = window.ade?.github?.getIssue;
  return entries.load(
    issueKey(projectRoot, owner, repo, number),
    read ? async () => normalizeGitHubIssue(owner, repo, await read({ owner, name: repo, number })) : null,
    { unavailable: "GitHub is not available here.", failed: "GitHub request failed." },
    options,
  );
}

export function peekGitHubIssue(projectRoot: string | null, owner: string, repo: string, number: number): GitHubIssueDetail | null {
  return entries.peek(issueKey(projectRoot, owner, repo, number));
}

export function useGitHubIssue(ref: { owner: string; repo: string; number: number } | null): GitHubIssueEntry & {
  refresh: () => void;
  projectRoot: string | null;
} {
  const projectRoot = useActiveProjectRoot();
  const key = ref ? issueKey(projectRoot, ref.owner, ref.repo, ref.number) : null;
  const entry = useSyncExternalStore(subscribe, () => entries.read(key), () => entries.empty);
  const owner = ref?.owner ?? null;
  const repo = ref?.repo ?? null;
  const number = ref?.number ?? null;
  // A list refresh can replace the whole copy with a newer partial row while
  // the issue is open; that read again is what lets editing come back.
  const partial = entry.issue != null && !isCompleteGitHubIssue(entry);
  useEffect(() => {
    if (!owner || !repo || !number) return;
    ensureIssueEventSubscription();
    void loadGitHubIssue(projectRoot, owner, repo, number);
  }, [number, owner, partial, projectRoot, repo]);
  const refresh = useCallback(() => {
    if (owner && repo && number) void loadGitHubIssue(projectRoot, owner, repo, number, { force: true });
  }, [number, owner, projectRoot, repo]);
  return { ...entry, refresh, projectRoot };
}

/** The cached copy only, for chips and hover cards that must not fetch. */
export function useGitHubIssuePeek(ref: { owner: string; repo: string; number: number } | null): GitHubIssueDetail | null {
  const projectRoot = useActiveProjectRoot();
  const key = ref ? issueKey(projectRoot, ref.owner, ref.repo, ref.number) : null;
  return useSyncExternalStore(subscribe, () => (key ? entries.peek(key) : null), () => null);
}

export async function loadGitHubIssueComments(owner: string, repo: string, number: number): Promise<GitHubIssueComment[]> {
  const read = window.ade?.github?.listIssueComments;
  if (!read) return [];
  const rows = await read({ owner, name: repo, number });
  return (rows ?? []).map(normalizeComment).filter((comment): comment is GitHubIssueComment => comment != null);
}

/* ── The project's repository ──────────────────────────────────────────── */

type RepoEntry = { repo: GitHubRepo | null; promise: Promise<GitHubRepo | null> | null; checked: boolean };
const repos = new Map<string, RepoEntry>();
const EMPTY_REPO: RepoEntry = { repo: null, promise: null, checked: false };

function loadProjectRepo(projectRoot: string): Promise<GitHubRepo | null> {
  const current = repos.get(projectRoot);
  if (current?.promise) return current.promise;
  if (current?.checked) return Promise.resolve(current.repo);
  const detect = window.ade?.github?.detectRepo;
  if (!detect) return Promise.resolve(null);
  const promise = detect()
    .then((repo) => {
      repos.set(projectRoot, { repo: repo ? { owner: repo.owner, name: repo.name } : null, promise: null, checked: true });
      notify();
      return repo ?? null;
    })
    .catch(() => {
      repos.set(projectRoot, { repo: null, promise: null, checked: true });
      notify();
      return null;
    });
  repos.set(projectRoot, { repo: null, promise, checked: false });
  return promise;
}

/** The GitHub repository behind this project's origin, or null. */
export function useProjectGitHubRepo(): { repo: GitHubRepo | null; checked: boolean } {
  const projectRoot = useActiveProjectRoot();
  const entry = useSyncExternalStore(
    subscribe,
    () => (projectRoot ? repos.get(projectRoot) ?? EMPTY_REPO : EMPTY_REPO),
    () => EMPTY_REPO,
  );
  useEffect(() => {
    if (projectRoot) void loadProjectRepo(projectRoot);
  }, [projectRoot]);
  return { repo: entry.repo, checked: entry.checked };
}

/* ── Badge summary: issues enabled + open count ─────────────────────────── */

const SUMMARY_STORAGE_PREFIX = "ade.github.issueSummary.v1:";
type SummaryEntry = { summary: GitHubRepoIssueSummary | null; checkedAt: number; promise: Promise<void> | null };
const summaries = new Map<string, SummaryEntry>();
const EMPTY_SUMMARY: SummaryEntry = { summary: null, checkedAt: 0, promise: null };

function repoKey(repo: GitHubRepo): string {
  return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
}

function readStoredSummary(key: string): SummaryEntry | null {
  try {
    const raw = window.localStorage.getItem(`${SUMMARY_STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { summary?: GitHubRepoIssueSummary | null; checkedAt?: number };
    if (typeof parsed.checkedAt !== "number") return null;
    return { summary: parsed.summary ?? null, checkedAt: parsed.checkedAt, promise: null };
  } catch {
    return null;
  }
}

/** Re-read the summary now (pane open, Refresh) or when it has gone stale. */
export function refreshGitHubIssueSummary(repo: GitHubRepo, options: { force?: boolean } = {}): void {
  const key = repoKey(repo);
  let current = summaries.get(key);
  if (!current) {
    current = readStoredSummary(key) ?? undefined;
    if (current) summaries.set(key, current);
  }
  if (current?.promise) return;
  if (!options.force && current && Date.now() - current.checkedAt < SUMMARY_STALE_MS) return;
  const read = window.ade?.github?.getRepoIssueSummary;
  if (!read) return;
  const promise = read({ owner: repo.owner, name: repo.name })
    .then((summary) => {
      const next: SummaryEntry = { summary, checkedAt: Date.now(), promise: null };
      summaries.set(key, next);
      try {
        window.localStorage.setItem(`${SUMMARY_STORAGE_PREFIX}${key}`, JSON.stringify({ summary, checkedAt: next.checkedAt }));
      } catch {
        // Still cached in memory.
      }
    })
    .catch(() => {
      // Keep the last answer; try again after the stale window rather than
      // retrying a failing read on every render.
      summaries.set(key, { summary: current?.summary ?? null, checkedAt: Date.now(), promise: null });
    })
    .finally(notify);
  summaries.set(key, { summary: current?.summary ?? null, checkedAt: current?.checkedAt ?? 0, promise });
  notify();
}

export function useGitHubIssueSummary(repo: GitHubRepo | null): GitHubRepoIssueSummary | null {
  const key = repo ? repoKey(repo) : null;
  const entry = useSyncExternalStore(subscribe, () => (key ? summaries.get(key) ?? EMPTY_SUMMARY : EMPTY_SUMMARY), () => EMPTY_SUMMARY);
  const owner = repo?.owner ?? null;
  const name = repo?.name ?? null;
  useEffect(() => {
    if (!owner || !name) return undefined;
    refreshGitHubIssueSummary({ owner, name });
    // A focus after the stale window is the only re-read; nothing ticks.
    const onFocus = () => refreshGitHubIssueSummary({ owner, name });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [name, owner]);
  return entry.summary;
}

/* ── Lists ─────────────────────────────────────────────────────────────── */
// Lists come from GraphQL's issues connection (`listRepoIssueList`): REST
// `/issues` mixes in pull requests and its page cap can fill with them.

export type GitHubIssueStateFilter = "open" | "closed" | "all";

type ListEntry = {
  issues: GitHubIssueDetail[];
  fetchedAt: number;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  promise: Promise<void> | null;
};
const lists = new Map<string, ListEntry>();
const EMPTY_LIST: ListEntry = { issues: [], fetchedAt: 0, status: "idle", error: null, promise: null };

function listKey(repo: GitHubRepo, state: GitHubIssueStateFilter): string {
  return `${repoKey(repo)}:${state}`;
}

export function loadGitHubIssueList(
  projectRoot: string | null,
  repo: GitHubRepo,
  state: GitHubIssueStateFilter,
  options: { force?: boolean } = {},
): void {
  const key = listKey(repo, state);
  const current = lists.get(key);
  if (current?.promise) return;
  if (!options.force && current?.status === "ready" && Date.now() - current.fetchedAt < LIST_STALE_MS) return;
  const read = window.ade?.github?.listRepoIssueList;
  if (!read) return;
  const promise = read({ owner: repo.owner, name: repo.name, state })
    .then((rows) => {
      const issues = (rows ?? [])
        .map((row) => normalizeGitHubIssue(repo.owner, repo.name, row))
        .filter((issue): issue is GitHubIssueDetail => issue != null && !issue.isPullRequest);
      for (const issue of issues) primeGitHubIssue(projectRoot, issue, { partial: true });
      lists.set(key, { issues, fetchedAt: Date.now(), status: "ready", error: null, promise: null });
    })
    .catch((error: unknown) => {
      lists.set(key, {
        issues: current?.issues ?? [],
        fetchedAt: current?.fetchedAt ?? 0,
        status: "error",
        error: errorMessage(error, "GitHub request failed."),
        promise: null,
      });
    })
    .finally(notify);
  lists.set(key, { ...(current ?? EMPTY_LIST), status: current?.issues.length ? current.status : "loading", promise });
  notify();
}

export function useGitHubIssueList(repo: GitHubRepo | null, state: GitHubIssueStateFilter): ListEntry & { refresh: () => void } {
  const projectRoot = useActiveProjectRoot();
  const key = repo ? listKey(repo, state) : null;
  const entry = useSyncExternalStore(subscribe, () => (key ? lists.get(key) ?? EMPTY_LIST : EMPTY_LIST), () => EMPTY_LIST);
  const owner = repo?.owner ?? null;
  const name = repo?.name ?? null;
  useEffect(() => {
    if (!owner || !name) return;
    ensureIssueEventSubscription();
    loadGitHubIssueList(projectRoot, { owner, name }, state);
  }, [entry.fetchedAt, name, owner, projectRoot, state]);
  const refresh = useCallback(() => {
    if (owner && name) loadGitHubIssueList(projectRoot, { owner, name }, state, { force: true });
  }, [name, owner, projectRoot, state]);
  return { ...entry, refresh };
}

/* ── Webhook push ──────────────────────────────────────────────────────── */

let issueEventsSubscribed = false;

/**
 * Re-read what an `issues` / `issue_comment` webhook says changed. Only issues
 * a view has already read are refreshed (one ETag'd GET each), and the repo's
 * lists and badge count are marked stale so the next look re-reads them.
 * Nothing is fetched for an issue nobody has open.
 */
function ensureIssueEventSubscription(): void {
  if (issueEventsSubscribed || typeof window === "undefined") return;
  const subscribeToPrEvents = window.ade?.prs?.onEvent;
  if (!subscribeToPrEvents) return;
  issueEventsSubscribed = true;
  subscribeToPrEvents((event) => {
    if (event.type !== "github-issue-changed") return;
    const owner = event.repoOwner.toLowerCase();
    const repo = event.repoName.toLowerCase();
    const suffix = `::${owner}/${repo}#${event.issueNumber}`;
    for (const key of [...entries.entries.keys()]) {
      if (!key.endsWith(suffix)) continue;
      const projectRoot = key.slice(0, key.length - suffix.length) || null;
      void loadGitHubIssue(projectRoot, event.repoOwner, event.repoName, event.issueNumber, { force: true });
    }
    markRepoIssuesStale(owner, repo);
  });
}

/** Lists and the badge re-read at the next look; mounted lists re-read now. */
function markRepoIssuesStale(owner: string, repo: string): void {
  const repoId = repoKey({ owner, name: repo });
  for (const [key, list] of lists) {
    if (key.startsWith(`${repoId}:`)) lists.set(key, { ...list, fetchedAt: 0 });
  }
  const summary = summaries.get(repoId);
  if (summary) summaries.set(repoId, { ...summary, checkedAt: 0 });
  notify();
}

/**
 * An issue ADE just created: shown at the top of the open lists at once, then
 * the lists and the badge re-read (no webhook may come for it).
 */
export function noteGitHubIssueCreated(projectRoot: string | null, issue: GitHubIssueDetail): void {
  primeGitHubIssue(projectRoot, issue);
  const repo = { owner: issue.owner, name: issue.repo };
  for (const state of ["open", "all"] as const) {
    const key = listKey(repo, state);
    const list = lists.get(key);
    if (list) lists.set(key, { ...list, issues: [issue, ...list.issues.filter((entry) => entry.number !== issue.number)] });
  }
  markRepoIssuesStale(issue.owner, issue.repo);
  refreshGitHubIssueSummary(repo, { force: true });
}

/* ── Writing ───────────────────────────────────────────────────────────── */

const WRITE_ACCESS_STALE_MS = 15 * 60_000;
/** Labels, people and milestones change rarely; read again after this. */
const REPO_CATALOG_STALE_MS = 15 * 60_000;

type WriteAccessEntry = { access: GitHubIssueWriteAccess | null; checkedAt: number; promise: Promise<void> | null };
const writeAccess = new Map<string, WriteAccessEntry>();
const EMPTY_WRITE_ACCESS: WriteAccessEntry = { access: null, checkedAt: 0, promise: null };

export function refreshGitHubIssueWriteAccess(repo: GitHubRepo, options: { force?: boolean } = {}): void {
  const key = repoKey(repo);
  const current = writeAccess.get(key);
  if (current?.promise) return;
  if (!options.force && current && Date.now() - current.checkedAt < WRITE_ACCESS_STALE_MS) return;
  const read = window.ade?.github?.getIssueWriteAccess;
  if (!read) return;
  const promise = read({ owner: repo.owner, name: repo.name, force: options.force === true })
    .then((access) => {
      writeAccess.set(key, { access, checkedAt: Date.now(), promise: null });
    })
    .catch(() => {
      writeAccess.set(key, { access: current?.access ?? null, checkedAt: Date.now(), promise: null });
    })
    .finally(notify);
  writeAccess.set(key, { access: current?.access ?? null, checkedAt: current?.checkedAt ?? 0, promise });
}

/**
 * Which credential an issue edit would use. `writeSource` null means none can,
 * and the viewer's controls stay read-only with the reason.
 */
export function useGitHubIssueWriteAccess(repo: GitHubRepo | null): GitHubIssueWriteAccess | null {
  const key = repo ? repoKey(repo) : null;
  const entry = useSyncExternalStore(subscribe, () => (key ? writeAccess.get(key) ?? EMPTY_WRITE_ACCESS : EMPTY_WRITE_ACCESS), () => EMPTY_WRITE_ACCESS);
  const owner = repo?.owner ?? null;
  const name = repo?.name ?? null;
  useEffect(() => {
    if (owner && name) refreshGitHubIssueWriteAccess({ owner, name });
  }, [name, owner]);
  return entry.access;
}

/** Labels, people and milestones the pickers offer, read when a picker first opens. */
export type GitHubRepoCatalog = {
  labels: GitHubIssueLabel[];
  people: GitHubIssuePerson[];
  milestones: Array<{ number: number; title: string }>;
};

type CatalogEntry = { catalog: GitHubRepoCatalog | null; checkedAt: number; promise: Promise<void> | null };
const catalogs = new Map<string, CatalogEntry>();
const EMPTY_CATALOG_ENTRY: CatalogEntry = { catalog: null, checkedAt: 0, promise: null };

export function loadGitHubRepoCatalog(repo: GitHubRepo): void {
  const key = repoKey(repo);
  const current = catalogs.get(key);
  if (current?.promise || (current?.catalog && Date.now() - current.checkedAt < REPO_CATALOG_STALE_MS)) return;
  const github = window.ade?.github;
  if (!github) return;
  const args = { owner: repo.owner, name: repo.name };
  const promise = Promise.all([
    github.listRepoLabels?.(args).catch(() => []) ?? Promise.resolve([]),
    github.listRepoCollaborators?.(args).catch(() => []) ?? Promise.resolve([]),
    github.listRepoMilestones?.(args).catch(() => []) ?? Promise.resolve([]),
  ])
    .then(([labels, people, milestones]) => {
      catalogs.set(key, {
        catalog: {
          labels: (labels ?? []).map((label) => ({
            name: label.name,
            color: label.color ? `#${label.color.replace(/^#/, "")}` : null,
          })),
          people: (people ?? [])
            .map((entry) => {
              const raw = entry as { login?: string; avatarUrl?: string | null; avatar_url?: string | null };
              return raw.login ? { login: raw.login, avatarUrl: raw.avatarUrl ?? raw.avatar_url ?? null } : null;
            })
            .filter((entry): entry is GitHubIssuePerson => entry != null),
          milestones: (milestones ?? []).map((milestone) => ({ number: milestone.number, title: milestone.title })),
        },
        checkedAt: Date.now(),
        promise: null,
      });
    })
    .finally(notify);
  catalogs.set(key, { catalog: current?.catalog ?? null, checkedAt: current?.checkedAt ?? 0, promise });
  notify();
}

export function useGitHubRepoCatalog(repo: GitHubRepo | null): GitHubRepoCatalog | null {
  const key = repo ? repoKey(repo) : null;
  return useSyncExternalStore(subscribe, () => (key ? catalogs.get(key) ?? EMPTY_CATALOG_ENTRY : EMPTY_CATALOG_ENTRY).catalog, () => null);
}

/**
 * Apply an edit at once, send one PATCH, then take GitHub's copy or put the
 * old one back. The optimistic copy is what the user picked; GitHub's answer
 * replaces it either way.
 */
export async function editGitHubIssue(
  projectRoot: string | null,
  issue: GitHubIssueDetail,
  patch: GitHubIssuePatch,
  optimistic: Partial<GitHubIssueDetail>,
): Promise<void> {
  const update = window.ade?.github?.updateIssue;
  if (!update) throw new Error("Editing GitHub issues is not available here.");
  const key = issueKey(projectRoot, issue.owner, issue.repo, issue.number);
  const snapshot = entries.peek(key) ?? issue;
  const next = await entries.edit(
    [key],
    snapshot,
    { ...snapshot, ...optimistic },
    async () => normalizeGitHubIssue(issue.owner, issue.repo, await update({ owner: issue.owner, name: issue.repo, number: issue.number, patch })),
    "GitHub rejected the change.",
  );
  // A later edit owns the outcome; it updates the lists when it lands.
  if (!next) return;
  // The list rows and the badge count may have changed with it.
  const repoId = repoKey({ owner: issue.owner, name: issue.repo });
  for (const [listKeyValue, list] of lists) {
    if (listKeyValue.startsWith(`${repoId}:`)) {
      lists.set(listKeyValue, {
        ...list,
        issues: list.issues.map((row) => (row.number === issue.number ? next : row)),
        fetchedAt: 0,
      });
    }
  }
  if (patch.state) {
    const summary = summaries.get(repoId);
    if (summary) summaries.set(repoId, { ...summary, checkedAt: 0 });
  }
  notify();
}

export async function commentOnGitHubIssue(issue: GitHubIssueDetail, body: string): Promise<GitHubIssueComment | null> {
  const comment = window.ade?.github?.commentOnIssue;
  if (!comment) throw new Error("Commenting is not available here.");
  try {
    const raw = await comment({ owner: issue.owner, name: issue.repo, number: issue.number, body });
    return raw ? normalizeComment(raw) : null;
  } catch (error) {
    throw new Error(errorMessage(error, "GitHub rejected the comment."));
  }
}

/* ── A bare `#123` ─────────────────────────────────────────────────────── */

/**
 * What a bare `#123` in this project means: an issue of the project's GitHub
 * repository, or not (a pull request, an unknown number, no GitHub remote).
 * GitHub numbers issues and pull requests from one sequence, so the only way
 * to know is to ask; the read is the same cached, ETag'd one the viewer uses.
 */
export async function resolveProjectGitHubIssueNumber(
  projectRoot: string | null,
  number: number,
): Promise<{ owner: string; repo: string; issue: GitHubIssueDetail } | null> {
  if (!projectRoot) return null;
  const repo = await loadProjectRepo(projectRoot);
  if (!repo) return null;
  const issue = await loadGitHubIssue(projectRoot, repo.owner, repo.name, number).catch(() => null);
  if (!issue || issue.isPullRequest) return null;
  return { owner: repo.owner, repo: repo.name, issue };
}

/** Every issue the lists and the viewer already read, for "similar issues". */
export function cachedGitHubIssues(owner: string, repo: string): GitHubIssueDetail[] {
  const wanted = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const byNumber = new Map<number, GitHubIssueDetail>();
  for (const [key, list] of lists) {
    if (!key.startsWith(`${wanted}:`)) continue;
    for (const issue of list.issues) byNumber.set(issue.number, issue);
  }
  for (const entry of entries.entries.values()) {
    const issue = entry.issue;
    if (issue && `${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}` === wanted && !issue.isPullRequest) {
      byNumber.set(issue.number, issue);
    }
  }
  return [...byNumber.values()];
}

/** The repo's issue templates and issue types, read once per repo per session. */
type CreateCatalogEntry = { templates: GitHubIssueTemplateSet | null; types: GitHubIssueTypeOption[]; promise: Promise<void> | null; loaded: boolean };
const createCatalogs = new Map<string, CreateCatalogEntry>();
const EMPTY_CREATE_CATALOG: CreateCatalogEntry = { templates: null, types: [], promise: null, loaded: false };

export function useGitHubCreateCatalog(repo: GitHubRepo | null): CreateCatalogEntry {
  const key = repo ? repoKey(repo) : null;
  const entry = useSyncExternalStore(subscribe, () => (key ? createCatalogs.get(key) ?? EMPTY_CREATE_CATALOG : EMPTY_CREATE_CATALOG), () => EMPTY_CREATE_CATALOG);
  const owner = repo?.owner ?? null;
  const name = repo?.name ?? null;
  useEffect(() => {
    if (!owner || !name || !key) return;
    const current = createCatalogs.get(key);
    if (current?.loaded || current?.promise) return;
    const github = window.ade?.github;
    if (!github) return;
    const promise = Promise.all([
      github.listIssueTemplates?.({ owner, name }).catch(() => null) ?? Promise.resolve(null),
      github.listIssueTypes?.({ owner, name }).catch(() => []) ?? Promise.resolve([]),
    ])
      .then(([templates, types]) => {
        createCatalogs.set(key, { templates, types: types ?? [], promise: null, loaded: true });
      })
      .finally(notify);
    createCatalogs.set(key, { ...EMPTY_CREATE_CATALOG, promise });
    notify();
  }, [key, name, owner]);
  return entry;
}
