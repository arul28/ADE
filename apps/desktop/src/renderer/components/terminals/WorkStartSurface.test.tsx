/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../state/appStore";
import { WorkStartSurface } from "./WorkStartSurface";

const selectLane = vi.fn();
const crossMachineState = vi.hoisted(() => ({
  lanesByMachine: {} as AppState["crossMachineLanesByMachineId"],
}));
const agentChatPaneProps = vi.hoisted(() => ({
  latest: null as null | {
    laneId: string | null;
    laneLabel?: string;
    workDraftKind?: "chat" | "cli";
    orchestratorEnabled?: boolean;
    draftContextTargetId?: string | null;
    onOpenShellSession?: (laneId: string, pin?: unknown) => void | Promise<void>;
    onLaunchCliSession?: unknown;
    suppressDraftLaunchNavigation?: boolean;
    initialDraftMachineId?: string | null;
  },
}));

vi.mock("../../state/appStore", () => ({
  useAppStore: <T,>(selector: (state: AppState) => T): T =>
    selector({ selectedLaneId: null, selectLane, lanesLoading: false } as unknown as AppState),
  useRootAppStore: <T,>(selector: (state: AppState) => T): T =>
    selector({
      crossMachineLanesByMachineId: crossMachineState.lanesByMachine,
    } as unknown as AppState),
}));

vi.mock("../chat/AgentChatPane", () => ({
  AgentChatPane: (props: {
    laneId: string | null;
    laneLabel?: string;
    workDraftKind?: "chat" | "cli";
    orchestratorEnabled?: boolean;
    draftContextTargetId?: string | null;
    onOpenShellSession?: (laneId: string, pin?: unknown) => void | Promise<void>;
    onLaunchCliSession?: unknown;
    suppressDraftLaunchNavigation?: boolean;
    initialDraftMachineId?: string | null;
  }) => {
    agentChatPaneProps.latest = props;
    return (
      <div data-testid="agent-chat-pane" data-work-draft-kind={props.workDraftKind}>
        <button type="button" onClick={() => props.laneId && props.onOpenShellSession?.(props.laneId)}>
          mock shell
        </button>
      </div>
    );
  },
}));

describe("WorkStartSurface", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    agentChatPaneProps.latest = null;
    crossMachineState.lanesByMachine = {};
  });

  it("renders the no-lanes state", () => {
    render(
      <WorkStartSurface
        draftKind="chat"
        lanes={[]}
        onOpenChatSession={vi.fn()}
        onLaunchPtySession={vi.fn()}
      />,
    );

    expect(screen.getByText("No lanes available")).toBeTruthy();
    expect(screen.getByText("Create or reopen a lane before starting work.")).toBeTruthy();
    expect(screen.queryByTestId("agent-chat-pane")).toBeNull();
  });

  it("uses one AgentChatPane surface for CLI mode and opens shell in the selected lane", async () => {
    const onLaunchPtySession = vi.fn().mockResolvedValue({ sessionId: "shell-session", ptyId: "pty-shell", pid: null });
    render(
      <WorkStartSurface
        draftKind="cli"
        draftLaneId="lane-2"
        lanes={[
          { id: "lane-1", name: "Lane 1" } as any,
          { id: "lane-2", name: "Lane 2" } as any,
        ]}
        onOpenChatSession={vi.fn()}
        onLaunchPtySession={onLaunchPtySession}
        onDraftLaneChange={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("agent-chat-pane")).toBeTruthy();
    expect(agentChatPaneProps.latest?.workDraftKind).toBe("cli");
    expect(agentChatPaneProps.latest?.onLaunchCliSession).toBe(onLaunchPtySession);

    fireEvent.click(screen.getByText("mock shell"));
    await waitFor(() => {
      expect(onLaunchPtySession).toHaveBeenCalledWith({
        laneId: "lane-2",
        profile: "shell",
        title: "Shell",
      });
    });
  });

  it("passes draft context options through to the chat pane", async () => {
    render(
      <WorkStartSurface
        draftKind="chat"
        draftLaneId="lane-local"
        draftContextTargetId="work:draft:lane-local:chat"
        lanes={[{ id: "lane-local", name: "Local" } as any]}
        onOpenChatSession={vi.fn()}
        onLaunchPtySession={vi.fn()}
        suppressDraftLaunchNavigation
      />,
    );

    expect(await screen.findByTestId("agent-chat-pane")).toBeTruthy();
    expect(agentChatPaneProps.latest?.draftContextTargetId).toBe("work:draft:lane-local:chat");
    expect(agentChatPaneProps.latest?.suppressDraftLaunchNavigation).toBe(true);
  });

  it("keeps a foreign draft lane selected instead of falling back locally", async () => {
    crossMachineState.lanesByMachine = {
      studio: {
        machineId: "studio",
        machineName: "Mac Studio",
        targetId: "studio",
        projectId: "project-a",
        binding: null,
        online: true,
        lanes: [{ id: "lane-studio", name: "Studio lane" } as any],
        sessions: [],
        prs: [],
        lastSyncedAtMs: 1,
        error: null,
      },
    };

    render(
      <WorkStartSurface
        draftKind="chat"
        draftLaneId="lane-studio"
        draftMachineId="studio"
        lanes={[{ id: "lane-local", name: "Local lane" } as any]}
        onOpenChatSession={vi.fn()}
        onLaunchPtySession={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("agent-chat-pane")).toBeTruthy();
    expect(agentChatPaneProps.latest?.laneId).toBe("lane-studio");
    expect(agentChatPaneProps.latest?.laneLabel).toBe("Studio lane");
    expect(agentChatPaneProps.latest?.initialDraftMachineId).toBe("studio");
  });

  it("does not overwrite a foreign draft while its machine catalog is still loading", async () => {
    const onDraftLaneChange = vi.fn();
    render(
      <WorkStartSurface
        draftKind="chat"
        draftLaneId="lane-studio"
        draftMachineId="studio"
        lanes={[{ id: "lane-local", name: "Local lane" } as any]}
        onOpenChatSession={vi.fn()}
        onLaunchPtySession={vi.fn()}
        onDraftLaneChange={onDraftLaneChange}
      />,
    );

    expect(await screen.findByTestId("agent-chat-pane")).toBeTruthy();
    expect(agentChatPaneProps.latest?.laneId).toBe("lane-studio");
    expect(agentChatPaneProps.latest?.laneLabel).toBe("lane-studio");
    expect(onDraftLaneChange).not.toHaveBeenCalled();
  });
});
