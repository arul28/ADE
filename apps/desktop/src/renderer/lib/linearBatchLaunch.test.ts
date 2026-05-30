import { describe, expect, it, vi } from "vitest";
import type { LaneLinearIssue, LaneSummary } from "../../shared/types";
import {
  defaultKickoffPrompt,
  findIssueConflicts,
  runBatchLaunch,
  type BatchLaunchDeps,
  type BatchLaunchIssueConfig,
} from "./linearBatchLaunch";

/** A no-op CLI launch dep for chat-focused tests (BatchLaunchDeps requires it). */
function makeLaunchCli(): BatchLaunchDeps["launchCli"] {
  return vi.fn(async () => ({ sessionId: "cli-sess" }));
}

function makeIssue(overrides: Partial<LaneLinearIssue> = {}): LaneLinearIssue {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "ENG-1",
    title: overrides.title ?? "Fix OAuth",
    url: null,
    projectId: "proj-1",
    projectSlug: "core",
    teamId: "team-1",
    teamKey: "ENG",
    stateId: "state-1",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 2,
    priorityLabel: "normal",
    labels: [],
    assigneeId: null,
    assigneeName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<BatchLaunchIssueConfig> = {}): BatchLaunchIssueConfig {
  return {
    modelId: "anthropic/claude-opus-4-8",
    reasoningEffort: null,
    codexFastMode: false,
    kickoffPrompt: "",
    branchOverride: "",
    ...overrides,
  };
}

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: overrides.id ?? "lane-1",
    name: overrides.name ?? "ade/eng-1",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "ade/eng-1",
    worktreePath: "/tmp/lane",
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    ...overrides,
  } as LaneSummary;
}

