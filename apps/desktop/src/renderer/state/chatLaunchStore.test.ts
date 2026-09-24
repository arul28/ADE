/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatLaunchSnapshot, ChatLaunchStage, OpenProjectBinding, TerminalSessionSummary } from "../../shared/types";
import {
  applyChatLaunchEvent,
  applyChatLaunchSnapshot,
  buildOptimisticChatLaunchSnapshot,
  chatLaunchStore,
  getChatLaunchEntry,
  getChatLaunchOriginClientId,
  hydrateChatLaunches,
  insertOptimisticChatLaunch,
  markChatLaunchStartFailed,
  resetChatLaunchStartFailure,
  resetChatLaunchStoreForTests,
  useChatLaunchForPane,
  useChatLaunchRowSources,
  useChatLaunchRowState,
  useChatLaunchStatusLine,
} from "./chatLaunchStore";
import { createChatLaunchEventCoalescer } from "./useChatLaunchSync";
import {
  buildChatLaunchThreadEvents,
  mergeChatLaunchRows,
  selectRosterChatLaunches,
} from "../components/chat/launch/chatLaunchSynthetic";
import {
  resetChatLaunchDraftRestoreForTests,
  subscribeChatLaunchClosed,
  type ChatLaunchClosedNotice,
} from "../components/chat/launch/chatLaunchDraftRestore";

const BINDING_A: OpenProjectBinding = { kind: "local", key: "local:/a", rootPath: "/a", displayName: "a" };
const BINDING_B: OpenProjectBinding = { kind: "local", key: "local:/b", rootPath: "/b", displayName: "b" };

function optimistic(launchId: string, overrides: Partial<ChatLaunchSnapshot> = {}): ChatLaunchSnapshot {
  return {
    ...buildOptimisticChatLaunchSnapshot({
      launch: {
        kind: "chat",
        mode: "foreground",
        launchId,
        laneId: `lane-${launchId}`,
        laneName: "Fix Login Redirect",
        prompt: "Fix the login redirect",
        originClientId: "window-1",
      },
      includeFetch: true,
      nowIso: "2026-09-22T10:00:00.000Z",
    }),
    ...overrides,
  };
}

afterEach(() => {
  resetChatLaunchStoreForTests();
  resetChatLaunchDraftRestoreForTests();
});

