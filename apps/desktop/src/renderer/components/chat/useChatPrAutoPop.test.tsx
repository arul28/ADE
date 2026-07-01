/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useChatPrAutoPop } from "./useChatPrAutoPop";
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

afterEach(() => {
  (globalThis.window as { ade?: unknown }).ade = originalAde;
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
