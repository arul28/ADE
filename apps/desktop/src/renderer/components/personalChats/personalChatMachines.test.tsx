/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatSessionSummary, PersonalChatCallArgs, PersonalChatMachineTarget } from "../../../shared/types";
import { usePersonalChatsAcrossMachines, type PersonalChatMachine } from "./personalChatMachines";

// The Chats rail over `window.ade.personalChats` (the IPC boundary these tests
// fake): each call names the machine it is for.
const THIS: PersonalChatMachine = { id: "this-mac", name: "This computer", isThisMachine: true };
const STUDIO: PersonalChatMachine = { id: "target-studio", name: "Studio", isThisMachine: false };

function chat(sessionId: string, lastActivityAt: string): AgentChatSessionSummary {
  return { sessionId, provider: "claude", title: sessionId, lastActivityAt, status: "idle" } as unknown as AgentChatSessionSummary;
}

type Deferred = { resolve: (rows: AgentChatSessionSummary[]) => void };

describe("usePersonalChatsAcrossMachines", () => {
  let pendingLists: Map<string, Deferred[]>;
  let call: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pendingLists = new Map();
    call = vi.fn((request: PersonalChatCallArgs, target?: PersonalChatMachineTarget | null) => {
      const machineId = target?.machineId ?? "unnamed";
      return new Promise((resolve) => {
        const queue = pendingLists.get(machineId) ?? [];
        queue.push({ resolve: (rows) => resolve({ action: request.action, result: rows }) });
        pendingLists.set(machineId, queue);
      });
    });
    (window as unknown as { ade: unknown }).ade = {
      personalChats: {
        call,
        streamEvents: vi.fn().mockResolvedValue({ events: [], nextCursor: 0, hasMore: false }),
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { ade?: unknown }).ade;
  });

  const answer = async (machineId: string, rows: AgentChatSessionSummary[]) => {
    const next = pendingLists.get(machineId)?.shift();
    expect(next, `a pending list read for ${machineId}`).toBeTruthy();
    await act(async () => next!.resolve(rows));
  };

  it("merges every machine's chats, and a machine that left mid-read re-reads instead of showing stale rows", async () => {
    const { result, rerender } = renderHook(
      ({ machines }) => usePersonalChatsAcrossMachines(machines, false),
      { initialProps: { machines: [THIS, STUDIO] } },
    );

    // Each machine is asked for its own list.
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls.map(([, target]) => target?.machineId).sort()).toEqual(["target-studio", "this-mac"]);
    await answer("this-mac", [chat("local-1", "2026-10-18T10:00:00Z")]);

    // The Studio disconnects while its read is in flight, and the late reply lands.
    rerender({ machines: [THIS] });
    await answer("target-studio", [chat("deleted-on-studio", "2026-10-18T12:00:00Z")]);
    expect(result.current.rows.map((row) => row.sessionId)).toEqual(["local-1"]);

    // It reconnects: its list is read again, and only the fresh rows show.
    rerender({ machines: [THIS, STUDIO] });
    await waitFor(() => expect(pendingLists.get("target-studio")?.length).toBe(1));
    await answer("target-studio", [chat("studio-1", "2026-10-18T11:00:00Z")]);

    expect(result.current.rows.map((row) => [row.rowId, row.machineId, row.machineName])).toEqual([
      ["target-studio::studio-1", "target-studio", "Studio"],
      ["this-mac::local-1", "this-mac", null],
    ]);
    expect(result.current.loadByMachine).toEqual({});
  });
});
