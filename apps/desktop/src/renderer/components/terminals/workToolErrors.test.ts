import { describe, expect, it } from "vitest";
import type { BuiltInBrowserStatus, BuiltInBrowserTab } from "../../../shared/types";
import {
  EMPTY_WORK_TOOL_ERRORS,
  pruneWorkToolBrowserErrors,
  reduceWorkToolBrowserErrors,
  workToolBrowserErrorCount,
  workToolErrorSuffix,
} from "./workToolErrors";

function tab(id: string): BuiltInBrowserTab {
  return {
    id,
    url: `https://example.test/${id}`,
    title: id,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    ownerLaneId: null,
    ownerChatSessionId: null,
    ownerClaimedAt: null,
    ownerLeaseExpiresAt: null,
    zoomFactor: 1,
    devToolsOpen: false,
    emulation: null,
    networkLogging: false,
    recording: null,
  } as unknown as BuiltInBrowserTab;
}

function status(tabIds: string[], activeTabId: string | null = tabIds[0] ?? null): BuiltInBrowserStatus {
  return { tabs: tabIds.map(tab), activeTabId } as unknown as BuiltInBrowserStatus;
}

describe("reduceWorkToolBrowserErrors", () => {
  it("records a tab's tally", () => {
    const next = reduceWorkToolBrowserErrors(EMPTY_WORK_TOOL_ERRORS, {
      tabId: "tab-1",
      consoleErrorCount: 2,
      failedRequestCount: 1,
    });
    expect(next["tab-1"]).toEqual({ consoleErrorCount: 2, failedRequestCount: 1 });
  });

  it("returns the same object when nothing moved, so the pane does not re-render", () => {
    const first = reduceWorkToolBrowserErrors(EMPTY_WORK_TOOL_ERRORS, {
      tabId: "tab-1",
      consoleErrorCount: 2,
      failedRequestCount: 0,
    });
    const second = reduceWorkToolBrowserErrors(first, {
      tabId: "tab-1",
      consoleErrorCount: 2,
      failedRequestCount: 0,
    });
    expect(second).toBe(first);
  });

  it("clears a tab when the service reports zero — that is what a navigation sends", () => {
    const withErrors = reduceWorkToolBrowserErrors(EMPTY_WORK_TOOL_ERRORS, {
      tabId: "tab-1",
      consoleErrorCount: 3,
      failedRequestCount: 2,
    });
    const cleared = reduceWorkToolBrowserErrors(withErrors, {
      tabId: "tab-1",
      consoleErrorCount: 0,
      failedRequestCount: 0,
    });
    expect(cleared["tab-1"]).toBeUndefined();
    // And a second zero for an already-clean tab is a no-op, not a new object.
    expect(reduceWorkToolBrowserErrors(cleared, {
      tabId: "tab-1",
      consoleErrorCount: 0,
      failedRequestCount: 0,
    })).toBe(cleared);
  });

  it("keeps tabs independent", () => {
    let state = reduceWorkToolBrowserErrors(EMPTY_WORK_TOOL_ERRORS, {
      tabId: "tab-1",
      consoleErrorCount: 1,
      failedRequestCount: 0,
    });
    state = reduceWorkToolBrowserErrors(state, {
      tabId: "tab-2",
      consoleErrorCount: 0,
      failedRequestCount: 4,
    });
    expect(Object.keys(state).sort()).toEqual(["tab-1", "tab-2"]);
  });

  it("ignores an empty tab id and sanitizes nonsense counts", () => {
    expect(reduceWorkToolBrowserErrors(EMPTY_WORK_TOOL_ERRORS, {
      tabId: "  ",
      consoleErrorCount: 5,
      failedRequestCount: 5,
    })).toBe(EMPTY_WORK_TOOL_ERRORS);
    const state = reduceWorkToolBrowserErrors(EMPTY_WORK_TOOL_ERRORS, {
      tabId: "tab-1",
      consoleErrorCount: -4,
      failedRequestCount: 2.7,
    });
    expect(state["tab-1"]).toEqual({ consoleErrorCount: 0, failedRequestCount: 2 });
  });
});

describe("pruneWorkToolBrowserErrors", () => {
  it("forgets tabs that no longer exist", () => {
    let state = reduceWorkToolBrowserErrors(EMPTY_WORK_TOOL_ERRORS, {
      tabId: "tab-1",
      consoleErrorCount: 1,
      failedRequestCount: 0,
    });
    state = reduceWorkToolBrowserErrors(state, {
      tabId: "tab-2",
      consoleErrorCount: 1,
      failedRequestCount: 0,
    });
    const pruned = pruneWorkToolBrowserErrors(state, status(["tab-2"]));
    expect(Object.keys(pruned)).toEqual(["tab-2"]);
  });

  it("is identity when every tracked tab is still open", () => {
    const state = reduceWorkToolBrowserErrors(EMPTY_WORK_TOOL_ERRORS, {
      tabId: "tab-1",
      consoleErrorCount: 1,
      failedRequestCount: 0,
    });
    expect(pruneWorkToolBrowserErrors(state, status(["tab-1", "tab-2"]))).toBe(state);
    expect(pruneWorkToolBrowserErrors(EMPTY_WORK_TOOL_ERRORS, null)).toBe(EMPTY_WORK_TOOL_ERRORS);
  });
});

describe("workToolBrowserErrorCount", () => {
  it("reports the active tab's total, not the sum across tabs", () => {
    let state = reduceWorkToolBrowserErrors(EMPTY_WORK_TOOL_ERRORS, {
      tabId: "tab-1",
      consoleErrorCount: 2,
      failedRequestCount: 1,
    });
    state = reduceWorkToolBrowserErrors(state, {
      tabId: "tab-2",
      consoleErrorCount: 9,
      failedRequestCount: 9,
    });
    expect(workToolBrowserErrorCount(state, status(["tab-1", "tab-2"], "tab-1"))).toBe(3);
    expect(workToolBrowserErrorCount(state, status(["tab-1", "tab-2"], "tab-2"))).toBe(18);
  });

  it("is zero with no status, no tabs, or a clean tab", () => {
    expect(workToolBrowserErrorCount(EMPTY_WORK_TOOL_ERRORS, null)).toBe(0);
    expect(workToolBrowserErrorCount(EMPTY_WORK_TOOL_ERRORS, status([], null))).toBe(0);
    expect(workToolBrowserErrorCount(EMPTY_WORK_TOOL_ERRORS, status(["tab-1"]))).toBe(0);
  });

  it("falls back to the first tab when nothing is marked active", () => {
    const state = reduceWorkToolBrowserErrors(EMPTY_WORK_TOOL_ERRORS, {
      tabId: "tab-1",
      consoleErrorCount: 4,
      failedRequestCount: 0,
    });
    expect(workToolBrowserErrorCount(state, status(["tab-1", "tab-2"], null))).toBe(4);
  });
});

describe("workToolErrorSuffix", () => {
  it("pluralizes and stays empty at zero", () => {
    expect(workToolErrorSuffix(0)).toBe("");
    expect(workToolErrorSuffix(1)).toBe(" · 1 error");
    expect(workToolErrorSuffix(3)).toBe(" · 3 errors");
    expect(workToolErrorSuffix(-2)).toBe("");
    expect(workToolErrorSuffix(Number.NaN)).toBe("");
  });
});
