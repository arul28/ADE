/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../../shared/types";
import type { LaneEvent, LaneEventsListResult } from "../../../../shared/types/laneEvents";

const mockStoreState = vi.hoisted(() => ({
  current: {
    project: { rootPath: "/repo" },
    projectBinding: null as null | { kind: string; rootPath: string; key: string },
    refreshLanes: vi.fn(async () => {}),
    selectLane: vi.fn(),
    setLaneWorkViewState: vi.fn(),
  },
}));

vi.mock("../../../state/appStore", () => ({
  selectActiveProjectRoot: () => "/repo",
  selectActiveProjectStateKey: () => "/repo",
  useAppStore: (selector: (state: unknown) => unknown) => selector(mockStoreState.current),
}));

import { LaneStoryTimeline } from "./LaneStoryTimeline";

function buildLane(): LaneSummary {
  return {
    id: "lane-1",
    name: "Story lane",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/story",
    worktreePath: "/tmp/ade/story",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 2, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: "#7C3AED",
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    archivedAt: null,
  };
}

function commit(id: string, minutes: number): LaneEvent {
  return {
    id,
    laneId: "lane-1",
    kind: "commit",
    ts: new Date(Date.parse("2026-08-01T10:00:00.000Z") + minutes * 60_000).toISOString(),
    actor: { kind: "agent", provider: "claude", model: "Opus 5", chatSessionId: "chat-1", attribution: "session" },
    ref: id,
    branchRef: "feature/story",
    payload: {
      sha: `sha-${id}`,
      shortSha: id,
      subject: `did the thing ${id}`,
      filesChanged: 3,
      insertions: 20,
      deletions: 4,
    },
    derived: false,
  } as LaneEvent;
}

function buildResult(events: LaneEvent[]): LaneEventsListResult {
  return {
    laneId: "lane-1",
    events,
    branches: [{ branchRef: "feature/story", firstTs: events[0]?.ts ?? "", lastTs: events[events.length - 1]?.ts ?? "" }],
    chats: [],
    baseRef: "main",
    hasDerived: false,
    generatedAt: "2026-08-01T13:00:00.000Z",
  };
}

function stubLaneEvents(result: LaneEventsListResult) {
  const list = vi.fn(async () => result);
  (window as unknown as { ade: unknown }).ade = {
    laneEvents: {
      list,
      summary: vi.fn(async () => ({ summaries: [], generatedAt: "" })),
      onChanged: vi.fn(() => () => {}),
    },
    git: { sync: vi.fn(async () => {}), push: vi.fn(async () => {}) },
  };
  return list;
}

function renderTimeline(extra: Partial<React.ComponentProps<typeof LaneStoryTimeline>> = {}) {
  return render(
    <MemoryRouter>
      <LaneStoryTimeline lane={buildLane()} prs={[]} humanAvatarUrl={null} {...extra} />
    </MemoryRouter>,
  );
}

describe("LaneStoryTimeline", () => {
  beforeEach(() => {
    stubLaneEvents(buildResult([commit("aaa1111", 0), commit("bbb2222", 5)]));
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("renders the lane header, git readout and a node per event", async () => {
    renderTimeline();
    await waitFor(() => expect(screen.getByTestId("lane-story-node-aaa1111")).toBeTruthy());
    expect(screen.getByText("Story lane")).toBeTruthy();
    expect(screen.getByText("main ↑2 ↓0")).toBeTruthy();
    expect(screen.getByText("CLEAN")).toBeTruthy();
    expect(screen.getByTestId("lane-story-node-bbb2222")).toBeTruthy();
    expect(screen.getByTestId("lane-story-canvas")).toBeTruthy();
  });

  it("summarises the story deterministically", async () => {
    renderTimeline();
    await waitFor(() => expect(screen.getByText(/2 commits from Claude/)).toBeTruthy());
  });

  it("expands a card in place on click and offers the chat jump", async () => {
    renderTimeline();
    await waitFor(() => expect(screen.getByTestId("lane-story-card-aaa1111")).toBeTruthy());
    expect(screen.queryByText("Jump to chat")).toBeNull();
    fireEvent.click(screen.getByTestId("lane-story-card-aaa1111"));
    expect(screen.getByText("Jump to chat")).toBeTruthy();
    expect(screen.getByText("3 files +20 −4")).toBeTruthy();
  });

  it("hides commits when the Commits filter is switched off", async () => {
    renderTimeline();
    await waitFor(() => expect(screen.getByTestId("lane-story-node-aaa1111")).toBeTruthy());
    fireEvent.click(screen.getByTestId("lane-story-filter-commits"));
    // Every remaining category is empty, so the canvas falls back to the quiet state.
    expect(screen.queryByTestId("lane-story-node-aaa1111")).toBeNull();
  });

  it("opens the existing Git Actions pane in a sheet", async () => {
    const renderGitActions = vi.fn(() => <div data-testid="git-actions-mock" />);
    renderTimeline({ renderGitActions });
    await waitFor(() => expect(screen.getByTestId("lane-story-node-aaa1111")).toBeTruthy());
    expect(screen.queryByTestId("lane-story-git-sheet")).toBeNull();
    fireEvent.click(screen.getByTestId("lane-story-git-sheet-toggle"));
    expect(screen.getByTestId("lane-story-git-sheet")).toBeTruthy();
    expect(renderGitActions).toHaveBeenCalledWith("lane-1");
  });

  it("shows the quiet empty state when the lane has no story", async () => {
    stubLaneEvents(buildResult([]));
    renderTimeline();
    await waitFor(() => expect(
      screen.getByText("No story yet — actions in this lane will appear here."),
    ).toBeTruthy());
  });
});
