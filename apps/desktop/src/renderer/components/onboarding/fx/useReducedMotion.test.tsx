/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReducedMotion } from "./useReducedMotion";

type Listener = (e: MediaQueryListEvent) => void;

interface MockMql {
  matches: boolean;
  media: string;
  onchange: null;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  addListener?: ReturnType<typeof vi.fn>;
  removeListener?: ReturnType<typeof vi.fn>;
  dispatchEvent: () => boolean;
  dispatchChange: (matches: boolean) => void;
}

function createMql(initial: boolean, options?: { legacy?: boolean }): MockMql {
  const listeners = new Set<Listener>();
  const legacy = options?.legacy === true;
  const mql: MockMql = {
    matches: initial,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn((_evt: string, cb: Listener) => {
      listeners.add(cb);
    }),
    removeEventListener: vi.fn((_evt: string, cb: Listener) => {
      listeners.delete(cb);
    }),
    dispatchEvent: () => false,
    dispatchChange: (matches: boolean) => {
      mql.matches = matches;
      listeners.forEach((cb) => cb({ matches } as MediaQueryListEvent));
    },
  };
  if (legacy) {
    // Legacy Safari API — remove modern listener methods.
    // biome-ignore lint/performance/noDelete: test needs property removal
    delete (mql as Partial<MockMql>).addEventListener;
    // biome-ignore lint/performance/noDelete: test needs property removal
    delete (mql as Partial<MockMql>).removeEventListener;
    mql.addListener = vi.fn((cb: Listener) => {
      listeners.add(cb);
    });
    mql.removeListener = vi.fn((cb: Listener) => {
      listeners.delete(cb);
    });
  }
  return mql;
}

function installMatchMedia(impl: (query: string) => MediaQueryList | MockMql): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: impl,
  });
}

function clearMatchMedia(): void {
  // Remove matchMedia entirely from window to simulate envs without it.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: undefined,
  });
}

afterEach(() => {
  cleanup();
  // Restore a benign matchMedia for the next test.
  installMatchMedia(() => createMql(false) as unknown as MediaQueryList);
});

describe("useReducedMotion", () => {
  it("returns false when window.matchMedia is unavailable", () => {
    clearMatchMedia();
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it("returns the initial matchMedia(...).matches value synchronously", () => {
    const mql = createMql(true);
    installMatchMedia(() => mql as unknown as MediaQueryList);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it("updates when the MediaQueryList emits a change event", () => {
    const mql = createMql(false);
    installMatchMedia(() => mql as unknown as MediaQueryList);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      mql.dispatchChange(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      mql.dispatchChange(false);
    });
    expect(result.current).toBe(false);
  });

  it("falls back to legacy addListener/removeListener when addEventListener is unavailable", () => {
    const mql = createMql(false, { legacy: true });
    installMatchMedia(() => mql as unknown as MediaQueryList);
    const { result, unmount } = renderHook(() => useReducedMotion());
    expect(mql.addListener).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);

    act(() => {
      mql.dispatchChange(true);
    });
    expect(result.current).toBe(true);

    unmount();
    expect(mql.removeListener).toHaveBeenCalledTimes(1);
  });

  it("cleans up listeners on unmount via removeEventListener", () => {
    const mql = createMql(false);
    installMatchMedia(() => mql as unknown as MediaQueryList);
    const { unmount } = renderHook(() => useReducedMotion());
    expect(mql.addEventListener).toHaveBeenCalledTimes(1);
    expect(mql.removeEventListener).not.toHaveBeenCalled();
    unmount();
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
    // Same handler reference added is the one removed.
    const addedHandler = mql.addEventListener.mock.calls[0]?.[1];
    const removedHandler = mql.removeEventListener.mock.calls[0]?.[1];
    expect(removedHandler).toBe(addedHandler);
  });

  it("gracefully handles matchMedia throwing", () => {
    installMatchMedia(() => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });
});
