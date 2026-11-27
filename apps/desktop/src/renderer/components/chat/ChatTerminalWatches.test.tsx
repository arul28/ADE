/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { OpenProjectBinding, RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import type { RemoteRuntimeConnectionStatus } from "../../../shared/types/remoteRuntime";
import type { TerminalWatchSummary } from "../../../shared/terminalWatch";
import { useChatTerminalWatches } from "./ChatTerminalWatches";

const originalAde = globalThis.window.ade;
let clock = 1;

const PIN: OpenProjectBinding = {
  kind: "remote",
  key: "remote:cloud-1:p1",
  targetId: "cloud-1",
  runtimeName: "Cloud lane",
  projectId: "p1",
  rootPath: "/repo",
  displayName: "repo",
};

const ASLEEP = new Error(
  "Error invoking remote method 'ade.remoteRuntime.callAction': Error: Remote ADE service connection failed recently (the computer is asleep). Retrying in 257s.",
);

function watch(): TerminalWatchSummary {
  return {
    watchId: "w-1",
    chatSessionId: "chat-1",
    terminalId: "term-1",
    terminalTitle: "npm run dev",
    match: null,
    armedBy: "agent",
    status: "active",
    startedAt: "2026-11-27T07:00:00.000Z",
    expiresAt: "2026-11-27T09:00:00.000Z",
    stoppedAt: null,
    stopReason: null,
    wakeCount: 0,
    lastWokeAt: null,
    bytesSeen: 0,
    holding: false,
  } as TerminalWatchSummary;
}

/** The chat's computer as the connection feed reports it, and its watch list. */
function installMachine(listWatches: (args: unknown, pin: OpenProjectBinding | null) => Promise<TerminalWatchSummary[]>) {
  const listeners = new Set<(snapshot: RemoteRuntimeConnectionSnapshot) => void>();
  const snapshotOf = (state: RemoteRuntimeConnectionStatus["state"]): RemoteRuntimeConnectionSnapshot => ({
    connections: [{ target: { id: PIN.kind === "remote" ? PIN.targetId : "", name: "Cloud lane", hostname: "cloud" }, state } as RemoteRuntimeConnectionStatus],
    connectedCount: state === "connected" ? 1 : 0,
    updatedAt: (clock += 1),
  });
  let answerFirstRead: (() => void) | null = null;
  const firstRead = new Promise<void>((resolve) => { answerFirstRead = resolve; });
  globalThis.window.ade = {
    remoteRuntime: {
      getConnectionSnapshot: async () => {
        await firstRead;
        return snapshotOf("connected");
      },
      onConnectionSnapshotChanged: (listener: (snapshot: RemoteRuntimeConnectionSnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    terminal: { listWatches },
  } as unknown as typeof window.ade;
  return {
    /** The feed lists the computer as connected. */
    ready: async () => {
      await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
      await act(async () => {
        answerFirstRead?.();
        await firstRead;
      });
    },
    push: (state: RemoteRuntimeConnectionStatus["state"]) => act(() => {
      const snapshot = snapshotOf(state);
      for (const listener of listeners) listener(snapshot);
    }),
  };
}

afterEach(() => {
  cleanup();
  globalThis.window.ade = originalAde;
});

describe("useChatTerminalWatches", () => {
  it("reads the watches again on the chat's computer once its lost link is back", async () => {
    const listWatches = vi.fn()
      .mockRejectedValueOnce(ASLEEP)
      .mockResolvedValueOnce([watch()]);
    const machine = installMachine(listWatches);
    // The chat opens once the feed lists its computer as connected; then its first read finds it asleep.
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: string | null }) => useChatTerminalWatches(chatId, PIN, PIN.key),
      { initialProps: { chatId: null as string | null } },
    );
    await machine.ready();
    expect(listWatches).not.toHaveBeenCalled();
    rerender({ chatId: "chat-1" });

    // Asleep: said as "out of reach", not as an empty list.
    await waitFor(() => expect(result.current.loadFailure).not.toBeNull());
    expect(result.current.loadFailure?.unreachable).toBe(true);
    expect(result.current.watches).toEqual([]);

    machine.push("connecting");
    expect(listWatches).toHaveBeenCalledTimes(1);
    machine.push("connected");

    await waitFor(() => expect(result.current.watches).toHaveLength(1));
    expect(listWatches).toHaveBeenCalledTimes(2);
    expect(listWatches).toHaveBeenLastCalledWith({ chatSessionId: "chat-1" }, PIN);
    expect(result.current.loadFailure).toBeNull();
  });
});
