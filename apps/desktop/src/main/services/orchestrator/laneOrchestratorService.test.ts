import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLaneOrchestratorService } from "./laneOrchestratorService";
import { createOrchestratorChatToolHandlers } from "./orchestratorChatTools";

function createFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-orchestrator-"));
  const adeDir = path.join(projectRoot, ".ade");
  const transcriptsDir = path.join(adeDir, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const createSession = vi.fn(async (args: any) => ({
    id: `worker-${Math.random().toString(36).slice(2, 8)}`,
    laneId: args.laneId,
    provider: args.provider,
    model: args.model,
    sessionProfile: args.sessionProfile,
    status: "idle" as const,
    createdAt: "2026-05-22T00:00:00.000Z",
    lastActivityAt: "2026-05-22T00:00:00.000Z",
  }));
  const sendMessage = vi.fn(async () => {});
  const updateSessionTitle = vi.fn(async () => {});

  const service = createLaneOrchestratorService({
    projectRoot,
    adeDir,
    transcriptsDir,
    createSession,
    sendMessage,
    updateSessionTitle,
    getLeadSession: () => ({ provider: "claude", model: "claude-sonnet-4-20250514" }),
  });

  return {
    projectRoot,
    adeDir,
    transcriptsDir,
    service,
    createSession,
    sendMessage,
    updateSessionTitle,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }),
  };
}

describe("laneOrchestratorService", () => {
  let fixture: ReturnType<typeof createFixture> | null = null;

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
    vi.restoreAllMocks();
  });

  it("creates and persists orchestrator state under .ade/lane-orchestrators", () => {
    fixture = createFixture();
    const { service, adeDir } = fixture;
    const leadSessionId = "lead-session-1";
    const state = service.ensureRun({ leadSessionId, laneId: "lane-1" });

    expect(state.phase).toBe("planning");
    expect(state.workers).toEqual([]);
    expect(fs.existsSync(path.join(adeDir, "lane-orchestrators", `${leadSessionId}.json`))).toBe(true);
    expect(service.getState(leadSessionId)?.laneId).toBe("lane-1");
  });

  it("updates plan markdown and phase", () => {
    fixture = createFixture();
    const { service } = fixture;
    const leadSessionId = "lead-session-2";
    service.ensureRun({ leadSessionId, laneId: "lane-1" });
    service.setPlanMarkdown({ leadSessionId, planMarkdown: "# Plan\n1. Inspect" });
    service.setPhase({ leadSessionId, phase: "executing" });

    const state = service.getState(leadSessionId);
    expect(state?.planMarkdown).toContain("# Plan");
    expect(state?.phase).toBe("executing");
  });

  it("spawns worker sessions and registers them", async () => {
    fixture = createFixture();
    const { service, createSession, sendMessage } = fixture;
    const leadSessionId = "lead-session-3";
    service.ensureRun({ leadSessionId, laneId: "lane-1" });

    const worker = await service.spawnWorker({
      leadSessionId,
      laneId: "lane-1",
      title: "Implement patch",
      initialPrompt: "Fix the failing test",
    });

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionProfile: "orchestrator-worker",
      orchestratorLeadSessionId: leadSessionId,
      orchestratorRole: "worker",
    }));
    expect(sendMessage).toHaveBeenCalled();
    expect(worker.title).toBe("Implement patch");
    expect(service.listWorkers(leadSessionId)).toHaveLength(1);
  });

  it("reads worker transcript summaries", () => {
    fixture = createFixture();
    const { service, transcriptsDir } = fixture;
    const workerSessionId = "worker-session-1";
    const transcriptPath = path.join(transcriptsDir, `${workerSessionId}.chat.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          sessionId: workerSessionId,
          timestamp: "2026-05-22T00:00:00.000Z",
          event: { type: "user_message", text: "Start work" },
        }),
        JSON.stringify({
          sessionId: workerSessionId,
          timestamp: "2026-05-22T00:00:01.000Z",
          event: { type: "text", text: "Patch applied" },
        }),
      ].join("\n"),
      "utf8",
    );

    const summary = service.getWorkerSummary({ workerSessionId, lineCount: 5 });
    expect(summary).toContain("User: Start work");
    expect(summary).toContain("Assistant: Patch applied");
  });
});

describe("orchestratorChatTools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates spawn_worker_chat to the lane orchestrator service", async () => {
    const fixture = createFixture();
    try {
      const leadSessionId = "lead-session-tools";
      fixture.service.ensureRun({ leadSessionId, laneId: "lane-1" });
      const handlers = createOrchestratorChatToolHandlers({
        laneOrchestratorService: fixture.service,
        leadSessionId,
        laneId: "lane-1",
      });

      const result = await handlers.spawn_worker_chat({
        title: "Worker A",
        initialPrompt: "Do the thing",
      });

      expect(result.success).toBe(true);
      expect(result.worker.title).toBe("Worker A");
      expect(fixture.service.listWorkers(leadSessionId)).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });
});
