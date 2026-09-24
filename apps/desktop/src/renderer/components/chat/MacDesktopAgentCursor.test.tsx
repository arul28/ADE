/* @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reduced.value,
}));

import {
  MAC_DESKTOP_AGENT_CURSOR_GLIDE_MS,
  MacDesktopAgentCursor,
  macDesktopAgentCursorTransition,
} from "./MacDesktopAgentCursor";

afterEach(() => {
  cleanup();
  reduced.value = false;
});

function glyph(): HTMLElement {
  return screen.getByTestId("mac-desktop-agent-cursor");
}

describe("MacDesktopAgentCursor", () => {
  it("appears in place, then glides to the next action's point", () => {
    const view = render(<MacDesktopAgentCursor point={{ x: 10, y: 20 }} />);
    expect(glyph().style.transform).toContain("translate3d(10px, 20px, 0)");
    // The first point is not flown into from anywhere.
    expect(glyph().style.transition).not.toContain("transform");

    view.rerender(<MacDesktopAgentCursor point={{ x: 300, y: 120 }} />);
    expect(glyph().style.transform).toContain("translate3d(300px, 120px, 0)");
    expect(glyph().style.transition).toContain(`transform ${MAC_DESKTOP_AGENT_CURSOR_GLIDE_MS}ms`);
    expect(glyph().dataset.glide).toBe("true");
  });

  it("fades out where it stopped once the agent is idle, and reappears in place", () => {
    const view = render(<MacDesktopAgentCursor point={{ x: 10, y: 20 }} />);
    view.rerender(<MacDesktopAgentCursor point={null} />);
    // Still on the page, fading, at the same point.
    expect(glyph().style.opacity).toBe("0");
    expect(glyph().style.transform).toContain("translate3d(10px, 20px, 0)");
    expect(glyph().style.transition).toContain("opacity");

    view.rerender(<MacDesktopAgentCursor point={{ x: 500, y: 40 }} />);
    expect(glyph().style.opacity).toBe("1");
    expect(glyph().dataset.glide).toBe("false");
  });

  it("does not animate with reduced motion", () => {
    reduced.value = true;
    const view = render(<MacDesktopAgentCursor point={{ x: 10, y: 20 }} />);
    view.rerender(<MacDesktopAgentCursor point={{ x: 300, y: 120 }} />);
    expect(glyph().style.transition).toBe("none");
    act(() => view.rerender(<MacDesktopAgentCursor point={null} />));
    expect(screen.queryByTestId("mac-desktop-agent-cursor")).toBeNull();
    expect(macDesktopAgentCursorTransition({ glide: true, reduceMotion: true })).toBe("none");
  });
});
