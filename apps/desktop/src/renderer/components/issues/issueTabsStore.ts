import { useSyncExternalStore } from "react";
import { issueRefKey, parseStoredIssueRef, type IssueRef } from "../../../shared/issueRefs";
import type { OpenProjectBinding } from "../../../shared/types";

/**
 * The issues open in the Work tools pane's Issues tab, per lane.
 *
 * Per lane for the same reason the tool strip is: the lane you are fixing a bug
 * in wants that bug's ticket open, and switching to another lane should not
 * bring it along. Persisted to localStorage so a restart keeps your tickets
 * where you left them; the issues themselves are re-read, never stored.
 */

export type IssueTabsState = {
  refs: IssueRef[];
  activeKey: string | null;
  pins?: Record<string, OpenProjectBinding>;
};

const STORAGE_KEY = "ade.work.issueTabs.v1";
const MAX_SCOPES = 40;
const MAX_TABS_PER_SCOPE = 12;
const EMPTY: IssueTabsState = { refs: [], activeKey: null };

let scopes: Map<string, IssueTabsState> | null = null;
const listeners = new Set<() => void>();

function load(): Map<string, IssueTabsState> {
  if (scopes) return scopes;
  scopes = new Map();
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
        const record = value as { refs?: unknown; activeKey?: unknown; pins?: unknown } | null;
        const refs = Array.isArray(record?.refs)
          ? record!.refs.map(parseStoredIssueRef).filter((ref): ref is IssueRef => ref != null)
          : [];
        if (refs.length === 0) continue;
        const retainedRefs = refs.slice(-MAX_TABS_PER_SCOPE);
        const activeKey = typeof record?.activeKey === "string"
          && retainedRefs.some((ref) => issueRefKey(ref) === record.activeKey)
          ? record.activeKey
          : issueRefKey(retainedRefs[retainedRefs.length - 1]!);
        const pins: Record<string, OpenProjectBinding> = {};
        if (record?.pins && typeof record.pins === "object") {
          for (const ref of retainedRefs) {
            const key = issueRefKey(ref);
            const candidate = (record.pins as Record<string, unknown>)[key];
            if (!candidate || typeof candidate !== "object") continue;
            const value = candidate as Partial<OpenProjectBinding>;
            if ((value.kind === "local" || value.kind === "remote") && typeof value.key === "string") pins[key] = candidate as OpenProjectBinding;
          }
        }
        scopes.set(scope, { refs: retainedRefs, activeKey, ...(Object.keys(pins).length ? { pins } : {}) });
      }
    }
  } catch {
    // A corrupt blob starts empty rather than breaking the pane.
  }
  return scopes;
}

function persist(): void {
  if (!scopes || typeof window === "undefined") return;
  try {
    const out: Record<string, IssueTabsState> = {};
    for (const [scope, state] of scopes) {
      if (state.refs.length > 0) out[scope] = state;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // Storage full or unavailable: the tabs still work for this session.
  }
}

function write(scope: string, next: IssueTabsState): void {
  const map = load();
  map.delete(scope);
  if (next.refs.length > 0) map.set(scope, next);
  while (map.size > MAX_SCOPES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  persist();
  for (const listener of listeners) listener();
}

export function issueTabsScopeKey(projectRoot: string | null, laneId: string | null): string {
  return `${projectRoot ?? ""}::${laneId ?? "-"}`;
}

export function readIssueTabs(scope: string): IssueTabsState {
  return load().get(scope) ?? EMPTY;
}

/** Opens the issue as a tab (or focuses the tab it already has). */
export function openIssueTab(scope: string, ref: IssueRef, pin?: OpenProjectBinding | null): void {
  const current = readIssueTabs(scope);
  const key = issueRefKey(ref);
  const exists = current.refs.some((entry) => issueRefKey(entry) === key);
  const refs = exists ? current.refs : [...current.refs, ref].slice(-MAX_TABS_PER_SCOPE);
  const pins = { ...current.pins };
  if (pin) pins[key] = pin;
  else delete pins[key];
  const retainedKeys = new Set(refs.map(issueRefKey));
  for (const pinnedKey of Object.keys(pins)) if (!retainedKeys.has(pinnedKey)) delete pins[pinnedKey];
  write(scope, { refs, activeKey: key, ...(Object.keys(pins).length ? { pins } : {}) });
}

export function activateIssueTab(scope: string, key: string): void {
  const current = readIssueTabs(scope);
  if (current.activeKey === key || !current.refs.some((ref) => issueRefKey(ref) === key)) return;
  write(scope, { ...current, activeKey: key });
}

/**
 * Closes a tab. The neighbour to the right inherits, then the left — the rule
 * the tool strip itself follows, so closing a run of tabs never jumps.
 */
export function closeIssueTab(scope: string, key: string): void {
  const current = readIssueTabs(scope);
  const index = current.refs.findIndex((ref) => issueRefKey(ref) === key);
  if (index < 0) return;
  const refs = current.refs.filter((_, i) => i !== index);
  const pins = { ...current.pins };
  delete pins[key];
  const activeKey = current.activeKey !== key
    ? current.activeKey
    : refs[index] ? issueRefKey(refs[index]!) : refs[index - 1] ? issueRefKey(refs[index - 1]!) : null;
  write(scope, { refs, activeKey, ...(Object.keys(pins).length ? { pins } : {}) });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useIssueTabs(scope: string): IssueTabsState {
  return useSyncExternalStore(subscribe, () => readIssueTabs(scope), () => EMPTY);
}
