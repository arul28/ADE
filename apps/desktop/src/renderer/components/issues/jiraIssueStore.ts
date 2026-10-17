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
import { jiraErrorMessage } from "../../../shared/jiraErrors";
import { makeJiraIssueContextAttachment } from "../../../shared/chatContextAttachments";
import { jiraIssueToLaneIssue } from "../../../shared/laneJiraIssue";
import { getProjectConfigCached } from "../../lib/projectConfigCache";
import { useActiveProjectRoot } from "../../state/appStore";
import { createIssueEntryCache, type IssueEntry } from "./issueEntryCache";

const ISSUE_STALE_MS = 60_000;
const LIST_STALE_MS = 60_000;
const CONNECTION_STALE_MS = 60_000;
const MAX_ISSUES = 80;
const PAGE_SIZE = 50;
export const JIRA_CONNECTION_CHANGED_EVENT = "ade:jira-connection-changed";
export const JIRA_PROJECT_BINDINGS_CHANGED_EVENT = "ade:jira-project-bindings-changed";

const listeners = new Set<() => void>();
const threadBindingListeners = new Set<() => void>();
let jiraConnectionRevision = 0;
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

function normalizeJiraSite(siteUrl: string): string {
  try { return new URL(siteUrl).origin.toLowerCase(); } catch { return siteUrl.trim().replace(/\/+$/, "").toLowerCase(); }
}

