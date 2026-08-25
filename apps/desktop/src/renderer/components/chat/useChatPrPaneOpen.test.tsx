/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatPrPaneOpen } from "./useChatPrPaneOpen";
import {
  chatCompanionUiStorageKey,
  readChatCompanionUiState,
  resetChatCompanionUiStateCacheForTests,
  writeChatCompanionUiState,
  DEFAULT_CHAT_COMPANION_UI_STATE,
} from "./chatCompanionUiState";

beforeEach(() => {
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
});

afterEach(() => {
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
});

describe("useChatPrPaneOpen", () => {
  it("starts closed", () => {
    const { result } = renderHook(() => useChatPrPaneOpen("chat-1"));
    expect(result.current.prPaneOpen).toBe(false);
  });

  it("seeds the pane open from stored companion state", () => {
    writeChatCompanionUiState("chat-1", { ...DEFAULT_CHAT_COMPANION_UI_STATE, prPaneOpen: true });
    resetChatCompanionUiStateCacheForTests();

    const { result } = renderHook(() => useChatPrPaneOpen("chat-1"));
    // Seeded on the FIRST render — not after an effect — so the pane never
    // flashes closed on chat open.
    expect(result.current.prPaneOpen).toBe(true);
  });

  it("persists a manual toggle to localStorage", () => {
    const { result } = renderHook(() => useChatPrPaneOpen("chat-1"));

    act(() => result.current.setPrPaneOpen(true));
    expect(readChatCompanionUiState("chat-1").prPaneOpen).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(chatCompanionUiStorageKey("chat-1"))!).prPaneOpen).toBe(true);

    act(() => result.current.setPrPaneOpen(false));
    expect(readChatCompanionUiState("chat-1").prPaneOpen).toBe(false);
  });

  it("re-seeds per chat when the persist key changes", async () => {
    writeChatCompanionUiState("chat-2", { ...DEFAULT_CHAT_COMPANION_UI_STATE, prPaneOpen: true });
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useChatPrPaneOpen(key),
      { initialProps: { key: "chat-1" } },
    );
    await act(async () => {});
    expect(result.current.prPaneOpen).toBe(false);

    rerender({ key: "chat-2" });
    await act(async () => {});
    expect(result.current.prPaneOpen).toBe(true);
    // Switching chats must not write chat-1's value into chat-2 (or vice versa).
    expect(readChatCompanionUiState("chat-1").prPaneOpen).toBe(false);
    expect(readChatCompanionUiState("chat-2").prPaneOpen).toBe(true);
  });

  it("never writes the outgoing chat's value into the incoming chat's record", async () => {
    // Regression: the hydrate and persist effects share a fiber and flush in
    // declaration order, so on the commit where the key changes the persist
    // effect still closes over the OUTGOING chat's `prPaneOpen`. Asserting the
    // settled value cannot catch that — a corrective render repairs it — so
    // watch the writes themselves.
    writeChatCompanionUiState("chat-2", { ...DEFAULT_CHAT_COMPANION_UI_STATE, prPaneOpen: true });
    resetChatCompanionUiStateCacheForTests();

    const chat2Key = chatCompanionUiStorageKey("chat-2");
    const writes: string[] = [];
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === chat2Key) writes.push(value);
        originalSetItem.call(this, key, value);
      });

    try {
      const { rerender } = renderHook(
        ({ key }: { key: string }) => useChatPrPaneOpen(key),
        { initialProps: { key: "chat-1" } },
      );
      await act(async () => {});
      rerender({ key: "chat-2" });
      await act(async () => {});

      // chat-1 was closed; chat-2 is open. No write to chat-2 may carry `false`.
      const clobbered = writes.filter((value) => value.includes("\"prPaneOpen\":false"));
      expect(clobbered).toEqual([]);
      expect(readChatCompanionUiState("chat-2").prPaneOpen).toBe(true);
    } finally {
      setItem.mockRestore();
    }
  });

  it("keeps working with no persist key and writes nothing to storage", async () => {
    const { result } = renderHook(() => useChatPrPaneOpen(null));
    await act(async () => {});

    act(() => result.current.setPrPaneOpen(true));
    expect(result.current.prPaneOpen).toBe(true);
    expect(window.localStorage.length).toBe(0);
  });
});
