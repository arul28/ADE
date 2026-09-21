/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenProjectBinding } from "../../../shared/types";
import type { MacDesktopInputResult } from "../../../shared/types/macDesktop";
import {
  macDesktopDriverPayload,
  MAC_DESKTOP_DRAG_SLOP_PX,
  MAC_DESKTOP_MOVE_INTERVAL_MS,
  createMacDesktopMovePump,
  macDesktopInputRefusal,
  macDesktopKeyCall,
  macDesktopMoveCall,
  macDesktopPointerUpCall,
  macDesktopWheelCall,
  useMacDesktopRealInput,
  type MacDesktopInputCall,
  type MacDesktopInputContext,
  type MacDesktopInputSender,
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

  it("takes the lane id out of a refusal when the caller names the lane", () => {
    const laneId = "ab829725-4f40-4c1f-8582-091b500dd26a";
    expect(macDesktopInputRefusal(
      new Error(`MAC_DESKTOP_USER_HAS_CONTROL: Lane ${laneId} is controlled by someone else.`),
      { laneId, laneName: "docs-fix" },
    )).toBe("Input refused: Lane docs-fix is controlled by someone else.");
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

/* ── The injected sender: the same hook off Electron ─────────────────────── */

const SILENT_RESULT: MacDesktopInputResult = {
  ok: true,
  action: "click",
  mode: "real",
  silent: true,
  resolved: null,
  observation: null,
  trace: null,
};

function pointerEvent(
  clientX: number,
  clientY: number,
  overrides: Record<string, unknown> = {},
): ReactPointerEvent<HTMLDivElement> {
  return {
    clientX,
    clientY,
    button: 0,
    detail: 1,
    pointerId: 7,
    currentTarget: { focus: vi.fn(), setPointerCapture: vi.fn() },
    ...overrides,
  } as unknown as ReactPointerEvent<HTMLDivElement>;
}

function keyEvent(
  key: string,
  overrides: Record<string, unknown> = {},
): ReactKeyboardEvent<HTMLDivElement> {
  return {
    key,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as ReactKeyboardEvent<HTMLDivElement>;
}

function renderInput(
  sender: MacDesktopInputSender,
  overrides: Partial<Parameters<typeof useMacDesktopRealInput>[0]> = {},
) {
  return renderHook(() => useMacDesktopRealInput({
    laneId: "lane-1",
    sessionId: null,
    controllerId: "tab-token-1",
    enabled: true,
    toDisplayPoint: (x, y) => ({ x, y }),
    runtimePin: null,
    sender,
    forwardPointerMoves: true,
    ...overrides,
  }));
}

describe("useMacDesktopRealInput with an injected sender", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("forwards a click through the sender with the controller token", async () => {
    const sender = vi.fn(async (_call: MacDesktopInputCall) => SILENT_RESULT);
    const { result } = renderInput(sender);

    await act(async () => {
      result.current.onPointerDown(pointerEvent(10, 11));
      result.current.onPointerUp(pointerEvent(10, 11));
    });

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0]![0]).toMatchObject({
      kind: "click",
      args: {
        laneId: "lane-1",
        x: 10,
        y: 11,
        mode: "real",
        silent: true,
        controllerId: "tab-token-1",
      },
    });
  });

  it("never sends a modifier-only key, the same rule as the desktop", () => {
    const sender = vi.fn(async (_call: MacDesktopInputCall) => SILENT_RESULT);
    const { result } = renderInput(sender);

    act(() => {
      result.current.onKeyDown(keyEvent("Shift", { shiftKey: true }));
      result.current.onKeyDown(keyEvent("Meta", { metaKey: true }));
    });

    expect(sender).not.toHaveBeenCalled();
  });

  it("coalesces a burst of moves to one per frame, latest position only", async () => {
    vi.useFakeTimers();
    const sender = vi.fn(async (_call: MacDesktopInputCall) => SILENT_RESULT);
    const { result } = renderInput(sender);

    act(() => {
      result.current.onPointerMove(pointerEvent(1, 1));
    });
    // The first move of a gesture goes immediately: that is the latency that
    // shows at the start of a drag.
    expect(sender).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.onPointerMove(pointerEvent(2, 2));
      result.current.onPointerMove(pointerEvent(3, 3));
    });
    expect(sender).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(MAC_DESKTOP_MOVE_INTERVAL_MS + 1);
    });
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.calls[1]![0]).toMatchObject({
      kind: "move",
      args: { laneId: "lane-1", x: 3, y: 3, silent: true, controllerId: "tab-token-1" },
    });
  });

  it("does not forward moves when the caller has not opted in", () => {
    const sender = vi.fn(async (_call: MacDesktopInputCall) => SILENT_RESULT);
    const { result } = renderInput(sender, { forwardPointerMoves: false });

    act(() => {
      result.current.onPointerMove(pointerEvent(4, 4));
    });

    expect(sender).not.toHaveBeenCalled();
    // The local glyph still follows the pointer; only the forwarded call is
    // withheld, which is the desktop's behavior.
    expect(result.current.cursorFeed.current).toEqual({ x: 4, y: 4 });
  });

  it("continues the gesture when the element refuses pointer capture", async () => {
    // A CDP-synthesized click surfaced this: `setPointerCapture` threw on the
    // synthetic pointer id, the press point was never recorded, and the whole
    // gesture was dropped before `pointerup`. The click must still go through.
    const sender = vi.fn(async (_call: MacDesktopInputCall) => SILENT_RESULT);
    const { result } = renderInput(sender);
    const capture = vi.fn(() => {
      throw new Error("InvalidPointerId");
    });

    await act(async () => {
      result.current.onPointerDown(pointerEvent(10, 11, {
        currentTarget: { focus: vi.fn(), setPointerCapture: capture },
      }));
      result.current.onPointerUp(pointerEvent(12, 13));
    });

    expect(capture).toHaveBeenCalledWith(7);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0]![0]).toMatchObject({
      kind: "click",
      args: { laneId: "lane-1", x: 12, y: 13, controllerId: "tab-token-1" },
    });
  });

  it("surfaces a refusal on the strip error line, and clears it", async () => {
    const sender = vi.fn(async (_call: MacDesktopInputCall) => {
      throw new Error("MAC_DESKTOP_USER_HAS_CONTROL");
    });
    const { result } = renderInput(sender);

    await act(async () => {
      result.current.onPointerUp(pointerEvent(1, 2));
    });
    expect(result.current.inputError).toBe("Input refused: MAC_DESKTOP_USER_HAS_CONTROL");

    act(() => { result.current.clearInputError(); });
    expect(result.current.inputError).toBeNull();
  });
});