describe("chatLaunchStore", () => {
  it("predicts fetch/checkout/agent stages and reserves the session id for a chat", () => {
    const snapshot = optimistic("launch-1");
    expect(snapshot.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ["fetch", "pending"],
      ["checkout", "pending"],
      ["agent", "pending"],
    ]);
    expect(snapshot.sessionId).toBe("launch-1");
    expect(snapshot.phase).toBe("running");
    const local = buildOptimisticChatLaunchSnapshot({
      launch: { kind: "cli", mode: "background", launchId: "l2", laneId: "x", laneName: "y", prompt: "p" },
      includeFetch: false,
    });
    expect(local.stages.map((stage) => stage.id)).toEqual(["checkout", "agent"]);
    expect(local.sessionId).toBeNull();
  });

  it("lets the host's first snapshot replace the optimistic one, then only newer ones", () => {
    insertOptimisticChatLaunch(BINDING_A, optimistic("launch-1", { sequence: 5 }));
    applyChatLaunchSnapshot(BINDING_A, optimistic("launch-1", { sequence: 0, laneName: "Host name" }));
    expect(getChatLaunchEntry("launch-1")?.snapshot.laneName).toBe("Host name");
    expect(getChatLaunchEntry("launch-1")?.hostSeen).toBe(true);

    applyChatLaunchSnapshot(BINDING_A, optimistic("launch-1", { sequence: 3, laneName: "Newer" }));
    applyChatLaunchSnapshot(BINDING_A, optimistic("launch-1", { sequence: 2, laneName: "Stale" }));
    expect(getChatLaunchEntry("launch-1")?.snapshot.laneName).toBe("Newer");
    // An optimistic insert never overwrites a snapshot the host already sent.
    insertOptimisticChatLaunch(BINDING_A, optimistic("launch-1", { laneName: "Local" }));
    expect(getChatLaunchEntry("launch-1")?.snapshot.laneName).toBe("Newer");
  });

  it("hydrates one binding without dropping another binding's or unacknowledged launches", () => {
    insertOptimisticChatLaunch(BINDING_A, optimistic("pending-start"));
    applyChatLaunchSnapshot(BINDING_A, optimistic("host-dropped", { sequence: 1 }));
    applyChatLaunchSnapshot(BINDING_B, optimistic("other-machine", { sequence: 1 }));

    hydrateChatLaunches(BINDING_A, [optimistic("listed", { sequence: 4 })]);

    const ids = Object.keys(chatLaunchStore.getState().entries).sort();
    expect(ids).toEqual(["listed", "other-machine", "pending-start"]);
    expect(getChatLaunchEntry("listed")?.bindingKey).toBe(BINDING_A.key);
  });

  it("removes a launch on launch-removed", () => {
    applyChatLaunchSnapshot(BINDING_A, optimistic("launch-1", { sequence: 1 }));
    applyChatLaunchEvent(BINDING_A, { type: "launch-removed", launchId: "launch-1" });
    expect(getChatLaunchEntry("launch-1")).toBeNull();
  });

  it("marks a rejected start as failed on its first open stage and can reset it for retry", () => {
    insertOptimisticChatLaunch(BINDING_A, optimistic("launch-1"));
    markChatLaunchStartFailed("launch-1", "Runtime disconnected");
    const failed = getChatLaunchEntry("launch-1")!;
    expect(failed.startError).toBe("Runtime disconnected");
    expect(failed.snapshot.phase).toBe("failed");
    expect(failed.snapshot.stages[0]).toMatchObject({ id: "fetch", status: "failed", error: "Runtime disconnected" });

    resetChatLaunchStartFailure("launch-1");
    const reset = getChatLaunchEntry("launch-1")!;
    expect(reset.startError).toBeNull();
    expect(reset.snapshot.phase).toBe("running");
    expect(reset.snapshot.stages[0]?.status).toBe("pending");
  });

  it("announces a launch closed once, when a host snapshot first moves it to cancelled", () => {
    const notices: ChatLaunchClosedNotice[] = [];
    const unsubscribe = subscribeChatLaunchClosed((notice) => notices.push(notice));
    // A launch first seen already cancelled (window start-up) has no tab to close.
    hydrateChatLaunches(BINDING_A, [optimistic("old", { phase: "cancelled", sequence: 3 })]);
    applyChatLaunchSnapshot(BINDING_A, optimistic("launch-1", { sequence: 1 }));
    expect(notices).toEqual([]);

    applyChatLaunchEvent(BINDING_A, { type: "launch-updated", launch: optimistic("launch-1", { phase: "cancelled", sequence: 2 }) });
    hydrateChatLaunches(BINDING_A, [optimistic("launch-1", { phase: "cancelled", sequence: 2 })]);
    expect(notices).toEqual([{ launchId: "launch-1", sessionId: "launch-1", kind: "chat", restoresPrompt: false }]);

    applyChatLaunchSnapshot(BINDING_A, optimistic("launch-2", { sequence: 1 }));
    hydrateChatLaunches(BINDING_A, [optimistic("launch-2", { phase: "cancelled", sequence: 4 })]);
    expect(notices.map((notice) => notice.launchId)).toEqual(["launch-1", "launch-2"]);
    unsubscribe();
  });

  it("keeps one origin client id per window", () => {
    const first = getChatLaunchOriginClientId();
    expect(first).toMatch(/^desktop-window:/);
    expect(getChatLaunchOriginClientId()).toBe(first);
    expect(window.sessionStorage.getItem("ade.chatLaunch.originClientId")).toBe(first);
  });
});

