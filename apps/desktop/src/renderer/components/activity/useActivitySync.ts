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

const POLL_INTERVAL_MS = 15_000;
const PRESENCE_INTERVAL_MS = 30_000;
const HIDDEN_PRESENCE_INTERVAL_MS = 120_000;
// This backstop must clear a 15s relay request, one 401 retry, and the 30s
// local-runtime fallback so legitimate host failures retain their real error.
const ACTIVITY_SNAPSHOT_TIMEOUT_MS = 75_000;
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
      if (!isCurrentAccountScope(scope) || !preferences) return;
      activityStore.getState().setPreferences(preferences);
    })
    .then(() => {
      if (!isCurrentAccountScope(scope)) return;
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

async function reportPresence(
  ambientSurfaceVisible: boolean,
  visibleItemIds: string[],
  foreground: boolean,
): Promise<void> {
  const api = window.ade?.attention;
  if (!api) return;
  const identity = await resolveDesktopIdentity();
  await api.reportPresence({
    ...identity,
    platform: desktopPlatform(),
    appForeground: foreground,
    ambientSurfaceVisible,
    visibleItemIds: ambientSurfaceVisible
      ? visibleItemIds.slice(0, MAX_VISIBLE_PRESENCE_ITEMS)
      : [],
    observedAt: new Date().toISOString(),
  });
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
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshActivitySnapshot();
    }, POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      foregroundRef.current = document.visibilityState === "visible" && document.hasFocus();
      if (foregroundRef.current) void refreshActivitySnapshot();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
