import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentChatSessionSummary,
  CtoSnapshot,
  MissionSummary,
  WorkerAgentRun,
} from "../../../shared/types";
import { getEventMeta } from "./eventTaxonomy";
import {
  buildSupplementalTimelineRecords,
  fetchSupplementalTimelineRecords,
} from "./historyActivitySources";
import { enrichEvent } from "./useTimelineStore";

const chat: AgentChatSessionSummary = {
  sessionId: "chat-1",
  laneId: "lane-1",
  provider: "codex",
  model: "gpt-5.5",
  title: "Fix checkout bug",
  status: "active",
  startedAt: "2026-05-22T00:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-05-22T00:10:00.000Z",
  lastOutputPreview: "Working on the fix",
  summary: "Investigating the checkout failure",
};

const mission: MissionSummary = {
  id: "mission-1",
  title: "Ship history tab",
  prompt: "Finish the History tab",
  laneId: "lane-1",
  laneName: "History lane",
  status: "completed",
  priority: "high",
  executionMode: "local",
  targetMachineId: null,
  outcomeSummary: "History shipped",
  lastError: null,
  artifactCount: 2,
  openInterventions: 0,
  totalSteps: 4,
  completedSteps: 4,
  createdAt: "2026-05-22T00:00:00.000Z",
  updatedAt: "2026-05-22T00:20:00.000Z",
  startedAt: "2026-05-22T00:01:00.000Z",
  completedAt: "2026-05-22T00:21:00.000Z",
};

const workerRun: WorkerAgentRun = {
  id: "run-1",
  agentId: "agent-1",
  status: "failed",
  wakeupReason: "manual",
  taskKey: "task-7",
  issueKey: null,
  context: { laneId: "lane-1", laneName: "History lane" },
  errorMessage: "Tests failed",
  startedAt: "2026-05-22T00:12:00.000Z",
  finishedAt: "2026-05-22T00:13:00.000Z",
  createdAt: "2026-05-22T00:11:00.000Z",
  updatedAt: "2026-05-22T00:13:00.000Z",
};

const ctoSnapshot: CtoSnapshot = {
  identity: {
    name: "CTO",
    version: 1,
    persona: "Coordinator",
    modelPreferences: { provider: "codex", model: "gpt-5.5" },
    updatedAt: "2026-05-22T00:00:00.000Z",
  },
  recentSessions: [
    {
      id: "cto-log-1",
      sessionId: "cto-chat-1",
      summary: "Reviewed the plan",
      startedAt: "2026-05-22T00:01:00.000Z",
      endedAt: "2026-05-22T00:02:00.000Z",
      provider: "codex",
      modelId: "gpt-5.5",
      capabilityMode: "full_tooling",
      createdAt: "2026-05-22T00:02:00.000Z",
    },
  ],
  recentSubordinateActivity: [
    {
      id: "activity-1",
      agentId: "agent-1",
      agentName: "Worker 1",
      activityType: "worker_run",
      summary: "Completed review",
      taskKey: "task-8",
      issueKey: null,
      createdAt: "2026-05-22T00:03:00.000Z",
    },
  ],
};

describe("history supplemental activity sources", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps chats, missions, CTO logs, and worker task runs into timeline records", () => {
    const records = buildSupplementalTimelineRecords({
      chats: [chat],
      missions: [mission],
      workerRuns: [workerRun],
      ctoSnapshot,
    });

    expect(records.map((record) => record.kind)).toEqual(expect.arrayContaining([
      "chat.session",
      "mission.completed",
      "worker.run",
      "cto.session",
      "worker.activity",
    ]));
    expect(records.find((record) => record.id === "chat:chat-1")?.status).toBe("running");
    expect(records.find((record) => record.id === "mission:mission-1")?.status).toBe("succeeded");
    expect(records.find((record) => record.id === "worker-run:run-1")?.status).toBe("failed");
  });

  it("uses source metadata labels when enriching supplemental records", () => {
    const [record] = buildSupplementalTimelineRecords({ chats: [chat] });

    expect(record).toBeDefined();
    const event = enrichEvent(record!);

    expect(event.label).toBe("Chat: Fix checkout bug");
    expect(event.category).toBe("session");
    expect(event.metadata?.sessionId).toBe("chat-1");
  });

  it("fetches chats, missions, CTO state, and worker runs through renderer APIs", async () => {
    const agentChatList = vi.fn(async () => [chat]);
    const missionsList = vi.fn(async () => [mission]);
    const ctoGetState = vi.fn(async () => ctoSnapshot);
    const listAgentRuns = vi.fn(async () => [workerRun]);
    vi.stubGlobal("window", {
      ade: {
        agentChat: { list: agentChatList },
        missions: { list: missionsList },
        cto: {
          getState: ctoGetState,
          listAgentRuns,
        },
      },
    });

    const records = await fetchSupplementalTimelineRecords(1000);

    expect(agentChatList).toHaveBeenCalledWith({ includeAutomation: true });
    expect(missionsList).toHaveBeenCalledWith({ limit: 500, includeArchived: true });
    expect(ctoGetState).toHaveBeenCalledWith({ recentLimit: 100 });
    expect(listAgentRuns).toHaveBeenCalledWith({ limit: 100 });
    expect(records.map((record) => record.kind)).toEqual(expect.arrayContaining([
      "chat.session",
      "mission.completed",
      "worker.run",
      "cto.session",
      "worker.activity",
    ]));
  });

  it("keeps git operation records visible under the git category", () => {
    for (const kind of [
      "git_fetch",
      "git_sync_rebase",
      "git_tag_create",
      "git_reset_hard",
      "git_stash_pop",
      "git_undo_head_change",
      "git_redo_head_change",
      "git_rebase_continue",
      "git_merge_abort",
    ]) {
      const meta = getEventMeta(kind);

      expect(meta.category).toBe("git");
      expect(meta.importance).not.toBe("noise");
    }
  });
});
