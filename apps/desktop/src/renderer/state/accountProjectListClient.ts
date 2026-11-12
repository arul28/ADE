/**
 * The client's account project list (L24): the one reader that publishes
 * into `publishAccountProjectList`, so the tab bar, Home and every copies hook
 * read the same list.
 *
 * - The source is this computer's brain (`projects.accountList`), a read of a
 *   JSON file the brain keeps current from the account directory. It makes no
 *   server call. The hosted web client has no brain of its own and no reader
 *   yet: there the list stays `unknown` and the app keeps its recents.
 * - A copy in localStorage paints the first frame and covers a brain that is
 *   still starting or offline. A signed-out answer clears it.
 * - Reads: once at start and on window focus (at most one in 15 s), and when
 *   a caller asks (`refreshAccountProjectList`, after an open or a clone). No
 *   timer and no poll.
 * - Machine names for copies on machines with no saved connection come from
 *   the account's machine list. That is a server call, so it runs only when a
 *   copy names an unknown machine, and at most once in 10 minutes.
 */
import { useEffect } from "react";
import { coerceAccountProjectView, type AccountProjectView } from "../../shared/accountProject";
import { isWebClientMode } from "../lib/webClientMode";
import { publishAccountProjectList, type AccountProjectListState } from "./useRepositoryCopies";

export const ACCOUNT_PROJECT_LIST_CACHE_KEY = "ade.accountProjects.cache.v1";
const FOCUS_READ_MIN_MS = 15_000;
const MACHINE_NAMES_MIN_MS = 10 * 60_000;

type CachedList = {
  v: 1;
  userId: string | null;
  projects: AccountProjectView[];
  machineNames: Record<string, string>;
};

function readCache(): CachedList | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ACCOUNT_PROJECT_LIST_CACHE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as Record<string, unknown>;
    if (row.v !== 1 || !Array.isArray(row.projects)) return null;
    const projects = row.projects.map(coerceAccountProjectView).filter((project): project is AccountProjectView => project !== null);
    const names: Record<string, string> = {};
    if (row.machineNames && typeof row.machineNames === "object") {
      for (const [key, value] of Object.entries(row.machineNames as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) names[key] = value;
      }
    }
    return { v: 1, userId: typeof row.userId === "string" ? row.userId : null, projects, machineNames: names };
  } catch {
    return null;
  }
}

function writeCache(next: CachedList | null): void {
  try {
    if (next) window.localStorage.setItem(ACCOUNT_PROJECT_LIST_CACHE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(ACCOUNT_PROJECT_LIST_CACHE_KEY);
  } catch {
    // Storage full or unavailable: the list still holds in memory.
  }
}

function sameProjects(left: readonly AccountProjectView[], right: readonly AccountProjectView[]): boolean {
  return left.length === right.length && JSON.stringify(left) === JSON.stringify(right);
}

function sameNames(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => left[key] === right[key]);
}

let current: AccountProjectListState = { state: "unknown", projects: [] };
let currentUserId: string | null = null;
let starts = 0;
let lastReadAt = 0;
let readInFlight: Promise<void> | null = null;
let lastNamesReadAt = 0;

/**
 * Adds and removes this client made (S13) that the brain may not have read
 * yet: the brain reads the list only after a heartbeat sees the change. Laid
 * over each answer until the answer agrees, or for five minutes.
 */
const PENDING_CHANGE_MS = 5 * 60_000;
const pendingChanges = new Map<string, { project: AccountProjectView | null; at: number }>();

function withPendingChanges(projects: readonly AccountProjectView[]): AccountProjectView[] {
  const now = Date.now();
  let next = [...projects];
  for (const [id, change] of pendingChanges) {
    const listed = next.some((project) => project.id === id);
    const agrees = change.project ? listed : !listed;
    if (agrees || now - change.at > PENDING_CHANGE_MS) {
      pendingChanges.delete(id);
      continue;
    }
    next = change.project ? [...next, change.project] : next.filter((project) => project.id !== id);
  }
  return next;
}

/**
 * Shows an add or a remove at once, before the brain reads it: the Add
 * project form and the Delete window call this with the account's answer.
 */
