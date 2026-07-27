/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chatCompanionUiStorageKey,
  patchChatCompanionUiState,
  pruneChatCompanionUiState,
  readChatCompanionUiState,
  resetChatCompanionUiStateCacheForTests,
  writeChatCompanionUiState,
  DEFAULT_CHAT_COMPANION_UI_STATE,
} from "./chatCompanionUiState";

const PREFIX = "ade.chat.companionUiState.";

function storedRecord(key: string): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(chatCompanionUiStorageKey(key));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function companionKeysInStorage(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const storageKey = window.localStorage.key(index);
    if (storageKey?.startsWith(PREFIX)) keys.push(storageKey.slice(PREFIX.length));
  }
  return keys;
}

/** Write `key` with a controlled write timestamp, so prune order is exact. */
function writeAt(key: string, atMs: number, over: Partial<typeof DEFAULT_CHAT_COMPANION_UI_STATE> = {}) {
  const now = vi.spyOn(Date, "now").mockReturnValue(atMs);
  try {
    writeChatCompanionUiState(key, { ...DEFAULT_CHAT_COMPANION_UI_STATE, ...over });
  } finally {
    now.mockRestore();
  }
}

beforeEach(() => {
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
});

afterEach(() => {
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
  vi.restoreAllMocks();
});

describe("chatCompanionUiState persistence", () => {
  it("stamps and round-trips savedAtMs on write", () => {
    writeAt("chat-1", 1_700_000_000_000, { prPaneOpen: true });
    resetChatCompanionUiStateCacheForTests();

    expect(storedRecord("chat-1")?.savedAtMs).toBe(1_700_000_000_000);
    // The timestamp is storage metadata: it must not leak into the UI state.
    expect(readChatCompanionUiState("chat-1")).toEqual({
      ...DEFAULT_CHAT_COMPANION_UI_STATE,
      prPaneOpen: true,
    });
  });

  it("degrades a corrupt stored value to the defaults instead of throwing", () => {
    window.localStorage.setItem(chatCompanionUiStorageKey("chat-1"), "{not json");
    resetChatCompanionUiStateCacheForTests();
    expect(() => readChatCompanionUiState("chat-1")).not.toThrow();
    expect(readChatCompanionUiState("chat-1")).toEqual(DEFAULT_CHAT_COMPANION_UI_STATE);
  });

  it("degrades garbage field types to the defaults", () => {
    window.localStorage.setItem(
      chatCompanionUiStorageKey("chat-1"),
      JSON.stringify({ prPaneOpen: "yes", chatActionsOpen: 1, chatActionsTab: "nope" }),
    );
    resetChatCompanionUiStateCacheForTests();
    const restored = readChatCompanionUiState("chat-1");
    expect(restored.prPaneOpen).toBe(false);
    expect(restored.chatActionsOpen).toBe(false);
    expect(restored.chatActionsTab).toBe("agents");
  });
});

describe("patchChatCompanionUiState", () => {
  it("merges into the stored record rather than replacing it", () => {
    writeChatCompanionUiState("chat-1", {
      ...DEFAULT_CHAT_COMPANION_UI_STATE,
      chatActionsOpen: true,
      chatActionsTab: "proof",
      terminalDrawerOpen: true,
    });

    patchChatCompanionUiState("chat-1", { prPaneOpen: true });
    resetChatCompanionUiStateCacheForTests();

    const restored = readChatCompanionUiState("chat-1");
    // The other owner's fields survive a single-field patch.
    expect(restored.prPaneOpen).toBe(true);
    expect(restored.chatActionsOpen).toBe(true);
    expect(restored.chatActionsTab).toBe("proof");
    expect(restored.terminalDrawerOpen).toBe(true);
  });

  it("patches a key that has nothing stored yet, starting from the defaults", () => {
    const next = patchChatCompanionUiState("chat-new", { prPaneOpen: true });
    expect(next).toEqual({ ...DEFAULT_CHAT_COMPANION_UI_STATE, prPaneOpen: true });
    resetChatCompanionUiStateCacheForTests();
    expect(readChatCompanionUiState("chat-new").prPaneOpen).toBe(true);
  });
});