function issueKey(projectRoot: string | null, siteUrl: string, key: string, pin?: OpenProjectBinding | null): string {
  return `${jiraConnectionRevision}::${scopeKey(projectRoot, pin)}::${normalizeJiraSite(siteUrl)}::${key.toUpperCase()}`;
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
  const revisionAtStart = jiraConnectionRevision;
  const promise = read(options.pin)
    .then((status) => {
      if (revisionAtStart !== jiraConnectionRevision) return null;
      connections.set(key, { status, checkedAt: Date.now(), promise: null });
      return status;
    })
    .catch(() => {
      if (revisionAtStart !== jiraConnectionRevision) return null;
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

export function useJiraConnectionStatus(enabled = true, pin: OpenProjectBinding | null = null): {
  status: JiraConnectionStatus | null;
  loading: boolean;
  refresh: () => Promise<JiraConnectionStatus | null>;
} {
  const projectRoot = useActiveProjectRoot();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const scopedKey = scopeKey(projectRoot, pin);
  const entry = useSyncExternalStore(subscribe, () => connections.get(scopedKey) ?? EMPTY_CONNECTION, () => EMPTY_CONNECTION);
  const refresh = useCallback(() => loadJiraConnectionStatus(projectRoot, { force: true, pin: pinRef.current }), [projectRoot, pinKey]);
  useEffect(() => {
    if (!enabled) return undefined;
    void loadJiraConnectionStatus(projectRoot, { pin: pinRef.current });
    const onFocus = () => { void loadJiraConnectionStatus(projectRoot, { pin: pinRef.current }); };
    const onChanged = () => { void loadJiraConnectionStatus(projectRoot, { force: true, pin: pinRef.current }); };
    window.addEventListener("focus", onFocus);
    window.addEventListener(JIRA_CONNECTION_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(JIRA_CONNECTION_CHANGED_EVENT, onChanged);
    };
  }, [enabled, pinKey, projectRoot]);
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
  const connectedSite = status.siteUrl ? normalizeJiraSite(status.siteUrl) : null;
  if (connectedSite !== normalizeJiraSite(siteUrl)) {
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
export function primeJiraIssue(projectRoot: string | null, issue: JiraIssueSummary, pin?: OpenProjectBinding | null): void {
  const key = issueKey(projectRoot, new URL(issue.url).origin, issue.key, pin);
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
  options: { force?: boolean; pin?: OpenProjectBinding | null } = {},
): Promise<JiraIssueDetail | null> {
  const pin = options.pin;
  const revisionAtStart = jiraConnectionRevision;
  const key = issueKey(projectRoot, ref.siteUrl, ref.key, pin);
  const api = window.ade?.jira;
  return issueEntries.load(
    key,
    api?.getIssue
      ? async () => {
        const status = await loadJiraConnectionStatus(projectRoot, { force: options.force, pin });
        if (revisionAtStart !== jiraConnectionRevision) return null;
        statusForIssue(ref.siteUrl, status);
        const issue = await api.getIssue({ key: ref.key }, pin);
        return revisionAtStart === jiraConnectionRevision ? issue : null;
      }
      : null,
    { unavailable: "Jira is not available in this ADE window.", failed: "Jira request failed." },
    options,
  );
}

export function peekJiraIssue(projectRoot: string | null, ref: Extract<IssueRef, { provider: "jira" }>, pin?: OpenProjectBinding | null): JiraIssueDetail | null {
  return issueEntries.peek(issueKey(projectRoot, ref.siteUrl, ref.key, pin));
}

export function useJiraIssuePeek(ref: Extract<IssueRef, { provider: "jira" }> | null, pin?: OpenProjectBinding | null): JiraIssueDetail | null {
  const projectRoot = useActiveProjectRoot();
  const key = ref ? issueKey(projectRoot, ref.siteUrl, ref.key, pin) : null;
  const entry = useSyncExternalStore(subscribe, () => issueEntries.read(key), () => issueEntries.empty);
  return entry.issue;
}

export function jiraIssueToContextAttachment(issue: JiraIssueDetail, siteUrl: string) {
  const laneIssue = jiraIssueToLaneIssue(issue, siteUrl);
  return laneIssue ? makeJiraIssueContextAttachment(laneIssue) : null;
}

export function useJiraIssue(ref: Extract<IssueRef, { provider: "jira" }> | null, pin?: OpenProjectBinding | null): JiraIssueEntry & {
  refresh: () => void;
  projectRoot: string | null;
} {
  const projectRoot = useActiveProjectRoot();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const key = ref ? issueKey(projectRoot, ref.siteUrl, ref.key, pin) : null;
  const entry = useSyncExternalStore(subscribe, () => issueEntries.read(key), () => issueEntries.empty);
  const siteUrl = ref?.siteUrl ?? null;
  const issueKeyValue = ref?.key ?? null;
  const partial = entry.issue != null && !isCompleteJiraIssue(entry);
  useEffect(() => {
    if (!siteUrl || !issueKeyValue) return;
    void loadJiraIssue(projectRoot, { provider: "jira", siteUrl, key: issueKeyValue }, { pin: pinRef.current });
  }, [issueKeyValue, partial, pinKey, projectRoot, siteUrl]);
  const refresh = useCallback(() => {
    if (siteUrl && issueKeyValue) {
      void loadJiraIssue(projectRoot, { provider: "jira", siteUrl, key: issueKeyValue }, { force: true, pin: pinRef.current });
    }
  }, [issueKeyValue, pinKey, projectRoot, siteUrl]);
  return { ...entry, refresh, projectRoot };
}

export function editJiraIssue(
  projectRoot: string | null,
  siteUrl: string,
  issue: JiraIssueDetail,
  patch: Omit<JiraUpdateIssueArgs, "key">,
  optimistic: Partial<JiraIssueDetail>,
  options: { pin?: OpenProjectBinding | null } = {},
): Promise<JiraIssueDetail | null> {
  const pin = options.pin;
  const revisionAtStart = jiraConnectionRevision;
  const api = window.ade?.jira;
  const key = issueKey(projectRoot, siteUrl, issue.key, pin);
  const promise = issueEntries.edit(
    [key],
    issue,
    { ...issue, ...optimistic },
    async () => {
      if (!api?.updateIssue) throw new Error("Jira issue editing is not available here.");
      const status = await loadJiraConnectionStatus(projectRoot, { pin });
      if (revisionAtStart !== jiraConnectionRevision) throw new Error("Jira connection changed while updating this issue.");
      statusForIssue(siteUrl, status);
      await api.updateIssue({ key: issue.key, ...patch }, pin);
      if (revisionAtStart !== jiraConnectionRevision) throw new Error("Jira connection changed while updating this issue.");
      return null;
    },
    "Jira refused the change.",
  );
  syncJiraIssueLists(projectRoot, siteUrl, { ...issue, ...optimistic }, pin);
  return promise.then((updated) => {
    if (revisionAtStart !== jiraConnectionRevision) return null;
    if (updated) syncJiraIssueLists(projectRoot, siteUrl, updated, pin);
    return updated;
  }, (error: unknown) => {
    if (revisionAtStart === jiraConnectionRevision) syncJiraIssueLists(projectRoot, siteUrl, issue, pin);
    throw error;
  });
}

export function transitionJiraIssue(
  projectRoot: string | null,
  siteUrl: string,
  issue: JiraIssueDetail,
  transition: JiraTransition,
  options: { pin?: OpenProjectBinding | null } = {},
): Promise<JiraIssueDetail | null> {
  const pin = options.pin;
  const revisionAtStart = jiraConnectionRevision;
  const api = window.ade?.jira;
  const key = issueKey(projectRoot, siteUrl, issue.key, pin);
  const promise = issueEntries.edit(
    [key],
    issue,
    { ...issue, status: transition.to },
    async () => {
      if (!api?.transitionIssue) throw new Error("Jira status changes are not available here.");
      const status = await loadJiraConnectionStatus(projectRoot, { pin });
      if (revisionAtStart !== jiraConnectionRevision) throw new Error("Jira connection changed while updating this issue.");
      statusForIssue(siteUrl, status);
      await api.transitionIssue({ key: issue.key, transitionId: transition.id }, pin);
      if (revisionAtStart !== jiraConnectionRevision) throw new Error("Jira connection changed while updating this issue.");
      return null;
    },
    "Jira refused the status change.",
  );
  const optimistic = { ...issue, status: transition.to };
  syncJiraIssueLists(projectRoot, siteUrl, optimistic, pin);
  return promise.then((updated) => {
    if (revisionAtStart !== jiraConnectionRevision) return null;
    if (updated) syncJiraIssueLists(projectRoot, siteUrl, updated, pin);
    return updated;
  }, (error: unknown) => {
    if (revisionAtStart === jiraConnectionRevision) syncJiraIssueLists(projectRoot, siteUrl, issue, pin);
    throw error;
  });
}

export async function addJiraIssueComment(
  projectRoot: string | null,
  siteUrl: string,
  issue: JiraIssueDetail,
  body: string,
  pin?: OpenProjectBinding | null,
): Promise<JiraComment> {
  const revisionAtStart = jiraConnectionRevision;
  const api = window.ade?.jira;
  if (!api?.addComment) throw new Error("Jira comments are not available here.");
  const status = await loadJiraConnectionStatus(projectRoot, { force: true, pin });
  if (revisionAtStart !== jiraConnectionRevision) throw new Error("Jira connection changed while adding a comment.");
  statusForIssue(siteUrl, status);
  const comment = await api.addComment({ key: issue.key, body }, pin);
  if (revisionAtStart !== jiraConnectionRevision) throw new Error("Jira connection changed while adding a comment.");
  const key = issueKey(projectRoot, siteUrl, issue.key, pin);
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
  pin?: OpenProjectBinding | null,
): Promise<{ comments: JiraComment[]; nextCursor: string | null }> {
  const revisionAtStart = jiraConnectionRevision;
  const api = window.ade?.jira;
  if (!api?.listComments) throw new Error("Jira comments are not available here.");
  const status = await loadJiraConnectionStatus(projectRoot, { force: true, pin });
  if (revisionAtStart !== jiraConnectionRevision) throw new Error("Jira connection changed while loading comments.");
  statusForIssue(siteUrl, status);
  const page = await api.listComments({ key, cursor }, pin);
  if (revisionAtStart !== jiraConnectionRevision) throw new Error("Jira connection changed while loading comments.");
  return page;
}

export async function loadJiraIssueTransitions(
  projectRoot: string | null,
  siteUrl: string,
  key: string,
  pin?: OpenProjectBinding | null,
): Promise<JiraTransition[]> {
  const revisionAtStart = jiraConnectionRevision;
  const api = window.ade?.jira;
  if (!api?.listTransitions) throw new Error("Jira status changes are not available here.");
  const status = await loadJiraConnectionStatus(projectRoot, { pin });
  if (revisionAtStart !== jiraConnectionRevision) throw new Error("Jira connection changed while loading statuses.");
  statusForIssue(siteUrl, status);
  const transitions = await api.listTransitions({ key }, pin);
  if (revisionAtStart !== jiraConnectionRevision) throw new Error("Jira connection changed while loading statuses.");
  return transitions;
}

/* ── Project and picker catalogs ───────────────────────────────────────── */

type ProjectEntry = { projects: JiraProject[]; fetchedAt: number; promise: Promise<JiraProject[]> | null; error: string | null };
const projects = new Map<string, ProjectEntry>();
const EMPTY_PROJECTS: ProjectEntry = { projects: [], fetchedAt: 0, promise: null, error: null };

export function loadJiraProjects(projectRoot: string | null, options: { force?: boolean; query?: string; siteUrl?: string; pin?: OpenProjectBinding | null } = {}): Promise<JiraProject[]> {
  const site = options.siteUrl ? normalizeJiraSite(options.siteUrl) : "";
  const key = `${jiraConnectionRevision}:${scopeKey(projectRoot, options.pin)}:${site}:${options.query?.trim().toLowerCase() ?? ""}`;
  const current = projects.get(key) ?? EMPTY_PROJECTS;
  if (current.promise) return current.promise;
  if (!options.force && Date.now() - current.fetchedAt < LIST_STALE_MS) return Promise.resolve(current.projects);
  const read = window.ade?.jira?.listProjects;
  if (!read) return Promise.resolve([]);
  const revisionAtStart = jiraConnectionRevision;
  const promise = read({ query: options.query }, options.pin)
    .then((rows) => {
      if (revisionAtStart !== jiraConnectionRevision) return [];
      const next = rows ?? [];
      projects.set(key, { projects: next, fetchedAt: Date.now(), promise: null, error: null });
      return next;
    })
    .catch((error: unknown) => {
      if (revisionAtStart !== jiraConnectionRevision) return [];
      projects.set(key, { ...current, fetchedAt: Date.now(), promise: null, error: jiraErrorMessage(error, "Couldn't load Jira projects.") });
      throw error;
    })
    .finally(notify);
  projects.set(key, { ...current, promise });
  notify();
  return promise;
}

export function useJiraProjects(enabled = true, siteUrl = "", pin?: OpenProjectBinding | null): { projects: JiraProject[]; loading: boolean; error: string | null; refresh: () => Promise<JiraProject[]> } {
  const projectRoot = useActiveProjectRoot();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const key = `${jiraConnectionRevision}:${scopeKey(projectRoot, pin)}:${normalizeJiraSite(siteUrl)}:`;
  const entry = useSyncExternalStore(subscribe, () => projects.get(key) ?? EMPTY_PROJECTS, () => EMPTY_PROJECTS);
  const refresh = useCallback(() => loadJiraProjects(projectRoot, { force: true, siteUrl, pin: pinRef.current }), [pinKey, projectRoot, siteUrl]);
  useEffect(() => {
    if (!enabled) return undefined;
    void loadJiraProjects(projectRoot, { siteUrl, pin: pinRef.current }).catch(() => {});
    const onConnectionChanged = () => { void loadJiraProjects(projectRoot, { force: true, siteUrl, pin: pinRef.current }).catch(() => {}); };
    window.addEventListener(JIRA_CONNECTION_CHANGED_EVENT, onConnectionChanged);
    return () => window.removeEventListener(JIRA_CONNECTION_CHANGED_EVENT, onConnectionChanged);
  }, [enabled, pinKey, projectRoot, siteUrl]);
  return { projects: entry.projects, loading: entry.promise != null, error: entry.error, refresh };
}

const createMeta = new Map<string, { value: JiraCreateMeta | null; promise: Promise<JiraCreateMeta | null> | null }>();
export function loadJiraCreateMeta(projectRoot: string | null, projectKey: string, force = false, pin?: OpenProjectBinding | null): Promise<JiraCreateMeta | null> {
  const key = `${jiraConnectionRevision}:${scopeKey(projectRoot, pin)}:${projectKey.toUpperCase()}`;
  const current = createMeta.get(key) ?? { value: null, promise: null };
  if (current.promise) return current.promise;
  if (!force && current.value) return Promise.resolve(current.value);
  const read = window.ade?.jira?.getCreateMeta;
  if (!read) return Promise.resolve(null);
  const revisionAtStart = jiraConnectionRevision;
  const promise = read({ projectKey }, pin)
    .then((value) => {
      if (revisionAtStart !== jiraConnectionRevision) return null;
      createMeta.set(key, { value, promise: null });
      return value;
    })
    .catch((error: unknown) => {
      if (revisionAtStart !== jiraConnectionRevision) return null;
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
export function loadJiraAssignableUsers(projectRoot: string | null, input: { projectKey?: string; key?: string; query?: string } = {}, pin?: OpenProjectBinding | null): Promise<JiraUser[]> {
  const cacheKey = `${jiraConnectionRevision}:${scopeKey(projectRoot, pin)}:${input.projectKey ?? ""}:${input.key ?? ""}:${input.query?.trim().toLowerCase() ?? ""}`;
  const current = assignableUsers.get(cacheKey) ?? { users: [], promise: null };
  if (current.users.length > 0) return Promise.resolve(current.users);
  if (current.promise) return current.promise;
  const read = window.ade?.jira?.listAssignableUsers;
  if (!read) return Promise.resolve([]);
  const revisionAtStart = jiraConnectionRevision;
  const promise = read(input, pin)
    .then((users) => {
      if (revisionAtStart !== jiraConnectionRevision) return [];
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
export function loadJiraLabels(projectRoot: string | null, query = "", pin?: OpenProjectBinding | null): Promise<string[]> {
  const key = `${jiraConnectionRevision}:${scopeKey(projectRoot, pin)}:${query.trim().toLowerCase()}`;
  const current = labelCatalogs.get(key) ?? { labels: [], promise: null };
  if (current.labels.length > 0) return Promise.resolve(current.labels);
  if (current.promise) return current.promise;
  const read = window.ade?.jira?.listLabels;
  if (!read) return Promise.resolve([]);
  const revisionAtStart = jiraConnectionRevision;
  const promise = read({ query }, pin)
    .then((labels) => {
      if (revisionAtStart !== jiraConnectionRevision) return [];
      labelCatalogs.set(key, { labels: labels ?? [], promise: null });
      return labels ?? [];
    })
    .finally(notify);
  labelCatalogs.set(key, { ...current, promise });
  notify();
  return promise;
}

function invalidateJiraConnectionData(): void {
  jiraConnectionRevision += 1;
  connections.clear();
  projects.clear();
  createMeta.clear();
  assignableUsers.clear();
  labelCatalogs.clear();
  lists.clear();
  listRequestVersions.clear();
  notify();
}

if (typeof window !== "undefined") {
  window.addEventListener(JIRA_CONNECTION_CHANGED_EVENT, invalidateJiraConnectionData);
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
  localChanges: Record<string, JiraIssueSummary | null>;
};
const lists = new Map<string, JiraIssueListEntry>();
const listRequestVersions = new Map<string, number>();
const EMPTY_LIST: JiraIssueListEntry = { issues: [], firstPageKeys: [], hasLoadedMore: false, nextCursor: null, fetchedAt: 0, status: "idle", error: null, promise: null, localChanges: {} };

function jiraListKey(projectRoot: string | null, filters: JiraIssueFilters, siteUrl = "", pin?: OpenProjectBinding | null): string {
  const projectKeys = [...(filters.projectKeys ?? [])].map((key) => key.toUpperCase()).sort().join(",");
  return JSON.stringify([jiraConnectionRevision, projectRoot ?? "", normalizeJiraSite(siteUrl), pin?.key ?? "", projectKeys, filters.state ?? "open", filters.assignee ?? "any", filters.query?.trim() ?? ""]);
}

type JiraListKeyParts = {
  revision: number;
  projectRoot: string;
  siteUrl: string;
  pinKey: string;
  projectKeys: string[];
  state: JiraIssueListState;
  assignee: "me" | "any";
  query: string;
};

function parseJiraListKey(key: string): JiraListKeyParts | null {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value) || value.length < 8) return null;
    return {
      revision: Number(value[0]),
      projectRoot: String(value[1] ?? ""),
      siteUrl: String(value[2] ?? ""),
      pinKey: String(value[3] ?? ""),
      projectKeys: String(value[4] ?? "").split(",").filter(Boolean),
      state: value[5] === "done" || value[5] === "all" ? value[5] : "open",
      assignee: value[6] === "me" ? "me" : "any",
      query: String(value[7] ?? ""),
    };
  } catch {
    return null;
  }
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

function syncJiraIssueLists(projectRoot: string | null, siteUrl: string, detail: JiraIssueDetail, pin?: OpenProjectBinding | null): void {
  const summary = summaryFromDetail(detail);
  const normalizedSite = normalizeJiraSite(siteUrl);
  const normalizedRoot = projectRoot ?? "";
  const pinKey = pin?.key ?? "";
  let changed = false;
  for (const [key, list] of lists) {
    const filters = parseJiraListKey(key);
    if (!filters || filters.revision !== jiraConnectionRevision || filters.projectRoot !== normalizedRoot || filters.siteUrl !== normalizedSite || filters.pinKey !== pinKey) continue;
    const projectMatches = !filters.projectKeys.length || filters.projectKeys.includes(summary.projectKey.toUpperCase());
    if (!projectMatches) continue;
    const stateMatches = filters.state === "all"
      || (filters.state === "done" ? summary.status.category === "done" : summary.status.category !== "done");
    const accountId = connections.get(scopeKey(projectRoot, pin))?.status?.account?.accountId;
    const canEvaluateAssignee = filters.assignee !== "me" || Boolean(accountId);
    const assigneeMatches = filters.assignee !== "me" || Boolean(accountId && summary.assignee?.accountId === accountId);
    const currentlyPresent = list.issues.some((issue) => issue.key === summary.key);

    if (!stateMatches || (canEvaluateAssignee && !assigneeMatches)) {
      // A request in flight may still return this issue, so the removal is
      // recorded even when the row is not cached yet.
      if (!currentlyPresent && !list.promise) continue;
      lists.set(key, {
        ...list,
        issues: list.issues.filter((issue) => issue.key !== summary.key),
        localChanges: { ...list.localChanges, [summary.key.toUpperCase()]: null },
      });
      changed = true;
      continue;
    }

    if (!canEvaluateAssignee || filters.query) {
      listRequestVersions.set(key, (listRequestVersions.get(key) ?? 0) + 1);
      lists.set(key, { ...EMPTY_LIST, status: "idle", fetchedAt: 0 });
      changed = true;
      continue;
    }
    if (!currentlyPresent) continue;
    lists.set(key, {
      ...list,
      issues: list.issues.map((issue) => issue.key === summary.key ? summary : issue),
      localChanges: { ...list.localChanges, [summary.key.toUpperCase()]: summary },
    });
    changed = true;
  }
  if (changed) notify();
}

export function loadJiraIssueList(
  projectRoot: string | null,
  filters: JiraIssueFilters,
  options: { force?: boolean; cursor?: string | null; siteUrl?: string; pin?: OpenProjectBinding | null } = {},
): Promise<void> {
  const pin = options.pin;
  const revisionAtStart = jiraConnectionRevision;
  const key = jiraListKey(projectRoot, filters, options.siteUrl, pin);
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
  const requestVersion = (listRequestVersions.get(key) ?? 0) + 1;
  listRequestVersions.set(key, requestVersion);
  const promise = read({ ...filters, limit: PAGE_SIZE, cursor }, pin)
    .then((page: JiraIssuePage) => {
      if (revisionAtStart !== jiraConnectionRevision || listRequestVersions.get(key) !== requestVersion) return;
      const latest = lists.get(key) ?? EMPTY_LIST;
      const rows = page.issues ?? [];
      for (const issue of rows) primeJiraIssue(projectRoot, issue, pin);
      const firstPageKeys = cursor ? latest.firstPageKeys : rows.map((issue) => issue.key);
      const firstPageSet = new Set(firstPageKeys);
      const oldFirstPageSet = new Set(latest.firstPageKeys);
      const refreshedKeys = new Set(rows.map((issue) => issue.key));
      const retainedLaterPages = !cursor && latest.hasLoadedMore
        ? latest.issues.filter((issue) => !oldFirstPageSet.has(issue.key) && !firstPageSet.has(issue.key) && !refreshedKeys.has(issue.key))
        : [];
      const baseIssues = cursor ? mergeJiraIssues(latest.issues, rows) : mergeJiraIssues(rows, retainedLaterPages);
      const issueMap = new Map(baseIssues.map((issue) => [issue.key.toUpperCase(), issue]));
      for (const [changedKey, changedIssue] of Object.entries(latest.localChanges)) {
        if (changedIssue) issueMap.set(changedKey, changedIssue);
        else issueMap.delete(changedKey);
      }
      lists.set(key, {
        ...latest,
        issues: [...issueMap.values()],
        firstPageKeys,
        hasLoadedMore: cursor ? true : latest.hasLoadedMore,
        nextCursor: cursor ? page.nextCursor ?? null : latest.hasLoadedMore ? latest.nextCursor : page.nextCursor ?? null,
        fetchedAt: Date.now(),
        status: "ready",
        error: null,
        promise: null,
        localChanges: {},
      });
    })
    .catch((error: unknown) => {
      if (revisionAtStart !== jiraConnectionRevision || listRequestVersions.get(key) !== requestVersion) return;
      const latest = lists.get(key) ?? EMPTY_LIST;
      lists.set(key, {
        ...latest,
        status: "error",
        error: jiraErrorMessage(error, "Jira request failed."),
        promise: null,
      });
    })
    .finally(notify);
  lists.set(key, { ...current, status: current.issues.length ? current.status : "loading", promise });
  notify();
  return promise;
}

export function useJiraIssueList(filters: JiraIssueFilters, enabled = true, siteUrl = "", pin?: OpenProjectBinding | null): JiraIssueListEntry & { refresh: () => void; loadMore: () => void } {
  const projectRoot = useActiveProjectRoot();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const key = jiraListKey(projectRoot, filters, siteUrl, pin);
  const entry = useSyncExternalStore(subscribe, () => lists.get(key) ?? EMPTY_LIST, () => EMPTY_LIST);
  // `entry.status` re-runs this after an invalidation (back to idle); a failed
  // read is not retried on its own, only by refresh or a scope change.
  useEffect(() => {
    if (enabled && entry.status !== "error") void loadJiraIssueList(projectRoot, filters, { siteUrl, pin: pinRef.current });
  }, [enabled, entry.status, pinKey, projectRoot, key]);
  const refresh = useCallback(() => { if (enabled) void loadJiraIssueList(projectRoot, filters, { force: true, siteUrl, pin: pinRef.current }); }, [enabled, key, pinKey, projectRoot]);
  const loadMore = useCallback(() => {
    if (!enabled) return;
    const current = lists.get(key);
    if (current?.nextCursor) void loadJiraIssueList(projectRoot, filters, { cursor: current.nextCursor, siteUrl, pin: pinRef.current });
  }, [enabled, key, pinKey, projectRoot, siteUrl]);
  return { ...entry, refresh, loadMore };
}

export function noteJiraIssueCreated(projectRoot: string | null, issue: JiraIssueSummary, pin?: OpenProjectBinding | null): void {
  primeJiraIssue(projectRoot, issue, pin);
  const issueSite = normalizeJiraSite(new URL(issue.url).origin);
  const normalizedRoot = projectRoot ?? "";
  const pinKey = pin?.key ?? "";
  const filterStates: JiraIssueListState[] = ["open", "all"];
  for (const [key, list] of lists) {
    const filters = parseJiraListKey(key);
    if (!filters || filters.revision !== jiraConnectionRevision || filters.projectRoot !== normalizedRoot || filters.siteUrl !== issueSite || filters.pinKey !== pinKey || !filterStates.includes(filters.state)) continue;
    if (filters.projectKeys.length && !filters.projectKeys.includes(issue.projectKey.toUpperCase())) continue;
    if (filters.assignee === "me" || filters.query) continue;
    const alreadyPresent = list.issues.some((row) => row.key === issue.key);
    lists.set(key, {
      ...list,
      issues: alreadyPresent ? list.issues.map((row) => row.key === issue.key ? issue : row) : mergeJiraIssues([issue], list.issues),
      localChanges: { ...list.localChanges, [issue.key.toUpperCase()]: issue },
    });
  }
  notify();
}
