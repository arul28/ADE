/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../state/appStore";
import { WorkStartSurface } from "./WorkStartSurface";

const selectLane = vi.fn();

vi.mock("../../state/appStore", () => ({
  useAppStore: <T,>(selector: (state: AppState) => T): T =>
    selector({ selectedLaneId: null, selectLane } as unknown as AppState),
}));

vi.mock("../chat/AgentChatPane", () => ({
  AgentChatPane: () => <div data-testid="agent-chat-pane" />,
}));

describe("WorkStartSurface", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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
});
