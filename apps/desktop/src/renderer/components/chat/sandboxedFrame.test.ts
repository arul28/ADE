// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameJustPressed, passFrameGate, watchOutsidePresses } from "./sandboxedFrame";

describe("sandboxed frame press gate", () => {
  // No watcher is held in this file, so the gate must refuse every frame,
  // including a real one, before it looks at the document.
  const frame = {} as HTMLIFrameElement;

  it("refuses a press when nothing is watching the outside presses", () => {
    expect(frameJustPressed(frame)).toBe(false);
    expect(frameJustPressed(null)).toBe(false);
  });

  it("refuses an action and leaves its rate-limit clock alone", () => {
    const lastRef = { current: 0 };
    expect(passFrameGate(frame, lastRef, 800)).toBe(false);
    expect(lastRef.current).toBe(0);
  });
});

describe("sandboxed frame press gate with two frames mounted", () => {
  const releases: Array<() => void> = [];
  afterEach(() => {
    for (const release of releases.splice(0)) release();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  function mountFrame(): HTMLIFrameElement {
    const frame = document.createElement("iframe");
    frame.tabIndex = 0;
    document.body.append(frame);
    releases.push(watchOutsidePresses());
    return frame;
  }

  it("refuses a frame that took the focus from script, and passes the frame the pointer left with the focus in it", () => {
    vi.useFakeTimers();
    const stealer = mountFrame();
    const pressed = mountFrame();
    // No press reaches ADE's document for longer than an activation lives.
    vi.advanceTimersByTime(10_000);

    // The user's press went into `pressed`; `stealer` then focuses itself.
    stealer.focus();
    expect(document.activeElement).toBe(stealer);
    expect(frameJustPressed(stealer)).toBe(false);

    // The pointer leaves a frame that holds the focus: the user clicked into it.
    pressed.focus();
    pressed.dispatchEvent(new Event("pointerout", { bubbles: true }));
    expect(frameJustPressed(pressed)).toBe(true);

    // The focus moves again with no input ADE can see.
    stealer.focus();
    expect(frameJustPressed(stealer)).toBe(false);
  });
});

