/* @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PrEventPayload, PrSummary } from "../../../shared/types";
import { clearPrReadInFlightForTest } from "../../lib/prReadCache";
import { useAppStore } from "../../state/appStore";
import { ChatPrPane } from "./ChatPrPane";

const originalAde = globalThis.window.ade;

function buildPr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-333",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 333,
    githubUrl: "https://github.com/arul28/ADE/pull/333",
    githubNodeId: "PR_node333",
    title: "Fix stale PR pane",
    state: "open",
    baseBranch: "main",
    headBranch: "feature/pr-pane",
    checksStatus: "pending",
    reviewStatus: "approved",
    additions: 248,
    deletions: 50,
    lastSyncedAt: null,
    createdAt: "2026-06-29T13:00:00.000Z",
    updatedAt: "2026-06-29T13:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installAdeMocks(stalePr: PrSummary, freshPr: PrSummary) {
  let prEventListener: ((event: PrEventPayload) => void) | null = null;
  globalThis.window.ade = {
    prs: {
      getForLane: vi.fn().mockResolvedValue(stalePr),
      refresh: vi.fn().mockResolvedValue([freshPr]),
      onEvent: vi.fn().mockImplementation((listener) => {
        prEventListener = listener;
        return () => {
          if (prEventListener === listener) prEventListener = null;
        };
      }),
    },
    app: {
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
  } as any;

  return {
    emitPrEvent: (event: PrEventPayload) => {
      prEventListener?.(event);
    },
  };
}

describe("ChatPrPane", () => {
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
    vi.unstubAllGlobals();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("refreshes a linked PR on mount and hides stale running checks once merged", async () => {
    const stalePr = buildPr({ state: "open", checksStatus: "pending" });
    const freshPr = buildPr({
      state: "merged",
      checksStatus: "pending",
      title: "Fix stale PR pane after merge",
      updatedAt: "2026-06-29T14:00:00.000Z",
    });
    const { emitPrEvent } = installAdeMocks(stalePr, freshPr);

    render(
      <MemoryRouter>
        <ChatPrPane laneId="lane-1" branchName="feature/pr-pane" chatModelId="openai/gpt-5" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("MERGED #333")).toBeTruthy();
    expect(screen.getByText("Fix stale PR pane after merge")).toBeTruthy();
    expect(screen.queryByText("Checks running")).toBeNull();

    await waitFor(() => {
      expect(window.ade.prs.refresh).toHaveBeenCalledWith({ prIds: ["pr-333"] });
    });
    expect(window.ade.prs.onEvent).toHaveBeenCalledTimes(1);

    act(() => {
      emitPrEvent({
        type: "prs-updated",
        polledAt: "2026-06-29T14:01:00.000Z",
        prs: [buildPr({ id: "other-pr", laneId: "other-lane", githubPrNumber: 444 })],
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("MERGED #333")).toBeNull();
    });
    expect(window.ade.prs.onEvent).toHaveBeenCalledTimes(1);
  });

  it("ignores stale live refresh results after switching lanes", async () => {
    const laneOnePr = buildPr({
      id: "pr-lane-1",
      laneId: "lane-1",
      githubPrNumber: 111,
      title: "Lane one stale PR",
    });
    const laneOneFreshPr = buildPr({
      ...laneOnePr,
      title: "Lane one refreshed PR",
      updatedAt: "2026-06-29T14:00:00.000Z",
    });
    const laneTwoPr = buildPr({
      id: "pr-lane-2",
      laneId: "lane-2",
      githubPrNumber: 222,
      title: "Lane two PR",
    });
    const laneOneLive = deferred<PrSummary[]>();
    const laneTwoLive = deferred<PrSummary[]>();

    globalThis.window.ade = {
      prs: {
        getForLane: vi.fn(async (requestedLaneId: string) => (requestedLaneId === "lane-1" ? laneOnePr : laneTwoPr)),
        refresh: vi.fn((args?: { prIds?: string[] }) => (
          args?.prIds?.[0] === "pr-lane-1" ? laneOneLive.promise : laneTwoLive.promise
        )),
        onEvent: vi.fn().mockImplementation(() => () => undefined),
      },
      app: {
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    const { rerender } = render(
      <MemoryRouter>
        <ChatPrPane laneId="lane-1" branchName="feature/pr-pane" chatModelId="openai/gpt-5" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Lane one stale PR")).toBeTruthy();

    rerender(
      <MemoryRouter>
        <ChatPrPane laneId="lane-2" branchName="feature/pr-pane-2" chatModelId="openai/gpt-5" />
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
});
