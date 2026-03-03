import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  PhaseCard,
  MissionExecutionPolicy,
  MissionPlannerAttempt,
  MissionPlannerEngine,
  MissionPlannerReasonCode,
  MissionPlannerResolvedEngine,
  MissionPlannerRun,
  OrchestratorClaimScope,
  OrchestratorExecutorKind,
  PlannerClaimLane,
  PlannerContextProfileRequirement,
  PlannerMissionComplexity,
  PlannerMissionDomain,
  PlannerMissionStrategy,
  PlannerClarifyingAnswer,
  PlannerClarifyingQuestion,
  PlannerPlan,
  PlannerStepPlan,
  PlannerTaskType,
  TeamRuntimeConfig
} from "../../../shared/types";
import { buildDeterministicMissionPlan } from "./missionPlanner";
import { phaseModelToExecutorKind } from "../orchestrator/executionPolicy";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createMemoryService } from "../memory/memoryService";
import { isRecord } from "../shared/utils";

type MissionPlanningLogger = {
  debug?: (event: string, data?: Record<string, unknown>) => void;
  info?: (event: string, data?: Record<string, unknown>) => void;
  warn?: (event: string, data?: Record<string, unknown>) => void;
  error?: (event: string, data?: Record<string, unknown>) => void;
};

export type MissionPlanningContextBundle = {
  missionProfile?: Record<string, unknown>;
  operationSummary?: Record<string, unknown>;
  docsDigest?: Array<{ path: string; sha256: string; bytes: number; content?: string }>;
  packDigest?: Record<string, unknown>;
  constraints?: string[];
};

export class MissionPlanningError extends Error {
  readonly reasonCode: string;
  readonly reasonDetail: string;
  readonly validationErrors: string[];
  readonly attempts: number;
  readonly engine: string | null;

  constructor(opts: {
    reasonCode: string;
    reasonDetail: string;
    validationErrors?: string[];
    attempts?: number;
    engine?: string | null;
  }) {
    super(`Mission planning failed: ${opts.reasonDetail}`);
    this.name = "MissionPlanningError";
    this.reasonCode = opts.reasonCode;
    this.reasonDetail = opts.reasonDetail;
    this.validationErrors = opts.validationErrors ?? [];
    this.attempts = opts.attempts ?? 0;
    this.engine = opts.engine ?? null;
  }
}

export type MissionPlanningRequest = {
  missionId?: string;
  title: string;
  prompt: string;
  laneId: string | null;
  plannerEngine: MissionPlannerEngine;
  projectRoot: string;
  timeoutMs?: number;
  model?: string;
  allowPlanningQuestions?: boolean;
  phaseCards?: PhaseCard[];
  contextBundle?: MissionPlanningContextBundle;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
  memoryService?: ReturnType<typeof createMemoryService> | null;
  memoryProjectId?: string | null;
  runId?: string | null;
  sourceRunId?: string | null;
  logger?: MissionPlanningLogger;
  policy?: MissionExecutionPolicy;
  phases?: PhaseCard[];
  settings?: import("../../../shared/types").MissionLevelSettings;
  teamRuntime?: TeamRuntimeConfig;
};

export type MissionPlanStepDraft = {
  index: number;
  title: string;
  detail: string;
  kind: string;
  metadata: Record<string, unknown>;
};

export type MissionPlanningResult = {
  plan: PlannerPlan;
  run: MissionPlannerRun;
};

type PlannerAdapterResult = {
  rawResponse: string;
  commandPreview: string;
  engine: MissionPlannerResolvedEngine;
};

type PlannerRuntimeError = {
  reasonCode: MissionPlannerReasonCode;
  detail: string;
  validationErrors?: string[];
  engine: MissionPlannerResolvedEngine;
  commandPreview?: string;
  rawResponse?: string | null;
};

type PlannerProjectKnowledgeEntry = {
  category: string;
  content: string;
};

const TASK_TYPES: PlannerTaskType[] = ["analysis", "code", "integration", "test", "review", "merge", "deploy", "docs", "milestone"];
const CONTEXT_PROFILES: PlannerContextProfileRequirement[] = ["deterministic", "deterministic_plus_narrative"];
const CLAIM_LANES: PlannerClaimLane[] = ["analysis", "backend", "frontend", "integration", "conflict"];
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_PLANNER_VALIDATION_RETRIES = 2;
const DEFAULT_PLANNER_MAX_QUESTIONS = 5;
const GENERIC_STEP_NAME_RE = /^(?:step|task|phase)\s*[-_#]?\s*\d+$/i;
const GENERIC_STEP_DESCRIPTION_RE =
  /^(?:execute|do|perform)\s+(?:mission|this|the)\s+(?:work|step|task)(?:\s+for\s+this\s+step)?\.?$/i;

type PlannerClarificationPolicy = {
  enabled: boolean;
  mode: "always" | "auto_if_uncertain" | "never";
  maxQuestions: number;
};

function clampQuestionCount(value: unknown, fallback = DEFAULT_PLANNER_MAX_QUESTIONS): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(10, Math.floor(numeric)));
}

function normalizePlannerQuestion(question: unknown): PlannerClarifyingQuestion | null {
  const record = isRecord(question) ? question : null;
  if (!record) return null;
  const text = String(record.question ?? "").trim();
  if (!text.length) return null;
  const context = String(record.context ?? "").trim();
  const defaultAssumption = String(record.defaultAssumption ?? "").trim();
  const impact = String(record.impact ?? "").trim();
  return {
    question: text,
    ...(context.length ? { context: context.slice(0, 800) } : {}),
    ...(defaultAssumption.length ? { defaultAssumption: defaultAssumption.slice(0, 800) } : {}),
    ...(impact.length ? { impact: impact.slice(0, 800) } : {})
  };
}

function normalizePlannerAnswer(answer: unknown): PlannerClarifyingAnswer | null {
  const record = isRecord(answer) ? answer : null;
  if (!record) return null;
  const question = String(record.question ?? "").trim();
  const value = String(record.answer ?? "").trim();
  if (!question.length || !value.length) return null;
  const questionIndex = Number(record.questionIndex);
  const source = record.source === "default_assumption" ? "default_assumption" : "user";
  const answeredAtRaw = String(record.answeredAt ?? "").trim();
  const answeredAt = answeredAtRaw.length > 0 ? answeredAtRaw : new Date().toISOString();
  const context = String(record.context ?? "").trim();
  const defaultAssumption = String(record.defaultAssumption ?? "").trim();
  const impact = String(record.impact ?? "").trim();
  return {
    questionIndex: Number.isFinite(questionIndex) ? Math.max(0, Math.floor(questionIndex)) : 0,
    question,
    answer: value,
    source,
    answeredAt,
    ...(context.length ? { context: context.slice(0, 800) } : {}),
    ...(defaultAssumption.length ? { defaultAssumption: defaultAssumption.slice(0, 800) } : {}),
    ...(impact.length ? { impact: impact.slice(0, 800) } : {})
  };
}

function resolvePlannerClarificationPolicy(args: {
  allowPlanningQuestions: boolean;
  phaseCards?: PhaseCard[];
}): PlannerClarificationPolicy {
  const planningPhase =
    args.phaseCards?.find((phase) => phase.phaseKey === "planning")
    ?? args.phaseCards?.find((phase) => phase.name.trim().toLowerCase() === "planning")
    ?? null;
  const phaseAsk = planningPhase?.askQuestions;
  const phaseEnabled = phaseAsk?.enabled === true;
  const enabled = args.allowPlanningQuestions || phaseEnabled;
  const phaseMode = phaseAsk?.mode === "always" || phaseAsk?.mode === "auto_if_uncertain" || phaseAsk?.mode === "never"
    ? phaseAsk.mode
    : "auto_if_uncertain";
  const mode = enabled
    ? (phaseEnabled
        ? phaseMode
        : phaseMode === "never"
          ? "auto_if_uncertain"
          : phaseMode)
    : "never";
  const maxQuestions = clampQuestionCount(phaseEnabled ? phaseAsk?.maxQuestions : undefined);
  if (!enabled) {
    return {
      enabled: false,
      mode: "never",
      maxQuestions
    };
  }
  return {
    enabled: true,
    mode,
    maxQuestions
  };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableStringify(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map((entry) => visit(entry));
    if (!input || typeof input !== "object") return input;
    const record = input as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) out[key] = visit(record[key]);
    return out;
  };
  return JSON.stringify(visit(value));
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function toLowerSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 80);
}