describe("chat launch stand-ins", () => {
  const realRow = { id: "launch-1", laneId: "lane-launch-1", title: "Real", startedAt: "2026-09-22T10:00:01.000Z" } as TerminalSessionSummary;

  it("lists a pending chat under its reserved id until the real row arrives", () => {
    const merged = mergeChatLaunchRows([], [optimistic("launch-1")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "launch-1", laneId: "lane-launch-1", laneName: "Fix Login Redirect" });

    const withReal = mergeChatLaunchRows([realRow], [optimistic("launch-1")]);
    expect(withReal).toEqual([realRow]);
    expect(mergeChatLaunchRows([], [optimistic("launch-1")], new Set(["launch-1"]))).toEqual([]);
    expect(mergeChatLaunchRows([], [optimistic("launch-1", { phase: "cancelled" })])).toEqual([]);
    // Once the chat exists and the agent runs, only the host's row lists it.
    expect(mergeChatLaunchRows([], [optimistic("launch-1", { sessionCreated: true, agentStarted: true, phase: "completed" })])).toEqual([]);
    expect(mergeChatLaunchRows([], [optimistic("launch-1", { sessionCreated: true })])).toHaveLength(1);
  });

  it("lists launches of this binding and of the same project on another machine only", () => {
    const source = (launchId: string, binding: OpenProjectBinding) => ({
      snapshot: optimistic(launchId),
      binding,
      bindingKey: binding.key,
    });
    const selected = selectRosterChatLaunches(
      [source("mine", BINDING_A), source("studio", BINDING_B), source("elsewhere", { ...BINDING_B, key: "local:/c" })],
      BINDING_A.key,
      new Set([BINDING_B.key]),
    );
    expect(selected.map((launch) => launch.launchId)).toEqual(["mine", "studio"]);
  });

  it("renders the prompt, the setup card and queued messages until the transcript has them", () => {
    const snapshot = optimistic("launch-1", {
      queuedMessages: [{ id: "q1", text: "Also check the logout", createdAt: "2026-09-22T10:00:02.000Z" }],
    });
    const events = buildChatLaunchThreadEvents(snapshot, []);
    expect(events.map((envelope) => envelope.event.type)).toEqual(["user_message", "ade_card", "user_message"]);
    expect(events[1]?.event).toMatchObject({ type: "ade_card", variant: "lane_setup", cardId: "lane-setup:launch-1" });
    expect(events[2]?.event).toMatchObject({ deliveryState: "queued", text: "Also check the logout" });

    const real = [
      { sessionId: "launch-1", timestamp: "t", event: { type: "user_message" as const, text: "Fix the login redirect" } },
      { sessionId: "launch-1", timestamp: "t", event: { ...events[1]!.event, title: "real" } as never },
    ];
    const replaced = buildChatLaunchThreadEvents({ ...snapshot, agentStarted: true }, real);
    expect(replaced).toEqual(real);
  });

  it("keeps undelivered queued messages after the agent started, the failed one as failed-to-send", () => {
    const real = [
      { sessionId: "launch-1", timestamp: "t", event: { type: "user_message" as const, text: "Fix the login redirect" } },
    ];
    const started = optimistic("launch-1", {
      agentStarted: true,
      sessionCreated: true,
      phase: "completed",
      queuedMessages: [
        { id: "q1", text: "Also check the logout", createdAt: "2026-09-22T10:00:02.000Z", deliveryError: "Session is busy." },
        { id: "q2", text: "And the signup", createdAt: "2026-09-22T10:00:03.000Z" },
      ],
    });
    const queued = buildChatLaunchThreadEvents(started, real)
      .filter((envelope) => envelope.event.type === "user_message" && envelope.event.messageId?.startsWith("launch-queued:"))
      .map((envelope) => envelope.event);
    expect(queued).toEqual([
      expect.objectContaining({ text: "Also check the logout", deliveryState: "failed", metadata: { launchDeliveryError: "Session is busy." } }),
      expect.objectContaining({ text: "And the signup", deliveryState: "queued" }),
    ]);

    // Mid-delivery with nothing failed: the real rows are about to land, so no stand-ins.
    const delivering = { ...started, queuedMessages: [{ id: "q3", text: "One more", createdAt: "2026-09-22T10:00:04.000Z" }] };
    expect(buildChatLaunchThreadEvents(delivering, real).some((envelope) => (
      envelope.event.type === "user_message" && envelope.event.messageId === "launch-queued:q3"
    ))).toBe(false);
  });

  it("re-renders a pane when a queued message's delivery fails", () => {
    applyChatLaunchSnapshot(BINDING_A, optimistic("launch-1", {
      sequence: 1,
      agentStarted: true,
      queuedMessages: [{ id: "q1", text: "x", createdAt: "2026-09-22T10:00:02.000Z" }],
    }));
    const { result } = renderHook(() => useChatLaunchForPane("launch-1"));
    const before = result.current;
    act(() => {
      applyChatLaunchSnapshot(BINDING_A, optimistic("launch-1", {
        sequence: 2,
        agentStarted: true,
        queuedMessages: [{ id: "q1", text: "x", createdAt: "2026-09-22T10:00:02.000Z", deliveryError: "boom" }],
      }));
    });
    expect(result.current).not.toBe(before);
    expect(result.current?.queuedMessages[0]?.deliveryError).toBe("boom");
  });
});

