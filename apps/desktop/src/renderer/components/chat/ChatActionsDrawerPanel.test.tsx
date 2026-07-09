/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatActionsDrawerPanel } from "./ChatActionsDrawerPanel";

afterEach(cleanup);

function commonProps() {
  return {
    onTabChange: vi.fn(),
    onClose: vi.fn(),
    agentsContent: <div>Agents body</div>,
    proofContent: <div>Proof body</div>,
    handoffContent: <div>Handoff body</div>,
  };
}

describe("ChatActionsDrawerPanel", () => {
  it("shows Sources as the first Codex-specific action tab", () => {
    const props = commonProps();
    render(
      <ChatActionsDrawerPanel
        {...props}
        tab="sources"
        sourcesContent={<div>Sources body</div>}
        missionsContent={<div>Missions body</div>}
      />,
    );

    expect(screen.getByText("Sources body")).toBeTruthy();
    const tabs = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(tabs.slice(0, 5)).toEqual(["Sources", "Missions", "Agents", "Proof", "Handoff"]);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(props.onTabChange).toHaveBeenCalledWith("agents");
  });

  it("falls back to Agents when a persisted Sources tab is unavailable", () => {
    render(<ChatActionsDrawerPanel {...commonProps()} tab="sources" />);

    expect(screen.getByText("Agents body")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sources" })).toBeNull();
  });
});