function normalizeStepId(stepId: string | null, index: number): string {
  const normalized = toLowerSlug(stepId ?? "");
  if (normalized.length > 0) return normalized;
  return `plan-${String(index + 1).padStart(3, "0")}`;
}

function isGenericStepName(value: string): boolean {
  const normalized = value.trim();
  if (!normalized.length) return true;
  return GENERIC_STEP_NAME_RE.test(normalized);
}

function isGenericStepDescription(value: string): boolean {
  const normalized = value.trim();
  if (!normalized.length) return true;
  return GENERIC_STEP_DESCRIPTION_RE.test(normalized);
}

function normalizeText(input: unknown, fallback: string): string {
  const text = String(input ?? "").trim();
  return text.length > 0 ? text : fallback;
}

function normalizePlannerMemoryContent(input: unknown, maxChars = 800): string {
  const text = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!text.length) return "";
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...` : text;
}

function toEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const text = String(value ?? "").trim();
  return (allowed as readonly string[]).includes(text) ? (text as T) : fallback;
}

function toPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function extractFirstJsonObject(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith("{") && raw.endsWith("}")) return raw;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = raw.slice(first, last + 1).trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  }
  return null;
}

function getPlanOutputPath(missionId: string): string {
  return path.join(os.tmpdir(), `ade-mission-plan-${missionId}.json`);
}

/**
 * Clean up any leftover plan output temp files. Safe to call at any time.
 */
export function cleanupPlanTempFiles(missionId?: string): void {
  try {
    if (missionId) {
      const filePath = getPlanOutputPath(missionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } else {
      // Clean up all ade-mission-plan-*.json files in tmpdir
      const tmpDir = os.tmpdir();
      const entries = fs.readdirSync(tmpDir);
      for (const entry of entries) {
        if (entry.startsWith("ade-mission-plan-") && entry.endsWith(".json")) {
          try {
            fs.unlinkSync(path.join(tmpDir, entry));
          } catch {
            // best-effort cleanup
          }
        }
      }
    }
  } catch {
    // best-effort cleanup — never throw
  }
}

function plannerSchemaJson(): Record<string, unknown> {
  const stepProperties = {
    stepId: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    taskType: { type: "string", enum: TASK_TYPES },
    executorHint: { type: "string", enum: ["claude", "codex", "either"] },
    preferredScope: { type: "string", enum: ["lane", "file", "session", "global"] },
    requiresContextProfiles: {
      type: "array",
      items: { type: "string", enum: CONTEXT_PROFILES },
      minItems: 1
    },
    dependencies: { type: "array", items: { type: "string" } },
    joinPolicy: { type: "string", enum: ["all_success", "any_success", "quorum"] },
    joinQuorum: { type: "number" },
    artifactHints: { type: "array", items: { type: "string" } },
    claimPolicy: {
      type: "object",
      additionalProperties: false,
      properties: {
        lanes: {
          type: "array",
          items: { type: "string", enum: CLAIM_LANES },
          minItems: 1
        },
        filePatterns: { type: "array", items: { type: "string" } },
        envKeys: { type: "array", items: { type: "string" } },
        exclusive: { type: "boolean" }
      },
      required: ["lanes"]
    },
    timeoutMs: { type: "number" },
    maxAttempts: { type: "number" },
    retryPolicy: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseMs: { type: "number" },
        maxMs: { type: "number" },
        multiplier: { type: "number" },
        maxRetries: { type: "number" }
      },
      required: ["baseMs", "maxMs", "multiplier", "maxRetries"]
    },
    outputContract: {
      type: "object",
      additionalProperties: false,
      properties: {
        expectedSignals: { type: "array", items: { type: "string" } },
        handoffTo: { type: "array", items: { type: "string" } },
        completionCriteria: { type: "string" }
      },
      required: ["expectedSignals", "completionCriteria"]
    }
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { const: "1.0" },
      clarifyingQuestions: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string" },
            context: { type: "string" },
            defaultAssumption: { type: "string" },
            impact: { type: "string" }
          },
          required: ["question"]
        }
      },
      missionSummary: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          objective: { type: "string" },
          domain: { type: "string", enum: ["backend", "frontend", "infra", "testing", "docs", "release", "mixed"] },
          complexity: { type: "string", enum: ["low", "medium", "high"] },
          strategy: { type: "string", enum: ["sequential", "parallel-lite", "parallel-first"] },
          parallelismCap: { type: "number" },
          parallelismRationale: { type: "string" }
        },
        required: ["title", "objective", "domain", "complexity", "strategy", "parallelismCap"]
      },
      assumptions: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
      steps: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: stepProperties,
          required: [
            "stepId",
            "name",
            "description",
            "taskType",
            "executorHint",
            "preferredScope",
            "requiresContextProfiles",
            "dependencies",
            "artifactHints",
            "claimPolicy",
            "maxAttempts",
            "retryPolicy",
            "outputContract"
          ]
        }
      },
      handoffPolicy: {
        type: "object",
        additionalProperties: false,
        properties: {
          externalConflictDefault: { type: "string", enum: ["intervention", "auto_internal_retry", "manual_merge_step"] }
        },
        required: ["externalConflictDefault"]
      }
    },
    required: ["schemaVersion", "missionSummary", "assumptions", "risks", "steps", "handoffPolicy"]
  };
}

function buildPlannerPrompt(args: {
  prompt: string;
  title: string;
  laneId: string | null;
  clarificationPolicy: PlannerClarificationPolicy;
  contextBundle?: MissionPlanningContextBundle;
  projectKnowledge?: PlannerProjectKnowledgeEntry[];
  policy?: MissionExecutionPolicy;
  phases?: PhaseCard[];
  settings?: import("../../../shared/types").MissionLevelSettings;
  planOutputPath: string;
  teamRuntime?: TeamRuntimeConfig;
}): string {
  const MAX_DOC_CONTENT_CHARS = 12_000;
  const MAX_TOTAL_DOCS_CHARS = 200_000;
  const docsEntries = (args.contextBundle?.docsDigest ?? []).slice(0, 20);
  let totalDocsChars = 0;
  const docsBlocks: string[] = [];
  for (const entry of docsEntries) {
    if (entry.content && entry.content.length > 0) {
      const budget = Math.min(MAX_DOC_CONTENT_CHARS, MAX_TOTAL_DOCS_CHARS - totalDocsChars);
      if (budget <= 0) {
        docsBlocks.push(`### ${entry.path} (${entry.bytes} bytes — skipped, context budget exhausted)`);
        continue;
      }
      const truncated = entry.content.length > budget;
      const slice = truncated ? entry.content.slice(0, budget) : entry.content;
      totalDocsChars += slice.length;
      const suffix = truncated ? `\n... [truncated from ${entry.bytes} bytes]` : "";
      docsBlocks.push(`### ${entry.path}\n${slice}${suffix}`);
    } else {
      docsBlocks.push(`### ${entry.path} (${entry.bytes} bytes — content not available)`);
    }
  }
  const docsSection = docsBlocks.length > 0 ? docsBlocks.join("\n\n") : "- none";
  const knowledgeEntries = (args.projectKnowledge ?? [])
    .map((entry) => ({
      category: String(entry.category ?? "fact").trim() || "fact",
      content: normalizePlannerMemoryContent(entry.content)
    }))
    .filter((entry) => entry.content.length > 0)
    .slice(0, 8);
  const knowledgeSection = knowledgeEntries.length
    ? knowledgeEntries.map((entry) => `- [${entry.category}] ${entry.content}`).join("\n")
    : "- none";
  const constraints = [
    "AI is only for initial planning. Runtime transitions are deterministic.",
    `IMPORTANT: Write your final plan as a JSON file. Use your file writing tool to create the file at the path provided in the PLAN_OUTPUT_PATH variable below. The file must contain ONLY valid JSON — no markdown, no comments, no explanations. After writing the file, respond with exactly: PLAN_WRITTEN`,
    `PLAN_OUTPUT_PATH: ${args.planOutputPath}`,
    "Use stable deterministic step IDs suitable for resume/replay.",
    "Do not use generic names such as 'Step 1' or 'Task 2'. Step names must be specific and action-oriented.",
    "Each step description must include concrete deliverables and verification intent.",
    "Dependencies must reflect true execution order. Independent workstreams should not depend on each other.",
    "Prefer minimal safe parallelism unless units are independent.",
    "Recommend a parallelismCap (1-32) based on how many workstreams can truly run independently. Include a brief parallelismRationale in missionSummary explaining your reasoning.",
    args.clarificationPolicy.enabled
      ? `Clarifying questions are enabled for planning (${args.clarificationPolicy.mode}, max ${args.clarificationPolicy.maxQuestions}).`
      : "Clarifying questions are disabled for planning. Fill assumptions conservatively and continue."
  ];

  const lines = [
    "You are a PLANNING agent. Your job is to analyze the request and produce a structured mission plan. You have READ-ONLY access to the codebase to understand the project structure. You MUST NOT write any code, create any source files, or modify any project files. The ONLY file you write is the plan JSON at PLAN_OUTPUT_PATH.",
    "",
    "You are ADE mission planner.",
    "Generate a deterministic mission plan object that matches the provided JSON schema exactly.",
    "",
    "Mission intake:",
    `- title: ${args.title}`,
    `- laneId: ${args.laneId ?? "none"}`,
    "- user_prompt:",
    args.prompt.trim(),
    "",
    "Context constraints:",
    ...constraints.map((line) => `- ${line}`),
    "",
    "Strategic planning principles:",
    "- CRITICAL PATH FIRST: Identify which steps block the most downstream work and front-load them.",
    "- SMART PARALLELISM: Group truly independent work for parallel execution. Don't serialize what can safely run concurrently.",
    "- HANDOFF DESIGN: Each step should produce a clear handoff summary for downstream consumers.",
    "- VERIFY EARLY: Place validation close to implementation, not batched at the end.",
    "- RIGHT-SIZE STEPS: One step = one agent, one session. If a step says 'implement X, Y, and Z' and they're independent, split them.",
    `- Use only supported taskType values: ${TASK_TYPES.join(", ")}.`,
    "- MILESTONE CHECKPOINTS: Insert a taskType \"milestone\" checkpoint every 3-5 implementation steps.",
    "- MILESTONE SYNC BARRIER: Milestone steps are synchronization barriers; dependent streams wait until the milestone succeeds before fan-in/fan-out continues.",
    "- MILESTONE VALIDATION: Milestone outputContract.completionCriteria must be explicit and verifiable (examples: \"all_acceptance_criteria_met_and_no_open_blockers\", \"integration_smoke_checks_green_and_contracts_verified\").",
    "",
    "Clarifying question policy:",
    args.clarificationPolicy.enabled
      ? `- You MAY include a top-level \"clarifyingQuestions\" array with up to ${args.clarificationPolicy.maxQuestions} entries.`
      : "- Do not include a top-level \"clarifyingQuestions\" array.",
    args.clarificationPolicy.enabled
      ? args.clarificationPolicy.mode === "always"
        ? "- Mode is \"always\": include at least one high-value clarifying question before execution planning."
        : args.clarificationPolicy.mode === "auto_if_uncertain"
          ? "- Mode is \"auto_if_uncertain\": include clarifying questions only when ambiguity could cause meaningful rework."
          : "- Mode is \"never\": do not include clarifying questions."
      : "- If information is missing, add assumptions and risks instead of questions.",
    args.clarificationPolicy.enabled
      ? "- For each clarifying question include: question, context, defaultAssumption, impact."
      : "- Keep the output focused on deterministic execution steps.",
    args.clarificationPolicy.enabled
      ? "- Avoid obvious questions. Ask only what materially changes implementation or validation."
      : "- Runtime should proceed without operator input unless blocked by policy.",
    "",
    "Clarifying question output shape (optional):",
    args.clarificationPolicy.enabled
      ? `- \"clarifyingQuestions\": [{ \"question\": string, \"context\": string, \"defaultAssumption\": string, \"impact\": string }] (max ${args.clarificationPolicy.maxQuestions})`
      : "- (disabled)",
    "",
    "IMPORTANT: All relevant project documentation is provided inline below. Do NOT attempt to read or open any files yourself — all context you need for planning is already included in this prompt.",
    "",
    "Project documentation (inline):",
    docsSection,
    "",
    "Project knowledge (memory budget, standard):",
    knowledgeSection,
    "- Consider this knowledge when decomposing work, ordering dependencies, and defining validation checkpoints.",
    "",
    "Additional context bundle (JSON):",
    stableStringify(args.contextBundle ?? {}),
    "",
    "## ADE Platform Capabilities",
    "You are planning for the ADE (Autonomous Development Environment) platform. Available capabilities:",
    "- **Lanes**: Isolated git worktrees for parallel development. Each step can execute in its own lane.",
    "- **Merge Conflict Resolution**: Built-in AI-powered merge conflict detection and resolution.",
    "- **Agent Teams**: Multiple AI agents can work in parallel on different steps.",
    "- **MCP Tools**: Model Context Protocol tools for file operations, terminal commands, web access, and more.",
    "- **Context Packs**: Curated sets of files and documentation that provide focused context to agents.",
    "- **Integration Chain**: Automated PR creation, code review, and branch integration pipeline.",
    "- **Parallel Execution**: Steps without dependencies can execute simultaneously across multiple agents.",
    ""
  ];

  if (args.teamRuntime?.enabled) {
    lines.push(
      "## Agent Team Runtime (ENABLED)",
      "This mission uses the ADE team runtime. The orchestrator operates as a coordinator with dedicated teammates.",
      "- Teammates share a task list and dynamically claim work as it becomes available.",
      "- Direct inter-agent communication is supported — teammates can message each other and the coordinator.",
      "- The coordinator manages the lifecycle: spawning teammates, assigning initial tasks, validating completion.",
      `- Target provider: ${args.teamRuntime.targetProvider}, teammate count: ${args.teamRuntime.teammateCount}.`,
      "Plan accordingly — design steps that can be claimed and executed independently by teammates. Larger missions benefit from more granular steps.",
      ""
    );
  }

  if (args.policy) {
    const p = args.policy;
    lines.push(
      "Execution policy constraints:",
      `- Testing mode: ${p.testing.mode}.`,
      `- Code review: ${p.codeReview.mode}.`,
      `- Merge: ${p.merge.mode}.`,
      `- Executor preferences: planning=${p.planning.model ?? "codex"}, implementation=${p.implementation.model ?? "codex"}, testing=${p.testing.model ?? "codex"}.`,
      ""
    );
    if (p.testing.mode === "none") {
      lines.push(
        "HARD CONSTRAINT — TESTING DISABLED: The user has explicitly disabled testing. You MUST NOT generate any test, validation, or verification steps. Do not include steps of type \"test\", \"validation\", \"test_review\", \"milestone\", or any step whose purpose is running tests/validation gates. This is a non-negotiable requirement.",
        ""
      );
    }
  }

  lines.push(
    "Before finalizing your plan, validate it:",
    "1. Every dependency in every step must reference a stepId that exists in your plan.",
    "2. Every stepId must be unique across all steps.",
    "3. No circular dependency chains.",
    "4. Step names must be descriptive, not generic (no \"Step 1\", \"Step 2\").",
    "5. Verify the JSON is well-formed and matches the required schema.",
    "If you find issues, fix them before outputting the final JSON.",
    ""
  );

  lines.push(`Output: Write one JSON object to ${args.planOutputPath}. Then reply with PLAN_WRITTEN.`);
  return lines.join("\n");
}

