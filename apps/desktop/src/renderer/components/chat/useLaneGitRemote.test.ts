/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { OpenProjectBinding } from "../../../shared/types/core";
import { useLaneGitRemote } from "./useLaneGitRemote";

type OriginRemote = { remoteUrl: string | null; branch: string | null };

let getOriginRemote: ReturnType<typeof vi.fn>;

function installGitBridge(implementation?: ReturnType<typeof vi.fn>) {
  getOriginRemote = implementation ?? vi.fn();
  (window as unknown as { ade: unknown }).ade = {
    git: { getOriginRemote },
  };
}

/**
 * Advances fake timers and flushes the microtask queue React needs to apply the
 * state the resolved promise sets. `vi.advanceTimersByTime` alone leaves the
 * `.then` callback queued, so the assertion after it would read stale state.
 */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Flushes pending promise callbacks without moving the clock. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useLaneGitRemote", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installGitBridge();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("stays idle and reads nothing without a lane", async () => {
    const { result } = renderHook(() => useLaneGitRemote(null));

    expect(result.current.status).toBe("idle");
    expect(result.current.remoteUrl).toBeNull();
    expect(result.current.branch).toBeNull();
    expect(result.current.error).toBeNull();
    expect(getOriginRemote).not.toHaveBeenCalled();
  });

  it("reports loading, then the remote it read", async () => {
    let resolveRead: ((value: OriginRemote) => void) | null = null;
    getOriginRemote.mockImplementation(() => new Promise<OriginRemote>((resolve) => {
      resolveRead = resolve;
    }));

    const { result } = renderHook(() => useLaneGitRemote("lane-1"));

    expect(result.current.status).toBe("loading");
    expect(getOriginRemote).toHaveBeenCalledWith({ laneId: "lane-1" });

    await act(async () => {
      resolveRead?.({ remoteUrl: "git@github.com:acme/project.git", branch: "ade/feature" });
      await Promise.resolve();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.remoteUrl).toBe("git@github.com:acme/project.git");
    expect(result.current.branch).toBe("ade/feature");
    expect(result.current.error).toBeNull();
  });

  it("reports a lane with no remote as ready and empty, not as a failure", async () => {
    getOriginRemote.mockResolvedValue({ remoteUrl: null, branch: "main" });

    const { result } = renderHook(() => useLaneGitRemote("lane-1"));
    await flush();

    expect(result.current.status).toBe("ready");
    expect(result.current.remoteUrl).toBeNull();
    expect(result.current.branch).toBe("main");
  });

  it("passes the runtime pin when the caller supplies one", async () => {
    getOriginRemote.mockResolvedValue({ remoteUrl: null, branch: null });
    const pin = { kind: "remote", key: "remote:studio:project-a" } as unknown as OpenProjectBinding;

    renderHook(() => useLaneGitRemote("lane-1", pin));
    await flush();

    expect(getOriginRemote).toHaveBeenCalledWith({ laneId: "lane-1" }, pin);
  });

  it("surfaces the failure message and clears it on the first automatic retry", async () => {
    getOriginRemote
      .mockRejectedValueOnce(new Error("Error invoking remote method 'git:getOriginRemote': git is not installed"))
      .mockResolvedValue({ remoteUrl: "git@github.com:acme/project.git", branch: "main" });

    const { result } = renderHook(() => useLaneGitRemote("lane-1"));
    await flush();

    expect(result.current.status).toBe("error");
    // The IPC wrapper is stripped so the reason reads as the real cause.
    expect(result.current.error).toBe("git is not installed");
    expect(result.current.remoteUrl).toBeNull();

    await advance(1_000);

    expect(getOriginRemote).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
    expect(result.current.remoteUrl).toBe("git@github.com:acme/project.git");
  });

  it("backs off 1s, 3s and 8s and then stops retrying", async () => {
    getOriginRemote.mockRejectedValue(new Error("origin unreachable"));

    const { result } = renderHook(() => useLaneGitRemote("lane-1"));
    await flush();
    expect(getOriginRemote).toHaveBeenCalledTimes(1);

    await advance(999);
    expect(getOriginRemote).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getOriginRemote).toHaveBeenCalledTimes(2);

    await advance(2_999);
    expect(getOriginRemote).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getOriginRemote).toHaveBeenCalledTimes(3);

    await advance(7_999);
    expect(getOriginRemote).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(getOriginRemote).toHaveBeenCalledTimes(4);

    // Four attempts is the whole budget. The hook now waits for `refetch()`.
    await advance(60_000);
    expect(getOriginRemote).toHaveBeenCalledTimes(4);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("origin unreachable");
  });

  it("restarts the whole sequence from refetch", async () => {
    getOriginRemote.mockRejectedValue(new Error("origin unreachable"));

    const { result } = renderHook(() => useLaneGitRemote("lane-1"));
    await flush();
    await advance(1_000);
    await advance(3_000);
    await advance(8_000);
    expect(getOriginRemote).toHaveBeenCalledTimes(4);

    getOriginRemote.mockResolvedValue({ remoteUrl: "git@github.com:acme/project.git", branch: "main" });
    await act(async () => {
      result.current.refetch();
      await Promise.resolve();
    });

    expect(getOriginRemote).toHaveBeenCalledTimes(5);
    await flush();
    expect(result.current.status).toBe("ready");
    expect(result.current.remoteUrl).toBe("git@github.com:acme/project.git");
  });

  it("drops a slow answer for the lane the user left", async () => {
    const pending: Array<(value: OriginRemote) => void> = [];
    getOriginRemote.mockImplementation(() => new Promise<OriginRemote>((resolve) => {
      pending.push(resolve);
    }));

    const { result, rerender } = renderHook(
      ({ laneId }: { laneId: string }) => useLaneGitRemote(laneId),
      { initialProps: { laneId: "lane-1" } },
    );

    rerender({ laneId: "lane-2" });
    expect(result.current.status).toBe("loading");
    expect(result.current.remoteUrl).toBeNull();

    // lane-1's read lands late. It must not become lane-2's answer.
    await act(async () => {
      pending[0]?.({ remoteUrl: "git@github.com:acme/lane-one.git", branch: "lane-one" });
      await Promise.resolve();
    });
    expect(result.current.status).toBe("loading");
    expect(result.current.remoteUrl).toBeNull();

    await act(async () => {
      pending[1]?.({ remoteUrl: "git@github.com:acme/lane-two.git", branch: "lane-two" });
      await Promise.resolve();
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.remoteUrl).toBe("git@github.com:acme/lane-two.git");
    expect(result.current.branch).toBe("lane-two");
  });

  it("cancels a scheduled retry when the lane changes", async () => {
    getOriginRemote.mockRejectedValue(new Error("origin unreachable"));

    const { rerender } = renderHook(
      ({ laneId }: { laneId: string }) => useLaneGitRemote(laneId),
      { initialProps: { laneId: "lane-1" } },
    );
    await flush();
    expect(getOriginRemote).toHaveBeenCalledTimes(1);

    rerender({ laneId: "lane-2" });
    await flush();
    expect(getOriginRemote).toHaveBeenLastCalledWith({ laneId: "lane-2" });
    const callsAfterSwitch = getOriginRemote.mock.calls.length;

    // Only lane-2's own retry may fire. Two new calls would mean lane-1's
    // pending timer survived the switch.
    await advance(1_000);
    expect(getOriginRemote.mock.calls.length).toBe(callsAfterSwitch + 1);
    expect(getOriginRemote).toHaveBeenLastCalledWith({ laneId: "lane-2" });
  });

  it("stops retrying after unmount", async () => {
    getOriginRemote.mockRejectedValue(new Error("origin unreachable"));

    const { unmount } = renderHook(() => useLaneGitRemote("lane-1"));
    await flush();
    expect(getOriginRemote).toHaveBeenCalledTimes(1);

    unmount();
    await advance(20_000);
    expect(getOriginRemote).toHaveBeenCalledTimes(1);
  });

  it("says so when the window has no git bridge at all", async () => {
    (window as unknown as { ade: unknown }).ade = {};

    const { result } = renderHook(() => useLaneGitRemote("lane-1"));
    await flush();

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Git is unavailable in this window.");
  });
});
