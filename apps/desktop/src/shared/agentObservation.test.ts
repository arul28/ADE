// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_DOM_COLLECTOR_FUNCTION, keyEventsForAgentInput } from "./agentObservation";

describe("keyEventsForAgentInput", () => {
  it("builds text-producing Enter and shortcut events with the right key lifecycle", () => {
    const enter = keyEventsForAgentInput("Enter");
    expect(enter.down).toMatchObject({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      text: "\r",
      unmodifiedText: "\r",
    });
    expect(enter.up).toMatchObject({ type: "keyUp", key: "Enter", code: "Enter" });

    const shortcut = keyEventsForAgentInput("Meta+n");
    expect(shortcut.down).toMatchObject({ type: "rawKeyDown", key: "n", code: "KeyN", modifiers: 4 });
    expect(shortcut.down).not.toHaveProperty("text");
  });

  it("supports bare modifiers and function keys, and rejects unknown key names", () => {
    expect(keyEventsForAgentInput("Shift").down).toMatchObject({
      type: "rawKeyDown",
      key: "Shift",
      code: "ShiftLeft",
      windowsVirtualKeyCode: 16,
    });
    expect(keyEventsForAgentInput("F12").down).toMatchObject({
      type: "rawKeyDown",
      key: "F12",
      code: "F12",
      windowsVirtualKeyCode: 123,
    });
    expect(() => keyEventsForAgentInput("PrintScreen")).toThrow(/Unknown key/);
    expect(() => keyEventsForAgentInput("Hyper+K")).toThrow(/Unknown modifier/);
  });
});

/**
 * The in-page collector is a string evaluated in the controlled renderer, so a
 * test must evaluate it the same way. jsdom has no layout engine, so every
 * element is given a non-zero box; element selection is what these cases pin,
 * not geometry.
 */
const COLLECT = new Function(`return (${AGENT_DOM_COLLECTOR_FUNCTION})`)() as (
  input: Record<string, unknown>,
) => { target?: { role?: string | null; tagName?: string | null; testId?: string | null; label?: string | null } | null };

const LAYOUT_RECT: DOMRect = {
  x: 0, y: 0, width: 200, height: 20,
  top: 0, left: 0, right: 200, bottom: 20,
  toJSON: () => ({}),
} as DOMRect;

describe("AGENT_DOM_COLLECTOR_FUNCTION text matching", () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(LAYOUT_RECT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("targets the clickable row, not the list container whose combined text includes the needle", () => {
    document.body.innerHTML = `
      <div role="listbox" aria-label="Lanes" tabindex="0" data-testid="lane-sidebar-list">
        <div role="option" data-testid="lane-sidebar-row"><span>Account sign-in and load balancing</span></div>
        <div role="option" data-testid="lane-sidebar-row"><span>Another lane</span></div>
      </div>`;

    const row = COLLECT({ locate: { text: "Account sign-in and load balancing" } });
    expect(row.target?.role).toBe("option");
    expect(row.target?.testId).toBe("lane-sidebar-row");

    // A heading with no clickable ancestor is still findable, for wait/assert.
    document.body.innerHTML = `
      <div role="listbox" tabindex="0"><div role="option"><span>Other</span></div></div>
      <h2>Count: 3</h2>`;
    const heading = COLLECT({ locate: { text: "Count: 3" } });
    expect(heading.target?.tagName).toBe("h2");
  });

  it("keeps an exact accessible-name match ahead of a container that contains the text", () => {
    document.body.innerHTML = `
      <div role="listbox" tabindex="0" data-testid="container">
        <span>Save</span>
        <button aria-label="Save" data-testid="save-button"></button>
      </div>`;

    const button = COLLECT({ locate: { text: "Save" } });
    expect(button.target?.tagName).toBe("button");
    expect(button.target?.testId).toBe("save-button");
  });
});
