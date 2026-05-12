/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkStartSurface } from "./WorkStartSurface";

const selectLane = vi.fn();

vi.mock("../../state/appStore", () => ({
  useAppStore: (selector: (state: { selectedLaneId: string | null; selectLane: typeof selectLane }) => unknown) =>
    selector({ selectedLaneId: null, selectLane }),
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
