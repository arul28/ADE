import { useEffect, useMemo, useRef } from "react";

import {
  type AttentionPresence,
  type AttentionSnapshot,
} from "../../../shared/types";
import {
  activityStore,
  useActivityStore,
} from "../../state/activityStore";
import { useAccountStatus } from "../../lib/account";
import { createBackoffPoller } from "../../lib/backoffPoller";
import { createPresenceReporter, type PresenceReporter } from "../../lib/presenceReporter";

const POLL_INTERVAL_MS = 15_000;
// The snapshot is incremental: an unchanged revision costs a relay round trip
// and returns nothing new, so the backstop poll backs off to this cap while
// nothing moves. Live changes and visibility returns reset it.
const SNAPSHOT_POLL_MAX_INTERVAL_MS = 120_000;
const PRESENCE_INTERVAL_MS = 30_000;
const HIDDEN_PRESENCE_INTERVAL_MS = 120_000;
// Focus, blur and visibility can flap several times inside one window switch;
// changes inside this window go out as one report carrying the latest state.
const PRESENCE_COALESCE_MS = 250;
// A failed report doubles the heartbeat interval per failure, up to this. The
// main process already drops reports while the relay is unreachable; this
// covers reports that do fail (a relay refusal, the local brain path).
const PRESENCE_FAILURE_BACKOFF_MAX_MS = 10 * 60_000;
// The main process answers a snapshot inside its own 25s budget (account leg
// plus local fallback); this backstop only catches a renderer-side hang.
const ACTIVITY_SNAPSHOT_TIMEOUT_MS = 35_000;
const PREFERENCES_REFRESH_MS = 60_000;
const MAX_VISIBLE_PRESENCE_ITEMS = 64;
type ActivityAccountScope = {
  generation: number;
  ownerId: string | null;
};

let activityAccountGeneration = 0;
let activityAccountOwnerId: string | null = null;
let refreshPromise: { generation: number; promise: Promise<void> } | null = null;
let identityPromise: Promise<{ deviceId: string; deviceName: string }> | null = null;
let preferencesRefreshPromise: {
  scope: ActivityAccountScope;
  promise: Promise<void>;
} | null = null;
let preferencesRefreshed: {
  scope: ActivityAccountScope;
  at: number;
} | null = null;

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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "ADE couldn’t refresh account Activity.";
}

