import { useEffect, useMemo, useRef } from "react";

import {
  ATTENTION_CONTRACT_VERSION,
  activityItemTier,
  attentionPhasePriority,
  sanitizeAttentionPreview,
  type AttentionCounts,
  type AttentionEventKind,
  type AttentionItem,
  type AttentionNotchSettings,
  type AttentionNotchToast,
  type AttentionNotchToastTreatment,
  type AttentionPhase,
  type AttentionPresence,
  type AttentionSnapshot,
} from "../../../shared/types";
import {
  acknowledgeActivityItem,
  activityStore,
  useActivityStore,
} from "../../state/activityStore";
import { useAccountStatus } from "../../lib/account";
import { activitySections, summarizeActivity } from "./activityPriority";
import {
  activityNotchSupported,
  activityNotchSettingsFromPreferences,
  persistActivityNotchSettings,
  readActivityNotchEnabled,
  readActivityNotchPresentation,
  resolveActivityNotchPresentation,
} from "./activityNotchLocalSettings";

export { activityNotchSettingsFromPreferences } from "./activityNotchLocalSettings";

const POLL_INTERVAL_MS = 15_000;
const PRESENCE_INTERVAL_MS = 30_000;
const HIDDEN_PRESENCE_INTERVAL_MS = 120_000;
// This backstop must clear a 15s relay request, one 401 retry, and the 30s
// local-runtime fallback so legitimate host failures retain their real error.
const ACTIVITY_SNAPSHOT_TIMEOUT_MS = 75_000;
const NOTCH_SETTINGS_REFRESH_MS = 60_000;
const MAX_VISIBLE_PRESENCE_ITEMS = 64;
/**
 * The notch receives a projection, not the store. The pipe has a byte budget
 * the router enforces at 192KB, and a 400-row account blows through it — so we
 * ship the top-priority slice and let `counts` carry the honest totals.
 */
export const MAX_NOTCH_PROJECTION_ITEMS = 48;
export const MAX_NOTCH_SNAPSHOT_BYTES = 160 * 1024;
const MAX_NOTCH_PREVIEW_LENGTH = 160;
const MAX_TOAST_TITLE_LENGTH = 256;
const MAX_TOAST_SUBTITLE_LENGTH = 512;
/** One toast per item per 10 minutes, however many times it flaps. */
export const TOAST_ITEM_COOLDOWN_MS = 600_000;
/** And at most one toast every 5s across the whole account. */
export const TOAST_MIN_INTERVAL_MS = 5_000;

type ActivityAccountScope = {
  generation: number;
  ownerId: string | null;
};

let activityAccountGeneration = 0;
let activityAccountOwnerId: string | null = null;
let refreshPromise: { generation: number; promise: Promise<void> } | null = null;
let identityPromise: Promise<{ deviceId: string; deviceName: string }> | null = null;
let notchSettingsRefreshPromise: {
  scope: ActivityAccountScope;
  promise: Promise<void>;
} | null = null;
let notchSettingsRefreshed: {
  scope: ActivityAccountScope;
  at: number;
} | null = null;
let notchSettingsUpdateQueue: Promise<void> = Promise.resolve();

function sameAccountScope(
  left: ActivityAccountScope,
  right: ActivityAccountScope,
): boolean {
  return left.generation === right.generation && left.ownerId === right.ownerId;
}

function isCurrentAccountScope(scope: ActivityAccountScope): boolean {
  return scope.generation === activityAccountGeneration
    && scope.ownerId === activityAccountOwnerId;
}

function unavailableActivitySnapshot(error: unknown): {
  snapshotScope: AttentionSnapshot["scope"];
  availability: NonNullable<AttentionSnapshot["availability"]>;
} {
  const message = errorMessage(error);
  const signedIn = Boolean(activityAccountOwnerId);
  const incompatible = /(?:unsupported|method not found|update .* then restart|needs upgrading)/i
    .test(message);
  if (incompatible) {
    return {
      snapshotScope: activityStore.getState().snapshotScope ?? (signedIn ? "account" : "machine"),
      availability: {
        state: "incompatible",
        title: "Update the connected ADE host",
        message: "This host cannot refresh Activity yet. Update ADE, restart its brain, then retry. Last-known work remains available.",
        recovery: "update_host",
      },
    };
  }
  return {
    snapshotScope: activityStore.getState().snapshotScope ?? (signedIn ? "account" : "machine"),
    availability: {
      state: "degraded",
      title: signedIn
        ? "Account Activity is reconnecting"
        : "This machine’s Activity is unavailable",
      message: signedIn
        ? "ADE couldn’t refresh the account stream. Last-known work remains available while you retry."
        : "ADE couldn’t refresh this machine. Retry to restore live updates.",
      recovery: "retry",
    },
  };
}