function normalizePlannerStep(step: unknown, index: number): PlannerStepPlan {
  const record = isRecord(step) ? step : {};
  return {
    stepId: normalizeStepId(typeof record.stepId === "string" ? record.stepId : null, index),
    name: normalizeText(record.name, `Step ${index + 1}`),
    description: normalizeText(record.description, "Execute this step and verify completion criteria."),
    taskType: toEnum(record.taskType, TASK_TYPES, "code"),
    executorHint: toEnum(record.executorHint, ["claude", "codex", "either"] as const, "either"),
    preferredScope: toEnum(record.preferredScope, ["lane", "file", "session", "global"] as const, "lane"),
    requiresContextProfiles: (() => {
      const values = toStringArray(record.requiresContextProfiles)
        .map((entry) => toEnum(entry, CONTEXT_PROFILES, "deterministic"))
        .filter((entry, idx, arr) => arr.indexOf(entry) === idx);
      return values.length > 0 ? values : ["deterministic"];
    })(),
    dependencies: toStringArray(record.dependencies).map((entry) => normalizeStepId(entry, index)),
    joinPolicy: (() => {
      if (record.joinPolicy == null) return undefined;
      return toEnum(record.joinPolicy, ["all_success", "any_success", "quorum"] as const, "all_success");
    })(),
    joinQuorum: record.joinQuorum == null ? undefined : toPositiveInt(record.joinQuorum, 1, 1, 16),
    artifactHints: toStringArray(record.artifactHints),
    claimPolicy: (() => {
      const claim = isRecord(record.claimPolicy) ? record.claimPolicy : {};
      const lanes = toStringArray(claim.lanes)
        .map((entry) => toEnum(entry, CLAIM_LANES, "analysis"))
        .filter((entry, idx, arr) => arr.indexOf(entry) === idx);
      return {
        lanes,
        filePatterns: toStringArray(claim.filePatterns),
        envKeys: toStringArray(claim.envKeys),
        exclusive: claim.exclusive === true
      };
    })(),
    timeoutMs: record.timeoutMs == null ? undefined : toPositiveInt(record.timeoutMs, 120_000, 1_000, 3_600_000),
    maxAttempts: (() => {
      const raw = Number(record.maxAttempts);
      if (!Number.isFinite(raw)) return 2;
      return Math.floor(raw);
    })(),
    retryPolicy: (() => {
      const retry = isRecord(record.retryPolicy) ? record.retryPolicy : {};
      const baseMs = toPositiveInt(retry.baseMs, 5_000, 100, 600_000);
      const maxMs = toPositiveInt(retry.maxMs, 120_000, baseMs, 3_600_000);
      return {
        baseMs,
        maxMs,
        multiplier: Math.max(1.1, Math.min(6, Number(retry.multiplier ?? 2))),
        maxRetries: toPositiveInt(retry.maxRetries, 1, 0, 8)
      };
    })(),
    outputContract: (() => {
      const contract = isRecord(record.outputContract) ? record.outputContract : {};
      return {
        expectedSignals: toStringArray(contract.expectedSignals),
        handoffTo: toStringArray(contract.handoffTo),
        completionCriteria: normalizeText(contract.completionCriteria, "completion_signals_present")
      };
    })()
  };
}

