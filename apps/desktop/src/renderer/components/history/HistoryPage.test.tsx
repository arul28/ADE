/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import type { GitBranchSummary, GitCommitListScope, GitCommitSummary, LaneStatus, LaneSummary } from "../../../shared/types";

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

  it.each([
    { name: "another lane's commit names that lane", sha: "b2", lane: "Lane B" },
    { name: "a base commit names no lane", sha: "m1", lane: null },
  ])("All lanes, deep link: $name", async ({ sha, lane }) => {
    useCommitViewPrefs.setState({ scope: "lanes" });
    const rows = [commit("b2", ["b1"]), commit("b1", ["m1"]), commit("a1", ["m1"]), commit("m1")];
    const branch = (name: string, tip: string, isCurrent = false): GitBranchSummary => ({
      name, isCurrent, isRemote: false, upstream: null, lastCommitSha: tip,
    });
    (window as any).ade.git.listRecentCommits = vi.fn(async (args: { skip?: number }) => ((args.skip ?? 0) > 0 ? [] : rows));
    (window as any).ade.git.listBranches = vi.fn(async () => [
      branch("ade/lane-a", "a1", true),
      branch("ade/lane-b", "b2"),
      branch("main", "m1"),
    ]);
    render(
      <MemoryRouter initialEntries={[`/history?surface=commits&laneId=lane-a&commitSha=${sha}`]}>
        <HistoryPage />
      </MemoryRouter>,
    );

    await screen.findByTestId("commit-detail");
    await waitFor(() => expect((window as any).ade.git.listBranches).toHaveBeenCalled());
    await waitFor(() => {
      const detail = within(screen.getByTestId("commit-detail"));
      const named = ["Lane A", "Lane B"].filter((name) => detail.queryAllByText(name).length > 0);
      expect(named).toEqual(lane ? [lane] : []);
    });
  });

  it("reads a lane's operations once, then fresh after a git action, not per commit click", async () => {
    const listOperations = vi.fn(async (_args?: { laneId?: string; limit?: number }) => []);
    (window as any).ade.history.listOperations = listOperations;
    (window as any).ade.git.fetch = vi.fn(async () => ({}));
    (window as any).ade.git.listRecentCommits = vi.fn(async (args: { laneId?: string; skip?: number }) =>
      (args.skip ?? 0) > 0 ? [] : [commit("c1"), commit("c2")]);
    render(
      <MemoryRouter initialEntries={["/history?surface=commits&laneId=lane-a&commitSha=c1"]}>
        <HistoryPage />
      </MemoryRouter>,
    );

    // The commit's lane operations load once when its details open.
    await waitFor(() => expect(listOperations).toHaveBeenCalledTimes(1));
    expect(listOperations.mock.calls[0]?.[0]).toMatchObject({ laneId: "lane-a", limit: 500 });

    // Another commit in the same lane within the 15 s window does not re-read.
    await act(async () => {
      captured.store!.getState().setSelectedCommit(commit("c2"));
    });
    expect(listOperations).toHaveBeenCalledTimes(1);

    // A git action on the lane must force a fresh read.
    fireEvent.click(screen.getByTestId("history-fetch"));
    await waitFor(() => expect(listOperations).toHaveBeenCalledTimes(2));
  });
});
