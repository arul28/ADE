import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type {
  JiraComment,
  JiraConnectionStatus,
  JiraCreateMeta,
  JiraIssueDetail,
  JiraIssueListState,
  JiraIssuePage,
  JiraIssueSummary,
  JiraListIssuesArgs,
  JiraProject,
  JiraTransition,
  JiraUpdateIssueArgs,
  JiraUser,
} from "../../../shared/types/jira";
import type { IssueRef } from "../../../shared/issueRefs";
import type { OpenProjectBinding } from "../../../shared/types";
import { makeJiraIssueContextAttachment } from "../../../shared/chatContextAttachments";
import { jiraIssueToLaneIssue } from "../../../shared/laneJiraIssue";
import { getProjectConfigCached } from "../../lib/projectConfigCache";
import { useActiveProjectRoot } from "../../state/appStore";
import { createIssueEntryCache, errorMessage, type IssueEntry } from "./issueEntryCache";

const ISSUE_STALE_MS = 60_000;
const LIST_STALE_MS = 60_000;
const CONNECTION_STALE_MS = 60_000;
const MAX_ISSUES = 80;
const PAGE_SIZE = 50;
export const JIRA_CONNECTION_CHANGED_EVENT = "ade:jira-connection-changed";
export const JIRA_PROJECT_BINDINGS_CHANGED_EVENT = "ade:jira-project-bindings-changed";

