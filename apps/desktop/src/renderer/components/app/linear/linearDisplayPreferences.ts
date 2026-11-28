import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CtoUpdateLinearViewPreferencesArgs,
  LinearDisplayPreferences,
  LinearIssueDisplayFields,
  LinearIssueViewType,
  OpenProjectBinding,
} from "../../../../shared/types";

/**
 * The list's display settings are Linear's own (`ViewPreferencesValues`): read
 * per tab or custom view from the Linear reader machine, changed here at once,
 * and written back to Linear a moment later. When Linear refuses the write the
 * change still holds for this session, and the Display menu says so quietly.
 */

export const LINEAR_DEFAULT_FIELDS: LinearIssueDisplayFields = {
  id: true,
  status: true,
  priority: true,
  assignee: true,
  labels: true,
  project: false,
  cycle: false,
  milestone: false,
  estimate: false,
  dueDate: true,
  pullRequests: true,
  createdAt: true,
  updatedAt: false,
  adeStatus: true,
};

export const LINEAR_DEFAULT_PREFERENCES: LinearDisplayPreferences = {
  grouping: "workflowState",
  subGrouping: "none",
  ordering: "manual",
  orderingDirection: "asc",
  nesting: "showAll",
  showEmptyGroups: false,
  showCompletedIssues: true,
  hiddenGroups: [],
  fields: LINEAR_DEFAULT_FIELDS,
  source: "default",
};

type Patch = CtoUpdateLinearViewPreferencesArgs["patch"];

type CacheEntry = {
  prefs: LinearDisplayPreferences | null;
  promise: Promise<LinearDisplayPreferences> | null;
  /** null = no write yet this session. */
  savedToLinear: boolean | null;
  reason: string | null;
};

const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 40;
const WRITE_DELAY_MS = 450;

function entryFor(key: string): CacheEntry {
  let entry = cache.get(key);
  if (!entry) {
    entry = { prefs: null, promise: null, savedToLinear: null, reason: null };
    cache.set(key, entry);
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === key) break;
      cache.delete(oldest);
    }
  }
  return entry;
}

/** Fills anything an older brain left out, so the UI never reads undefined. */
export function normalizeDisplayPreferences(value: Partial<LinearDisplayPreferences> | null | undefined): LinearDisplayPreferences {
  if (!value || typeof value !== "object") return LINEAR_DEFAULT_PREFERENCES;
  return {
    ...LINEAR_DEFAULT_PREFERENCES,
    ...value,
    hiddenGroups: Array.isArray(value.hiddenGroups) ? value.hiddenGroups : [],
    fields: { ...LINEAR_DEFAULT_FIELDS, ...(value.fields ?? {}) },
  };
}

export function applyDisplayPatch(prefs: LinearDisplayPreferences, patch: Patch): LinearDisplayPreferences {
  return {
    ...prefs,
    ...patch,
    fields: patch.fields ? { ...prefs.fields, ...patch.fields } : prefs.fields,
  } as LinearDisplayPreferences;
}

function mergePatches(left: Patch | null, right: Patch): Patch {
  if (!left) return right;
  return {
    ...left,
    ...right,
    ...(left.fields || right.fields ? { fields: { ...(left.fields ?? {}), ...(right.fields ?? {}) } } : {}),
  };
}

export function useLinearDisplayPreferences({
  pin,
  viewType,
  customViewId,
}: {
  pin: OpenProjectBinding | null;
  viewType: LinearIssueViewType;
  customViewId: string | null;
}): {
  prefs: LinearDisplayPreferences;
  update: (patch: Patch) => void;
  savedToLinear: boolean | null;
  reason: string | null;
} {
  const pinKey = pin?.key ?? null;
  const key = `${pinKey ?? "none"}::${viewType}::${customViewId ?? ""}`;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    const entry = entryFor(key);
    const cto = typeof window === "undefined" ? null : window.ade?.cto;
    const readPin = pinRef.current;
    if (entry.prefs || entry.promise || !readPin || typeof cto?.getLinearViewPreferences !== "function") {
      bump();
      return;
    }
    let cancelled = false;
    const promise = cto.getLinearViewPreferences({ viewType, customViewId }, readPin);
    entry.promise = promise;
    void promise
      .then((value) => {
        // A change made while the read was out wins over what Linear had.
        if (!entry.prefs) entry.prefs = normalizeDisplayPreferences(value);
      })
      .catch(() => {
        // An older machine without the method, or Linear refused: defaults.
        if (!entry.prefs) entry.prefs = LINEAR_DEFAULT_PREFERENCES;
      })
      .finally(() => {
        entry.promise = null;
        if (!cancelled) bump();
      });
    return () => { cancelled = true; };
    // The key holds the pin's key, the view type and the custom view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Rapid toggles collapse into one write per view.
  const pendingRef = useRef<{ key: string; patch: Patch; pin: OpenProjectBinding; viewType: LinearIssueViewType; customViewId: string | null } | null>(null);
  const timerRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    const cto = window.ade?.cto;
    const entry = entryFor(pending.key);
    if (typeof cto?.updateLinearViewPreferences !== "function") {
      entry.savedToLinear = false;
      entry.reason = "This machine's ADE can't save display settings to Linear.";
      bump();
      return;
    }
    void cto.updateLinearViewPreferences(
      { viewType: pending.viewType, customViewId: pending.customViewId, patch: pending.patch },
      pending.pin,
    )
      .then((result) => {
        entry.savedToLinear = result.savedToLinear;
        entry.reason = result.savedToLinear ? null : result.reason ?? null;
      })
      .catch((error: unknown) => {
        entry.savedToLinear = false;
        entry.reason = error instanceof Error ? error.message : null;
      })
      .finally(bump);
  }, [bump]);

  // Leaving a view (or the window) sends what is still waiting.
  useEffect(() => () => flush(), [flush, key]);

  const update = useCallback((patch: Patch) => {
    const entry = entryFor(key);
    entry.prefs = applyDisplayPatch(entry.prefs ?? LINEAR_DEFAULT_PREFERENCES, patch);
    bump();
    const writePin = pinRef.current;
    if (!writePin) return;
    if (pendingRef.current && pendingRef.current.key !== key) flush();
    pendingRef.current = {
      key,
      pin: writePin,
      viewType,
      customViewId,
      patch: mergePatches(pendingRef.current?.patch ?? null, patch),
    };
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, WRITE_DELAY_MS);
  }, [bump, customViewId, flush, key, viewType]);

  const entry = entryFor(key);
  return {
    prefs: entry.prefs ?? LINEAR_DEFAULT_PREFERENCES,
    update,
    savedToLinear: entry.savedToLinear,
    reason: entry.reason,
  };
}
