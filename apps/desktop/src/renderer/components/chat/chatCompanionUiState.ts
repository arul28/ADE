import { useCallback, useSyncExternalStore } from "react";
import type { ChatActionsTab } from "./ChatActionsDrawerPanel";
import {
  isWorkLiveCardClosed,
  isWorkLivePreviewDisabled,
  normalizeWorkLiveCardClosedByTool,
  type WorkLiveCardClosedByTool,
  type WorkLiveScreenTool,
} from "../../state/workLiveCardState";

/**
 * Per-chat companion UI state — which side panes/drawers a given chat had open.
 *
 * Scoped by a companion key, so switching surfaces restores each one's own
 * shell instead of dragging the previous one's open drawers along. Two surfaces
 * write this namespace and their key spaces are disjoint: the ADE chat pane
 * keys by chat session id (plus a couple of reserved draft keys), the CLI
 * session pane keys by terminal session id. Nothing here may assume one
 * surface's keys are the only live ones.
 *
 * Persisted in `localStorage` rather than `sessionStorage`: reopening the app
 * to the chat you left should look like the chat you left. It is still
 * best-effort UI state — every read degrades to the defaults.
 */
export type ChatCompanionUiState = {
  chatActionsOpen: boolean;
  chatActionsTab: ChatActionsTab;
  iosSimulatorOpen: boolean;
  appControlOpen: boolean;
  terminalDrawerOpen: boolean;
  /** Floating PR pane (left side). Persisted per chat; explicit open/close only. */
  prPaneOpen: boolean;
  /**
   * Which card the Apple Development tools drawer has open (round 4 §B1).
   *
   * One of the four group ids, or null for a drawer collapsed to its four
   * headers. Typed as a string here on purpose: this module is the chat shell's
   * store and must not take a dependency on the Apple feature's union to hold a
   * value it only ever round-trips. The drawer validates what it reads.
   */
  appleToolsGroup: string | null;
  /**
   * The Work corner card's "off" markers for this chat, keyed by tool id.
   *
   * Mirror of lane mac-desktop (b18dd67ec) minus the mac-desktop tool; on merge,
   * take theirs. Written by × on a floating preview (valued with the session key
   * that was closed) and by the "Show preview when minimized" toggle (valued
   * with a sentinel). Presence is what disables the preview, so the reader is
   * `isWorkLivePreviewEnabled`, not a session-key comparison. Per chat because
   * the preview belongs to the conversation you are reading.
   */
  workLiveCardClosedByTool: WorkLiveCardClosedByTool;
};

export const DEFAULT_CHAT_COMPANION_UI_STATE: ChatCompanionUiState = {
  chatActionsOpen: false,
  chatActionsTab: "agents",
  iosSimulatorOpen: false,
  appControlOpen: false,
  terminalDrawerOpen: false,
  prPaneOpen: false,
  appleToolsGroup: "device",
  workLiveCardClosedByTool: {},
};

const CHAT_COMPANION_UI_STORAGE_PREFIX = "ade.chat.companionUiState.";

/**
 * Ceiling on stored companion keys before a prune runs. Chats are created far
 * more often than they are revisited, so without this the family grows once per
 * chat forever. The cap is deliberately generous: pruning is only ever a
 * garbage-collection pass, never a correctness mechanism.
 */
const MAX_CHAT_COMPANION_UI_ENTRIES = 200;

/**
 * The persisted record: the UI state plus the write timestamp that orders the
 * prune. `savedAtMs` is storage metadata, deliberately kept out of
 * `ChatCompanionUiState` so callers never have to carry it forward.
 */
type StoredChatCompanionUiState = Partial<ChatCompanionUiState> & {
  /** Pre-consolidation field name for `chatActionsOpen` + the "proof" tab. */
  proofDrawerOpen?: boolean;
  savedAtMs?: number;
};

function parseChatActionsTab(value: unknown): ChatActionsTab {
  if (
    value === "sources"
    || value === "agents"
    || value === "proof"
    || value === "handoff"
    || value === "missions"
  ) return value;
  return "agents";
}

const chatCompanionUiStateByKey = new Map<string, ChatCompanionUiState>();

export function chatCompanionUiStorageKey(key: string): string {
  return `${CHAT_COMPANION_UI_STORAGE_PREFIX}${key}`;
}

