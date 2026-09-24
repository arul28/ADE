/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../../shared/types";
import type { LaneAgent } from "../laneAgents";
import type { LaneTabPrTag } from "../lanePageModel";
import { LaneSidebarRow, type LaneSidebarRowProps } from "./LaneSidebarRow";

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Router cost ledger",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "refs/heads/ade/router-cost",
    worktreePath: "/tmp/lane-1",
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: "#a78bfa",
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makePr(number: number, state: LaneTabPrTag["state"]): LaneTabPrTag {
  return {
    source: "ade",
    id: `pr-${number}`,
    linkedPrId: `pr-${number}`,
    githubPrNumber: number,
    githubUrl: `https://github.com/acme/ade/pull/${number}`,
    repoOwner: "acme",
    repoName: "ade",
    title: `PR ${number}`,
    state,
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

const waitingAgent: LaneAgent = {
  sessionId: "session-1",
  laneId: "lane-1",
  kind: "chat",
  name: "Ledger",
  modelId: null,
  providerLabel: "Claude",
  activity: "awaiting-input",
  lastHint: "Awaiting your input",
  lastActivityAt: "2026-09-01T00:00:00.000Z",
};

function renderRow(overrides: Partial<LaneSidebarRowProps> = {}) {
  const props: LaneSidebarRowProps = {
    lane: makeLane(),
    depth: 0,
    indentLevel: 0,
    fallbackColorIndex: 0,
    selected: false,
    multiSelected: false,
    pulsing: false,
    runtime: null,
    agents: [],
    prs: undefined,
    rebaseSuggestion: null,
    autoRebaseStatus: null,
    deleteStatusLabel: null,
    creating: false,
    onSelect: vi.fn(),
    onContextMenu: vi.fn(),
    onOpenPr: vi.fn(),
    onOpenAgent: vi.fn(),
    ...overrides,
  };
  render(<LaneSidebarRow {...props} />);
  return props;
}

afterEach(() => cleanup());

describe("LaneSidebarRow", () => {
  it("shows the name, the branch without refs/heads, and selects on click", () => {
    const props = renderRow();
    expect(screen.getByText("Router cost ledger")).toBeTruthy();
    expect(screen.getByText("ade/router-cost")).toBeTruthy();
    fireEvent.click(screen.getByTestId("lane-sidebar-row"));
    expect(props.onSelect).toHaveBeenCalledWith("lane-1", expect.anything());
  });

  it("collapses several PRs into one chip that opens the primary PR", () => {
    const props = renderRow({ prs: [makePr(1301, "open"), makePr(1299, "merged"), makePr(1295, "draft")] });
    const chip = screen.getByTestId("lane-sidebar-pr-chip");
    expect(chip.textContent).toContain("#1301");
    expect(chip.textContent).toContain("+2");
    fireEvent.click(chip);
    expect(props.onOpenPr).toHaveBeenCalledWith(expect.objectContaining({ githubPrNumber: 1301 }));
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("flags a lane whose agent is waiting on the user", () => {
    renderRow({ agents: [waitingAgent] });
    expect(screen.getByTestId("lane-sidebar-agent-status").getAttribute("data-tone")).toBe("attention");
  });

  it("shows the amber needs-you dot with its reason even with no agent", () => {
    renderRow({ needsYouReason: "PR checks are failing" });
    const status = screen.getByTestId("lane-sidebar-agent-status");
    expect(status.getAttribute("data-tone")).toBe("attention");
    expect(status.getAttribute("title")).toContain("PR checks are failing");
  });

  it("shows a parent hint when the row is not under its stack parent", () => {
    renderRow({ parentHint: "Lane Timeline" });
    expect(screen.getByTestId("lane-sidebar-parent-hint").textContent).toBe("↳ Lane Timeline");
  });

  it("tints the PR chip's glyph red when the open PR is failing", () => {
    renderRow({ prs: [{ ...makePr(1301, "open"), checksStatus: "failing" }] });
    const chip = screen.getByTestId("lane-sidebar-pr-chip");
    expect(chip.getAttribute("data-state")).toBe("open");
    expect(chip.getAttribute("data-tone")).toBe("danger");
    expect(screen.getByTestId("lane-sidebar-pr-chip-glyph").style.color).toBe("rgb(248, 113, 113)");
  });

  it("is inert while deleting and shows the delete step instead of metadata", () => {
    const props = renderRow({ deleteStatusLabel: "Removing worktree", prs: [makePr(1, "open")] });
    expect(screen.getByText("Removing worktree")).toBeTruthy();
    expect(screen.queryByTestId("lane-sidebar-pr-chip")).toBeNull();
    fireEvent.click(screen.getByTestId("lane-sidebar-row"));
    fireEvent.contextMenu(screen.getByTestId("lane-sidebar-row"));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onContextMenu).not.toHaveBeenCalled();
  });
});
