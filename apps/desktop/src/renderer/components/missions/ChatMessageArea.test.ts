import { describe, expect, it } from "vitest";
import { shouldPollRawMissionTranscript } from "./ChatMessageArea";
import { formatChannelAccessibleName, type Channel } from "./ChatChannelList";

function channel(overrides: Partial<Channel>): Channel {
  return {
    id: "thread:1",
    kind: "worker",
    label: "Worker",
    fullLabel: "Worker",
    threadId: "thread-1",
    sessionId: "session-1",
    laneId: null,
    status: "active",
    stepKey: null,
    attemptId: null,
    unreadCount: 0,
    phaseLabel: null,
    ...overrides,
  };
}

describe("shouldPollRawMissionTranscript", () => {
  it("polls raw transcripts only for live worker-style threads", () => {
    expect(shouldPollRawMissionTranscript(channel({ kind: "worker", status: "active" }))).toBe(true);
    expect(shouldPollRawMissionTranscript(channel({ kind: "teammate", status: "active" }))).toBe(true);
  });

  it("does not poll raw coordinator transcripts", () => {
    expect(shouldPollRawMissionTranscript(channel({ kind: "orchestrator", status: "active" }))).toBe(false);
  });

  it("does not poll closed or feed channels", () => {
    expect(shouldPollRawMissionTranscript(channel({ kind: "worker", status: "closed" }))).toBe(false);
    expect(shouldPollRawMissionTranscript(channel({ kind: "global", status: "active", threadId: null, sessionId: null }))).toBe(false);
  });
});

describe("formatChannelAccessibleName", () => {
  it("keeps worker labels and phase badges distinct for assistive tech", () => {
    expect(formatChannelAccessibleName("data model", "Data")).toBe("data model, Data channel");
  });

  it("does not append empty badges", () => {
    expect(formatChannelAccessibleName("Orchestrator")).toBe("Orchestrator");
    expect(formatChannelAccessibleName("Mission Feed", " ")).toBe("Mission Feed");
  });
});
