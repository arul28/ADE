/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../../shared/types";
import type { LaneEventsSummary } from "../../../../shared/types/laneEvents";
import type { LaneAgent } from "../laneAgents";
import type { LaneTabPrTag } from "../lanePageModel";

const agentsByLane = vi.hoisted(() => ({ current: new Map<string, LaneAgent[]>() }));

vi.mock("../laneAgents", () => ({
  useLaneAgents: () => agentsByLane.current,
}));

import { LaneStoryList } from "./LaneStoryList";

function buildLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
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
    status: { dirty: false, ahead: 1, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: "#7C3AED",
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function buildSummary(overrides: Partial<LaneEventsSummary> = {}): LaneEventsSummary {
  return {
    laneId: "lane-1",
    eventCount: 3,
    commitCount: 2,
    prCount: 1,
    lastEventTs: "2026-08-01T12:00:00.000Z",
    lastEventKind: "pr_opened",
    spine: [
      { kind: "commit", ts: "2026-08-01T10:00:00.000Z", provider: "claude", actorKind: "agent", ref: "sha1" },
      { kind: "pr_opened", ts: "2026-08-01T12:00:00.000Z", provider: null, actorKind: "human", ref: "pr-1" },
    ],
    tail: null,
    ...overrides,
  };
}

function buildPr(overrides: Partial<LaneTabPrTag> = {}): LaneTabPrTag {
  return {
    source: "ade",
    id: "pr-1",
    linkedPrId: "pr-1",
    githubPrNumber: 1234,
    githubUrl: "https://github.com/acme/repo/pull/1234",
    repoOwner: "acme",
    repoName: "repo",
    title: "Add the lane story",
    state: "open",
    ...overrides,
  } as LaneTabPrTag;
}

const agent: LaneAgent = {
  sessionId: "chat-1",
  laneId: "lane-1",
  kind: "chat",
  name: "Story chat",
  modelId: "claude-opus-5",
  providerLabel: "Claude",
  activity: "working",
  lastHint: "Writing the canvas",
  lastActivityAt: "2026-08-01T12:00:00.000Z",
};

describe("LaneStoryList", () => {
  afterEach(() => {
    cleanup();
    agentsByLane.current = new Map();
  });

  it("renders a row per lane with its agents and PR chips", () => {
    agentsByLane.current = new Map([["lane-1", [agent]]]);
    render(
      <LaneStoryList
        lanes={[buildLane()]}
        summaries={new Map([["lane-1", buildSummary()]])}
        lanePrTagsByLaneId={new Map([["lane-1", [buildPr()]]])}
        selectedLaneId={null}
        humanAvatarUrl={null}
        onOpenLane={vi.fn()}
      />,
    );

    expect(screen.getByText("Story lane")).toBeTruthy();
    expect(screen.getByText("feature/story")).toBeTruthy();
    expect(screen.getByText("Writing the canvas")).toBeTruthy();
    expect(screen.getByText("#1234")).toBeTruthy();
    // The compact spine is drawn from the summary's spine entries.
    expect(screen.getByLabelText("3 events")).toBeTruthy();
  });

  it("opens the lane when its row is clicked", () => {
    const onOpenLane = vi.fn();
    render(
      <LaneStoryList
        lanes={[buildLane()]}
        summaries={new Map()}
        lanePrTagsByLaneId={new Map()}
        selectedLaneId={null}
        humanAvatarUrl={null}
        onOpenLane={onOpenLane}
      />,
    );
    fireEvent.click(screen.getByTestId("lane-story-row-lane-1"));
    expect(onOpenLane).toHaveBeenCalledWith("lane-1");
  });

  it("stays quiet for a lane with no story and no agents", () => {
    render(
      <LaneStoryList
        lanes={[buildLane()]}
        summaries={new Map()}
        lanePrTagsByLaneId={new Map()}
        selectedLaneId={null}
        humanAvatarUrl={null}
        onOpenLane={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("No story yet")).toBeTruthy();
    expect(screen.getByText("no agent")).toBeTruthy();
  });
});
