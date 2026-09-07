/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkToolPicker } from "./WorkToolPicker";
import { WORK_TOOL_DEFINITIONS, type WorkToolContext } from "./workTools";
import type { WorkToolStatusMap } from "./useWorkToolStatuses";

const LOCAL: WorkToolContext = {
  isRemoteProject: false,
  supportsIosSimulator: true,
  isWebClient: false,
};

function cardFor(label: string): HTMLButtonElement {
  const card = screen.getByText(label).closest("button");
  if (!card) throw new Error(`No picker card for ${label}`);
  return card as HTMLButtonElement;
}

describe("WorkToolPicker", () => {
  afterEach(cleanup);

  it("renders a card per tool with its live status line", () => {
    const statuses: WorkToolStatusMap = {
      terminal: { line: "2 shells · zsh, npm run dev", live: true },
      browser: { line: "No tabs", live: false },
    };
    render(
      <WorkToolPicker
        activeTool={null}
        context={LOCAL}
        statuses={statuses}
        loading={false}
        onPick={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(WORK_TOOL_DEFINITIONS.length);
    expect(screen.getByText("2 shells · zsh, npm run dev")).toBeTruthy();
    expect(screen.getByText("No tabs")).toBeTruthy();
    // A tool with nothing measurable says what it is FOR rather than faking a
    // status line.
    expect(screen.getByText("Browse and edit the lane worktree")).toBeTruthy();
  });

  it("shows the reason on a tool that cannot run here and refuses the click", () => {
    const onPick = vi.fn();
    render(
      <WorkToolPicker
        activeTool={null}
        context={{ ...LOCAL, supportsIosSimulator: false }}
        statuses={{}}
        loading={false}
        onPick={onPick}
      />,
    );

    const ios = cardFor("iOS Simulator");
    expect(ios.disabled).toBe(true);
    expect(screen.getByText("macOS only")).toBeTruthy();
    fireEvent.click(ios);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("activates the tool a card names", () => {
    const onPick = vi.fn();
    render(
      <WorkToolPicker
        activeTool="git"
        context={LOCAL}
        statuses={{}}
        loading={false}
        onPick={onPick}
      />,
    );

    expect(cardFor("Git").getAttribute("aria-current")).toBe("true");
    expect(cardFor("Browser").getAttribute("aria-current")).toBe(null);

    fireEvent.click(cardFor("Browser"));
    expect(onPick).toHaveBeenCalledWith("browser");
  });

  it("holds a placeholder line while reads settle instead of shifting layout", () => {
    render(
      <WorkToolPicker
        activeTool={null}
        context={LOCAL}
        statuses={{ git: { line: "3 ahead · clean", live: true } }}
        loading
        onPick={vi.fn()}
      />,
    );

    // Already-answered tools commit immediately; the rest hold a skeleton.
    expect(screen.getByText("3 ahead · clean")).toBeTruthy();
    expect(document.querySelectorAll(".ade-tool-skeleton").length).toBeGreaterThan(0);
  });
});
