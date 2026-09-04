/**
 * The divider, dragged.
 *
 * Two regressions live here and neither is visible from a single pointer move.
 * The first is that the drag died after ONE move, because the cleanup effect
 * depended on a handler that was rebuilt whenever the width changed and so ran
 * mid-drag, removing the listeners the drag was running on. The second is that
 * every pointer frame was persisted, so one drag wrote a hundred `ui-state`
 * rows through the bridge.
 *
 * So the walk is a real drag: press, several moves, release.
 */

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { HistorySplit, PANE_TITLE_PX } from "../src/components/HistorySplit";
import { DETAIL_MAX_PX, DETAIL_MIN_PX } from "../src/host/uiState";

afterEach(cleanup);

function move(clientX: number): void {
  act(() => {
    window.dispatchEvent(new MouseEvent("pointermove", { clientX, bubbles: true }));
  });
}

function release(): void {
  act(() => {
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  });
}

function Harness({ committed }: { committed: number[] }): React.ReactElement {
  const [px, setPx] = React.useState(420);
  return (
    <HistorySplit
      detailPx={px}
      onDetailPx={setPx}
      onDetailPxCommit={(next) => {
        setPx(next);
        committed.push(next);
      }}
      timelineTitle="Commit graph"
      detailTitle="Commit"
      timeline={<div>timeline</div>}
      detail={<div>detail</div>}
    />
  );
}

/**
 * Press the divider at a real coordinate.
 *
 * jsdom has no `PointerEvent`, and Testing Library's `fireEvent.pointerDown`
 * falls back to a bare `Event` there — which carries no `clientX`, so the drag
 * would start at `NaN` and every assertion below would be about the fallback
 * rather than about the split. A `MouseEvent` named `pointerdown` is the same
 * thing React's listener receives in a browser, with the coordinate on it.
 */
function startDrag(): HTMLElement {
  const handle = screen.getByLabelText("Resize the history detail pane");
  act(() => {
    handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 1_000, bubbles: true }));
  });
  return handle;
}

function detailPane(): HTMLElement {
  return screen.getByText("detail").parentElement!.parentElement as HTMLElement;
}

describe("the history split", () => {
  it("keeps resizing across every pointer move, not just the first", () => {
    const committed: number[] = [];
    render(<Harness committed={committed} />);
    startDrag();

    move(960);
    expect(detailPane().style.width).toBe("460px");
    move(920);
    expect(detailPane().style.width).toBe("500px");
    move(900);
    expect(detailPane().style.width).toBe("520px");

    release();
    expect(detailPane().style.width).toBe("520px");
  });

  it("persists once, on release, rather than on every frame", () => {
    const committed: number[] = [];
    render(<Harness committed={committed} />);
    startDrag();

    move(980);
    move(960);
    move(940);
    expect(committed).toEqual([]);

    release();
    expect(committed).toEqual([480]);
  });

  it("clamps to the compiled bounds while dragging", () => {
    const committed: number[] = [];
    render(<Harness committed={committed} />);
    startDrag();

    move(2_000);
    expect(detailPane().style.width).toBe(`${DETAIL_MIN_PX}px`);
    move(0);
    expect(detailPane().style.width).toBe(`${DETAIL_MAX_PX}px`);
    release();
    expect(committed).toEqual([DETAIL_MAX_PX]);
  });

  it("stops listening once the pointer is up", () => {
    const committed: number[] = [];
    render(<Harness committed={committed} />);
    startDrag();
    move(960);
    release();

    move(500);
    expect(detailPane().style.width).toBe("460px");
    expect(committed).toEqual([460]);
  });

  it("titles both panes at the compiled height", () => {
    render(<Harness committed={[]} />);
    const graph = document.querySelector('[data-ade-history-pane-title="Commit graph"]');
    const commit = document.querySelector('[data-ade-history-pane-title="Commit"]');
    expect(graph).toBeTruthy();
    expect(commit).toBeTruthy();
    expect((graph as HTMLElement).style.height).toBe(`${PANE_TITLE_PX}px`);
    expect(PANE_TITLE_PX).toBe(24);
  });
});