export function readChatCompanionUiState(key: string): ChatCompanionUiState {
  const cached = chatCompanionUiStateByKey.get(key);
  if (cached) return cached;
  try {
    const raw = window.localStorage.getItem(chatCompanionUiStorageKey(key));
    if (raw) {
      const decoded = JSON.parse(raw) as unknown;
      // Every field is read defensively: a hand-edited / partially-written /
      // older-shape value must degrade to the default, never throw and never
      // hand a non-boolean to a pane that treats it as one.
      const parsed = (decoded && typeof decoded === "object" ? decoded : {}) as
        StoredChatCompanionUiState;
      const legacyProofOpen = parsed.proofDrawerOpen === true;
      const state: ChatCompanionUiState = {
        chatActionsOpen: parsed.chatActionsOpen === true || legacyProofOpen,
        chatActionsTab: legacyProofOpen && parsed.chatActionsTab == null
          ? "proof"
          : parseChatActionsTab(parsed.chatActionsTab),
        iosSimulatorOpen: parsed.iosSimulatorOpen === true,
        appControlOpen: parsed.appControlOpen === true,
        terminalDrawerOpen: parsed.terminalDrawerOpen === true,
        prPaneOpen: parsed.prPaneOpen === true,
        // `undefined` is "never written", which is the default card; an explicit
        // null is a drawer the user collapsed and must stay collapsed.
        appleToolsGroup: parsed.appleToolsGroup === undefined
          ? DEFAULT_CHAT_COMPANION_UI_STATE.appleToolsGroup
          : (typeof parsed.appleToolsGroup === "string" ? parsed.appleToolsGroup : null),
        workLiveCardClosedByTool: normalizeWorkLiveCardClosedByTool(parsed.workLiveCardClosedByTool),
      };
      chatCompanionUiStateByKey.set(key, state);
      return state;
    }
  } catch {
    // Local storage is best-effort UI state only.
  }
  return DEFAULT_CHAT_COMPANION_UI_STATE;
}

export function writeChatCompanionUiState(key: string, state: ChatCompanionUiState): void {
  chatCompanionUiStateByKey.set(key, state);
  notifyChatCompanionUiState(key);
  try {
    const record: StoredChatCompanionUiState = { ...state, savedAtMs: Date.now() };
    window.localStorage.setItem(chatCompanionUiStorageKey(key), JSON.stringify(record));
  } catch {
    // Local storage is best-effort UI state only.
  }
  // Garbage-collect from inside the module, on the only event that can grow the
  // family. No caller has to know it exists, and no caller has to enumerate its
  // own live keys — which is what made the old `knownKeys` prune wrong as soon
  // as a second surface (the CLI session pane) started writing this namespace.
  pruneChatCompanionUiState();
}

/**
 * Merge `patch` into the stored record for `key`.
 *
 * A whole-record write clobbers fields this caller does not own — older blobs
 * still carry `prPaneOpen` from the retired floating pane — so the write reads
 * forward first. Doing the read-merge-write here makes that structural.
 */
export function patchChatCompanionUiState(
  key: string,
  patch: Partial<ChatCompanionUiState>,
): ChatCompanionUiState {
  const next: ChatCompanionUiState = { ...readChatCompanionUiState(key), ...patch };
  writeChatCompanionUiState(key, next);
  return next;
}

/* ── Live-preview markers ────────────────────────────────────────────────────
 * Mirror of lane mac-desktop (b18dd67ec) minus the mac-desktop tool; on merge,
 * take theirs.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Per-key change listeners.
 *
 * The floating preview (which reads a chat's closed flags) and the toggle in
 * the tool's own header (which writes them) live in different subtrees, so a
 * plain module read would go stale without a write. `useSyncExternalStore` over
 * this map is the smallest thing that keeps them in step; every write replaces
 * the cached object, so the snapshot identity changes exactly when the state
 * does.
 */
const chatCompanionUiSubscribers = new Map<string, Set<() => void>>();

function notifyChatCompanionUiState(key: string): void {
  const listeners = chatCompanionUiSubscribers.get(key);
  if (!listeners) return;
  for (const listener of [...listeners]) listener();
}

export function subscribeChatCompanionUiState(key: string, listener: () => void): () => void {
  let listeners = chatCompanionUiSubscribers.get(key);
  if (!listeners) {
    listeners = new Set();
    chatCompanionUiSubscribers.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) chatCompanionUiSubscribers.delete(key);
  };
}

/**
 * The companion UI state for a chat, reactively.
 *
 * A null key is the projectless/draft surface: it answers the defaults and
 * subscribes to nothing, so a caller can always call this hook.
 */
