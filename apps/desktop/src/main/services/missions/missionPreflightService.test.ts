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
                cli: { mode: "full-auto", sandboxPermissions: "workspace-write" },
                inProcess: { mode: "full-auto" },
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
    expect(result.approvalSummary?.missionGoal).toBe("Implement mission orchestration improvements.");
    expect(result.approvalSummary?.recommendedExecution.teamRuntimeEnabled).toBe(true);
    expect(result.approvalSummary?.phaseLabels.length).toBeGreaterThan(0);
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
                cli: { mode: "full-auto", sandboxPermissions: "workspace-write" },
                inProcess: { mode: "full-auto" },
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

  it("blocks launch when required computer-use proof has no backend coverage", async () => {
    const profiles = createProfiles();
    const proofPhases = profiles[0]!.phases.map((phase, index) =>
      index === 0
        ? {
            ...phase,
            validationGate: {
              ...phase.validationGate,
              required: true,
              evidenceRequirements: ["screenshot" as const],
              capabilityFallback: "block" as const,
            },
          }
        : phase,
    );
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
                cli: { mode: "full-auto", sandboxPermissions: "workspace-write" },
                inProcess: { mode: "full-auto" },
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
      } as any,
      computerUseArtifactBrokerService: {
        getBackendStatus: () => ({
          backends: [],
          localFallback: {
            available: false,
            detail: "No local fallback in test.",
            supportedKinds: [],
          },
        }),
      } as any,
    });

    const result = await service.runPreflight({
      launch: {
        prompt: "Capture required proof.",
        phaseProfileId: profiles[0]!.id,
        phaseOverride: proofPhases,
        modelConfig: {
          orchestratorModel: {
            provider: "claude",
            modelId: "claude-sonnet-4-6"
          }
        },
      }
    });

    expect(result.canLaunch).toBe(false);
    expect(result.computerUse?.blocked).toBe(true);
    expect(result.computerUse?.missingKinds).toEqual(["screenshot"]);
    expect(result.checklist.find((item) => item.id === "computer_use")?.severity).toBe("fail");
  });

  it("allows runtime-discovered models when external proof backend covers browser evidence", async () => {
    const profiles = createProfiles();
    const proofPhases = profiles[0]!.phases.map((phase, index) => ({
      ...phase,
      model: {
        ...phase.model,
        provider: "opencode",
        modelId: index === 0 ? "runtime/non-registry-model" : phase.model.modelId,
      },
      validationGate: index === 0
        ? {
            ...phase.validationGate,
            required: true,
            evidenceRequirements: ["screenshot" as const],
            capabilityFallback: "block" as const,
          }
        : phase.validationGate,
    }));
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
        ]
      } as any,
      aiIntegrationService: {
        getAvailabilityAsync: async () => ({
          availableModels: [
            { id: "runtime/non-registry-model", shortId: "runtime-model", family: "opencode", displayName: "Runtime model" },
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
                cli: { mode: "full-auto", sandboxPermissions: "workspace-write" },
                inProcess: { mode: "full-auto" },
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
      } as any,
      computerUseArtifactBrokerService: {
        getBackendStatus: () => ({
          backends: [
            {
              name: "agent-browser",
              available: true,
              state: "installed",
              detail: "agent-browser is available.",
              supportedKinds: ["screenshot"],
            },
          ],
          localFallback: {
            available: false,
            detail: "No local fallback in test.",
            supportedKinds: [],
          },
        }),
      } as any,
    });

    const result = await service.runPreflight({
      launch: {
        prompt: "Capture required proof.",
        phaseProfileId: profiles[0]!.id,
        phaseOverride: proofPhases,
        modelConfig: {
          orchestratorModel: {
            provider: "opencode",
            modelId: "runtime/non-registry-model"
          }
        },
      }
    });

    expect(result.canLaunch).toBe(true);
    expect(result.checklist.find((item) => item.id === "computer_use")?.severity).toBe("pass");
    expect(result.checklist.find((item) => item.id === "capabilities")?.severity).toBe("pass");
  });

  it("reports local computer-use platform blockers when backend status is wired", async () => {
    const profiles = createProfiles();
    const proofPhases = profiles[0]!.phases.map((phase, index) => ({
      ...phase,
      validationGate: index === 0
        ? {
            ...phase.validationGate,
            required: true,
            evidenceRequirements: ["video_recording" as const],
            capabilityFallback: "block" as const,
          }
        : phase.validationGate,
    }));
    const service = createMissionPreflightService({
      logger: createLogger(),
      projectRoot: "/tmp/ade-preflight",
      missionService: {
        listPhaseProfiles: () => profiles
      } as any,
      laneService: {
        list: async () => [{ id: "lane-1", archivedAt: null }]
      } as any,
      aiIntegrationService: {
        getAvailabilityAsync: async () => ({
          availableModels: [
            { id: "claude-sonnet-4-6", shortId: "claude-sonnet-4-6", family: "claude", displayName: "Claude Sonnet 4.6" },
          ]
        }),
        executeTask: async () => ({ structuredOutput: { clear: true, feedback: [] } })
      } as any,
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              permissions: {
                cli: { mode: "full-auto", sandboxPermissions: "workspace-write" },
                inProcess: { mode: "full-auto" },
              }
            }
          }
        })
      } as any,
      missionBudgetService: {
        estimateLaunchBudget: async () => ({
          estimate: createBudgetEstimate("subscription"),
          hardLimitExceeded: false,
          windowUsageCostUsd: 0,
          remainingWindowCostUsd: 1,
          budgetLimitCostUsd: 1
        })
      } as any,
      computerUseArtifactBrokerService: {
        getBackendStatus: () => ({
          backends: [],
          localFallback: {
            available: false,
            detail: "ADE local computer-use tools are fallback-only and currently blocked_by_capability.",
            supportedKinds: [],
          },
        }),
      } as any,
    });

    const result = await service.runPreflight({
      launch: {
        prompt: "Capture required proof.",
        phaseProfileId: profiles[0]!.id,
        phaseOverride: proofPhases,
      }
    });

    expect(result.canLaunch).toBe(false);
    expect(result.checklist.find((item) => item.id === "capabilities")?.details.join("\n")).toContain("blocked by platform support");
  });

  it("shows warning (not fail) for non-full-auto permissions and still allows launch", async () => {
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
                cli: { mode: "edit" },
                inProcess: { mode: "plan" },
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
        prompt: "Implement feature.",
        phaseProfileId: profiles[0]!.id,
        phaseOverride: profiles[0]!.phases,
        modelConfig: {
          orchestratorModel: {
            provider: "claude",
            modelId: "claude-sonnet-4-6"
          }
        },
      }
    });

    const permItem = result.checklist.find((item) => item.id === "permissions");
    expect(permItem?.severity).toBe("warning");
    expect(result.canLaunch).toBe(true);
    expect(result.hardFailures).toBe(0);
    // Warning details should mention the specific mode
    expect(permItem?.details?.some((d) => d.includes("edit"))).toBe(true);
  });

  it("uses per-provider permissions from providers field over old cli/inProcess", async () => {
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
                cli: { mode: "edit" },
                inProcess: { mode: "plan" },
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

    // Mission-level providers field overrides all old cli/inProcess modes
    const result = await service.runPreflight({
      launch: {
        prompt: "Implement feature.",
        phaseProfileId: profiles[0]!.id,
        phaseOverride: profiles[0]!.phases,
        modelConfig: {
          orchestratorModel: {
            provider: "claude",
            modelId: "claude-sonnet-4-6"
          }
        },
        permissionConfig: {
          providers: { claude: "full-auto", codex: "full-auto", opencode: "full-auto" },
        },
      }
    });

    const permItem = result.checklist.find((item) => item.id === "permissions");
    // providers overrides project-level cli.mode=edit for all families
    expect(permItem?.severity).toBe("pass");
    expect(result.canLaunch).toBe(true);
  });

  it("summarizes result-lane closeout for new missions without requiring PR automation", async () => {
    const profiles = createProfiles();
    const service = createMissionPreflightService({
      logger: createLogger(),
      projectRoot: "/tmp/ade-preflight",
      missionService: {
        listPhaseProfiles: () => profiles,
      } as any,
      laneService: {
        list: async () => [{ id: "lane-1", archivedAt: null }, { id: "lane-2", archivedAt: null }],
      } as any,
      aiIntegrationService: {
        getAvailabilityAsync: async () => ({
          availableModels: [
            { id: "google/gemini-2.5-flash", shortId: "gemini-2.5-flash", family: "google", displayName: "Gemini 2.5 Flash" },
          ],
        }),
        executeTask: async () => ({ structuredOutput: { clear: true, feedback: [] } }),
      } as any,
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              permissions: {
                cli: { mode: "full-auto", sandboxPermissions: "workspace-write" },
                inProcess: { mode: "full-auto" },
              },
            },
          },
        }),
      } as any,
      missionBudgetService: {
        estimateLaunchBudget: async () => ({
          estimate: createBudgetEstimate("subscription"),
          hardLimitExceeded: false,
          windowUsageCostUsd: 0.1,
          remainingWindowCostUsd: 10.9,
          budgetLimitCostUsd: 11,
        }),
      } as any,
    });

    const result = await service.runPreflight({
      launch: {
        prompt: "Land the consolidated implementation in one lane.",
        phaseProfileId: profiles[0]!.id,
        phaseOverride: profiles[0]!.phases.map((phase) => ({
          ...phase,
          model: {
            ...phase.model,
            provider: "openrouter",
            modelId: "google/gemini-2.5-flash",
          },
        })),
        modelConfig: {
          orchestratorModel: {
            provider: "openai",
            modelId: "google/gemini-2.5-flash",
          },
        },
      } as any,
    });

    expect(result.canLaunch).toBe(true);
    expect(result.checklist.find((item) => item.id === "capabilities")?.severity).toBe("pass");
    expect(
      result.approvalSummary?.conflictAssumptions.some((detail) =>
        detail.includes("result lane") && detail.includes("will not auto-open a PR"),
      ),
    ).toBe(true);
  });

});
