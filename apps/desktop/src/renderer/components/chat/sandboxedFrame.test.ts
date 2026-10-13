import { describe, expect, it } from "vitest";
import { frameJustPressed, passFrameGate } from "./sandboxedFrame";

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