/** The account the Activity store currently belongs to (null when signed out). */
export function currentActivityAccountOwnerId(): string | null {
  return activityAccountOwnerId;
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
        void refreshActivityPreferences({ generation, ownerId });
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
 * Load the account's Activity preferences into the store. Hide-details and the
 * dock-badge scope govern the Activity surfaces on every platform, so this runs
 * after each snapshot, throttled to once a minute per account.
 */
async function refreshActivityPreferences(
  scope: ActivityAccountScope,
  force = false,
): Promise<void> {
  if (!isCurrentAccountScope(scope)) return;
  if (!scope.ownerId) return;
  if (
    preferencesRefreshPromise
    && sameAccountScope(preferencesRefreshPromise.scope, scope)
  ) {
    return preferencesRefreshPromise.promise;
  }
  if (
    !force
    && preferencesRefreshed
    && sameAccountScope(preferencesRefreshed.scope, scope)
    && Date.now() - preferencesRefreshed.at < PREFERENCES_REFRESH_MS
  ) return;
  const attentionApi = typeof window !== "undefined" ? window.ade?.attention : null;
  if (typeof attentionApi?.getPreferences !== "function") return;
  const ownerId = scope.ownerId;
  // `Promise.resolve().then(…)` rather than a bare call: a host that answers
  // synchronously (or with nothing at all) must land in this chain's own catch
  // instead of throwing past it as an unhandled rejection.
  const promise = Promise.resolve()
    .then(() => attentionApi.getPreferences(ownerId))
    .then((preferences) => {
      // `null`: the account service is unreachable. Keep what is loaded, and
      // do not start the throttle, so the next snapshot tries again.
      if (!isCurrentAccountScope(scope) || !preferences) return;
      activityStore.getState().setPreferences(preferences);
      preferencesRefreshed = { scope, at: Date.now() };
    })
    .catch(() => {
      // The last loaded preferences stay in force while the account's
      // preferences are temporarily unavailable.
    })
    .finally(() => {
      if (preferencesRefreshPromise?.promise === promise) {
        preferencesRefreshPromise = null;
      }
    });
  preferencesRefreshPromise = { scope, promise };
  return promise;
}

/** Keys the removed notch kept on this computer. Cleared once per launch. */
const RETIRED_NOTCH_STORAGE_KEYS = [
  "ade:attention:notch-enabled",
  "ade:attention:notch-reveal-mode",
  "ade:attention:notch-expanded-panel",
  "ade:attention:notch-auto-reveal",
  "ade:attention:notch-ticker",
] as const;
let retiredNotchStorageCleared = false;

function clearRetiredNotchStorage(): void {
  if (retiredNotchStorageCleared || typeof window === "undefined") return;
  retiredNotchStorageCleared = true;
  try {
    for (const key of RETIRED_NOTCH_STORAGE_KEYS) window.localStorage.removeItem(key);
  } catch {
    // A restricted renderer keeps the stale keys; nothing reads them.
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

/**
 * Reports presence and returns whether the person is using this computer
 * (the desktop's OS idle clock), or `null` when that is unknown.
 */
async function reportPresence(
  ambientSurfaceVisible: boolean,
  visibleItemIds: string[],
  foreground: boolean,
  leaving = false,
): Promise<boolean | null> {
  const api = window.ade?.attention;
  if (!api) return null;
  const identity = await resolveDesktopIdentity();
  const receipt = await api.reportPresence({
    ...identity,
    platform: desktopPlatform(),
    appForeground: foreground,
    ambientSurfaceVisible,
    visibleItemIds: ambientSurfaceVisible
      ? visibleItemIds.slice(0, MAX_VISIBLE_PRESENCE_ITEMS)
      : [],
    observedAt: new Date().toISOString(),
    ...(leaving ? { userActive: false } : {}),
  });
  return receipt && typeof receipt.userActive === "boolean" ? receipt.userActive : null;
}

/**
 * Keeps the account-wide Activity snapshot and desktop presence warm even
 * before the user opens Activity, so badges remain truthful.
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

  useEffect(clearRetiredNotchStorage, []);

  useEffect(() => {
    if (accountLoading) return;
    if (activityAccountOwnerId !== accountUserId) {
      activityAccountGeneration += 1;
      activityAccountOwnerId = accountUserId;
      identityPromise = null;
      preferencesRefreshPromise = null;
      preferencesRefreshed = null;
      activityStore.getState().resetStream();
    }
    void refreshActivitySnapshot();
    // Hidden pages pause the poll and returning to view reads at once (the
    // poller's own visibility handling), so a hidden window makes no snapshot
    // calls. A failed read keeps the cadence so a host outage retries promptly.
    const snapshotPoller = createBackoffPoller({
      baseMs: POLL_INTERVAL_MS,
      maxMs: SNAPSHOT_POLL_MAX_INTERVAL_MS,
      isActive: () => true,
      read: async () => {
        const revisionBefore = activityStore.getState().revision;
        await refreshActivitySnapshot();
        const { syncStatus, syncError, revision } = activityStore.getState();
        if (syncStatus === "error") throw new Error(syncError ?? "Activity refresh failed");
        return revision !== revisionBefore;
      },
    });
    snapshotPoller.start();
    const onVisibilityChange = () => {
      foregroundRef.current = document.visibilityState === "visible" && document.hasFocus();
      if (foregroundRef.current) void refreshActivitySnapshot();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      snapshotPoller.stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [accountLoading, accountUserId]);

  const presenceReporterRef = useRef<PresenceReporter | null>(null);
  // This computer can tell whether the person is using it (in use or idle),
  // though maybe not ADE: a hidden window keeps the visible cadence then. In
  // use, the relay's presence window (45 s) never lapses and the phone stays
  // quiet while they work elsewhere; idle, coming back to the keyboard is
  // reported within one beat instead of two minutes.
  const userActivityKnownRef = useRef(false);

  useEffect(() => {
    if (accountLoading || !accountUserId) return;
    userActivityKnownRef.current = false;
    const reporter = createPresenceReporter({
      send: async () => {
        const userActive = await reportPresence(
          ambientSurfaceVisibleRef.current,
          visibleItemIdsRef.current,
          foregroundRef.current,
        );
        userActivityKnownRef.current = typeof userActive === "boolean";
      },
      isVisible: () => document.visibilityState === "visible" || userActivityKnownRef.current,
      visibleIntervalMs: PRESENCE_INTERVAL_MS,
      hiddenIntervalMs: HIDDEN_PRESENCE_INTERVAL_MS,
      maxBackoffMs: PRESENCE_FAILURE_BACKOFF_MAX_MS,
      coalesceMs: PRESENCE_COALESCE_MS,
    });
    presenceReporterRef.current = reporter;
    reporter.start();
    const onVisibilityChange = () => {
      // Coming back reports promptly: a 120s-stale "hidden" claim right as the
      // user returns is the one case that misleads. Going hidden waits — `blur`
      // has already reported the foreground change — but moves the heartbeat
      // to the hidden cadence.
      if (document.visibilityState === "visible") reporter.request();
      else reporter.reschedule();
    };
    const onFocus = () => {
      foregroundRef.current = true;
      reporter.request();
    };
    const onBlur = () => {
      foregroundRef.current = false;
      reporter.request();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      reporter.stop();
      if (presenceReporterRef.current === reporter) presenceReporterRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [accountLoading, accountUserId]);

  // What is on screen changed: report it through the same coalesced sender
  // instead of restarting the heartbeat (and its listeners) on every change.
  // Item ids only travel while an Activity surface is visible, so they only
  // count as a change then.
  const presenceStateKey = ambientSurfaceVisible ? `visible\u001e${visibleItemIdsKey}` : "hidden";
  const lastPresenceStateKeyRef = useRef(presenceStateKey);
  useEffect(() => {
    if (lastPresenceStateKeyRef.current === presenceStateKey) return;
    lastPresenceStateKeyRef.current = presenceStateKey;
    presenceReporterRef.current?.request();
  }, [presenceStateKey]);

  useEffect(() => () => {
    if (accountUserId) void reportPresence(false, [], false, true).catch(() => {});
  }, [accountUserId]);
}
