import { useCallback, useEffect, useSyncExternalStore } from "react";
import type {
  CtoGetLinearIssuePickerDataResult,
  CtoLinearIssueComment,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { useActiveProjectRoot } from "../../state/appStore";
import { applyIssueEdit, type LinearIssueEdit } from "../app/linearIssueBrowserModel";
import { createIssueEntryCache, type IssueEntry, type IssueEntryStatus } from "./issueEntryCache";

/**
 * One cache for every place that shows a single Linear issue: the Issues tab in
 * the Work tools pane, the issue sheet, and the hover card on an issue chip.
 *
 * Three views of one issue must agree: change the status in the tab and the
 * sheet (or the next hover) shows the new status without asking Linear again.
 * So reads, edits and the result of an edit all land in one entry per issue,
 * and views subscribe to the entry rather than holding their own copy.
 *
 * Nothing here polls. An entry is read when a view asks for it, re-read when it
 * is older than `STALE_MS` and a view asks again, and re-read on Refresh.
 */

const STALE_MS = 60_000;
const CATALOG_STALE_MS = 90_000;
const MAX_ENTRIES = 80;

export type LinearIssueEntryStatus = IssueEntryStatus;
export type LinearIssueEntry = IssueEntry<NormalizedLinearIssue>;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const issues = createIssueEntryCache<NormalizedLinearIssue>({ maxEntries: MAX_ENTRIES, staleMs: STALE_MS, notify });

function entryKey(projectRoot: string | null | undefined, identifier: string): string {
  return `${projectRoot ?? ""}::${identifier.trim().toUpperCase()}`;
}

/**
 * Read one issue. `identifier` may be `ADE-123` or a Linear id; Linear's
 * `issue(id:)` accepts both, so a link never has to be searched for.
 */
export function loadLinearIssue(
  projectRoot: string | null | undefined,
  identifier: string,
  options: { force?: boolean } = {},
): Promise<NormalizedLinearIssue | null> {
  const read = window.ade?.cto?.getLinearIssue;
  return issues.load(
    entryKey(projectRoot, identifier),
    read ? async () => (await read({ issueId: identifier.trim() })) ?? null : null,
    { unavailable: "Linear is not available here.", failed: "Linear request failed." },
    options,
  );
}

/** The cached copy only, for hover cards that must not cause a request. */
export function peekLinearIssue(projectRoot: string | null | undefined, identifier: string): NormalizedLinearIssue | null {
  return issues.peek(entryKey(projectRoot, identifier));
}

/**
 * Apply one edit optimistically, send one `issueUpdate`, then take Linear's copy
 * or roll back. Two quick edits on one issue: only the newest one's result
 * lands, the same rule the issue browser follows.
 */
export async function editLinearIssue(
  projectRoot: string | null | undefined,
  issue: NormalizedLinearIssue,
  edit: LinearIssueEdit,
  catalog: CtoGetLinearIssuePickerDataResult,
): Promise<void> {
  const update = window.ade?.cto?.updateLinearIssue;
  if (!update) throw new Error("Editing Linear issues is not available here.");
  const keys = [entryKey(projectRoot, issue.identifier), entryKey(projectRoot, issue.id)];
  const snapshot = issues.peek(keys[0]!) ?? issue;
  const optimistic = applyIssueEdit(snapshot, edit, catalog);
  await issues.edit(
    keys,
    snapshot,
    optimistic,
    async () => (await update({ issueId: issue.id, ...edit })) ?? null,
    "Linear rejected the change.",
  );
}

export function useLinearIssue(identifier: string | null): LinearIssueEntry & {
  refresh: () => void;
  projectRoot: string | null;
} {
  const projectRoot = useActiveProjectRoot();
  const key = identifier ? entryKey(projectRoot, identifier) : null;
  const entry = useSyncExternalStore(
    subscribe,
    () => issues.read(key),
    () => issues.empty,
  );
  useEffect(() => {
    if (!identifier) return;
    void loadLinearIssue(projectRoot, identifier);
  }, [identifier, projectRoot]);
  const refresh = useCallback(() => {
    if (identifier) void loadLinearIssue(projectRoot, identifier, { force: true });
  }, [identifier, projectRoot]);
  return { ...entry, refresh, projectRoot };
}

/**
 * The cached copy of an issue, kept current, without ever reading it. For the
 * Issues tab's chips and hover cards: twelve open tabs must not mean twelve
 * requests on mount; the tab you look at reads its issue, the others show what
 * is already known.
 */
export function useLinearIssuePeek(identifier: string | null): NormalizedLinearIssue | null {
  const projectRoot = useActiveProjectRoot();
  const key = identifier ? entryKey(projectRoot, identifier) : null;
  const entry = useSyncExternalStore(
    subscribe,
    () => issues.read(key),
    () => issues.empty,
  );
  return entry.issue;
}

/* ── Picker catalog (states, users, labels) ─────────────────────────────── */

type CatalogEntry = {
  data: CtoGetLinearIssuePickerDataResult | null;
  fetchedAt: number;
  promise: Promise<CtoGetLinearIssuePickerDataResult | null> | null;
};

const catalogs = new Map<string, CatalogEntry>();
const EMPTY_CATALOG_ENTRY: CatalogEntry = { data: null, fetchedAt: 0, promise: null };

function loadCatalog(projectRoot: string | null): Promise<CtoGetLinearIssuePickerDataResult | null> {
  const key = projectRoot ?? "";
  const current = catalogs.get(key);
  if (current?.promise) return current.promise;
  if (current?.data && Date.now() - current.fetchedAt < CATALOG_STALE_MS) return Promise.resolve(current.data);
  const read = window.ade?.cto?.getLinearIssuePickerData;
  if (!read) return Promise.resolve(null);
  const promise = read()
    .then((data) => {
      catalogs.set(key, { data, fetchedAt: Date.now(), promise: null });
      if (projectRoot) storeTeamKeys(projectRoot, { keys: teamKeysFromCatalog(data), checkedAt: Date.now() });
      notify();
      return data;
    })
    .catch(() => {
      catalogs.set(key, { data: current?.data ?? null, fetchedAt: current?.fetchedAt ?? 0, promise: null });
      notify();
      return current?.data ?? null;
    });
  catalogs.set(key, { data: current?.data ?? null, fetchedAt: current?.fetchedAt ?? 0, promise });
  return promise;
}

export function useLinearPickerCatalog(): CtoGetLinearIssuePickerDataResult | null {
  const projectRoot = useActiveProjectRoot();
  const entry = useSyncExternalStore(
    subscribe,
    () => catalogs.get(projectRoot ?? "") ?? EMPTY_CATALOG_ENTRY,
    () => EMPTY_CATALOG_ENTRY,
  );
  useEffect(() => {
    void loadCatalog(projectRoot);
  }, [projectRoot]);
  return entry.data;
}

/* ── Comments ───────────────────────────────────────────────────────────── */

export async function loadLinearIssueComments(issueId: string): Promise<CtoLinearIssueComment[]> {
  const read = window.ade?.cto?.getLinearIssueComments;
  if (!read) return [];
  return (await read({ issueId })) ?? [];
}

/* ── Workspace team keys (for `ADE-123` in prose) ──────────────────────── */

/**
 * The team keys of the connected Linear workspace, so a bare `ADE-123` an agent
 * writes can become an issue chip without matching `SHA-256` or `UTF-8`.
 *
 * Read from the picker catalog at most once an hour per project and kept in
 * localStorage, so opening a chat never costs a Linear request. A failed read
 * (Linear not connected) is remembered for the same hour.
 */
const TEAM_KEYS_STORAGE_PREFIX = "ade.linear.teamKeys.v1:";
const TEAM_KEYS_REFRESH_MS = 60 * 60_000;

type TeamKeysEntry = { keys: string[]; checkedAt: number };

const teamKeys = new Map<string, TeamKeysEntry>();
const teamKeyReads = new Map<string, Promise<void>>();
const EMPTY_TEAM_KEYS: string[] = [];

function readStoredTeamKeys(projectRoot: string): TeamKeysEntry | null {
  try {
    const raw = window.localStorage.getItem(`${TEAM_KEYS_STORAGE_PREFIX}${projectRoot}`);
    const parsed = raw ? (JSON.parse(raw) as Partial<TeamKeysEntry>) : null;
    if (!parsed || !Array.isArray(parsed.keys) || typeof parsed.checkedAt !== "number") return null;
    return { keys: parsed.keys.filter((key): key is string => typeof key === "string"), checkedAt: parsed.checkedAt };
  } catch {
    return null;
  }
}

function storeTeamKeys(projectRoot: string, entry: TeamKeysEntry): void {
  const current = teamKeys.get(projectRoot);
  teamKeys.set(projectRoot, entry);
  try {
    window.localStorage.setItem(`${TEAM_KEYS_STORAGE_PREFIX}${projectRoot}`, JSON.stringify(entry));
  } catch {
    // Storage unavailable: the keys still work for this session.
  }
  if (current?.keys.join(",") !== entry.keys.join(",")) notify();
}

function teamKeysFromCatalog(catalog: CtoGetLinearIssuePickerDataResult): string[] {
  return [...new Set(catalog.states.map((state) => state.teamKey?.trim().toUpperCase()).filter((key): key is string => Boolean(key)))].sort();
}

function refreshTeamKeys(projectRoot: string): void {
  if (teamKeyReads.has(projectRoot)) return;
  const read = window.ade?.cto?.getLinearIssuePickerData;
  if (!read) return;
  const current = teamKeys.get(projectRoot);
  const promise = read()
    .then((catalog) => storeTeamKeys(projectRoot, { keys: teamKeysFromCatalog(catalog), checkedAt: Date.now() }))
    .catch(() => storeTeamKeys(projectRoot, { keys: current?.keys ?? [], checkedAt: Date.now() }))
    .finally(() => teamKeyReads.delete(projectRoot));
  teamKeyReads.set(projectRoot, promise);
}

export function useLinearWorkspaceTeamKeys(): string[] {
  const projectRoot = useActiveProjectRoot();
  const entry = useSyncExternalStore(
    subscribe,
    () => (projectRoot ? teamKeys.get(projectRoot) ?? null : null),
    () => null,
  );
  useEffect(() => {
    if (!projectRoot) return;
    let known = teamKeys.get(projectRoot) ?? null;
    if (!known) {
      known = readStoredTeamKeys(projectRoot);
      if (known) {
        teamKeys.set(projectRoot, known);
        notify();
      }
    }
    if (!known || Date.now() - known.checkedAt > TEAM_KEYS_REFRESH_MS) refreshTeamKeys(projectRoot);
  }, [projectRoot]);
  return entry?.keys ?? EMPTY_TEAM_KEYS;
}

/** Every issue this cache holds, for the create form's "similar issues" hint. */
export function cachedLinearIssues(): NormalizedLinearIssue[] {
  return [...issues.entries.values()].map((entry) => entry.issue).filter((issue): issue is NormalizedLinearIssue => issue != null);
}
