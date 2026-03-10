import { describe, expect, it } from "vitest";
import type { OrchestratorChatMessage } from "../../../shared/types";
import {
  isSignalMessage,
  readRecord,
  readString,
  formatStructuredValue,
  statusDotForWorker,
  workerStatusToParticipantStatus,
  normalizeMentionKey,
} from "./chatFilters";

function makeMessage(overrides: Partial<OrchestratorChatMessage> = {}): OrchestratorChatMessage {
  return {
    id: "msg-1",
    missionId: "mission-1",
    role: "worker",
    content: "hello world",
    timestamp: "2026-03-10T00:00:00.000Z",
    stepKey: "step-1",
    threadId: null,
    target: null,
    visibility: "full",
    deliveryState: "delivered",
    sourceSessionId: null,
    attemptId: null,
    laneId: null,
    runId: null,
    metadata: null,
    ...overrides,
  };
}

describe("readRecord", () => {
  it("returns null for non-objects", () => {
    expect(readRecord(null)).toBeNull();
    expect(readRecord(undefined)).toBeNull();
    expect(readRecord("string")).toBeNull();
    expect(readRecord(42)).toBeNull();
    expect(readRecord([1, 2])).toBeNull();
  });

  it("returns the object for plain objects", () => {
    const obj = { key: "value" };
    expect(readRecord(obj)).toBe(obj);
  });
});

describe("readString", () => {
  it("returns null for empty/whitespace strings", () => {
    expect(readString("")).toBeNull();
    expect(readString("   ")).toBeNull();
  });

  it("returns trimmed non-empty strings", () => {
    expect(readString("  hello  ")).toBe("hello");
    expect(readString("world")).toBe("world");
  });

  it("returns null for non-strings", () => {
    expect(readString(null)).toBeNull();
    expect(readString(42)).toBeNull();
    expect(readString(undefined)).toBeNull();
  });
});

describe("formatStructuredValue", () => {
  it("returns strings as-is", () => {
    expect(formatStructuredValue("hello")).toBe("hello");
  });

  it("JSON-stringifies objects", () => {
    expect(formatStructuredValue({ key: "val" })).toBe(JSON.stringify({ key: "val" }, null, 2));
  });

  it("stringifies numbers", () => {
    expect(formatStructuredValue(42)).toBe("42");
  });
});

describe("isSignalMessage", () => {
  it("rejects metadata_only visibility", () => {
    expect(isSignalMessage(makeMessage({ visibility: "metadata_only" }))).toBe(false);
  });

  it("keeps all user messages", () => {
    expect(isSignalMessage(makeMessage({ role: "user", content: "x" }))).toBe(true);
  });

  it("rejects low-signal noise content", () => {
    expect(isSignalMessage(makeMessage({ content: "streaming..." }))).toBe(false);
  });

  it("keeps substantive worker content", () => {
    expect(
      isSignalMessage(makeMessage({ content: "I have completed the implementation of the auth module." })),
    ).toBe(true);
  });

  it("handles structuredStream text kind — keeps substantive text", () => {
    expect(
      isSignalMessage(
        makeMessage({
          content: "Setting up the test framework",
          metadata: { structuredStream: { kind: "text" } },
        }),
      ),
    ).toBe(true);
  });

  it("handles structuredStream text kind — filters noise", () => {
    expect(
      isSignalMessage(
        makeMessage({
          content: "streaming...",
          metadata: { structuredStream: { kind: "text" } },
        }),
      ),
    ).toBe(false);
  });

  it("keeps plan kind", () => {
    expect(
      isSignalMessage(
        makeMessage({
          content: "plan",
          metadata: { structuredStream: { kind: "plan" } },
        }),
      ),
    ).toBe(true);
  });

  it("keeps failed status", () => {
    expect(
      isSignalMessage(
        makeMessage({
          content: "failed",
          metadata: { structuredStream: { kind: "status", status: "failed", message: "error" } },
        }),
      ),
    ).toBe(true);
  });

  it("keeps error kind with non-empty message", () => {
    expect(
      isSignalMessage(
        makeMessage({
          content: "Something went wrong with the deployment pipeline",
          metadata: { structuredStream: { kind: "error", message: "Connection timed out after 30 seconds" } },
        }),
      ),
    ).toBe(true);
  });
});

describe("statusDotForWorker", () => {
  it("returns green for active states", () => {
    for (const state of ["spawned", "initializing", "working", "waiting_input"]) {
      expect(statusDotForWorker(state)).toMatch(/^#/);
      // All these should return the same green color
      expect(statusDotForWorker(state)).toBe(statusDotForWorker("spawned"));
    }
  });

  it("returns gray for terminal/idle states", () => {
    expect(statusDotForWorker("completed")).toBe(statusDotForWorker("idle"));
    expect(statusDotForWorker("disposed")).toBe(statusDotForWorker("idle"));
  });

  it("returns red for failed", () => {
    expect(statusDotForWorker("failed")).not.toBe(statusDotForWorker("completed"));
  });

  it("returns gray for undefined", () => {
    expect(statusDotForWorker(undefined)).toBe(statusDotForWorker("completed"));
  });
});

describe("workerStatusToParticipantStatus", () => {
  it("maps active states to active", () => {
    expect(workerStatusToParticipantStatus("spawned")).toBe("active");
    expect(workerStatusToParticipantStatus("working")).toBe("active");
  });

  it("maps failed to failed", () => {
    expect(workerStatusToParticipantStatus("failed")).toBe("failed");
  });

  it("maps terminal states to completed", () => {
    expect(workerStatusToParticipantStatus("completed")).toBe("completed");
    expect(workerStatusToParticipantStatus("disposed")).toBe("completed");
    expect(workerStatusToParticipantStatus(undefined)).toBe("completed");
  });
});

describe("normalizeMentionKey", () => {
  it("normalizes to lowercase kebab", () => {
    const used = new Set<string>();
    expect(normalizeMentionKey("Hello World", "fallback", used)).toBe("hello-world");
  });

  it("deduplicates with suffix", () => {
    const used = new Set<string>(["hello"]);
    expect(normalizeMentionKey("Hello", "fallback", used)).toBe("hello-2");
    expect(used.has("hello-2")).toBe(true);
  });

  it("uses fallback for empty strings", () => {
    const used = new Set<string>();
    expect(normalizeMentionKey("", "fallback-1", used)).toBe("fallback-1");
  });
});
