import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type {
  CtoGetLinearIssuePickerDataResult,
  CtoLinearIssueComment,
  NormalizedLinearIssue,
  OpenProjectBinding,
} from "../../../shared/types";
import { useActiveProjectRoot } from "../../state/appStore";
import { useActiveRepositoryReader } from "../../state/repositoryScope";
import { cacheScopePin } from "../../lib/tabBindingKey";
import { applyIssueEdit, type LinearIssueEdit } from "../app/linearIssueBrowserModel";
import { LINEAR_CONNECTION_CHANGED_EVENT } from "../../lib/linearConnectionEvents";
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
 *
 * Every read goes to the repository reader (`useActiveRepositoryReader`), the
 * machine whose Linear connection serves this project. A null pin means no
 * machine is online, and nothing is asked.
 */

type LinearPin = OpenProjectBinding | null;
const NO_MACHINE_MESSAGE = "No computer that has this project is online.";

/** The machine that reads Linear for the open project. */
export function useLinearIssuePin(): LinearPin {
  return useActiveRepositoryReader();
}

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
  /** `pin` null: no machine is online, so only the cache answers. */
  options: { force?: boolean; pin: LinearPin },
): Promise<NormalizedLinearIssue | null> {
  const key = entryKey(projectRoot, identifier);
  if (options.pin === null) return Promise.resolve(issues.peek(key));
  const pin = options.pin;
  const read = window.ade?.cto?.getLinearIssue;
  return issues.load(
    key,
    read ? async () => (await read({ issueId: identifier.trim() }, pin)) ?? null : null,
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
  pin: LinearPin,
): Promise<void> {
  const update = window.ade?.cto?.updateLinearIssue;
  if (!update) throw new Error("Editing Linear issues is not available here.");
  if (!pin) throw new Error(NO_MACHINE_MESSAGE);
  const keys = [entryKey(projectRoot, issue.identifier), entryKey(projectRoot, issue.id)];
  const snapshot = issues.peek(keys[0]!) ?? issue;
  const optimistic = applyIssueEdit(snapshot, edit, catalog);
  await issues.edit(
    keys,
    snapshot,
    optimistic,
    async () => (await update({ issueId: issue.id, ...edit }, pin)) ?? null,
    "Linear rejected the change.",
  );
}

export function useLinearIssue(identifier: string | null): LinearIssueEntry & {
  refresh: () => void;
  projectRoot: string | null;
  /** The machine the issue was read through; edits go there too. */
  pin: LinearPin;
} {
  const projectRoot = useActiveProjectRoot();
  const pin = useLinearIssuePin();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const key = identifier ? entryKey(projectRoot, identifier) : null;
  const entry = useSyncExternalStore(
    subscribe,
    () => issues.read(key),
    () => issues.empty,
  );
  useEffect(() => {
    if (!identifier || !pinRef.current) return;
    void loadLinearIssue(projectRoot, identifier, { pin: pinRef.current });
  }, [identifier, pinKey, projectRoot]);
  const refresh = useCallback(() => {
    if (identifier && pinRef.current) void loadLinearIssue(projectRoot, identifier, { force: true, pin: pinRef.current });
  }, [identifier, pinKey, projectRoot]);
  return { ...entry, refresh, projectRoot, pin };
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

/** The catalog is the machine's Linear connection; the tab's own machine shares the unpinned entry. */
function catalogKey(projectRoot: string | null, pin: LinearPin): string {
  return `${cacheScopePin(pin)?.key ?? ""}|${projectRoot ?? ""}`;
}

function loadCatalog(projectRoot: string | null, pin: OpenProjectBinding): Promise<CtoGetLinearIssuePickerDataResult | null> {
  const key = catalogKey(projectRoot, pin);
  const current = catalogs.get(key);
  if (current?.promise) return current.promise;
  if (current?.data && Date.now() - current.fetchedAt < CATALOG_STALE_MS) return Promise.resolve(current.data);
  const read = window.ade?.cto?.getLinearIssuePickerData;
  if (!read) return Promise.resolve(null);
  const generation = projectRoot ? teamKeyGeneration(projectRoot) : 0;
  const promise = read(pin)
    .then((data) => {
      catalogs.set(key, { data, fetchedAt: Date.now(), promise: null });
      // A catalog asked for before Linear changed workspace names the old teams.
      if (projectRoot && teamKeyGeneration(projectRoot) === generation) {
        storeTeamKeys(projectRoot, { keys: teamKeysFromCatalog(data), checkedAt: Date.now() });
      }
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
  const pin = useLinearIssuePin();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const key = catalogKey(projectRoot, pin);
  const entry = useSyncExternalStore(
    subscribe,
    () => catalogs.get(key) ?? EMPTY_CATALOG_ENTRY,
    () => EMPTY_CATALOG_ENTRY,
  );
  useEffect(() => {
    if (pinRef.current) void loadCatalog(projectRoot, pinRef.current);
  }, [pinKey, projectRoot]);
  return entry.data;
}

/* ── Comments ───────────────────────────────────────────────────────────── */

export async function loadLinearIssueComments(issueId: string, pin: LinearPin): Promise<CtoLinearIssueComment[]> {
  const read = window.ade?.cto?.getLinearIssueComments;
  if (!read || !pin) return [];
  return (await read({ issueId }, pin)) ?? [];
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

/**
 * `workspaceUrlKey` is the connected workspace's URL name (`linear.app/<it>/…`),
 * so a link to another workspace's `ENG-12` is not opened as ours. Undefined
 * until read with the keys; null when Linear is not connected.
 */
export type LinearWorkspaceKeys = { keys: string[]; workspaceUrlKey?: string | null; checkedAt: number };
type TeamKeysEntry = LinearWorkspaceKeys;

const teamKeys = new Map<string, TeamKeysEntry>();
// The running read per project, and a count that moves whenever a read
// starts over (Linear connected, switched or disconnected): a result from an
// older count describes the old workspace and is dropped.
const teamKeyReads = new Map<string, Promise<void>>();
const teamKeyGenerations = new Map<string, number>();
// The connection change each project last started over for: every mounted
// hook hears the event, and one read is enough.
const teamKeyRestartEvents = new Map<string, Event>();
const EMPTY_TEAM_KEYS: string[] = [];

function readStoredTeamKeys(projectRoot: string): TeamKeysEntry | null {
  try {
    const raw = window.localStorage.getItem(`${TEAM_KEYS_STORAGE_PREFIX}${projectRoot}`);
    const parsed = raw ? (JSON.parse(raw) as Partial<TeamKeysEntry>) : null;
    if (!parsed || !Array.isArray(parsed.keys) || typeof parsed.checkedAt !== "number") return null;
    return {
      keys: parsed.keys.filter((key): key is string => typeof key === "string"),
      ...(typeof parsed.workspaceUrlKey === "string" || parsed.workspaceUrlKey === null ? { workspaceUrlKey: parsed.workspaceUrlKey } : {}),
      checkedAt: parsed.checkedAt,
    };
  } catch {
    return null;
  }
}

/** A catalog read carries no workspace, so an entry without one keeps the known one. */
function storeTeamKeys(projectRoot: string, next: TeamKeysEntry): void {
  const current = teamKeys.get(projectRoot);
  const entry = next.workspaceUrlKey === undefined && current?.workspaceUrlKey !== undefined
    ? { ...next, workspaceUrlKey: current.workspaceUrlKey }
    : next;
  teamKeys.set(projectRoot, entry);
  try {
    window.localStorage.setItem(`${TEAM_KEYS_STORAGE_PREFIX}${projectRoot}`, JSON.stringify(entry));
  } catch {
    // Storage unavailable: the keys still work for this session.
  }
  if (current?.keys.join(",") !== entry.keys.join(",") || current?.workspaceUrlKey !== entry.workspaceUrlKey) notify();
}

function teamKeysFromCatalog(catalog: CtoGetLinearIssuePickerDataResult): string[] {
  return [...new Set(catalog.states.map((state) => state.teamKey?.trim().toUpperCase()).filter((key): key is string => Boolean(key)))].sort();
}

function teamKeyGeneration(projectRoot: string): number {
  return teamKeyGenerations.get(projectRoot) ?? 0;
}

/** `restart`: the connection changed, so a running read is stale; start over. */
function refreshTeamKeys(projectRoot: string, pin: OpenProjectBinding, restart = false): void {
  if (teamKeyReads.has(projectRoot) && !restart) return;
  const cto = window.ade?.cto;
  if (!cto?.getLinearIssuePickerData) return;
  const generation = teamKeyGeneration(projectRoot) + 1;
  teamKeyGenerations.set(projectRoot, generation);
  const isCurrent = () => teamKeyGeneration(projectRoot) === generation;
  const store = (next: TeamKeysEntry) => {
    if (isCurrent()) storeTeamKeys(projectRoot, next);
  };
  const current = teamKeys.get(projectRoot);
  const readPicker = cto.getLinearIssuePickerData;
  // The status first: a disconnected workspace has no keys, so nothing it
  // named before should keep linking. Unreadable status keeps what is known.
  const readStatus = cto.getLinearConnectionStatus
    ? cto.getLinearConnectionStatus(pin).then((status) => status, () => null)
    : Promise.resolve(null);
  const promise = readStatus
    .then(async (status) => {
      if (status && !status.connected) {
        store({ keys: [], workspaceUrlKey: null, checkedAt: Date.now() });
        return;
      }
      const catalog = await readPicker(pin);
      const workspaceUrlKey = status ? status.organizationUrlKey?.trim() || null : current?.workspaceUrlKey ?? null;
      store({ keys: teamKeysFromCatalog(catalog), workspaceUrlKey, checkedAt: Date.now() });
    })
    .catch(() => store({ keys: current?.keys ?? [], workspaceUrlKey: current?.workspaceUrlKey ?? null, checkedAt: Date.now() }))
    .finally(() => {
      if (isCurrent()) teamKeyReads.delete(projectRoot);
    });
  teamKeyReads.set(projectRoot, promise);
}

// A project whose keys were never read: empty, and due for a read.
const NEVER_READ_TEAM_KEYS: TeamKeysEntry = { keys: EMPTY_TEAM_KEYS, checkedAt: 0 };

/**
 * The keys this session holds for the project, filled from localStorage on the
 * first read. Filling here, not in an effect, means a page of PR comments
 * parses once with the keys instead of once without and again with them.
 */
function teamKeysEntryFor(projectRoot: string): TeamKeysEntry {
  let entry = teamKeys.get(projectRoot);
  if (!entry) {
    entry = readStoredTeamKeys(projectRoot) ?? NEVER_READ_TEAM_KEYS;
    teamKeys.set(projectRoot, entry);
  }
  return entry;
}

function useTeamKeysEntry(projectRoot: string | null): TeamKeysEntry | null {
  return useSyncExternalStore(
    subscribe,
    () => (projectRoot ? teamKeysEntryFor(projectRoot) : null),
    () => null,
  );
}

export function useLinearWorkspaceTeamKeys(): string[] {
  const projectRoot = useActiveProjectRoot();
  const pin = useLinearIssuePin();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const entry = useTeamKeysEntry(projectRoot);
  useEffect(() => {
    if (!projectRoot) return;
    const known = teamKeysEntryFor(projectRoot);
    const readPin = pinRef.current;
    const due = Date.now() - known.checkedAt > TEAM_KEYS_REFRESH_MS || known.workspaceUrlKey === undefined;
    if (readPin && due) refreshTeamKeys(projectRoot, readPin);
    // Connecting, switching or disconnecting Linear changes the keys now, not in an hour.
    const onConnectionChanged = (event: Event) => {
      if (!pinRef.current || teamKeyRestartEvents.get(projectRoot) === event) return;
      teamKeyRestartEvents.set(projectRoot, event);
      refreshTeamKeys(projectRoot, pinRef.current, true);
    };
    window.addEventListener(LINEAR_CONNECTION_CHANGED_EVENT, onConnectionChanged);
    return () => window.removeEventListener(LINEAR_CONNECTION_CHANGED_EVENT, onConnectionChanged);
  }, [pinKey, projectRoot]);
  return entry?.keys ?? EMPTY_TEAM_KEYS;
}

const NO_WORKSPACE: LinearWorkspaceKeys = { keys: EMPTY_TEAM_KEYS, workspaceUrlKey: null, checkedAt: 0 };

/**
 * The same keys and the workspace's URL name, without ever asking Linear: for
 * a view drawn many times on one page (every PR comment). The page above it
 * keeps them fresh with `useLinearWorkspaceTeamKeys`. Stable until they change.
 */
export function useCachedLinearWorkspace(): LinearWorkspaceKeys {
  return useTeamKeysEntry(useActiveProjectRoot()) ?? NO_WORKSPACE;
}

/** Every issue this cache holds, for the create form's "similar issues" hint. */
export function cachedLinearIssues(): NormalizedLinearIssue[] {
  return [...issues.entries.values()].map((entry) => entry.issue).filter((issue): issue is NormalizedLinearIssue => issue != null);
}
