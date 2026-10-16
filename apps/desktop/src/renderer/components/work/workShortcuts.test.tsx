/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render } from "@testing-library/react";
import { useWorkShortcuts } from "./workShortcuts";

/**
 * The Work page's chords, through the hook's real seam: a `keydown` on the
 * window, and the DOM the page would have.
 *
 * jsdom gives every element an empty `DOMRectList`, and the hook asks whether a
 * row is on screen before moving to it. Stub the rects (a jsdom limitation, not
 * a behavior) so "visible" means "in the document" here.
 */
const isMac = navigator.platform.toLowerCase().includes("mac");
const mod = isMac ? { metaKey: true } : { ctrlKey: true };

function stubRects(): void {
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([
    { width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100, x: 0, y: 0, toJSON: () => ({}) },
  ] as unknown as DOMRectList);
  // jsdom has no layout, so it has no scrolling either.
  Element.prototype.scrollIntoView = vi.fn();
}

type Row = { id: string; onClick: ReturnType<typeof vi.fn>; onWrapperClick: ReturnType<typeof vi.fn>; action: HTMLElement };

/**
 * Two session rows in the shape SessionCard renders: a drag wrapper that
 * carries the stable anchor, around the pressable face that selects. Both
 * listen for a click, so a test can tell a press on the control from a press on
 * the wrapper it bubbles through.
 */
function appendRows(): Row[] {
  return ["session-a", "session-b"].map((id) => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-session-row", "");
    wrapper.setAttribute("data-session-id", id);
    const face = document.createElement("div");
    face.setAttribute("role", "button");
    face.setAttribute("data-session-row-action", "");
    const onClick = vi.fn();
    const onWrapperClick = vi.fn();
    face.addEventListener("click", onClick);
    wrapper.addEventListener("click", onWrapperClick);
    wrapper.appendChild(face);
    document.body.appendChild(wrapper);
    return { id, onClick, onWrapperClick, action: face };
  });
}

type HarnessProps = {
  active?: boolean;
  toolsOpen?: () => boolean;
  onCloseTools?: () => void;
  onToggleTools?: () => void;
  selectedSessionId?: string | null;
  withField?: boolean;
  withTerminal?: boolean;
};

function Harness(props: HarnessProps) {
  const shortcuts = useWorkShortcuts({
    active: props.active ?? true,
    keybindings: null,
    selectedSessionId: props.selectedSessionId ?? null,
    onNewChat: () => {},
    onToggleTools: props.onToggleTools ?? (() => {}),
    onCloseTools: props.onCloseTools ?? (() => {}),
    toolsOpen: props.toolsOpen ?? (() => false),
  });
  return (
    <div>
      <div data-testid="keys-open" data-open={String(shortcuts.keysOpen)} />
      {props.withField ? <input aria-label="field" /> : null}
      {props.withTerminal
        ? (
          <div className="xterm">
            <textarea aria-label="terminal" />
          </div>
        )
        : null}
    </div>
  );
}

function keysOpen(container: HTMLElement): boolean {
  return container.querySelector('[data-testid="keys-open"]')?.getAttribute("data-open") === "true";
}

function field(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[aria-label="field"]');
  if (!element) throw new Error("the harness rendered no field");
  return element;
}

describe("useWorkShortcuts", () => {
  beforeEach(() => {
    stubRects();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("moves the selection by pressing the next row's control, not the drag wrapper", () => {
    const rows = appendRows();
    render(<Harness selectedSessionId="session-a" />);

    fireEvent.keyDown(window, { key: "ArrowDown", ...mod });

    // The face selects; the wrapper only carries drag and the context menu.
    expect(rows[1]?.onClick).toHaveBeenCalledTimes(1);
    expect(rows[0]?.onClick).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "ArrowUp", ...mod });

    expect(rows[0]?.onClick).toHaveBeenCalledTimes(1);
    expect(rows[1]?.onClick).toHaveBeenCalledTimes(1);
  });

  it("leaves the caret chords to a text field and to a terminal", () => {
    const rows = appendRows();
    const { container } = render(<Harness selectedSessionId="session-a" withField withTerminal />);

    const fieldEvent = createEvent.keyDown(field(container), { key: "ArrowDown", ...mod });
    fireEvent(field(container), fieldEvent);
    fireEvent.keyDown(container.querySelector(".xterm textarea")!, { key: "ArrowDown", ...mod });

    expect(rows[0]?.onClick).not.toHaveBeenCalled();
    expect(rows[1]?.onClick).not.toHaveBeenCalled();
    // Nothing was pressed at all — not the control, not the wrapper it would
    // bubble through (the shape a press-the-wrapper regression takes).
    expect(rows[0]?.onWrapperClick).not.toHaveBeenCalled();
    expect(rows[1]?.onWrapperClick).not.toHaveBeenCalled();
    // Not claimed: inside a field the caret chords stay the platform's.
    expect(fieldEvent.defaultPrevented).toBe(false);
  });

  it("opens the shortcut sheet with ? outside a field, and closes it with ? again", () => {
    const { container } = render(<Harness />);
    expect(keysOpen(container)).toBe(false);

    fireEvent.keyDown(window, { key: "?" });
    expect(keysOpen(container)).toBe(true);

    fireEvent.keyDown(window, { key: "?" });
    expect(keysOpen(container)).toBe(false);
  });

  it("types ? in a text field instead of opening the sheet", () => {
    const { container } = render(<Harness withField />);
    const event = createEvent.keyDown(field(container), { key: "?" });
    fireEvent(field(container), event);

    expect(keysOpen(container)).toBe(false);
    // The character must reach the field: the sheet must not swallow it.
    expect(event.defaultPrevented).toBe(false);
  });

  it("closes the tools pane on Escape from outside it, reading the pane's state at press time", () => {
    const onCloseTools = vi.fn();
    const onToggleTools = vi.fn();
    // Two distinct functions, not one closure over a mutable flag: a version of
    // the handler that kept the args it was armed with cannot pass this.
    const closedFor = () => false;
    const openFor = () => true;
    const { rerender } = render(
      <Harness toolsOpen={closedFor} onCloseTools={onCloseTools} onToggleTools={onToggleTools} />,
    );

    // The pane opens after mount (a click on the header toggle, say): the
    // handler reads that state at press time, not the state it was armed with.
    rerender(
      <Harness toolsOpen={openFor} onCloseTools={onCloseTools} onToggleTools={onToggleTools} />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseTools).toHaveBeenCalledTimes(1);
    expect(onToggleTools).not.toHaveBeenCalled();

    // With no pane open, Escape is not this page's to claim.
    rerender(
      <Harness toolsOpen={closedFor} onCloseTools={onCloseTools} onToggleTools={onToggleTools} />,
    );
    const event = createEvent.keyDown(window, { key: "Escape" });
    fireEvent(window, event);
    expect(onCloseTools).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });
});