export function noteAccountProjectChange(change: { added: AccountProjectView } | { removedId: string }): void {
  const id = "added" in change ? change.added.id : change.removedId;
  pendingChanges.set(id, { project: "added" in change ? change.added : null, at: Date.now() });
  if (current.state !== "ready") return;
  const projects = withPendingChanges(current.projects.filter((project) => project.id !== id));
  publish({ ...current, projects });
  writeCache({ v: 1, userId: currentUserId, projects, machineNames: { ...(current.machineNames ?? {}) } });
}

function publish(next: AccountProjectListState): void {
  const unchanged = next.state === current.state
    && sameProjects(next.projects, current.projects)
    && sameNames(next.machineNames ?? {}, current.machineNames ?? {});
  if (unchanged) return;
  current = next;
  publishAccountProjectList(next);
}

async function readMachineNames(projects: readonly AccountProjectView[], known: Readonly<Record<string, string>>): Promise<void> {
  const unknownKeys = new Set<string>();
  for (const project of projects) {
    for (const copy of project.copies) if (!known[copy.machineKey]) unknownKeys.add(copy.machineKey);
  }
  if (unknownKeys.size === 0) return;
  if (Date.now() - lastNamesReadAt < MACHINE_NAMES_MIN_MS) return;
  const listMachines = window.ade?.account?.listMachines;
  if (typeof listMachines !== "function") return;
  lastNamesReadAt = Date.now();
  const result = await listMachines().catch(() => null);
  if (!result || result.state !== "ok") return;
  const names: Record<string, string> = { ...known };
  for (const machine of result.machines) {
    const name = machine.customName?.trim() || machine.name?.trim();
    if (machine.machineKey && name) names[machine.machineKey] = name;
  }
  if (sameNames(names, current.machineNames ?? {})) return;
  if (current.state !== "ready") return;
  publish({ ...current, machineNames: names });
  writeCache({ v: 1, userId: currentUserId, projects: [...current.projects], machineNames: names });
}

async function readList(): Promise<void> {
  const accountList = window.ade?.project?.accountList;
  if (typeof accountList !== "function") return;
  lastReadAt = Date.now();
  const status = await window.ade?.account?.status?.().catch(() => null);
  const userId = status?.userId ?? null;
  const answer = await accountList().catch(() => null);
  if (!answer) return;
  if (answer.state === "signed_out") {
    currentUserId = null;
    writeCache(null);
    publish({ state: "signed_out", projects: [] });
    return;
  }
  if (answer.state === "not_loaded") {
    // The brain has not read the list for this account yet: keep the copy
    // this account left, and only that account's copy.
    if (current.state === "ready" && currentUserId && userId && currentUserId !== userId) {
      currentUserId = userId;
      writeCache(null);
      publish({ state: "unknown", projects: [] });
    }
    return;
  }
  currentUserId = userId;
  const machineNames = current.machineNames ?? {};
  const projects = withPendingChanges(answer.projects);
  publish({ state: "ready", projects, machineNames });
  writeCache({ v: 1, userId, projects, machineNames: { ...machineNames } });
  await readMachineNames(projects, machineNames);
}

/** Reads the list now, or joins the read in flight. */
export function refreshAccountProjectList(options?: { force?: boolean }): Promise<void> {
  if (readInFlight) return readInFlight;
  if (!options?.force && Date.now() - lastReadAt < FOCUS_READ_MIN_MS) return Promise.resolve();
  readInFlight = readList().finally(() => {
    readInFlight = null;
  });
  return readInFlight;
}

function start(): () => void {
  starts += 1;
  if (starts === 1) {
    const cached = readCache();
    if (cached && current.state === "unknown") {
      currentUserId = cached.userId;
      publish({ state: "ready", projects: cached.projects, machineNames: cached.machineNames });
    }
  }
  void refreshAccountProjectList({ force: starts === 1 });
  const onFocus = () => void refreshAccountProjectList();
  window.addEventListener("focus", onFocus);
  return () => {
    starts -= 1;
    window.removeEventListener("focus", onFocus);
  };
}

/** Keeps the account project list current while the caller is mounted (desktop only). */
export function useAccountProjectListClient(): void {
  useEffect(() => {
    if (isWebClientMode()) return undefined;
    return start();
  }, []);
}