function failClosedActivityNotchSettings(): AttentionNotchSettings {
  const presentation = readActivityNotchPresentation();
  return {
    enabled: readActivityNotchEnabled(),
    // Presentation is a layout choice, not a privacy one: keeping the user's
    // chosen mode here stops a lost account load from re-covering the menu bar.
    revealMode: presentation.revealMode,
    expandedPanelEnabled: presentation.expandedPanelEnabled,
    automaticRevealEnabled: presentation.automaticRevealEnabled,
    tickerEnabled: presentation.tickerEnabled,
    preferredDisplayId: null,
    hideDetails: true,
    celebrationsEnabled: false,
    soundsEnabled: false,
  };
}

function enqueueActivityNotchSettingsUpdate(
  scope: ActivityAccountScope,
  settings: AttentionNotchSettings,
): Promise<void> {
  const notchApi = typeof window !== "undefined" ? window.ade?.attentionNotch : null;
  if (!notchApi) return Promise.resolve();
  const update = notchSettingsUpdateQueue
    .catch(() => {
      // A failed older update must not prevent the current account from
      // restoring a known-safe native helper state.
    })
    .then(async () => {
      if (!isCurrentAccountScope(scope)) return;
      await notchApi.updateSettings(settings);
    });
  notchSettingsUpdateQueue = update.catch(() => {});
  return update;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "ADE couldn’t refresh account Activity.";
}

export async function refreshActivitySnapshot(): Promise<void> {
  const generation = activityAccountGeneration;
  const ownerId = activityAccountOwnerId;
  if (refreshPromise?.generation === generation) return refreshPromise.promise;
  const api = typeof window !== "undefined" ? window.ade?.attention : null;
  if (!api) {
    activityStore.getState().setSyncStatus("ready");
    return;
  }

  activityStore.getState().setSyncStatus("syncing");
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const snapshotPromise = Promise.resolve().then(() => api.getSnapshot(
      activityStore.getState().revision,
      activityStore.getState().streamId,
    ));
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(
        "Activity took too long to respond. Retry to restore live updates.",
      ));
    }, ACTIVITY_SNAPSHOT_TIMEOUT_MS);
  });
  const promise = Promise.race([snapshotPromise, timeoutPromise])
    .then((snapshot) => {
      if (
        generation !== activityAccountGeneration
        || ownerId !== activityAccountOwnerId
      ) return;
      activityStore.getState().applySnapshot(snapshot);
      if (ownerId) {
        void refreshActivityNotchSettings({ generation, ownerId });
      }
    })
    .catch((error) => {
      if (generation !== activityAccountGeneration) return;
      activityStore.setState(unavailableActivitySnapshot(error));
      activityStore.getState().setSyncStatus("error", errorMessage(error));
    })
    .finally(() => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (refreshPromise?.promise === promise) refreshPromise = null;
    });
  refreshPromise = { generation, promise };
  return promise;
}

/**
 * One projected row: bounded preview, no `recentActivity` (the notch never
 * renders it and it is the single largest field on a busy agent row). Built
 * fresh so the store's objects are never mutated.
 */
function projectActivityNotchItem(item: AttentionItem): AttentionItem {
  const { recentActivity: _recentActivity, ...rest } = item;
  return {
    ...rest,
    detail: null,
    preview: item.preview.length > MAX_NOTCH_PREVIEW_LENGTH
      ? `${item.preview.slice(0, MAX_NOTCH_PREVIEW_LENGTH - 1)}…`
      : item.preview,
  };
}

function activityNotchCounts(items: readonly AttentionItem[]): AttentionCounts {
  const summary = summarizeActivity(items);
  return {
    needsYou: summary.needsYouCount,
    working: summary.workingCount,
    done: summary.doneCount,
    total: summary.trackedCount,
    machinesOnline: summary.machinesOnline,
    machinesTotal: summary.machinesTotal,
  };
}

