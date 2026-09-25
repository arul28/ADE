import { useRef, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type {
  ChatLaunchArgs,
  ChatLaunchEvent,
  ChatLaunchSnapshot,
  ChatLaunchStage,
  LaneEnvInitStep,
  OpenProjectBinding,
} from "../../shared/types";
import { chatLaunchStatusLine, createChatLaunchSnapshot, isChatLaunchPending, mergeChatLaunchSnapshot } from "../../shared/chatLaunch";
import type { DraftLaunchSnapshot } from "../lib/draftLaunchJobs";
import type { WorkPtyLaunchArgs } from "../components/terminals/cliLaunch";
import { announceChatLaunchClosed } from "../components/chat/launch/chatLaunchDraftRestore";

/**
 * Renderer mirror of the brain's new-lane launches (`shared/types/chatLaunch.ts`).
 *
 * One store for the whole window: the thread's setup card, the Work sidebar
 * row, the Launches slide-out and the CLI driver all read the same snapshot.
 * Entries are keyed by launch id (a client-chosen UUID, unique across
 * machines) and remember which project binding they belong to, so hydrating
 * one binding never drops another binding's launches.
 *
 * The store is fed by exactly one subscription per binding
 * (`useChatLaunchSync`, mounted once in the app shell) — never per pane — and
 * by the optimistic inserts the launching composer makes before the host has
 * answered. Snapshots only move forward (`mergeChatLaunchSnapshot`).
 */

const UNBOUND_CHAT_LAUNCH_BINDING_KEY = "__unbound__";

export type ChatLaunchEntry = {
  launchId: string;
  bindingKey: string;
  binding: OpenProjectBinding | null;
  snapshot: ChatLaunchSnapshot;
  /** A snapshot for this launch has come from the host at least once. */
  hostSeen: boolean;
  /**
   * `chatLaunch.start` rejected before the host accepted the launch. The card
   * shows the failure; Retry re-sends `start` with the same launch id.
   */
  startError: string | null;
};

type ChatLaunchState = {
  entries: Record<string, ChatLaunchEntry>;
  /** Launches this window's slide-out was told to stop showing. */
  dismissed: Record<string, true>;
};

export const chatLaunchStore = createStore<ChatLaunchState>(() => ({
  entries: {},
  dismissed: {},
}));

export function chatLaunchBindingKey(binding: OpenProjectBinding | null | undefined): string {
  return binding?.key ?? UNBOUND_CHAT_LAUNCH_BINDING_KEY;
}

/* ── Origin client id ─────────────────────────────────────────────────────
   Stable per renderer window (sessionStorage survives reloads of the same
   window, not new windows), so "my launches" means launches this window
   started. */

const ORIGIN_CLIENT_ID_STORAGE_KEY = "ade.chatLaunch.originClientId";
let cachedOriginClientId: string | null = null;

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getChatLaunchOriginClientId(): string {
  if (cachedOriginClientId) return cachedOriginClientId;
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(ORIGIN_CLIENT_ID_STORAGE_KEY);
  } catch {
    stored = null;
  }
  const id = stored?.trim() || `desktop-window:${randomId()}`;
  if (!stored) {
    try {
      window.sessionStorage.setItem(ORIGIN_CLIENT_ID_STORAGE_KEY, id);
    } catch {
      // Storage can be unavailable (private contexts); the id still holds for this page.
    }
  }
  cachedOriginClientId = id;
  return id;
}

/* ── Window-local launch records ──────────────────────────────────────────
   What the host does not need to know but this window does: the args to
   re-send `start` with, the composer snapshot to restore on Delete/Cancel, and
   the prepared CLI launch the driver starts once the lane is ready. Not
   reactive and never persisted. */

export type ChatLaunchCliParams = Omit<WorkPtyLaunchArgs, "laneId" | "pin" | "disposition">;

export type ChatLaunchLocalRecord = {
  args: ChatLaunchArgs;
  pin: OpenProjectBinding | null;
  draftSnapshot: DraftLaunchSnapshot | null;
  cli: ChatLaunchCliParams | null;
};

const localRecords = new Map<string, ChatLaunchLocalRecord>();

export function registerChatLaunchLocalRecord(launchId: string, record: ChatLaunchLocalRecord): void {
  localRecords.set(launchId, record);
}

export function getChatLaunchLocalRecord(launchId: string): ChatLaunchLocalRecord | null {
  return localRecords.get(launchId) ?? null;
}