export function validateAndCanonicalizePlannerPlan(raw: unknown): {
  plan: PlannerPlan;
  validationErrors: string[];
} {
  const source = isRecord(raw) ? raw : {};
  const missionSummarySource = isRecord(source.missionSummary) ? source.missionSummary : {};
  const clarifyingQuestions = Array.isArray(source.clarifyingQuestions)
    ? source.clarifyingQuestions
        .map((entry) => normalizePlannerQuestion(entry))
        .filter((entry): entry is PlannerClarifyingQuestion => entry != null)
        .slice(0, 10)
    : [];
  const clarifyingAnswers = Array.isArray(source.clarifyingAnswers)
    ? source.clarifyingAnswers
        .map((entry) => normalizePlannerAnswer(entry))
        .filter((entry): entry is PlannerClarifyingAnswer => entry != null)
        .slice(0, 20)
    : [];
  const stepsRaw = Array.isArray(source.steps) ? source.steps : [];
  const normalizedSteps = stepsRaw.map((step, index) => normalizePlannerStep(step, index));

  const validationErrors: string[] = [];
  if (normalizedSteps.length === 0) validationErrors.push("Plan must include at least one step.");

  const seen = new Set<string>();
  for (const step of normalizedSteps) {
    if (isGenericStepName(step.name)) {
      validationErrors.push(`Step '${step.stepId}' uses a generic name ('${step.name}').`);
    }
    if (isGenericStepDescription(step.description)) {
      validationErrors.push(`Step '${step.stepId}' uses an uninformative description.`);
    }
    if (seen.has(step.stepId)) validationErrors.push(`Duplicate stepId: ${step.stepId}`);
    seen.add(step.stepId);
  }

  const stepById = new Map<string, PlannerStepPlan>();
  for (const step of normalizedSteps) stepById.set(step.stepId, step);

  for (const step of normalizedSteps) {
    step.dependencies = step.dependencies.filter((dep) => dep !== step.stepId);
    for (const dep of step.dependencies) {
      if (!stepById.has(dep)) validationErrors.push(`Unresolved dependency '${dep}' in step '${step.stepId}'.`);
    }
    if (step.joinPolicy === "quorum") {
      if (!step.joinQuorum || step.joinQuorum <= 0) {
        validationErrors.push(`Step '${step.stepId}' uses joinPolicy=quorum without valid joinQuorum.`);
      }
    }
    if (step.maxAttempts < 1 || step.maxAttempts > 8) {
      validationErrors.push(`Step '${step.stepId}' has maxAttempts outside bounds [1..8].`);
    }
  }

  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const step of normalizedSteps) {
    indegree.set(step.stepId, 0);
    adjacency.set(step.stepId, []);
  }
  for (const step of normalizedSteps) {
    for (const dep of step.dependencies) {
      adjacency.get(dep)?.push(step.stepId);
      indegree.set(step.stepId, (indegree.get(step.stepId) ?? 0) + 1);
    }
  }

  const originalOrder = new Map<string, number>();
  normalizedSteps.forEach((step, index) => originalOrder.set(step.stepId, index));

  const queue = [...normalizedSteps.filter((step) => (indegree.get(step.stepId) ?? 0) === 0)].sort((a, b) => {
    const ao = originalOrder.get(a.stepId) ?? 0;
    const bo = originalOrder.get(b.stepId) ?? 0;
    return ao - bo || a.stepId.localeCompare(b.stepId);
  });
  const ordered: PlannerStepPlan[] = [];
  while (queue.length > 0) {
    const next = queue.shift()!;
    ordered.push(next);
    for (const dependent of adjacency.get(next.stepId) ?? []) {
      indegree.set(dependent, (indegree.get(dependent) ?? 0) - 1);
      if ((indegree.get(dependent) ?? 0) === 0) {
        const candidate = stepById.get(dependent);
        if (candidate) queue.push(candidate);
      }
    }
    queue.sort((a, b) => {
      const ao = originalOrder.get(a.stepId) ?? 0;
      const bo = originalOrder.get(b.stepId) ?? 0;
      return ao - bo || a.stepId.localeCompare(b.stepId);
    });
  }
  if (ordered.length !== normalizedSteps.length) {
    validationErrors.push("Dependency cycle detected in planner steps.");
  }

  if (validationErrors.length > 0) {
    return {
      plan: buildDeterministicPlannerPlan({
        title: normalizeText(missionSummarySource.title, "Mission"),
        prompt: normalizeText(source.prompt, ""),
        laneId: null
      }),
      validationErrors
    };
  }

  const plan: PlannerPlan = {
    schemaVersion: "1.0",
    ...(clarifyingQuestions.length > 0 ? { clarifyingQuestions } : {}),
    ...(clarifyingAnswers.length > 0 ? { clarifyingAnswers } : {}),
    missionSummary: {
      title: normalizeText(missionSummarySource.title, "Mission"),
      objective: normalizeText(missionSummarySource.objective, "Deliver mission objective with deterministic execution."),
      domain: toEnum(
        missionSummarySource.domain,
        ["backend", "frontend", "infra", "testing", "docs", "release", "mixed"] as const,
        "mixed"
      ),
      complexity: toEnum(missionSummarySource.complexity, ["low", "medium", "high"] as const, "medium"),
      strategy: toEnum(missionSummarySource.strategy, ["sequential", "parallel-lite", "parallel-first"] as const, "parallel-lite"),
      parallelismCap: toPositiveInt(missionSummarySource.parallelismCap, 2, 1, 32),
      parallelismRationale: typeof missionSummarySource.parallelismRationale === "string"
        ? missionSummarySource.parallelismRationale.slice(0, 500)
        : undefined
    },
    assumptions: toStringArray(source.assumptions),
    risks: toStringArray(source.risks),
    steps: ordered.map((step) => ({
      ...step,
      dependencies: [...new Set(step.dependencies)].sort((a, b) => a.localeCompare(b)),
      artifactHints: [...new Set(step.artifactHints)],
      outputContract: {
        ...step.outputContract,
        expectedSignals: [...new Set(step.outputContract.expectedSignals)],
        handoffTo: [...new Set(step.outputContract.handoffTo ?? [])]
      }
    })),
    handoffPolicy: {
      externalConflictDefault: toEnum(
        isRecord(source.handoffPolicy) ? source.handoffPolicy.externalConflictDefault : null,
        ["intervention", "auto_internal_retry", "manual_merge_step"] as const,
        "intervention"
      )
    }
  };

  return {
    plan,
    validationErrors: []
  };
}

