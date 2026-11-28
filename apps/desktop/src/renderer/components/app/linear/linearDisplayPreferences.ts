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

type DisplayControl = "grouping" | "ordering" | "nesting" | "fields" | "completed" | "hidden_groups";

function changedControl(patch: LinearDisplayPatch): DisplayControl | null {
  if (patch.grouping !== undefined || patch.subGrouping !== undefined) return "grouping";
  if (patch.ordering !== undefined || patch.orderingDirection !== undefined) return "ordering";
  if (patch.nesting !== undefined || patch.showEmptyGroups !== undefined) return "nesting";
  if (patch.showCompletedIssues !== undefined) return "completed";
  if (patch.hiddenGroups !== undefined) return "hidden_groups";
  if (patch.fields && Object.keys(patch.fields).length > 0) return "fields";
  return null;
}

/**
 * One coarse product fact per Display control a person changes: which control,
 * never the value, view, team or issue. At most once an hour per control,
 * inside the `ade_feature_used` 140-per-day / 30-per-minute limits.
 */
function captureDisplayChange(patch: LinearDisplayPatch): void {
  const control = changedControl(patch);
  if (!control) return;
  void window.ade?.analytics?.capture({
    event: "ade_feature_used",
    properties: { feature: "issues", action: "issue_display_changed", outcome: `display_${control}`, source: "renderer_route" },
    dedupeKey: `issue_display_changed:${control}`,
    minimumIntervalMs: 60 * 60_000,
  }).catch(() => undefined);
}

/**
 * One display change, in the order it was made (`id`). `state`: waiting to be
 * written, in a write that has not answered, lost (the write never reached the
 * brain; the next write carries it), refused (the brain kept it in ADE and sends
 * it along with its next write), or saved before the first read (`savedAt`: the
 * first read that started after then drops it).
 */
type LocalChange = {
  id: number;
  patch: LinearDisplayPatch;
  state: "waiting" | "sent" | "lost" | "refused" | "saved";
  savedAt: number | null;
};

/** The keys a patch sets: top-level settings, and `fields.<name>` per field. */
function patchKeys(patch: LinearDisplayPatch): string[] {
  const { fields, ...rest } = patch;
  const keys = Object.entries(rest).filter(([, value]) => value !== undefined).map(([key]) => key);
  for (const [name, value] of Object.entries(fields ?? {})) if (value !== undefined) keys.push(`fields.${name}`);
  return keys;
}

function withoutKeys(patch: LinearDisplayPatch, drop: (key: string) => boolean): LinearDisplayPatch {
  const { fields, ...rest } = patch;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) if (value !== undefined && !drop(key)) out[key] = value;
  const keptFields = Object.fromEntries(
    Object.entries(fields ?? {}).filter(([name, value]) => value !== undefined && !drop(`fields.${name}`)),
  );
  if (Object.keys(keptFields).length > 0) out.fields = keptFields;
  return out as LinearDisplayPatch;
}

/**
 * A change with every key a newer choice already set taken out: a newer local
 * change of any state, or a newer change Linear already saved. So an older
 * change that is retried, or still shown, never undoes a newer one.
 */
function effectivePatch(entry: CacheEntry, change: LocalChange): LinearDisplayPatch {
  const newerKeys = new Set<string>();
  for (const other of entry.local) if (other.id > change.id) for (const key of patchKeys(other.patch)) newerKeys.add(key);
  return withoutKeys(change.patch, (key) => newerKeys.has(key) || (entry.savedKeyIds.get(key) ?? 0) > change.id);
}