export function forgetChatLaunchLocalRecord(launchId: string): void {
  localRecords.delete(launchId);
}

/* ── Unsent queued messages ───────────────────────────────────────────────
   Messages this window queued that the host has not acknowledged yet (still
   waiting for the host to accept the launch, or mid-request). A host
   snapshot cannot carry them, so they are re-appended to every snapshot the
   entry takes until they are delivered or dropped — the bubble never
   flickers out while a message waits. */

type QueuedMessage = ChatLaunchSnapshot["queuedMessages"][number];

const unsentQueuedMessages = new Map<string, QueuedMessage[]>();

function withUnsentQueuedMessages(snapshot: ChatLaunchSnapshot): ChatLaunchSnapshot {
  const unsent = unsentQueuedMessages.get(snapshot.launchId);
  if (!unsent?.length) return snapshot;
  const present = new Set(snapshot.queuedMessages.map((message) => message.id));
  const missing = unsent.filter((message) => !present.has(message.id));
  return missing.length ? { ...snapshot, queuedMessages: [...snapshot.queuedMessages, ...missing] } : snapshot;
}

/* ── Structural sharing ─────────────────────────────────────────────────
   Every host snapshot arrives as fresh objects (it crossed IPC), yet during
   checkout only one number in one stage moves. Stages that did not change keep
   their previous object, and an unchanged stage list keeps its array, so the
   memoized stage rows and the progress rail skip their re-render. */

