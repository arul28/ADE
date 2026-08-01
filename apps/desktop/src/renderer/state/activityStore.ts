import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import {
  attentionItemNeedsInbox,
  type AttentionItem,
  type AttentionPreferences,
  type AttentionSnapshot,
  type AttentionTombstone,
} from "../../shared/types";

export type ActivitySyncStatus = "idle" | "syncing" | "ready" | "error";

type PendingActivityAcknowledgement = {
  previous: AttentionItem;
  seenAt: string;
  dismissedAt?: string;
};

export type ActivityStoreState = {
  snapshotScope: AttentionSnapshot["scope"] | null;
  accountOwnerId: string | null;
  availability: AttentionSnapshot["availability"] | null;
  streamId: string | null;
  revision: number;
  generatedAt: string | null;
  itemsById: Record<string, AttentionItem>;
  tombstonesById: Record<string, AttentionTombstone>;
  headerSurfaceVisible: boolean;
  /**
   * Last account preferences this window loaded. Null means "not loaded yet",
   * which every reader must treat as the conservative default rather than as
   * "the user turned it off" — see `selectActivityHideDetails`.
   */
  preferences: AttentionPreferences | null;
  syncStatus: ActivitySyncStatus;
  syncError: string | null;
  pendingAcknowledgements: Record<string, PendingActivityAcknowledgement>;
  acknowledgementErrors: Record<string, string>;
  resetStream: () => void;
  setPreferences: (preferences: AttentionPreferences | null) => void;
  applySnapshot: (snapshot: AttentionSnapshot) => void;
  upsertItem: (item: AttentionItem) => void;
  removeItem: (tombstone: AttentionTombstone) => void;
  setHeaderSurfaceVisible: (visible: boolean) => void;
  setSyncStatus: (status: ActivitySyncStatus, error?: string | null) => void;
  markSeen: (itemId: string, seenAt?: string) => void;
  dismiss: (itemId: string, dismissedAt?: string) => void;
};

