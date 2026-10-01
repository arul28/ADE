import { afterEach, describe, expect, it } from "vitest";
import {
  openPrInChatToolsPane,
  requestChatPrSelection,
  subscribeChatPrSelections,
  takeChatPrSelection,
} from "./chatPrPaneRequests";
import {
  resetWorkToolRequestsForTests,
  takePendingWorkToolRequest,
} from "../terminals/workToolRequests";

afterEach(() => {
  resetWorkToolRequestsForTests();
});

describe("chatPrPaneRequests", () => {
  it("keeps a selection meant for another chat held until that chat takes it", () => {
    requestChatPrSelection({ laneId: "lane-a", sessionId: "chat-a", prId: "pr-9" });

    // A pane for a different chat in the same lane must not steal it; the
    // session switch that goes with the selection has not reached it yet.
    expect(takeChatPrSelection("lane-a", "chat-b")).toBeNull();
    expect(takeChatPrSelection("lane-a", "chat-a")).toBe("pr-9");
    // Taken once — a later refresh does not re-pin the same PR.
    expect(takeChatPrSelection("lane-a", "chat-a")).toBeNull();
  });

  it("lets any chat in the lane take a selection that names no session", () => {
    requestChatPrSelection({ laneId: "lane-b", prId: "pr-3" });

    expect(takeChatPrSelection("lane-b", "any-chat")).toBe("pr-3");
  });

  it("notifies live subscribers for the lane until they unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeChatPrSelections((laneId) => seen.push(laneId));

    requestChatPrSelection({ laneId: "lane-c", prId: "pr-4" });
    unsubscribe();
    requestChatPrSelection({ laneId: "lane-c", prId: "pr-5" });

    expect(seen).toEqual(["lane-c"]);
  });

  it("opens the Work PR tool and holds the selection for the pane", () => {
    openPrInChatToolsPane({ laneId: "lane-d", sessionId: "chat-d", prId: "pr-7" });

    expect(takePendingWorkToolRequest()?.tool).toBe("pr");
    expect(takeChatPrSelection("lane-d", "chat-d")).toBe("pr-7");
  });
});