function inferDomain(prompt: string): PlannerMissionDomain {
  const lower = prompt.toLowerCase();
  if (/\b(ui|frontend|css|layout|react|tailwind)\b/.test(lower)) return "frontend";
  if (/\b(api|backend|database|server|orm)\b/.test(lower)) return "backend";
  if (/\binfra|deploy|kubernetes|terraform|aws|ci\b/.test(lower)) return "infra";
  if (/\btest|qa|verify|validation\b/.test(lower)) return "testing";
  if (/\bdocs|documentation|readme\b/.test(lower)) return "docs";
  if (/\brelease|changelog|version\b/.test(lower)) return "release";
  return "mixed";
}

function inferComplexity(prompt: string): PlannerMissionComplexity {
  const lines = prompt.split("\n").length;
  if (prompt.length < 120 && lines < 3) return "low";
  if (prompt.length < 400 && lines < 8) return "medium";
  return "high";
}

function mapLegacyStrategy(strategy: string): PlannerMissionStrategy {
  if (strategy.includes("parallel")) return "parallel-first";
  if (strategy.includes("integration_gate")) return "parallel-lite";
  return "sequential";
}

export function buildDeterministicPlannerPlan(args: {
  title: string;
  prompt: string;
  laneId: string | null;
  policy?: MissionExecutionPolicy;
  phases?: PhaseCard[];
  settings?: import("../../../shared/types").MissionLevelSettings;
}): PlannerPlan {
  const legacy = buildDeterministicMissionPlan({
    prompt: args.prompt,
    laneId: args.laneId,
    policy: args.policy
  });
  const idByIndex = legacy.steps.map((_, index) => `plan-${String(index + 1).padStart(3, "0")}`);
  const steps: PlannerStepPlan[] = legacy.steps.map((step, index) => {
    const metadata = step.metadata ?? {};
    const depIndices = Array.isArray(metadata.dependencyIndices)
      ? metadata.dependencyIndices.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : [];
    const deps = depIndices
      .map((value) => idByIndex[Math.max(0, Math.floor(value))] ?? "")
      .filter(Boolean);

    const taskType: PlannerTaskType =
      step.kind === "analysis"
        ? "analysis"
        : step.kind === "validation"
          ? "test"
          : step.kind === "integration"
            ? "integration"
            : step.kind === "summary"
              ? "review"
              : "code";

    return {
      stepId: idByIndex[index]!,
      name: step.title,
      description: step.detail,
      taskType,
      executorHint: "either",
      preferredScope: "lane",
      requiresContextProfiles: ["deterministic"],
      dependencies: deps,
      joinPolicy: (metadata.joinPolicy as PlannerStepPlan["joinPolicy"]) ?? "all_success",
      joinQuorum: Number.isFinite(Number(metadata.quorumCount)) ? Number(metadata.quorumCount) : undefined,
      artifactHints: [],
      claimPolicy: {
        lanes: taskType === "integration" ? ["integration"] : ["backend"],
        exclusive: true
      },
      timeoutMs: undefined,
      maxAttempts: Number.isFinite(Number(metadata.retryLimit)) ? Math.max(1, Number(metadata.retryLimit) + 1) : 2,
      retryPolicy: {
        baseMs: 5_000,
        maxMs: 120_000,
        multiplier: 2,
        maxRetries: Number.isFinite(Number(metadata.retryLimit)) ? Math.max(0, Number(metadata.retryLimit)) : 1
      },
      outputContract: {
        expectedSignals: [],
        handoffTo: [],
        completionCriteria:
          typeof metadata.doneCriteria === "string" && metadata.doneCriteria.trim().length > 0
            ? metadata.doneCriteria.trim()
            : "completion_signals_present"
      }
    };
  });

  const strategy = mapLegacyStrategy(legacy.strategy);
  return {
    schemaVersion: "1.0",
    clarifyingQuestions: [],
    clarifyingAnswers: [],
    missionSummary: {
      title: args.title,
      objective: args.prompt.trim(),
      domain: inferDomain(args.prompt),
      complexity: inferComplexity(args.prompt),
      strategy,
      parallelismCap: strategy === "parallel-first" ? 3 : 2
    },
    assumptions: [],
    risks: [],
    steps,
    handoffPolicy: {
      externalConflictDefault: "intervention"
    }
  };
}

function plannerEngineOrder(
  requested: MissionPlannerEngine,
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>
): MissionPlannerResolvedEngine[] {
  const availability = aiIntegrationService?.getAvailability() ?? { claude: false, codex: false };

  if (requested === "claude_cli") return availability.claude ? ["claude_cli"] : [];
  if (requested === "codex_cli") return availability.codex ? ["codex_cli"] : [];

  const ordered: MissionPlannerResolvedEngine[] = [];
  if (availability.claude) ordered.push("claude_cli");
  if (availability.codex) ordered.push("codex_cli");
  return ordered;
}

async function runPlannerAdapter(args: {
  engine: MissionPlannerResolvedEngine;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  model?: string;
  planOutputPath: string;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
}): Promise<PlannerAdapterResult> {
  if (!args.aiIntegrationService || args.aiIntegrationService.getMode() === "guest") {
    throw new Error("Mission planning AI is unavailable. Install/authenticate Claude Code or Codex.");
  }

  if (args.engine === "codex_cli" || args.engine === "claude_cli") {
    const provider = args.engine === "codex_cli" ? "codex" : "claude";
    // Use "edit" permission mode so the planner can write its plan JSON to the
    // temp file at planOutputPath. The planner prompt explicitly constrains the
    // agent to only write that single file — no project files.
    const aiResult = await args.aiIntegrationService.planMission({
      cwd: args.cwd,
      prompt: args.prompt,
      timeoutMs: args.timeoutMs,
      model: args.model,
      provider,
      jsonSchema: plannerSchemaJson(),
      permissionMode: "edit"
    });
    const rawResponse =
      aiResult.structuredOutput != null && typeof aiResult.structuredOutput === "object"
        ? JSON.stringify(aiResult.structuredOutput)
        : aiResult.text;
    return {
      engine: args.engine,
      rawResponse,
      commandPreview: `aiIntegrationService.planMission(provider=${provider})`
    };
  }
  throw new Error("Planner adapter is unavailable for the requested engine.");
}

