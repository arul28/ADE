import { useEffect, useMemo, useRef } from "react";

import {
  ATTENTION_CONTRACT_VERSION,
  type AttentionNotchSettings,
  type AttentionPresence,
  type AttentionSnapshot,
} from "../../../shared/types";
import {
  acknowledgeAttentionItem,
  attentionStore,
  selectAttentionItems,
  useAttentionStore,
} from "../../state/attentionStore";
import { useAccountStatus } from "../../lib/account";
import {
  attentionNotchSettingsFromPreferences,
  readAttentionNotchEnabled,
} from "./attentionNotchLocalSettings";

export { attentionNotchSettingsFromPreferences } from "./attentionNotchLocalSettings";

const POLL_INTERVAL_MS = 15_000;
const PRESENCE_INTERVAL_MS = 30_000;
const NOTCH_SETTINGS_REFRESH_MS = 60_000;
const MAX_VISIBLE_PRESENCE_ITEMS = 64;

type AttentionAccountScope = {
  generation: number;
  ownerId: string;
};

let attentionAccountGeneration = 0;
let attentionAccountOwnerId: string | null = null;
let refreshPromise: { generation: number; promise: Promise<void> } | null = null;
let identityPromise: Promise<{ deviceId: string; deviceName: string }> | null = null;
let notchSettingsRefreshPromise: {
  scope: AttentionAccountScope;
  promise: Promise<void>;
} | null = null;
let notchSettingsRefreshed: {
  scope: AttentionAccountScope;
  at: number;
} | null = null;
let notchSettingsUpdateQueue: Promise<void> = Promise.resolve();

function sameAccountScope(
  left: AttentionAccountScope,
  right: AttentionAccountScope,
): boolean {
  return left.generation === right.generation && left.ownerId === right.ownerId;
}

function isCurrentAccountScope(scope: AttentionAccountScope): boolean {
  return scope.generation === attentionAccountGeneration
    && scope.ownerId === attentionAccountOwnerId;
}

function failClosedAttentionNotchSettings(): AttentionNotchSettings {
  return {
    enabled: readAttentionNotchEnabled(),
    preferredDisplayId: null,
    hideDetails: true,
    celebrationsEnabled: false,
    soundsEnabled: false,
  };
}

function enqueueAttentionNotchSettingsUpdate(
  scope: AttentionAccountScope,
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
  return "ADE couldn’t refresh account attention.";
}

export async function refreshAttentionSnapshot(): Promise<void> {
  const generation = attentionAccountGeneration;
  const ownerId = attentionAccountOwnerId;
  if (refreshPromise?.generation === generation) return refreshPromise.promise;
  const api = typeof window !== "undefined" ? window.ade?.attention : null;
  if (!api) {
    attentionStore.getState().setSyncStatus("ready");
    return;
  }

  attentionStore.getState().setSyncStatus("syncing");
  const promise = api
    .getSnapshot(
      attentionStore.getState().revision,
      attentionStore.getState().streamId,
    )
    .then((snapshot) => {
      if (
        generation !== attentionAccountGeneration
        || ownerId !== attentionAccountOwnerId
      ) return;
      attentionStore.getState().applySnapshot(snapshot);
      if (ownerId) {
        void refreshAttentionNotchSettings({ generation, ownerId });
      }
    })
    .catch((error) => {
      if (generation !== attentionAccountGeneration) return;
      attentionStore.getState().setSyncStatus("error", errorMessage(error));
    })
    .finally(() => {
      if (refreshPromise?.promise === promise) refreshPromise = null;
    });
  refreshPromise = { generation, promise };
  return promise;
}

export function materializeAttentionNotchSnapshot(): AttentionSnapshot {
  const state = attentionStore.getState();
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    streamId: state.streamId,
    revision: state.revision,
    generatedAt: state.generatedAt ?? new Date().toISOString(),
    items: Object.values(state.itemsById),
    tombstones: [],
  };
}

