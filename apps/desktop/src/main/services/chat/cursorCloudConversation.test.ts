import { describe, expect, it } from "vitest";
import {
  cloudConversationHasTurns,
  cloudRunsFromList,
  cloudTurnFingerprint,
  fingerprintAlreadyHydrated,
  flattenCloudConversationMessages,
  isCloudRunStillLive,
  latestCloudRunFromList,
  nextCursorCloudMirrorDelay,
  releaseCursorCloudAttachLease,
  transcriptCloudFingerprints,
  unwrapCloudConversationTurn,
} from "./cursorCloudConversation";

const agentTurn = {
  type: "agent",
  userMessage: { text: "hi there" },
  steps: [{ type: "assistantMessage", message: { text: "hello" } }],
};

const sdkAgentTurn = {
  type: "agentConversationTurn",
  turn: {
    userMessage: { text: "hi there" },
    steps: [
      { type: "thinkingMessage", message: { text: "hmm" } },
      { type: "assistantMessage", message: { text: "hello" } },
    ],
  },
};

const sdkShellTurn = {
  type: "shellConversationTurn",
  turn: {
    shellCommand: { command: "ls", workingDirectory: "/repo" },
    shellOutput: { stdout: "a.ts\n", stderr: "", exitCode: 0 },
  },
};

describe("flattenCloudConversationMessages", () => {
  it("returns a bare ConversationTurn array", () => {
    expect(flattenCloudConversationMessages([agentTurn])).toEqual([agentTurn]);
  });

  it("unwraps { turns } which the SDK conversation helper uses", () => {
    expect(flattenCloudConversationMessages({ turns: [agentTurn] })).toEqual([agentTurn]);
  });

  it("unwraps messages, conversation, items, and result wrappers", () => {
    expect(flattenCloudConversationMessages({ messages: [agentTurn] })).toEqual([agentTurn]);
    expect(flattenCloudConversationMessages({ conversation: [agentTurn] })).toEqual([agentTurn]);
    expect(flattenCloudConversationMessages({ items: [agentTurn] })).toEqual([agentTurn]);
    expect(flattenCloudConversationMessages({ result: [agentTurn] })).toEqual([agentTurn]);
  });

  it("unwraps nested { result: { turns } } worker payloads and a lone turn object", () => {
    expect(flattenCloudConversationMessages({ result: { turns: [agentTurn] } })).toEqual([agentTurn]);
    expect(flattenCloudConversationMessages(agentTurn)).toEqual([agentTurn]);
    expect(flattenCloudConversationMessages(sdkAgentTurn)).toEqual([sdkAgentTurn]);
  });

  it("treats missing or empty payloads as no turns", () => {
    expect(flattenCloudConversationMessages(null)).toEqual([]);
    expect(flattenCloudConversationMessages({})).toEqual([]);
    expect(cloudConversationHasTurns({ turns: [] })).toBe(false);
    expect(cloudConversationHasTurns({ turns: [agentTurn] })).toBe(true);
    expect(cloudConversationHasTurns({ turns: [sdkAgentTurn] })).toBe(true);
    expect(cloudConversationHasTurns({
      turns: [{ type: "agentConversationTurn", turn: { steps: [] } }],
    })).toBe(false);
  });
});

