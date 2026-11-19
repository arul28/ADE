/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { OpenProjectBinding, RemoteRuntimeConnectionSnapshot } from "../../shared/types";
import type { RemoteRuntimeConnectionStatus } from "../../shared/types/remoteRuntime";
import { useReadRetryOnReconnect } from "./projectMachines";

const originalAde = globalThis.window.ade;
let clock = 1;

function remotePin(targetId: string): OpenProjectBinding {
  return { kind: "remote", key: `remote:${targetId}:p1`, targetId, runtimeName: targetId, projectId: "p1", rootPath: "/repo", displayName: "repo" };
}

function connection(targetId: string, state: RemoteRuntimeConnectionStatus["state"], extra: Partial<RemoteRuntimeConnectionStatus> = {}) {
  return { target: { id: targetId, name: targetId, hostname: targetId }, state, ...extra } as RemoteRuntimeConnectionStatus;
}

/**
 * The window's connection feed. Its first read answers `initial` when the test
 * calls `answer()`; `push` sends a later snapshot.
 */
function installFeed(initial: RemoteRuntimeConnectionStatus) {
  const listeners = new Set<(snapshot: RemoteRuntimeConnectionSnapshot) => void>();
  const snapshotOf = (entry: RemoteRuntimeConnectionStatus): RemoteRuntimeConnectionSnapshot => ({
    connections: [entry],
    connectedCount: entry.state === "connected" ? 1 : 0,
    updatedAt: (clock += 1),
  });
  let answerFirstRead: (() => void) | null = null;
  const firstRead = new Promise<void>((resolve) => { answerFirstRead = resolve; });
  globalThis.window.ade = {
    remoteRuntime: {
      getConnectionSnapshot: async () => {
        await firstRead;
        return snapshotOf(initial);
      },
      onConnectionSnapshotChanged: (listener: (snapshot: RemoteRuntimeConnectionSnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as typeof window.ade;
  return {
    answer: async () => {
      await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
      await act(async () => {
        answerFirstRead?.();
        await firstRead;
      });
    },
    push: (entry: RemoteRuntimeConnectionStatus) => act(() => {
      const snapshot = snapshotOf(entry);
      for (const listener of listeners) listener(snapshot);
    }),
  };
}

const LINK_LOST = Object.assign(
  new Error("Connection lost — outcome unknown. Check the current state before retrying."),
  { code: "connection_lost_outcome_unknown" },
);

afterEach(() => {
  // Unmounting stops the shared feed, so the next test starts it on its own bridge.
  cleanup();
  globalThis.window.ade = originalAde;
});

describe("useReadRetryOnReconnect", () => {
  it("reads again once, after the link the read lost is back", async () => {
    const feed = installFeed(connection("mac-1", "connected"));
    const { result } = renderHook(() => useReadRetryOnReconnect(remotePin("mac-1")));
    await feed.answer();

    let willRetry = false;
    act(() => { willRetry = result.current.begin()(LINK_LOST); });
    expect(willRetry).toBe(true);
    expect(result.current.retryKey).toBe(0);

    feed.push(connection("mac-1", "connecting"));
    expect(result.current.retryKey).toBe(0);
    feed.push(connection("mac-1", "connected"));
    expect(result.current.retryKey).toBe(1);

    // One lost read, one read again: a later drop and return does not repeat it.
    feed.push(connection("mac-1", "connecting"));
    feed.push(connection("mac-1", "connected"));
    expect(result.current.retryKey).toBe(1);
  });

  it("reads again when a read sent before the feed listed the machine lost its link", async () => {
    const feed = installFeed(connection("mac-5", "connected"));
    const { result } = renderHook(() => useReadRetryOnReconnect(remotePin("mac-5")));

    act(() => { result.current.begin()(LINK_LOST); });
    expect(result.current.retryKey).toBe(0);
    await feed.answer();
    expect(result.current.retryKey).toBe(1);
  });

  it("waits out ADE Web's held reconnect, which still reads as connected", async () => {
    const feed = installFeed(connection("mac-2", "connected"));
    const { result } = renderHook(() => useReadRetryOnReconnect(remotePin("mac-2")));
    await feed.answer();

    act(() => { result.current.begin()(LINK_LOST); });
    feed.push(connection("mac-2", "connected", { reconnectingSinceMs: 1_000 }));
    expect(result.current.retryKey).toBe(0);
    feed.push(connection("mac-2", "connected"));
    expect(result.current.retryKey).toBe(1);
  });

  it("reads again at once when the link came back before the failure landed", async () => {
    const feed = installFeed(connection("mac-3", "connected"));
    const { result } = renderHook(() => useReadRetryOnReconnect(remotePin("mac-3")));
    await feed.answer();

    const failed = result.current.begin();
    feed.push(connection("mac-3", "connecting"));
    feed.push(connection("mac-3", "connected"));
    act(() => { failed(LINK_LOST); });
    expect(result.current.retryKey).toBe(1);
  });

  it.each([
    ["an answer from the machine", remotePin("mac-4"), new Error("Chat session 'chat-1' was not found.")],
    ["a pin on this computer", { kind: "local", key: "local:/repo", rootPath: "/repo", displayName: "repo" } as OpenProjectBinding, LINK_LOST],
    ["no pin", null, LINK_LOST],
  ])("never reads again for %s", async (_label, pin, error) => {
    const feed = installFeed(connection("mac-4", "connected"));
    const { result } = renderHook(() => useReadRetryOnReconnect(pin));
    if (pin?.kind === "remote") await feed.answer();

    let willRetry = true;
    act(() => { willRetry = result.current.begin()(error); });
    expect(willRetry).toBe(false);
    feed.push(connection("mac-4", "connecting"));
    feed.push(connection("mac-4", "connected"));
    expect(result.current.retryKey).toBe(0);
  });
});
