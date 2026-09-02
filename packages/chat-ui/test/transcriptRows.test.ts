import { describe, expect, it } from "vitest";

import type { AgentChatEvent, AgentChatEventEnvelope } from "../src/sdkTypes";
import {
  buildTranscriptRows,
  collapseTranscriptEvents,
  groupTranscriptRows,
  mergeStreamingText,
  resolveToolName,
  shouldMergeTextRows,
  type ApprovalRow,
  type ToolChipRow,
} from "../src/transcript/transcriptRows";

let sequence = 0;
function envelope(event: AgentChatEvent, timestamp?: string): AgentChatEventEnvelope {
  sequence += 1;
  return {
    sessionId: "session",
    timestamp: timestamp ?? `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    sequence,
    event,
  };
}

/** The one approval row, wherever the other rendered events put it. */
function onlyApproval(rows: ReturnType<typeof collapseTranscriptEvents>): ApprovalRow {
  const found = rows.map((row) => row.event).filter((event) => event.type === "approval");
  if (found.length !== 1) throw new Error(`expected one approval row, found ${found.length}`);
  return found[0] as ApprovalRow;
}

describe("mergeStreamingText", () => {
  it("replaces when the incoming chunk is a growing snapshot", () => {
    expect(mergeStreamingText("Hel", "Hello")).toBe("Hello");
  });

  it("appends when the incoming chunk is a delta", () => {
    expect(mergeStreamingText("Hel", "lo")).toBe("Hello");
  });

  it("treats an empty side as a no-op", () => {
    expect(mergeStreamingText("", "Hello")).toBe("Hello");
    expect(mergeStreamingText("Hello", "")).toBe("Hello");
  });
});

describe("shouldMergeTextRows", () => {
  it("merges matching message ids", () => {
    expect(
      shouldMergeTextRows({ type: "text", text: "a", messageId: "m1" }, { type: "text", text: "b", messageId: "m1" }),
    ).toBe(true);
  });

  it("refuses to merge different message ids", () => {
    expect(
      shouldMergeTextRows({ type: "text", text: "a", messageId: "m1" }, { type: "text", text: "b", messageId: "m2" }),
    ).toBe(false);
  });

  it("falls back to turn and item when only one side has an id", () => {
    expect(
      shouldMergeTextRows(
        { type: "text", text: "a", messageId: "m1", turnId: "t1", itemId: "i1" },
        { type: "text", text: "b", turnId: "t1", itemId: "i1" },
      ),
    ).toBe(true);
    expect(
      shouldMergeTextRows(
        { type: "text", text: "a", messageId: "m1", turnId: "t1" },
        { type: "text", text: "b", turnId: "t2" },
      ),
    ).toBe(false);
  });

  it("merges identity-free events from providers that send none", () => {
    expect(shouldMergeTextRows({ type: "text", text: "a" }, { type: "text", text: "b" })).toBe(true);
  });
});

describe("collapseTranscriptEvents", () => {
  it("folds a streamed message into one row", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "text", text: "Hello", messageId: "m1" }),
      envelope({ type: "text", text: " there", messageId: "m1" }),
      envelope({ type: "text", text: "!", messageId: "m1" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({ type: "text", text: "Hello there!" });
  });

  it("keeps distinct messages apart", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "text", text: "one", messageId: "m1" }),
      envelope({ type: "text", text: "two", messageId: "m2" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("upgrades a tool_call chip in place when its result lands", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "tool_call", tool: "search", args: { q: "x" }, itemId: "i1", turnId: "t1" }),
      envelope({
        type: "tool_result",
        tool: "search",
        result: { hits: 2 },
        itemId: "i1",
        turnId: "t1",
        status: "completed",
      }),
    ]);
    expect(rows).toHaveLength(1);
    const chip = rows[0]!.event as ToolChipRow;
    expect(chip).toMatchObject({
      type: "tool_chip",
      tool: "search",
      status: "completed",
      args: { q: "x" },
      result: { hits: 2 },
    });
  });

  it("matches call and result on logicalItemId when the provider renumbers items", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "tool_call", tool: "search", args: {}, itemId: "call_1", logicalItemId: "L1", turnId: "t1" }),
      envelope({
        type: "tool_result",
        tool: "search",
        result: "ok",
        itemId: "result_9",
        logicalItemId: "L1",
        turnId: "t1",
      }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("renders an orphan tool_result as its own chip", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "tool_result", tool: "search", result: "ok", itemId: "i1", status: "failed" }),
    ]);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.event as ToolChipRow).status).toBe("failed");
  });

  it("drops event kinds this package does not draw", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "text", text: "hi", messageId: "m1" }),
      // No cast: `AgentChatEvent` is open, so an ADE-only kind from a newer
      // runtime type-checks and must be ignored, not rendered as an empty row.
      envelope({ type: "plan", steps: [] }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("gives each row a stable key across recomputation", () => {
    const events = [
      envelope({ type: "user_message", text: "hi" }),
      envelope({ type: "text", text: "hello", messageId: "m1" }),
    ];
    expect(collapseTranscriptEvents(events).map((row) => row.key)).toEqual(
      collapseTranscriptEvents(events).map((row) => row.key),
    );
  });
});

describe("groupTranscriptRows", () => {
  it("merges consecutive reasoning from the same block", () => {
    const rows = buildTranscriptRows([
      envelope({ type: "reasoning", text: "first", turnId: "t1", itemId: "i1", summaryIndex: 0 }),
      envelope({ type: "reasoning", text: "second", turnId: "t1", itemId: "i1", summaryIndex: 0 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({ type: "reasoning", text: "first\n\n---\n\nsecond" });
  });

  it("keeps reasoning from different blocks separate", () => {
    const rows = buildTranscriptRows([
      envelope({ type: "reasoning", text: "a", turnId: "t1", itemId: "i1", summaryIndex: 0 }),
      envelope({ type: "reasoning", text: "b", turnId: "t1", itemId: "i1", summaryIndex: 1 }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("collapses repeated identical status rows", () => {
    const rows = groupTranscriptRows(
      collapseTranscriptEvents([
        envelope({ type: "status", turnStatus: "started", turnId: "t1" }),
        envelope({ type: "status", turnStatus: "started", turnId: "t1" }),
        envelope({ type: "status", turnStatus: "completed", turnId: "t1" }),
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("resolveToolName", () => {
  it("prefers a payload title when the provider only said 'tool'", () => {
    expect(resolveToolName("tool", { title: "Search invoices" })).toBe("Search invoices");
    expect(resolveToolName("other", { title: "Search invoices" })).toBe("Search invoices");
  });

  it("keeps a real tool name even when a title exists", () => {
    expect(resolveToolName("Bash", { title: "Search invoices" })).toBe("Bash");
  });

  it("keeps the generic name when there is no title", () => {
    expect(resolveToolName("tool", { q: 1 })).toBe("tool");
  });
});

/**
 * Approvals are the one row a reader can act on, so the rules that keep one
 * visible and honest are load-bearing. A card that vanishes, or one that still
 * offers buttons after the turn died, is worse than none: the person waits for
 * a reply that can never come.
 */
describe("approval rows", () => {
  function approvalOf(rows: ReturnType<typeof collapseTranscriptEvents>, index = 0): ApprovalRow {
    const event = rows[index]!.event;
    if (event.type !== "approval") throw new Error(`row ${index} is ${event.type}`);
    return event;
  }

  it("draws an approval_request as a pending card", () => {
    const rows = collapseTranscriptEvents([
      envelope({
        type: "approval_request",
        itemId: "item-1",
        kind: "command",
        description: "Run a shell command",
        turnId: "t1",
        detail: { command: "ls -la" },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(approvalOf(rows)).toMatchObject({
      type: "approval",
      id: "item-1",
      kind: "command",
      description: "Run a shell command",
      turnId: "t1",
      state: "pending",
      detail: { command: "ls -la" },
    });
  });

  it("settles the card in place rather than adding a second row", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "approval_request", itemId: "item-1", kind: "command", description: "Run it" }),
      envelope({ type: "pending_input_resolved", itemId: "item-1", resolution: "accepted" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(approvalOf(rows).state).toBe("accepted");
  });

  it("maps declined and cancelled onto their own settled states", () => {
    expect(
      approvalOf(
        collapseTranscriptEvents([
          envelope({ type: "approval_request", itemId: "a", kind: "tool_call", description: "x" }),
          envelope({ type: "pending_input_resolved", itemId: "a", resolution: "declined" }),
        ]),
      ).state,
    ).toBe("rejected");
    expect(
      approvalOf(
        collapseTranscriptEvents([
          envelope({ type: "approval_request", itemId: "b", kind: "tool_call", description: "x" }),
          envelope({ type: "pending_input_resolved", itemId: "b", resolution: "cancelled" }),
        ]),
      ).state,
    ).toBe("cancelled");
  });

  it("matches a resolution to its request through logicalItemId", () => {
    // Providers renumber items between the ask and the answer; matching on the
    // raw itemId alone would leave the card pending forever.
    const rows = collapseTranscriptEvents([
      envelope({
        type: "approval_request",
        itemId: "item-1",
        logicalItemId: "logical-1",
        kind: "file_change",
        description: "Write a file",
      }),
      envelope({ type: "pending_input_resolved", itemId: "logical-1", resolution: "accepted" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(approvalOf(rows).state).toBe("accepted");
  });

  it("keeps the decision when the request is replayed", () => {
    // History and the live stream overlap on reconnect. Re-reading the request
    // must not put answered buttons back on screen.
    const rows = collapseTranscriptEvents([
      envelope({ type: "approval_request", itemId: "item-1", kind: "command", description: "Run it" }),
      envelope({ type: "pending_input_resolved", itemId: "item-1", resolution: "accepted" }),
      envelope({ type: "approval_request", itemId: "item-1", kind: "command", description: "Run it" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(approvalOf(rows).state).toBe("accepted");
  });

  it("expires a still-pending card when the turn ends", () => {
    // `done` is not a drawn kind, so this only works because the turn-ending
    // check runs before the rendered-kind filter.
    const rows = collapseTranscriptEvents([
      envelope({ type: "approval_request", itemId: "item-1", kind: "command", description: "Run it", turnId: "t1" }),
      envelope({ type: "done", turnId: "t1" }),
    ]);
    expect(approvalOf(rows).state).toBe("expired");
  });

  it("expires on a completed, failed or interrupted status", () => {
    for (const turnStatus of ["completed", "failed", "interrupted"] as const) {
      const rows = collapseTranscriptEvents([
        envelope({ type: "approval_request", itemId: "i", kind: "command", description: "Run it", turnId: "t1" }),
        envelope({ type: "status", turnStatus, turnId: "t1" }),
      ]);
      expect(approvalOf(rows).state).toBe("expired");
    }
  });

  it("leaves a card pending when an error arrives mid-turn", () => {
    // An `error` is NOT a turn ending. An OpenCode per-tool failure emits one
    // and keeps streaming the same turn, and the Codex planning-approval guard
    // emits one to decline a single request. Expiring the card here disables
    // the buttons on a request the runtime is still blocked on.
    const rows = collapseTranscriptEvents([
      envelope({ type: "approval_request", itemId: "item-1", kind: "command", description: "Run it", turnId: "t1" }),
      envelope({ type: "error", turnId: "t1", message: "tool failed" }),
    ]);
    expect(onlyApproval(rows).state).toBe("pending");
  });

  it("leaves a card pending when a turn-less error arrives", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "approval_request", itemId: "item-1", kind: "command", description: "Run it", turnId: "t1" }),
      envelope({ type: "error", message: "declined one request" }),
    ]);
    expect(onlyApproval(rows).state).toBe("pending");
  });

  it("leaves a card of another turn pending, and never un-settles an answer", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "approval_request", itemId: "old", kind: "command", description: "Old", turnId: "t1" }),
      envelope({ type: "pending_input_resolved", itemId: "old", resolution: "accepted" }),
      envelope({ type: "approval_request", itemId: "new", kind: "command", description: "New", turnId: "t2" }),
      envelope({ type: "status", turnStatus: "completed", turnId: "t1" }),
    ]);
    expect(approvalOf(rows, 0).state).toBe("accepted");
    expect(approvalOf(rows, 1).state).toBe("pending");
  });

  it("does not start a turn's approval over on a status it has already seen", () => {
    // `status: started` is not an ending and must leave pending cards alone.
    const rows = collapseTranscriptEvents([
      envelope({ type: "approval_request", itemId: "i", kind: "command", description: "Run it", turnId: "t1" }),
      envelope({ type: "status", turnStatus: "started", turnId: "t1" }),
    ]);
    expect(approvalOf(rows).state).toBe("pending");
  });

  it("drops a resolution whose request is outside the history window", () => {
    // There is no description to draw, so inventing a card would show the
    // reader an approval they cannot read.
    const rows = collapseTranscriptEvents([
      envelope({ type: "pending_input_resolved", itemId: "gone", resolution: "accepted" }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it("applies a resolution that arrived before its request", () => {
    // Needs a runtime that renumbers, so it is rare — but dropping the
    // resolution left a live card with working buttons on a request the
    // provider had already settled.
    const rows = collapseTranscriptEvents([
      envelope({ type: "pending_input_resolved", itemId: "item-1", resolution: "declined" }),
      envelope({ type: "approval_request", itemId: "item-1", kind: "command", description: "Run it" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(approvalOf(rows).state).toBe("rejected");
  });

  it("matches an early resolution by logicalItemId too", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "pending_input_resolved", itemId: "L1", resolution: "accepted" }),
      envelope({
        type: "approval_request",
        itemId: "item-1",
        logicalItemId: "L1",
        kind: "command",
        description: "Run it",
      }),
    ]);
    expect(approvalOf(rows).state).toBe("accepted");
  });
});

describe("restored pending approvals", () => {
  function approvalOf(rows: ReturnType<typeof collapseTranscriptEvents>, index = 0): ApprovalRow {
    const event = rows[index]!.event;
    if (event.type !== "approval") throw new Error(`row ${index} is ${event.type}`);
    return event;
  }

  const request = {
    itemId: "item-1",
    kind: "command" as const,
    description: "Run `ls`",
    requestKind: "approval",
    detail: { command: "ls" },
  };

  it("draws a card for a request the transcript never showed", () => {
    // A reload drops the live events that carried the request, and history may
    // not reach back far enough. Without this the thread comes back looking
    // merely silent, with nothing on screen able to unblock it.
    const rows = collapseTranscriptEvents([], [request]);
    expect(rows).toHaveLength(1);
    expect(approvalOf(rows)).toMatchObject({
      type: "approval",
      id: "item-1",
      state: "pending",
      requestKind: "approval",
      detail: { command: "ls" },
    });
  });

  it("does not draw a second card for a request history already replayed", () => {
    const rows = collapseTranscriptEvents(
      [envelope({ type: "approval_request", itemId: "item-1", kind: "command", description: "Run it" })],
      [request],
    );
    expect(rows).toHaveLength(1);
  });

  it("does not resurrect a card the transcript already settled", () => {
    const rows = collapseTranscriptEvents(
      [
        envelope({ type: "approval_request", itemId: "item-1", kind: "command", description: "Run it" }),
        envelope({ type: "pending_input_resolved", itemId: "item-1", resolution: "accepted" }),
      ],
      [request],
    );
    expect(rows).toHaveLength(1);
    expect(approvalOf(rows).state).toBe("accepted");
  });

  it("matches a replayed request by logicalItemId as well as itemId", () => {
    const rows = collapseTranscriptEvents(
      [
        envelope({
          type: "approval_request",
          itemId: "retry-2",
          logicalItemId: "L1",
          kind: "command",
          description: "Run it",
        }),
      ],
      [{ ...request, itemId: "retry-1", logicalItemId: "L1" }],
    );
    expect(rows).toHaveLength(1);
  });

  it("keeps the restored card through the grouping pass", () => {
    const rows = buildTranscriptRows([], [request]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("approval");
  });

  it("skips a request with no itemId rather than drawing an unanswerable card", () => {
    expect(collapseTranscriptEvents([], [{ ...request, itemId: "" }])).toHaveLength(0);
  });

  // The restore-only cases. A restored row comes from `pendingApprovals()`,
  // which the runtime answers from its authoritative "still blocked right now"
  // list, read after the history window. So the row is LIVE by construction and
  // no turn ending in that history settles it. The one thing that does is an
  // explicit resolution whose request fell outside the window, parked as an
  // orphan during the walk.

  it("restores a card already settled by a resolution whose request is outside the window", () => {
    const rows = collapseTranscriptEvents(
      [envelope({ type: "pending_input_resolved", itemId: "item-1", resolution: "accepted" })],
      [request],
    );
    expect(rows).toHaveLength(1);
    expect(approvalOf(rows).state).toBe("accepted");
  });

  it("matches an orphan resolution to a restored card by logicalItemId", () => {
    const rows = collapseTranscriptEvents(
      [envelope({ type: "pending_input_resolved", itemId: "L1", resolution: "declined" })],
      [{ ...request, itemId: "retry-1", logicalItemId: "L1" }],
    );
    expect(rows).toHaveLength(1);
    expect(approvalOf(rows).state).toBe("rejected");
  });

  it("keeps a restored card pending when its own turn ended earlier in history", () => {
    // The engine listed this request as blocked AFTER that ending was written.
    // Expiring it here draws read-only buttons on a live request and hangs the
    // runtime until someone interrupts it.
    const rows = collapseTranscriptEvents(
      [envelope({ type: "done", turnId: "t1" })],
      [{ ...request, turnId: "t1" }],
    );
    expect(rows).toHaveLength(1);
    expect(approvalOf(rows).state).toBe("pending");
  });

  it("keeps a restored card carrying no turn pending when a turn ended", () => {
    const rows = collapseTranscriptEvents(
      [envelope({ type: "done", turnId: "t9" })],
      [request],
    );
    expect(approvalOf(rows).state).toBe("pending");
  });

  it("keeps a restored card pending on an ending that names no turn", () => {
    // A turn-less ending is the reachable case: a disk-pressure interrupt, or
    // an `error` from a runtime that emits one without a turn id.
    const rows = collapseTranscriptEvents(
      [envelope({ type: "status", turnStatus: "interrupted" })],
      [{ ...request, turnId: "t1" }],
    );
    expect(onlyApproval(rows).state).toBe("pending");
  });

  it("keeps a restored card pending when another turn ended", () => {
    const rows = collapseTranscriptEvents(
      [envelope({ type: "done", turnId: "t2" })],
      [{ ...request, turnId: "t1" }],
    );
    expect(approvalOf(rows).state).toBe("pending");
  });

  it("keeps a restored card pending through several endings", () => {
    const rows = collapseTranscriptEvents(
      [
        envelope({ type: "done", turnId: "t1" }),
        envelope({ type: "done", turnId: "t2" }),
      ],
      [{ ...request, turnId: "t1" }],
    );
    expect(approvalOf(rows).state).toBe("pending");
  });

  it("settles a restored card only on an orphan resolution, not on an ending", () => {
    // The resolution says what the decision WAS, and it is the one signal that
    // outranks the engine's blocked list.
    const rows = collapseTranscriptEvents(
      [
        envelope({ type: "pending_input_resolved", itemId: "item-1", resolution: "accepted" }),
        envelope({ type: "done", turnId: "t1" }),
      ],
      [{ ...request, turnId: "t1" }],
    );
    expect(approvalOf(rows).state).toBe("accepted");
  });

  it("leaves a restored card pending when the stream carried no ending at all", () => {
    const rows = collapseTranscriptEvents(
      [envelope({ type: "text", text: "still working" })],
      [request],
    );
    expect(onlyApproval(rows).state).toBe("pending");
  });

  it("places a restored card at the instant it was read, not at the tail", () => {
    const rows = collapseTranscriptEvents(
      [
        envelope({ type: "text", text: "before", messageId: "m-before" }, "2026-01-02T00:00:00.000Z"),
        envelope({ type: "text", text: "after", messageId: "m-after" }, "2026-01-02T00:00:20.000Z"),
      ],
      [request],
      "2026-01-02T00:00:10.000Z",
    );
    expect(rows.map((row) => row.event.type)).toEqual(["text", "approval", "text"]);
  });

  it("keeps a settled restored card above the messages that streamed in later", () => {
    // The card is answered, then ten more messages arrive. Appending the
    // restored row on every rebuild pinned it below all of them for the life of
    // the mount, and the transcript read out of order permanently.
    const history = [
      envelope({ type: "text", text: "before", messageId: "m-before" }, "2026-01-02T00:00:00.000Z"),
    ];
    const later = Array.from({ length: 10 }, (_, index) =>
      envelope({ type: "text", text: `later ${index}`, messageId: `m${index}` }, `2026-01-02T00:01:${String(index).padStart(2, "0")}.000Z`),
    );
    const rows = collapseTranscriptEvents(
      [
        ...history,
        envelope({ type: "pending_input_resolved", itemId: "item-1", resolution: "accepted" }, "2026-01-02T00:00:30.000Z"),
        ...later,
      ],
      [request],
      "2026-01-02T00:00:10.000Z",
    );
    const approvalIndex = rows.findIndex((row) => row.event.type === "approval");
    expect(approvalIndex).toBe(1);
    expect(onlyApproval(rows).state).toBe("accepted");
    expect(rows).toHaveLength(12);
    expect(rows[rows.length - 1]!.event.type).toBe("text");
  });

  it("appends a restored card when the caller names no read time", () => {
    const rows = collapseTranscriptEvents(
      [envelope({ type: "text", text: "before", messageId: "m-before" }, "2026-01-02T00:00:00.000Z")],
      [request],
    );
    expect(rows.map((row) => row.event.type)).toEqual(["text", "approval"]);
  });
});