export function materializeActivityNotchSnapshot(): AttentionSnapshot {
  const state = activityStore.getState();
  const allItems = Object.values(state.itemsById);
  // Activity's own order, flattened: needs-you, then working, then done.
  // `activitySections` already drops dismissed and expired rows.
  const ordered = activitySections(allItems).flatMap((section) => section.items);
  const projected = ordered
    .slice(0, MAX_NOTCH_PROJECTION_ITEMS)
    .map(projectActivityNotchItem);
  const projectedItemCount = projected.length;
  const snapshot: AttentionSnapshot = {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    scope: state.snapshotScope ?? (activityAccountOwnerId ? "account" : "machine"),
    availability: state.availability ?? {
      state: activityAccountOwnerId ? "ready" : "signed_out",
      title: activityAccountOwnerId ? "Account Activity" : "This machine only",
      message: activityAccountOwnerId
        ? "Live across your ADE account."
        : "Sign in to combine Activity across every ADE machine.",
      recovery: activityAccountOwnerId ? null : "sign_in",
    },
    streamId: state.streamId,
    revision: state.revision,
    generatedAt: state.generatedAt ?? new Date().toISOString(),
    items: [...projected],
    itemsTruncated: projected.length < ordered.length,
    counts: activityNotchCounts(allItems),
    tombstones: [],
  };
  const encoder = new TextEncoder();
  const bytesBeforeBudget = encoder.encode(JSON.stringify(snapshot)).byteLength;
  let bytesAfterBudget = bytesBeforeBudget;
  while (snapshot.items.length > 0 && bytesAfterBudget > MAX_NOTCH_SNAPSHOT_BYTES) {
    snapshot.items.pop();
    snapshot.itemsTruncated = true;
    bytesAfterBudget = encoder.encode(JSON.stringify(snapshot)).byteLength;
  }
  if (snapshot.items.length < projectedItemCount) {
    console.warn(`activity.notch_snapshot_truncated ${JSON.stringify({
      reason: "byte_budget",
      budgetBytes: MAX_NOTCH_SNAPSHOT_BYTES,
      bytesBeforeBudget,
      bytesAfterBudget,
      projectedItems: projectedItemCount,
      publishedItems: snapshot.items.length,
      totalItems: ordered.length,
    })}`);
  }
  return snapshot;
}

export function activityNotchSnapshotSignature(
  snapshot = materializeActivityNotchSnapshot(),
): string {
  return JSON.stringify([
    snapshot.scope ?? null,
    snapshot.availability ?? null,
    snapshot.streamId ?? null,
    snapshot.revision,
    // Counts derive from the full set, so a row falling off the projection can
    // change them without changing a single published row.
    snapshot.counts ?? null,
    ...[...snapshot.items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => [
        item.id,
        item.revision,
        item.seenAt,
        item.dismissedAt,
        item.machine.machineKey,
        item.machine.accountMachineKey ?? null,
        item.machine.deviceId ?? null,
        item.machine.name,
        item.machine.online,
        item.machine.lastSeenAt,
      ]),
  ]);
}

async function publishActivityNotchSnapshot(
  snapshot = materializeActivityNotchSnapshot(),
): Promise<void> {
  const api = typeof window !== "undefined" ? window.ade?.attentionNotch : null;
  if (!api) return;
  await api.publishSnapshot(snapshot);
}

/**
 * Every event kind, mapped. Left exhaustive on purpose: a new kind added to
 * `AttentionEventKind` must fail the build here rather than silently arrive as
 * an `info` toast for something that broke.
 */
const TOAST_TREATMENT_BY_EVENT: Record<AttentionEventKind, AttentionNotchToastTreatment> = {
  agent_running: "info",
  agent_needs_you: "alert",
  agent_failed: "alert",
  agent_completed: "info",
  pr_checks_failing: "alert",
  pr_review_requested: "info",
  pr_changes_requested: "alert",
  pr_merge_ready: "success",
  pr_merged: "celebration",
  pr_opened: "info",
  pr_closed: "info",
};

const PRIVACY_TOAST_TITLE: Record<AttentionItem["kind"], string> = {
  agent: "Agent update",
  pull_request: "Pull request update",
};

export type ActivityToastDecisionInput = {
  items: readonly AttentionItem[];
  /** Phase each item carried the last time this window looked at it. */
  previousPhases: ReadonlyMap<string, AttentionPhase>;
  lastToastAtByItem: ReadonlyMap<string, number>;
  lastToastAt: number;
  availabilityState: string | null;
  automaticRevealEnabled: boolean;
  hideDetails: boolean;
  now?: number;
};

