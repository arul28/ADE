/* @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSceneOnScreen } from "./useSceneOnScreen";

/**
 * When a scene's frame is up. A scene runs while it is on screen and for a
 * short linger after it leaves, so a scroll past and back does not reload it —
 * but a scene scrolled away DURING its own turn still unmounts, or a
 * ten-minute turn would keep every scene it ever drew executing.
 */

type Entry = { isIntersecting: boolean };

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: (entries: Entry[]) => void;
  elements: Element[] = [];
  constructor(callback: (entries: Entry[]) => void) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element): void { this.elements.push(element); }
  disconnect(): void {}
  trigger(entries: Entry[]): void { this.callback(entries); }
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
});

function renderObserver(ignoreScroll: boolean) {
  const target = { current: document.createElement("div") };
  return {
    target,
    ...renderHook(() => useSceneOnScreen(target, true, { ignoreScroll })),
  };
}

describe("useSceneOnScreen", () => {
  it("mounts only after the scene has dwelled on screen", async () => {
    vi.useFakeTimers();
    const { result } = renderObserver(true);
    const observer = FakeIntersectionObserver.instances[0]!;
    expect(result.current).toBe(false);

    act(() => observer.trigger([{ isIntersecting: true }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(result.current).toBe(true);
  });

  it("unmounts a scene that leaves the screen during its own turn, after the linger", async () => {
    vi.useFakeTimers();
    const { result } = renderObserver(true);
    const observer = FakeIntersectionObserver.instances[0]!;
    act(() => observer.trigger([{ isIntersecting: true }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(result.current).toBe(true);

    act(() => observer.trigger([{ isIntersecting: false }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_999); });
    // Still up through the linger: a scroll back is not a reload.
    expect(result.current).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(result.current).toBe(false);
  });

  it("does not observe at all while disabled", () => {
    const target = { current: document.createElement("div") };
    const { result } = renderHook(() => useSceneOnScreen(target, false));
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    expect(result.current).toBe(false);
  });
});