const listeners = new Set<() => void>();
const threadBindingListeners = new Set<() => void>();
function notify(): void {
  for (const listener of listeners) listener();
}
function notifyThreadBindings(): void {
  for (const listener of threadBindingListeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function subscribeThreadBindings(listener: () => void): () => void {
  threadBindingListeners.add(listener);
  return () => threadBindingListeners.delete(listener);
}

function scopeKey(projectRoot: string | null, pin?: OpenProjectBinding | null): string {
  return pin?.key ?? projectRoot ?? "bound";
}

function issueKey(projectRoot: string | null, siteUrl: string, key: string): string {
  return `${projectRoot ?? ""}::${siteUrl.toLowerCase().replace(/\/$/, "")}::${key.toUpperCase()}`;
}

type ConnectionEntry = {
  status: JiraConnectionStatus | null;
  checkedAt: number;
  promise: Promise<JiraConnectionStatus | null> | null;
};
const connections = new Map<string, ConnectionEntry>();
const EMPTY_CONNECTION: ConnectionEntry = { status: null, checkedAt: 0, promise: null };

export function loadJiraConnectionStatus(
  projectRoot: string | null,
  options: { pin?: OpenProjectBinding | null; force?: boolean } = {},
): Promise<JiraConnectionStatus | null> {
  const key = scopeKey(projectRoot, options.pin);
  const current = connections.get(key) ?? EMPTY_CONNECTION;
  if (current.promise) return current.promise;
  if (!options.force && Date.now() - current.checkedAt < CONNECTION_STALE_MS) return Promise.resolve(current.status);
  const read = window.ade?.jira?.getConnectionStatus;
  if (!read) return Promise.resolve(null);
  const promise = read(options.pin)
    .then((status) => {
      connections.set(key, { status, checkedAt: Date.now(), promise: null });
      return status;
    })
    .catch(() => {
      connections.set(key, { status: current.status, checkedAt: Date.now(), promise: null });
      return current.status;
    })
    .finally(notify);
  connections.set(key, { ...current, promise });
  notify();
  return promise;
}

export function rememberJiraConnectionStatus(
  projectRoot: string | null,
  status: JiraConnectionStatus,
  pin?: OpenProjectBinding | null,
): void {
  connections.set(scopeKey(projectRoot, pin), { status, checkedAt: Date.now(), promise: null });
  notify();
}

export function useJiraConnectionStatus(enabled = true): {
  status: JiraConnectionStatus | null;
  loading: boolean;
  refresh: () => Promise<JiraConnectionStatus | null>;
} {
  const projectRoot = useActiveProjectRoot();
  const key = scopeKey(projectRoot);
  const entry = useSyncExternalStore(subscribe, () => connections.get(key) ?? EMPTY_CONNECTION, () => EMPTY_CONNECTION);
  const refresh = useCallback(() => loadJiraConnectionStatus(projectRoot, { force: true }), [projectRoot]);
  useEffect(() => {
    if (!enabled) return undefined;
    void loadJiraConnectionStatus(projectRoot);
    const onFocus = () => { void loadJiraConnectionStatus(projectRoot); };
    const onChanged = () => { void loadJiraConnectionStatus(projectRoot, { force: true }); };
    window.addEventListener("focus", onFocus);
    window.addEventListener(JIRA_CONNECTION_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(JIRA_CONNECTION_CHANGED_EVENT, onChanged);
    };
  }, [enabled, projectRoot]);
  return { status: entry.status, loading: entry.promise != null, refresh };
}

type JiraThreadEntityBindings = {
  projectKeys: string[];
  siteUrl: string | null;
  checkedAt: number;
  promise: Promise<void> | null;
};

const threadEntityBindings = new Map<string, JiraThreadEntityBindings>();
const EMPTY_THREAD_ENTITY_BINDINGS: JiraThreadEntityBindings = {
  projectKeys: [],
  siteUrl: null,
  checkedAt: 0,
  promise: null,
};

function loadJiraThreadEntityBindings(
  projectRoot: string | null,
  pin: OpenProjectBinding | null,
  force = false,
): Promise<void> {
  const key = scopeKey(projectRoot, pin);
  const current = threadEntityBindings.get(key) ?? EMPTY_THREAD_ENTITY_BINDINGS;
  if (current.promise) return current.promise;
  if (!force && Date.now() - current.checkedAt < CONNECTION_STALE_MS) return Promise.resolve();

  const configPromise = (async () => {
    try {
      return await getProjectConfigCached({ projectRoot, pin, force });
    } catch {
      return null;
    }
  })();
  const promise = Promise.all([
    configPromise,
    loadJiraConnectionStatus(projectRoot, { pin, force }),
  ]).then(([config, status]) => {
    threadEntityBindings.set(key, {
      projectKeys: config?.effective.issueTrackers?.jira?.projectKeys ?? current.projectKeys,
      siteUrl: status?.connected ? status.siteUrl ?? null : null,
      checkedAt: Date.now(),
      promise: null,
    });
  }).catch(() => {
    threadEntityBindings.set(key, { ...current, checkedAt: Date.now(), promise: null });
  }).finally(notifyThreadBindings);

  threadEntityBindings.set(key, { ...current, promise });
  notifyThreadBindings();
  return promise;
}

/** Jira keys for chat chips, loaded once per chat machine/project scope. */
export function useJiraThreadEntityBindings(
  projectRoot: string | null,
  pin: OpenProjectBinding | null,
): Pick<JiraThreadEntityBindings, "projectKeys" | "siteUrl"> {
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const key = scopeKey(projectRoot, pin);
  const entry = useSyncExternalStore(
    subscribeThreadBindings,
    () => threadEntityBindings.get(key) ?? EMPTY_THREAD_ENTITY_BINDINGS,
    () => EMPTY_THREAD_ENTITY_BINDINGS,
  );

  useEffect(() => {
    const refresh = (force = false) => { void loadJiraThreadEntityBindings(projectRoot, pinRef.current, force); };
    refresh();
    const onFocus = () => refresh();
    const onChanged = () => refresh(true);
    window.addEventListener("focus", onFocus);
    window.addEventListener(JIRA_CONNECTION_CHANGED_EVENT, onChanged);
    window.addEventListener(JIRA_PROJECT_BINDINGS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(JIRA_CONNECTION_CHANGED_EVENT, onChanged);
      window.removeEventListener(JIRA_PROJECT_BINDINGS_CHANGED_EVENT, onChanged);
    };
  }, [projectRoot, pinKey]);

  return { projectKeys: entry.projectKeys, siteUrl: entry.siteUrl };
}

function statusForIssue(siteUrl: string, status: JiraConnectionStatus | null): void {
  if (!status?.connected) {
    const reason = status?.error?.reason ?? "not-connected";
    throw new Error(`[jira:${reason}] ${status?.error?.message ?? "Connect Jira in Settings to read this issue."}`);
  }
  const connectedSite = status.siteUrl?.replace(/\/$/, "").toLowerCase();
  if (connectedSite !== siteUrl.replace(/\/$/, "").toLowerCase()) {
    throw new Error(`[jira:not-connected] Connect ${siteUrl} on this machine to read this issue.`);
  }
}

/* ── One issue ─────────────────────────────────────────────────────────── */

export type JiraIssueEntry = IssueEntry<JiraIssueDetail>;
const issueEntries = createIssueEntryCache<JiraIssueDetail>({ maxEntries: MAX_ISSUES, staleMs: ISSUE_STALE_MS, notify });

function summaryToDetail(issue: JiraIssueSummary): JiraIssueDetail {
  return {
    ...issue,
    description: "",
    dueDate: null,
    subtasks: [],
    comments: [],
    commentsCursor: null,
    totalComments: 0,
    permissions: { edit: false, comment: false, transition: false, assign: false },
  };
}

/** Prime a list or create result so a viewer can draw before its full read. */
export function primeJiraIssue(projectRoot: string | null, issue: JiraIssueSummary): void {
  const key = issueKey(projectRoot, new URL(issue.url).origin, issue.key);
  const current = issueEntries.peek(key);
  if (current && current.updatedAt >= issue.updatedAt) return;
  issueEntries.write(key, { status: "ready", issue: summaryToDetail(issue), error: null, fetchedAt: 0 });
}

export function isCompleteJiraIssue(entry: { fetchedAt: number }): boolean {
  return entry.fetchedAt > 0;
}

export function loadJiraIssue(
  projectRoot: string | null,
  ref: Extract<IssueRef, { provider: "jira" }>,
  options: { force?: boolean } = {},
): Promise<JiraIssueDetail | null> {
  const key = issueKey(projectRoot, ref.siteUrl, ref.key);
  const api = window.ade?.jira;
  return issueEntries.load(
    key,
    api?.getIssue
      ? async () => {
        const status = await loadJiraConnectionStatus(projectRoot, { force: options.force });
        statusForIssue(ref.siteUrl, status);
        return api.getIssue({ key: ref.key });
      }
      : null,
    { unavailable: "Jira is not available in this ADE window.", failed: "Jira request failed." },
    options,
  );
}

export function peekJiraIssue(projectRoot: string | null, ref: Extract<IssueRef, { provider: "jira" }>): JiraIssueDetail | null {
  return issueEntries.peek(issueKey(projectRoot, ref.siteUrl, ref.key));
}

export function useJiraIssuePeek(ref: Extract<IssueRef, { provider: "jira" }> | null): JiraIssueDetail | null {
  const projectRoot = useActiveProjectRoot();
  const key = ref ? issueKey(projectRoot, ref.siteUrl, ref.key) : null;
  const entry = useSyncExternalStore(subscribe, () => issueEntries.read(key), () => issueEntries.empty);
  return entry.issue;
}

export function jiraIssueToContextAttachment(issue: JiraIssueDetail, siteUrl: string) {
  const laneIssue = jiraIssueToLaneIssue(issue, siteUrl);
  return laneIssue ? makeJiraIssueContextAttachment(laneIssue) : null;
}

export function useJiraIssue(ref: Extract<IssueRef, { provider: "jira" }> | null): JiraIssueEntry & {
  refresh: () => void;
  projectRoot: string | null;
} {
  const projectRoot = useActiveProjectRoot();
  const key = ref ? issueKey(projectRoot, ref.siteUrl, ref.key) : null;
  const entry = useSyncExternalStore(subscribe, () => issueEntries.read(key), () => issueEntries.empty);
  const siteUrl = ref?.siteUrl ?? null;
  const issueKeyValue = ref?.key ?? null;
  const partial = entry.issue != null && !isCompleteJiraIssue(entry);
  useEffect(() => {
    if (!siteUrl || !issueKeyValue) return;
    void loadJiraIssue(projectRoot, { provider: "jira", siteUrl, key: issueKeyValue });
  }, [issueKeyValue, partial, projectRoot, siteUrl]);
  const refresh = useCallback(() => {
    if (siteUrl && issueKeyValue) {
      void loadJiraIssue(projectRoot, { provider: "jira", siteUrl, key: issueKeyValue }, { force: true });
    }
  }, [issueKeyValue, projectRoot, siteUrl]);
  return { ...entry, refresh, projectRoot };
}

export function editJiraIssue(
  projectRoot: string | null,
  siteUrl: string,
  issue: JiraIssueDetail,
  patch: Omit<JiraUpdateIssueArgs, "key">,
  optimistic: Partial<JiraIssueDetail>,
): Promise<JiraIssueDetail | null> {
  const api = window.ade?.jira;
  const key = issueKey(projectRoot, siteUrl, issue.key);
  const promise = issueEntries.edit(
    [key],
    issue,
    { ...issue, ...optimistic },
    async () => {
      if (!api?.updateIssue) throw new Error("Jira issue editing is not available here.");
      const status = await loadJiraConnectionStatus(projectRoot);
      statusForIssue(siteUrl, status);
      await api.updateIssue({ key: issue.key, ...patch });
      return null;
    },
    "Jira refused the change.",
  );
  syncJiraIssueLists(projectRoot, siteUrl, { ...issue, ...optimistic });
  return promise.then((updated) => {
    if (updated) syncJiraIssueLists(projectRoot, siteUrl, updated);
    return updated;
  }, (error: unknown) => {
    syncJiraIssueLists(projectRoot, siteUrl, issue);
    throw error;
  });
}

export function transitionJiraIssue(
  projectRoot: string | null,
  siteUrl: string,
  issue: JiraIssueDetail,
  transition: JiraTransition,
): Promise<JiraIssueDetail | null> {
  const api = window.ade?.jira;
  const key = issueKey(projectRoot, siteUrl, issue.key);
  const promise = issueEntries.edit(
    [key],
    issue,
    { ...issue, status: transition.to },
    async () => {
      if (!api?.transitionIssue) throw new Error("Jira status changes are not available here.");
      const status = await loadJiraConnectionStatus(projectRoot);
      statusForIssue(siteUrl, status);
      await api.transitionIssue({ key: issue.key, transitionId: transition.id });
      return null;
    },
    "Jira refused the status change.",
  );
  const optimistic = { ...issue, status: transition.to };
  syncJiraIssueLists(projectRoot, siteUrl, optimistic);
  return promise.then((updated) => {
    if (updated) syncJiraIssueLists(projectRoot, siteUrl, updated);
    return updated;
  }, (error: unknown) => {
    syncJiraIssueLists(projectRoot, siteUrl, issue);
    throw error;
  });
}

export async function addJiraIssueComment(
  projectRoot: string | null,
  siteUrl: string,
  issue: JiraIssueDetail,
  body: string,
): Promise<JiraComment> {
  const api = window.ade?.jira;
  if (!api?.addComment) throw new Error("Jira comments are not available here.");
  const status = await loadJiraConnectionStatus(projectRoot, { force: true });
  statusForIssue(siteUrl, status);
  const comment = await api.addComment({ key: issue.key, body });
  const key = issueKey(projectRoot, siteUrl, issue.key);
  issueEntries.write(key, {
    issue: { ...issue, comments: [...issue.comments, comment], totalComments: issue.totalComments + 1 },
    fetchedAt: Date.now(),
    error: null,
  });
  return comment;
}

export async function loadJiraIssueComments(
  projectRoot: string | null,
  siteUrl: string,
  key: string,
  cursor: string | null,
): Promise<{ comments: JiraComment[]; nextCursor: string | null }> {
  const api = window.ade?.jira;
  if (!api?.listComments) throw new Error("Jira comments are not available here.");
  const status = await loadJiraConnectionStatus(projectRoot, { force: true });
  statusForIssue(siteUrl, status);
  return api.listComments({ key, cursor });
}

/* ── Project and picker catalogs ───────────────────────────────────────── */

type ProjectEntry = { projects: JiraProject[]; fetchedAt: number; promise: Promise<JiraProject[]> | null; error: string | null };
const projects = new Map<string, ProjectEntry>();
const EMPTY_PROJECTS: ProjectEntry = { projects: [], fetchedAt: 0, promise: null, error: null };

export function loadJiraProjects(projectRoot: string | null, options: { force?: boolean; query?: string; siteUrl?: string } = {}): Promise<JiraProject[]> {
  const site = options.siteUrl?.toLowerCase().replace(/\/$/, "") ?? "";
  const key = `${scopeKey(projectRoot)}:${site}:${options.query?.trim().toLowerCase() ?? ""}`;
  const current = projects.get(key) ?? EMPTY_PROJECTS;
  if (current.promise) return current.promise;
  if (!options.force && Date.now() - current.fetchedAt < LIST_STALE_MS) return Promise.resolve(current.projects);
  const read = window.ade?.jira?.listProjects;
  if (!read) return Promise.resolve([]);
  const promise = read({ query: options.query })
    .then((rows) => {
      const next = rows ?? [];
      projects.set(key, { projects: next, fetchedAt: Date.now(), promise: null, error: null });
      return next;
    })
    .catch((error: unknown) => {
      projects.set(key, { ...current, fetchedAt: Date.now(), promise: null, error: errorMessage(error, "Couldn't load Jira projects.") });
      throw error;
    })
    .finally(notify);
  projects.set(key, { ...current, promise });
  notify();
  return promise;
}

export function useJiraProjects(enabled = true, siteUrl = ""): { projects: JiraProject[]; loading: boolean; error: string | null; refresh: () => Promise<JiraProject[]> } {
  const projectRoot = useActiveProjectRoot();
  const key = `${scopeKey(projectRoot)}:${siteUrl.toLowerCase().replace(/\/$/, "")}:`;
  const entry = useSyncExternalStore(subscribe, () => projects.get(key) ?? EMPTY_PROJECTS, () => EMPTY_PROJECTS);
  const refresh = useCallback(() => loadJiraProjects(projectRoot, { force: true, siteUrl }), [projectRoot, siteUrl]);
  useEffect(() => {
    if (!enabled) return undefined;
    void loadJiraProjects(projectRoot, { siteUrl }).catch(() => {});
    const onConnectionChanged = () => { void loadJiraProjects(projectRoot, { force: true, siteUrl }).catch(() => {}); };
    window.addEventListener(JIRA_CONNECTION_CHANGED_EVENT, onConnectionChanged);
    return () => window.removeEventListener(JIRA_CONNECTION_CHANGED_EVENT, onConnectionChanged);
  }, [enabled, projectRoot, siteUrl]);
  return { projects: entry.projects, loading: entry.promise != null, error: entry.error, refresh };
}

const createMeta = new Map<string, { value: JiraCreateMeta | null; promise: Promise<JiraCreateMeta | null> | null }>();
export function loadJiraCreateMeta(projectRoot: string | null, projectKey: string, force = false): Promise<JiraCreateMeta | null> {
  const key = `${scopeKey(projectRoot)}:${projectKey.toUpperCase()}`;
  const current = createMeta.get(key) ?? { value: null, promise: null };
  if (current.promise) return current.promise;
  if (!force && current.value) return Promise.resolve(current.value);
  const read = window.ade?.jira?.getCreateMeta;
  if (!read) return Promise.resolve(null);
  const promise = read({ projectKey })
    .then((value) => {
      createMeta.set(key, { value, promise: null });
      return value;
    })
    .catch((error: unknown) => {
      createMeta.set(key, { ...current, promise: null });
      throw error;
    })
    .finally(notify);
  createMeta.set(key, { ...current, promise });
  notify();
  return promise;
}

type AssignableEntry = { users: JiraUser[]; promise: Promise<JiraUser[]> | null };
const assignableUsers = new Map<string, AssignableEntry>();
export function loadJiraAssignableUsers(projectRoot: string | null, input: { projectKey?: string; key?: string; query?: string } = {}): Promise<JiraUser[]> {
  const cacheKey = `${scopeKey(projectRoot)}:${input.projectKey ?? ""}:${input.key ?? ""}:${input.query?.trim().toLowerCase() ?? ""}`;
  const current = assignableUsers.get(cacheKey) ?? { users: [], promise: null };
  if (current.users.length > 0) return Promise.resolve(current.users);
  if (current.promise) return current.promise;
  const read = window.ade?.jira?.listAssignableUsers;
  if (!read) return Promise.resolve([]);
  const promise = read(input)
    .then((users) => {
      assignableUsers.set(cacheKey, { users: users ?? [], promise: null });
      return users ?? [];
    })
    .finally(() => { notify(); });
  assignableUsers.set(cacheKey, { ...current, promise });
  notify();
  return promise;
}

type LabelEntry = { labels: string[]; promise: Promise<string[]> | null };
const labelCatalogs = new Map<string, LabelEntry>();
export function loadJiraLabels(projectRoot: string | null, query = ""): Promise<string[]> {
  const key = `${scopeKey(projectRoot)}:${query.trim().toLowerCase()}`;
  const current = labelCatalogs.get(key) ?? { labels: [], promise: null };
  if (current.labels.length > 0) return Promise.resolve(current.labels);
  if (current.promise) return current.promise;
  const read = window.ade?.jira?.listLabels;
  if (!read) return Promise.resolve([]);
  const promise = read({ query })
    .then((labels) => {
      labelCatalogs.set(key, { labels: labels ?? [], promise: null });
      return labels ?? [];
    })
    .finally(notify);
  labelCatalogs.set(key, { ...current, promise });
  notify();
  return promise;
}

function clearJiraCatalogs(): void {
  projects.clear();
  createMeta.clear();
  assignableUsers.clear();
  labelCatalogs.clear();
  notify();
}

if (typeof window !== "undefined") {
  window.addEventListener(JIRA_CONNECTION_CHANGED_EVENT, clearJiraCatalogs);
}

/* ── Lists: cursor pages stay visible during refresh ────────────────────── */

export type JiraIssueFilters = Pick<JiraListIssuesArgs, "projectKeys" | "state" | "assignee" | "query">;
type JiraIssueListEntry = {
  issues: JiraIssueSummary[];
  firstPageKeys: string[];
  hasLoadedMore: boolean;
  nextCursor: string | null;
  fetchedAt: number;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  promise: Promise<void> | null;
};
const lists = new Map<string, JiraIssueListEntry>();
const EMPTY_LIST: JiraIssueListEntry = { issues: [], firstPageKeys: [], hasLoadedMore: false, nextCursor: null, fetchedAt: 0, status: "idle", error: null, promise: null };

function jiraListKey(projectRoot: string | null, filters: JiraIssueFilters, siteUrl = ""): string {
  const projectKeys = [...(filters.projectKeys ?? [])].map((key) => key.toUpperCase()).sort().join(",");
  return JSON.stringify([projectRoot ?? "", siteUrl.toLowerCase().replace(/\/$/, ""), projectKeys, filters.state ?? "open", filters.assignee ?? "any", filters.query?.trim() ?? ""]);
}

function mergeJiraIssues(previous: JiraIssueSummary[], next: JiraIssueSummary[]): JiraIssueSummary[] {
  const rows = new Map(previous.map((issue) => [issue.key, issue]));
  for (const issue of next) rows.set(issue.key, issue);
  return [...rows.values()];
}

function summaryFromDetail(issue: JiraIssueDetail): JiraIssueSummary {
  return {
    id: issue.id,
    key: issue.key,
    projectKey: issue.projectKey,
    title: issue.title,
    status: issue.status,
    issueType: issue.issueType,
    priority: issue.priority,
    assignee: issue.assignee,
    reporter: issue.reporter,
    labels: issue.labels,
    parentKey: issue.parentKey,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function syncJiraIssueLists(projectRoot: string | null, siteUrl: string, detail: JiraIssueDetail): void {
  const summary = summaryFromDetail(detail);
  const normalizedSite = siteUrl.toLowerCase().replace(/\/$/, "");
  const normalizedRoot = projectRoot ?? "";
  let changed = false;
  for (const [key, list] of lists) {
    let filters: unknown;
    try { filters = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(filters) || filters[0] !== normalizedRoot || filters[1] !== normalizedSite) continue;
    const projectKeys = String(filters[2] ?? "").split(",").filter(Boolean);
    if (projectKeys.length && !projectKeys.includes(summary.projectKey.toUpperCase())) continue;
    if (!list.issues.some((issue) => issue.key === summary.key)) continue;
    lists.set(key, { ...list, issues: list.issues.map((issue) => issue.key === summary.key ? summary : issue) });
    changed = true;
  }
  if (changed) notify();
}

export function loadJiraIssueList(
  projectRoot: string | null,
  filters: JiraIssueFilters,
  options: { force?: boolean; cursor?: string | null; siteUrl?: string } = {},
): Promise<void> {
  const key = jiraListKey(projectRoot, filters, options.siteUrl);
  const current = lists.get(key) ?? EMPTY_LIST;
  if (current.promise) return current.promise;
  if (!options.force && !options.cursor && current.status === "ready" && Date.now() - current.fetchedAt < LIST_STALE_MS) {
    return Promise.resolve();
  }
  const read = window.ade?.jira?.listIssues;
  if (!read) {
    lists.set(key, { ...current, status: "error", error: "Jira issue lists are not available in this ADE window.", promise: null });
    notify();
    return Promise.resolve();
  }
  const cursor = options.cursor ?? (options.force ? null : current.nextCursor);
  const promise = read({ ...filters, limit: PAGE_SIZE, cursor })
    .then((page: JiraIssuePage) => {
      const rows = page.issues ?? [];
      for (const issue of rows) primeJiraIssue(projectRoot, issue);
      const firstPageKeys = cursor ? current.firstPageKeys : rows.map((issue) => issue.key);
      const firstPageSet = new Set(firstPageKeys);
      const oldFirstPageSet = new Set(current.firstPageKeys);
      const refreshedKeys = new Set(rows.map((issue) => issue.key));
      const retainedLaterPages = !cursor && current.hasLoadedMore
        ? current.issues.filter((issue) => !oldFirstPageSet.has(issue.key) && !firstPageSet.has(issue.key) && !refreshedKeys.has(issue.key))
        : [];
      const issues = cursor ? mergeJiraIssues(current.issues, rows) : mergeJiraIssues(rows, retainedLaterPages);
      lists.set(key, {
        issues,
        firstPageKeys,
        hasLoadedMore: cursor ? true : current.hasLoadedMore,
        nextCursor: cursor ? page.nextCursor ?? null : current.hasLoadedMore ? current.nextCursor : page.nextCursor ?? null,
        fetchedAt: Date.now(),
        status: "ready",
        error: null,
        promise: null,
      });
    })
    .catch((error: unknown) => {
      lists.set(key, {
        ...current,
        status: "error",
        error: errorMessage(error, "Jira request failed."),
        promise: null,
      });
    })
    .finally(notify);
  lists.set(key, { ...current, status: current.issues.length ? current.status : "loading", promise });
  notify();
  return promise;
}

export function useJiraIssueList(filters: JiraIssueFilters, enabled = true, siteUrl = ""): JiraIssueListEntry & { refresh: () => void; loadMore: () => void } {
  const projectRoot = useActiveProjectRoot();
  const key = jiraListKey(projectRoot, filters, siteUrl);
  const entry = useSyncExternalStore(subscribe, () => lists.get(key) ?? EMPTY_LIST, () => EMPTY_LIST);
  useEffect(() => { if (enabled) void loadJiraIssueList(projectRoot, filters, { siteUrl }); }, [enabled, projectRoot, key]);
  const refresh = useCallback(() => { if (enabled) void loadJiraIssueList(projectRoot, filters, { force: true, siteUrl }); }, [enabled, key, projectRoot]);
  const loadMore = useCallback(() => {
    if (!enabled) return;
    const current = lists.get(key);
    if (current?.nextCursor) void loadJiraIssueList(projectRoot, filters, { cursor: current.nextCursor, siteUrl });
  }, [enabled, key, projectRoot, siteUrl]);
  return { ...entry, refresh, loadMore };
}

export function noteJiraIssueCreated(projectRoot: string | null, issue: JiraIssueSummary): void {
  primeJiraIssue(projectRoot, issue);
  const filterStates: JiraIssueListState[] = ["open", "all"];
  for (const [key, list] of lists) {
    let filters: unknown;
    try { filters = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(filters) || filters[0] !== (projectRoot ?? "") || !filterStates.includes(filters[3] as JiraIssueListState)) continue;
    const projectKeys = String(filters[2] ?? "").split(",").filter(Boolean);
    if (projectKeys.length && !projectKeys.includes(issue.projectKey.toUpperCase())) continue;
    if (filters[4] === "me" || filters[5]) continue;
    lists.set(key, { ...list, issues: mergeJiraIssues([issue], list.issues) });
  }
  notify();
}