/**
 * The whole "should this interrupt" decision, pure and injectable so cooldown
 * and rate-limit behaviour can be driven deterministically in tests.
 *
 * When several items transition inside one merge exactly one toast is emitted —
 * the highest-priority one — and the rest are dropped rather than queued: a
 * queue would still be announcing the last burst when the next one arrives.
 */
export function activityToastForTransition(
  input: ActivityToastDecisionInput,
): AttentionNotchToast | null {
  const now = input.now ?? Date.now();
  if (!input.automaticRevealEnabled) return null;
  // Degraded/signed-out snapshots carry last-known rows; announcing one as if
  // it just happened would be a lie about freshness.
  if (input.availabilityState !== "ready") return null;
  if (now - input.lastToastAt < TOAST_MIN_INTERVAL_MS) return null;

  let best: AttentionItem | null = null;
  for (const item of input.items) {
    const previous = input.previousPhases.get(item.id);
    // First sighting is not a transition: a window that just opened would
    // otherwise toast the entire backlog.
    if (previous === undefined || previous === item.phase) continue;
    if (activityItemTier(item) !== "signal") continue;
    if (item.seenAt != null || item.dismissedAt != null) continue;
    const lastForItem = input.lastToastAtByItem.get(item.id);
    if (lastForItem !== undefined && now - lastForItem < TOAST_ITEM_COOLDOWN_MS) continue;
    if (
      best === null
      || attentionPhasePriority(item.phase) < attentionPhasePriority(best.phase)
      || (
        attentionPhasePriority(item.phase) === attentionPhasePriority(best.phase)
        && item.id.localeCompare(best.id) < 0
      )
    ) {
      best = item;
    }
  }
  if (!best) return null;

  const treatment = TOAST_TREATMENT_BY_EVENT[best.eventKind] ?? "info";
  const unclampedTitle = input.hideDetails ? PRIVACY_TOAST_TITLE[best.kind] : best.title;
  const unclampedSubtitle = input.hideDetails
    ? best.privacyPreview
    : sanitizeAttentionPreview(best.preview, MAX_TOAST_SUBTITLE_LENGTH);
  return {
    itemId: best.id,
    eventKind: best.eventKind,
    treatment,
    title: unclampedTitle.slice(0, MAX_TOAST_TITLE_LENGTH),
    subtitle: unclampedSubtitle.slice(0, MAX_TOAST_SUBTITLE_LENGTH),
    tone: null,
    durationMs: null,
  };
}

const notchToastPhases = new Map<string, AttentionPhase>();
const notchToastCooldownByItem = new Map<string, number>();
let notchLastToastAt = 0;

function resetActivityToastState(): void {
  notchToastPhases.clear();
  notchToastCooldownByItem.clear();
  notchLastToastAt = 0;
}

/**
 * Runs on the same store subscription that publishes the snapshot, so a merge
 * can never publish rows without having considered whether one of them earned
 * an announcement.
 */
function emitActivityNotchToast(snapshot: AttentionSnapshot): void {
  const items = Object.values(activityStore.getState().itemsById);
  const presentation = resolveActivityNotchPresentation(
    activityStore.getState().preferences,
  );
  const toast = activityToastForTransition({
    items,
    previousPhases: notchToastPhases,
    lastToastAtByItem: notchToastCooldownByItem,
    lastToastAt: notchLastToastAt,
    availabilityState: snapshot.availability?.state ?? null,
    automaticRevealEnabled: presentation.automaticRevealEnabled,
    // The notch takes hide-details' fail-closed default, exactly like
    // `failClosedActivityNotchSettings`: it paints over the menu bar of a Mac
    // whose owner may have walked away.
    hideDetails: activityStore.getState().preferences?.account?.hideDetails !== false,
  });
  // Record every phase seen, toast or not, so a suppressed transition is not
  // re-detected as new on the next merge.
  const liveIds = new Set<string>();
  for (const item of items) {
    liveIds.add(item.id);
    notchToastPhases.set(item.id, item.phase);
  }
  for (const id of [...notchToastPhases.keys()]) {
    if (!liveIds.has(id)) notchToastPhases.delete(id);
  }
  const now = Date.now();
  for (const [id, at] of [...notchToastCooldownByItem]) {
    if (now - at >= TOAST_ITEM_COOLDOWN_MS) notchToastCooldownByItem.delete(id);
  }
  if (!toast?.itemId) return;
  const notchApi = window.ade?.attentionNotch;
  if (typeof notchApi?.publishToast !== "function") return;
  void Promise.resolve(notchApi.publishToast(toast))
    .then(() => {
      const publishedAt = Date.now();
      notchLastToastAt = publishedAt;
      notchToastCooldownByItem.set(toast.itemId!, publishedAt);
    })
    .catch(() => {});
}