describe("findIssueConflicts", () => {
  it("flags issues already attached to a lane as the primary issue", () => {
    const issues = [makeIssue({ id: "a" }), makeIssue({ id: "b" })];
    const lanes = [makeLane({ id: "lane-a", name: "Lane A", linearIssue: makeIssue({ id: "a" }) })];
    const conflicts = findIssueConflicts(issues, lanes);
    expect(conflicts.get("a")).toEqual({ laneId: "lane-a", laneName: "Lane A", reason: "lane" });
    expect(conflicts.has("b")).toBe(false);
  });

  it("flags issues attached to a lane's chat/CLI session", () => {
    const issues = [makeIssue({ id: "a" })];
    const lanes = [
      makeLane({
        id: "lane-x",
        name: "Lane X",
        linearIssueLinks: [
          {
            id: "link-1",
            laneId: "lane-x",
            issue: makeIssue({ id: "a" }),
            role: "primary",
            source: "chat_attach",
            includeInPr: true,
            closeOnMerge: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ];
    const conflicts = findIssueConflicts(issues, lanes);
    expect(conflicts.get("a")).toEqual({ laneId: "lane-x", laneName: "Lane X", reason: "session" });
  });

  it("prefers the primary-lane reason over a session attachment", () => {
    const issues = [makeIssue({ id: "a" })];
    const lanes = [
      makeLane({ id: "lane-a", name: "Lane A", linearIssue: makeIssue({ id: "a" }) }),
      makeLane({
        id: "lane-x",
        name: "Lane X",
        linearIssueLinks: [
          {
            id: "link-1",
            laneId: "lane-x",
            issue: makeIssue({ id: "a" }),
            role: "primary",
            source: "chat_attach",
            includeInPr: true,
            closeOnMerge: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ];
    const conflicts = findIssueConflicts(issues, lanes);
    expect(conflicts.get("a")?.reason).toBe("lane");
    expect(conflicts.get("a")?.laneId).toBe("lane-a");
  });
});

describe("defaultKickoffPrompt", () => {
  it("is generic — names no specific issue so it is safe to share across a batch", () => {
    const prompt = defaultKickoffPrompt();
    // Must NOT bake in any specific identifier; the agent reads its attached issue.
    expect(prompt).not.toMatch(/[A-Z]{2,}-\d+/);
    expect(prompt).toContain("ADE_LINEAR_ISSUE_IDS");
    expect(prompt).toContain("ade linear");
  });
});

describe("runBatchLaunch", () => {
  it("launches every issue: lane → headless launch (session + kickoff)", async () => {
    const createLane = vi.fn(async (args: { name: string; linearIssue: LaneLinearIssue; branchName?: string }) => ({ id: `lane-${args.name}` }));
    const launch = vi.fn(async (args: { kickoffText: string; contextAttachments?: unknown[] }) => {
      void args;
      return { id: "sess" };
    });
    const onItem = vi.fn();

    const entries = [
      { issue: makeIssue({ id: "a", identifier: "ENG-1" }), config: makeConfig() },
      { issue: makeIssue({ id: "b", identifier: "ENG-2" }), config: makeConfig() },
    ];
    const result = await runBatchLaunch(entries, { createLane, launch, launchCli: makeLaunchCli() }, { onItem });

    expect(createLane).toHaveBeenCalledTimes(2);
    expect(createLane.mock.calls[0]?.[0]).not.toHaveProperty("branchName");
    expect(createLane.mock.calls[0]?.[0]?.linearIssue).toMatchObject({ id: "a", identifier: "ENG-1" });
    expect(launch).toHaveBeenCalledTimes(2);
    // The kickoff text is GENERIC (names no issue); each agent's specific issue
    // rides on its own context attachment — so agents never cross-wire.
    expect(launch.mock.calls[0]?.[0]?.kickoffText).not.toMatch(/[A-Z]{2,}-\d+/);
    expect(launch.mock.calls[0]?.[0]?.contextAttachments?.[0]).toMatchObject({ type: "linear_issue" });
    expect(JSON.stringify(launch.mock.calls[0]?.[0]?.contextAttachments)).toContain("ENG-1");
    expect(JSON.stringify(launch.mock.calls[1]?.[0]?.contextAttachments)).toContain("ENG-2");
    expect(result.createdLaneIds).toHaveLength(2);
    expect(result.createdSessionIds).toHaveLength(2);
    expect(result.failedIssueIds).toHaveLength(0);
  });

  it("passes only user branch overrides as explicit branch names", async () => {
    const createLane = vi.fn(async (_args: { name: string; linearIssue: LaneLinearIssue; branchName?: string }) => ({ id: "lane-a" }));
    const launch = vi.fn(async () => ({ id: "sess" }));

    await runBatchLaunch(
      [{ issue: makeIssue({ id: "a" }), config: makeConfig({ branchOverride: "custom/branch" }) }],
      { createLane, launch, launchCli: makeLaunchCli() },
      { onItem: vi.fn() },
    );

    expect(createLane.mock.calls[0]?.[0]).toMatchObject({
      branchName: "custom/branch",
      linearIssue: expect.objectContaining({ id: "a" }),
    });
  });

  it("keeps siblings alive when one issue fails and records the failure", async () => {
    const createLane = vi.fn(async (args: { name: string; linearIssue: { id: string } }) => {
      if (args.linearIssue.id === "b") throw new Error("worktree add failed");
      return { id: `lane-${args.linearIssue.id}` };
    });
    const launch = vi.fn(async () => ({ id: "sess" }));
    const onItem = vi.fn();

    const entries = [
      { issue: makeIssue({ id: "a" }), config: makeConfig() },
      { issue: makeIssue({ id: "b" }), config: makeConfig() },
      { issue: makeIssue({ id: "c" }), config: makeConfig() },
    ];
    const result = await runBatchLaunch(entries, { createLane, launch, launchCli: makeLaunchCli() }, { onItem });

    expect(result.failedIssueIds).toEqual(["b"]);
    expect(result.createdLaneIds).toEqual(expect.arrayContaining(["lane-a", "lane-c"]));
    expect(result.createdSessionIds).toHaveLength(2);
  });

  it("rolls back the lane when the agent launch fails after lane creation", async () => {
    const createLane = vi.fn(async (args: { linearIssue: { id: string } }) => ({ id: `lane-${args.linearIssue.id}` }));
    const launch = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const deleteLane = vi.fn(async () => undefined);
    const onItem = vi.fn();

    const entries = [{ issue: makeIssue({ id: "a" }), config: makeConfig() }];
    const result = await runBatchLaunch(
      entries,
      { createLane, launch, launchCli: makeLaunchCli(), deleteLane },
      { onItem },
    );

    expect(deleteLane).toHaveBeenCalledWith({
      laneId: "lane-a",
      force: true,
      deleteBranch: true,
      deleteRemoteBranch: true,
      remoteName: "origin",
    });
    expect(result.createdLaneIds).toHaveLength(0);
    expect(result.failedIssueIds).toEqual(["a"]);
  });

  it("surfaces the orphan (never silently) when both launch and rollback fail", async () => {
    const createLane = vi.fn(async (args: { linearIssue: { id: string } }) => ({ id: `lane-${args.linearIssue.id}` }));
    const launch = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const deleteLane = vi.fn(async () => {
      throw new Error("worktree busy");
    });
    const onItem = vi.fn();

    const entries = [{ issue: makeIssue({ id: "a" }), config: makeConfig() }];
    const result = await runBatchLaunch(
      entries,
      { createLane, launch, launchCli: makeLaunchCli(), deleteLane },
      { onItem },
    );

    expect(deleteLane).toHaveBeenCalledWith({
      laneId: "lane-a",
      force: true,
      deleteBranch: true,
      deleteRemoteBranch: true,
      remoteName: "origin",
    });
    // Rollback failed, so the lane stays visible instead of becoming an invisible orphan.
    expect(result.createdLaneIds).toEqual(["lane-a"]);
    expect(result.failedIssueIds).toEqual(["a"]);
    const failedCalls = onItem.mock.calls.filter(([, patch]) => patch && patch.status === "failed");
    const failed = failedCalls[failedCalls.length - 1];
    expect(failed?.[1].laneId).toBe("lane-a");
    expect(failed?.[1].error).toMatch(/manual cleanup/i);
  });

  it("respects the concurrency cap", async () => {
    let active = 0;
    let maxActive = 0;
    const createLane = vi.fn(async (args: { linearIssue: { id: string } }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { id: `lane-${args.linearIssue.id}` };
    });
    const launch = vi.fn(async () => ({ id: "sess" }));

    const entries = Array.from({ length: 8 }, (_, i) => ({
      issue: makeIssue({ id: `i${i}` }),
      config: makeConfig(),
    }));
    await runBatchLaunch(entries, { createLane, launch, launchCli: makeLaunchCli() }, { onItem: vi.fn(), concurrency: 3 });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("creates the lane only when laneOnly is set (no agent launch)", async () => {
    const createLane = vi.fn(async () => ({ id: "lane-a" }));
    const launch = vi.fn(async () => ({ id: "sess" }));

    const entries = [{ issue: makeIssue({ id: "a" }), config: makeConfig({ laneOnly: true }) }];
    const result = await runBatchLaunch(entries, { createLane, launch, launchCli: makeLaunchCli() }, { onItem: vi.fn() });

    expect(createLane).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    expect(result.createdLaneIds).toEqual(["lane-a"]);
  });

  it("dispatches to launchCli (not launch) when sessionType is cli", async () => {
    const createLane = vi.fn(async (args: { linearIssue: { id: string } }) => ({ id: `lane-${args.linearIssue.id}` }));
    const launch = vi.fn(async () => ({ id: "sess" }));
    const launchCli = vi.fn(async (args: { laneId: string; kickoffPrompt: string }) => {
      void args;
      return { sessionId: "cli-1" };
    });

    const entries = [
      { issue: makeIssue({ id: "a", identifier: "ENG-7" }), config: makeConfig({ sessionType: "cli", permissionMode: "plan" }) },
    ];
    const result = await runBatchLaunch(entries, { createLane, launch, launchCli }, { onItem: vi.fn() });

    expect(launch).not.toHaveBeenCalled();
    expect(launchCli).toHaveBeenCalledTimes(1);
    expect(launchCli.mock.calls[0]?.[0]).toMatchObject({
      laneId: "lane-a",
      permissionMode: "plan",
      // Generic kickoff; the issue identity rides on linearIssues (per-issue).
      linearIssues: [expect.objectContaining({ id: "a" })],
    });
    expect(launchCli.mock.calls[0]?.[0]?.kickoffPrompt).not.toMatch(/[A-Z]{2,}-\d+/);
    expect(result.createdSessionIds).toEqual(["cli-1"]);
  });

  it("launches into an existing lane without creating or rolling one back", async () => {
    const createLane = vi.fn(async () => ({ id: "lane-new" }));
    const launch = vi.fn(async (args: { laneId: string }) => {
      void args;
      return { id: "sess" };
    });
    const deleteLane = vi.fn(async () => undefined);

    const entries = [
      { issue: makeIssue({ id: "a" }), config: makeConfig({ existingLaneId: "lane-existing" }) },
    ];
    const result = await runBatchLaunch(
      entries,
      { createLane, launch, launchCli: makeLaunchCli(), deleteLane },
      { onItem: vi.fn() },
    );

    expect(createLane).not.toHaveBeenCalled();
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ laneId: "lane-existing" });
    // An existing lane is never recorded as created (so it is never highlighted
    // as fresh) nor rolled back.
    expect(result.createdLaneIds).toHaveLength(0);
    expect(result.createdSessionIds).toEqual(["sess"]);
  });

  it("does not roll back an existing lane when the agent launch fails", async () => {
    const createLane = vi.fn(async () => ({ id: "lane-new" }));
    const launch = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const deleteLane = vi.fn(async () => undefined);

    const entries = [
      { issue: makeIssue({ id: "a" }), config: makeConfig({ existingLaneId: "lane-existing" }) },
    ];
    const result = await runBatchLaunch(
      entries,
      { createLane, launch, launchCli: makeLaunchCli(), deleteLane },
      { onItem: vi.fn() },
    );

    expect(deleteLane).not.toHaveBeenCalled();
    expect(result.failedIssueIds).toEqual(["a"]);
    expect(result.createdLaneIds).toHaveLength(0);
  });
});
