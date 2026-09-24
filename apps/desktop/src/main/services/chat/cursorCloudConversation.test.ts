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
  it.each([
    ["a bare array", [agentTurn], [agentTurn]],
    ["{ turns }", { turns: [agentTurn] }, [agentTurn]],
    ["{ messages }", { messages: [agentTurn] }, [agentTurn]],
    ["{ conversation }", { conversation: [agentTurn] }, [agentTurn]],
    ["{ items }", { items: [agentTurn] }, [agentTurn]],
    ["{ result }", { result: [agentTurn] }, [agentTurn]],
    ["{ result: { turns } }", { result: { turns: [agentTurn] } }, [agentTurn]],
    ["a lone turn", agentTurn, [agentTurn]],
    ["a lone SDK turn", sdkAgentTurn, [sdkAgentTurn]],
    ["null", null, []],
    ["an empty object", {}, []],
  ])("unwraps %s", (_label, payload, expected) => {
    expect(flattenCloudConversationMessages(payload)).toEqual(expected);
  });

  it("counts only turns with content", () => {
    expect(cloudConversationHasTurns({ turns: [] })).toBe(false);
    expect(cloudConversationHasTurns({ turns: [agentTurn] })).toBe(true);
    expect(cloudConversationHasTurns({ turns: [sdkAgentTurn] })).toBe(true);
    expect(cloudConversationHasTurns({
      turns: [{ type: "agentConversationTurn", turn: { steps: [] } }],
    })).toBe(false);
  });
});

describe("unwrapCloudConversationTurn", () => {
  it.each([
    ["the SDK agentConversationTurn wrapper", sdkAgentTurn, { kind: "agent", userText: "hi there", steps: sdkAgentTurn.turn.steps }],
    ["the flattened { type: agent } shape", agentTurn, { kind: "agent", userText: "hi there", steps: agentTurn.steps }],
    [
      "the SDK shellConversationTurn wrapper",
      sdkShellTurn,
      { kind: "shell", command: "ls", cwd: "/repo", stdout: "a.ts\n", stderr: "", exitCode: 0 },
    ],
  ])("reads %s", (_label, raw, expected) => {
    expect(unwrapCloudConversationTurn(raw)).toEqual(expected);
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

describe("cloudRunsFromList", () => {
  it("accepts a bare array", () => {
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
  // New turns reset to the floor, a quiet chat backs off to a cap, a skipped tick keeps its delay.
  it.each([
    [45_000, "new", 3_000],
    [null, "new", 3_000],
    [0, "unchanged", 3_000],
    [null, "unchanged", 3_000],
    [3_000, "unchanged", 8_000],
    [8_000, "unchanged", 20_000],
    [20_000, "unchanged", 45_000],
    [45_000, "unchanged", 45_000],
    [8_000, "skipped", 8_000],
    [null, "skipped", 3_000],
    [0, "skipped", 3_000],
  ] as const)("from %s after a %s tick waits %s ms", (current, outcome, expected) => {
    expect(nextCursorCloudMirrorDelay(current, outcome)).toBe(expected);
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