async function refreshActivityNotchSettings(
  scope: ActivityAccountScope,
  force = false,
): Promise<void> {
  if (!isCurrentAccountScope(scope)) return;
  if (!scope.ownerId) return;
  if (
    notchSettingsRefreshPromise
    && sameAccountScope(notchSettingsRefreshPromise.scope, scope)
  ) {
    return notchSettingsRefreshPromise.promise;
  }
  if (
    !force
    && notchSettingsRefreshed
    && sameAccountScope(notchSettingsRefreshed.scope, scope)
    && Date.now() - notchSettingsRefreshed.at < NOTCH_SETTINGS_REFRESH_MS
  ) return;
  const attentionApi = typeof window !== "undefined" ? window.ade?.attention : null;
  const notchApi = typeof window !== "undefined" ? window.ade?.attentionNotch : null;
  // The notch is optional — it does not exist on the web client at all — but the
  // preferences behind it are not: hide-details and the dock-badge scope govern
  // the Activity surfaces on every platform, so the fetch must not be gated on
  // the native helper being present.
  if (typeof attentionApi?.getPreferences !== "function") return;
  const ownerId = scope.ownerId;
  // `Promise.resolve().then(…)` rather than a bare call: a host that answers
  // synchronously (or with nothing at all) must land in this chain's own catch
  // instead of throwing past it as an unhandled rejection.
  const promise = Promise.resolve()
    .then(() => attentionApi.getPreferences(ownerId))
    .then(async (preferences) => {
      if (!isCurrentAccountScope(scope) || !preferences) return;
      activityStore.getState().setPreferences(preferences);
      if (!notchApi) return;
      await enqueueActivityNotchSettingsUpdate(
        scope,
        activityNotchSettingsFromPreferences(
          preferences,
          readActivityNotchEnabled(),
          resolveActivityNotchPresentation(preferences),
        ),
      );
    })
    .then(() => {
      if (!isCurrentAccountScope(scope)) return;
      notchSettingsRefreshed = { scope, at: Date.now() };
    })
    .catch(() => {
      // The fail-closed settings applied for this account remain in force if
      // its preferences are temporarily unavailable.
    })
    .finally(() => {
      if (notchSettingsRefreshPromise?.promise === promise) {
        notchSettingsRefreshPromise = null;
      }
    });
  notchSettingsRefreshPromise = { scope, promise };
  return promise;
}

async function prepareActivityNotchForAccount(
  scope: ActivityAccountScope,
): Promise<string | null> {
  const notchApi = typeof window !== "undefined" ? window.ade?.attentionNotch : null;
  if (!notchApi || !isCurrentAccountScope(scope)) return null;
  try {
    // Never let the previous account's privacy/animation/sound choices govern
    // a new stream. Clear the old snapshot only after native presentation is
    // private and quiet, then hydrate the new account's preferences.
    await enqueueActivityNotchSettingsUpdate(scope, failClosedActivityNotchSettings());
    if (!isCurrentAccountScope(scope)) return null;
    const snapshot = materializeActivityNotchSnapshot();
    await publishActivityNotchSnapshot(snapshot);
    const publishedSignature = activityNotchSnapshotSignature(snapshot);
    if (!isCurrentAccountScope(scope)) return null;
    if (scope.ownerId) await refreshActivityNotchSettings(scope, true);
    return isCurrentAccountScope(scope) ? publishedSignature : null;
  } catch {
    return null;
  }
}

function fallbackDeviceIdentity(): { deviceId: string; deviceName: string } {
  const storageKey = "ade:attention:desktop-device-id";
  let deviceId = "";
  try {
    deviceId = window.localStorage.getItem(storageKey) ?? "";
    if (!deviceId) {
      deviceId = globalThis.crypto?.randomUUID?.() ?? `desktop-${Date.now().toString(36)}`;
      window.localStorage.setItem(storageKey, deviceId);
    }
  } catch {
    deviceId = `desktop-${Date.now().toString(36)}`;
  }
  return { deviceId, deviceName: "ADE Desktop" };
}

