/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

/**
 * The pane at its default 36% on a normal window — 447px, which is what the
 * visual review measured — and the column's own `px-6` padding.
 */
const DEFAULT_PANE_WIDTH_PX = 447;
const COLUMN_PADDING_PX = 24;

describe("WorkToolPicker", () => {
  // jsdom has no WebGL, so the backdrop takes its static-gradient path here.
  // Stubbed rather than left to fail, because jsdom's own "not implemented"
  // notice is a page of stderr per test for a fallback that is working.
  beforeAll(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(cleanup);

  it("paints the backdrop from outside the scroll container", () => {
    render(
      <WorkToolPicker
        activeTool={null}
        context={LOCAL}
        statuses={{}}
        loading={false}
        onPick={vi.fn()}
      />,
    );

    const backdrop = document.querySelector("[data-backdrop]");
    const scroller = document.querySelector("[data-tool-picker-scroll]");
    expect(backdrop).toBeTruthy();
    expect(scroller).toBeTruthy();
    // `inset: 0` inside a scroller resolves against the scroll ORIGIN, so a
    // pane too short for the column would scroll the mesh off the top and show
    // bare chrome underneath the rest of the cards.
    expect(scroller?.contains(backdrop as Node)).toBe(false);
    expect(backdrop?.parentElement).toBe(scroller?.parentElement);
    // Still behind the cards: painted first, so the scrolling column sits on
    // top of it without needing a z-index.
    expect(backdrop?.className).toContain("ade-tool-picker-backdrop");
    expect(backdrop?.nextElementSibling).toBe(scroller);
  });

  it("renders an untitled column of cards, each with its live status line", () => {
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

    // No title and no subline: the tab strip above the page already says
    // "Tools", and six labelled cards do not need introducing.
    expect(screen.queryByRole("heading", { name: "Tools" })).toBeNull();
    expect(screen.queryByText("Pick what this lane works with")).toBeNull();

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

    // A tool with a status shows the status and NOT its hint — never both.
    expect(screen.getByText("Clean")).toBeTruthy();
    expect(screen.queryByText("Commit, push, rebase")).toBeNull();
    // A tool with nothing measured says what it is for, in four words.
    expect(screen.getByText("Drive a real browser")).toBeTruthy();
    expect(screen.getByText("Run a shell here")).toBeTruthy();
    // Files has no hint at all: the lane store always knows whether the
    // worktree is dirty, so its slot is a status the pane never has to guess.
    expect(screen.getByText("Boot a simulator")).toBeTruthy();
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
    // The reason replaces the hint rather than joining it.
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

  it("paints the shader backdrop behind the grid, out of the way of clicks", () => {
    render(
      <WorkToolPicker
        activeTool={null}
        context={LOCAL}
        statuses={{}}
        loading={false}
        onPick={vi.fn()}
      />,
    );

    const backdrop = document.querySelector(".ade-tool-picker-backdrop");
    expect(backdrop).toBeTruthy();
    // Decoration, never a target and never announced.
    expect(backdrop?.getAttribute("aria-hidden")).toBe("true");
    // Behind the column, not in front of it.
    expect(backdrop?.nextElementSibling?.contains(
      screen.getByRole("group", { name: "Work tools" }),
    )).toBe(true);
  });

  it("caps the grid at two columns and fits two of them in the default pane", () => {
    render(
      <WorkToolPicker
        activeTool={null}
        context={LOCAL}
        statuses={{}}
        loading={false}
        onPick={vi.fn()}
      />,
    );

    const grid = screen.getByRole("group", { name: "Work tools" });
    const column = grid.parentElement as HTMLElement;
    // The regression: at 527px of pane the grid found room for a THIRD track
    // and spent the extra width making every card smaller (149px). Two 196px
    // tracks need 400px of column and three need 604px — more than the column
    // is ever allowed to be, so three is arithmetically unreachable.
    const maxColumn = Number.parseInt(column.style.maxWidth, 10);
    const track = /minmax\(min\(100%, (\d+)px\)/u.exec(grid.style.gridTemplateColumns);
    expect(track).toBeTruthy();
    const minTrack = Number(track![1]);
    // Three tracks stay arithmetically unreachable inside the column…
    expect(minTrack * 3 + 16).toBeGreaterThan(maxColumn);
    // …and two always fit it.
    expect(minTrack * 2 + 8).toBeLessThanOrEqual(maxColumn);
    // The regression this pins: at the pane's default width the old 196px
    // track needed 448px and had 447 — so the picker everybody sees on first
    // open rendered one column down a pane wide enough for two, missing it by
    // a single pixel. `px-6` either side plus the 8px gutter is the budget.
    expect(minTrack * 2 + 8 + COLUMN_PADDING_PX * 2).toBeLessThanOrEqual(DEFAULT_PANE_WIDTH_PX);
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
