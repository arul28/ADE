/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import type { LaneSummary } from "../../../shared/types";
import { useWorkLaneContextMenu } from "./useWorkLaneContextMenu";

const navigate = vi.fn();
const selectLane = vi.fn();
const setWorkViewState = vi.fn();
const switchRemoteProject = vi.fn().mockResolvedValue(undefined);
const switchProjectToPath = vi.fn().mockResolvedValue(undefined);

let capturedLaneContextMenuProps: Record<string, unknown> | null = null;
let capturedManageLaneHostProps: Record<string, unknown> | null = null;

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
        projectBinding: {
          kind: "remote",
          key: "/remote/project",
          rootPath: "/remote/project",
        },
        selectLane,
        setWorkViewState,
        switchRemoteProject,
        switchProjectToPath,
      }),
  };
});

vi.mock("../lanes/LaneContextMenu", () => ({
  LaneContextMenu: (props: Record<string, unknown>) => {
    capturedLaneContextMenuProps = props;
    return null;
  },
  HoverButton: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
  }) => <button role="menuitem" disabled={disabled} onClick={onClick}>{children}</button>,
  menuItemStyle: {},
}));

vi.mock("./WorkManageLaneDialogHost", () => ({
  WorkManageLaneDialogHost: (props: Record<string, unknown>) => {
    capturedManageLaneHostProps = props;
    return props.laneId ? <div data-testid="work-manage-lane-dialog" /> : null;
  },
}));

afterEach(() => {
  cleanup();
  capturedLaneContextMenuProps = null;
  capturedManageLaneHostProps = null;
  navigate.mockReset();
  selectLane.mockReset();
  setWorkViewState.mockReset();
  switchRemoteProject.mockReset();
  switchProjectToPath.mockReset();
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

  it("starts a foreign lane draft with its owning machine", () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { app: { writeClipboardText } },
    });
    const lane = {
      id: "lane-remote",
      name: "Remote Lane",
      laneType: "worktree",
      branchRef: "refs/heads/remote-lane",
      worktreePath: "/Users/studio/ADE/.ade/worktrees/remote-lane",
      linearIssue: null,
    } as LaneSummary;
    const binding = {
      kind: "remote" as const,
      key: "remote:studio:ade",
      targetId: "studio",
      projectId: "ade",
      rootPath: "/Users/studio/ADE",
      displayName: "ADE",
      runtimeName: "Studio",
      hostname: "studio.local",
    };
    const { result } = renderHook(() => useWorkLaneContextMenu(), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    });

    act(() => {
      result.current.triggerForeign(lane, binding, "Studio", true, {
        preventDefault: vi.fn(),
        clientX: 12,
        clientY: 34,
      });
    });
    render(<>{result.current.menu}</>);
    fireEvent.click(screen.getByRole("menuitem", { name: "Start chat in lane" }));

    expect(setWorkViewState).toHaveBeenCalledWith("/remote/project", expect.any(Function));
    const updater = setWorkViewState.mock.calls[0]?.[1] as (
      previous: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(updater({})).toMatchObject({
      draftKind: "chat",
      draftLaneId: "lane-remote",
      draftMachineId: "studio",
      activeItemId: null,
      selectedItemId: null,
    });
  });

  it("opens foreign lane management with the owning runtime without rebinding the tab", () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { app: { writeClipboardText: vi.fn().mockResolvedValue(undefined) } },
    });
    const lane = {
      id: "lane-studio",
      name: "Studio Lane",
      laneType: "worktree",
      branchRef: "refs/heads/studio-lane",
      worktreePath: "/Users/studio/ADE/.ade/worktrees/studio-lane",
    } as LaneSummary;
    const binding = {
      kind: "remote" as const,
      key: "remote:studio:ade",
      targetId: "studio",
      projectId: "ade",
      rootPath: "/Users/studio/ADE",
      displayName: "ADE",
      runtimeName: "Studio",
      hostname: "studio.local",
    };
    const { result } = renderHook(() => useWorkLaneContextMenu(), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    });

    act(() => {
      result.current.triggerForeign(lane, binding, "Studio", true, {
        preventDefault: vi.fn(),
        clientX: 12,
        clientY: 34,
      });
    });
    const view = render(<>{result.current.menu}</>);
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage lane" }));
    view.rerender(<>{result.current.menu}</>);

    expect(capturedManageLaneHostProps).toMatchObject({
      laneId: "lane-studio",
      lane,
      runtimePin: binding,
    });
    expect(view.getByTestId("work-manage-lane-dialog")).toBeTruthy();
    expect(switchRemoteProject).not.toHaveBeenCalled();
    expect(switchProjectToPath).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("disables foreign lane management while its machine is offline", () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { app: { writeClipboardText: vi.fn().mockResolvedValue(undefined) } },
    });
    const lane = {
      id: "lane-studio",
      name: "Studio Lane",
      laneType: "worktree",
      branchRef: "refs/heads/studio-lane",
    } as LaneSummary;
    const binding = {
      kind: "remote" as const,
      key: "remote:studio:ade",
      targetId: "studio",
      projectId: "ade",
      rootPath: "/Users/studio/ADE",
      displayName: "ADE",
      runtimeName: "Studio",
      hostname: "studio.local",
    };
    const { result } = renderHook(() => useWorkLaneContextMenu(), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    });

    act(() => {
      result.current.triggerForeign(lane, binding, "Studio", false, {
        preventDefault: vi.fn(),
        clientX: 12,
        clientY: 34,
      });
    });
    render(<>{result.current.menu}</>);

    expect((screen.getByRole("menuitem", { name: "Manage lane" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens lane management in Work without navigating to the Lanes tab", () => {
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
    const view = render(<>{result.current.menu}</>);
    const onManage = capturedLaneContextMenuProps?.onManage as (laneId: string) => void;

    act(() => onManage("lane-remote"));
    view.rerender(<>{result.current.menu}</>);

    expect(capturedManageLaneHostProps?.laneId).toBe("lane-remote");
    expect(view.getByTestId("work-manage-lane-dialog")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});