async function resolveDesktopIdentity(): Promise<{ deviceId: string; deviceName: string }> {
  if (identityPromise) return identityPromise;
  identityPromise = (async () => {
    const fallback = fallbackDeviceIdentity();
    try {
      const identity = await window.ade?.account?.getLocalMachineIdentity?.();
      if (!identity?.deviceId) return fallback;
      let deviceName = fallback.deviceName;
      try {
        const directory = await window.ade?.account?.listMachines?.();
        const local = directory?.machines.find(
          (machine) =>
            machine.deviceId === identity.deviceId
            || machine.machineKey === identity.machineKey,
        );
        deviceName = local?.name?.trim() || deviceName;
      } catch {
        // Presence remains useful with a generic device name.
      }
      return { deviceId: identity.deviceId, deviceName };
    } catch {
      return fallback;
    }
  })();
  return identityPromise;
}

function desktopPlatform(): AttentionPresence["platform"] {
  if (typeof navigator === "undefined") return "unknown";
  return /Mac/i.test(navigator.userAgent || navigator.platform) ? "macOS" : "unknown";
}

async function reportPresence(
  ambientSurfaceVisible: boolean,
  visibleItemIds: string[],
  foreground: boolean,
): Promise<void> {
  const api = window.ade?.attention;
  if (!api) return;
  let nativeSurfaceVisible = false;
  try {
    const health = await window.ade?.attentionNotch?.getHealth?.();
    nativeSurfaceVisible = health?.state === "running" && health.surface != null;
  } catch {
    // Presence remains useful when the optional native helper cannot report.
  }
  const effectiveSurfaceVisible = ambientSurfaceVisible || nativeSurfaceVisible;
  const identity = await resolveDesktopIdentity();
  await api.reportPresence({
    ...identity,
    platform: desktopPlatform(),
    appForeground: foreground,
    ambientSurfaceVisible: effectiveSurfaceVisible,
    visibleItemIds: effectiveSurfaceVisible
      ? visibleItemIds.slice(0, MAX_VISIBLE_PRESENCE_ITEMS)
      : [],
    observedAt: new Date().toISOString(),
  });
}

/**
 * Keeps the account-wide Activity snapshot and desktop presence warm even
 * before the user opens Activity, so badges and native surfaces remain truthful.
 */
