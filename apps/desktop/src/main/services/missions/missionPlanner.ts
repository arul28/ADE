import type {
  OrchestratorExecutorKind,
  OrchestratorJoinPolicy,
  OrchestratorClaimScope,
  StartOrchestratorRunStepPolicy
} from "../../../shared/types";

type RawPlanStep = {
  title: string;
  detail: string;
  kind: "analysis" | "implementation" | "validation" | "integration" | "summary";
  dependencyIndices: number[];
  joinPolicy: OrchestratorJoinPolicy;
  quorumCount: number | null;
  retryLimit: number;
  executorKind: OrchestratorExecutorKind;
  doneCriteria: string;
  splitReason: string;
  policy: StartOrchestratorRunStepPolicy;
};

export type DeterministicMissionPlannerStep = {
  index: number;
  title: string;
  detail: string;
  kind: string;
  metadata: Record<string, unknown>;
};

export type DeterministicMissionPlan = {
  plannerVersion: "ade.missionPlanner.v1";
  strategy: string;
  keywords: string[];
  steps: DeterministicMissionPlannerStep[];
};

const ANALYSIS_WORDS = ["analyze", "analysis", "investigate", "research", "understand", "audit", "review", "plan"];
const IMPLEMENT_WORDS = ["implement", "refactor", "fix", "build", "create", "update", "add", "remove", "migrate", "ship", "write"];
const VALIDATION_WORDS = ["test", "verify", "validate", "check", "lint", "typecheck", "ci", "qa"];
const INTEGRATION_WORDS = ["merge", "integrate", "reconcile", "combine", "conflict", "land", "cherry-pick"];
const SUMMARY_WORDS = ["summary", "summarize", "handoff", "report", "pr", "pull request", "document"];

