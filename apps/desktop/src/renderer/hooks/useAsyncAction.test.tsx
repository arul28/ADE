/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useAsyncAction } from "./useAsyncAction";

afterEach(() => {
  cleanup();
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAsyncAction", () => {
  it("reports pending while the action is in flight and clears it on settle", async () => {
    const gate = deferred();
    const { result } = renderHook(() => useAsyncAction({ action: () => gate.promise }));

    expect(result.current.pending).toBe(false);

    act(() => {
      result.current.run();
    });
    expect(result.current.pending).toBe(true);

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(result.current.pending).toBe(false);
  });

  it("ignores a second run while one is already pending", async () => {
    const action = vi.fn(() => deferred().promise);
    const { result } = renderHook(() => useAsyncAction({ action }));

    // `run` schedules the action on a microtask, so flush before asserting.
    await act(async () => {
      result.current.run();
      result.current.run();
      result.current.run();
      await Promise.resolve();
    });

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh run once the previous one settled", async () => {
    const gates = [deferred(), deferred()];
    let call = 0;
    const action = vi.fn(() => gates[call++]!.promise);
    const { result } = renderHook(() => useAsyncAction({ action }));

    act(() => {
      result.current.run();
    });
    await act(async () => {
      gates[0]!.resolve();
      await gates[0]!.promise;
    });

    await act(async () => {
      result.current.run();
      await Promise.resolve();
    });

    expect(action).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toBe(true);
  });

  it("routes a rejection to onError and still clears pending", async () => {
    const gate = deferred();
    const onError = vi.fn();
    const { result } = renderHook(() => useAsyncAction({ action: () => gate.promise, onError }));

    act(() => {
      result.current.run();
    });
    await act(async () => {
      gate.reject(new Error("boom"));
      await gate.promise.catch(() => {});
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe("boom");
    expect(result.current.pending).toBe(false);
  });

  it("routes a synchronous throw to onError rather than escaping run()", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useAsyncAction({
      action: () => { throw new Error("sync boom"); },
      onError,
    }));

    await act(async () => {
      result.current.run();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(false);
  });

  it("invokes onSuccess with the action's resolved value", async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useAsyncAction({
      action: async () => "done",
      onSuccess,
    }));

    await act(async () => {
      result.current.run();
      await Promise.resolve();
    });

    expect(onSuccess).toHaveBeenCalledWith("done");
  });

  it("does not invoke onSuccess after unmount", async () => {
    const gate = deferred();
    const onSuccess = vi.fn();
    const { result, unmount } = renderHook(() => useAsyncAction({
      action: () => gate.promise,
      onSuccess,
    }));

    act(() => {
      result.current.run();
    });
    unmount();

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });

    // The guard's whole job: a settle that lands after unmount touches nothing.
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
