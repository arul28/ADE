/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCopyToClipboard } from "./useCopyToClipboard";

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
  // jsdom has no execCommand; one test stubs it to prove the fallback is not
  // reached, so drop it rather than leaking a always-succeeds stub.
  Reflect.deleteProperty(document, "execCommand");
});

describe("useCopyToClipboard", () => {
  it("flashes copied, then returns to idle after the timeout", async () => {
    stubClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopyToClipboard({ timeout: 1500 }));

    await act(async () => {
      await result.current.copy("hello");
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current.copied).toBe(false);
  });

  it("returns false and never claims copied when the write rejects", async () => {
    // No `document.execCommand` in jsdom, so the textarea fallback also fails.
    stubClipboard(() => Promise.reject(new Error("denied")));
    const { result } = renderHook(() => useCopyToClipboard());

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.copy("hello");
    });

    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
  });

  it("scopes the confirmation to the key that was copied", async () => {
    stubClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("value-a", "row-a");
    });

    expect(result.current.isCopied("row-a")).toBe(true);
    expect(result.current.isCopied("row-b")).toBe(false);
  });

  it("lets the newest copy win when an older write resolves late", async () => {
    const resolvers: Array<() => void> = [];
    stubClipboard(() => new Promise<void>((resolve) => resolvers.push(resolve)));
    const { result } = renderHook(() => useCopyToClipboard());

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.copy("slow", "row-a");
      second = result.current.copy("fast", "row-b");
    });

    // Settle the newer write first, then let the stale one land.
    await act(async () => {
      resolvers[1]();
      await second;
      resolvers[0]();
      await first;
    });

    expect(result.current.isCopied("row-b")).toBe(true);
    expect(result.current.isCopied("row-a")).toBe(false);
  });

  it("invokes onCopy with the copied text on a successful write", async () => {
    stubClipboard(() => Promise.resolve());
    const onCopy = vi.fn();
    const { result } = renderHook(() => useCopyToClipboard({ onCopy }));

    await act(async () => {
      await result.current.copy("hello");
    });

    // Load-bearing: PinDisplay's digit flash is driven entirely by onCopy.
    expect(onCopy).toHaveBeenCalledWith("hello");
  });

  it("does not invoke onCopy after unmount", async () => {
    let release!: () => void;
    stubClipboard(() => new Promise<void>((resolve) => { release = resolve; }));
    const onCopy = vi.fn();

    const { result, unmount } = renderHook(() => useCopyToClipboard({ onCopy }));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.copy("hello");
    });

    unmount();
    await act(async () => {
      release();
      await pending;
    });

    // The guard's whole job: a write that lands after unmount touches nothing.
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("uses a custom write transport and treats false as a failure", async () => {
    const write = vi.fn<[string], Promise<boolean>>().mockResolvedValue(false);
    const { result } = renderHook(() => useCopyToClipboard({ write }));

    await act(async () => {
      await result.current.copy("hello");
    });

    expect(write).toHaveBeenCalledWith("hello");
    expect(result.current.copied).toBe(false);
  });

  it("treats a throwing custom transport as a failure without using the fallback", async () => {
    // The textarea fallback would silently route around a bespoke transport, so
    // a throw from `write` must fail the copy outright rather than retrying.
    const write = vi.fn<[string], Promise<boolean>>().mockRejectedValue(new Error("denied"));
    const execCommand = vi.fn(() => true);
    (document as unknown as { execCommand: () => boolean }).execCommand = execCommand;
    const { result } = renderHook(() => useCopyToClipboard({ write }));

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.copy("hello");
    });

    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("ignores an in-flight copy that resolves after reset()", async () => {
    let release!: () => void;
    stubClipboard(() => new Promise<void>((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useCopyToClipboard());

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.copy("hello", "row-a");
    });
    act(() => {
      result.current.reset();
    });

    await act(async () => {
      release();
      await pending;
    });

    // reset() bumped the run id, so the older copy may not claim the flash.
    expect(result.current.copied).toBe(false);
    expect(result.current.copiedKey).toBeNull();
  });

  it("reset clears a pending confirmation immediately", async () => {
    stubClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("hello", "row-a");
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.copied).toBe(false);
    expect(result.current.copiedKey).toBeNull();

    // The cancelled run's timer must not resurrect the confirmation.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.copied).toBe(false);
  });

  it("waits out the full timeout measured from the latest copy", async () => {
    stubClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopyToClipboard({ timeout: 1000 }));

    await act(async () => {
      await result.current.copy("one");
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    await act(async () => {
      await result.current.copy("two");
    });

    // 800ms after the second copy: the first copy's window would have closed by
    // now, but the second restarted the clock.
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.copied).toBe(false);
  });
});
