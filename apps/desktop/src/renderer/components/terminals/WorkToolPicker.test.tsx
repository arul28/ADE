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

  it("colours the card dot by state, not by tool", () => {
    render(
      <WorkToolPicker
        activeTool={null}
        context={LOCAL}
        statuses={{
          terminal: { line: "2 shells", live: true },
          browser: { line: "github.com · you own this tab", live: true, attention: true },
          pr: { line: "#12 · checks failing", live: false, errored: true },
          git: { line: "clean", live: false },
        }}
        loading={false}
        onPick={vi.fn()}
      />,
    );

    const stateOf = (label: string) =>
      cardFor(label).querySelector("[data-tool-glyph-state]")?.getAttribute("data-tool-glyph-state");

    expect(stateOf("Terminal")).toBe("live");
    // A login handoff is not "activity" and not "broken" — it is the one state
    // that is asking the person for something.
    expect(stateOf("Browser")).toBe("attention");
    expect(stateOf("Pull request")).toBe("error");
    expect(stateOf("Git")).toBe("idle");

    // Non-idle dots announce what their colour means; an idle dot says nothing,
    // because "nothing is happening" is not news worth a screen-reader stop.
    expect(screen.getByLabelText("Needs you")).toBeTruthy();
    expect(screen.getByLabelText("Errors")).toBeTruthy();
  });

  it("keeps every status on one line and finishes the last row", () => {
    render(
      <WorkToolPicker
        activeTool={null}
        context={LOCAL}
        statuses={{ terminal: { line: "2 shells · a very long dev server command that would wrap", live: true } }}
        loading={false}
        onPick={vi.fn()}
      />,
    );

    const status = screen.getByText("2 shells · a very long dev server command that would wrap");
    expect(status.className).toContain("truncate");

    // Seven tools in a two-column grid leave the seventh alone; it spans the
    // row instead of orphaning it.
    const last = WORK_TOOL_DEFINITIONS[WORK_TOOL_DEFINITIONS.length - 1]!;
    const lastCard = cardFor(last.label);
    const gridItem = lastCard.parentElement as HTMLElement;
    if (WORK_TOOL_DEFINITIONS.length % 2 === 1) {
      expect(gridItem.style.gridColumn).toBe("1 / -1");
    } else {
      expect(gridItem.style.gridColumn).toBe("");
    }
  });

  it("keeps the web client's watchable tools pickable and its undrivable one dimmed", () => {
    const onPick = vi.fn();
    render(
      <WorkToolPicker
        activeTool={null}
        context={{ isRemoteProject: false, supportsIosSimulator: true, isWebClient: true }}
        statuses={{}}
        loading={false}
        onPick={onPick}
      />,
    );

    // Browser and App Control leave a describable trail the hosted client can
    // show read-only; the simulator's pane is a video stream and nothing else.
    expect(cardFor("Browser").disabled).toBe(false);
    expect(cardFor("App Control").disabled).toBe(false);
    expect(cardFor("iOS Simulator").disabled).toBe(true);
    expect(screen.getByText("Desktop app only")).toBeTruthy();

    fireEvent.click(cardFor("Browser"));
    expect(onPick).toHaveBeenCalledWith("browser");
  });

  it("tells you how to get back here and how to get here from anywhere", () => {
    render(
      <WorkToolPicker
        activeTool={null}
        context={LOCAL}
        statuses={{}}
        loading={false}
        onPick={vi.fn()}
      />,
    );

    expect(screen.getByText(/Esc returns here/)).toBeTruthy();
    expect(screen.getByText(/Tools:/)).toBeTruthy();
  });
});
