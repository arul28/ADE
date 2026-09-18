import { describe, expect, it } from "vitest";

import {
  MAC_DESKTOP_DRAG_SLOP_PX,
  createMacDesktopMovePump,
  macDesktopInputRefusal,
  macDesktopKeyCall,
  macDesktopMoveCall,
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
    expect(call.args).toMatchObject({
      laneId: "lane-1",
      x: 11,
      y: 12,
      mode: "real",
      button: "left",
      count: 1,
      silent: true,
    });
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
    expect(call?.kind).toBe("type");
    if (call?.kind !== "type") throw new Error("expected a type");
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
    expect(shortcut?.kind).toBe("press");
    if (shortcut?.kind !== "press") throw new Error("expected a press");
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
    expect(named?.kind).toBe("press");
    if (named?.kind !== "press") throw new Error("expected a press");
    expect(named.args.key).toBe("enter");
    expect(named.args.modifiers).toEqual([]);
  });

  it("does not send a bare modifier as a key the driver will refuse", () => {
    for (const key of ["Control", "Shift", "Meta", "Alt", "CapsLock"]) {
      expect(macDesktopKeyCall(context, {
        key,
        metaKey: key === "Meta",
        shiftKey: key === "Shift",
        altKey: key === "Alt",
        ctrlKey: key === "Control",
      })).toBeNull();
    }
  });

  it("renames ArrowLeft to the driver's left key", () => {
    const call = macDesktopKeyCall(context, {
      key: "ArrowLeft",
      metaKey: true,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
    });
    expect(call?.kind).toBe("press");
    if (call?.kind !== "press") throw new Error("expected a press");
    expect(call.args.key).toBe("left");
    expect(call.args.modifiers).toEqual(["cmd"]);
  });
});

describe("macDesktopInputRefusal", () => {
  it("names the refusal on one line instead of swallowing it", () => {
    expect(macDesktopInputRefusal(new Error("MAC_DESKTOP_USER_HAS_CONTROL")))
      .toBe("Input refused: MAC_DESKTOP_USER_HAS_CONTROL");
    expect(macDesktopInputRefusal("")).toBe("Input refused: unknown error");
    expect(macDesktopInputRefusal(
      new Error("Error invoking remote method 'ade.localRuntime.callAction': Error: invalid_argument: \"control\" is not a key this driver knows."),
    )).toBe("Input refused: \"control\" is not a key this driver knows.");
  });
});

describe("macDesktopMoveCall", () => {
  it("is a real, silent move carrying the lease holder", () => {
    const call = macDesktopMoveCall(context, { x: 42, y: 43 });
    expect(call.kind).toBe("move");
    expect(call.args).toMatchObject({
      laneId: "lane-1",
      x: 42,
      y: 43,
      silent: true,
      controllerId: "ade-window:abc",
      chatSessionId: "chat-1",
    });
  });
});

describe("every forwarded event a takeover sends", () => {
  it("asks for silence, so the user's own input is not observed back at them", () => {
    // The whole set, named individually: a call added later that forgets
    // `silent` turns a keystroke into a screenshot, an AX walk and a line in
    // the chat, and it does it sixty times during one sentence.
    const calls = [
      macDesktopMoveCall(context, { x: 1, y: 1 }),
      macDesktopPointerUpCall(context, { from: null, to: { x: 1, y: 1 }, button: 0, detail: 1 }),
      macDesktopPointerUpCall(context, {
        from: { x: 0, y: 0 },
        to: { x: 100, y: 100 },
        button: 0,
        detail: 1,
      }),
      macDesktopWheelCall(context, { point: { x: 1, y: 1 }, deltaX: 0, deltaY: 60 }),
      macDesktopKeyCall(context, { key: "a", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false }),
      macDesktopKeyCall(context, { key: "Enter", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false }),
    ].filter((call): call is NonNullable<typeof call> => call != null);
    expect(calls.map((call) => call.kind)).toEqual(["move", "click", "drag", "scroll", "type", "press"]);
    for (const call of calls) expect(call.args.silent).toBe(true);
  });
});

describe("createMacDesktopMovePump", () => {
  /** A clock and a scheduler with no real time in them. */
  function harness(intervalMs = 16) {
    const sent: Array<{ x: number; y: number }> = [];
    let nowMs = 0;
    let scheduled: { fn: () => void; at: number; handle: number } | null = null;
    let nextHandle = 1;
    const pump = createMacDesktopMovePump({
      intervalMs,
      send: (point) => sent.push(point),
      now: () => nowMs,
      schedule: (fn, ms) => {
        const handle = nextHandle++;
        scheduled = { fn, at: nowMs + ms, handle };
        return handle;
      },
      cancel: (handle) => {
        if (scheduled?.handle === handle) scheduled = null;
      },
    });
    return {
      pump,
      sent,
      advance(ms: number) {
        nowMs += ms;
        while (scheduled && scheduled.at <= nowMs) {
          const due = scheduled;
          scheduled = null;
          due.fn();
        }
      },
      get pending() {
        return scheduled != null;
      },
    };
  }

  it("sends the first move immediately: the start of a gesture is the latency that shows", () => {
    const { pump, sent } = harness();
    pump.push({ x: 1, y: 1 });
    expect(sent).toEqual([{ x: 1, y: 1 }]);
  });

  it("coalesces a burst into one call carrying only the latest position", () => {
    const { pump, sent, advance } = harness(16);
    pump.push({ x: 1, y: 1 });
    // A 240 Hz trackpad inside one 60 Hz window. Everything but the last one is
    // a position the pointer has already left.
    pump.push({ x: 2, y: 2 });
    pump.push({ x: 3, y: 3 });
    pump.push({ x: 4, y: 4 });
    expect(sent).toEqual([{ x: 1, y: 1 }]);
    advance(16);
    expect(sent).toEqual([{ x: 1, y: 1 }, { x: 4, y: 4 }]);
  });

  it("holds at the rate over a long drag rather than drifting up to the event rate", () => {
    const { pump, sent, advance } = harness(16);
    for (let step = 0; step < 100; step += 1) {
      pump.push({ x: step, y: step });
      advance(4);
    }
    // 400 ms of events at 250 Hz. A 60 Hz cap allows about 25.
    expect(sent.length).toBeLessThanOrEqual(26);
    expect(sent.length).toBeGreaterThan(20);
    expect(sent.at(-1)).toEqual({ x: 99, y: 99 });
  });

  it("drops the pending move when the gesture ends, so nothing posts after unmount", () => {
    const clock = harness(16);
    const { pump, sent, advance } = clock;
    pump.push({ x: 1, y: 1 });
    pump.push({ x: 2, y: 2 });
    expect(clock.pending).toBe(true);
    pump.stop();
    advance(1_000);
    expect(sent).toEqual([{ x: 1, y: 1 }]);
  });
});
