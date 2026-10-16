/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render } from "@testing-library/react";
import { useProjectTabShortcuts } from "./useProjectTabShortcuts";

/**
 * `⌃⇥` / `⇧⌃⇥` through the hook's real seam: a `keydown` on the window and the
 * tab strip the top bar renders.
 *
 * jsdom gives every element an empty `DOMRectList`; the hook asks whether a tab
 * is on screen first, so stub the rects (a jsdom limitation, not a behavior).
 */
const isMac = navigator.platform.toLowerCase().includes("mac");
const ctrlOnly = { ctrlKey: true };

function stubRects(): void {
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([
    { width: 100, height: 24, top: 0, left: 0, bottom: 24, right: 100, x: 0, y: 0, toJSON: () => ({}) },
  ] as unknown as DOMRectList);
}

type Tab = { key: string; onClick: ReturnType<typeof vi.fn> };

/** The tab strip as the top bar renders it: one pressable element per tab,
 *  `aria-current` marking the active one. */
function appendTabs(keys: string[], currentKey: string): Tab[] {
  return keys.map((key) => {
    const tab = document.createElement("div");
    tab.setAttribute("role", "button");
    tab.setAttribute("data-project-tab-key", key);
    if (key === currentKey) tab.setAttribute("aria-current", "true");
    const onClick = vi.fn();
    tab.addEventListener("click", onClick);
    document.body.appendChild(tab);
    return { key, onClick };
  });
}

type HarnessProps = {
  enabled?: boolean;
  onOpenProjectPicker?: () => void;
};

function Harness(props: HarnessProps) {
  useProjectTabShortcuts({
    enabled: props.enabled ?? true,
    keybindings: null,
    onOpenProjectPicker: props.onOpenProjectPicker ?? (() => {}),
  });
  return <div />;
}

describe("useProjectTabShortcuts", () => {
  beforeEach(() => {
    stubRects();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("presses the next tab, wraps backwards to the last one, and never opens the picker", () => {
    const onOpenProjectPicker = vi.fn();
    const tabs = appendTabs(["local:ade", "local:crumb"], "local:ade");
    render(<Harness onOpenProjectPicker={onOpenProjectPicker} />);

    const forward = createEvent.keyDown(window, { key: "Tab", ...ctrlOnly });
    fireEvent(window, forward);

    expect(tabs[1]?.onClick).toHaveBeenCalledTimes(1);
    expect(tabs[0]?.onClick).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });

    // From the first tab, "previous" wraps to the last one.
    expect(tabs[1]?.onClick).toHaveBeenCalledTimes(2);
    expect(onOpenProjectPicker).not.toHaveBeenCalled();
  });

  it("opens the project picker when there is only one tab to sit on", () => {
    const onOpenProjectPicker = vi.fn();
    const tabs = appendTabs(["local:ade"], "local:ade");
    render(<Harness onOpenProjectPicker={onOpenProjectPicker} />);

    fireEvent.keyDown(window, { key: "Tab", ...ctrlOnly });

    expect(onOpenProjectPicker).toHaveBeenCalledTimes(1);
    expect(tabs[0]?.onClick).not.toHaveBeenCalled();
  });

  it("leaves the chord to a tab that is no longer on screen", () => {
    const onOpenProjectPicker = vi.fn();
    const tabs = appendTabs(["local:ade", "local:crumb"], "local:ade");
    tabs[1]?.onClick.mockClear();
    // The second tab is hidden (its group collapsed): it is not a target, and
    // with one visible tab the picker stands in for it.
    document.querySelectorAll("[data-project-tab-key]")[1]?.setAttribute("hidden", "");
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function stubHidden(
      this: Element,
    ) {
      return (this as HTMLElement).hasAttribute("hidden")
        ? ([] as unknown as DOMRectList)
        : ([{ width: 10, height: 10, top: 0, left: 0, bottom: 10, right: 10, x: 0, y: 0, toJSON: () => ({}) }] as unknown as DOMRectList);
    });
    render(<Harness onOpenProjectPicker={onOpenProjectPicker} />);

    fireEvent.keyDown(window, { key: "Tab", ...ctrlOnly });

    expect(tabs[1]?.onClick).not.toHaveBeenCalled();
    expect(onOpenProjectPicker).toHaveBeenCalledTimes(1);
  });

  it("does nothing while a modal layer is in front, while disabled, or on a held key", () => {
    const onOpenProjectPicker = vi.fn();
    const tabs = appendTabs(["local:ade", "local:crumb"], "local:ade");
    const { rerender } = render(
      <div>
        <div role="dialog" aria-modal="true">
          <button type="button">inside</button>
        </div>
        <Harness enabled={false} onOpenProjectPicker={onOpenProjectPicker} />
      </div>,
    );

    fireEvent.keyDown(window, { key: "Tab", ...ctrlOnly });
    fireEvent.keyDown(window, { key: "Tab", repeat: true, ...ctrlOnly });
    rerender(
      <div>
        <div role="dialog" aria-modal="true">
          <button type="button">inside</button>
        </div>
        <Harness onOpenProjectPicker={onOpenProjectPicker} />
      </div>,
    );
    fireEvent.keyDown(document.querySelector('[role="dialog"] button')!, { key: "Tab", ...ctrlOnly });

    expect(tabs[0]?.onClick).not.toHaveBeenCalled();
    expect(tabs[1]?.onClick).not.toHaveBeenCalled();
    expect(onOpenProjectPicker).not.toHaveBeenCalled();
  });
});
