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

const ACTIVITY_STALE_MESSAGE =
  "This changed on the machine that owns it, so ADE left it alone. Refresh Activity to see where it got to.";

/**
 * The other reason a row rolls back, and the reason it needed its own sentence.
 *
 * A bulk acknowledgment aborts at the first chunk that throws — expired auth, a
 * 5xx, a rejected CORS preflight, an owner-fence 409 — so the rows in and after
 * that chunk were never answered for. They roll back exactly as a stale refusal
 * does, but nothing changed underneath the user, and telling them it did sends
 * them to refresh a list that is already correct.
 */
const ACTIVITY_UNREACHED_MESSAGE =
  "ADE couldn’t reach Activity for this one, so nothing changed. Try again in a moment.";

function activityErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "ADE couldn’t update this Activity item.";
}

/**
 * Acknowledge one or more items in a SINGLE relay call.
 *
 * The bulk shape is the whole point. "Clear all" used to fire one acknowledge
 * per row: N independent optimistic dismisses, N races against the revision
 * fence, N rollbacks, and — because every caller swallowed the rejection — no
 * explanation for why the rows came back. One call has one outcome, so either
 * the inbox clears or the user is told why it did not.
 *
 * Optimism and rollback are both per item, because the host answers per item:
 * `{ acknowledged, stale, unreached }`. It rejects only when it applied nothing
 * at all, so a rejection rolls the whole batch back while `stale` and
 * `unreached` roll back exactly their own rows — clearing nine of ten and
 * putting the tenth back is the honest result, and pretending otherwise in
 * either direction is how a list ends up disagreeing with the machine it came
 * from. The two rollback lists carry the same consequence and different
 * reasons, so each gets its own per-item message.
 */
export type ActivityAcknowledgementResult = {
  /** Ids the host applied. Their optimistic state stands. */
  acknowledged: string[];
  /** Ids the host refused as stale. Rolled back, with a per-item message. */
  stale: string[];
  /**
   * Ids the host never answered for, because the request failed in transport.
   * Rolled back identically — only the explanation differs, and it has to:
   * "this changed underneath you" is false for a call that did not complete.
   * Always an array here, even though the bridge omits it when empty, so the
   * pane never has to guess whether an older producer left it out.
   */
  unreached: string[];
  /** The transport failure behind `unreached`, for the caller's detail line. */
  unreachedReason?: string;
};

/**
 * Undo the optimistic state for a subset of a batch, and say why.
 *
 * Shared by the two ways an acknowledgement can fail, which are genuinely
 * different: a rejection means the host applied NOTHING (roll the batch back),
 * while a `stale` list means it applied the rest (roll back only those, and
 * leave the rows that really did clear cleared).
 */
function rollbackAcknowledgements(
  ids: readonly string[],
  timestamp: string,
  kind: "seen" | "dismiss",
  message: string,
): void {
  if (ids.length === 0) return;
  activityStore.setState((state) => {
    const pendingAcknowledgements = { ...state.pendingAcknowledgements };
    const acknowledgementErrors = { ...state.acknowledgementErrors };
    const itemsById = { ...state.itemsById };
    let rolledBack = false;
    for (const itemId of ids) {
      const currentPending = pendingAcknowledgements[itemId];
      // A newer acknowledgement of the same row owns the state now; this one
      // has already lost and must not resurrect the old timestamps.
      if (!currentPending || currentPending.seenAt !== timestamp) continue;
      const current = itemsById[itemId];
      const canRollback = current
        && current.seenAt === timestamp
        && (kind !== "dismiss" || current.dismissedAt === timestamp);
      if (canRollback) {
        itemsById[itemId] = {
          ...current,
          seenAt: currentPending.previous.seenAt,
          dismissedAt: currentPending.previous.dismissedAt,
        };
        rolledBack = true;
      }
      delete pendingAcknowledgements[itemId];
      acknowledgementErrors[itemId] = message;
    }
    return {
      pendingAcknowledgements,
      acknowledgementErrors,
      itemsById: rolledBack ? itemsById : state.itemsById,
    };
  });
}

