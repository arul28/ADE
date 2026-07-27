import type { ChatActionsTab } from "./ChatActionsDrawerPanel";

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
  /** Floating PR pane (left side). Persisted per chat, incl. webhook auto-pop. */
  prPaneOpen: boolean;
};

export const DEFAULT_CHAT_COMPANION_UI_STATE: ChatCompanionUiState = {
  chatActionsOpen: false,
  chatActionsTab: "agents",
  iosSimulatorOpen: false,
  appControlOpen: false,
  terminalDrawerOpen: false,
  prPaneOpen: false,
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
 * The namespace has two independent owners — the chat shell's drawer state and
 * `useChatPrAutoPop`'s `prPaneOpen` — so a whole-record write from either one
 * clobbers the other unless it reads forward first. Doing the read-merge-write
 * here makes that structural instead of a convention each caller has to honour.
 */
export function patchChatCompanionUiState(
  key: string,
  patch: Partial<ChatCompanionUiState>,
): ChatCompanionUiState {
  const next: ChatCompanionUiState = { ...readChatCompanionUiState(key), ...patch };
  writeChatCompanionUiState(key, next);
  return next;
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
