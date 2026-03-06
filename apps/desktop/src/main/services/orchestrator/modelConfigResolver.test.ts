import { describe, expect, it } from "vitest";
import {
  resolveMissionDecisionTimeoutCapMs,
  resolveMissionModelConfig,
  resolveOrchestratorModelConfig,
} from "./modelConfigResolver";

function createCtx(metadata: Record<string, unknown>) {
  return {
    db: {
      get: () => ({
        metadata_json: JSON.stringify(metadata),
      }),
    },
    callTypeConfigCache: new Map(),
  } as any;
}

describe("modelConfigResolver", () => {
  it("reads mission model config from launch metadata", () => {
    const ctx = createCtx({
      launch: {
        modelConfig: {
          orchestratorModel: {
            modelId: "openai/gpt-5.3-codex",
            provider: "codex",
            thinkingLevel: "medium",
          },
          decisionTimeoutCapHours: 12,
        },
      },
    });

    expect(resolveMissionModelConfig(ctx, "mission-1")?.orchestratorModel?.modelId).toBe("openai/gpt-5.3-codex");
    expect(resolveOrchestratorModelConfig(ctx, "mission-1", "coordinator").modelId).toBe("openai/gpt-5.3-codex");
    expect(resolveMissionDecisionTimeoutCapMs(ctx, "mission-1")).toBe(12 * 60 * 60 * 1000);
  });

  it("falls back to the legacy root model config shape", () => {
    const ctx = createCtx({
      modelConfig: {
        orchestratorModel: {
          modelId: "anthropic/claude-sonnet-4-6",
          provider: "claude",
          thinkingLevel: "medium",
        },
        decisionTimeoutCapHours: 6,
      },
    });

    expect(resolveMissionModelConfig(ctx, "mission-2")?.orchestratorModel?.modelId).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveMissionDecisionTimeoutCapMs(ctx, "mission-2")).toBe(6 * 60 * 60 * 1000);
  });
});
