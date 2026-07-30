/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import { SUBMENU_OPEN_DELAY_MS } from "../ui/MenuSubmenu";
import { LaneContextMenu } from "./LaneContextMenu";

let isRemoteProject = false;

vi.mock("../../state/appStore", async () => {
  const actual = await vi.importActual<typeof import("../../state/appStore")>("../../state/appStore");
  return {
    ...actual,
    useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ projectBinding: { kind: isRemoteProject ? "remote" : "local" } }),
  };
});

const lane = {
  id: "lane-1",
  name: "Lane One",
  laneType: "worktree",
  baseRef: "main",
  branchRef: "refs/heads/lane-one",
  worktreePath: "/tmp/lane-one",
  parentLaneId: null,
  childCount: 0,
  stackDepth: 0,
  parentStatus: null,
  isEditProtected: false,
  status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
  color: null,
  icon: null,
  tags: [],
  createdAt: "2026-07-10T10:00:00.000Z",
} satisfies LaneSummary;

const writeClipboardText = vi.fn().mockResolvedValue(undefined);
const revealPath = vi.fn().mockResolvedValue(undefined);

function renderLaneMenu(overrides: Partial<Parameters<typeof LaneContextMenu>[0]> = {}) {
  const props = {
    laneContextMenu: { laneId: lane.id, x: 10, y: 10 },
    lanesById: new Map([[lane.id, lane as LaneSummary]]),
    visibleLaneIds: [lane.id],
    onClose: vi.fn(),
    onAdoptAttached: vi.fn(),
    onManage: vi.fn(),
    selectLane: vi.fn(),
    onRemoveFromSplit: vi.fn(),
    onCloseOtherSplits: vi.fn(),
    onSelectAll: vi.fn(),
    onBatchManage: vi.fn(),
    onStartChatInLane: vi.fn(),
    onToggleWorkPin: vi.fn(),
    workPinnedLaneIds: [] as string[],
    ...overrides,
  };
  render(<LaneContextMenu {...props} />);
  return props;
}

function openSubmenu(trigger: Element) {
  fireEvent.pointerOver(trigger);
  act(() => { vi.advanceTimersByTime(SUBMENU_OPEN_DELAY_MS + 10); });
}

beforeEach(() => {
  vi.useFakeTimers();
  isRemoteProject = false;
  (window as unknown as { ade: unknown }).ade = {
    app: { writeClipboardText, revealPath },
    prs: { getForLane: vi.fn().mockResolvedValue(null) },
    github: { getRemoteStatus: vi.fn().mockResolvedValue({ repo: null }) },
    lanes: { updateAppearance: vi.fn().mockResolvedValue(undefined) },
  };
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("LaneContextMenu grouping", () => {
  it("labels its sections and keeps the primary actions on the top level", () => {
    renderLaneMenu();

    for (const label of ["Go to", "Copy", "Tabs", "Color", "Manage"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // The two actions the Work sidebar's singleton row depends on are never
    // buried in a submenu.
    expect(screen.getByRole("menuitem", { name: "Start chat in lane" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Manage Lane" })).toBeTruthy();
  });

  it("keeps every clipboard action reachable behind the Copy submenu", () => {
    const props = renderLaneMenu();

    // Collapsed, not dropped: the four copy rows were the biggest block in the
    // flat menu and the one nobody read.
    expect(screen.queryByRole("menuitem", { name: "Copy Path" })).toBeNull();
    openSubmenu(screen.getByRole("menuitem", { name: "Copy" }));

    for (const name of ["Copy ADE Lane Link", "Copy Branch Link (Cross-Machine)", "Copy Path"]) {
      expect(screen.getByRole("menuitem", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Path" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(writeClipboardText).toHaveBeenCalledWith("/tmp/lane-one");
  });

  it("files a remote project's path copy under Copy and drops the reveal row", () => {
    // Nothing local to reveal on a remote project, so the same button that
    // would reveal becomes the only way to get at the path.
    isRemoteProject = true;
    renderLaneMenu();

    expect(screen.queryByRole("menuitem", { name: /^Reveal in/ })).toBeNull();
    openSubmenu(screen.getByRole("menuitem", { name: "Copy" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Remote Path" }));
    expect(writeClipboardText).toHaveBeenCalledWith("/tmp/lane-one");
    expect(revealPath).not.toHaveBeenCalled();
  });

  it("shows the split rows once the lane is one of several open tabs", () => {
    renderLaneMenu({ visibleLaneIds: [lane.id, "lane-2"] });

    expect(screen.getByText("2 tabs open")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Remove from Split" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Close Other Tabs" })).toBeTruthy();
  });
});