function mapHintToExecutor(args: {
  hint: PlannerStepPlan["executorHint"];
  taskType: PlannerTaskType;
  executorPolicy: string;
}): OrchestratorExecutorKind {
  if (args.executorPolicy === "codex") return "codex";
  if (args.executorPolicy === "claude") return "claude";

  if (args.hint === "claude") return "claude";
  if (args.hint === "codex") return "codex";
  if (args.taskType === "code" || args.taskType === "integration" || args.taskType === "merge" || args.taskType === "test" || args.taskType === "deploy") {
    return "codex";
  }
  return "claude";
}

function inferReviewTarget(step: PlannerStepPlan): "code" | "tests" {
  const label = `${step.name} ${step.description}`.toLowerCase();
  if (/\b(test|tests|qa|verification|assert|spec)\b/.test(label)) return "tests";
  return "code";
}

function inferRoleClass(step: PlannerStepPlan): string {
  if (step.taskType === "analysis") return "planning";
  if (step.taskType === "code" || step.taskType === "deploy") return "implementation";
  if (step.taskType === "test") return "testing";
  if (step.taskType === "review" || step.taskType === "milestone") return "review";
  if (step.taskType === "integration") return "integration";
  if (step.taskType === "merge") return "merge";
  return "handoff";
}

function toClaimScopes(step: PlannerStepPlan): Array<{ scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number }> {
  const scopes: Array<{ scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number }> = [];
  // Planner lane hints are semantic domains (backend/frontend/integration), not concrete ADE lanes.
  // We only emit deterministic lock scopes when explicit file/env scopes are present.
  for (const pattern of step.claimPolicy.filePatterns ?? []) {
    const normalizedPattern = String(pattern ?? "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "");
    if (!normalizedPattern.length) continue;
    scopes.push({
      scopeKind: "file",
      scopeValue: `glob:${normalizedPattern}`,
      ttlMs: step.timeoutMs ?? 60_000
    });
  }
  for (const envKey of step.claimPolicy.envKeys ?? []) {
    scopes.push({
      scopeKind: "env",
      scopeValue: envKey,
      ttlMs: step.timeoutMs ?? 60_000
    });
  }
  return scopes;
}

export function plannerPlanToMissionSteps(args: {
  plan: PlannerPlan;
  requestedEngine: MissionPlannerEngine;
  resolvedEngine: MissionPlannerResolvedEngine;
  executorPolicy: string;
  degraded: boolean;
  reasonCode: MissionPlannerReasonCode | null;
  validationErrors: string[];
  policy?: MissionExecutionPolicy;
  phases?: PhaseCard[];
  settings?: import("../../../shared/types").MissionLevelSettings;
}): MissionPlanStepDraft[] {
  const indexByStepId = new Map<string, number>();
  args.plan.steps.forEach((step, index) => indexByStepId.set(step.stepId, index));
  return args.plan.steps.map((step, index) => {
    const requiresNarrative = step.requiresContextProfiles.includes("deterministic_plus_narrative");
    const retryLimit = Math.max(0, step.maxAttempts - 1);
    const reviewTarget = step.taskType === "review" ? inferReviewTarget(step) : null;
    const roleClass = inferRoleClass(step);
    const dependencyIndices = step.dependencies
      .map((dep) => indexByStepId.get(dep))
      .filter((value): value is number => typeof value === "number");

    // Resolve executor kind — policy overrides take precedence
    let executorKind: OrchestratorExecutorKind;
    if (args.policy) {
      const taskType = step.taskType;
      if (taskType === "analysis") {
        executorKind = phaseModelToExecutorKind(args.policy.planning.model);
      } else if (taskType === "code") {
        executorKind = phaseModelToExecutorKind(args.policy.implementation.model);
      } else if (taskType === "test") {
        executorKind = phaseModelToExecutorKind(args.policy.testing.model);
      } else if (taskType === "milestone") {
        executorKind = phaseModelToExecutorKind(args.policy.validation.model);
      } else if (taskType === "review") {
        executorKind =
          reviewTarget === "tests"
            ? phaseModelToExecutorKind(args.policy.testReview.model)
            : phaseModelToExecutorKind(args.policy.codeReview.model);
      } else if (taskType === "integration" || taskType === "merge") {
        executorKind = phaseModelToExecutorKind(args.policy.implementation?.model);
      } else {
        executorKind = mapHintToExecutor({
          hint: step.executorHint,
          taskType: step.taskType,
          executorPolicy: args.executorPolicy
        });
      }
    } else {
      executorKind = mapHintToExecutor({
        hint: step.executorHint,
        taskType: step.taskType,
        executorPolicy: args.executorPolicy
      });
    }

    // Resolve reasoning effort from policy
    let reasoningEffort: string | undefined;
    if (args.policy) {
      const taskType = step.taskType;
      if (taskType === "analysis") {
        reasoningEffort = args.policy.planning.reasoningEffort;
      } else if (taskType === "code") {
        reasoningEffort = args.policy.implementation.reasoningEffort;
      } else if (taskType === "test") {
        reasoningEffort = args.policy.testing.reasoningEffort;
      } else if (taskType === "milestone") {
        reasoningEffort = args.policy.validation.reasoningEffort;
      } else if (taskType === "review") {
        reasoningEffort =
          reviewTarget === "tests"
            ? args.policy.testReview.reasoningEffort
            : args.policy.codeReview.reasoningEffort;
      } else if (taskType === "integration" || taskType === "merge") {
        reasoningEffort = args.policy.implementation?.reasoningEffort;
      }
    }

    const metadata: Record<string, unknown> = {
      stepKey: step.stepId,
      stepType: step.taskType,
      dependencyStepKeys: step.dependencies,
      dependencyIndices,
      joinPolicy: step.joinPolicy ?? "all_success",
      quorumCount: step.joinQuorum ?? null,
      retryLimit,
      executorKind,
      doneCriteria: step.outputContract.completionCriteria,
      expectedSignals: step.outputContract.expectedSignals,
      artifactHints: step.artifactHints,
      laneHints: step.claimPolicy.lanes,
      planner: {
        version: "ade.missionPlanner.v2",
        schemaVersion: args.plan.schemaVersion,
        missionStrategy: args.plan.missionSummary.strategy,
        requestedEngine: args.requestedEngine,
        resolvedEngine: args.resolvedEngine,
        degraded: args.degraded,
        reasonCode: args.reasonCode,
        validationErrors: args.validationErrors
      },
      policy: {
        includeNarrative: requiresNarrative,
        includeFullDocs:
          step.taskType === "analysis"
          || step.taskType === "integration"
          || step.taskType === "review"
          || step.taskType === "milestone",
        docsMaxBytes: requiresNarrative ? 220_000 : 120_000,
        claimScopes: toClaimScopes(step)
      },
      roleClass,
      requiresDedicatedWorker: roleClass === "review" || roleClass === "testing" || roleClass === "integration",
      ...(reviewTarget ? { reviewTarget } : {}),
      planStep: step,
      ...(args.plan.clarifyingQuestions?.length ? { plannerClarifyingQuestions: args.plan.clarifyingQuestions } : {}),
      ...(args.plan.clarifyingAnswers?.length ? { plannerClarifyingAnswers: args.plan.clarifyingAnswers } : {})
    };

    if (reasoningEffort) {
      metadata.reasoningEffort = reasoningEffort;
    }

    return {
      index,
      title: step.name,
      detail: step.description,
      kind:
        step.taskType === "analysis"
          ? "analysis"
          : step.taskType === "test"
            ? "validation"
          : step.taskType === "integration" || step.taskType === "merge"
              ? "integration"
              : step.taskType === "review" || step.taskType === "docs" || step.taskType === "milestone"
                ? "summary"
                : "implementation",
      metadata
    };
  });
}

export async function planMissionOnce(args: MissionPlanningRequest): Promise<MissionPlanningResult> {
  const startedAt = Date.now();
  const plannerRunId = randomUUID();
  const memoryProjectId = String(args.memoryProjectId ?? "").trim();
  const sourceRunId = String(args.sourceRunId ?? args.runId ?? "").trim() || plannerRunId;
  const missionId = args.missionId ?? randomUUID();
  const timeoutMs = Math.max(5_000, Math.min(600_000, Math.floor(args.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
  const requestedEngine: MissionPlannerEngine = args.plannerEngine ?? "auto";
  const order = plannerEngineOrder(requestedEngine, args.aiIntegrationService);
  const plannerAttempts: MissionPlannerAttempt[] = [];
  const planOutputPath = getPlanOutputPath(missionId);
  const clarificationPolicy = resolvePlannerClarificationPolicy({
    allowPlanningQuestions: args.allowPlanningQuestions === true,
    phaseCards: args.phaseCards
  });
  const projectKnowledge: PlannerProjectKnowledgeEntry[] = (() => {
    if (!args.memoryService || !memoryProjectId.length) return [];
    try {
      const memories = args.memoryService.getMemoryBudget(memoryProjectId, "standard");
      return memories
        .map((memory) => ({
          category: String(memory.category ?? "fact").trim() || "fact",
          content: normalizePlannerMemoryContent(memory.content)
        }))
        .filter((entry) => entry.content.length > 0)
        .slice(0, 8);
    } catch (error) {
      args.logger?.warn?.("missions.planner.memory_read_failed", {
        plannerRunId,
        projectId: memoryProjectId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  })();

  const prompt = buildPlannerPrompt({
    prompt: args.prompt,
    title: args.title,
    laneId: args.laneId,
    clarificationPolicy,
    contextBundle: args.contextBundle,
    projectKnowledge,
    policy: args.policy,
    planOutputPath,
    teamRuntime: args.teamRuntime
  });

  const runtimeErrors: PlannerRuntimeError[] = [];
  if (!order.length) {
    throw new MissionPlanningError({
      reasonCode: "planner_unavailable",
      reasonDetail: "Selected planner adapter is unavailable on this machine.",
      attempts: 0,
      engine: null
    });
  }
  for (const engine of order) {
    try {
      let adapterResult = await runPlannerAdapter({
        engine,
        cwd: args.projectRoot,
        prompt,
        timeoutMs,
        model: args.model,
        planOutputPath,
        aiIntegrationService: args.aiIntegrationService
      });

      // --- Multi-strategy plan extraction ---
      let rawJson: string | null = null;
      let planSource: "file" | "text" | "recovery" | null = null;

      // Strategy 1: Read plan JSON from the temp file the planner was instructed to write
      try {
        if (fs.existsSync(planOutputPath)) {
          const fileContent = fs.readFileSync(planOutputPath, "utf-8").trim();
          if (fileContent.startsWith("{")) {
            rawJson = fileContent;
            planSource = "file";
            args.logger?.info?.("ai_orchestrator.planner_plan_from_file", {
              missionId,
              path: planOutputPath
            });
          }
        }
      } catch {
        // file read failed — fall through to text extraction
      }

      // Strategy 2: Extract JSON from the planner's text output (existing fallback)
      if (!rawJson && adapterResult.rawResponse) {
        rawJson = extractFirstJsonObject(adapterResult.rawResponse);
        if (rawJson) {
          planSource = "text";
          args.logger?.info?.("ai_orchestrator.planner_plan_from_text", { missionId });
        }
      }

      // Strategy 3: Recovery — ask planner to re-output the plan to the file
      if (!rawJson) {
        args.logger?.warn?.("ai_orchestrator.planner_plan_recovery", { missionId });
        try {
          const recoveryResult = await runPlannerAdapter({
            engine,
            cwd: args.projectRoot,
            prompt: `Your plan was not saved correctly. Write ONLY the JSON plan object to ${planOutputPath}. No other text. Use your file writing tool to create the file. After writing, respond with: PLAN_WRITTEN`,
            timeoutMs: Math.min(timeoutMs, 60_000), // shorter timeout for recovery
            model: args.model,
            planOutputPath,
            aiIntegrationService: args.aiIntegrationService
          });
          // Try reading the file again after recovery
          try {
            if (fs.existsSync(planOutputPath)) {
              const recoveryFileContent = fs.readFileSync(planOutputPath, "utf-8").trim();
              if (recoveryFileContent.startsWith("{")) {
                rawJson = recoveryFileContent;
                planSource = "recovery";
                args.logger?.info?.("ai_orchestrator.planner_plan_from_recovery_file", { missionId });
              }
            }
          } catch {
            // file read failed after recovery
          }
          // Try extracting from recovery text output
          if (!rawJson && recoveryResult.rawResponse) {
            rawJson = extractFirstJsonObject(recoveryResult.rawResponse);
            if (rawJson) {
              planSource = "recovery";
              args.logger?.info?.("ai_orchestrator.planner_plan_from_recovery_text", { missionId });
            }
          }
        } catch (recoveryError) {
          args.logger?.warn?.("ai_orchestrator.planner_recovery_failed", {
            missionId,
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          });
        }
      }

      // Clean up temp file after extraction
      try { if (fs.existsSync(planOutputPath)) fs.unlinkSync(planOutputPath); } catch { /* best-effort */ }

      if (!rawJson) {
        plannerAttempts.push({
          id: randomUUID(),
          engine,
          status: "failed",
          reasonCode: "planner_parse_error",
          detail: "Planner output did not contain a valid JSON plan after all extraction strategies (file, text, recovery).",
          commandPreview: adapterResult.commandPreview,
          rawResponse: adapterResult.rawResponse,
          validationErrors: [],
          createdAt: new Date().toISOString()
        });
        runtimeErrors.push({
          engine,
          reasonCode: "planner_parse_error",
          detail: "Planner output did not contain a valid JSON plan after all extraction strategies (file, text, recovery).",
          rawResponse: adapterResult.rawResponse,
          commandPreview: adapterResult.commandPreview
        });
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch (error) {
        plannerAttempts.push({
          id: randomUUID(),
          engine,
          status: "failed",
          reasonCode: "planner_parse_error",
          detail: error instanceof Error ? error.message : String(error),
          commandPreview: adapterResult.commandPreview,
          rawResponse: adapterResult.rawResponse,
          validationErrors: [],
          createdAt: new Date().toISOString()
        });
        runtimeErrors.push({
          engine,
          reasonCode: "planner_parse_error",
          detail: error instanceof Error ? error.message : String(error),
          rawResponse: adapterResult.rawResponse,
          commandPreview: adapterResult.commandPreview
        });
        continue;
      }

      let { plan, validationErrors } = validateAndCanonicalizePlannerPlan(parsed);

      // Retry the same engine with feedback when validation fails
      if (validationErrors.length > 0) {
        let retrySucceeded = false;
        for (let retryIdx = 0; retryIdx < MAX_PLANNER_VALIDATION_RETRIES; retryIdx++) {
          args.logger?.warn?.("missions.planner.validation_retry", {
            engine,
            retry: retryIdx + 1,
            maxRetries: MAX_PLANNER_VALIDATION_RETRIES,
            validationErrors
          });

          const retryPrompt =
            prompt +
            "\n\n---\n\nYour previous plan output had validation errors:\n" +
            validationErrors.map((e, i) => `${i + 1}. ${e}`).join("\n") +
            "\n\nFix these issues and output a corrected plan. " +
            "Keep all the same steps but fix the referenced problems.";

          try {
            const retryAdapterResult = await runPlannerAdapter({
              engine,
              cwd: args.projectRoot,
              prompt: retryPrompt,
              timeoutMs,
              model: args.model,
              planOutputPath,
              aiIntegrationService: args.aiIntegrationService
            });

            const retryRawJson = extractFirstJsonObject(retryAdapterResult.rawResponse);
            if (!retryRawJson) {
              plannerAttempts.push({
                id: randomUUID(),
                engine,
                status: "failed",
                reasonCode: "planner_parse_error",
                detail: `Validation retry ${retryIdx + 1}: output did not contain a JSON object.`,
                commandPreview: retryAdapterResult.commandPreview,
                rawResponse: retryAdapterResult.rawResponse,
                validationErrors: [],
                createdAt: new Date().toISOString()
              });
              continue;
            }

            let retryParsed: unknown;
            try {
              retryParsed = JSON.parse(retryRawJson);
            } catch (parseErr) {
              plannerAttempts.push({
                id: randomUUID(),
                engine,
                status: "failed",
                reasonCode: "planner_parse_error",
                detail: `Validation retry ${retryIdx + 1}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
                commandPreview: retryAdapterResult.commandPreview,
                rawResponse: retryAdapterResult.rawResponse,
                validationErrors: [],
                createdAt: new Date().toISOString()
              });
              continue;
            }

            const retryValidation = validateAndCanonicalizePlannerPlan(retryParsed);
            if (retryValidation.validationErrors.length === 0) {
              // Retry succeeded — use the corrected plan
              plan = retryValidation.plan;
              validationErrors = [];
              adapterResult = retryAdapterResult;
              rawJson = retryRawJson;
              parsed = retryParsed;
              retrySucceeded = true;
              args.logger?.info?.("missions.planner.validation_retry_success", {
                engine,
                retry: retryIdx + 1
              });
              break;
            }

            // Update errors for next retry attempt
            validationErrors = retryValidation.validationErrors;
            plannerAttempts.push({
              id: randomUUID(),
              engine,
              status: "failed",
              reasonCode: "planner_validation_error",
              detail: `Validation retry ${retryIdx + 1}: ${retryValidation.validationErrors[0] ?? "Planner validation failed."}`,
              commandPreview: retryAdapterResult.commandPreview,
              rawResponse: retryAdapterResult.rawResponse,
              validationErrors: retryValidation.validationErrors,
              createdAt: new Date().toISOString()
            });
          } catch (retryErr) {
            args.logger?.warn?.("missions.planner.validation_retry_error", {
              engine,
              retry: retryIdx + 1,
              error: retryErr instanceof Error ? retryErr.message : String(retryErr)
            });
            break;
          }
        }

        if (!retrySucceeded) {
          plannerAttempts.push({
            id: randomUUID(),
            engine,
            status: "failed",
            reasonCode: "planner_validation_error",
            detail: validationErrors[0] ?? "Planner validation failed.",
            commandPreview: adapterResult.commandPreview,
            rawResponse: adapterResult.rawResponse,
            validationErrors,
            createdAt: new Date().toISOString()
          });
          runtimeErrors.push({
            engine,
            reasonCode: "planner_validation_error",
            detail: validationErrors[0] ?? "Planner validation failed.",
            validationErrors,
            rawResponse: adapterResult.rawResponse,
            commandPreview: adapterResult.commandPreview
          });
          continue;
        }
      }

      if (clarificationPolicy.enabled) {
        const boundedQuestions = (plan.clarifyingQuestions ?? []).slice(0, clarificationPolicy.maxQuestions);
        plan.clarifyingQuestions = boundedQuestions;
      } else {
        delete plan.clarifyingQuestions;
      }

      const normalized = stableStringify(plan);
      const normalizedPlanHash = sha256(normalized);
      const planHash = sha256(rawJson);
      plannerAttempts.push({
        id: randomUUID(),
        engine,
        status: "succeeded",
        reasonCode: null,
        detail: null,
        commandPreview: adapterResult.commandPreview,
        rawResponse: adapterResult.rawResponse,
        validationErrors: [],
        createdAt: new Date().toISOString()
      });
      const run: MissionPlannerRun = {
        id: plannerRunId,
        missionId: args.missionId ?? "",
        requestedEngine,
        resolvedEngine: engine,
        status: "succeeded",
        degraded: false,
        reasonCode: null,
        reasonDetail: null,
        planHash,
        normalizedPlanHash,
        commandPreview: adapterResult.commandPreview,
        rawResponse: adapterResult.rawResponse,
        createdAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        validationErrors: [],
        attempts: plannerAttempts
      };
      // Strip test-type steps when testing is disabled (check phases first, fall back to policy)
      const testingDisabled = args.phases
        ? !args.phases.some((p) => p.phaseKey.toLowerCase() === "testing" || p.phaseKey.toLowerCase() === "test")
        : args.policy?.testing?.mode === "none";
      if (testingDisabled && plan.steps) {
        plan.steps = plan.steps.filter(
          (s) => !["test", "validation", "test_review", "milestone"].includes(s.taskType ?? "")
        );
      }

      if (args.memoryService && memoryProjectId.length) {
        const assumptionCandidates = (plan.assumptions ?? [])
          .map((entry) => normalizePlannerMemoryContent(entry, 400))
          .filter((entry) => entry.length > 0)
          .filter((entry, idx, arr) => arr.indexOf(entry) === idx);
        const riskCandidates = assumptionCandidates.length > 0
          ? (plan.risks ?? [])
              .map((entry) => normalizePlannerMemoryContent(`Risk to monitor: ${entry}`, 400))
              .filter((entry) => entry.length > 0)
              .filter((entry, idx, arr) => arr.indexOf(entry) === idx)
          : [];
        const memoryCandidates = [...assumptionCandidates, ...riskCandidates]
          .slice(0, 5);
        if (memoryCandidates.length > 0) {
          try {
            for (const content of memoryCandidates) {
              args.memoryService.addCandidateMemory({
                projectId: memoryProjectId,
                scope: "project",
                category: "decision",
                content,
                importance: "low",
                confidence: 0.5,
                sourceRunId
              });
            }
          } catch (error) {
            args.logger?.warn?.("missions.planner.memory_writeback_failed", {
              plannerRunId,
              projectId: memoryProjectId,
              sourceRunId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      args.logger?.info?.("missions.planner.success", {
        plannerRunId,
        requestedEngine,
        resolvedEngine: engine,
        planSource,
        durationMs: run.durationMs
      });
      return { plan, run };
    } catch (error) {
      if (error instanceof MissionPlanningError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const reasonCode: MissionPlannerReasonCode =
        /timed out|timeout/i.test(message) ? "planner_timeout" : "planner_execution_error";
      plannerAttempts.push({
        id: randomUUID(),
        engine,
        status: "failed",
        reasonCode,
        detail: message,
        commandPreview: null,
        rawResponse: null,
        validationErrors: [],
        createdAt: new Date().toISOString()
      });
      runtimeErrors.push({
        engine,
        reasonCode,
        detail: message
      });
    }
  }

  // Clean up temp file on failure path too
  try { if (fs.existsSync(planOutputPath)) fs.unlinkSync(planOutputPath); } catch { /* best-effort */ }

  // All engines exhausted — throw with summary of failures
  const allValidationErrors = runtimeErrors.flatMap((e) => e.validationErrors ?? []);
  const summaryDetails = runtimeErrors.map((e) => `${e.engine}: ${e.detail}`).join("; ");
  const best = runtimeErrors[runtimeErrors.length - 1];
  throw new MissionPlanningError({
    reasonCode: best?.reasonCode ?? "planner_unavailable",
    reasonDetail: summaryDetails || "All planner engines failed.",
    validationErrors: allValidationErrors,
    attempts: plannerAttempts.length,
    engine: best?.engine ?? null
  });
}