describe("chat launch render isolation", () => {
  function checkoutAt(launchId: string, percent: number, sequence: number): ChatLaunchSnapshot {
    const stages: ChatLaunchStage[] = [
      { id: "fetch", status: "done", startedAt: "2026-09-22T10:00:00.000Z", endedAt: "2026-09-22T10:00:00.300Z", percent: null, detail: "origin/main at 524a0ac", error: null },
      { id: "checkout", status: "running", startedAt: "2026-09-22T10:00:00.300Z", endedAt: null, percent, detail: null, error: null },
      { id: "agent", status: "pending", startedAt: null, endedAt: null, percent: null, detail: null, error: null },
    ];
    // Fresh objects every time, as a snapshot that crossed IPC would be.
    return optimistic(launchId, { sequence, stages: JSON.parse(JSON.stringify(stages)) });
  }

  it("keeps unchanged stage objects across snapshots so memoized rows skip", () => {
    applyChatLaunchSnapshot(BINDING_A, checkoutAt("launch-1", 10, 1));
    const before = getChatLaunchEntry("launch-1")!.snapshot;
    applyChatLaunchSnapshot(BINDING_A, checkoutAt("launch-1", 11, 2));
    const after = getChatLaunchEntry("launch-1")!.snapshot;
    expect(after).not.toBe(before);
    expect(after.stages).not.toBe(before.stages);
    expect(after.stages[0]).toBe(before.stages[0]);
    expect(after.stages[1]).not.toBe(before.stages[1]);
    expect(after.stages[1]?.percent).toBe(11);
    expect(after.stages[2]).toBe(before.stages[2]);

    // A snapshot whose stages did not move keeps the stage array itself.
    applyChatLaunchSnapshot(BINDING_A, { ...checkoutAt("launch-1", 11, 3), laneName: "Renamed" });
    expect(getChatLaunchEntry("launch-1")!.snapshot.stages).toBe(after.stages);
  });

  it("does not re-render the Work roster, the sidebar row or the chat pane on a checkout tick", () => {
    applyChatLaunchSnapshot(BINDING_A, checkoutAt("launch-1", 10, 1));
    applyChatLaunchSnapshot(BINDING_A, checkoutAt("launch-2", 50, 1));
    const renders = { roster: 0, row: 0, pane: 0, status: 0 };
    const roster = renderHook(() => { renders.roster += 1; return useChatLaunchRowSources(); });
    const row = renderHook(() => { renders.row += 1; return useChatLaunchRowState("launch-2"); });
    const pane = renderHook(() => { renders.pane += 1; return useChatLaunchForPane("launch-2"); });
    const status = renderHook(() => { renders.status += 1; return useChatLaunchStatusLine("launch-2"); });
    const first = { roster: roster.result.current, row: row.result.current, pane: pane.result.current };
    const baseline = { ...renders };

    act(() => {
      for (let i = 2; i <= 9; i += 1) applyChatLaunchSnapshot(BINDING_A, checkoutAt("launch-1", 10 + i, i));
      for (let i = 2; i <= 9; i += 1) applyChatLaunchSnapshot(BINDING_A, checkoutAt("launch-2", 50 + i, i));
    });

    expect(roster.result.current).toBe(first.roster);
    expect(row.result.current).toBe(first.row);
    expect(pane.result.current).toBe(first.pane);
    expect(renders.roster).toBe(baseline.roster);
    expect(renders.row).toBe(baseline.row);
    expect(renders.pane).toBe(baseline.pane);
    // Only the status text follows the ticks of its own launch.
    expect(status.result.current).toBe("Checking out files · 59%");
    expect(renders.status).toBeGreaterThan(baseline.status);
    expect(renders.status).toBeLessThanOrEqual(baseline.status + 8);
  });

  it("coalesces a burst of launch events into one store write per launch", () => {
    vi.useFakeTimers();
    try {
      const applied: string[] = [];
      const coalescer = createChatLaunchEventCoalescer((_binding, event) => {
        applied.push(event.type === "launch-updated" ? `${event.launch.launchId}@${event.launch.sequence}` : `-${event.launchId}`);
      }, 50);
      coalescer.push(BINDING_A, { type: "launch-updated", launch: checkoutAt("a", 10, 1) });
      coalescer.push(BINDING_A, { type: "launch-updated", launch: checkoutAt("a", 20, 3) });
      coalescer.push(BINDING_A, { type: "launch-updated", launch: checkoutAt("a", 15, 2) });
      coalescer.push(BINDING_A, { type: "launch-updated", launch: checkoutAt("b", 10, 1) });
      coalescer.push(BINDING_A, { type: "launch-removed", launchId: "b" });
      expect(applied).toEqual([]);
      vi.advanceTimersByTime(60);
      expect(applied).toEqual(["a@3", "-b"]);
      coalescer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
