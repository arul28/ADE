/* @vitest-environment jsdom */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFloatingPlayerFrame, type FloatingPlayerChoice } from "./FloatingPlayer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A bare box on the shared hook, inside a column the test sizes. */
function Box({ onCommit }: { onCommit: (choice: FloatingPlayerChoice) => void }) {
  const { hostRef, frame, startDrag } = useFloatingPlayerFrame({
    source: { width: 1_600, height: 1_000 },
    onCommit,
  });
  return (
    <div
      ref={hostRef}
      data-testid="box"
      onPointerDown={startDrag}
      style={{ left: frame.x, top: frame.y, width: frame.width }}
    />
  );
}

function pointer(target: EventTarget, type: string, clientX: number, clientY: number): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY }));
  });
}

describe("useFloatingPlayerFrame", () => {
  it("works in the column's own pixels when the page is zoomed", () => {
    // The hosted web client zooms <body> by 1.1: the column is 1000 CSS px
    // wide but 1100 viewport px, and the pointer reports viewport px.
    const column = document.createElement("div");
    Object.defineProperty(column, "clientWidth", { value: 1_000 });
    Object.defineProperty(column, "clientHeight", { value: 700 });
    column.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 1_100, bottom: 770, width: 1_100, height: 770, toJSON: () => ({}),
    });
    document.body.appendChild(column);
    const onCommit = vi.fn();
    const { getByTestId } = render(<Box onCommit={onCommit} />, { container: column });
    const box = getByTestId("box");

    // Parked top right inside the 1000px column, not the 1100px rect.
    expect(box.style.left).toBe(`${1_000 - 12 - 320}px`);

    // 110 viewport px of pointer is 100 CSS px of box.
    pointer(box, "pointerdown", 900, 100);
    pointer(window, "pointermove", 790, 210);
    pointer(window, "pointerup", 790, 210);
    expect(parseFloat(box.style.left)).toBeCloseTo(668 - 100, 6);
    expect(parseFloat(box.style.top)).toBeCloseTo(112, 6);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const choice = onCommit.mock.calls[0]![0] as FloatingPlayerChoice;
    expect(choice.width).toBeNull();
    expect(choice.position?.x).toBeCloseTo(568, 6);
    expect(choice.position?.y).toBeCloseTo(112, 6);
    column.remove();
  });

  it("reports nothing for a press that does not move", () => {
    const onCommit = vi.fn();
    const { getByTestId } = render(<Box onCommit={onCommit} />);
    pointer(getByTestId("box"), "pointerdown", 10, 10);
    pointer(window, "pointerup", 10, 10);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
