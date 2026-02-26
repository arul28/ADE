/**
 * missionTriage.ts
 *
 * Fast mission scope classification before planning. Uses a haiku-class model
 * to classify missions as trivial/simple/standard/complex, allowing trivial
 * tasks to skip the full planner entirely.
 *
 * Read-only — no side effects, no state mutations.
 */

import { streamText } from "ai";
import { resolveModelAlias, MODEL_REGISTRY } from "../../../shared/modelRegistry";
import type { Logger } from "../logging/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MissionScope = "trivial" | "simple" | "standard" | "complex";

export type TriageResult = {
  scope: MissionScope;
  estimatedSteps: number;
  estimatedAgents: number;
  skipPlanner: boolean;
  reasoning: string;
  /** For trivial/simple missions, the coordinator can use these directly. */
  suggestedSteps?: Array<{ title: string; instructions: string }>;
};

export type TriageDeps = {
  logger: Logger;
  projectRoot?: string;
};

export type TriageProjectContext = {
  repoName?: string;
  recentFiles?: string[];
  techStack?: string[];
  projectSize?: "small" | "medium" | "large";
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRIAGE_SYSTEM_PROMPT = `You are a mission scope classifier. Given a software engineering task, classify its scope.

Respond with JSON only:
{
  "scope": "trivial" | "simple" | "standard" | "complex",
  "estimatedSteps": number,
  "estimatedAgents": number,
  "reasoning": "brief explanation",
  "suggestedSteps": [{"title": "...", "instructions": "..."}]
}

Classification guide:
- trivial: Single-file fix, typo, rename, config change. 1 step, 1 agent. Skip planner.
- simple: 2-3 related files, single feature addition, bug fix with tests. 2-3 steps, 1-2 agents. Skip planner (coordinator outlines steps).
- standard: Multi-file feature, refactoring, new component with tests. 4-8 steps, 2-4 agents. Full planner.
- complex: Cross-cutting changes, multi-module refactor, architecture change. 8+ steps, 4+ agents. Full planner + dynamic fan-out.

Only include "suggestedSteps" for trivial and simple scopes.

Consider:
- Number of files likely affected
- Whether changes are logically connected or independent
- Need for tests, documentation, config changes
- Risk of merge conflicts between parallel agents`;

/** Guidance for the coordinator prompt on when to use one vs multiple agents. */
export const MODEL_CAPABILITY_GUIDANCE = `
## When to use ONE agent vs MULTIPLE agents:

ONE agent suffices when:
- Task touches <20 files that are logically connected
- Changes are sequential (each depends on the previous)
- Total context fits in <100K tokens
- No hard file conflicts possible

MULTIPLE agents when:
- Hard file conflicts would arise from parallel edits
- Context would overflow a single agent (>100K tokens)
- Genuinely independent workstreams exist (e.g., frontend + backend + tests)
- Different expertise needed (e.g., one for DB migration, one for API, one for UI)
`;

const VALID_SCOPES: Set<string> = new Set(["trivial", "simple", "standard", "complex"]);

// ---------------------------------------------------------------------------
// Model Resolution
// ---------------------------------------------------------------------------

/**
 * Pick the fastest available model for triage. Prefers haiku, falls back to sonnet.
 * Returns a model ID string from the registry.
 */
export function resolveTriageModel(): string {
  // Prefer haiku (CLI-wrapped) — fastest
  const haiku = resolveModelAlias("haiku");
  if (haiku) return haiku.id;

  // Fall back to haiku API
  const haikuApi = resolveModelAlias("haiku-api");
  if (haikuApi) return haikuApi.id;

  // Fall back to sonnet (still fast enough)
  const sonnet = resolveModelAlias("sonnet");
  if (sonnet) return sonnet.id;

  // Last resort: first available model
  return MODEL_REGISTRY[0].id;
}

// ---------------------------------------------------------------------------
// Prompt Builder
// ---------------------------------------------------------------------------

function buildTriagePrompt(goal: string, projectContext: TriageProjectContext): string {
  const parts: string[] = [`Task: ${goal}`];

  if (projectContext.repoName) {
    parts.push(`Repository: ${projectContext.repoName}`);
  }
  if (projectContext.projectSize) {
    parts.push(`Project size: ${projectContext.projectSize}`);
  }
  if (projectContext.techStack?.length) {
    parts.push(`Tech stack: ${projectContext.techStack.join(", ")}`);
  }
  if (projectContext.recentFiles?.length) {
    const fileList = projectContext.recentFiles.slice(0, 10).join(", ");
    parts.push(`Recently modified files: ${fileList}`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Response Parser
// ---------------------------------------------------------------------------

function parseTriageResponse(text: string, goal: string): TriageResult {
  // Try to extract JSON from the response (handle markdown code blocks)
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);

    const scope: MissionScope = VALID_SCOPES.has(parsed.scope) ? parsed.scope : "standard";
    const estimatedSteps = typeof parsed.estimatedSteps === "number" && parsed.estimatedSteps > 0
      ? Math.min(Math.floor(parsed.estimatedSteps), 50)
      : 5;
    const estimatedAgents = typeof parsed.estimatedAgents === "number" && parsed.estimatedAgents > 0
      ? Math.min(Math.floor(parsed.estimatedAgents), 20)
      : 2;
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided";

    const skipPlanner = scope === "trivial" || scope === "simple";

    let suggestedSteps: TriageResult["suggestedSteps"];
    if (skipPlanner && Array.isArray(parsed.suggestedSteps)) {
      suggestedSteps = parsed.suggestedSteps
        .filter(
          (s: unknown): s is { title: string; instructions: string } =>
            typeof s === "object" && s !== null &&
            typeof (s as any).title === "string" &&
            typeof (s as any).instructions === "string",
        )
        .slice(0, 10);
    }

    return { scope, estimatedSteps, estimatedAgents, skipPlanner, reasoning, suggestedSteps };
  } catch {
    // JSON parse failed — fall back to standard
    return {
      scope: "standard",
      estimatedSteps: 5,
      estimatedAgents: 2,
      skipPlanner: false,
      reasoning: `Triage response was not valid JSON. Defaulting to standard scope. Raw: ${text.slice(0, 200)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main Triage Function
// ---------------------------------------------------------------------------

/**
 * Fast AI triage call to classify mission scope before planning.
 * Uses haiku-class model for speed (<2s). Read-only — no side effects.
 */
export async function triageMissionScope(
  goal: string,
  projectContext: TriageProjectContext,
  deps: TriageDeps,
): Promise<TriageResult> {
  const prompt = buildTriagePrompt(goal, projectContext);
  const modelId = resolveTriageModel();

  try {
    const { resolveModel } = await import("../ai/providerResolver");
    const { detectAllAuth } = await import("../ai/authDetector");
    const auth = await detectAllAuth();
    const model = await resolveModel(modelId, auth);

    const result = streamText({
      model,
      prompt,
      system: TRIAGE_SYSTEM_PROMPT,
      // No tools — pure classification
    });

    let text = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text;
    }

    const triageResult = parseTriageResponse(text, goal);

    deps.logger.debug("mission_triage.completed", {
      modelId,
      scope: triageResult.scope,
      estimatedSteps: triageResult.estimatedSteps,
      estimatedAgents: triageResult.estimatedAgents,
      skipPlanner: triageResult.skipPlanner,
    });

    return triageResult;
  } catch (err) {
    deps.logger.debug("mission_triage.failed", {
      error: err instanceof Error ? err.message : String(err),
      modelId,
    });
    // Fallback: assume standard scope — safe default
    return {
      scope: "standard",
      estimatedSteps: 5,
      estimatedAgents: 2,
      skipPlanner: false,
      reasoning: "Triage failed, defaulting to standard scope",
    };
  }
}
