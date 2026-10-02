// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { useTranscriptPresentation } from "./chatTranscriptPresentation";

afterEach(cleanup);

const envelope = (timestamp: string, event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
  sessionId: "session-1",
  timestamp,
  event,
});

describe("useTranscriptPresentation", () => {
  // A detached WebFetch's late result settles its row under the turn that
  // called it, after that turn's `done`, while a newer turn is live.
  it("keeps the live turn active when a finished turn receives a late event", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope("2026-10-01T10:00:00.000Z", { type: "status", turnStatus: "started", turnId: "turn-fetch" }),
      envelope("2026-10-01T10:00:01.000Z", { type: "tool_call", tool: "WebFetch", args: {}, itemId: "fetch-1", turnId: "turn-fetch" }),
      envelope("2026-10-01T10:00:02.000Z", { type: "done", turnId: "turn-fetch", status: "completed" }),
      envelope("2026-10-01T10:00:20.000Z", { type: "status", turnStatus: "started", turnId: "turn-live" }),
      envelope("2026-10-01T10:00:21.000Z", {
        type: "tool_result",
        tool: "WebFetch",
        result: "late page",
        itemId: "fetch-1",
        turnId: "turn-fetch",
        status: "completed",
      }),
    ];

    const { result } = renderHook(() => useTranscriptPresentation({ events, rows: [], showStreamingIndicator: true }));

    expect(result.current.activeTurnId).toBe("turn-live");
    expect(result.current.activeTurnStartedAt).toBe(Date.parse("2026-10-01T10:00:20.000Z"));
  });
});
