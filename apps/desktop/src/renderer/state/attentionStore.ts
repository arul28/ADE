import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import {
  attentionItemIsLive,
  attentionItemNeedsInbox,
  sortAttentionItems,
  type AttentionItem,
  type AttentionSnapshot,
  type AttentionTombstone,
} from "../../shared/types";

export type AttentionView = "live" | "inbox" | "recent";

export type AttentionScope =
  | { kind: "all" }
  | { kind: "machine"; machineKey: string; label: string }
  | { kind: "project"; projectId: string; label: string; machineKey?: string | null };

export type AttentionSyncStatus = "idle" | "syncing" | "ready" | "error";

type PendingAttentionAcknowledgement = {
  previous: AttentionItem;
  seenAt: string;
  dismissedAt?: string;
};

export type AttentionStoreState = {
  streamId: string | null;
  revision: number;
  generatedAt: string | null;
  itemsById: Record<string, AttentionItem>;
  tombstonesById: Record<string, AttentionTombstone>;
  view: AttentionView;
  scope: AttentionScope;
  selectedItemId: string | null;
  syncStatus: AttentionSyncStatus;
  syncError: string | null;
  pendingAcknowledgements: Record<string, PendingAttentionAcknowledgement>;
  acknowledgementErrors: Record<string, string>;
  resetStream: () => void;
  applySnapshot: (snapshot: AttentionSnapshot) => void;
  upsertItem: (item: AttentionItem) => void;
  removeItem: (tombstone: AttentionTombstone) => void;
  setView: (view: AttentionView) => void;
  setScope: (scope: AttentionScope) => void;
  selectItem: (itemId: string | null) => void;
  setSyncStatus: (status: AttentionSyncStatus, error?: string | null) => void;
  markSeen: (itemId: string, seenAt?: string) => void;
  dismiss: (itemId: string, dismissedAt?: string) => void;
};

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;

function itemMatchesScope(item: AttentionItem, scope: AttentionScope): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "machine") return item.machine.machineKey === scope.machineKey;
  return item.project.projectId === scope.projectId
    && (!scope.machineKey || item.machine.machineKey === scope.machineKey);
}

