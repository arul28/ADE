/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

// Render framer-motion elements as plain DOM so assertions don't depend on
// animation timing / requestAnimationFrame in jsdom.
vi.mock("framer-motion", () => {
  const React = require("react");
  const strip = (props: Record<string, unknown>) => {
    const { initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...rest } = props;
    return rest;
  };
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
          const { children, ...rest } = strip(props);
          return React.createElement(tag, { ...rest, ref }, children as React.ReactNode);
        }),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

import {
  ChatPrPane,
  chatPrSignature,
  detectChatPrDelta,
  type ChatPrSignature,
} from "./ChatPrPane";
import type { PrCheck, PrEventPayload, PrReview, PrStatus, PrSummary } from "../../../shared/types";
import { clearPrReadInFlightForTest } from "../../lib/prReadCache";
import { useAppStore } from "../../state/appStore";

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
    title: "Add webhook relay for PR sync",
    state: "open",
    baseBranch: "main",
    headBranch: "feat",
    checksStatus: "none",
    reviewStatus: "none",
    additions: 420,
    deletions: 38,
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

const sig = (over: Partial<ChatPrSignature> = {}): ChatPrSignature => ({
  exists: true,
  state: "open",
  headSha: "aaa111",
  ...over,
});

const originalAde = (globalThis.window as { ade?: unknown }).ade;

