import type {
  MissionExecutionPolicy,
  OrchestratorExecutorKind,
  OrchestratorJoinPolicy,
  OrchestratorClaimScope,
  StartOrchestratorRunStepPolicy
} from "../../../shared/types";
import { SLASH_COMMAND_TRANSLATIONS } from "../orchestrator/orchestratorConstants";
import { phaseModelToExecutorKind } from "../orchestrator/executionPolicy";

type RawPlanStep = {
  title: string;
  detail: string;
  kind: "analysis" | "implementation" | "validation" | "integration" | "merge" | "summary";
  dependencyIndices: number[];
  joinPolicy: OrchestratorJoinPolicy;
  quorumCount: number | null;
  timeoutMs: number | null;
  retryLimit: number;
  executorKind: OrchestratorExecutorKind;
  doneCriteria: string;
  splitReason: string;
  policy: StartOrchestratorRunStepPolicy;
  extraMetadata?: Record<string, unknown>;
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
const ACTION_HINT_WORDS = [
  ...ANALYSIS_WORDS,
  ...IMPLEMENT_WORDS,
  ...VALIDATION_WORDS,
  ...INTEGRATION_WORDS,
  ...SUMMARY_WORDS,
  "harden",
  "instrument",
  "expose",
  "show",
  "prove"
];
const NON_EXECUTABLE_LINE_RE =
  /^(?:goals?|plan requirements?|hard constraints?|constraints?|important|notes?|final output|output)\s*:?\s*$/i;
const NON_EXECUTABLE_PHRASES = [
  "keep changes minimal",
  "changes minimal and focused",
  "exercise real parallel fan-out",
  "dependency-safe joins",
  "clean terminal completion",
  "no manual intervention",
  "step titles must be descriptive",
  "run roots concurrently when dependencies allow"
];

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

function hasActionHint(task: string): boolean {
  const lower = task.toLowerCase();
  return ACTION_HINT_WORDS.some((word) => lower.includes(word));
}

function isActionableTask(task: string): boolean {
  const normalized = task
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;]+$/g, "")
    .trim();
  if (normalized.length < 8) return false;
  if (NON_EXECUTABLE_LINE_RE.test(normalized)) return false;
  const lower = normalized.toLowerCase();
  if (NON_EXECUTABLE_PHRASES.some((phrase) => lower.includes(phrase))) return false;
  if (normalized.endsWith(":")) return false;
  if (hasActionHint(lower)) return true;
  return /^(?:backend|runtime|ui|frontend|api|docs?|tests?|review)\b/i.test(normalized);
}

function extractTaskCandidates(prompt: string): string[] {
  const lines = prompt
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.trim().length > 0);

  const bulletLineRe = /^(\s*)(?:[-*•]|\d+[.)])\s+(.+)$/;
  const bulletTasks = lines
    .map((line, index) => {
      const match = line.match(bulletLineRe);
      if (!match?.[2]) return null;
      return {
        index,
        indent: match[1]?.length ?? 0,
        task: match[2].trim()
      };
    })
    .filter((entry): entry is { index: number; indent: number; task: string } => Boolean(entry))
    .filter((entry) => {
      if (!entry.task.endsWith(":")) return true;
      const nextLine = lines[entry.index + 1];
      if (!nextLine) return true;
      const nextMatch = nextLine.match(bulletLineRe);
      if (!nextMatch) return true;
      const nextIndent = nextMatch[1]?.length ?? 0;
      return nextIndent <= entry.indent;
    })
    .map((entry) => entry.task.replace(/\s+/g, " ").trim())
    .filter((task) => isActionableTask(task));
  if (bulletTasks.length >= 2) {
    return dedupe(bulletTasks.map((task) => task.slice(0, 140)));
  }

  const sentenceTasks = normalizePrompt(prompt)
    .replace(/\n/g, " ")
    .split(/(?<=[.!?;])\s+|\s+\band\b\s+/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 8)
    .map((entry) => entry.replace(/[.!?;]+$/g, "").trim())
    .filter((entry) => isActionableTask(entry));

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
  if (args.laneId && (args.kind === "integration" || args.kind === "merge" || args.kind === "validation")) {
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
  const rawStepType = String(step.extraMetadata?.stepType ?? step.extraMetadata?.taskType ?? step.kind ?? "").trim().toLowerCase();
  const roleClass =
    step.kind === "analysis"
      ? "planning"
      : step.kind === "implementation"
        ? "implementation"
        : step.kind === "integration"
          ? "integration"
          : step.kind === "merge"
            ? "merge"
            : step.kind === "summary"
              ? "handoff"
              : rawStepType === "review" || rawStepType === "test_review" || rawStepType === "review_test"
                ? "review"
                : "testing";
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
    },
    roleClass,
    requiresDedicatedWorker: roleClass === "review" || roleClass === "testing" || roleClass === "integration",
    role:
      step.kind === "analysis"
        ? "planning"
        : step.kind === "implementation"
          ? "implementation"
          : step.kind === "validation"
            ? "testing"
            : step.kind === "integration"
              ? "integration"
              : step.kind === "summary"
                ? "merge"
                : step.kind === "merge"
                  ? "merge"
                  : "implementation"
  };
  if (Number.isFinite(step.timeoutMs ?? NaN) && (step.timeoutMs ?? 0) > 0) {
    metadata.timeoutMs = Math.floor(step.timeoutMs as number);
  }
  if (step.extraMetadata) {
    for (const [key, value] of Object.entries(step.extraMetadata)) {
      metadata[key] = value;
    }
  }

  return {
    index,
    title: step.title,
    detail: step.detail,
    kind: step.kind,
    metadata
  };
}