function isExpiredItem(item: AttentionItem, now: number): boolean {
  if (!item.expiresAt) return false;
  const expiresAt = Date.parse(item.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function isRecentItem(item: AttentionItem, now: number): boolean {
  if (item.dismissedAt || isExpiredItem(item, now) || attentionItemIsLive(item)) return false;
  const timestamp = Date.parse(item.seenAt ?? item.updatedAt);
  if (!Number.isFinite(timestamp)) return false;
  return now - timestamp <= RECENT_WINDOW_MS;
}

function sortRecentItems(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((left, right) => {
    const timestamp = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(timestamp) && timestamp !== 0) return timestamp;
    return left.id.localeCompare(right.id);
  });
}

export function selectAttentionItems(
  state: Pick<AttentionStoreState, "itemsById" | "scope" | "view">,
  now = Date.now(),
): AttentionItem[] {
  const scoped = Object.values(state.itemsById).filter(
    (item) => itemMatchesScope(item, state.scope) && !isExpiredItem(item, now),
  );
  if (state.view === "live") {
    return sortAttentionItems(scoped.filter((item) => !item.dismissedAt && attentionItemIsLive(item)));
  }
  if (state.view === "inbox") {
    return sortAttentionItems(scoped.filter(attentionItemNeedsInbox));
  }
  return sortRecentItems(scoped.filter((item) => isRecentItem(item, now)));
}

export function selectAttentionCounts(
  state: Pick<AttentionStoreState, "itemsById" | "scope">,
  now = Date.now(),
): Record<AttentionView, number> {
  const scoped = Object.values(state.itemsById).filter(
    (item) => itemMatchesScope(item, state.scope) && !isExpiredItem(item, now),
  );
  return {
    live: scoped.filter((item) => !item.dismissedAt && attentionItemIsLive(item)).length,
    inbox: scoped.filter(attentionItemNeedsInbox).length,
    recent: scoped.filter((item) => isRecentItem(item, now)).length,
  };
}

export function selectAttentionUnseenCount(
  state: Pick<AttentionStoreState, "itemsById">,
): number {
  const now = Date.now();
  return Object.values(state.itemsById).filter(
    (item) => !isExpiredItem(item, now) && item.seenAt === null && attentionItemNeedsInbox(item),
  ).length;
}

function createInitialState(): Pick<
  AttentionStoreState,
  | "streamId"
  | "revision"
  | "generatedAt"
  | "itemsById"
  | "tombstonesById"
  | "view"
  | "scope"
  | "selectedItemId"
  | "syncStatus"
  | "syncError"
  | "pendingAcknowledgements"
  | "acknowledgementErrors"
> {
  return {
    streamId: null,
    revision: 0,
    generatedAt: null,
    itemsById: {},
    tombstonesById: {},
    view: "live",
    scope: { kind: "all" },
    selectedItemId: null,
    syncStatus: "idle",
    syncError: null,
    pendingAcknowledgements: {},
    acknowledgementErrors: {},
  };
}

export const attentionStore = createStore<AttentionStoreState>((set) => ({
  ...createInitialState(),
  resetStream: () => set(createInitialState()),
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
        streamId: incomingStreamId ?? (streamReset ? null : state.streamId),
        revision: snapshot.revision,
        generatedAt: snapshot.generatedAt,
        itemsById,
        tombstonesById,
        syncStatus: "ready",
        syncError: null,
        pendingAcknowledgements: streamReset ? {} : state.pendingAcknowledgements,
        acknowledgementErrors: streamReset ? {} : state.acknowledgementErrors,
        selectedItemId: state.selectedItemId && itemsById[state.selectedItemId]
          ? state.selectedItemId
          : null,
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
        selectedItemId: state.selectedItemId === tombstone.id ? null : state.selectedItemId,
      };
    }),
  setView: (view) => set({ view, selectedItemId: null }),
  setScope: (scope) => set({ scope, selectedItemId: null }),
  selectItem: (selectedItemId) => set({ selectedItemId }),
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
        selectedItemId: state.selectedItemId === itemId ? null : state.selectedItemId,
      };
    }),
}));

export function useAttentionStore<T>(selector: (state: AttentionStoreState) => T): T {
  return useStore(attentionStore, selector);
}

export function applyAttentionSnapshot(snapshot: AttentionSnapshot): void {
  attentionStore.getState().applySnapshot(snapshot);
}

export function upsertAttentionItem(item: AttentionItem): void {
  attentionStore.getState().upsertItem(item);
}

export function removeAttentionItem(tombstone: AttentionTombstone): void {
  attentionStore.getState().removeItem(tombstone);
}

export function resetAttentionStoreForTests(): void {
  attentionStore.setState(createInitialState());
}

function attentionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "ADE couldn’t update this attention item.";
}

export async function acknowledgeAttentionItem(
  itemId: string,
  kind: "seen" | "dismiss",
): Promise<void> {
  const before = attentionStore.getState();
  const item = before.itemsById[itemId];
  if (!item || before.pendingAcknowledgements[itemId]) return;

  const timestamp = new Date().toISOString();
  const pending: PendingAttentionAcknowledgement = {
    previous: item,
    seenAt: timestamp,
    ...(kind === "dismiss" ? { dismissedAt: timestamp } : {}),
  };
  attentionStore.setState((state) => {
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
  if (kind === "dismiss") attentionStore.getState().dismiss(itemId, timestamp);
  else attentionStore.getState().markSeen(itemId, timestamp);

  try {
    const api = typeof window !== "undefined" ? window.ade?.attention : null;
    if (api) {
      await api.acknowledge({
        itemIds: [itemId],
        seenAt: timestamp,
        ...(kind === "dismiss" ? { dismissedAt: timestamp } : {}),
      });
    }
    attentionStore.setState((state) => {
      const pendingAcknowledgements = { ...state.pendingAcknowledgements };
      delete pendingAcknowledgements[itemId];
      return { pendingAcknowledgements };
    });
  } catch (error) {
    const message = attentionErrorMessage(error);
    attentionStore.setState((state) => {
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
        selectedItemId: canRollback ? itemId : state.selectedItemId,
      };
    });
    throw error;
  }
}
