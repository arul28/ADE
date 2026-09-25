/* @vitest-environment jsdom */

import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnchoredMenu } from "./AnchoredMenu";

function Harness() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div data-testid="clipping-parent" style={{ overflow: "hidden" }}>
      <button ref={buttonRef} type="button" onClick={() => setOpen((value) => !value)}>
        Toggle
      </button>
      <AnchoredMenu open={open} anchorRef={buttonRef} onClose={() => setOpen(false)} role="menu" aria-label="Test menu">
        <button type="button" role="menuitem">Item</button>
      </AnchoredMenu>
    </div>
  );
}

afterEach(cleanup);

describe("AnchoredMenu", () => {
  it("renders outside the clipping parent as a fixed layer", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    const menu = screen.getByRole("menu", { name: "Test menu" });
    expect(screen.getByTestId("clipping-parent").contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
  });

  it("stays open for clicks inside it and on the trigger, closes on an outside click", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Toggle" });
    fireEvent.click(toggle);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Item" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    // The trigger's own click toggles it; its mousedown must not close it first.
    fireEvent.mouseDown(toggle);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape and on window resize", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Toggle" });
    fireEvent.click(toggle);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(toggle);
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
