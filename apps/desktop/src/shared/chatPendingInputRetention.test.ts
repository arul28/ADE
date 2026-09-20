import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "./types";
import {
  retainUnresolvedApprovalRequests,
  unresolvedApprovalRequestEnvelopes,
} from "./chatPendingInputRetention";

function envelope(index: number, event: Record<string, unknown>): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp: `2026-03-17T10:00:${String(index).padStart(2, "0")}.000Z`,
    event,
  } as never;
}

const text = (index: number) => envelope(index, { type: "text", text: `t${index}` });
const request = (index: number, itemId: string) =>
  envelope(index, { type: "approval_request", itemId, kind: "tool_call", description: "?" });
const resolved = (index: number, itemId: string) =>
  envelope(index, { type: "pending_input_resolved", itemId, resolution: "accepted" });

describe("unresolvedApprovalRequestEnvelopes", () => {
  it("keeps a request with no receipt", () => {
    const events = [request(1, "a"), text(2)];
    expect(unresolvedApprovalRequestEnvelopes(events)).toEqual([events[0]]);
  });

  it("drops a request once a receipt arrives", () => {
    expect(unresolvedApprovalRequestEnvelopes([request(1, "a"), resolved(2, "a")])).toEqual([]);
  });

  it("drops a request an auto-approval review settled", () => {
    const events = [
      request(1, "a"),
      envelope(2, { type: "auto_approval_review", targetItemId: "a", reviewStatus: "completed" }),
    ];
    expect(unresolvedApprovalRequestEnvelopes(events)).toEqual([]);
  });

  it("keeps only the newest request for a re-raised item id", () => {
    const events = [request(1, "a"), request(2, "a")];
    expect(unresolvedApprovalRequestEnvelopes(events)).toEqual([events[1]]);
  });
});

describe("retainUnresolvedApprovalRequests", () => {
  it("re-admits a card the window dropped, in its original position", () => {
    const events = [request(1, "a"), text(2), text(3), text(4)];
    const windowed = events.slice(-2);
    expect(retainUnresolvedApprovalRequests(events, windowed)).toEqual([
      events[0],
      events[2],
      events[3],
    ]);
  });

  it("leaves a window that already holds the card untouched", () => {
    const events = [text(1), request(2, "a"), text(3)];
    const windowed = events.slice(-2);
    expect(retainUnresolvedApprovalRequests(events, windowed)).toEqual(windowed);
  });

  it("does not re-admit an answered card", () => {
    const events = [request(1, "a"), resolved(2, "a"), text(3), text(4)];
    const windowed = events.slice(-2);
    expect(retainUnresolvedApprovalRequests(events, windowed)).toEqual(windowed);
  });

  it("re-admits several cards in chronological order", () => {
    const events = [request(1, "a"), text(2), request(3, "b"), text(4), text(5)];
    const windowed = events.slice(-1);
    expect(retainUnresolvedApprovalRequests(events, windowed)).toEqual([
      events[0],
      events[2],
      events[4],
    ]);
  });
});
