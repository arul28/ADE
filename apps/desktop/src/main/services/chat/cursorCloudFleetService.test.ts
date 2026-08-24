import { describe, expect, it, vi } from "vitest";
import { createCursorCloudFleetService } from "./cursorCloudFleetService";
import { isCursorCloudFleetEntryActive } from "../../../shared/cursorCloudFleetStatus";
import type { CursorCloudAgentSummary } from "../../../shared/types/config";
import type { LaneSummary } from "../../../shared/types/lanes";

const mockGit = vi.hoisted(() => ({ runGit: vi.fn() }));
vi.mock("../git/git", () => ({
  runGit: (...args: unknown[]) => mockGit.runGit(...args),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Parameters<typeof createCursorCloudFleetService>[0]["logger"];

function agent(overrides: Partial<CursorCloudAgentSummary> & { agentId: string }): CursorCloudAgentSummary {
  return {
    name: `Agent ${overrides.agentId}`,
    summary: "does things",
    repos: ["https://github.com/arul/ade"],
    webUrl: `https://cursor.com/agents?id=${overrides.agentId}`,
    ...overrides,
  };
}

function lane(overrides: Partial<LaneSummary> & { id: string }): LaneSummary {
  return {
    name: overrides.id,
    laneType: "worktree",
    baseRef: "main",
    branchRef: `lane/${overrides.id}`,
    worktreePath: `/wt/${overrides.id}`,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: "idle",
    color: null,
    icon: null,
    tags: [],
    createdAt: new Date().toISOString(),
    linearIssue: null,
    worktreeAvailable: true,
    ...overrides,
  } as LaneSummary;
}

function buildHarness(overrides?: {
  agents?: CursorCloudAgentSummary[];
  runs?: Array<Record<string, unknown>>;
}) {
  // Default git behavior: origin resolves to the test repo, worktrees are
  // clean, fetch/merge succeed. Individual tests override per-command.
  // Cleared per-harness so cross-test call assertions stay isolated.
  mockGit.runGit.mockClear();
  mockGit.runGit.mockImplementation(async (args: string[]) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      return { exitCode: 0, stdout: "https://github.com/arul/ade.git\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const listCursorCloudAgents = vi.fn(async () => ({
    items: overrides?.agents ?? [],
  }));
  const listCursorCloudRuns = vi.fn(async (_args: { agentId: string; limit?: number }) => ({
    items: overrides?.runs ?? [],
  }));
  const lanes: LaneSummary[] = [];
  let importBranchCalls = 0;
  const laneService = {
    list: vi.fn(async () => lanes),
    importBranch: vi.fn(async (args: { branchRef: string; name?: string }) => {
      importBranchCalls += 1;
      const created = lane({ id: `imported-${importBranchCalls}`, branchRef: args.branchRef, name: args.branchRef });
      lanes.push(created);
      return created;
    }),
  };
  const sessionLinks: Array<{ sessionId: string; agentId: string; laneId: string; title: string | null }> = [];
  const openCursorCloudChat = vi.fn(async (args: { cloudAgentId: string; laneId: string }) => ({
    sessionId: `session-for-${args.cloudAgentId}`,
  }));
  const cancelCursorCloudRun = vi.fn(async () => undefined);
  const gitCommands: string[][] = [];
  const service = createCursorCloudFleetService({
    projectRoot: "/proj",
    logger,
    listCursorCloudAgents,
    listCursorCloudRuns,
    laneService,
    listCursorCloudSessionLinks: async () => sessionLinks,
    openCursorCloudChat,
    cancelCursorCloudRun,
    getIngressStatus: () => ({ state: "ready", lastEventAt: null }),
  });
  return { service, listCursorCloudAgents, listCursorCloudRuns, laneService, lanes, sessionLinks, openCursorCloudChat, cancelCursorCloudRun, gitCommands };
}

describe("cursorCloudFleetService", () => {
  describe("project scoping", () => {
    it("keeps agents whose repo matches the project origin", async () => {
      const harness = buildHarness({ agents: [agent({ agentId: "bc-1" })] });
      const result = await harness.service.getFleet();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].matchedBy).toBe("repo");
      expect(result.items[0].ownership.laneId).toBeNull();
    });

    it("keeps unlinked foreign-repo agents when a project session links them", async () => {
      const harness = buildHarness({
        agents: [agent({ agentId: "bc-2", repos: ["https://github.com/other/repo"] })],
      });
      harness.sessionLinks.push({ sessionId: "s1", agentId: "bc-2", laneId: "lane-1", title: "T" });
      harness.lanes.push(lane({ id: "lane-1" }));
      const result = await harness.service.getFleet();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].matchedBy).toBe("session");
      expect(result.items[0].ownership.laneName).toBe("lane-1");
    });

    it("drops agents that are neither linked nor repo-matched", async () => {
      const harness = buildHarness({
        agents: [
          agent({ agentId: "bc-3", repos: ["https://github.com/other/repo"] }),
          agent({ agentId: "bc-4" }),
        ],
      });
      const result = await harness.service.getFleet();
      expect(result.items.map((entry) => entry.agent.agentId)).toEqual(["bc-4"]);
      expect(result.items[0].matchedBy).toBe("repo");
    });
  });

  describe("archived rows", () => {
    it("hides archived entries unless includeArchived is set", async () => {
      const harness = buildHarness({
        agents: [agent({ agentId: "bc-live" }), agent({ agentId: "bc-old", archived: true })],
      });
      const hidden = await harness.service.getFleet({ includeArchived: false });
      expect(hidden.items.map((entry) => entry.agent.agentId)).toEqual(["bc-live"]);
      const shown = await harness.service.getFleet({ includeArchived: true });
      expect(shown.items).toHaveLength(2);
    });
  });

  describe("active-run enrichment", () => {
    it("fetches latest runs only for live agents and refines branch/pr/status", async () => {
      const harness = buildHarness({
        agents: [
          agent({ agentId: "bc-run", status: "running" }),
          agent({ agentId: "bc-done", status: "finished" }),
        ],
        runs: [{
          id: "run-9",
          agentId: "bc-run",
          status: "RUNNING",
          git: { branches: [{ repoUrl: "github.com/arul/ade", branch: "cursor/fix-1", prUrl: "https://github.com/arul/ade/pull/7" }] },
        }],
      });
      const result = await harness.service.getFleet({ includeArchived: false });
      expect(harness.listCursorCloudRuns).toHaveBeenCalledTimes(1);
      expect(harness.listCursorCloudRuns).toHaveBeenCalledWith(expect.objectContaining({ agentId: "bc-run", limit: 1 }));
      const enriched = result.items.find((entry) => entry.agent.agentId === "bc-run");
      expect(enriched?.branch).toBe("cursor/fix-1");
      expect(enriched?.prUrl).toBe("https://github.com/arul/ade/pull/7");
      expect(enriched?.runStatus).toBe("running");
      expect(enriched?.latestRunId).toBe("run-9");
      const finishedRow = result.items.find((entry) => entry.agent.agentId === "bc-done");
      expect(finishedRow?.branch).toBeNull();
    });
  });

  describe("isCursorCloudFleetEntryActive", () => {
    const base = { agent: agent({ agentId: "x" }), latestRunId: null, branch: null, prUrl: null, modelId: null, matchedBy: "repo" as const };
    it("treats archived or terminal rows as inactive even if the list lagged", () => {
      expect(isCursorCloudFleetEntryActive({ ...base, runStatus: "running" })).toBe(true);
      expect(isCursorCloudFleetEntryActive({ ...base, runStatus: "finished" })).toBe(false);
      expect(isCursorCloudFleetEntryActive({ ...base, agent: agent({ agentId: "x", archived: true, status: "running" }) })).toBe(false);
    });
    it("reads an unknown run status on a live agent as creating (active)", () => {
      expect(isCursorCloudFleetEntryActive({
        ...base,
        runStatus: undefined,
        agent: agent({ agentId: "x" }),
      })).toBe(true);
    });
  });

  describe("branch-name safety", () => {
    it("refuses to fetch a branch name that git would parse as an option", async () => {
      const harness = buildHarness({
        agents: [agent({ agentId: "bc-evil", status: "finished" })],
        runs: [{ id: "run-e", agentId: "bc-evil", status: "FINISHED", git: { branches: [{ branch: "--upload-pack=/bin/echo pwned" }] } }],
      });
      await expect(harness.service.pullIntoLane("bc-evil")).rejects.toThrow(/unusable branch name/i);
      const fetchCalls = mockGit.runGit.mock.calls.filter((call) => call[0][0] === "fetch");
      expect(fetchCalls).toHaveLength(0);
    });
  });

  describe("multi-repo pull scoping", () => {
    it("skips branches pushed to other repos and pulls this project's branch", async () => {
      const harness = buildHarness({
        agents: [agent({ agentId: "bc-multi", status: "finished", repos: ["https://github.com/arul/ade"] })],
        runs: [{
          id: "run-m",
          agentId: "bc-multi",
          status: "FINISHED",
          git: { branches: [
            { repoUrl: "github.com/other/repo", branch: "cursor/wrong-repo" },
            { repoUrl: "github.com/arul/ade", branch: "cursor/right-repo" },
          ] },
        }],
      });
      harness.lanes.push(lane({ id: "lane-1", branchRef: "main" }));
      const result = await harness.service.pullIntoLane("bc-multi");
      expect(result.mergedBranch).toBe("cursor/right-repo");
    });

    it("refuses instead of name-fetching when every pushed branch belongs to another repo", async () => {
      const harness = buildHarness({
        agents: [agent({ agentId: "bc-foreign", status: "finished" })],
        runs: [{
          id: "run-f",
          agentId: "bc-foreign",
          status: "FINISHED",
          git: { branches: [{ repoUrl: "github.com/other/repo", branch: "main" }] },
        }],
      });
      await expect(harness.service.pullIntoLane("bc-foreign")).rejects.toThrow(
        /only pushed branches to other repositories/i,
      );
      const fetchCalls = mockGit.runGit.mock.calls.filter((call) => call[0][0] === "fetch");
      expect(fetchCalls).toHaveLength(0);
    });

    it("surfaces a transient run-read failure as its own error, not 'no pushed branch'", async () => {
      const harness = buildHarness({
        agents: [agent({ agentId: "bc-flaky", status: "finished" })],
      });
      harness.listCursorCloudRuns.mockRejectedValue(new Error("cursor api timeout"));
      await expect(harness.service.pullIntoLane("bc-flaky")).rejects.toThrow(
        /could not read this agent's latest run.*cursor api timeout/i,
      );
    });

    it("scopes resolveLaneForAgent to this project's repos and never imports a foreign branch", async () => {
      const harness = buildHarness({
        agents: [agent({ agentId: "bc-res", status: "running" })],
        runs: [{
          id: "run-r",
          agentId: "bc-res",
          status: "RUNNING",
          git: { branches: [{ repoUrl: "github.com/other/repo", branch: "cursor/foreign" }] },
        }],
      });
      await expect(harness.service.resolveLaneForAgent("bc-res")).rejects.toThrow(
        /only pushed branches to other repositories/i,
      );
      expect(harness.laneService.importBranch).not.toHaveBeenCalled();
    });

    it("matches lanes on exact case-sensitive branch names, not URL canonicalization", async () => {
      const harness = buildHarness({
        agents: [agent({ agentId: "bc-case", status: "finished" })],
        runs: [{
          id: "run-c",
          agentId: "bc-case",
          status: "FINISHED",
          git: { branches: [{ branch: "Feature/X" }] },
        }],
      });
      // A lane whose branch differs only by case must NOT absorb the pull;
      // a new lane gets imported from the exact ref instead.
      harness.lanes.push(lane({ id: "lane-lower", branchRef: "feature/x" }));
      const result = await harness.service.pullIntoLane("bc-case");
      expect(result.status).toBe("created_lane");
      expect(result.mergedBranch).toBe("Feature/X");
    });

    it("shows the project's own branch on enriched rows for multi-repo agents", async () => {
      const harness = buildHarness({
        agents: [agent({ agentId: "bc-row", status: "running" })],
        runs: [{
          id: "run-row",
          agentId: "bc-row",
          status: "RUNNING",
          git: { branches: [
            { repoUrl: "github.com/other/repo", branch: "cursor/foreign", prUrl: "https://github.com/other/repo/pull/1" },
            { repoUrl: "github.com/arul/ade", branch: "cursor/mine", prUrl: "https://github.com/arul/ade/pull/2" },
          ] },
        }],
      });
      const result = await harness.service.getFleet({ includeArchived: false });
      const row = result.items.find((entry) => entry.agent.agentId === "bc-row");
      expect(row?.branch).toBe("cursor/mine");
      expect(row?.prUrl).toBe("https://github.com/arul/ade/pull/2");
    });
  });

  describe("pullIntoLane", () => {
    function finishedAgent(id: string): CursorCloudAgentSummary[] {
      return [agent({ agentId: id, status: "finished" })];
    }

    it("refuses to pull into a lane with uncommitted changes", async () => {
      const harness = buildHarness({
        agents: finishedAgent("bc-dirty"),
        runs: [{ id: "run-4", agentId: "bc-dirty", status: "FINISHED", git: { branches: [{ branch: "lane/lane-1" }] } }],
      });
      harness.lanes.push(lane({ id: "lane-1", branchRef: "lane/lane-1" }));
      mockGit.runGit.mockImplementation(async (args: string[]) => {
        if (args[0] === "status") {
          return { exitCode: 0, stdout: " M src/app.ts\n", stderr: "" };
        }
        if (args[0] === "remote") {
          return { exitCode: 0, stdout: "https://github.com/arul/ade.git\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      await expect(harness.service.pullIntoLane("bc-dirty")).rejects.toThrow(/uncommitted changes/i);
      expect(harness.laneService.importBranch).not.toHaveBeenCalled();
    });

    it("aborts and reports a conflicted merge instead of claiming success", async () => {
      const harness = buildHarness({
        agents: finishedAgent("bc-conflict"),
        runs: [{ id: "run-5", agentId: "bc-conflict", status: "FINISHED", git: { branches: [{ branch: "lane/lane-1" }] } }],
      });
      harness.lanes.push(lane({ id: "lane-1", branchRef: "lane/lane-1" }));
      mockGit.runGit.mockImplementation(async (args: string[]) => {
        if (args[0] === "merge" && args[1] === "--no-edit") {
          return { exitCode: 1, stdout: "", stderr: "CONFLICT (content): Merge conflict in src/app.ts" };
        }
        if (args[0] === "remote") {
          return { exitCode: 0, stdout: "https://github.com/arul/ade.git\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      await expect(harness.service.pullIntoLane("bc-conflict")).rejects.toThrow(/conflicted.*aborted/i);
      const mergeCalls = mockGit.runGit.mock.calls.filter((call) => call[0][0] === "merge");
      expect(mergeCalls.some((call) => call[0][1] === "--abort")).toBe(true);
    });

    it("refuses to pull an unfinished agent", async () => {
      const harness = buildHarness({
        agents: [agent({ agentId: "bc-x", status: "running" })],
        runs: [{ id: "run-1", agentId: "bc-x", status: "RUNNING", git: { branches: [{ branch: "cursor/x" }] } }],
      });
      await expect(harness.service.pullIntoLane("bc-x")).rejects.toThrow(/still running/i);
    });

    it("refuses when the agent pushed no branch", async () => {
      const harness = buildHarness({ agents: finishedAgent("bc-y") });
      await expect(harness.service.pullIntoLane("bc-y")).rejects.toThrow(/did not push a branch/i);
    });

    it("merges into a dirty-worktree-free matching lane without creating one", async () => {
      const harness = buildHarness({
        agents: finishedAgent("bc-z"),
        runs: [{ id: "run-2", agentId: "bc-z", status: "FINISHED", git: { branches: [{ branch: "lane/lane-1" }] } }],
      });
      harness.lanes.push(lane({ id: "lane-1", branchRef: "lane/lane-1" }));
      const result = await harness.service.pullIntoLane("bc-z");
      expect(result.status).toBe("pulled");
      expect(result.laneId).toBe("lane-1");
      expect(harness.laneService.importBranch).not.toHaveBeenCalled();
      expect(harness.openCursorCloudChat).toHaveBeenCalledWith(
        expect.objectContaining({ cloudAgentId: "bc-z", laneId: "lane-1" }),
      );
    });

    it("creates a new lane when no local lane matches the branch", async () => {
      const harness = buildHarness({
        agents: finishedAgent("bc-new"),
        runs: [{ id: "run-3", agentId: "bc-new", status: "FINISHED", git: { branches: [{ branch: "cursor/fresh" }] } }],
      });
      const result = await harness.service.pullIntoLane("bc-new");
      expect(result.status).toBe("created_lane");
      expect(result.mergedBranch).toBe("cursor/fresh");
      expect(harness.laneService.importBranch).toHaveBeenCalledWith(
        expect.objectContaining({ branchRef: "cursor/fresh" }),
      );
    });
  });

  describe("resolveLaneForAgent", () => {
    it("prefers the linked session's lane and never creates one", async () => {
      const harness = buildHarness({ agents: [] });
      harness.sessionLinks.push({ sessionId: "s9", agentId: "bc-link", laneId: "lane-9", title: null });
      harness.lanes.push(lane({ id: "lane-9" }));
      const resolved = await harness.service.resolveLaneForAgent("bc-link");
      expect(resolved).toEqual({ laneId: "lane-9", laneName: "lane-9", created: false });
      expect(harness.listCursorCloudRuns).not.toHaveBeenCalled();
    });

    it("errors honestly when there is no link and no pushed branch", async () => {
      const harness = buildHarness({ agents: [] });
      await expect(harness.service.resolveLaneForAgent("bc-none")).rejects.toThrow(/no pushed branch/i);
    });
  });

  describe("stopAgentRun", () => {
    it("cancels the latest run", async () => {
      const harness = buildHarness({
        agents: [],
        runs: [{ id: "run-77", agentId: "bc-stop" }],
      });
      const result = await harness.service.stopAgentRun("bc-stop");
      expect(result.stopped).toBe(true);
      expect(harness.cancelCursorCloudRun).toHaveBeenCalledWith({ agentId: "bc-stop", runId: "run-77" });
    });

    it("says so when there is nothing to stop", async () => {
      const harness = buildHarness({ agents: [], runs: [] });
      await expect(harness.service.stopAgentRun("bc-idle")).rejects.toThrow(/no runs to stop/i);
    });
  });
});