function sameEnvSteps(a: LaneEnvInitStep[] | undefined, b: LaneEnvInitStep[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((step, index) => {
    const other = b[index]!;
    return step.kind === other.kind
      && step.label === other.label
      && step.status === other.status
      && step.error === other.error
      && step.durationMs === other.durationMs;
  });
}

function sameStage(a: ChatLaunchStage, b: ChatLaunchStage): boolean {
  return a.id === b.id
    && a.status === b.status
    && a.startedAt === b.startedAt
    && a.endedAt === b.endedAt
    && a.percent === b.percent
    && a.detail === b.detail
    && a.error === b.error
    && sameEnvSteps(a.steps, b.steps);
}

/** `next` with every stage that is unchanged from `previous` swapped for the previous object. */
function shareChatLaunchStages(previous: ChatLaunchSnapshot | null | undefined, next: ChatLaunchSnapshot): ChatLaunchSnapshot {
  if (!previous || previous === next || previous.launchId !== next.launchId) return next;
  const prevStages = previous.stages;
  let changed = prevStages.length !== next.stages.length;
  const stages = next.stages.map((stage, index) => {
    const prev = prevStages[index];
    if (prev && sameStage(prev, stage)) return prev;
    changed = true;
    return stage;
  });
  return { ...next, stages: changed ? stages : prevStages };
}

/**
 * The snapshot an entry holds after a host snapshot arrives. An optimistic
 * snapshot never outranks the host's first answer, whatever sequence it
 * carries; after that, only newer host snapshots apply. Unchanged stages keep
 * their previous objects. Returns `current.snapshot` itself when nothing moved.
 */
function mergeEntrySnapshot(current: ChatLaunchEntry | undefined, incoming: ChatLaunchSnapshot): ChatLaunchSnapshot {
  const next = current?.hostSeen ? mergeChatLaunchSnapshot(current.snapshot, incoming) : incoming;
  return next === current?.snapshot ? next : withUnsentQueuedMessages(shareChatLaunchStages(current?.snapshot, next));
}

/** A host snapshot moved a launch this window already held to `cancelled` (here or on another device). */
function becameCancelled(current: ChatLaunchEntry | undefined, next: ChatLaunchSnapshot): boolean {
  return Boolean(current && current.snapshot.phase !== "cancelled" && next.phase === "cancelled");
}

/**
 * Post the close notice for launches a host snapshot just cancelled, so Work
 * closes the tab wherever the cancel came from. The window that pressed
 * Cancel posts its own notice too (with the prompt to restore); a repeated
 * notice is harmless.
 */
function announceCancelled(snapshots: readonly ChatLaunchSnapshot[]): void {
  for (const snapshot of snapshots) {
    announceChatLaunchClosed({ launchId: snapshot.launchId, sessionId: snapshot.sessionId, kind: snapshot.kind });
  }
}

/* ── Mutations ──────────────────────────────────────────────────────────── */

function setEntries(mutate: (entries: Record<string, ChatLaunchEntry>) => Record<string, ChatLaunchEntry> | null): void {
  chatLaunchStore.setState((state) => {
    const next = mutate(state.entries);
    return next && next !== state.entries ? { entries: next } : state;
  });
}

/** A launch this window is about to start, shown before the host answers. */
export function insertOptimisticChatLaunch(binding: OpenProjectBinding | null, snapshot: ChatLaunchSnapshot): void {
  setEntries((entries) => {
    if (entries[snapshot.launchId]?.hostSeen) return null;
    return {
      ...entries,
      [snapshot.launchId]: {
        launchId: snapshot.launchId,
        bindingKey: chatLaunchBindingKey(binding),
        binding,
        snapshot,
        hostSeen: false,
        startError: null,
      },
    };
  });
}

/** Host-authored snapshot (start/retry results, events, list hydration). */
export function applyChatLaunchSnapshot(binding: OpenProjectBinding | null, snapshot: ChatLaunchSnapshot): void {
  const cancelled: ChatLaunchSnapshot[] = [];
  setEntries((entries) => {
    const current = entries[snapshot.launchId];
    const merged = mergeEntrySnapshot(current, snapshot);
    if (current?.hostSeen && merged === current.snapshot && current.startError == null) return null;
    if (becameCancelled(current, merged)) cancelled.push(merged);
    return {
      ...entries,
      [snapshot.launchId]: {
        launchId: snapshot.launchId,
        bindingKey: current?.bindingKey ?? chatLaunchBindingKey(binding),
        binding: current?.binding ?? binding,
        snapshot: merged,
        hostSeen: true,
        startError: null,
      },
    };
  });
  announceCancelled(cancelled);
}

export function applyChatLaunchEvent(binding: OpenProjectBinding | null, event: ChatLaunchEvent): void {
  if (event.type === "launch-updated") {
    applyChatLaunchSnapshot(binding, event.launch);
    return;
  }
  if (event.type === "launch-removed") {
    removeChatLaunch(event.launchId);
  }
}

/**
 * Replace one binding's launches with the host's list. Launches the host has
 * never acknowledged (still starting, or `start` failed) are kept: the host
 * cannot list what it has not seen, and dropping them would lose the card.
 */
export function hydrateChatLaunches(binding: OpenProjectBinding | null, snapshots: readonly ChatLaunchSnapshot[]): void {
  const bindingKey = chatLaunchBindingKey(binding);
  const cancelled: ChatLaunchSnapshot[] = [];
  setEntries((entries) => {
    const next: Record<string, ChatLaunchEntry> = {};
    for (const entry of Object.values(entries)) {
      if (entry.bindingKey !== bindingKey || !entry.hostSeen) next[entry.launchId] = entry;
    }
    for (const snapshot of snapshots) {
      const current = entries[snapshot.launchId];
      const merged = mergeEntrySnapshot(current, snapshot);
      if (becameCancelled(current, merged)) cancelled.push(merged);
      next[snapshot.launchId] = {
        launchId: snapshot.launchId,
        bindingKey: current?.bindingKey ?? bindingKey,
        binding: current?.binding ?? binding,
        snapshot: merged,
        hostSeen: true,
        startError: null,
      };
    }
    return next;
  });
  announceCancelled(cancelled);
}

function failFirstOpenStage(stages: ChatLaunchStage[], message: string): ChatLaunchStage[] {
  const index = stages.findIndex((stage) => stage.status === "running" || stage.status === "pending");
  if (index < 0) return stages;
  const endedAt = new Date().toISOString();
  return stages.map((stage, i) => (i === index
    ? { ...stage, status: "failed", error: message, startedAt: stage.startedAt ?? endedAt, endedAt }
    : stage));
}

/** `start` rejected: the launch never reached the host. */
export function markChatLaunchStartFailed(launchId: string, message: string): void {
  setEntries((entries) => {
    const current = entries[launchId];
    if (!current || current.hostSeen) return null;
    return {
      ...entries,
      [launchId]: {
        ...current,
        startError: message,
        snapshot: {
          ...current.snapshot,
          phase: "failed",
          error: message,
          stages: failFirstOpenStage(current.snapshot.stages, message),
          updatedAt: new Date().toISOString(),
        },
      },
    };
  });
}

/** Retry after a failed `start`: put the optimistic card back to running. */
export function resetChatLaunchStartFailure(launchId: string): void {
  setEntries((entries) => {
    const current = entries[launchId];
    if (!current || current.startError == null) return null;
    return {
      ...entries,
      [launchId]: {
        ...current,
        startError: null,
        snapshot: {
          ...current.snapshot,
          phase: "running",
          error: null,
          stages: current.snapshot.stages.map((stage) => (stage.status === "failed"
            ? { ...stage, status: "pending", error: null, startedAt: null, endedAt: null }
            : stage)),
          updatedAt: new Date().toISOString(),
        },
      },
    };
  });
}

/**
 * Optimistic queued message while the lane is still being set up. It stays in
 * the entry's snapshot (across host snapshots) until
 * `removeOptimisticQueuedMessage` — on delivery or on failure.
 */
export function appendOptimisticQueuedMessage(
  launchId: string,
  message: QueuedMessage,
): void {
  setEntries((entries) => {
    const current = entries[launchId];
    if (!current) return null;
    const unsent = unsentQueuedMessages.get(launchId) ?? [];
    if (!unsent.some((entry) => entry.id === message.id)) unsentQueuedMessages.set(launchId, [...unsent, message]);
    if (current.snapshot.queuedMessages.some((entry) => entry.id === message.id)) return null;
    return {
      ...entries,
      [launchId]: {
        ...current,
        snapshot: { ...current.snapshot, queuedMessages: [...current.snapshot.queuedMessages, message] },
      },
    };
  });
}

export function removeOptimisticQueuedMessage(launchId: string, messageId: string): void {
  const unsent = unsentQueuedMessages.get(launchId);
  if (unsent) {
    const rest = unsent.filter((entry) => entry.id !== messageId);
    if (rest.length) unsentQueuedMessages.set(launchId, rest);
    else unsentQueuedMessages.delete(launchId);
  }
  setEntries((entries) => {
    const current = entries[launchId];
    if (!current || !current.snapshot.queuedMessages.some((entry) => entry.id === messageId)) return null;
    return {
      ...entries,
      [launchId]: {
        ...current,
        snapshot: {
          ...current.snapshot,
          queuedMessages: current.snapshot.queuedMessages.filter((entry) => entry.id !== messageId),
        },
      },
    };
  });
}

export function removeChatLaunch(launchId: string): void {
  unsentQueuedMessages.delete(launchId);
  setEntries((entries) => {
    if (!entries[launchId]) return null;
    const next = { ...entries };
    delete next[launchId];
    return next;
  });
}

const refreshingLaunchIds = new Set<string>();

/**
 * Re-read one launch from its host and apply it. Used when something else
 * (the transcript's finished setup card, the chat's own messages) says the
 * held snapshot is behind — a lost live event must not freeze the card, the
 * Work row and the slide-out. At most one read per launch is in flight. A
 * host that no longer has the launch (its retention ran out) drops the entry,
 * the same as a list re-read would.
 */
export function refreshChatLaunch(launchId: string | null | undefined): void {
  const entry = launchId ? chatLaunchStore.getState().entries[launchId] : undefined;
  const api = typeof window !== "undefined" ? window.ade?.chatLaunch : undefined;
  if (!entry || !entry.hostSeen || !api?.get || refreshingLaunchIds.has(entry.launchId)) return;
  const id = entry.launchId;
  refreshingLaunchIds.add(id);
  let request: Promise<ChatLaunchSnapshot | null>;
  try {
    request = api.get({ launchId: id }, entry.binding ?? undefined);
  } catch {
    refreshingLaunchIds.delete(id);
    return;
  }
  void Promise.resolve(request).then((snapshot) => {
    const current = chatLaunchStore.getState().entries[id];
    if (!current) return;
    if (snapshot) applyChatLaunchSnapshot(current.binding, snapshot);
    else if (current.hostSeen) removeChatLaunch(id);
  }).catch(() => {
    // The next list re-read (resync, visibility) corrects it instead.
  }).finally(() => {
    refreshingLaunchIds.delete(id);
  });
}

export function dismissChatLaunches(launchIds: readonly string[]): void {
  if (launchIds.length === 0) return;
  chatLaunchStore.setState((state) => {
    const next = { ...state.dismissed };
    let changed = false;
    for (const id of launchIds) {
      if (next[id]) continue;
      next[id] = true;
      changed = true;
    }
    return changed ? { dismissed: next } : state;
  });
}

export function getChatLaunchEntry(launchId: string | null | undefined): ChatLaunchEntry | null {
  if (!launchId) return null;
  return chatLaunchStore.getState().entries[launchId] ?? null;
}

/**
 * True when a new-lane launch this window knows about owns the lane. Its
 * creation and a cancel's deletion are already on screen (the thread card or
 * the Launches slide-out), so generic "Lane created" / "Lane deleted" toasts
 * would only repeat them.
 */
export function isChatLaunchLane(laneId: string | null | undefined): boolean {
  if (!laneId) return false;
  const { entries } = chatLaunchStore.getState();
  for (const entry of Object.values(entries)) {
    if (entry.snapshot.laneId === laneId) return true;
  }
  return false;
}

export function resetChatLaunchStoreForTests(): void {
  chatLaunchStore.setState({ entries: {}, dismissed: {} });
  localRecords.clear();
  unsentQueuedMessages.clear();
  refreshingLaunchIds.clear();
  cachedOriginClientId = null;
}

/* ── Optimistic snapshot ──────────────────────────────────────────────── */

export function buildOptimisticChatLaunchSnapshot(args: {
  launch: ChatLaunchArgs & { laneId: string; laneName: string };
  includeFetch: boolean;
  nowIso?: string;
}): ChatLaunchSnapshot {
  return createChatLaunchSnapshot({
    launch: args.launch,
    laneId: args.launch.laneId,
    laneName: args.launch.laneName,
    includeFetch: args.includeFetch,
    // The client cannot know whether a template or environment config applies;
    // the host's first snapshot adds the stage when one does.
    includeEnvironment: false,
    nowIso: args.nowIso ?? new Date().toISOString(),
  });
}

/* ── Hooks ─────────────────────────────────────────────────────────────── */

/** Before the host answers, a launch has nothing to cancel yet — unless `start` itself failed. */
export function useChatLaunchHostReady(launchId: string | null | undefined): boolean {
  return useStore(chatLaunchStore, (state) => {
    const entry = launchId ? state.entries[launchId] : undefined;
    return entry ? entry.hostSeen || entry.startError != null : true;
  });
}

export function useChatLaunchSnapshot(launchId: string | null | undefined): ChatLaunchSnapshot | null {
  return useStore(chatLaunchStore, (state) => (launchId ? state.entries[launchId]?.snapshot ?? null : null));
}

const EMPTY_LANE_ID_SET: ReadonlySet<string> = new Set();
let cachedLaneIdEntries: Record<string, ChatLaunchEntry> | null = null;
let cachedLaneIds: ReadonlySet<string> = EMPTY_LANE_ID_SET;

function pendingLaunchLaneIdsOf(entries: Record<string, ChatLaunchEntry>): ReadonlySet<string> {
  if (entries === cachedLaneIdEntries) return cachedLaneIds;
  const ids = new Set<string>();
  for (const entry of Object.values(entries)) {
    if (entry.snapshot.kind === "chat" && entry.snapshot.phase !== "cancelled") ids.add(entry.snapshot.laneId);
  }
  cachedLaneIdEntries = entries;
  // Keep the previous set's identity when membership did not change, so
  // consumers do not re-render on every stage tick.
  const same = ids.size === cachedLaneIds.size && [...ids].every((id) => cachedLaneIds.has(id));
  if (!same) cachedLaneIds = ids.size ? ids : EMPTY_LANE_ID_SET;
  return cachedLaneIds;
}

/** Lane ids reserved by chat launches that have not been cancelled. */
export function usePendingChatLaunchLaneIds(): ReadonlySet<string> {
  return useStore(chatLaunchStore, (state) => pendingLaunchLaneIdsOf(state.entries));
}

/* ── Narrow subscriptions ──────────────────────────────────────────────────
   A launch snapshot changes many times a second while files check out. The
   Work roster and the chat pane only care about a few fields, so they read
   through an equality gate and re-render only when those fields move. The
   setup card and the sidebar status line subscribe to the full snapshot. */

export function useChatLaunchSelector<T>(select: (state: ChatLaunchState) => T, isEqual: (a: T, b: T) => boolean): T {
  const cacheRef = useRef<{ value: T } | null>(null);
  const getSnapshot = (): T => {
    const next = select(chatLaunchStore.getState());
    const previous = cacheRef.current;
    if (previous && isEqual(previous.value, next)) return previous.value;
    cacheRef.current = { value: next };
    return next;
  };
  return useSyncExternalStore(chatLaunchStore.subscribe, getSnapshot, getSnapshot);
}

export type ChatLaunchRowSource = {
  snapshot: ChatLaunchSnapshot;
  binding: OpenProjectBinding | null;
  bindingKey: string;
};

function rowSignature(source: ChatLaunchRowSource): string {
  const s = source.snapshot;
  return [
    s.launchId,
    s.kind,
    s.sessionId ?? "",
    s.laneId,
    s.laneName,
    s.title,
    s.modelId ?? "",
    s.startedAt,
    // What decides whether the roster lists a stand-in row (`shouldListChatLaunchRow`).
    s.phase === "cancelled" ? "cancelled" : "live",
    s.sessionCreated ? "created" : "reserved",
    isChatLaunchPending(s) ? "pending" : "started",
    source.bindingKey,
  ].join("\u0001");
}

function sameRowSources(a: ChatLaunchRowSource[], b: ChatLaunchRowSource[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (rowSignature(a[i]!) !== rowSignature(b[i]!)) return false;
  }
  return true;
}

/** Launches as the Work roster needs them: identity, lane, title — not stage ticks. */
export function useChatLaunchRowSources(): ChatLaunchRowSource[] {
  return useChatLaunchSelector(
    (state) => Object.values(state.entries)
      .map((entry) => ({ snapshot: entry.snapshot, binding: entry.binding, bindingKey: entry.bindingKey }))
      .sort((a, b) => a.snapshot.launchId.localeCompare(b.snapshot.launchId)),
    sameRowSources,
  );
}

function samePaneSnapshot(a: ChatLaunchSnapshot | null, b: ChatLaunchSnapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.launchId === b.launchId
    && a.kind === b.kind
    && a.phase === b.phase
    && a.sessionId === b.sessionId
    && a.sessionCreated === b.sessionCreated
    && a.agentStarted === b.agentStarted
    && a.laneId === b.laneId
    && a.laneName === b.laneName
    && a.prompt.text === b.prompt.text
    && a.prompt.displayText === b.prompt.displayText
    && a.prompt.attachments.length === b.prompt.attachments.length
    && a.queuedMessages.length === b.queuedMessages.length
    && a.queuedMessages.every((message, index) => (
      message.id === b.queuedMessages[index]?.id
      && (message.deliveryError ?? null) === (b.queuedMessages[index]?.deliveryError ?? null)
    ));
}

/**
 * The launch behind a chat pane, re-rendering only on what the pane acts on
 * (phase, session created, agent started, queued messages). The live setup
 * card reads the full snapshot on its own.
 */
export function useChatLaunchForPane(sessionId: string | null | undefined): ChatLaunchSnapshot | null {
  return useChatLaunchSelector(
    (state) => (sessionId ? state.entries[sessionId]?.snapshot ?? null : null),
    samePaneSnapshot,
  );
}

export type ChatLaunchRowState = {
  startedAt: string;
  /** A chat launch that still owns its chat's first moments (see `isChatLaunchPending`). */
  pending: boolean;
  failed: boolean;
};

function sameRowState(a: ChatLaunchRowState | null, b: ChatLaunchRowState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.startedAt === b.startedAt && a.pending === b.pending && a.failed === b.failed;
}

/**
 * What a Work sidebar row needs from its launch: whether it is still being set
 * up and whether that failed. Changes a handful of times per launch, so a row
 * never re-renders on checkout progress; the moving status text subscribes on
 * its own through {@link useChatLaunchStatusLine}.
 */
export function useChatLaunchRowState(sessionId: string | null | undefined): ChatLaunchRowState | null {
  return useChatLaunchSelector((state) => {
    const snapshot = sessionId ? state.entries[sessionId]?.snapshot : undefined;
    if (!snapshot) return null;
    const pending = snapshot.kind === "chat" && isChatLaunchPending(snapshot);
    return { startedAt: snapshot.startedAt, pending, failed: pending && snapshot.phase === "failed" };
  }, sameRowState);
}

/** The launch's one-line status ("Checking out files · 62%"); re-renders only when the text changes. */
export function useChatLaunchStatusLine(launchId: string | null | undefined): string | null {
  return useStore(chatLaunchStore, (state) => {
    const snapshot = launchId ? state.entries[launchId]?.snapshot : undefined;
    return snapshot ? chatLaunchStatusLine(snapshot) : null;
  });
}
