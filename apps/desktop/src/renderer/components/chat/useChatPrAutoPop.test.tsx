/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatPrAutoPop } from "./useChatPrAutoPop";
import {
  chatCompanionUiStorageKey,
  readChatCompanionUiState,
  resetChatCompanionUiStateCacheForTests,
  writeChatCompanionUiState,
  DEFAULT_CHAT_COMPANION_UI_STATE,
} from "./chatCompanionUiState";
import type { PrEventPayload, PrSummary } from "../../../shared/types";

function makePr(over: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr1",
    laneId: "lane1",
    projectId: "proj",
    repoOwner: "o",
    repoName: "r",
    githubPrNumber: 42,
    githubUrl: "https://github.com/o/r/pull/42",
    githubNodeId: null,
    title: "PR",
    state: "open",
    baseBranch: "main",
    headBranch: "feat",
    checksStatus: "none",
    reviewStatus: "none",
    additions: 1,
    deletions: 0,
    mergeConflicts: null,
    behindBaseBy: null,
    headSha: "aaa111",
    lastSyncedAt: new Date().toISOString(),
    createdAt: "2026-06-30T00:00:00Z",
    updatedAt: "rev-1",
    creationStrategy: null,
    ...over,
  };
}

const originalAde = (globalThis.window as { ade?: unknown }).ade;
let emit: ((event: PrEventPayload) => void) | null = null;

function installAde(initial: PrSummary | null) {
  emit = null;
  (globalThis.window as { ade?: unknown }).ade = {
    prs: {
      getForLane: vi.fn().mockResolvedValue(initial),
      onEvent: vi.fn().mockImplementation((cb: (event: PrEventPayload) => void) => {
        emit = cb;
        return () => { emit = null; };
      }),
    },
  };
}

function emitUpdated(prs: PrSummary[]) {
  act(() => emit?.({ type: "prs-updated", polledAt: "now", prs }));
}

beforeEach(() => {
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
});

afterEach(() => {
  (globalThis.window as { ade?: unknown }).ade = originalAde;
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
  vi.clearAllMocks();
});

describe("useChatPrAutoPop", () => {
  it("starts closed and does not pop for a PR that already existed on open", async () => {
    installAde(makePr({ state: "open" }));
    const { result } = renderHook(() => useChatPrAutoPop("lane1"));
    // Let the silent baseline seed resolve.
    await waitFor(() => expect(window.ade.prs.getForLane).toHaveBeenCalled());
    await act(async () => {});
    // Re-emitting the same open PR (e.g. a checks refresh) must not pop.
    emitUpdated([makePr({ state: "open", checksStatus: "passing" })]);
    expect(result.current.prPaneOpen).toBe(false);
    expect(result.current.prPaneDelta).toBeNull();
  });

  it("pops with a lifecycle delta when the PR merges", async () => {
    installAde(makePr({ state: "open" }));
    const { result } = renderHook(() => useChatPrAutoPop("lane1"));
    await act(async () => {});
    emitUpdated([makePr({ state: "merged" })]);
    expect(result.current.prPaneOpen).toBe(true);
    expect(result.current.prPaneDelta?.kind).toBe("merged");
  });

  it("pops for a new commit push (head sha change)", async () => {
    installAde(makePr({ state: "open", headSha: "aaa111" }));
    const { result } = renderHook(() => useChatPrAutoPop("lane1"));
    await act(async () => {});
    emitUpdated([makePr({ state: "open", headSha: "bbb222" })]);
    expect(result.current.prPaneOpen).toBe(true);
    expect(result.current.prPaneDelta?.kind).toBe("commit");
  });

  it("re-pops on each qualifying event with a fresh nonce", async () => {
    installAde(makePr({ state: "open", headSha: "aaa111" }));
    const { result } = renderHook(() => useChatPrAutoPop("lane1"));
    await act(async () => {});
    emitUpdated([makePr({ state: "open", headSha: "bbb222" })]);
    const first = result.current.prPaneDelta?.nonce;
    emitUpdated([makePr({ state: "merged", headSha: "bbb222" })]);
    expect(result.current.prPaneDelta?.kind).toBe("merged");
    expect(result.current.prPaneDelta?.nonce).not.toBe(first);
  });

  it("degrades to no-op when the prs bridge is unavailable", () => {
    (globalThis.window as { ade?: unknown }).ade = {};
    const { result } = renderHook(() => useChatPrAutoPop("lane1"));
    expect(result.current.prPaneOpen).toBe(false);
    expect(result.current.prPaneDelta).toBeNull();
  });
});

describe("useChatPrAutoPop persistence", () => {
  it("seeds the pane open from stored companion state", () => {
    installAde(makePr({ state: "open" }));
    writeChatCompanionUiState("chat-1", { ...DEFAULT_CHAT_COMPANION_UI_STATE, prPaneOpen: true });
    resetChatCompanionUiStateCacheForTests();

    const { result } = renderHook(() => useChatPrAutoPop("lane1", { persistKey: "chat-1" }));
    // Seeded on the FIRST render — not after an effect — so the pane never
    // flashes closed on chat open.
    expect(result.current.prPaneOpen).toBe(true);
  });

  it("persists a manual toggle to localStorage", async () => {
    installAde(null);
    const { result } = renderHook(() => useChatPrAutoPop("lane1", { persistKey: "chat-1" }));
    await act(async () => {});

    act(() => result.current.setPrPaneOpen(true));
    expect(readChatCompanionUiState("chat-1").prPaneOpen).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(chatCompanionUiStorageKey("chat-1"))!).prPaneOpen).toBe(true);

    act(() => result.current.setPrPaneOpen(false));
    expect(readChatCompanionUiState("chat-1").prPaneOpen).toBe(false);
  });

  it("persists the webhook auto-pop too", async () => {
    installAde(makePr({ state: "open" }));
    const { result } = renderHook(() => useChatPrAutoPop("lane1", { persistKey: "chat-1" }));
    await act(async () => {});

    emitUpdated([makePr({ state: "merged" })]);

    expect(result.current.prPaneOpen).toBe(true);
    expect(readChatCompanionUiState("chat-1").prPaneOpen).toBe(true);
  });

  it("an already-open PR still does not pop on chat open with a persist key", async () => {
    installAde(makePr({ state: "open" }));
    const { result } = renderHook(() => useChatPrAutoPop("lane1", { persistKey: "chat-1" }));
    await waitFor(() => expect(window.ade.prs.getForLane).toHaveBeenCalled());
    await act(async () => {});

    emitUpdated([makePr({ state: "open", checksStatus: "passing" })]);

    expect(result.current.prPaneOpen).toBe(false);
    expect(result.current.prPaneDelta).toBeNull();
    // The silent baseline seed must not have written an "open" pane either.
    expect(readChatCompanionUiState("chat-1").prPaneOpen).toBe(false);
  });

  it("re-seeds per chat when the persist key changes", async () => {
    installAde(null);
    writeChatCompanionUiState("chat-2", { ...DEFAULT_CHAT_COMPANION_UI_STATE, prPaneOpen: true });
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useChatPrAutoPop("lane1", { persistKey: key }),
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
    installAde(null);
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
        ({ key }: { key: string }) => useChatPrAutoPop("lane1", { persistKey: key }),
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

  it("keeps working with no persist key", async () => {
    installAde(makePr({ state: "open" }));
    const { result } = renderHook(() => useChatPrAutoPop("lane1"));
    await act(async () => {});
    emitUpdated([makePr({ state: "merged" })]);
    expect(result.current.prPaneOpen).toBe(true);
    expect(window.localStorage.length).toBe(0);
  });
});