function isExpiredItem(item: AttentionItem, now: number): boolean {
  if (!item.expiresAt) return false;
  const expiresAt = Date.parse(item.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

/**
 * Whether Activity surfaces may show agent-authored text. Unloaded preferences
 * resolve to `false` rather than `true`: hide-details is off by default, and
 * defaulting a *display* choice to "hidden" would make every surface look
 * broken for the seconds before the account load lands. The native notch takes
 * the opposite default because it paints over the menu bar of a locked-away
 * Mac — see `failClosedActivityNotchSettings` in `useActivitySync.ts`.
 */
export function selectActivityHideDetails(
  state: Pick<ActivityStoreState, "preferences">,
): boolean {
  return state.preferences?.account?.hideDetails === true;
}

/**
 * Dock-badge scope. Local by default so a fresh install badges only the work
 * on the Mac in front of the user; flipping it to `account` is an explicit,
 * synced choice.
 */
export function selectDockBadgeScope(
  state: Pick<ActivityStoreState, "preferences">,
): "local" | "account" {
  return state.preferences?.account?.dockBadgeScope === "account" ? "account" : "local";
}

export function selectActivityUnseenCount(
  state: Pick<ActivityStoreState, "itemsById">,
): number {
  const now = Date.now();
  return Object.values(state.itemsById).filter(
    (item) => !isExpiredItem(item, now) && item.seenAt === null && attentionItemNeedsInbox(item),
  ).length;
}

function createInitialState(): Pick<
  ActivityStoreState,
  | "streamId"
  | "snapshotScope"
  | "accountOwnerId"
  | "availability"
  | "revision"
  | "generatedAt"
  | "itemsById"
  | "tombstonesById"
  | "headerSurfaceVisible"
  | "preferences"
  | "syncStatus"
  | "syncError"
  | "pendingAcknowledgements"
  | "acknowledgementErrors"
> {
  return {
    snapshotScope: null,
    accountOwnerId: null,
    availability: null,
    streamId: null,
    revision: 0,
    generatedAt: null,
    itemsById: {},
    tombstonesById: {},
    headerSurfaceVisible: false,
    preferences: null,
    syncStatus: "idle",
    syncError: null,
    pendingAcknowledgements: {},
    acknowledgementErrors: {},
  };
}

export const activityStore = createStore<ActivityStoreState>((set) => ({
  ...createInitialState(),
  resetStream: () =>
    set((state) => ({
      ...createInitialState(),
      headerSurfaceVisible: state.headerSurfaceVisible,
    })),
  // Preferences are account-scoped, so a stream reset deliberately drops them
  // rather than letting the previous account's privacy choice govern this one.
  setPreferences: (preferences) => set({ preferences }),
  applySnapshot: (snapshot) =>
    set((state) => {
      // Account revisions are monotonic only inside one verified account.
      // Stream identity is authoritative; the lower-revision check preserves
      // safe behavior while older relays roll forward to stream-aware payloads.
      const incomingStreamId = snapshot.streamId?.trim() || null;
      const streamReset = (
        Boolean(state.streamId && incomingStreamId && state.streamId !== incomingStreamId)
        || snapshot.revision < state.revision
      );
      const tombstonesById = streamReset ? {} : { ...state.tombstonesById };
      for (const tombstone of snapshot.tombstones ?? []) {
        const existing = tombstonesById[tombstone.id];
        if (!existing || tombstone.revision >= existing.revision) {
          tombstonesById[tombstone.id] = tombstone;
        }
      }
      const itemsById: Record<string, AttentionItem> = streamReset || state.revision === 0
        ? {}
        : { ...state.itemsById };
      for (const tombstone of snapshot.tombstones ?? []) {
        delete itemsById[tombstone.id];
      }
      for (const item of snapshot.items) {
        const tombstone = tombstonesById[item.id];
        if (!tombstone || item.revision > tombstone.revision) {
          const pending = streamReset ? undefined : state.pendingAcknowledgements[item.id];
          itemsById[item.id] = pending
            ? {
                ...item,
                seenAt: pending.seenAt,
                ...(pending.dismissedAt ? { dismissedAt: pending.dismissedAt } : {}),
              }
            : item;
        }
      }
      const presenceByMachine = new Map(
        (snapshot.machines ?? []).map((machine) => [machine.machineKey, machine]),
      );
      for (const [itemId, item] of Object.entries(itemsById)) {
        const presence = presenceByMachine.get(item.machine.machineKey);
        if (!presence) continue;
        itemsById[itemId] = {
          ...item,
          machine: {
            ...item.machine,
            name: presence.name,
            online: presence.online,
            lastSeenAt: presence.lastSeenAt,
          },
        };
      }
      return {
        snapshotScope: snapshot.scope ?? null,
        accountOwnerId: snapshot.accountOwnerId?.trim() || null,
        availability: snapshot.availability ?? null,
        streamId: incomingStreamId ?? (streamReset ? null : state.streamId),
        revision: snapshot.revision,
        generatedAt: snapshot.generatedAt,
        itemsById,
        tombstonesById,
        syncStatus: "ready",
        syncError: null,
        pendingAcknowledgements: streamReset ? {} : state.pendingAcknowledgements,
        acknowledgementErrors: streamReset ? {} : state.acknowledgementErrors,
      };
    }),
  upsertItem: (item) =>
    set((state) => {
      const existing = state.itemsById[item.id];
      const tombstone = state.tombstonesById[item.id];
      if (existing && existing.revision >= item.revision) return state;
      if (tombstone && tombstone.revision >= item.revision) return state;
      return {
        itemsById: { ...state.itemsById, [item.id]: item },
      };
    }),
  removeItem: (tombstone) =>
    set((state) => {
      const existingTombstone = state.tombstonesById[tombstone.id];
      const existingItem = state.itemsById[tombstone.id];
      if (existingTombstone && existingTombstone.revision >= tombstone.revision) return state;
      if (existingItem && existingItem.revision > tombstone.revision) return state;
      const itemsById = { ...state.itemsById };
      delete itemsById[tombstone.id];
      return {
        itemsById,
        tombstonesById: { ...state.tombstonesById, [tombstone.id]: tombstone },
      };
    }),
  setHeaderSurfaceVisible: (headerSurfaceVisible) => set({ headerSurfaceVisible }),
  setSyncStatus: (syncStatus, syncError = null) => set({ syncStatus, syncError }),
  markSeen: (itemId, seenAt = new Date().toISOString()) =>
    set((state) => {
      const item = state.itemsById[itemId];
      if (!item || item.seenAt) return state;
      return {
        itemsById: {
          ...state.itemsById,
          [itemId]: { ...item, seenAt },
        },
      };
    }),
  dismiss: (itemId, dismissedAt = new Date().toISOString()) =>
    set((state) => {
      const item = state.itemsById[itemId];
      if (!item || item.dismissedAt) return state;
      return {
        itemsById: {
          ...state.itemsById,
          [itemId]: {
            ...item,
            seenAt: item.seenAt ?? dismissedAt,
            dismissedAt,
          },
        },
      };
    }),
}));

export function useActivityStore<T>(selector: (state: ActivityStoreState) => T): T {
  return useStore(activityStore, selector);
}

export function applyActivitySnapshot(snapshot: AttentionSnapshot): void {
  activityStore.getState().applySnapshot(snapshot);
}

export function upsertActivityItem(item: AttentionItem): void {
  activityStore.getState().upsertItem(item);
}

export function removeActivityItem(tombstone: AttentionTombstone): void {
  activityStore.getState().removeItem(tombstone);
}

export function resetActivityStoreForTests(): void {
  activityStore.setState(createInitialState());
}

function activityErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "ADE couldn’t update this Activity item.";
}

export async function acknowledgeActivityItem(
  itemId: string,
  kind: "seen" | "dismiss",
): Promise<void> {
  const before = activityStore.getState();
  const item = before.itemsById[itemId];
  if (!item || before.pendingAcknowledgements[itemId]) return;

  const timestamp = new Date().toISOString();
  const pending: PendingActivityAcknowledgement = {
    previous: item,
    seenAt: timestamp,
    ...(kind === "dismiss" ? { dismissedAt: timestamp } : {}),
  };
  activityStore.setState((state) => {
    const acknowledgementErrors = { ...state.acknowledgementErrors };
    delete acknowledgementErrors[itemId];
    return {
      pendingAcknowledgements: {
        ...state.pendingAcknowledgements,
        [itemId]: pending,
      },
      acknowledgementErrors,
    };
  });
  if (kind === "dismiss") activityStore.getState().dismiss(itemId, timestamp);
  else activityStore.getState().markSeen(itemId, timestamp);

  try {
    const api = typeof window !== "undefined" ? window.ade?.attention : null;
    if (api) {
      await api.acknowledge({
        itemIds: [itemId],
        sourceRevisions: { [itemId]: item.revision },
        expectedAccountOwnerId: before.accountOwnerId,
        seenAt: timestamp,
        ...(kind === "dismiss" ? { dismissedAt: timestamp } : {}),
      });
    }
    activityStore.setState((state) => {
      const pendingAcknowledgements = { ...state.pendingAcknowledgements };
      delete pendingAcknowledgements[itemId];
      return { pendingAcknowledgements };
    });
  } catch (error) {
    const message = activityErrorMessage(error);
    activityStore.setState((state) => {
      const currentPending = state.pendingAcknowledgements[itemId];
      if (!currentPending || currentPending.seenAt !== timestamp) return state;
      const current = state.itemsById[itemId];
      const canRollback = current
        && current.seenAt === timestamp
        && (kind !== "dismiss" || current.dismissedAt === timestamp);
      const pendingAcknowledgements = { ...state.pendingAcknowledgements };
      delete pendingAcknowledgements[itemId];
      return {
        pendingAcknowledgements,
        itemsById: canRollback
          ? {
              ...state.itemsById,
              [itemId]: {
                ...current,
                seenAt: currentPending.previous.seenAt,
                dismissedAt: currentPending.previous.dismissedAt,
              },
            }
          : state.itemsById,
        acknowledgementErrors: {
          ...state.acknowledgementErrors,
          [itemId]: message,
        },
      };
    });
    throw error;
  }
}
