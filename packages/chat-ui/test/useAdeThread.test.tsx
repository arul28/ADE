import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useAdeThread } from "../src/context/AdeChatContext";
import type {
  AdeChatClient,
  AdeThread,
  AgentChatEventEnvelope,
  ApprovalRequest,
  ModelDescriptor,
  ProviderStatus,
  Unsubscribe,
} from "../src/sdkTypes";

/**
 * Two rules `useAdeThread` owns and nothing else can check for it:
 *
 *  1. The merged transcript is ORDERED, by `sequence` then `timestamp`. History
 *     and the live buffer are concatenated, not interleaved, so without a sort
 *     an envelope that arrived live during `history()` renders after rows that
 *     came before it. `@ade-dev/sdk` answers the same question the same way in
 *     `compareEnvelopes`; leaving the two sides with different answers is what
 *     this covers.
 *  2. Requests the runtime is still blocked on reach the rows as REQUESTS, not
 *     as fabricated envelopes carrying a thread key where a `sessionId` belongs
 *     and invented sequence numbers that collide with real ones.
 */

const statuses: ProviderStatus[] = [
  { id: "claude", displayName: "Claude", installed: true, authenticated: true },
];
const models: ModelDescriptor[] = [{ id: "claude/haiku", providerId: "claude", displayName: "H" }];

function envelope(sequence: number | undefined, text: string, timestamp: string): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp,
    ...(sequence !== undefined ? { sequence } : {}),
    event: { type: "text", text, messageId: text },
  };
}

function stubClient(thread: Partial<AdeThread>): AdeChatClient {
  const full: AdeThread = {
    key: "main",
    send: async () => {},
    steer: async () => {},
    interrupt: async () => {},
    history: async () => [],
    on: (() => () => {}) as AdeThread["on"],
    ...thread,
  };
  return {
    providers: { status: async () => statuses, onChange: (): Unsubscribe => () => {} },
    models: { list: async () => models },
    threads: { open: async () => full },
  };
}

function textsOf(rows: ReturnType<typeof useAdeThread>["rows"]): string[] {
  return rows.flatMap((row) => (row.event.type === "text" ? [row.event.text] : []));
}

