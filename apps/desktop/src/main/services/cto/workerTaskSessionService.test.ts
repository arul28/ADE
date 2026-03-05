import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createWorkerTaskSessionService } from "./workerTaskSessionService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-worker-task-sessions-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const dbPath = path.join(adeDir, "ade.db");
  const db = await openKvDb(dbPath, createLogger());
  const projectId = "project-test";
  const service = createWorkerTaskSessionService({
    db,
    projectId,
  });
  return { db, projectId, service };
}

describe("workerTaskSessionService", () => {
  it("derives deterministic task keys", async () => {
    const fixture = await createFixture();
    const keyA = fixture.service.deriveTaskKey({
      agentId: "a1",
      laneId: "lane-x",
      missionId: "mission-1",
      summary: "fix checkout bug",
    });
    const keyB = fixture.service.deriveTaskKey({
      agentId: "a1",
      laneId: "lane-x",
      missionId: "mission-1",
      summary: "fix checkout bug",
    });
    expect(keyA).toBe(keyB);
    expect(keyA.startsWith("task:")).toBe(true);
    fixture.db.close();
  });

  it("persists and resumes task sessions by (agentId, adapterType, taskKey)", async () => {
    const fixture = await createFixture();
    const taskKey = fixture.service.deriveTaskKey({
      agentId: "worker-1",
      chatSessionId: "chat-123",
      summary: "investigate flaky test",
    });
    const created = fixture.service.ensureTaskSession({
      agentId: "worker-1",
      adapterType: "codex-local",
      taskKey,
      payload: { sessionId: "chat-123", threadId: "thread-1" },
    });
    expect(created.taskKey).toBe(taskKey);

    const resumed = fixture.service.getTaskSession("worker-1", "codex-local", taskKey);
    expect(resumed?.payload).toEqual({ sessionId: "chat-123", threadId: "thread-1" });

    fixture.service.ensureTaskSession({
      agentId: "worker-1",
      adapterType: "codex-local",
      taskKey,
      payload: { sessionId: "chat-123", threadId: "thread-2" },
    });
    const updated = fixture.service.getTaskSession("worker-1", "codex-local", taskKey);
    expect(updated?.payload).toEqual({ sessionId: "chat-123", threadId: "thread-2" });

    fixture.db.close();
  });

  it("clears task sessions with targeted and bulk behavior", async () => {
    const fixture = await createFixture();
    const keyOne = fixture.service.deriveTaskKey({ agentId: "worker-1", summary: "one" });
    const keyTwo = fixture.service.deriveTaskKey({ agentId: "worker-1", summary: "two" });
    fixture.service.ensureTaskSession({
      agentId: "worker-1",
      adapterType: "process",
      taskKey: keyOne,
      payload: { run: 1 },
    });
    fixture.service.ensureTaskSession({
      agentId: "worker-1",
      adapterType: "process",
      taskKey: keyTwo,
      payload: { run: 2 },
    });

    const clearedOne = fixture.service.clearAgentTaskSession({
      agentId: "worker-1",
      adapterType: "process",
      taskKey: keyOne,
    });
    expect(clearedOne).toBe(1);
    expect(fixture.service.getTaskSession("worker-1", "process", keyOne)?.payload).toEqual({});

    const clearedAll = fixture.service.clearAgentTaskSession({
      agentId: "worker-1",
      adapterType: "process",
    });
    expect(clearedAll).toBeGreaterThanOrEqual(1);
    expect(fixture.service.getTaskSession("worker-1", "process", keyTwo)?.payload).toEqual({});

    fixture.db.close();
  });
});

