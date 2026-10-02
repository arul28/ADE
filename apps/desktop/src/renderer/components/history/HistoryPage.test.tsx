/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TimelineStoreApi } from "./useTimelineStore";

// Capture the per-page timeline store so the test can call the same action the
// lane picker calls (`setFocusLane`) without driving a Radix menu.
const captured = vi.hoisted(() => ({
  store: null as TimelineStoreApi | null,
}));

// react-resizable-panels needs a real layout engine; jsdom gets plain divs.
vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
  Panel: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
  Separator: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
}));

vi.mock("./useTimelineStore", async (importOriginal) => {
  const actual = await importOriginal() as {
    createTimelineStore: () => TimelineStoreApi;
  } & Record<string, unknown>;
  return {
    ...actual,
    createTimelineStore: () => {
      captured.store = actual.createTimelineStore();
      return captured.store;
    },
  };
});

import { HistoryPage } from "./HistoryPage";
import { useCommitViewPrefs } from "./commitViewPrefs";
import { useAppStore } from "../../state/appStore";
import type { GitCommitListScope, GitCommitSummary, LaneStatus, LaneSummary } from "../../../shared/types";

const status: LaneStatus = {
  dirty: false,
  ahead: 0,
  behind: 0,
  remoteBehind: 0,
  rebaseInProgress: false,
};

function lane(id: string, name: string): LaneSummary {
  return {
    id,
    name,
    laneType: "worktree",
    baseRef: "main",
    branchRef: `ade/${id}`,
    worktreePath: `/tmp/${id}`,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status,
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    archivedAt: null,
    lastCommitAt: "2026-01-01T00:00:00Z",
  };
}

function commit(sha: string, parents: string[] = []): GitCommitSummary {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents,
    authorName: "Ada",
    authoredAt: "2026-01-01T00:00:00Z",
    subject: `commit ${sha}`,
    pushed: true,
  };
}

function LocationProbe({ onSearch }: { onSearch: (search: string) => void }) {
  const location = useLocation();
  React.useEffect(() => {
    onSearch(location.search);
  }, [location.search, onSearch]);
  return null;
}

describe("HistoryPage lane/URL sync", () => {
  beforeEach(() => {
    captured.store = null;
    useCommitViewPrefs.setState({ scope: "lane", fold: "all", search: "" });
    (window as any).ade = {
      git: {
        listRecentCommits: vi.fn(async () => []),
        listBranches: vi.fn(async () => []),
        getOriginRemote: vi.fn(async () => ({ remoteUrl: null })),
        getOpenPrForBranch: vi.fn(async () => null),
        getCommitMessage: vi.fn(async () => ""),
        listCommitFiles: vi.fn(async () => []),
      },
      history: { listOperations: vi.fn(async () => []) },
      app: { writeClipboardText: vi.fn(async () => {}) },
      layout: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
    };
    useAppStore.setState({
      lanes: [lane("lane-a", "Lane A"), lane("lane-b", "Lane B")],
      selectedLaneId: "lane-a",
      projectBinding: null,
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("keeps a lane pick when History opened from a URL that carried laneId", async () => {
    let search = "";
    render(
      <MemoryRouter initialEntries={["/history?surface=commits&laneId=lane-a"]}>
        <LocationProbe onSearch={(value) => { search = value; }} />
        <HistoryPage />
      </MemoryRouter>,
    );

    // The URL lane is hydrated into the store first.
    await waitFor(() => expect(captured.store?.getState().focusLaneId).toBe("lane-a"));

    // The picker's action: switch to lane B.
    await act(async () => {
      captured.store!.getState().setFocusLane("lane-b", null);
    });

    // The pick must survive the URL hydration effect and be written to the URL.
    await waitFor(() => {
      expect(captured.store?.getState().focusLaneId).toBe("lane-b");
      expect(new URLSearchParams(search).get("laneId")).toBe("lane-b");
    });
  });

  it("shows the lane picked in the lane list beside it, and moves that list with its own picks", async () => {
    let search = "";
    render(
      <MemoryRouter initialEntries={["/history?surface=commits&laneId=lane-a"]}>
        <LocationProbe onSearch={(value) => { search = value; }} />
        <HistoryPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(captured.store?.getState().focusLaneId).toBe("lane-a"));

    // A click in the Lanes or Work sidebar held beside History.
    await act(async () => {
      useAppStore.getState().selectLane("lane-b");
    });
    await waitFor(() => {
      expect(captured.store?.getState().focusLaneId).toBe("lane-b");
      expect(new URLSearchParams(search).get("laneId")).toBe("lane-b");
    });

    // History's own lane picker: the list follows.
    await act(async () => {
      captured.store!.getState().setFocusLane("lane-a", null);
    });
    await waitFor(() => {
      expect(useAppStore.getState().selectedLaneId).toBe("lane-a");
      expect(new URLSearchParams(search).get("laneId")).toBe("lane-a");
    });
  });

  it.each([
    { name: "replaces a selection All lanes does not show with its newest commit", allLanes: ["x2", "c3", "x1"], expected: "x2" },
    { name: "keeps a selection All lanes still shows", allLanes: ["x2", "c3", "c1"], expected: "c1" },
  ])("$name", async ({ allLanes, expected }) => {
    const byScope: Record<GitCommitListScope, GitCommitSummary[]> = {
      lane: [commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1")],
      lanes: allLanes.map((sha) => commit(sha)),
    };
    (window as any).ade.git.listRecentCommits = vi.fn(async (args: { scope?: GitCommitListScope; skip?: number }) =>
      (args.skip ?? 0) > 0 ? [] : byScope[args.scope ?? "lane"]);
    render(
      <MemoryRouter initialEntries={["/history?surface=commits&laneId=lane-a"]}>
        <HistoryPage />
      </MemoryRouter>,
    );
    // Arriving on the lane opens its newest commit; then an older one is picked.
    await waitFor(() => expect(captured.store?.getState().selectedCommitSha).toBe("c3"));
    await act(async () => {
      captured.store!.getState().setSelectedCommit(byScope.lane[2]!);
    });

    await act(async () => {
      useCommitViewPrefs.getState().setScope("lanes");
    });

    await waitFor(() => expect(captured.store?.getState().selectedCommitSha).toBe(expected));
  });
});
