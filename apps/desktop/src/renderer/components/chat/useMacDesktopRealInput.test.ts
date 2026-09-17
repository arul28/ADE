import { describe, expect, it } from "vitest";

import {
  MAC_DESKTOP_DRAG_SLOP_PX,
  macDesktopInputRefusal,
  macDesktopKeyCall,
  macDesktopPointerUpCall,
  macDesktopWheelCall,
  type MacDesktopInputContext,
} from "./useMacDesktopRealInput";

const context: MacDesktopInputContext = {
  laneId: "lane-1",
  chatSessionId: "chat-1",
  controllerId: "ade-window:abc",
};

describe("macDesktopPointerUpCall", () => {
  it("sends a click with the controller id the lease is held under", () => {
    const call = macDesktopPointerUpCall(context, {
      from: { x: 10, y: 10 },
      to: { x: 11, y: 12 },
      button: 0,
      detail: 1,
    });
    expect(call.kind).toBe("click");
    // The regression this exists for: the host checks the LEASE HOLDER, which
    // is this window's controller id, and a payload carrying only the chat
    // session id was refused for input the user had just taken control for.
    expect(call.args.controllerId).toBe("ade-window:abc");
    expect(call.args.chatSessionId).toBe("chat-1");
    expect(call.args).toMatchObject({ laneId: "lane-1", x: 11, y: 12, mode: "real", button: "left", count: 1 });
  });

  it("reads the right button and the double click off the event", () => {
    const call = macDesktopPointerUpCall(context, {
      from: null,
      to: { x: 1, y: 1 },
      button: 2,
      detail: 2,
    });
    expect(call.args).toMatchObject({ button: "right", count: 2 });
  });

  it("sends a drag once the release is past the slop, with the controller id", () => {
    const call = macDesktopPointerUpCall(context, {
      from: { x: 0, y: 0 },
      to: { x: MAC_DESKTOP_DRAG_SLOP_PX + 1, y: 0 },
      button: 0,
      detail: 1,
    });
    expect(call.kind).toBe("drag");
    expect(call.args.controllerId).toBe("ade-window:abc");
    if (call.kind !== "drag") throw new Error("expected a drag");
    expect(call.args.from).toEqual({ x: 0, y: 0 });
    expect(call.args.to).toEqual({ x: 5, y: 0 });
  });

  it("stays a click when there was no press point to compare against", () => {
    const call = macDesktopPointerUpCall(context, {
      from: null,
      to: { x: 500, y: 500 },
      button: 0,
      detail: 1,
    });
    expect(call.kind).toBe("click");
  });
});

describe("macDesktopWheelCall", () => {
  it("picks the dominant axis, its direction and a clamped amount", () => {
    const down = macDesktopWheelCall(context, { point: { x: 4, y: 5 }, deltaX: 2, deltaY: 100 });
    expect(down.args).toMatchObject({ direction: "down", amount: 5, x: 4, y: 5 });
    expect(down.args.controllerId).toBe("ade-window:abc");

    const left = macDesktopWheelCall(context, { point: { x: 0, y: 0 }, deltaX: -60, deltaY: 1 });
    expect(left.args).toMatchObject({ direction: "left", amount: 3 });

    const tiny = macDesktopWheelCall(context, { point: { x: 0, y: 0 }, deltaX: 0, deltaY: 1 });
    expect(tiny.args).toMatchObject({ direction: "down", amount: 1 });
  });
});

describe("macDesktopKeyCall", () => {
  it("types a bare printable character as text", () => {
    const call = macDesktopKeyCall(context, {
      key: "a",
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
    });
    expect(call.kind).toBe("type");
    if (call.kind !== "type") throw new Error("expected a type");
    expect(call.args.text).toBe("a");
    expect(call.args.controllerId).toBe("ade-window:abc");
  });

  it("presses everything else, with the modifiers the event carried", () => {
    const shortcut = macDesktopKeyCall(context, {
      key: "S",
      metaKey: true,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
    });
    expect(shortcut.kind).toBe("press");
    if (shortcut.kind !== "press") throw new Error("expected a press");
    expect(shortcut.args.key).toBe("s");
    expect(shortcut.args.modifiers).toEqual(["cmd", "shift"]);
    expect(shortcut.args.controllerId).toBe("ade-window:abc");

    const named = macDesktopKeyCall(context, {
      key: "Enter",
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
    });
    expect(named.kind).toBe("press");
    if (named.kind !== "press") throw new Error("expected a press");
    expect(named.args.key).toBe("enter");
    expect(named.args.modifiers).toEqual([]);
  });
});

describe("macDesktopInputRefusal", () => {
  it("names the refusal on one line instead of swallowing it", () => {
    expect(macDesktopInputRefusal(new Error("MAC_DESKTOP_USER_HAS_CONTROL")))
      .toBe("Input refused: MAC_DESKTOP_USER_HAS_CONTROL");
    expect(macDesktopInputRefusal("")).toBe("Input refused: unknown error");
  });
});
