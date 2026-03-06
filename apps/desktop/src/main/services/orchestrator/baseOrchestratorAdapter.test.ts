import { describe, expect, it } from "vitest";
import { buildFullPrompt } from "./baseOrchestratorAdapter";

describe("buildFullPrompt", () => {
  it("injects shared facts, mission memory, and project knowledge into worker prompts", () => {
    const memoryService = {
      getSharedFacts: () => [
        {
          id: "fact-1",
          runId: "run-1",
          stepId: "step-1",
          factType: "gotcha",
          content: "Peer worker found that the fixture needs a seeded repo.",
          createdAt: "2026-03-05T12:00:00.000Z",
        },
      ],
      getMemoryBudget: (_projectId: string, _level: string, opts?: { scope?: string; scopeOwnerId?: string | null }) => {
        if (opts?.scope === "mission" && opts.scopeOwnerId === "run-1") {
          return [
            {
              id: "mem-mission-1",
              category: "pattern",
              content: "Mission memory stays scoped to the current run.",
              importance: "medium",
            },
          ];
        }
        return [
          {
            id: "mem-project-1",
            category: "decision",
            content: "Project-wide decisions should stay visible across runs.",
            importance: "high",
          },
        ];
      },
    } as any;

    const prompt = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: {
            missionGoal: "Stabilize W6 memory behavior",
          },
        } as any,
        step: {
          id: "step-1",
          title: "Fix mission memory scoping",
          stepKey: "fix-memory",
          laneId: "lane-1",
          metadata: {},
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: {
          content: "Project context body",
        } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "unified",
      {
        memoryService,
        projectId: "project-1",
      }
    );

    expect(prompt.prompt).toContain("## Shared Team Knowledge");
    expect(prompt.prompt).toContain("## Mission Memory");
    expect(prompt.prompt).toContain("Mission memory stays scoped to the current run.");
    expect(prompt.prompt).toContain("## Project Knowledge");
    expect(prompt.prompt).toContain("Project-wide decisions should stay visible across runs.");
  });

  it("routes read-only workers to ADE result reporting instead of file writes", () => {
    const prompt = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: {
            missionGoal: "Research the sidebar flow",
          },
        } as any,
        step: {
          id: "step-1",
          title: "Plan sidebar changes",
          stepKey: "plan-sidebar",
          laneId: "lane-1",
          metadata: {
            readOnlyExecution: true,
          },
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: {
          content: "Project context body",
        } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "unified",
      {}
    );

    expect(prompt.prompt).toContain("ALWAYS call `report_result`");
    expect(prompt.prompt).toContain("This step cannot write files.");
    expect(prompt.prompt).not.toContain("PROGRESS CHECKPOINTING:");
    expect(prompt.prompt).not.toContain("STEP OUTPUT FILE:");
  });

  it("keeps checkpoint and step output instructions for writable workers", () => {
    const prompt = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: {
            missionGoal: "Implement the sidebar flow",
          },
        } as any,
        step: {
          id: "step-1",
          title: "Implement sidebar changes",
          stepKey: "implement-sidebar",
          laneId: "lane-1",
          metadata: {},
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: {
          content: "Project context body",
        } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "unified",
      {}
    );

    expect(prompt.prompt).toContain("ALWAYS call `report_result`");
    expect(prompt.prompt).toContain("PROGRESS CHECKPOINTING:");
    expect(prompt.prompt).toContain("STEP OUTPUT FILE:");
  });
});
