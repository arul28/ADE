/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { pressActivation } from "./pressActivation";

afterEach(cleanup);

type Press = {
  pointerType: string;
  button: number;
  pointerId: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};
const PLAIN_MOUSE: Press = { pointerType: "mouse", button: 0, pointerId: 1 };

/** jsdom has no PointerEvent, so a pointer event is a mouse event with the two pointer fields. */
function pointer(element: Element, type: "pointerdown" | "pointerup" | "pointercancel", press: Press = PLAIN_MOUSE) {
  const { pointerType, pointerId, ...mouse } = press;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...mouse });
  Object.defineProperties(event, { pointerType: { value: pointerType }, pointerId: { value: pointerId } });
  act(() => {
    element.dispatchEvent(event);
  });
}

/** A real click after a press: the browser sends pointerup, then click. */
function release(element: Element) {
  pointer(element, "pointerup");
  fireEvent.click(element);
}

function Control({ action, actOnPress }: { action: () => void | (() => void); actOnPress?: boolean }) {
  return (
    <div role="button" tabIndex={0} data-testid="control" draggable {...pressActivation(action, actOnPress)}>
      row
      <button type="button" data-testid="nested" onClick={(event) => event.stopPropagation()}>
        nested
      </button>
      {createPortal(<div data-testid="portal">menu backdrop</div>, document.body)}
    </div>
  );
}

describe("pressActivation", () => {
  it("acts once on a plain mouse press, before the release", () => {
    const action = vi.fn();
    render(<Control action={action} />);
    const control = screen.getByTestId("control");

    pointer(control, "pointerdown");
    expect(action).toHaveBeenCalledTimes(1);

    // The click of the same press must not act a second time.
    release(control);
    expect(action).toHaveBeenCalledTimes(1);

    // The press is over: the next press acts again.
    pointer(control, "pointerdown");
    expect(action).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the Ctrl key (the context menu on macOS)", { ...PLAIN_MOUSE, ctrlKey: true }, undefined],
    ["the Cmd key (toggle selection)", { ...PLAIN_MOUSE, metaKey: true }, undefined],
    ["the Shift key (range selection)", { ...PLAIN_MOUSE, shiftKey: true }, undefined],
    ["the Alt key", { ...PLAIN_MOUSE, altKey: true }, undefined],
    ["the right button", { ...PLAIN_MOUSE, button: 2 }, undefined],
    ["a touch", { ...PLAIN_MOUSE, pointerType: "touch" }, undefined],
    ["a pen", { ...PLAIN_MOUSE, pointerType: "pen" }, undefined],
    ["a control that waits for the click", PLAIN_MOUSE, false],
  ])("leaves a press with %s to the click", (_name, press, actOnPress) => {
    const action = vi.fn();
    render(<Control action={action} actOnPress={actOnPress} />);
    const control = screen.getByTestId("control");

    pointer(control, "pointerdown", press);
    expect(action).not.toHaveBeenCalled();

    release(control);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("does not act for a press on a nested control or in a portal of the control", () => {
    const action = vi.fn();
    render(<Control action={action} />);

    pointer(screen.getByTestId("nested"), "pointerdown");
    // React sends a press in a portal to the component that rendered it.
    pointer(screen.getByTestId("portal"), "pointerdown");
    expect(action).not.toHaveBeenCalled();

    // A click with no press (the keyboard, assistive technology) still acts.
    fireEvent.click(screen.getByTestId("control"));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["dragstart, then pointercancel", ["dragstart", "pointercancel"] as const],
    ["pointercancel, then dragstart", ["pointercancel", "dragstart"] as const],
  ])("runs the undo once when the press becomes a drag (%s)", (_name, order) => {
    const undo = vi.fn();
    const action = vi.fn(() => undo);
    render(<Control action={action} />);
    const control = screen.getByTestId("control");

    pointer(control, "pointerdown");
    for (const type of order) {
      if (type === "dragstart") fireEvent.dragStart(control);
      else pointer(control, type);
    }
    expect(action).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(1);

    fireEvent.dragEnd(control);
    fireEvent.dragStart(control);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("keeps the action when the press ends in a release, with no drag", () => {
    const undo = vi.fn();
    render(<Control action={() => undo} />);
    const control = screen.getByTestId("control");

    pointer(control, "pointerdown");
    release(control);
    // A drag that starts later belongs to another press.
    fireEvent.dragStart(control);
    expect(undo).not.toHaveBeenCalled();
  });
});
