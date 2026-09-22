/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";
import { appleKeyText, useAppleDeviceInput } from "./useAppleDeviceInput";

const pinRef = { current: null as OpenProjectBinding | null };

function install(api: Record<string, unknown>) {
  (window as unknown as { ade: unknown }).ade = { iosSimulator: api };
}

const render = (enabled = true, deviceUdid: string | null = "device-1") =>
  renderHook(() => useAppleDeviceInput({
    deviceUdid,
    laneId: "lane-1",
    chatSessionId: "chat-1",
    enabled,
    runtimePinRef: pinRef,
  }));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useAppleDeviceInput", () => {
  it("sends a press that did not travel as exactly one tap", async () => {
    const tap = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    const drag = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    install({ tap, drag });
    const { result } = render();

    await act(async () => {
      result.current.send({ phase: "begin", x: 100.4, y: 200.6 });
      result.current.send({ phase: "move", x: 102, y: 201 });
      result.current.send({ phase: "end", x: 101, y: 202 });
    });

    expect(drag).not.toHaveBeenCalled();
    expect(tap).toHaveBeenCalledTimes(1);
    expect(tap.mock.calls[0]?.[0]).toMatchObject({
      deviceUdid: "device-1",
      x: 101,
      y: 202,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
  });

  it("sends a press that travelled as one drag, not a tap at the end of it", async () => {
    // Round 3, A1: round 2 threw begin and move away and tapped wherever the
    // finger lifted, so scrolling a list, swiping a row and dragging a slider
    // all did nothing at all.
    const tap = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    const drag = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    install({ tap, drag });
    const { result } = render();

    await act(async () => {
      result.current.send({ phase: "begin", x: 100, y: 600 });
      result.current.send({ phase: "move", x: 100, y: 400 });
      result.current.send({ phase: "end", x: 100, y: 200 });
    });

    expect(tap).not.toHaveBeenCalled();
    expect(drag).toHaveBeenCalledTimes(1);
    expect(drag.mock.calls[0]?.[0]).toMatchObject({
      startX: 100,
      startY: 600,
      endX: 100,
      endY: 200,
    });
    // Long enough that UIKit's velocity tracker reads a drag, not a flick.
    expect(Number(drag.mock.calls[0]?.[0]?.durationMs)).toBeGreaterThanOrEqual(60);
  });

  it("sends one action per gesture, however many pointer events it took", async () => {
    // The other half of A1: every action is an `ade/actions/call` on a serial
    // control queue, so a live-streamed move-per-event would be the timeout
    // storm the desktop log filled up with.
    const tap = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    const drag = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    install({ tap, drag });
    const { result } = render();

    await act(async () => {
      result.current.send({ phase: "begin", x: 10, y: 600 });
      for (let step = 0; step < 40; step += 1) {
        result.current.send({ phase: "move", x: 10, y: 600 - (step * 10) });
      }
      result.current.send({ phase: "end", x: 10, y: 200 });
    });

    expect(tap).not.toHaveBeenCalled();
    expect(drag).toHaveBeenCalledTimes(1);
  });

  it("turns a wheel into a finger moving the other way", async () => {
    const drag = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    install({ tap: vi.fn(), drag });
    const { result } = render();

    await act(async () => {
      result.current.scroll({ x: 200, y: 400, deltaX: 0, deltaY: 120 });
    });

    expect(drag).toHaveBeenCalledTimes(1);
    // Content down means finger up: iOS has no scroll event, only touches.
    expect(drag.mock.calls[0]?.[0]).toMatchObject({ startY: 400, endY: 280 });
  });

  it("types what a key produces and leaves shortcuts alone", async () => {
    const typeText = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    install({ typeText });
    const { result } = render();

    let sent = false;
    await act(async () => {
      sent = result.current.key({ key: "a", metaKey: false, ctrlKey: false, altKey: false });
    });
    expect(sent).toBe(true);
    expect(typeText).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUdid: "device-1", text: "a" }),
      null,
    );

    await act(async () => {
      expect(result.current.key({ key: "r", metaKey: true, ctrlKey: false, altKey: false })).toBe(false);
      expect(result.current.key({ key: "ArrowUp", metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
    });
    expect(typeText).toHaveBeenCalledTimes(1);
  });

  it("drops every event while input is not allowed", async () => {
    const tap = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    const drag = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    const typeText = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    install({ tap, drag, typeText });
    const { result } = render(false);

    await act(async () => {
      result.current.send({ phase: "begin", x: 1, y: 1 });
      result.current.send({ phase: "end", x: 1, y: 1 });
      result.current.scroll({ x: 1, y: 1, deltaX: 0, deltaY: 10 });
      result.current.key({ key: "a", metaKey: false, ctrlKey: false, altKey: false });
    });

    expect(tap).not.toHaveBeenCalled();
    expect(drag).not.toHaveBeenCalled();
    expect(typeText).not.toHaveBeenCalled();
  });

  it("ignores an end with no begin behind it", async () => {
    const tap = vi.fn(async (_args: Record<string, unknown>, _pin?: unknown) => ({ ok: true as const }));
    install({ tap });
    const { result } = render();

    await act(async () => {
      result.current.send({ phase: "end", x: 5, y: 5 });
    });
    expect(tap).not.toHaveBeenCalled();
  });
});

describe("appleKeyText", () => {
  it("only answers for something the device can type", () => {
    expect(appleKeyText({ key: "x", metaKey: false, ctrlKey: false, altKey: false })).toBe("x");
    expect(appleKeyText({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false })).toBe("\n");
    expect(appleKeyText({ key: "Backspace", metaKey: false, ctrlKey: false, altKey: false })).toBeNull();
    expect(appleKeyText({ key: "x", metaKey: true, ctrlKey: false, altKey: false })).toBeNull();
  });
});
