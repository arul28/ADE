import { describe, expect, it } from "vitest";
import { parseAgentChatTranscript } from "./chatTranscript";

function line(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe("parseAgentChatTranscript", () => {
  it("parses valid NDJSON into a non-empty envelope array", () => {
    const raw = [
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:00.000Z",
        event: { type: "text", text: "hello" },
      }),
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:01.000Z",
        event: { type: "status", message: "starting" },
      }),
    ].join("\n");

    const envelopes = parseAgentChatTranscript(raw);

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      sessionId: "session-1",
      timestamp: "2026-04-13T12:00:00.000Z",
      event: { type: "text", text: "hello" },
    });
    expect(envelopes[1]).toMatchObject({
      sessionId: "session-1",
      timestamp: "2026-04-13T12:00:01.000Z",
      event: { type: "status", message: "starting" },
    });
  });

  it("includes sequence when parsed.sequence is a finite number", () => {
    const raw = line({
      sessionId: "session-1",
      timestamp: "2026-04-13T12:00:00.000Z",
      sequence: 5,
      event: { type: "text", text: "hi" },
    });

    const [envelope] = parseAgentChatTranscript(raw);

    expect(envelope, "expected at least one envelope").toBeTruthy();
    expect(envelope!.sequence).toBe(5);
  });

  it("includes sequence when the value is zero (still finite)", () => {
    const raw = line({
      sessionId: "session-1",
      timestamp: "2026-04-13T12:00:00.000Z",
      sequence: 0,
      event: { type: "text", text: "hi" },
    });

    const [envelope] = parseAgentChatTranscript(raw);

    expect(envelope, "expected at least one envelope").toBeTruthy();
    expect(envelope!.sequence).toBe(0);
  });

  it("omits sequence when the field is absent", () => {
    const raw = line({
      sessionId: "session-1",
      timestamp: "2026-04-13T12:00:00.000Z",
      event: { type: "text", text: "hi" },
    });

    const [envelope] = parseAgentChatTranscript(raw);

    expect(envelope, "expected at least one envelope").toBeTruthy();
    expect(envelope!).not.toHaveProperty("sequence");
  });

  it("omits sequence when the value is NaN, Infinity, or a string", () => {
    const rawLines = [
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:00.000Z",
        sequence: Number.NaN,
        event: { type: "text", text: "nan" },
      }),
      // JSON.stringify turns Infinity into null, so inject a raw string for the Infinity case
      '{"sessionId":"session-1","timestamp":"2026-04-13T12:00:01.000Z","sequence":Infinity,"event":{"type":"text","text":"inf"}}',
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:02.000Z",
        sequence: "7",
        event: { type: "text", text: "string-seq" },
      }),
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:03.000Z",
        sequence: null,
        event: { type: "text", text: "null-seq" },
      }),
    ];

    const envelopes = parseAgentChatTranscript(rawLines.join("\n"));

    // The raw Infinity line is invalid JSON, so it is silently skipped.
    // NaN, "7", and null should each produce an envelope without a `sequence` field.
    const withoutSequence = envelopes.filter((envelope) => !("sequence" in envelope));
    expect(envelopes.length).toBeGreaterThan(0);
    expect(withoutSequence).toHaveLength(envelopes.length);
    for (const envelope of envelopes) {
      expect(envelope).not.toHaveProperty("sequence");
    }
  });

  it("includes provenance when it is a non-null, non-array object", () => {
    const raw = line({
      sessionId: "session-1",
      timestamp: "2026-04-13T12:00:00.000Z",
      event: { type: "text", text: "hi" },
      provenance: {
        messageId: "msg-1",
        threadId: "thread-1",
        role: "worker",
      },
    });

    const [envelope] = parseAgentChatTranscript(raw);

    expect(envelope, "expected at least one envelope").toBeTruthy();
    expect(envelope!.provenance).toEqual({
      messageId: "msg-1",
      threadId: "thread-1",
      role: "worker",
    });
  });

  it("sets provenance to undefined when it is null, an array, or a primitive", () => {
    const rawLines = [
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:00.000Z",
        event: { type: "text", text: "null-prov" },
        provenance: null,
      }),
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:01.000Z",
        event: { type: "text", text: "array-prov" },
        provenance: ["messageId", "msg-1"],
      }),
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:02.000Z",
        event: { type: "text", text: "string-prov" },
        provenance: "msg-1",
      }),
    ];

    const envelopes = parseAgentChatTranscript(rawLines.join("\n"));

    expect(envelopes).toHaveLength(3);
    for (const envelope of envelopes) {
      expect(envelope.provenance).toBeUndefined();
    }
  });

  it("returns an empty array for empty input or blank lines without throwing", () => {
    expect(parseAgentChatTranscript("")).toEqual([]);
    expect(parseAgentChatTranscript("\n\n   \n\t\n")).toEqual([]);
    expect(parseAgentChatTranscript("\r\n\r\n")).toEqual([]);
  });

  it("skips lines that fail JSON.parse or lack required fields", () => {
    const rawLines = [
      "this is not json",
      "{malformed",
      line({
        // missing sessionId
        timestamp: "2026-04-13T12:00:00.000Z",
        event: { type: "text", text: "no-session" },
      }),
      line({
        sessionId: "   ", // blank sessionId after trim
        timestamp: "2026-04-13T12:00:00.000Z",
        event: { type: "text", text: "blank-session" },
      }),
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:00.000Z",
        // missing event
      }),
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:00.000Z",
        event: "not-an-object",
      }),
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:00.000Z",
        event: { type: "text", text: "valid" },
      }),
    ];

    const envelopes = parseAgentChatTranscript(rawLines.join("\n"));

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.event).toEqual({ type: "text", text: "valid" });
  });

  it("falls back to a generated timestamp when the timestamp field is missing or blank", () => {
    const raw = [
      line({
        sessionId: "session-1",
        event: { type: "text", text: "no-timestamp" },
      }),
      line({
        sessionId: "session-1",
        timestamp: "   ",
        event: { type: "text", text: "blank-timestamp" },
      }),
    ].join("\n");

    const envelopes = parseAgentChatTranscript(raw);

    expect(envelopes).toHaveLength(2);
    for (const envelope of envelopes) {
      // Must be a non-empty ISO string so downstream consumers have something to compare.
      expect(typeof envelope.timestamp).toBe("string");
      expect(envelope.timestamp.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(envelope.timestamp))).toBe(false);
    }
  });

  it("preserves order across multiple valid lines", () => {
    const raw = [
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "first" },
      }),
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:01.000Z",
        sequence: 2,
        event: { type: "text", text: "second" },
      }),
      line({
        sessionId: "session-1",
        timestamp: "2026-04-13T12:00:02.000Z",
        sequence: 3,
        event: { type: "text", text: "third" },
      }),
    ].join("\n");

    const envelopes = parseAgentChatTranscript(raw);

    expect(envelopes.map((envelope) => envelope.sequence)).toEqual([1, 2, 3]);
    expect(
      envelopes.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : null,
      ),
    ).toEqual(["first", "second", "third"]);
  });
});