function detectSlashCommands(prompt: string): string[] {
  return prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\/[a-zA-Z]/.test(line));
}

export function buildDeterministicMissionPlan(args: { prompt: string; laneId?: string | null; policy?: MissionExecutionPolicy }): DeterministicMissionPlan {
  const prompt = normalizePrompt(args.prompt);
  const policy = args.policy;
  const laneId = typeof args.laneId === "string" && args.laneId.trim().length ? args.laneId.trim() : null;
  const taskCandidates = extractTaskCandidates(prompt);
  const lowerPrompt = prompt.toLowerCase();
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
  const explicitParallelRootIntent =
    /\bparallel\b/.test(lowerPrompt) &&
    (/\broot\b/.test(lowerPrompt) || /\bfan[-\s]?out\b/.test(lowerPrompt) || /\bbranches?\b/.test(lowerPrompt));

  const strategy =
    workCandidates.length >= 2
      ? "parallel_execution_branches_with_join"
      : explicitIntegration
        ? "single_branch_with_explicit_integration_gate"
        : "single_branch_default";

  // Policy-driven executor kind helpers
  const analysisExecutor: OrchestratorExecutorKind = policy ? phaseModelToExecutorKind(policy.planning.model) : "unified";
  const implExecutor: OrchestratorExecutorKind = policy ? phaseModelToExecutorKind(policy.implementation.model) : "unified";
  const testExecutor: OrchestratorExecutorKind = policy ? phaseModelToExecutorKind(policy.testing.model) : "unified";
  const reviewExecutor: OrchestratorExecutorKind = policy?.codeReview.model ? phaseModelToExecutorKind(policy.codeReview.model) : "unified";
  const testReviewExecutor: OrchestratorExecutorKind = policy?.testReview.model ? phaseModelToExecutorKind(policy.testReview.model) : "unified";
  const integrationExecutor: OrchestratorExecutorKind = "unified";

  const rawSteps: RawPlanStep[] = [];
  let previousIndex = -1;
  let analysisIndex = -1;

  const shouldSeedAnalysis =
    (!explicitParallelRootIntent || workCandidates.length < 2) &&
    (prompt.length >= 120 || hasAnyKeyword(prompt, ANALYSIS_WORDS) || taskCandidates.length >= 3);
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
      timeoutMs: 180_000,
      retryLimit: 0,
      executorKind: analysisExecutor,
      doneCriteria: "Context baseline and explicit success criteria are recorded for downstream steps.",
      splitReason: "Mission prompt requires up-front deterministic scoping.",
      policy: buildPolicy({
        kind: "analysis",
        laneId,
        title: "analysis",
        parallelBranch: false
      }),
      extraMetadata: policy?.planning.reasoningEffort ? { reasoningEffort: policy.planning.reasoningEffort } : undefined
    });
    previousIndex = index;
  }

  const effectiveWork = workCandidates.length > 0 ? workCandidates : ["Implement the mission objective"];
  const parallelBranches = effectiveWork.length >= 2 ? effectiveWork.slice(0, 3) : effectiveWork.slice(0, 1);
  const fanOutDependencies = analysisIndex >= 0 ? [analysisIndex] : [];
  const workIndexes: number[] = [];

  // TDD mode: emit test steps before each implementation step
  const isTdd = policy?.testing.mode === "tdd";

  for (const workTask of parallelBranches) {
    const implDependencyIndices =
      parallelBranches.length > 1
        ? [...fanOutDependencies]
        : analysisIndex >= 0
          ? [analysisIndex]
          : previousIndex >= 0
            ? [previousIndex]
            : [];

    // TDD: emit a test-writing step BEFORE the implementation step
    if (isTdd) {
      const testIndex = rawSteps.length;
      rawSteps.push({
        title: `Write tests for: ${workTask}`,
        detail: "Write test cases before implementation (TDD).",
        kind: "validation",
        dependencyIndices: [...implDependencyIndices],
        joinPolicy: "all_success",
        quorumCount: null,
        timeoutMs: 300_000,
        retryLimit: 1,
        executorKind: testExecutor,
        doneCriteria: "Test cases are written and ready for implementation to satisfy.",
        splitReason: "TDD policy requires test-first workflow.",
        policy: buildPolicy({
          kind: "validation",
          laneId,
          title: `tdd-test-${slugify(workTask)}`,
          parallelBranch: parallelBranches.length > 1
        }),
        extraMetadata: {
          stepType: "test",
          taskType: "test",
          ...(policy?.testing.reasoningEffort ? { reasoningEffort: policy.testing.reasoningEffort } : {})
        }
      });
      // Implementation depends on its TDD test step
      const implIndex = rawSteps.length;
      workIndexes.push(implIndex);
      rawSteps.push({
        title: workTask,
        detail: "Execute this branch and keep outputs isolated for deterministic integration.",
        kind: "implementation",
        dependencyIndices: [testIndex],
        joinPolicy: "all_success",
        quorumCount: null,
        timeoutMs: 420_000,
        retryLimit: 1,
        executorKind: implExecutor,
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
        }),
        extraMetadata: policy?.implementation.reasoningEffort ? { reasoningEffort: policy.implementation.reasoningEffort } : undefined
      });
      previousIndex = implIndex;
    } else {
      const index = rawSteps.length;
      workIndexes.push(index);
      rawSteps.push({
        title: workTask,
        detail: "Execute this branch and keep outputs isolated for deterministic integration.",
        kind: "implementation",
        dependencyIndices: [...implDependencyIndices],
        joinPolicy: "all_success",
        quorumCount: null,
        timeoutMs: 420_000,
        retryLimit: 1,
        executorKind: implExecutor,
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
        }),
        extraMetadata: policy?.implementation.reasoningEffort ? { reasoningEffort: policy.implementation.reasoningEffort } : undefined
      });
      previousIndex = index;
    }
  }

  // Code review gate (policy-driven)
  if (policy && policy.codeReview.mode !== "off") {
    const index = rawSteps.length;
    rawSteps.push({
      title: "Code review gate",
      detail: "Review implementation outputs for quality, correctness, and adherence to standards.",
      kind: "validation",
      dependencyIndices: workIndexes.length ? [...workIndexes] : previousIndex >= 0 ? [previousIndex] : [],
      joinPolicy: "all_success",
      quorumCount: null,
      timeoutMs: 600_000,
      retryLimit: 0,
      executorKind: reviewExecutor,
      doneCriteria: "Review feedback is recorded and blocking issues are flagged.",
      splitReason: "Execution policy requires code review before validation/summary.",
      policy: buildPolicy({
        kind: "validation",
        laneId,
        title: "code-review",
        parallelBranch: false
      }),
      extraMetadata: {
        taskType: "review",
        stepType: "review",
        ...(policy.codeReview.reasoningEffort ? { reasoningEffort: policy.codeReview.reasoningEffort } : {})
      }
    });
    previousIndex = index;
  }

  // Integration step — always include if there are parallel branches
  const hasParallelJoin = workIndexes.length > 1 || explicitIntegration;
  if (hasParallelJoin) {
    const joinConfig = deriveJoinPolicy(prompt, workIndexes.length || 1);
    const index = rawSteps.length;
    rawSteps.push({
      title: "Integrate branch outputs",
      detail: "Verify cross-branch compatibility and consolidate a single integration result.",
      kind: "integration",
      dependencyIndices: workIndexes.length ? workIndexes : previousIndex >= 0 ? [previousIndex] : [],
      joinPolicy: joinConfig.joinPolicy,
      quorumCount: joinConfig.quorumCount,
      timeoutMs: 900_000,
      retryLimit: 1,
      executorKind: integrationExecutor,
      doneCriteria: "Cross-branch contracts are validated and integration outputs are summarized for downstream gates.",
      splitReason: "Parallel branches require a compatibility gate before validation.",
      policy: buildPolicy({
        kind: "integration",
        laneId,
        title: "integration",
        parallelBranch: false
      }),
      extraMetadata: undefined
    });
    previousIndex = index;
  }

  // Validation step — skip when policy.testing.mode === "none"
  // When testing mode is "tdd", TDD test steps were already emitted above;
  // the post-implementation validation is still useful as a verification gate.
  const skipValidation = policy?.testing.mode === "none";
  if (!skipValidation) {
    const validationTitle = validationCandidates[0] ?? "Run deterministic verification checks";
    const index = rawSteps.length;
    rawSteps.push({
      title: validationTitle,
      detail: "Execute deterministic checks and classify failures before completion.",
      kind: "validation",
      dependencyIndices: previousIndex >= 0 ? [previousIndex] : [],
      joinPolicy: "all_success",
      quorumCount: null,
      timeoutMs: 600_000,
      retryLimit: 1,
      executorKind: testExecutor,
      doneCriteria: "Required checks complete and outcomes are attached to mission artifacts/handoffs.",
      splitReason: "Validation gate ensures deterministic completion criteria.",
      policy: buildPolicy({
        kind: "validation",
        laneId,
        title: validationTitle,
        parallelBranch: false
      }),
      extraMetadata: policy?.testing.reasoningEffort ? { reasoningEffort: policy.testing.reasoningEffort } : undefined
    });
    previousIndex = index;
  }

  // Test review gate (policy-driven)
  if (policy && policy.testReview.mode !== "off" && policy.testing.mode !== "none") {
    const index = rawSteps.length;
    rawSteps.push({
      title: "Test review gate",
      detail: "Review test outcomes and failure diagnostics before final handoff/merge.",
      kind: "validation",
      dependencyIndices: previousIndex >= 0 ? [previousIndex] : [],
      joinPolicy: "all_success",
      quorumCount: null,
      timeoutMs: 420_000,
      retryLimit: 0,
      executorKind: testReviewExecutor,
      doneCriteria: "Test findings are reviewed and release blockers are called out explicitly.",
      splitReason: "Execution policy requires a dedicated test review phase.",
      policy: buildPolicy({
        kind: "validation",
        laneId,
        title: "test-review",
        parallelBranch: false
      }),
      extraMetadata: {
        taskType: "test_review",
        stepType: "test_review",
        reviewTarget: "tests",
        ...(policy.testReview.reasoningEffort ? { reasoningEffort: policy.testReview.reasoningEffort } : {})
      }
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
    timeoutMs: 180_000,
    retryLimit: 0,
    executorKind: "unified",
    doneCriteria: "Outcome summary and required artifact links are persisted for operators.",
    splitReason: "Mission completion requires a deterministic audit and handoff record.",
    policy: buildPolicy({
      kind: "summary",
      laneId,
      title: summaryTitle,
      parallelBranch: false
    })
  });

  // Slash command steps — each detected /command becomes a step after all preceding steps
  const slashCommands = detectSlashCommands(args.prompt);
  for (const cmd of slashCommands) {
    const depIndex = rawSteps.length - 1;
    const cmdBase = cmd.split(/\s/)[0];
    const translation = SLASH_COMMAND_TRANSLATIONS[cmdBase];

    if (translation) {
      // Translated slash command: use the full prompt translation as step instructions
      rawSteps.push({
        title: cmd,
        detail: translation.prompt,
        kind: "implementation",
        dependencyIndices: depIndex >= 0 ? [depIndex] : [],
        joinPolicy: "all_success",
        quorumCount: null,
        timeoutMs: 300_000,
        retryLimit: 0,
        executorKind: "unified",
        doneCriteria: "Slash command execution completed.",
        splitReason: "Slash command detected in prompt.",
        policy: buildPolicy({
          kind: "implementation",
          laneId,
          title: cmd,
          parallelBranch: false
        }),
        extraMetadata: {
          stepType: "command",
          slashCommand: cmd,
          instructions: translation.prompt
        }
      });
    } else {
      // Unknown slash command: pass through as startupCommand.
      rawSteps.push({
        title: cmd,
        detail: `Execute slash command: ${cmd}`,
        kind: "implementation",
        dependencyIndices: depIndex >= 0 ? [depIndex] : [],
        joinPolicy: "all_success",
        quorumCount: null,
        timeoutMs: 300_000,
        retryLimit: 0,
        executorKind: "unified",
        doneCriteria: "Slash command execution completed.",
        splitReason: "Slash command detected in prompt.",
        policy: buildPolicy({
          kind: "implementation",
          laneId,
          title: cmd,
          parallelBranch: false
        }),
        extraMetadata: {
          startupCommand: cmd,
          stepType: "command",
          slashCommand: cmd
        }
      });
    }
  }

  return {
    plannerVersion: "ade.missionPlanner.v1",
    strategy,
    keywords,
    steps: rawSteps.map((step, index) => toPlannerStep(step, index, strategy, keywords))
  };
}
