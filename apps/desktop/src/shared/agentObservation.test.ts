import { describe, expect, it } from "vitest";
import { keyEventsForAgentInput } from "./agentObservation";

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
