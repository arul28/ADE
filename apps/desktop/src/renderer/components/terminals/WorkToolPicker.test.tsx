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

/** By id, for the cases that walk the catalogue rather than name a tool. */
function cardById(id: string): HTMLButtonElement {
  const card = document.querySelector<HTMLButtonElement>(`button[data-tool-id="${id}"]`);
  if (!card) throw new Error(`No picker card for ${id}`);
  return card;
}

describe("WorkToolPicker", () => {
  afterEach(cleanup);

  it("renders a titled column of cards, each with its live status line", () => {
    const statuses: WorkToolStatusMap = {
      terminal: { line: "2 shells", live: true },
      browser: { line: "3 tabs · agent", live: true },
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

    // The page names itself once, above the grid — the pane header no longer
    // repeats it.
    expect(screen.getByRole("heading", { name: "Tools" })).toBeTruthy();
    expect(screen.getByText("Pick what this lane works with")).toBeTruthy();

    expect(screen.getAllByRole("button")).toHaveLength(WORK_TOOL_DEFINITIONS.length);
    expect(screen.getByText("2 shells")).toBeTruthy();
    expect(screen.getByText("3 tabs · agent")).toBeTruthy();
  });

  it("falls back to a short description only when a tool has measured nothing", () => {
    render(
      <WorkToolPicker
        activeTool={null}
        context={LOCAL}
        statuses={{ git: { line: "Clean", live: false } }}
        loading={false}
        onPick={vi.fn()}
      />,
    );

    // A tool with a status shows the status and NOT its blurb — never both.
    expect(screen.getByText("Clean")).toBeTruthy();
    expect(screen.queryByText("Commit, push, rebase")).toBeNull();
    // A tool with nothing measured says what it is for, in four words.
    expect(screen.getByText("Drive a real browser")).toBeTruthy();
    expect(screen.getByText("Run a shell here")).toBeTruthy();
    // Files measures nothing, so it always shows its blurb rather than a noun
    // ("Lane worktree") dressed up as a status.
    expect(screen.getByText("Browse the worktree")).toBeTruthy();
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

    const ios = cardFor("Simulator");
    expect(ios.disabled).toBe(true);
    // The reason replaces the blurb rather than joining it.
    expect(screen.getByText("macOS only")).toBeTruthy();
    expect(screen.queryByText("Boot a simulator")).toBeNull();
    // Dimmed, not hidden: the tool still exists, it just cannot run here.
    expect(ios.className).toContain("opacity-40");
    fireEvent.click(ios);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps the browser clickable on a remote project and disables only the rest", () => {
    const onPick = vi.fn();
    render(
      <WorkToolPicker
        activeTool={null}
        context={{ ...LOCAL, isRemoteProject: true }}
        statuses={{}}
        loading={false}
        onPick={onPick}
      />,
    );

    // The browser is this window's, whatever machine the lane runs on: a
    // loopback URL over there is reached through a port-forward, which is the
    // whole point of pinning a remote lane at a browser.
    expect(cardFor("Browser").disabled).toBe(false);
    fireEvent.click(cardFor("Browser"));
    expect(onPick).toHaveBeenCalledWith("browser");

    // The two that really do drive something attached to this desk stay off.
    expect(cardFor("Simulator").disabled).toBe(true);
    expect(cardFor("App Control").disabled).toBe(true);
    expect(screen.getAllByText("Runs on this computer only").length).toBe(2);
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

  it("marks only broken tools, and only with a red dot on the label row", () => {
    render(
      <WorkToolPicker
        activeTool={null}
        context={LOCAL}
        statuses={{
          terminal: { line: "2 shells", live: true },
          browser: { line: "github.com", live: true, errorCount: 3 },
          "app-control": { line: "Finder", live: false, errored: true },
          git: { line: "Clean", live: false },
        }}
        loading={false}
        onPick={vi.fn()}
      />,
    );

    // Activity is NOT a mark: a live shell and a clean worktree are both quiet.
    expect(cardFor("Terminal").querySelector("[data-tool-error-dot]")).toBeNull();
    expect(cardFor("Git").querySelector("[data-tool-error-dot]")).toBeNull();
    // A counted tally and a bare error STATE both earn the same dot.
    expect(cardFor("Browser").querySelector("[data-tool-error-dot]")).toBeTruthy();
    expect(cardFor("App Control").querySelector("[data-tool-error-dot]")).toBeTruthy();
    expect(screen.getByLabelText("Browser · errors")).toBeTruthy();
  });

  it("moves a highlight with the arrow keys, starting at nothing highlighted", () => {
    render(
      <WorkToolPicker
        activeTool={null}
        context={LOCAL}
        statuses={{}}
        loading={false}
        onPick={vi.fn()}
      />,
    );

    // Opening the page pre-selects nothing: this is a page you look at, not a
    // palette you are already typing into.
    expect(document.querySelector("[data-highlighted='true']")).toBeNull();

    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    const first = WORK_TOOL_DEFINITIONS[0]!;
    expect(cardById(first.id).getAttribute("data-highlighted")).toBe("true");
    // Focus travels with the highlight, so Enter is the browser's own
    // activation rather than a second key path that could disagree.
    expect(document.activeElement).toBe(cardById(first.id));

    fireEvent.keyDown(document.body, { key: "ArrowUp" });
    expect(cardById(first.id).getAttribute("data-highlighted")).toBe(null);
    const last = WORK_TOOL_DEFINITIONS[WORK_TOOL_DEFINITIONS.length - 1]!;
    expect(cardById(last.id).getAttribute("data-highlighted")).toBe("true");
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

    // An odd tool count leaves the last card alone; it spans the row instead of
    // orphaning it.
    const last = WORK_TOOL_DEFINITIONS[WORK_TOOL_DEFINITIONS.length - 1]!;
    const gridItem = cardById(last.id).parentElement as HTMLElement;
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
    expect(cardFor("Simulator").disabled).toBe(true);
    expect(screen.getByText("Desktop app only")).toBeTruthy();

    fireEvent.click(cardFor("Browser"));
    expect(onPick).toHaveBeenCalledWith("browser");
  });
});