function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toWords(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasAnyKeyword(input: string, keywords: string[]): boolean {
  const lower = input.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length ? slug : "step";
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function extractTaskCandidates(prompt: string): string[] {
  const lines = normalizePrompt(prompt)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const bulletTasks = lines
    .map((line) => line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/)?.[1]?.trim() ?? null)
    .filter((entry): entry is string => Boolean(entry));
  if (bulletTasks.length >= 2) {
    return dedupe(bulletTasks.map((task) => task.slice(0, 140)));
  }

  const sentenceTasks = normalizePrompt(prompt)
    .replace(/\n/g, " ")
    .split(/(?<=[.!?;])\s+|\s+\band\b\s+/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 8)
    .map((entry) => entry.replace(/[.!?;]+$/g, "").trim())
    .filter(Boolean);

  return dedupe(sentenceTasks.slice(0, 8).map((task) => task.slice(0, 140)));
}

function classifyTask(task: string): RawPlanStep["kind"] {
  if (hasAnyKeyword(task, SUMMARY_WORDS)) return "summary";
  if (hasAnyKeyword(task, INTEGRATION_WORDS)) return "integration";
  if (hasAnyKeyword(task, VALIDATION_WORDS)) return "validation";
  if (hasAnyKeyword(task, ANALYSIS_WORDS)) return "analysis";
  return "implementation";
}

function deriveJoinPolicy(prompt: string, branchCount: number): { joinPolicy: OrchestratorJoinPolicy; quorumCount: number | null } {
  if (branchCount <= 1) {
    return {
      joinPolicy: "all_success",
      quorumCount: null
    };
  }
  const lower = prompt.toLowerCase();
  const quorumMatch = lower.match(/\b(?:quorum|at least)\s+(\d+)\b/);
  const quorum = quorumMatch ? Number(quorumMatch[1]) : NaN;
  if (Number.isFinite(quorum) && quorum > 0) {
    return {
      joinPolicy: "quorum",
      quorumCount: Math.max(1, Math.min(branchCount, Math.floor(quorum)))
    };
  }
  if (/\b(?:either|any one|any of|one of)\b/.test(lower)) {
    return {
      joinPolicy: "any_success",
      quorumCount: null
    };
  }
  return {
    joinPolicy: "all_success",
    quorumCount: null
  };
}

function buildPolicy(args: {
  kind: RawPlanStep["kind"];
  laneId: string | null;
  title: string;
  parallelBranch: boolean;
}): StartOrchestratorRunStepPolicy {
  const claimScopes: Array<{ scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number }> = [];
  if (args.laneId && (args.kind === "integration" || args.kind === "validation")) {
    claimScopes.push({
      scopeKind: "lane",
      scopeValue: `lane:${args.laneId}`,
      ttlMs: 60_000
    });
  } else if (args.parallelBranch) {
    claimScopes.push({
      scopeKind: "file",
      scopeValue: `planner:${slugify(args.title)}`,
      ttlMs: 45_000
    });
  }

  return {
    includeNarrative: false,
    includeFullDocs: args.kind === "analysis" || args.kind === "integration",
    docsMaxBytes: args.kind === "analysis" ? 160_000 : 120_000,
    claimScopes
  };
}

function toPlannerStep(step: RawPlanStep, index: number, strategy: string, keywords: string[]): DeterministicMissionPlannerStep {
  const metadata: Record<string, unknown> = {
    stepType: step.kind,
    dependencyIndices: step.dependencyIndices,
    joinPolicy: step.joinPolicy,
    quorumCount: step.quorumCount,
    retryLimit: step.retryLimit,
    executorKind: step.executorKind,
    doneCriteria: step.doneCriteria,
    policy: step.policy,
    planner: {
      version: "ade.missionPlanner.v1",
      strategy,
      splitReason: step.splitReason,
      keywords
    }
  };

  return {
    index,
    title: step.title,
    detail: step.detail,
    kind: step.kind,
    metadata
  };
}

export function buildDeterministicMissionPlan(args: { prompt: string; laneId?: string | null }): DeterministicMissionPlan {
  const prompt = normalizePrompt(args.prompt);
  const laneId = typeof args.laneId === "string" && args.laneId.trim().length ? args.laneId.trim() : null;
  const taskCandidates = extractTaskCandidates(prompt);
  const promptWords = toWords(prompt);
  const keywords = dedupe(promptWords.filter((word) =>
    ANALYSIS_WORDS.includes(word) ||
    IMPLEMENT_WORDS.includes(word) ||
    VALIDATION_WORDS.includes(word) ||
    INTEGRATION_WORDS.includes(word) ||
    SUMMARY_WORDS.includes(word)
  ));

  const classified = taskCandidates.map((task) => ({
    task,
    kind: classifyTask(task)
  }));

  const workCandidates = classified
    .filter((entry) => entry.kind === "implementation" || entry.kind === "analysis")
    .map((entry) => entry.task);
  const validationCandidates = classified.filter((entry) => entry.kind === "validation").map((entry) => entry.task);
  const summaryCandidates = classified.filter((entry) => entry.kind === "summary").map((entry) => entry.task);
  const explicitIntegration = classified.some((entry) => entry.kind === "integration");

  const strategy =
    workCandidates.length >= 2
      ? "parallel_execution_branches_with_join"
      : explicitIntegration
        ? "single_branch_with_explicit_integration_gate"
        : "single_branch_default";

  const rawSteps: RawPlanStep[] = [];
  let previousIndex = -1;
  let analysisIndex = -1;

  const shouldSeedAnalysis =
    prompt.length >= 120 || hasAnyKeyword(prompt, ANALYSIS_WORDS) || taskCandidates.length >= 3;
  if (shouldSeedAnalysis) {
    const index = rawSteps.length;
    analysisIndex = index;
    rawSteps.push({
      title: "Clarify mission constraints and success signal",
      detail: "Collect deterministic constraints from packs and mission prompt before execution.",
      kind: "analysis",
      dependencyIndices: [],
      joinPolicy: "all_success",
      quorumCount: null,
      retryLimit: 0,
      executorKind: "codex",
      doneCriteria: "Context baseline and explicit success criteria are recorded for downstream steps.",
      splitReason: "Mission prompt requires up-front deterministic scoping.",
      policy: buildPolicy({
        kind: "analysis",
        laneId,
        title: "analysis",
        parallelBranch: false
      })
    });
    previousIndex = index;
  }

  const effectiveWork = workCandidates.length > 0 ? workCandidates : ["Implement the mission objective"];
  const parallelBranches = effectiveWork.length >= 2 ? effectiveWork.slice(0, 3) : effectiveWork.slice(0, 1);
  const workIndexes: number[] = [];

  for (const workTask of parallelBranches) {
    const index = rawSteps.length;
    workIndexes.push(index);
    rawSteps.push({
      title: workTask,
      detail: "Execute this branch and keep outputs isolated for deterministic integration.",
      kind: "implementation",
      dependencyIndices: analysisIndex >= 0 ? [analysisIndex] : previousIndex >= 0 ? [previousIndex] : [],
      joinPolicy: "all_success",
      quorumCount: null,
      retryLimit: 1,
      executorKind: "codex",
      doneCriteria: "Code changes are produced in lane scope and recorded as attempt outputs.",
      splitReason:
        parallelBranches.length > 1
          ? "Prompt included multiple executable units that can run concurrently."
          : "Prompt maps to a single executable workstream.",
      policy: buildPolicy({
        kind: "implementation",
        laneId,
        title: workTask,
        parallelBranch: parallelBranches.length > 1
      })
    });
    previousIndex = index;
  }

  const hasParallelJoin = workIndexes.length > 1 || explicitIntegration;
  if (hasParallelJoin) {
    const joinConfig = deriveJoinPolicy(prompt, workIndexes.length || 1);
    const index = rawSteps.length;
    rawSteps.push({
      title: "Integrate branch outputs",
      detail: "Apply deterministic merge sequencing and finalize a single integration result.",
      kind: "integration",
      dependencyIndices: workIndexes.length ? workIndexes : previousIndex >= 0 ? [previousIndex] : [],
      joinPolicy: joinConfig.joinPolicy,
      quorumCount: joinConfig.quorumCount,
      retryLimit: 1,
      executorKind: "codex",
      doneCriteria: "Integration lane state is conflict-free or a deterministic policy block is produced.",
      splitReason: "Multiple branches require deterministic join semantics before validation.",
      policy: buildPolicy({
        kind: "integration",
        laneId,
        title: "integration",
        parallelBranch: false
      })
    });
    previousIndex = index;
  }

  const needsValidation = true;
  if (needsValidation) {
    const validationTitle = validationCandidates[0] ?? "Run deterministic verification checks";
    const index = rawSteps.length;
    rawSteps.push({
      title: validationTitle,
      detail: "Execute deterministic checks and classify failures before completion.",
      kind: "validation",
      dependencyIndices: previousIndex >= 0 ? [previousIndex] : [],
      joinPolicy: "all_success",
      quorumCount: null,
      retryLimit: 1,
      executorKind: "codex",
      doneCriteria: "Required checks complete and outcomes are attached to mission artifacts/handoffs.",
      splitReason: "Validation gate ensures deterministic completion criteria.",
      policy: buildPolicy({
        kind: "validation",
        laneId,
        title: validationTitle,
        parallelBranch: false
      })
    });
    previousIndex = index;
  }

  const summaryTitle = summaryCandidates[0] ?? "Record mission outcomes and handoff artifacts";
  rawSteps.push({
    title: summaryTitle,
    detail: "Finalize mission summary, artifacts, and runtime provenance for audit/history.",
    kind: "summary",
    dependencyIndices: previousIndex >= 0 ? [previousIndex] : [],
    joinPolicy: "all_success",
    quorumCount: null,
    retryLimit: 0,
    executorKind: "codex",
    doneCriteria: "Outcome summary and required artifact links are persisted for operators.",
    splitReason: "Mission completion requires a deterministic audit and handoff record.",
    policy: buildPolicy({
      kind: "summary",
      laneId,
      title: summaryTitle,
      parallelBranch: false
    })
  });

  return {
    plannerVersion: "ade.missionPlanner.v1",
    strategy,
    keywords,
    steps: rawSteps.map((step, index) => toPlannerStep(step, index, strategy, keywords))
  };
}
