import { describe, expect, it } from "vitest";
import type { CodexPendingApprovalRequest, CodexThread } from "../../shared/types";
import {
  codexChatReducer,
  createInitialCodexChatState,
  getActiveTurnId,
  getApprovalForItem,
  getOrderedTurns
} from "./codexChatState";

function at(iso: string): string {
  return iso;
}

function makeThread(): CodexThread {
  return {
    id: "thread-1",
    preview: "Test thread",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    path: null,
    cwd: "/tmp/lane-a",
    cliVersion: "0.1.0",
    source: "app-server",
    gitInfo: null,
    turns: [
      {
        id: "turn-1",
        status: "completed",
        error: null,
        items: [
          {
            id: "item-user-1",
            type: "userMessage",
            content: [{ type: "text", text: "hello" }]
          },
          {
            id: "item-agent-1",
            type: "agentMessage",
            text: "world"
          }
        ]
      }
    ]
  };
}

describe("codexChatReducer", () => {
  it("hydrates from thread/read and appends streaming deltas", () => {
    const initial = createInitialCodexChatState(at("2026-02-19T00:00:00.000Z"));
    const hydrated = codexChatReducer(initial, {
      type: "hydrate-thread",
      thread: makeThread(),
      at: at("2026-02-19T00:00:01.000Z")
    });

    expect(hydrated.threadId).toBe("thread-1");
    expect(getOrderedTurns(hydrated)).toHaveLength(1);
    expect(hydrated.turnsById["turn-1"]?.itemsById["item-agent-1"]?.text).toBe("world");

    const withStreamingTurn = codexChatReducer(hydrated, {
      type: "notification",
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-2",
          status: "running",
          items: [],
          error: null
        }
      },
      receivedAt: at("2026-02-19T00:00:02.000Z")
    });

    const withDelta = codexChatReducer(withStreamingTurn, {
      type: "notification",
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        itemId: "item-agent-2",
        delta: "stream "
      },
      receivedAt: at("2026-02-19T00:00:03.000Z")
    });

    const withSecondDelta = codexChatReducer(withDelta, {
      type: "notification",
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        itemId: "item-agent-2",
        delta: "output"
      },
      receivedAt: at("2026-02-19T00:00:04.000Z")
    });

    expect(withSecondDelta.turnsById["turn-2"]?.itemsById["item-agent-2"]?.text).toBe("stream output");
    expect(getActiveTurnId(withSecondDelta)).toBe("turn-2");
  });

  it("tracks approval requests and resolves by request id", () => {
    const base = codexChatReducer(createInitialCodexChatState(at("2026-02-19T00:00:00.000Z")), {
      type: "hydrate-thread",
      thread: makeThread(),
      at: at("2026-02-19T00:00:01.000Z")
    });

    const approval: CodexPendingApprovalRequest = {
      requestId: "approval-1",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-2",
      itemId: "item-cmd-1",
      reason: "Needs network",
      command: "npm test",
      cwd: "/tmp/lane-a",
      grantRoot: null,
      requestedAt: "2026-02-19T00:00:02.000Z"
    };

    const withApproval = codexChatReducer(base, {
      type: "approval-added",
      request: approval,
      at: at("2026-02-19T00:00:02.000Z")
    });

    expect(getApprovalForItem(withApproval, "item-cmd-1")?.requestId).toBe("approval-1");

    const resolved = codexChatReducer(withApproval, {
      type: "approval-removed",
      requestId: "approval-1",
      at: at("2026-02-19T00:00:03.000Z")
    });

    expect(getApprovalForItem(resolved, "item-cmd-1")).toBeNull();
  });

  it("ignores thread-scoped events for other threads", () => {
    const hydrated = codexChatReducer(createInitialCodexChatState(at("2026-02-19T00:00:00.000Z")), {
      type: "hydrate-thread",
      thread: makeThread(),
      at: at("2026-02-19T00:00:01.000Z")
    });

    const ignored = codexChatReducer(hydrated, {
      type: "notification",
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-2",
        turnId: "turn-9",
        itemId: "item-agent-9",
        delta: "should-not-apply"
      },
      receivedAt: at("2026-02-19T00:00:02.000Z")
    });

    expect(ignored.turnsById["turn-9"]).toBeUndefined();
    expect(ignored.turnsById["turn-1"]?.itemsById["item-agent-1"]?.text).toBe("world");
  });
});