describe("pruneChatCompanionUiState", () => {
  it("returns 0 without enumerating storage when it is under the cap", () => {
    writeChatCompanionUiState("chat-1", DEFAULT_CHAT_COMPANION_UI_STATE);
    const keySpy = vi.spyOn(Storage.prototype, "key");

    expect(pruneChatCompanionUiState(200)).toBe(0);

    // The fast path is one `length` read: prefixed keys are a subset of all
    // keys, so an under-cap store cannot hold an over-cap family.
    expect(keySpy).not.toHaveBeenCalled();
  });

  it("evicts oldest-first and never leaves the family over the cap", () => {
    // Insertion order is deliberately NOT write-time order, so only a real
    // savedAtMs ordering can pick the right victims.
    writeAt("chat-newest", 5_000);
    writeAt("chat-oldest", 1_000);
    writeAt("chat-mid-late", 4_000);
    writeAt("chat-mid-early", 2_000);

    expect(pruneChatCompanionUiState(2)).toBe(2);
    expect(companionKeysInStorage().sort()).toEqual(["chat-mid-late", "chat-newest"]);
    // Idempotent once at the cap.
    expect(pruneChatCompanionUiState(2)).toBe(0);
  });

  it("evicts legacy records with no savedAtMs before timestamped ones", () => {
    writeAt("chat-a", 1_000);
    writeAt("chat-b", 2_000);
    // Written last, so only the missing timestamp can make it the first victim.
    window.localStorage.setItem(
      chatCompanionUiStorageKey("legacy"),
      JSON.stringify({ prPaneOpen: true }),
    );

    expect(pruneChatCompanionUiState(2)).toBe(1);
    expect(companionKeysInStorage().sort()).toEqual(["chat-a", "chat-b"]);
  });

  it("treats a CLI/terminal-session key exactly like a chat-session key", () => {
    // Regression: the old prune took a `knownKeys` set built only from chat
    // sessions, so a live CLI-surface key was permanently "unknown" and was the
    // first thing evicted. Write order alone must decide.
    writeAt("chat-old-1", 1_000);
    writeAt("chat-old-2", 2_000);
    writeAt("term-session-9f2a", 3_000, { prPaneOpen: true });

    expect(pruneChatCompanionUiState(1)).toBe(2);
    // The newest key survives whichever surface wrote it.
    expect(companionKeysInStorage()).toEqual(["term-session-9f2a"]);
    resetChatCompanionUiStateCacheForTests();
    expect(readChatCompanionUiState("term-session-9f2a").prPaneOpen).toBe(true);

    // ...and the mirror case: an old CLI key is not privileged either.
    window.localStorage.clear();
    resetChatCompanionUiStateCacheForTests();
    writeAt("term-session-9f2a", 1_000);
    writeAt("chat-new-1", 2_000);
    writeAt("chat-new-2", 3_000);
    expect(pruneChatCompanionUiState(2)).toBe(1);
    expect(companionKeysInStorage().sort()).toEqual(["chat-new-1", "chat-new-2"]);
  });

  it("ignores keys outside the companion namespace", () => {
    window.localStorage.setItem("ade.some.other.key", "1");
    window.localStorage.setItem("ade.another.key", "2");
    writeAt("chat-1", 1_000);
    writeAt("chat-2", 2_000);

    expect(pruneChatCompanionUiState(1)).toBe(1);
    expect(window.localStorage.getItem("ade.some.other.key")).toBe("1");
    expect(window.localStorage.getItem("ade.another.key")).toBe("2");
    expect(companionKeysInStorage()).toEqual(["chat-2"]);
  });

  it("garbage-collects on write with no explicit prune call", () => {
    // The module must be self-sufficient: no surface has to run a prune effect.
    for (let index = 0; index < 205; index += 1) writeAt(`chat-${index}`, 1_000 + index);

    expect(companionKeysInStorage().length).toBe(200);
    // The key just written is the newest, so a write can never evict itself.
    expect(companionKeysInStorage()).toContain("chat-204");
    expect(companionKeysInStorage()).not.toContain("chat-0");
  });

  it("never evicts the key a live surface is writing, however many surfaces write", () => {
    for (let index = 0; index < 210; index += 1) {
      writeAt(index % 2 === 0 ? `chat-${index}` : `term-${index}`, 1_000 + index);
    }
    // Both surfaces keep re-writing their own live key; both must survive.
    writeAt("chat-live", 9_000, { chatActionsOpen: true });
    writeAt("term-live", 9_001, { prPaneOpen: true });

    const keys = companionKeysInStorage();
    expect(keys.length).toBe(200);
    expect(keys).toContain("chat-live");
    expect(keys).toContain("term-live");
    resetChatCompanionUiStateCacheForTests();
    expect(readChatCompanionUiState("term-live").prPaneOpen).toBe(true);
    expect(readChatCompanionUiState("chat-live").chatActionsOpen).toBe(true);
  });

  it("survives an app restart (localStorage, not sessionStorage)", () => {
    writeChatCompanionUiState("chat-1", { ...DEFAULT_CHAT_COMPANION_UI_STATE, prPaneOpen: true });
    expect(window.localStorage.getItem(chatCompanionUiStorageKey("chat-1"))).toBeTruthy();
    expect(window.sessionStorage.getItem(chatCompanionUiStorageKey("chat-1"))).toBeNull();
  });

  it("keeps the legacy proofDrawerOpen migration working", () => {
    window.localStorage.setItem(
      chatCompanionUiStorageKey("chat-1"),
      JSON.stringify({ proofDrawerOpen: true }),
    );
    resetChatCompanionUiStateCacheForTests();
    const restored = readChatCompanionUiState("chat-1");
    expect(restored.chatActionsOpen).toBe(true);
    expect(restored.chatActionsTab).toBe("proof");
    expect(restored.prPaneOpen).toBe(false);
  });
});