describe("unwrapCloudConversationTurn", () => {
  it("reads the SDK agentConversationTurn wrapper", () => {
    expect(unwrapCloudConversationTurn(sdkAgentTurn)).toEqual({
      kind: "agent",
      userText: "hi there",
      steps: sdkAgentTurn.turn.steps,
    });
  });

  it("reads the SDK shellConversationTurn wrapper", () => {
    expect(unwrapCloudConversationTurn(sdkShellTurn)).toEqual({
      kind: "shell",
      command: "ls",
      cwd: "/repo",
      stdout: "a.ts\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("still accepts the flattened { type: agent } shape", () => {
    expect(unwrapCloudConversationTurn(agentTurn)).toEqual({
      kind: "agent",
      userText: "hi there",
      steps: agentTurn.steps,
    });
  });
});

describe("isCloudRunStillLive", () => {
  it("treats creating, running, and queued as live", () => {
    expect(isCloudRunStillLive("CREATING")).toBe(true);
    expect(isCloudRunStillLive("running")).toBe(true);
    expect(isCloudRunStillLive("queued")).toBe(true);
    expect(isCloudRunStillLive("FINISHED")).toBe(false);
    expect(isCloudRunStillLive(null)).toBe(false);
  });
});

describe("latestCloudRunFromList", () => {
  it("reads { items } from Agent.listRuns", () => {
    expect(latestCloudRunFromList({
      items: [{ runId: "run-1", status: "FINISHED", model: { id: "composer-2" } }],
    })).toEqual({ runId: "run-1", status: "FINISHED", modelSdkId: "composer-2" });
  });

  it("accepts a bare array and id instead of runId", () => {
    expect(latestCloudRunFromList([{ id: "run-2", status: "running", modelId: "composer-2" }]))
      .toEqual({ runId: "run-2", status: "running", modelSdkId: "composer-2" });
  });

  it("returns every run so inbound cursor.com turns are not dropped", () => {
    expect(cloudRunsFromList({
      items: [
        { runId: "run-new", status: "FINISHED", model: { id: "composer-2.5-fast" } },
        { id: "run-old", status: "FINISHED", modelId: "composer-2" },
      ],
    })).toEqual([
      { runId: "run-new", status: "FINISHED", modelSdkId: "composer-2.5-fast" },
      { runId: "run-old", status: "FINISHED", modelSdkId: "composer-2" },
    ]);
  });
});

describe("cloud turn fingerprints", () => {
  it("fingerprints agent user text and shell commands", () => {
    expect(cloudTurnFingerprint({
      kind: "agent",
      userText: "hi there",
      steps: [],
    })).toBe("user:hi there");
    expect(cloudTurnFingerprint({
      kind: "shell",
      command: "ls",
      cwd: "/repo",
      stdout: "",
      stderr: "",
      exitCode: 0,
    })).toBe("shell:ls");
  });

  it("treats ADE's stored user text as already hydrated when cloud prefixes a system prompt", () => {
    const fingerprints = transcriptCloudFingerprints([
      { event: { type: "user_message", text: "ok this is a test message, are u getting this?" } },
    ]);
    expect(fingerprintAlreadyHydrated(
      fingerprints,
      "user:ADE launch context...\nok this is a test message, are u getting this?",
    )).toBe(true);
    expect(fingerprintAlreadyHydrated(fingerprints, "user:a brand new cursor.com turn")).toBe(false);
  });
});

describe("nextCursorCloudMirrorDelay", () => {
  it("resets to the floor when new turns arrive", () => {
    expect(nextCursorCloudMirrorDelay(45_000, "new")).toBe(3_000);
    expect(nextCursorCloudMirrorDelay(null, "new")).toBe(3_000);
  });

  it("steps through backoff while a watched chat is quiet", () => {
    expect(nextCursorCloudMirrorDelay(0, "unchanged")).toBe(3_000);
    expect(nextCursorCloudMirrorDelay(null, "unchanged")).toBe(3_000);
    expect(nextCursorCloudMirrorDelay(3_000, "unchanged")).toBe(8_000);
    expect(nextCursorCloudMirrorDelay(8_000, "unchanged")).toBe(20_000);
    expect(nextCursorCloudMirrorDelay(20_000, "unchanged")).toBe(45_000);
    expect(nextCursorCloudMirrorDelay(45_000, "unchanged")).toBe(45_000);
  });

  it("keeps the current delay when a tick is skipped", () => {
    expect(nextCursorCloudMirrorDelay(8_000, "skipped")).toBe(8_000);
    expect(nextCursorCloudMirrorDelay(null, "skipped")).toBe(3_000);
    expect(nextCursorCloudMirrorDelay(0, "skipped")).toBe(3_000);
  });
});

describe("releaseCursorCloudAttachLease", () => {
  it("clears the matching run and turn so watched polls can resume", () => {
    const runtime = {
      cloudRuns: new Map<string, { runId: string }>([
        ["run-1", { runId: "run-1" }],
        ["run-2", { runId: "run-2" }],
      ]),
      activeCloudRunId: "run-1",
      activeTurnId: "turn-1",
    };

    releaseCursorCloudAttachLease(runtime, { runId: "run-1", turnId: "turn-1" });

    expect(runtime.cloudRuns.has("run-1")).toBe(false);
    expect(runtime.cloudRuns.has("run-2")).toBe(true);
    expect(runtime.activeCloudRunId).toBeNull();
    expect(runtime.activeTurnId).toBeNull();
  });

  it("does not clear a newer live run or turn", () => {
    const runtime = {
      cloudRuns: new Map<string, { runId: string }>([["run-2", { runId: "run-2" }]]),
      activeCloudRunId: "run-2",
      activeTurnId: "turn-2",
    };

    releaseCursorCloudAttachLease(runtime, { runId: "run-1", turnId: "turn-1" });

    expect(runtime.cloudRuns.has("run-2")).toBe(true);
    expect(runtime.activeCloudRunId).toBe("run-2");
    expect(runtime.activeTurnId).toBe("turn-2");
  });
});