export function useActivitySync(routeSurfaceVisible: boolean): void {
  const { status: accountStatus, loading: accountLoading } = useAccountStatus();
  const accountUserId = accountStatus.signedIn ? accountStatus.userId : null;
  const itemsById = useActivityStore((state) => state.itemsById);
  const headerSurfaceVisible = useActivityStore((state) => state.headerSurfaceVisible);
  const visibleItemIds = useMemo(
    () => Object.keys(itemsById),
    [itemsById],
  );
  const visibleItemIdsKey = visibleItemIds.join("\u001f");
  const ambientSurfaceVisible = routeSurfaceVisible || headerSurfaceVisible;
  const ambientSurfaceVisibleRef = useRef(ambientSurfaceVisible);
  const visibleItemIdsRef = useRef(visibleItemIds);
  const foregroundRef = useRef(
    typeof document === "undefined"
      ? false
      : document.visibilityState === "visible" && document.hasFocus(),
  );
  ambientSurfaceVisibleRef.current = ambientSurfaceVisible;
  visibleItemIdsRef.current = visibleItemIds;

  useEffect(() => {
    if (accountLoading) return;
    if (activityAccountOwnerId !== accountUserId) {
      activityAccountGeneration += 1;
      activityAccountOwnerId = accountUserId;
      identityPromise = null;
      notchSettingsRefreshPromise = null;
      notchSettingsRefreshed = null;
      resetActivityToastState();
      activityStore.getState().resetStream();
    }
    const accountScope = {
      generation: activityAccountGeneration,
      ownerId: accountUserId,
    };
    let lastNotchSignature = "";
    let notchPrepared = false;
    let prepareNotchPromise: Promise<void> | null = null;
    let notchPublishInFlight = false;
    let notchPublishQueued = false;
    let active = true;
    let unsubscribe = () => {};
    const prepareNotch = () => {
      if (
        notchPrepared
        || prepareNotchPromise
        || !active
        || !isCurrentAccountScope(accountScope)
      ) return;
      const pending = prepareActivityNotchForAccount(accountScope)
        .then((publishedSignature) => {
          if (!active || !publishedSignature || !isCurrentAccountScope(accountScope)) return;
          notchPrepared = true;
          lastNotchSignature = publishedSignature;
          publishNotchIfChanged();
        })
        .finally(() => {
          if (prepareNotchPromise === pending) prepareNotchPromise = null;
        });
      prepareNotchPromise = pending;
    };
    const publishNotchIfChanged = () => {
      const snapshot = materializeActivityNotchSnapshot();
      // Toasts ride this same pass, and deliberately before the signature
      // gate: a phase transition is exactly what earns an announcement, and a
      // republish-suppressed frame must still be able to carry one.
      emitActivityNotchToast(snapshot);
      const nextSignature = activityNotchSnapshotSignature(snapshot);
      if (nextSignature === lastNotchSignature) return;
      if (!notchPrepared) {
        prepareNotch();
        return;
      }
      if (notchPublishInFlight) {
        notchPublishQueued = true;
        return;
      }
      notchPublishInFlight = true;
      void publishActivityNotchSnapshot(snapshot)
        .then(() => {
          if (active && isCurrentAccountScope(accountScope)) {
            lastNotchSignature = nextSignature;
          }
        })
        .catch(() => {
          // Keep the prior signature: the next store update retries this state.
        })
        .finally(() => {
          notchPublishInFlight = false;
          if (notchPublishQueued && active) {
            notchPublishQueued = false;
            publishNotchIfChanged();
          }
        });
    };
    if (activityNotchSupported()) {
      unsubscribe = activityStore.subscribe(publishNotchIfChanged);
      publishNotchIfChanged();
    }
    const removeNotchAcknowledgeListener =
      window.ade?.attentionNotch?.onAcknowledgeRequested((request) => {
        void acknowledgeActivityItem(request.itemId, request.mode)
          .finally(publishNotchIfChanged);
      }) ?? (() => {});
    const removeNotchRefreshListener =
      window.ade?.attentionNotch?.onRefreshRequested?.((request) => {
        if (request?.force !== true && document.visibilityState === "visible") return;
        void refreshActivitySnapshot();
      }) ?? (() => {});
    const removeNotchSettingsListener =
      window.ade?.attentionNotch?.onSettingsChanged?.((settings) => {
        persistActivityNotchSettings(settings);
      }) ?? (() => {});
    void refreshActivitySnapshot();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshActivitySnapshot();
    }, POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      foregroundRef.current = document.visibilityState === "visible" && document.hasFocus();
      if (foregroundRef.current) void refreshActivitySnapshot();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      removeNotchAcknowledgeListener();
      removeNotchRefreshListener();
      removeNotchSettingsListener();
      unsubscribe();
    };
  }, [accountLoading, accountUserId]);

  useEffect(() => {
    if (accountLoading || !accountUserId) return;
    const send = () => {
      void reportPresence(
        ambientSurfaceVisibleRef.current,
        visibleItemIdsRef.current,
        foregroundRef.current,
      ).catch(() => {});
    };
    let timer: number | null = null;
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      const delay = document.visibilityState === "visible"
        ? PRESENCE_INTERVAL_MS
        : HIDDEN_PRESENCE_INTERVAL_MS;
      timer = window.setTimeout(() => {
        timer = null;
        send();
        schedule();
      }, delay);
    };
    send();
    schedule();
    const onVisibilityChange = () => {
      // Coming back reports at once: presence is how other devices learn this
      // machine is being watched, and a 120s-stale "hidden" claim right as the
      // user returns is the one case that misleads. Going hidden waits — `blur`
      // has already reported the foreground change.
      if (document.visibilityState === "visible") send();
      schedule();
    };
    const onFocus = () => {
      foregroundRef.current = true;
      send();
    };
    const onBlur = () => {
      foregroundRef.current = false;
      send();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [accountLoading, accountUserId, ambientSurfaceVisible, visibleItemIdsKey]);

  useEffect(() => () => {
    if (accountUserId) void reportPresence(false, [], false).catch(() => {});
  }, [accountUserId]);
}