function installAde(over?: {
  getForLane?: unknown;
  refresh?: unknown;
  getChecks?: PrCheck[];
  getReviews?: PrReview[];
  getStatus?: PrStatus | null;
  relayConfigured?: boolean;
  webhookState?: string;
}) {
  (globalThis.window as { ade?: unknown }).ade = {
    prs: {
      getForLane: over?.getForLane ?? vi.fn().mockResolvedValue(makePr()),
      refresh: over?.refresh ?? vi.fn().mockResolvedValue([makePr()]),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
      getChecks: vi.fn().mockResolvedValue(over?.getChecks ?? []),
      getReviews: vi.fn().mockResolvedValue(over?.getReviews ?? []),
      getStatus: vi.fn().mockResolvedValue(over?.getStatus ?? null),
      syncLanePr: vi.fn().mockResolvedValue(null),
    },
    github: {
      getAppInstallationStatus: vi.fn().mockResolvedValue({
        relayConfigured: over?.relayConfigured ?? true,
        webhookState: over?.webhookState ?? "active",
      }),
    },
    app: { openExternal: vi.fn().mockResolvedValue(undefined) },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installAdeWithEvents(stalePr: PrSummary, freshPr: PrSummary) {
  // The pane keeps TWO subscriptions (PR rows + reconcile-on-focus), so the
  // harness must fan out to every registered listener, not just the last one.
  const prEventListeners = new Set<(event: PrEventPayload) => void>();
  (globalThis.window as { ade?: unknown }).ade = {
    prs: {
      getForLane: vi.fn().mockResolvedValue(stalePr),
      refresh: vi.fn().mockResolvedValue([freshPr]),
      onEvent: vi.fn().mockImplementation((listener) => {
        prEventListeners.add(listener);
        return () => {
          prEventListeners.delete(listener);
        };
      }),
      getChecks: vi.fn().mockResolvedValue([]),
      getReviews: vi.fn().mockResolvedValue([]),
      getStatus: vi.fn().mockResolvedValue(null),
      syncLanePr: vi.fn().mockResolvedValue(null),
    },
    github: {
      getAppInstallationStatus: vi.fn().mockResolvedValue({
        relayConfigured: true,
        webhookState: "active",
      }),
    },
    app: { openExternal: vi.fn().mockResolvedValue(undefined) },
  };

  return {
    emitPrEvent: (event: PrEventPayload) => {
      for (const listener of [...prEventListeners]) listener(event);
    },
  };
}

function renderPane(props: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <ChatPrPane laneId="lane1" {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearPrReadInFlightForTest();
  useAppStore.setState({
    project: { rootPath: "/Users/admin/Projects/ADE", displayName: "ADE" } as any,
    projectBinding: {
      kind: "local",
      key: "local:/Users/admin/Projects/ADE",
      rootPath: "/Users/admin/Projects/ADE",
      displayName: "ADE",
    } as any,
  });
});

afterEach(() => {
  cleanup();
  clearPrReadInFlightForTest();
  (globalThis.window as { ade?: unknown }).ade = originalAde;
  vi.clearAllMocks();
});

describe("detectChatPrDelta", () => {
  it("pops for a newly created / first-linked PR", () => {
    expect(detectChatPrDelta(sig({ exists: false, state: null, headSha: null }), makePr())?.kind).toBe("created");
  });

  it("pops for lifecycle transitions", () => {
    expect(detectChatPrDelta(sig(), makePr({ state: "merged" }))?.kind).toBe("merged");
    expect(detectChatPrDelta(sig(), makePr({ state: "closed" }))?.kind).toBe("closed");
    expect(detectChatPrDelta(sig({ state: "draft" }), makePr({ state: "open" }))?.kind).toBe("ready");
    expect(detectChatPrDelta(sig({ state: "closed" }), makePr({ state: "open" }))?.kind).toBe("reopened");
    expect(detectChatPrDelta(sig(), makePr({ state: "draft" }))?.kind).toBe("draft");
  });

  it("pops for a new commit (head sha change)", () => {
    expect(detectChatPrDelta(sig({ headSha: "aaa111" }), makePr({ headSha: "bbb222" }))?.kind).toBe("commit");
  });

  it("does NOT pop for checks/review-only changes", () => {
    // Same state + same head sha, only checks/review changed.
    const next = makePr({ checksStatus: "failing", reviewStatus: "changes_requested" });
    expect(detectChatPrDelta(sig(), next)).toBeNull();
  });

  it("does NOT pop when the PR was unlinked / removed", () => {
    expect(detectChatPrDelta(sig(), null)).toBeNull();
  });
});

describe("chatPrSignature", () => {
  it("captures existence, state, and head sha", () => {
    expect(chatPrSignature(makePr({ state: "merged", headSha: "zzz" }))).toEqual({
      exists: true,
      state: "merged",
      headSha: "zzz",
    });
    expect(chatPrSignature(null)).toEqual({ exists: false, state: null, headSha: null });
  });
});

describe("ChatPrPane", () => {
  it("refreshes a linked PR on mount and hides stale running checks once merged", async () => {
    const stalePr = makePr({
      id: "pr-333",
      laneId: "lane-1",
      githubPrNumber: 333,
      title: "Fix stale PR pane",
      state: "open",
      checksStatus: "pending",
    });
    const freshPr = makePr({
      ...stalePr,
      state: "merged",
      checksStatus: "pending",
      title: "Fix stale PR pane after merge",
      updatedAt: "2026-06-29T14:00:00.000Z",
    });
    const { emitPrEvent } = installAdeWithEvents(stalePr, freshPr);

    render(
      <MemoryRouter>
        <ChatPrPane laneId="lane-1" branchName="feature/pr-pane" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Merged")).toBeTruthy();
    expect(screen.getByText("Fix stale PR pane after merge")).toBeTruthy();
    expect(screen.queryByText("Checks running")).toBeNull();

    await waitFor(() => {
      expect((window.ade.prs.refresh as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ prIds: ["pr-333"] }, null);
    });
    // Exactly two stable subscriptions: PR rows + reconcile-on-focus. Neither
    // may be torn down and re-created as PR state changes.
    expect(window.ade.prs.onEvent).toHaveBeenCalledTimes(2);

    act(() => {
      emitPrEvent({
        type: "prs-updated",
        polledAt: "2026-06-29T14:01:00.000Z",
        prs: [makePr({ id: "other-pr", laneId: "other-lane", githubPrNumber: 444 })],
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Fix stale PR pane after merge")).toBeNull();
    });
    // Exactly two stable subscriptions: PR rows + reconcile-on-focus. Neither
    // may be torn down and re-created as PR state changes.
    expect(window.ade.prs.onEvent).toHaveBeenCalledTimes(2);
  });

  it("renders a projection-only PR without calling row-based refresh or enrichment APIs", async () => {
    const projectedPr = makePr({
      id: "gh:o/r#404",
      unmapped: true,
      githubPrNumber: 404,
      title: "Externally opened PR",
      updatedAt: "2026-07-16T12:00:00.000Z",
    });
    const refresh = vi.fn().mockResolvedValue([]);
    installAde({
      getForLane: vi.fn().mockResolvedValue(projectedPr),
      refresh,
    });

    renderPane();

    expect(await screen.findByText("Externally opened PR")).toBeTruthy();
    expect(screen.getByText("PR #404")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    expect(window.ade.prs.getChecks).not.toHaveBeenCalled();
    expect(window.ade.prs.getReviews).not.toHaveBeenCalled();
    expect(window.ade.prs.getStatus).not.toHaveBeenCalled();
  });

  it("explains GitHub stack position instead of showing ADE merge readiness", async () => {
    const stackedPr = makePr({
      stack: {
        id: "stack-18",
        number: 18,
        size: 3,
        position: 2,
        baseBranch: "main",
      },
    });
    installAde({
      getForLane: vi.fn().mockResolvedValue(stackedPr),
      refresh: vi.fn().mockResolvedValue([stackedPr]),
      getStatus: {
        prId: stackedPr.id,
        state: "open",
        checksStatus: "passing",
        reviewStatus: "approved",
        isMergeable: true,
        mergeStateStatus: "clean",
      } as PrStatus,
    });

    renderPane();

    expect(await screen.findByLabelText("GitHub Stack 2 of 3")).toBeTruthy();
    expect(screen.getByText(/Review rebases and merge the stack on GitHub/)).toBeTruthy();
    expect(screen.queryByText("Ready to merge")).toBeNull();
  });

  it("ignores stale live refresh results after switching lanes", async () => {
    const laneOnePr = makePr({
      id: "pr-lane-1",
      laneId: "lane-1",
      githubPrNumber: 111,
      title: "Lane one stale PR",
    });
    const laneOneFreshPr = makePr({
      ...laneOnePr,
      title: "Lane one refreshed PR",
      updatedAt: "2026-06-29T14:00:00.000Z",
    });
    const laneTwoPr = makePr({
      id: "pr-lane-2",
      laneId: "lane-2",
      githubPrNumber: 222,
      title: "Lane two PR",
    });
    const laneOneLive = deferred<PrSummary[]>();
    const laneTwoLive = deferred<PrSummary[]>();

    installAde({
      getForLane: vi.fn(async (requestedLaneId: string) => (requestedLaneId === "lane-1" ? laneOnePr : laneTwoPr)),
      refresh: vi.fn((args?: { prIds?: string[] }) => (
        args?.prIds?.[0] === "pr-lane-1" ? laneOneLive.promise : laneTwoLive.promise
      )),
    });

    const { rerender } = render(
      <MemoryRouter>
        <ChatPrPane laneId="lane-1" branchName="feature/pr-pane" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Lane one stale PR")).toBeTruthy();

    rerender(
      <MemoryRouter>
        <ChatPrPane laneId="lane-2" branchName="feature/pr-pane-2" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Lane two PR")).toBeTruthy();

    await act(async () => {
      laneOneLive.resolve([laneOneFreshPr]);
      await laneOneLive.promise;
    });

    expect(screen.getByText("Lane two PR")).toBeTruthy();
    expect(screen.queryByText("Lane one refreshed PR")).toBeNull();

    await act(async () => {
      laneTwoLive.resolve([laneTwoPr]);
      await laneTwoLive.promise;
    });
  });

  it("renders the linked PR's state, title, and diff", async () => {
    installAde();
    renderPane();
    expect(await screen.findByText("Add webhook relay for PR sync")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("+420")).toBeTruthy();
    expect(screen.getByText("−38")).toBeTruthy();
  });

  it("shows the delta line describing what just changed", async () => {
    installAde();
    renderPane({ delta: { kind: "merged", label: "Merged", tone: "good", nonce: 1 } });
    // Title still says the PR is open; "Merged" here is the delta line.
    expect(await screen.findByText("Merged")).toBeTruthy();
    expect(screen.getByText("just now")).toBeTruthy();
  });

  it("renders enriched check counts from getChecks", async () => {
    installAde({
      getChecks: [
        { name: "build", status: "completed", conclusion: "failure", detailsUrl: null, startedAt: null, completedAt: null },
        { name: "test", status: "completed", conclusion: "success", detailsUrl: null, startedAt: null, completedAt: null },
      ],
    });
    renderPane();
    expect(await screen.findByText("1/2 checks failing")).toBeTruthy();
  });

  it("shows the reviewer next to an approved review", async () => {
    installAde({
      getReviews: [
        { reviewer: "arul", reviewerAvatarUrl: null, state: "approved", body: null, submittedAt: null },
      ],
    });
    renderPane();
    expect(await screen.findByText("Approved")).toBeTruthy();
    expect(await screen.findByText("· arul")).toBeTruthy();
  });

  it("surfaces a 'Ready to merge' state when everything is green", async () => {
    installAde({
      getStatus: {
        prId: "pr1",
        state: "open",
        checksStatus: "passing",
        reviewStatus: "approved",
        isMergeable: true,
        mergeConflicts: false,
        behindBaseBy: 0,
        reviewDecision: "approved",
      },
    });
    renderPane();
    expect(await screen.findByText("Ready to merge")).toBeTruthy();
  });

  it("falls back to a 'polling' dot when the webhook relay is not connected", async () => {
    installAde({ relayConfigured: false });
    renderPane();
    expect(await screen.findByText("polling")).toBeTruthy();
  });
});

describe("ChatPrPane title bar", () => {
  it("syncs the lane PR then re-reads it when ↻ is pressed", async () => {
    installAde();
    renderPane();

    await screen.findByText("Add webhook relay for PR sync");
    const readsBefore = (window.ade.prs.getForLane as ReturnType<typeof vi.fn>).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh pull request" }));

    await waitFor(() => {
      expect(window.ade.prs.syncLanePr).toHaveBeenCalledWith("lane1", null);
    });
    await waitFor(() => {
      expect((window.ade.prs.getForLane as ReturnType<typeof vi.fn>).mock.calls.length)
        .toBeGreaterThan(readsBefore);
    });
  });

  it("spins ↻ while a backend reconcile runs and stops after the hide debounce", async () => {
    vi.useFakeTimers();
    try {
      const pr = makePr({ id: "pr-reconcile", title: "Reconcile me" });
      const { emitPrEvent } = installAdeWithEvents(pr, pr);
      renderPane();
      await act(async () => { await Promise.resolve(); });

      const icon = () => screen.getByRole("button", { name: "Refresh pull request" }).querySelector("svg");
      expect(icon()?.getAttribute("class") ?? "").not.toContain("animate-spin");

      act(() => {
        emitPrEvent({ type: "pr-reconcile", state: "running", polledAt: "2026-07-27T00:00:00.000Z" });
      });
      expect(icon()?.getAttribute("class") ?? "").toContain("animate-spin");

      act(() => {
        emitPrEvent({ type: "pr-reconcile", state: "idle", polledAt: "2026-07-27T00:00:01.000Z" });
      });
      // Still spinning inside the 300ms anti-flicker debounce.
      expect(icon()?.getAttribute("class") ?? "").toContain("animate-spin");

      act(() => { vi.advanceTimersByTime(400); });
      expect(icon()?.getAttribute("class") ?? "").not.toContain("animate-spin");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not strand the reconcile hide timer when the pane unmounts mid-debounce", async () => {
    vi.useFakeTimers();
    try {
      const pr = makePr({ id: "pr-reconcile-unmount" });
      const { emitPrEvent } = installAdeWithEvents(pr, pr);
      const { unmount } = renderPane();
      await act(async () => { await Promise.resolve(); });

      act(() => {
        emitPrEvent({ type: "pr-reconcile", state: "running", polledAt: "2026-07-27T00:00:00.000Z" });
        emitPrEvent({ type: "pr-reconcile", state: "idle", polledAt: "2026-07-27T00:00:01.000Z" });
      });

      const clearSpy = vi.spyOn(window, "clearTimeout");
      unmount();
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();

      // The pending hide must not fire into an unmounted tree.
      act(() => { vi.advanceTimersByTime(400); });
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls onClose from the ✕ button", async () => {
    installAde();
    const onClose = vi.fn();
    renderPane({ onClose });

    fireEvent.click(await screen.findByRole("button", { name: "Close pull request panel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
