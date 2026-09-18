import { describe, expect, it } from "vitest";
import {
  drainRunningClaudeWorkflowAgents,
  finalizeClaudeWorkflowProgress,
  parseClaudeWorkflowProgress,
  planClaudeWorkflowAgentTransitions,
  summarizeClaudeWorkflowRun,
  type ClaudeWorkflowAgentEmitState,
} from "./claudeWorkflowProgress";
import { isAgentChatWorkflowProgress } from "../../../shared/chatSubagents";

const TASK_ID = "wf-task-1";

function agentEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "workflow_agent", index: 0, state: "start", startedAt: 100, ...overrides };
}

describe("parseClaudeWorkflowProgress", () => {
  it("returns undefined for absent or malformed payloads", () => {
    expect(parseClaudeWorkflowProgress(undefined, TASK_ID)).toBeUndefined();
    expect(parseClaudeWorkflowProgress(null, TASK_ID)).toBeUndefined();
    expect(parseClaudeWorkflowProgress("nope", TASK_ID)).toBeUndefined();
    expect(parseClaudeWorkflowProgress({}, TASK_ID)).toBeUndefined();
    expect(parseClaudeWorkflowProgress([], TASK_ID)).toBeUndefined();
    expect(parseClaudeWorkflowProgress([null, 42, "x", { type: "mystery" }], TASK_ID)).toBeUndefined();
  });

  it("drops malformed entries without dropping the snapshot", () => {
    const snapshot = parseClaudeWorkflowProgress([
      { type: "workflow_agent", state: "start" }, // missing index
      { type: "workflow_agent", index: 1 }, // missing state
      agentEntry({ index: 2, state: "done" }),
      { type: "workflow_phase", index: 0, title: "Scan" },
      { type: "workflow_phase", index: 1 }, // missing title
      { type: "workflow_log", message: "narration is ignored" },
    ], TASK_ID);
    expect(snapshot).toBeDefined();
    expect(snapshot!.agents).toHaveLength(1);
    expect(snapshot!.agents[0]!.status).toBe("completed");
    expect(snapshot!.phases).toEqual([{ index: 0, title: "Scan" }]);
  });

  it("drops fractional and unsafe indexes so synthetic lineage stays addressable", () => {
    const snapshot = parseClaudeWorkflowProgress([
      agentEntry({ index: 0.5 }),
      agentEntry({ index: Number.MAX_SAFE_INTEGER + 1 }),
      agentEntry({ index: 1, state: "done" }),
      { type: "workflow_phase", index: 1.5, title: "Fractional" },
      { type: "workflow_phase", index: Number.MAX_SAFE_INTEGER + 1, title: "Unsafe" },
      { type: "workflow_phase", index: 0, title: "Valid" },
    ], TASK_ID);

    expect(snapshot).toMatchObject({
      phases: [{ index: 0, title: "Valid" }],
      agents: [expect.objectContaining({ index: 1, status: "completed" })],
    });
  });

  it("derives status and excludes queued agents while counting them", () => {
    const snapshot = parseClaudeWorkflowProgress([
      agentEntry({ index: 0, state: "start" , startedAt: undefined }), // queued
      agentEntry({ index: 1, state: "start", startedAt: 5 }), // running
      agentEntry({ index: 2, state: "done", startedAt: undefined }), // terminal counts as started
      agentEntry({ index: 3, state: "error", error: "boom" }),
      agentEntry({ index: 4, state: "reticulating", startedAt: 9 }), // unknown state degrades to running
      agentEntry({ index: 5, state: "reticulating", startedAt: undefined }), // unknown without start = queued
    ], TASK_ID);
    expect(snapshot!.queuedCount).toBe(2);
    expect(snapshot!.runningCount).toBe(2);
    expect(snapshot!.doneCount).toBe(1);
    expect(snapshot!.failedCount).toBe(1);
    expect(snapshot!.agents.map((agent) => agent.status)).toEqual([
      "running", "completed", "failed", "running",
    ]);
    expect(snapshot!.agents.find((agent) => agent.status === "failed")!.summary).toContain("boom");
  });

  it("applies last-write-wins per agent index", () => {
    const snapshot = parseClaudeWorkflowProgress([
      agentEntry({ index: 0, state: "start" }),
      agentEntry({ index: 0, state: "done" }),
    ], TASK_ID);
    expect(snapshot!.agents).toHaveLength(1);
    expect(snapshot!.agents[0]!.status).toBe("completed");
  });

  it("builds stable synthetic keys and prefers real agent ids", () => {
    const snapshot = parseClaudeWorkflowProgress([
      agentEntry({ index: 0, model: "claude-opus-5" }),
      agentEntry({ index: 1, agentId: "a-real" }),
    ], TASK_ID);
    expect(snapshot!.agents[0]!.key).toBe(`${TASK_ID}::a0`);
    expect(snapshot!.agents[0]!.model).toBe("claude-opus-5");
    expect(snapshot!.agents[1]!.key).toBe("a-real");
  });

  it("clips oversized previews and surfaces blocked agents", () => {
    const snapshot = parseClaudeWorkflowProgress([
      agentEntry({
        label: "x".repeat(1000),
        blocked: true,
        lastToolSummary: "y".repeat(1000),
        lastToolName: "z".repeat(1000),
      }),
    ], TASK_ID);
    const agent = snapshot!.agents[0]!;
    expect(agent.name.length).toBeLessThanOrEqual(241);
    expect(agent.summary).toContain("blocked by safety filter");
    expect(agent.lastToolName?.length).toBeLessThanOrEqual(241);
  });

  it("round-trips clipped provider text through the shared workflow boundary", () => {
    const long = "x".repeat(1_000);
    const snapshot = parseClaudeWorkflowProgress([
      { type: "workflow_phase", index: 0, title: long },
      agentEntry({
        label: long,
        agentId: long,
        agentType: long,
        model: long,
        phaseTitle: long,
        blocked: true,
        error: long,
        resultPreview: long,
        lastToolSummary: long,
        lastToolName: long,
        promptPreview: long,
      }),
    ], TASK_ID)!;

    expect(isAgentChatWorkflowProgress(snapshot)).toBe(true);
    expect(snapshot.agents[0]!.key.length).toBeLessThanOrEqual(241);
    expect(snapshot.agents[0]!.summary.length).toBeLessThanOrEqual(241);
    expect(snapshot.agents[0]!.agentId?.length).toBeLessThanOrEqual(241);
    expect(snapshot.agents[0]!.agentType?.length).toBeLessThanOrEqual(241);
  });

  it("marks provider-running agents stopped when a terminal workflow snapshot is finalized", () => {
    const snapshot = parseClaudeWorkflowProgress([
      agentEntry({ index: 0, state: "start" }),
      agentEntry({ index: 1, state: "done" }),
    ], TASK_ID)!;
    const finalized = finalizeClaudeWorkflowProgress(snapshot);
    expect(finalized.runningCount).toBe(0);
    expect(finalized.queuedCount).toBe(0);
    expect(finalized.agents.map((agent) => agent.status)).toEqual(["stopped", "completed"]);
    expect(finalized.agents[0]!.summary).toContain("Workflow ended");
  });

  it("names agents from label, agentType, then index", () => {
    const snapshot = parseClaudeWorkflowProgress([
      agentEntry({ index: 0, label: "verify:auth" }),
      agentEntry({ index: 1, agentType: "code-reviewer" }),
      agentEntry({ index: 2 }),
    ], TASK_ID);
    expect(snapshot!.agents.map((agent) => agent.name)).toEqual([
      "verify:auth", "code-reviewer", "Agent #3",
    ]);
  });
});

