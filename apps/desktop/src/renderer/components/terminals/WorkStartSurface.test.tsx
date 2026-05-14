/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../state/appStore";
import { WorkStartSurface } from "./WorkStartSurface";

const selectLane = vi.fn();
const agentChatPaneProps = vi.hoisted(() => ({
  latest: null as null | {
    laneId: string | null;
    workDraftKind?: "chat" | "cli";
    onOpenShellSession?: (laneId: string) => void | Promise<void>;
    onLaunchCliSession?: unknown;
  },
}));

vi.mock("../../state/appStore", () => ({
  useAppStore: <T,>(selector: (state: AppState) => T): T =>
    selector({ selectedLaneId: null, selectLane, lanesLoading: false } as unknown as AppState),
}));

vi.mock("../chat/AgentChatPane", () => ({
  AgentChatPane: (props: {
    laneId: string | null;
    workDraftKind?: "chat" | "cli";
    onOpenShellSession?: (laneId: string) => void | Promise<void>;
    onLaunchCliSession?: unknown;
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
    const onLaunchPtySession = vi.fn().mockResolvedValue({});
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
});