describe("useAdeThread transcript ordering", () => {
  it("sorts a history page that arrives out of sequence order", async () => {
    const client = stubClient({
      history: async () => [
        envelope(3, "third", "2026-01-01T00:00:03.000Z"),
        envelope(1, "first", "2026-01-01T00:00:01.000Z"),
        envelope(2, "second", "2026-01-01T00:00:02.000Z"),
      ],
    });
    const { result } = renderHook(() =>
      useAdeThread("main", { client, modelId: "claude/haiku" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(textsOf(result.current.rows)).toEqual(["first", "second", "third"]);
  });

  it("places a live envelope that beat history back into sequence order", async () => {
    // The race this exists for: the transcript subscribes before awaiting
    // history, so an envelope emitted during the request is held and then
    // concatenated AFTER the page even though it belongs inside it.
    let emit: ((value: AgentChatEventEnvelope) => void) | null = null;
    const client = stubClient({
      on: ((channel: string, cb: (value: AgentChatEventEnvelope) => void) => {
        if (channel === "event") emit = cb;
        return () => {};
      }) as AdeThread["on"],
      history: async () => {
        emit?.(envelope(2, "middle", "2026-01-01T00:00:02.000Z"));
        return [
          envelope(1, "first", "2026-01-01T00:00:01.000Z"),
          envelope(3, "last", "2026-01-01T00:00:03.000Z"),
        ];
      },
    });
    const { result } = renderHook(() =>
      useAdeThread("main", { client, modelId: "claude/haiku" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(textsOf(result.current.rows)).toEqual(["first", "middle", "last"]);
  });

  it("falls back to timestamp, then arrival order, for envelopes with no sequence", async () => {
    const client = stubClient({
      history: async () => [
        envelope(undefined, "b", "2026-01-01T00:00:02.000Z"),
        envelope(undefined, "a", "2026-01-01T00:00:01.000Z"),
        envelope(undefined, "c", "2026-01-01T00:00:02.000Z"),
      ],
    });
    const { result } = renderHook(() =>
      useAdeThread("main", { client, modelId: "claude/haiku" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    // "b" and "c" tie on timestamp and keep the order they arrived in.
    expect(textsOf(result.current.rows)).toEqual(["a", "b", "c"]);
  });

  it("keeps a deterministic order when sequence and timestamp disagree across a mixed page", async () => {
    // The intransitive case. Comparing sequence only when BOTH sides carry one
    // and otherwise falling through to timestamp gives A < B by sequence, B < C
    // by timestamp and C < A by timestamp, which is not an ordering at all:
    // `Array.prototype.sort` may then return any permutation and adjacent text
    // envelopes stop merging. Sequence is the primary key unconditionally, so
    // the numbered envelopes come first in sequence order and the un-numbered
    // one follows.
    const client = stubClient({
      history: async () => [
        envelope(1, "A", "2026-01-01T00:00:03.000Z"),
        envelope(2, "B", "2026-01-01T00:00:01.000Z"),
        envelope(undefined, "C", "2026-01-01T00:00:02.000Z"),
      ],
    });
    const { result } = renderHook(() =>
      useAdeThread("main", { client, modelId: "claude/haiku" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(textsOf(result.current.rows)).toEqual(["A", "B", "C"]);
  });

  it("orders the same mixed page identically however it arrives", async () => {
    // A valid comparator gives one answer for every input permutation. This is
    // the property the intransitive version could not hold.
    const pages = [
      [
        envelope(undefined, "C", "2026-01-01T00:00:02.000Z"),
        envelope(2, "B", "2026-01-01T00:00:01.000Z"),
        envelope(1, "A", "2026-01-01T00:00:03.000Z"),
      ],
      [
        envelope(2, "B", "2026-01-01T00:00:01.000Z"),
        envelope(undefined, "C", "2026-01-01T00:00:02.000Z"),
        envelope(1, "A", "2026-01-01T00:00:03.000Z"),
      ],
    ];
    for (const page of pages) {
      const client = stubClient({ history: async () => page });
      const { result } = renderHook(() =>
        useAdeThread("main", { client, modelId: "claude/haiku" }),
      );
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(textsOf(result.current.rows)).toEqual(["A", "B", "C"]);
    }
  });
});

describe("useAdeThread restores blocked approvals", () => {
  const request: ApprovalRequest = {
    itemId: "item-1",
    kind: "command",
    description: "Run `ls`",
  };

  it("draws a card for a request history never carried", async () => {
    const client = stubClient({ pendingApprovals: async () => [request] });
    const { result } = renderHook(() =>
      useAdeThread("main", { client, modelId: "claude/haiku" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]!.event).toMatchObject({
      type: "approval",
      id: "item-1",
      state: "pending",
    });
  });

  it("does not draw a second card for one history already replayed", async () => {
    const client = stubClient({
      pendingApprovals: async () => [request],
      history: async () => [
        {
          sessionId: "session-1",
          timestamp: "2026-01-01T00:00:01.000Z",
          sequence: 1,
          event: {
            type: "approval_request",
            itemId: "item-1",
            kind: "command",
            description: "Run `ls`",
          },
        },
      ],
    });
    const { result } = renderHook(() =>
      useAdeThread("main", { client, modelId: "claude/haiku" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.rows).toHaveLength(1);
  });

  it("opens the thread anyway when pendingApprovals throws", async () => {
    const client = stubClient({
      pendingApprovals: async () => {
        throw new Error("no such action");
      },
    });
    const { result } = renderHook(() =>
      useAdeThread("main", { client, modelId: "claude/haiku" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.rows).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});
