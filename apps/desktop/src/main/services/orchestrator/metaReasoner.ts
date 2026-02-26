import type { FanOutDecision } from "../../../shared/types";

// ---------------------------------------------------------------------------
// Meta-reasoner: AI-powered analysis of agent output to decide fan-out strategy
// ---------------------------------------------------------------------------

export type MetaReasonerRunState = {
  activeAgentCount: number;
  parallelismCap: number;
  availableLanes: string[];
  fileOwnershipMap: Record<string, string>;
};

export type MetaReasonerOpts = {
  stepOutput: string;
  stepKey: string;
  runState: MetaReasonerRunState;
  aiService: {
    executeTask: (args: {
      feature: "orchestrator";
      taskType: "review";
      prompt: string;
      cwd: string;
      provider: "claude" | "codex";
      reasoningEffort?: string;
      permissionMode: "read-only";
      oneShot: true;
      timeoutMs?: number;
    }) => Promise<{ text: string; sessionId: string | null }>;
  };
  cwd: string;
};

const INLINE_FALLBACK: FanOutDecision = {
  strategy: "inline",
  subtasks: [],
  reasoning: "fallback — no subtasks detected or parse failed"
};

/**
 * Analyze agent output and decide whether & how to fan out subtasks.
 * Always falls back to "inline" (no fan-out) if the AI call fails or
 * produces unparseable output.
 */
export async function analyzeForFanOut(opts: MetaReasonerOpts): Promise<FanOutDecision> {
  try {
    const prompt = buildMetaReasonerPrompt(opts);
    const result = await opts.aiService.executeTask({
      feature: "orchestrator" as const,
      taskType: "review" as const,
      prompt,
      cwd: opts.cwd,
      provider: "claude",
      reasoningEffort: "low",
      permissionMode: "read-only" as const,
      oneShot: true,
      timeoutMs: 30_000
    });
    if (!result.text?.trim()) return INLINE_FALLBACK;
    const decision = parseMetaReasonerOutput(result.text);
    // Safety cap: never exceed maxChildren
    if (decision.subtasks.length > 8) {
      decision.subtasks = decision.subtasks.slice(0, 8);
      decision.reasoning += " (capped at 8 subtasks)";
    }
    return decision;
  } catch {
    return INLINE_FALLBACK;
  }
}

function buildMetaReasonerPrompt(opts: MetaReasonerOpts): string {
  const claimedFiles = Object.entries(opts.runState.fileOwnershipMap);
  const claimedSection = claimedFiles.length > 0
    ? claimedFiles.map(([f, s]) => `${f} (${s})`).join(", ")
    : "none";

  return `You are a meta-reasoner for a multi-agent orchestrator. Analyze the following agent output and decide the optimal dispatch strategy for any subtasks.

## Agent Output (step: ${opts.stepKey})
${opts.stepOutput.slice(0, 4000)}

## Current Run State
- Active agents: ${opts.runState.activeAgentCount}
- Parallelism cap: ${opts.runState.parallelismCap}
- Available lanes: ${opts.runState.availableLanes.join(", ") || "none"}
- Files already claimed: ${claimedSection}

## Decision Factors
| Factor | Favors Internal | Favors External |
|--------|----------------|-----------------|
| Subtask count <= 3 | yes | |
| Subtask count > 6 | | yes |
| File overlap between subtasks | yes (sequential) | |
| No file overlap | | yes (parallel) |
| Simple/trivial complexity | yes | |
| Complex subtasks | | yes |
| Near parallelism cap | yes | |

## Instructions
1. Identify any distinct subtasks from the agent output.
2. If none, return strategy "inline" with empty subtasks.
3. Otherwise decide the best dispatch strategy.
4. For "hybrid", group related subtasks into clusters.

Respond ONLY with a JSON object (no markdown fences) matching this schema:
{
  "strategy": "inline" | "internal_parallel" | "external_parallel" | "hybrid",
  "subtasks": [{ "title": string, "instructions": string, "files": string[], "complexity": "trivial"|"simple"|"moderate"|"complex" }],
  "reasoning": string,
  "clusters": [{ "subtaskIndices": number[], "reason": string }]
}`;
}

function parseMetaReasonerOutput(text: string): FanOutDecision {
  try {
    // Try to extract JSON from the response — handle both raw JSON and markdown-fenced
    let jsonStr = text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }
    const parsed = JSON.parse(jsonStr);
    // Validate required fields
    const validStrategies = new Set(["inline", "internal_parallel", "external_parallel", "hybrid"]);
    if (!validStrategies.has(parsed.strategy)) return INLINE_FALLBACK;
    if (!Array.isArray(parsed.subtasks)) return INLINE_FALLBACK;
    const validComplexities = new Set(["trivial", "simple", "moderate", "complex"]);
    const subtasks = parsed.subtasks
      .filter((s: unknown) => s && typeof s === "object" && !Array.isArray(s))
      .map((s: Record<string, unknown>) => ({
        title: String(s.title ?? ""),
        instructions: String(s.instructions ?? ""),
        files: Array.isArray(s.files) ? s.files.filter((f): f is string => typeof f === "string") : [],
        complexity: validComplexities.has(String(s.complexity ?? "")) ? String(s.complexity) : "moderate",
        ...(typeof s.estimatedTokens === "number" ? { estimatedTokens: s.estimatedTokens } : {})
      })) as FanOutDecision["subtasks"];
    const clusters = Array.isArray(parsed.clusters)
      ? parsed.clusters
          .filter((c: unknown) => c && typeof c === "object" && !Array.isArray(c))
          .map((c: Record<string, unknown>) => ({
            subtaskIndices: Array.isArray(c.subtaskIndices)
              ? c.subtaskIndices.filter((i): i is number => typeof i === "number")
              : [],
            reason: String(c.reason ?? "")
          }))
      : undefined;
    return {
      strategy: parsed.strategy as FanOutDecision["strategy"],
      subtasks,
      reasoning: String(parsed.reasoning ?? ""),
      ...(clusters && clusters.length > 0 ? { clusters } : {})
    };
  } catch {
    return INLINE_FALLBACK;
  }
}
