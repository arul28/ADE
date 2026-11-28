import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type {
  LinearDisplayPreferences,
  LinearIssueViewType,
  OpenProjectBinding,
} from "../../../../shared/types";
import {
  applyLinearDisplayPatch,
  defaultLinearDisplayPreferences,
  mergeLinearDisplayPatches,
  normalizeLinearDisplayPreferences,
  type LinearDisplayPatch,
} from "../../../../shared/linearDisplayPreferences";

/**
 * The list's display settings are Linear's own (`ViewPreferencesValues`): read
 * per tab or custom view from the Linear reader machine, changed here at once,
 * and written back to Linear a moment later.
 *
 * Each view keeps Linear's last read (`base`) and the changes this window made
 * that Linear has not confirmed (`local`: waiting to be written, or refused).
 * What shows is `base` with `local` applied on top, so a read never undoes a
 * change, and a change made before the first read never discards Linear's
 * other values. A read older than a minute is redone when the view is shown
 * again or the window comes back. When Linear refuses a write the change still
 * holds for this session, and the Display menu says so quietly.
 */

const DEFAULT_PREFERENCES: LinearDisplayPreferences = defaultLinearDisplayPreferences();
const MAX_ENTRIES = 40;
const WRITE_DELAY_MS = 450;
const READ_TTL_MS = 60_000;

/** `savedAt`: when Linear confirmed it while there was no read to fold it into. */
type LocalChange = { id: number; patch: LinearDisplayPatch; savedAt: number | null };

type CacheEntry = {
  /** Linear's last answer for this view; null before the first read lands. */
  base: LinearDisplayPreferences | null;
  /** When the last read finished, whether it worked or not (0 = never read). */
  fetchedAt: number;
  promise: Promise<void> | null;
  local: LocalChange[];
  /** `base` with `local` on top; rebuilt on every change so its identity is stable between them. */
  prefs: LinearDisplayPreferences;
  /** null = no write yet this session. */
  savedToLinear: boolean | null;
  reason: string | null;
};

const cache = new Map<string, CacheEntry>();
const listeners = new Set<() => void>();
let version = 0;
let nextChangeId = 1;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion(): number {
  return version;
}

function entryFor(key: string): CacheEntry {
  let entry = cache.get(key);
  if (!entry) {
    entry = { base: null, fetchedAt: 0, promise: null, local: [], prefs: DEFAULT_PREFERENCES, savedToLinear: null, reason: null };
    cache.set(key, entry);
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === key) break;
      cache.delete(oldest);
    }
  }
  return entry;
}

function rebuild(entry: CacheEntry): void {
  let prefs = entry.base ?? DEFAULT_PREFERENCES;
  for (const change of entry.local) prefs = applyLinearDisplayPatch(prefs, change.patch);
  entry.prefs = prefs;
}

type ViewTarget = { key: string; pin: OpenProjectBinding; viewType: LinearIssueViewType; customViewId: string | null };

function readView(target: ViewTarget, force = false): void {
  const cto = typeof window === "undefined" ? null : window.ade?.cto;
  if (typeof cto?.getLinearViewPreferences !== "function") return;
  const entry = entryFor(target.key);
  if (entry.promise) return;
  // A failed read waits out the TTL too, so a refusal is not retried on every focus.
  if (!force && Date.now() - entry.fetchedAt < READ_TTL_MS) return;
  const startedAt = Date.now();
  entry.promise = cto.getLinearViewPreferences({ viewType: target.viewType, customViewId: target.customViewId }, target.pin)
    .then((value) => {
      entry.base = normalizeLinearDisplayPreferences(value);
      // Changes Linear confirmed before this read started are in its answer now.
      entry.local = entry.local.filter((change) => change.savedAt == null || change.savedAt > startedAt);
    })
    .catch((error: unknown) => {
      // An older machine without the method, or Linear refused: keep what shows (defaults at first).
      console.warn("[linear] reading display settings failed", error);
    })
    .finally(() => {
      entry.fetchedAt = Date.now();
      entry.promise = null;
      rebuild(entry);
      notify();
    });
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
  update: (patch: LinearDisplayPatch) => void;
  savedToLinear: boolean | null;
  reason: string | null;
} {
  const pinKey = pin?.key ?? null;
  const key = `${pinKey ?? "none"}::${viewType}::${customViewId ?? ""}`;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  // Any entry's change re-renders; a read that lands after switching views and back still shows.
  useSyncExternalStore(subscribe, getVersion, getVersion);

  useEffect(() => {
    const refresh = () => {
      const readPin = pinRef.current;
      if (readPin) readView({ key, pin: readPin, viewType, customViewId });
    };
    refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // The key holds the pin's key, the view type and the custom view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Rapid toggles collapse into one write per view.
  const pendingRef = useRef<(ViewTarget & { ids: number[]; patch: LinearDisplayPatch }) | null>(null);
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
      notify();
      return;
    }
    void cto.updateLinearViewPreferences(
      { viewType: pending.viewType, customViewId: pending.customViewId, patch: pending.patch },
      pending.pin,
    )
      .then((result) => {
        entry.savedToLinear = result.savedToLinear;
        entry.reason = result.savedToLinear ? null : result.reason ?? null;
        // Linear has these now: fold them into its copy. Before the first read
        // they stay on top (so the read's other values still come through),
        // marked saved so the first read that started after this drops them.
        if (result.savedToLinear) {
          const sent = new Set(pending.ids);
          if (entry.base) {
            for (const change of entry.local) {
              if (sent.has(change.id)) entry.base = applyLinearDisplayPatch(entry.base, change.patch);
            }
            entry.local = entry.local.filter((change) => !sent.has(change.id));
          } else {
            const savedAt = Date.now();
            for (const change of entry.local) {
              if (sent.has(change.id)) change.savedAt = savedAt;
            }
          }
        }
      })
      .catch((error: unknown) => {
        console.warn("[linear] saving display settings failed", error);
        entry.savedToLinear = false;
        entry.reason = error instanceof Error ? error.message : null;
      })
      .finally(() => {
        rebuild(entry);
        notify();
      });
  }, []);

  // Leaving a view (or the window) sends what is still waiting.
  useEffect(() => () => flush(), [flush, key]);

  const update = useCallback((patch: LinearDisplayPatch) => {
    const entry = entryFor(key);
    const change: LocalChange = { id: nextChangeId++, patch, savedAt: null };
    entry.local.push(change);
    rebuild(entry);
    notify();
    const writePin = pinRef.current;
    if (!writePin) return;
    if (pendingRef.current && pendingRef.current.key !== key) flush();
    const previous = pendingRef.current;
    pendingRef.current = {
      key,
      pin: writePin,
      viewType,
      customViewId,
      ids: [...(previous?.ids ?? []), change.id],
      patch: mergeLinearDisplayPatches(previous?.patch ?? null, patch),
    };
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, WRITE_DELAY_MS);
  }, [customViewId, flush, key, viewType]);

  const entry = entryFor(key);
  return {
    prefs: entry.prefs,
    update,
    savedToLinear: entry.savedToLinear,
    reason: entry.reason,
  };
}