export function attentionNotchSnapshotSignature(
  snapshot = materializeAttentionNotchSnapshot(),
): string {
  return JSON.stringify([
    snapshot.streamId ?? null,
    snapshot.revision,
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

async function publishAttentionNotchSnapshot(): Promise<void> {
  const api = typeof window !== "undefined" ? window.ade?.attentionNotch : null;
  if (!api) return;
  await api.publishSnapshot(materializeAttentionNotchSnapshot());
}

async function refreshAttentionNotchSettings(
  scope: AttentionAccountScope,
  force = false,
): Promise<void> {
  if (!isCurrentAccountScope(scope)) return;
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
  if (!attentionApi || !notchApi) return;
  const promise = attentionApi
    .getPreferences(scope.ownerId)
    .then(async (preferences) => {
      if (!isCurrentAccountScope(scope)) return;
      await enqueueAttentionNotchSettingsUpdate(
        scope,
        attentionNotchSettingsFromPreferences(preferences),
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

async function prepareAttentionNotchForAccount(
  scope: AttentionAccountScope,
): Promise<boolean> {
  const notchApi = typeof window !== "undefined" ? window.ade?.attentionNotch : null;
  if (!notchApi || !isCurrentAccountScope(scope)) return false;
  try {
    // Never let the previous account's privacy/animation/sound choices govern
    // a new stream. Clear the old snapshot only after native presentation is
    // private and quiet, then hydrate the new account's preferences.
    await enqueueAttentionNotchSettingsUpdate(scope, failClosedAttentionNotchSettings());
    if (!isCurrentAccountScope(scope)) return false;
    await publishAttentionNotchSnapshot();
  } catch {
    return false;
  }
  if (!isCurrentAccountScope(scope)) return false;
  await refreshAttentionNotchSettings(scope, true);
  return isCurrentAccountScope(scope);
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
 * Keeps the account-wide Attention snapshot and desktop presence warm even
 * before the user opens the Attention route, so sidebar badges remain truthful.
 */
export function useAttentionSync(ambientSurfaceVisible: boolean): void {
  const { status: accountStatus, loading: accountLoading } = useAccountStatus();
  const accountUserId = accountStatus.signedIn ? accountStatus.userId : null;
  const itemsById = useAttentionStore((state) => state.itemsById);
  const scope = useAttentionStore((state) => state.scope);
  const view = useAttentionStore((state) => state.view);
  const visibleItemIds = useMemo(
    () => selectAttentionItems({ itemsById, scope, view }).map((item) => item.id),
    [itemsById, scope, view],
  );
  const visibleItemIdsKey = visibleItemIds.join("\u001f");
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
    if (attentionAccountOwnerId !== accountUserId) {
      attentionAccountGeneration += 1;
      attentionAccountOwnerId = accountUserId;
      identityPromise = null;
      notchSettingsRefreshPromise = null;
      notchSettingsRefreshed = null;
      attentionStore.getState().resetStream();
    }
    if (!accountUserId) {
      void publishAttentionNotchSnapshot().catch(() => {});
      return;
    }
    const accountScope = {
      generation: attentionAccountGeneration,
      ownerId: accountUserId,
    };
    let lastNotchSignature = "";
    let active = true;
    let unsubscribe = () => {};
    const publishNotchIfChanged = () => {
      const nextSignature = attentionNotchSnapshotSignature();
      if (nextSignature === lastNotchSignature) return;
      lastNotchSignature = nextSignature;
      void publishAttentionNotchSnapshot().catch(() => {});
    };
    void prepareAttentionNotchForAccount(accountScope).then((prepared) => {
      if (!active || !prepared || !isCurrentAccountScope(accountScope)) return;
      unsubscribe = attentionStore.subscribe(publishNotchIfChanged);
      publishNotchIfChanged();
    });
    const removeNotchAcknowledgeListener =
      window.ade?.attentionNotch?.onAcknowledgeRequested((request) => {
        void acknowledgeAttentionItem(request.itemId, request.mode)
          .finally(publishNotchIfChanged);
      }) ?? (() => {});
    const removeNotchRefreshListener =
      window.ade?.attentionNotch?.onRefreshRequested?.(() => {
        if (document.visibilityState === "visible") return;
        void refreshAttentionSnapshot();
      }) ?? (() => {});
    void refreshAttentionSnapshot();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshAttentionSnapshot();
    }, POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      foregroundRef.current = document.visibilityState === "visible" && document.hasFocus();
      if (foregroundRef.current) void refreshAttentionSnapshot();
      void reportPresence(
        ambientSurfaceVisibleRef.current,
        visibleItemIdsRef.current,
        foregroundRef.current,
      ).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      removeNotchAcknowledgeListener();
      removeNotchRefreshListener();
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
    send();
    const interval = window.setInterval(send, PRESENCE_INTERVAL_MS);
    const onFocus = () => {
      foregroundRef.current = true;
      send();
    };
    const onBlur = () => {
      foregroundRef.current = false;
      send();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [accountLoading, accountUserId, ambientSurfaceVisible, visibleItemIdsKey]);

  useEffect(() => () => {
    if (accountUserId) void reportPresence(false, [], false).catch(() => {});
  }, [accountUserId]);
}