/* ── The desktop's own dispatch: a takeover on another Mac ──────────────── */

const STUDIO_PIN: OpenProjectBinding = {
  kind: "remote",
  key: "remote:target-studio:project-a",
  targetId: "target-studio",
  runtimeName: "Mac Studio",
  transport: "paired",
  projectId: "project-a",
  rootPath: "/repo",
  displayName: "ADE",
};

describe("useMacDesktopRealInput with the Mac Desktop namespace", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("forwards a takeover click to the focused chat's machine", async () => {
    const click = vi.fn(async () => SILENT_RESULT);
    (window as unknown as { ade: unknown }).ade = { macDesktop: { click } };
    const { result } = renderHook(() => useMacDesktopRealInput({
      laneId: "lane-1",
      sessionId: "chat-1",
      controllerId: "ade-window:1",
      enabled: true,
      toDisplayPoint: (x, y) => ({ x, y }),
      runtimePin: STUDIO_PIN,
    }));

    await act(async () => {
      result.current.onPointerDown(pointerEvent(10, 11));
      result.current.onPointerUp(pointerEvent(11, 12));
    });

    expect(click).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        x: 11,
        y: 12,
        mode: "real",
        controllerId: "ade-window:1",
      }),
      // The pin, not the project tab: this is a click on a display that lives
      // on the Studio.
      STUDIO_PIN,
    );
  });
});

describe("macDesktopDriverPayload", () => {
  // The fast path posts straight to the driver, which never saw the
  // renderer's flat args: forwarding them as-is left click and scroll
  // unrecognised, and a takeover could move but not click or scroll.
  const context = { laneId: "lane-1", chatSessionId: "chat-1", controllerId: "ade-window:x" };

  it("shapes move, click and scroll the way the driver reads them", () => {
    expect(macDesktopDriverPayload(macDesktopMoveCall(context, { x: 10, y: 20 })))
      .toEqual({ to: { x: 10, y: 20 } });
    expect(macDesktopDriverPayload(macDesktopPointerUpCall(context, { from: null, to: { x: 3, y: 4 }, button: 0, detail: 1 })))
      .toEqual({ at: { x: 3, y: 4 }, button: "left", count: 1 });
    expect(macDesktopDriverPayload(macDesktopWheelCall(context, { point: { x: 5, y: 6 }, deltaX: 0, deltaY: 120 })))
      .toMatchObject({ x: 5, y: 6, direction: "down" });
  });
});