describe("summarizeClaudeWorkflowRun", () => {
  it("rolls up phase and counts", () => {
    const snapshot = parseClaudeWorkflowProgress([
      { type: "workflow_phase", index: 0, title: "Scan" },
      { type: "workflow_phase", index: 1, title: "Verify" },
      agentEntry({ index: 0, state: "done" }),
      agentEntry({ index: 1, phaseTitle: "Verify" }),
      agentEntry({ index: 2, startedAt: undefined }),
    ], TASK_ID)!;
    const summary = summarizeClaudeWorkflowRun(snapshot);
    expect(summary).toContain("Verify");
    expect(summary).toContain("1 running");
    expect(summary).toContain("1 done");
    expect(summary).toContain("1 queued");
  });
});

describe("planClaudeWorkflowAgentTransitions", () => {
  function parseAgents(entries: Record<string, unknown>[]) {
    return parseClaudeWorkflowProgress(entries, TASK_ID)!.agents;
  }

  it("emits started once, progress on change, result on terminal — and freezes after", () => {
    const tracked = new Map<string, ClaudeWorkflowAgentEmitState>();
    const first = planClaudeWorkflowAgentTransitions(tracked, parseAgents([agentEntry()]));
    expect(first.map((t) => t.kind)).toEqual(["started"]);

    // Identical snapshot re-sent (reconnect / duplicate tick) → nothing.
    expect(planClaudeWorkflowAgentTransitions(tracked, parseAgents([agentEntry()]))).toEqual([]);

    const progressed = planClaudeWorkflowAgentTransitions(
      tracked,
      parseAgents([agentEntry({ tokens: 500, lastToolName: "Read" })]),
    );
    expect(progressed.map((t) => t.kind)).toEqual(["progress"]);

    const done = planClaudeWorkflowAgentTransitions(
      tracked,
      parseAgents([agentEntry({ state: "done", tokens: 900 })]),
    );
    expect(done.map((t) => t.kind)).toEqual(["result"]);

    // Terminal agents are frozen: later re-emissions never produce events.
    expect(planClaudeWorkflowAgentTransitions(
      tracked,
      parseAgents([agentEntry({ state: "done", tokens: 901 })]),
    )).toEqual([]);
  });

  it("emits started+result together for agents first seen terminal", () => {
    const tracked = new Map<string, ClaudeWorkflowAgentEmitState>();
    const transitions = planClaudeWorkflowAgentTransitions(
      tracked,
      parseAgents([agentEntry({ state: "done", cached: true })]),
    );
    expect(transitions.map((t) => t.kind)).toEqual(["started", "result"]);
  });

  it("latches the emitted identity when a real agentId arrives late", () => {
    const tracked = new Map<string, ClaudeWorkflowAgentEmitState>();
    const first = planClaudeWorkflowAgentTransitions(tracked, parseAgents([agentEntry()]));
    expect(first[0]!.agentId).toBe(`${TASK_ID}::a0`);
    const later = planClaudeWorkflowAgentTransitions(
      tracked,
      parseAgents([agentEntry({ agentId: "a-real", tokens: 12 })]),
    );
    expect(later).toHaveLength(1);
    expect(later[0]!.agentId).toBe(`${TASK_ID}::a0`);
  });
});

describe("drainRunningClaudeWorkflowAgents", () => {
  it("returns only non-terminal agents and clears the tracker", () => {
    const tracked = new Map<string, ClaudeWorkflowAgentEmitState>();
    const agents = parseClaudeWorkflowProgress([
      agentEntry({ index: 0 }),
      agentEntry({ index: 1, state: "done" }),
    ], TASK_ID)!.agents;
    planClaudeWorkflowAgentTransitions(tracked, agents);
    const drained = drainRunningClaudeWorkflowAgents(tracked);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.agent.index).toBe(0);
    expect(tracked.size).toBe(0);
    expect(drainRunningClaudeWorkflowAgents(undefined)).toEqual([]);
  });
});