export function useChatCompanionUiState(key: string | null): ChatCompanionUiState {
  const subscribe = useCallback(
    (listener: () => void) => (key ? subscribeChatCompanionUiState(key, listener) : () => undefined),
    [key],
  );
  const snapshot = useCallback(
    () => (key ? readChatCompanionUiState(key) : DEFAULT_CHAT_COMPANION_UI_STATE),
    [key],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Has this tool's preview been closed for this chat at the given session key? */
export function isWorkLiveCardClosedForChat(
  key: string,
  tool: WorkLiveScreenTool,
  sessionKey: string | null,
): boolean {
  return isWorkLiveCardClosed(readChatCompanionUiState(key).workLiveCardClosedByTool, tool, sessionKey);
}

/** × for one chat's preview: remember the session key it was closed at. */
export function closeWorkLiveCardForChat(
  key: string,
  tool: WorkLiveScreenTool,
  sessionKey: string,
): ChatCompanionUiState {
  const current = readChatCompanionUiState(key);
  return patchChatCompanionUiState(key, {
    workLiveCardClosedByTool: { ...current.workLiveCardClosedByTool, [tool]: sessionKey },
  });
}

/** Clears the closed marker: the preview is welcome again in this chat. */
export function floatWorkLiveCardForChat(
  key: string,
  tool: WorkLiveScreenTool,
): ChatCompanionUiState {
  const current = readChatCompanionUiState(key);
  const closed = { ...current.workLiveCardClosedByTool };
  delete closed[tool];
  return patchChatCompanionUiState(key, { workLiveCardClosedByTool: closed });
}

/**
 * The marker the "Show preview when minimized" toggle writes when it is OFF.
 *
 * A non-empty sentinel rather than an absent / empty key, because the closed
 * map is the same one × writes: presence of a marker is what reads as "off",
 * and `normalizeWorkLiveCardClosedByTool` drops empty keys on the way back in.
 */
export const WORK_LIVE_PREVIEW_DISABLED_KEY = "preview-off";

/**
 * Is the per-chat preview for this tool ON?
 *
 * Default ON — a tool only stops previewing once the user pressed × or turned
 * the toggle off. Presence-based rather than session-keyed: the toggle is a
 * statement about the tool in this chat, and it survives the next session.
 */
export function isWorkLivePreviewEnabled(
  state: Pick<ChatCompanionUiState, "workLiveCardClosedByTool">,
  tool: WorkLiveScreenTool,
): boolean {
  return !isWorkLivePreviewDisabled(state.workLiveCardClosedByTool, tool);
}

/**
 * The per-chat "Show preview when minimized" toggle, one per screen tool.
 *
 * ON clears the tool's closed marker; OFF writes the same marker × does, so the
 * two affordances can never disagree. A missing key (projectless surface) is a
 * no-op.
 */
export function setWorkLivePreviewEnabledForChat(
  key: string | null,
  tool: WorkLiveScreenTool,
  enabled: boolean,
): ChatCompanionUiState | null {
  if (!key) return null;
  if (enabled) return floatWorkLiveCardForChat(key, tool);
  return closeWorkLiveCardForChat(key, tool, WORK_LIVE_PREVIEW_DISABLED_KEY);
}

function readSavedAtMs(storage: Storage, storageKey: string): number {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return 0;
    const decoded = JSON.parse(raw) as unknown;
    const savedAtMs = (decoded as StoredChatCompanionUiState | null)?.savedAtMs;
    // Records written before `savedAtMs` existed (and corrupt ones) sort as the
    // oldest, so the stalest entries are exactly the first to go.
    return typeof savedAtMs === "number" && Number.isFinite(savedAtMs) ? savedAtMs : 0;
  } catch {
    return 0;
  }
}

/**
 * Evict the oldest stored companion records until the family fits `maxEntries`.
 *
 * Ordered by write time rather than by any caller's notion of "live" keys: the
 * namespace has more than one writer (the ADE chat pane keys by chat session,
 * the CLI session pane keys by terminal session), and any prune that trusts one
 * writer's key set treats the other writer's live keys as garbage.
 *
 * Called automatically on every write, so it needs no caller cooperation; it is
 * still exported for tests and for an explicit sweep. The common case costs one
 * `length` read — prefixed keys are a subset of all keys, so a store that is
 * under the cap cannot hold a family that is over it.
 */
export function pruneChatCompanionUiState(
  maxEntries: number = MAX_CHAT_COMPANION_UI_ENTRIES,
): number {
  let pruned = 0;
  try {
    const storage = window.localStorage;
    if (storage.length <= maxEntries) return 0;
    const entries: { storageKey: string; savedAtMs: number }[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const storageKey = storage.key(index);
      if (!storageKey?.startsWith(CHAT_COMPANION_UI_STORAGE_PREFIX)) continue;
      entries.push({ storageKey, savedAtMs: readSavedAtMs(storage, storageKey) });
    }
    if (entries.length <= maxEntries) return 0;
    // Stable sort: same-millisecond writes keep their storage order.
    entries.sort((a, b) => a.savedAtMs - b.savedAtMs);
    const evictCount = entries.length - maxEntries;
    for (let index = 0; index < evictCount; index += 1) {
      const storageKey = entries[index]!.storageKey;
      storage.removeItem(storageKey);
      chatCompanionUiStateByKey.delete(storageKey.slice(CHAT_COMPANION_UI_STORAGE_PREFIX.length));
      pruned += 1;
    }
  } catch {
    // Local storage is best-effort UI state only.
  }
  return pruned;
}

/** Test helper — the in-memory mirror outlives `localStorage.clear()`. */
export function resetChatCompanionUiStateCacheForTests(): void {
  chatCompanionUiStateByKey.clear();
}
