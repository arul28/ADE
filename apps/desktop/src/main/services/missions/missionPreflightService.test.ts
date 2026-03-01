import { describe, expect, it } from "vitest";
import type { MissionPreflightBudgetEstimate, PhaseProfile } from "../../../shared/types";
import { createBuiltInPhaseCards } from "./phaseEngine";
import { createMissionPreflightService } from "./missionPreflightService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

function createProfiles(): PhaseProfile[] {
  const phases = createBuiltInPhaseCards("2026-02-27T00:00:00.000Z");
  return [
    {
      id: "profile:default",
      name: "Default",
      description: "Default mission profile",
      phases,
      isBuiltIn: true,
      isDefault: true,
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:00.000Z",
    }
  ];
}

function createBudgetEstimate(mode: "subscription" | "api-key"): MissionPreflightBudgetEstimate {
  const phases = createBuiltInPhaseCards("2026-02-27T00:00:00.000Z");
  return {
    mode,
    estimatedTokens: 12_000,
    estimatedCostUsd: 2.4,
    estimatedTimeMs: 30 * 60_000,
    perPhase: phases.map((phase) => ({
      phaseKey: phase.phaseKey,
      phaseName: phase.name,
      estimatedTokens: 2_400,
      estimatedCostUsd: 0.48,
      estimatedTimeMs: 6 * 60_000,
      configuredMaxTokens: phase.budget.maxTokens ?? null,
      configuredMaxTimeMs: phase.budget.maxTimeMs ?? null
    }))
  };
}

describe("missionPreflightService", () => {
  it("passes launch preflight when runtime prerequisites are satisfied", async () => {
    const profiles = createProfiles();
    const service = createMissionPreflightService({
      logger: createLogger(),
      projectRoot: "/tmp/ade-preflight",
      missionService: {
        listPhaseProfiles: () => profiles
      } as any,
      laneService: {
        list: async () => [
          { id: "lane-1", archivedAt: null },
          { id: "lane-2", archivedAt: null },
          { id: "lane-3", archivedAt: null },
          { id: "lane-4", archivedAt: null },
        ]
      } as any,
      aiIntegrationService: {
        getAvailabilityAsync: async () => ({
          availableModels: [
            { id: "anthropic/claude-sonnet-4-6", shortId: "claude-sonnet-4-6", family: "anthropic", displayName: "Claude Sonnet 4.6" },
            { id: "claude-sonnet-4-6", shortId: "claude-sonnet-4-6", family: "claude", displayName: "Claude Sonnet 4.6" },
            { id: "openai/gpt-5.3-codex", shortId: "gpt-5.3-codex", family: "openai", displayName: "GPT-5.3 Codex" },
            { id: "gpt-5.3-codex", shortId: "gpt-5.3-codex", family: "codex", displayName: "GPT-5.3 Codex" },
          ]
        }),
        executeTask: async () => ({ structuredOutput: { clear: true, feedback: [] } })
      } as any,
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              permissions: {
                claude: { permissionMode: "bypassPermissions" },
                codex: { approvalMode: "full-auto" }
              }
            }
          }
        })
      } as any,
      missionBudgetService: {
        estimateLaunchBudget: async () => ({
          estimate: createBudgetEstimate("subscription"),
          hardLimitExceeded: false,
          windowUsageCostUsd: 0.6,
          remainingWindowCostUsd: 10.4,
          budgetLimitCostUsd: 11
        })
      } as any
    });

    const result = await service.runPreflight({
      launch: {
        prompt: "Implement mission orchestration improvements.",
        phaseProfileId: profiles[0]!.id,
        phaseOverride: profiles[0]!.phases,
        modelConfig: {
          orchestratorModel: {
            provider: "claude",
            modelId: "claude-sonnet-4-6"
          }
        },
        executionPolicy: {
          teamRuntime: {
            enabled: true,
            teammateCount: 2
          }
        } as any
      }
    });

    expect(result.canLaunch).toBe(true);
    expect(result.hardFailures).toBe(0);
    expect(result.checklist.find((item) => item.id === "models")?.severity).toBe("pass");
    expect(result.checklist.find((item) => item.id === "permissions")?.severity).toBe("pass");
    expect(result.checklist.find((item) => item.id === "worktrees")?.severity).toBe("pass");
    expect(result.checklist.find((item) => item.id === "budget")?.severity).toBe("warning");
  });

  it("blocks launch when budget estimate exceeds API-key envelope", async () => {
    const profiles = createProfiles();
    const service = createMissionPreflightService({
      logger: createLogger(),
      projectRoot: "/tmp/ade-preflight",
      missionService: {
        listPhaseProfiles: () => profiles
      } as any,
      laneService: {
        list: async () => [{ id: "lane-1", archivedAt: null }, { id: "lane-2", archivedAt: null }]
      } as any,
      aiIntegrationService: {
        getAvailabilityAsync: async () => ({
          availableModels: [
            { id: "anthropic/claude-sonnet-4-6", shortId: "claude-sonnet-4-6", family: "anthropic", displayName: "Claude Sonnet 4.6" },
            { id: "claude-sonnet-4-6", shortId: "claude-sonnet-4-6", family: "claude", displayName: "Claude Sonnet 4.6" },
            { id: "openai/gpt-5.3-codex", shortId: "gpt-5.3-codex", family: "openai", displayName: "GPT-5.3 Codex" },
            { id: "gpt-5.3-codex", shortId: "gpt-5.3-codex", family: "codex", displayName: "GPT-5.3 Codex" },
          ]
        }),
        executeTask: async () => ({ structuredOutput: { clear: true, feedback: [] } })
      } as any,
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              permissions: {
                claude: { permissionMode: "bypassPermissions" },
                codex: { approvalMode: "full-auto" }
              }
            }
          }
        })
      } as any,
      missionBudgetService: {
        estimateLaunchBudget: async () => ({
          estimate: createBudgetEstimate("api-key"),
          hardLimitExceeded: true,
          windowUsageCostUsd: 1.5,
          remainingWindowCostUsd: 0.2,
          budgetLimitCostUsd: 1.7
        })
      } as any
    });

    const result = await service.runPreflight({
      launch: {
        prompt: "Implement mission orchestration improvements.",
        phaseProfileId: profiles[0]!.id,
        phaseOverride: profiles[0]!.phases,
        modelConfig: {
          orchestratorModel: {
            provider: "claude",
            modelId: "claude-sonnet-4-6"
          }
        }
      }
    });

    expect(result.canLaunch).toBe(false);
    expect(result.hardFailures).toBeGreaterThan(0);
    expect(result.checklist.find((item) => item.id === "budget")?.severity).toBe("fail");
  });
});
