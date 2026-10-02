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
import { useAppStore } from "../../state/appStore";
import type { LaneStatus, LaneSummary } from "../../../shared/types";

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
    (window as any).ade = {
      git: {
        listRecentCommits: vi.fn(async () => []),
        listBranches: vi.fn(async () => []),
        getOriginRemote: vi.fn(async () => ({ remoteUrl: null })),
        getOpenPrForBranch: vi.fn(async () => null),
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
});