export async function acknowledgeActivityItems(
  itemIds: readonly string[],
  kind: "seen" | "dismiss",
): Promise<ActivityAcknowledgementResult> {
  const before = activityStore.getState();
  const targets: AttentionItem[] = [];
  const seenIds = new Set<string>();
  for (const itemId of itemIds) {
    const item = before.itemsById[itemId];
    // A row already in flight, already gone, or named twice in one batch is
    // silently skipped rather than double-counted into the request.
    if (!item || before.pendingAcknowledgements[itemId] || seenIds.has(itemId)) continue;
    seenIds.add(itemId);
    targets.push(item);
  }
  if (targets.length === 0) return { acknowledged: [], stale: [], unreached: [] };

  const timestamp = new Date().toISOString();
  const sourceRevisions: Record<string, number> = {};
  /**
   * The alert identity each row carried AS RENDERED — the narrow fence that
   * replaces the revision fence, and nothing wider.
   *
   * The race it closes: the client polls at revision N with X `running`, the
   * user hits Clear all, X flips to `needs_you` and that publish lands FIRST
   * (which resets seen/dismissed, because the alert identity changed). The ack
   * then applies to the NEW needs-you entry and marks it seen and dismissed —
   * so an alert nobody ever saw disappears from the inbox and the badge.
   * Quoting the fingerprint lets the host refuse exactly that item and nothing
   * else. It is emphatically NOT the old `source_revision <= ?` fence, which
   * refused every dismiss on a live agent because a running row republishes
   * constantly without its alert identity changing at all.
   *
   * An item with no `alertFingerprint` (a legacy publisher) quotes nothing, so
   * the host has nothing to compare and the ack applies as it does today.
   */
  const alertFingerprints: Record<string, string> = {};
  activityStore.setState((state) => {
    const pendingAcknowledgements = { ...state.pendingAcknowledgements };
    const acknowledgementErrors = { ...state.acknowledgementErrors };
    for (const item of targets) {
      pendingAcknowledgements[item.id] = {
        previous: item,
        seenAt: timestamp,
        ...(kind === "dismiss" ? { dismissedAt: timestamp } : {}),
      };
      delete acknowledgementErrors[item.id];
      sourceRevisions[item.id] = item.revision;
      const alertFingerprint = item.alertFingerprint?.trim();
      if (alertFingerprint) alertFingerprints[item.id] = alertFingerprint;
    }
    return { pendingAcknowledgements, acknowledgementErrors };
  });
  for (const item of targets) {
    if (kind === "dismiss") activityStore.getState().dismiss(item.id, timestamp);
    else activityStore.getState().markSeen(item.id, timestamp);
  }

  const targetIds = targets.map((item) => item.id);
  try {
    const api = typeof window !== "undefined" ? window.ade?.attention : null;
    // No bridge (tests, the web adapter before it loads) means nothing to be
    // refused by: the optimistic state is the whole truth.
    const outcome = api
      ? await api.acknowledge({
          itemIds: targetIds,
          sourceRevisions,
          alertFingerprints,
          expectedAccountOwnerId: before.accountOwnerId,
          seenAt: timestamp,
          ...(kind === "dismiss" ? { dismissedAt: timestamp } : {}),
        })
      : { acknowledged: targetIds, stale: [] };

    // The host answers per item, and only rejects when it applied nothing at
    // all. A row it refused must come back; the rows beside it must not.
    //
    // A producer that predates `unreached` — or a path that never has anything
    // to put in it — sends nothing, which reads as the empty list it is.
    const staleIds = (outcome?.stale ?? []).filter((id) => seenIds.has(id));
    const unreachedIds = (outcome?.unreached ?? []).filter(
      (id) => seenIds.has(id) && !staleIds.includes(id),
    );
    const rolledBack = new Set([...staleIds, ...unreachedIds]);
    const acknowledgedIds = targetIds.filter((id) => !rolledBack.has(id));
    activityStore.setState((state) => {
      const pendingAcknowledgements = { ...state.pendingAcknowledgements };
      for (const id of acknowledgedIds) delete pendingAcknowledgements[id];
      return { pendingAcknowledgements };
    });
    rollbackAcknowledgements(staleIds, timestamp, kind, ACTIVITY_STALE_MESSAGE);
    rollbackAcknowledgements(unreachedIds, timestamp, kind, ACTIVITY_UNREACHED_MESSAGE);
    return {
      acknowledged: acknowledgedIds,
      stale: staleIds,
      unreached: unreachedIds,
      ...(unreachedIds.length > 0 && outcome?.unreachedReason?.trim()
        ? { unreachedReason: outcome.unreachedReason.trim() }
        : {}),
    };
  } catch (error) {
    rollbackAcknowledgements(targetIds, timestamp, kind, activityErrorMessage(error));
    throw error;
  }
}

/**
 * The reason a single row can still fail. Staleness is no longer the routine
 * outcome it was — the relay-side revision fence that rejected every ack on a
 * live agent is gone — so when this does appear it means something real.
 */
export class ActivityAcknowledgementStale extends Error {
  constructor(readonly itemId: string) {
    super(ACTIVITY_STALE_MESSAGE);
    this.name = "ActivityAcknowledgementStale";
  }
}

export async function acknowledgeActivityItem(
  itemId: string,
  kind: "seen" | "dismiss",
): Promise<void> {
  const outcome = await acknowledgeActivityItems([itemId], kind);
  // One item, so "some of the batch was refused" and "this failed" are the
  // same sentence — and every caller of the single-item form is written to
  // treat a rejection as the failure signal.
  if (outcome.stale.includes(itemId)) throw new ActivityAcknowledgementStale(itemId);
  // A one-item batch is one chunk, so a transport failure normally rejects
  // outright and never reaches here. Handled anyway rather than letting a
  // rolled-back row report success — and with the transport sentence, not the
  // stale one.
  if (outcome.unreached.includes(itemId)) {
    throw new Error(outcome.unreachedReason?.trim() || ACTIVITY_UNREACHED_MESSAGE);
  }
}