type CacheEntry = {
  /** Linear's last answer for this view; null before the first read lands. */
  base: LinearDisplayPreferences | null;
  /** When the last read finished, whether it worked or not (0 = never read). */
  fetchedAt: number;
  promise: Promise<void> | null;
  local: LocalChange[];
  /** `base` with `local` on top; rebuilt on every change so its identity is stable between them. */
  prefs: LinearDisplayPreferences;
  /** Per key, the newest change id Linear saved for it (folded into `base`). */
  savedKeyIds: Map<string, number>;
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
    entry = { base: null, fetchedAt: 0, promise: null, local: [], prefs: DEFAULT_PREFERENCES, savedKeyIds: new Map(), savedToLinear: null, reason: null };
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
  // A lost or refused change that newer saved choices fully replaced has
  // nothing left to send or show.
  entry.local = entry.local.filter(
    (change) => (change.state !== "lost" && change.state !== "refused") || patchKeys(effectivePatch(entry, change)).length > 0,
  );
  let prefs = entry.base ?? DEFAULT_PREFERENCES;
  for (const change of entry.local) prefs = applyLinearDisplayPatch(prefs, effectivePatch(entry, change));
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
      // Changes Linear confirmed before this read started are in its answer now;
      // their keys still outrank any older change that is retried later.
      entry.local = entry.local.filter((change) => {
        if (change.savedAt == null || change.savedAt > startedAt) return true;
        for (const key of patchKeys(change.patch)) {
          entry.savedKeyIds.set(key, Math.max(entry.savedKeyIds.get(key) ?? 0, change.id));
        }
        return false;
      });
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
  const pendingRef = useRef<ViewTarget | null>(null);
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
    // Everything not yet in Linear goes in one write, oldest first, each
    // change without the keys a newer choice already set.
    const batch = entry.local.filter((change) => change.state === "waiting" || change.state === "lost");
    if (batch.length === 0) return;
    const patch = batch.reduce<LinearDisplayPatch>(
      (merged, change) => mergeLinearDisplayPatches(merged, effectivePatch(entry, change)),
      {},
    );
    for (const change of batch) change.state = "sent";
    const sentIds = new Set(batch.map((change) => change.id));
    void cto.updateLinearViewPreferences(
      { viewType: pending.viewType, customViewId: pending.customViewId, patch },
      pending.pin,
    )
      .then((result) => {
        entry.savedToLinear = result.savedToLinear;
        entry.reason = result.savedToLinear ? null : result.reason ?? null;
        if (!result.savedToLinear) {
          for (const change of entry.local) if (sentIds.has(change.id)) change.state = "refused";
          return;
        }
        // Saved: this write, plus earlier refused changes the brain sent along.
        const newest = Math.max(...sentIds);
        const saved = entry.local.filter(
          (change) => sentIds.has(change.id) || (change.state === "refused" && change.id < newest),
        );
        if (entry.base) {
          // Fold them into Linear's copy and remember which keys they set, so an
          // older change still shown or retried cannot undo them.
          for (const change of saved) {
            entry.base = applyLinearDisplayPatch(entry.base, effectivePatch(entry, change));
            for (const key of patchKeys(change.patch)) {
              entry.savedKeyIds.set(key, Math.max(entry.savedKeyIds.get(key) ?? 0, change.id));
            }
          }
          const savedIds = new Set(saved.map((change) => change.id));
          entry.local = entry.local.filter((change) => !savedIds.has(change.id));
        } else {
          // Before the first read they stay on top (so the read's other values
          // still come through), marked saved for the first read after this.
          const savedAt = Date.now();
          for (const change of saved) {
            change.state = "saved";
            change.savedAt = savedAt;
          }
        }
      })
      .catch((error: unknown) => {
        console.warn("[linear] saving display settings failed", error);
        // The brain never got these: the next write for this view carries them.
        for (const change of entry.local) if (sentIds.has(change.id) && change.state === "sent") change.state = "lost";
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
    const change: LocalChange = { id: nextChangeId++, patch, state: "waiting", savedAt: null };
    entry.local.push(change);
    rebuild(entry);
    notify();
    captureDisplayChange(patch);
    const writePin = pinRef.current;
    if (!writePin) return;
    if (pendingRef.current && pendingRef.current.key !== key) flush();
    pendingRef.current = { key, pin: writePin, viewType, customViewId };
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
