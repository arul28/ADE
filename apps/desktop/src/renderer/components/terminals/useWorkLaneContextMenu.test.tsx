/* @vitest-environment jsdom */

import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import type { LaneSummary } from "../../../shared/types";
import { useWorkLaneContextMenu } from "./useWorkLaneContextMenu";

const navigate = vi.fn();
const selectLane = vi.fn();
const setWorkViewState = vi.fn();

let capturedLaneContextMenuProps: Record<string, unknown> | null = null;

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock("../../state/appStore", async () => {
  const actual = await vi.importActual<typeof import("../../state/appStore")>("../../state/appStore");
  return {
    ...actual,
    useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        lanes: [
          {
            id: "lane-remote",
            name: "Remote Lane",
            laneType: "worktree",
            baseRef: "main",
            branchRef: "remote-lane",
            worktreePath: "/tmp/remote-lane",
            parentLaneId: null,
            childCount: 0,
            stackDepth: 0,
            parentStatus: null,
            isEditProtected: false,
            status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
            color: null,
            icon: null,
            tags: [],
            createdAt: "2026-04-22T10:00:00.000Z",
          } satisfies LaneSummary,
        ],
        project: { rootPath: "/local/project" },
        projectBinding: { kind: "remote", rootPath: "/remote/project" },
        selectLane,
        setWorkViewState,
      }),
  };
});

vi.mock("../lanes/LaneContextMenu", () => ({
  LaneContextMenu: (props: Record<string, unknown>) => {
    capturedLaneContextMenuProps = props;
    return null;
  },
}));

afterEach(() => {
  cleanup();
  capturedLaneContextMenuProps = null;
  navigate.mockReset();
  selectLane.mockReset();
  setWorkViewState.mockReset();
});

describe("useWorkLaneContextMenu", () => {
  it("persists start-chat draft state under the active project root for remote projects", () => {
    const { result } = renderHook(() => useWorkLaneContextMenu(), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    });

    act(() => {
      result.current.trigger("lane-remote", {
        preventDefault: vi.fn(),
        clientX: 12,
        clientY: 34,
      });
    });

    render(<>{result.current.menu}</>);

    expect(capturedLaneContextMenuProps).not.toBeNull();
    const onStartChatInLane = capturedLaneContextMenuProps?.onStartChatInLane as (laneId: string) => void;

    act(() => {
      onStartChatInLane("lane-remote");
    });

    expect(setWorkViewState).toHaveBeenCalledWith("/remote/project", expect.any(Function));
    const updater = setWorkViewState.mock.calls[0]?.[1] as (prev: Record<string, unknown>) => Record<string, unknown>;
    expect(updater({ draftKind: "cli", orchestratorEnabled: true, activeItemId: "session-1" })).toMatchObject({
      draftKind: "chat",
      orchestratorEnabled: false,
      draftLaneId: "lane-remote",
      activeItemId: null,
      selectedItemId: null,
    });
    expect(selectLane).toHaveBeenCalledWith("lane-remote");
    expect(navigate).toHaveBeenCalledWith("/work");
  });
});
