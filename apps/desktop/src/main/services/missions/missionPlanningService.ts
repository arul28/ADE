import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  MissionExecutorPolicy,
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
  PlannerPlan,
  PlannerStepPlan,
  PlannerTaskType
} from "../../../shared/types";
import { buildDeterministicMissionPlan } from "./missionPlanner";

type MissionPlanningLogger = {
  debug?: (event: string, data?: Record<string, unknown>) => void;
  info?: (event: string, data?: Record<string, unknown>) => void;
  warn?: (event: string, data?: Record<string, unknown>) => void;
  error?: (event: string, data?: Record<string, unknown>) => void;
};

export type MissionPlanningContextBundle = {
  missionProfile?: Record<string, unknown>;
  operationSummary?: Record<string, unknown>;
  docsDigest?: Array<{ path: string; sha256: string; bytes: number }>;
  packDigest?: Record<string, unknown>;
  constraints?: string[];
};

export type MissionPlanningRequest = {
  missionId?: string;
  title: string;
  prompt: string;
  laneId: string | null;
  plannerEngine: MissionPlannerEngine;
  projectRoot: string;
  timeoutMs?: number;
  allowPlanningQuestions?: boolean;
  contextBundle?: MissionPlanningContextBundle;
  logger?: MissionPlanningLogger;
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
  engine: Exclude<MissionPlannerResolvedEngine, "deterministic_fallback">;
};

type PlannerRuntimeError = {
  reasonCode: MissionPlannerReasonCode;
  detail: string;
  validationErrors?: string[];
  engine: MissionPlannerResolvedEngine;
  commandPreview?: string;
  rawResponse?: string | null;
};

const TASK_TYPES: PlannerTaskType[] = ["analysis", "code", "integration", "test", "review", "merge", "deploy", "docs"];
const CONTEXT_PROFILES: PlannerContextProfileRequirement[] = ["deterministic", "deterministic_plus_narrative"];
const CLAIM_LANES: PlannerClaimLane[] = ["analysis", "backend", "frontend", "integration", "conflict"];
const DEFAULT_TIMEOUT_MS = 45_000;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function normalizeText(input: unknown, fallback: string): string {
  const text = String(input ?? "").trim();
  return text.length > 0 ? text : fallback;
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

function commandExists(command: string): boolean {
  try {
    if (process.platform === "win32") {
      const res = spawnSync("where", [command], { encoding: "utf8" });
      return res.status === 0;
    }
    const res = spawnSync("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], { encoding: "utf8" });
    return res.status === 0;
  } catch {
    return false;
  }
}

function plannerSchemaJson(): Record<string, unknown> {
  const stepProperties = {
    stepId: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    taskType: { type: "string", enum: TASK_TYPES },
    executorHint: { type: "string", enum: ["claude", "codex", "gemini", "hosted", "either"] },
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
      missionSummary: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          objective: { type: "string" },
          domain: { type: "string", enum: ["backend", "frontend", "infra", "testing", "docs", "release", "mixed"] },
          complexity: { type: "string", enum: ["low", "medium", "high"] },
          strategy: { type: "string", enum: ["sequential", "parallel-lite", "parallel-first"] },
          parallelismCap: { type: "number" }
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
  allowPlanningQuestions: boolean;
  contextBundle?: MissionPlanningContextBundle;
}): string {
  const docs = (args.contextBundle?.docsDigest ?? [])
    .slice(0, 20)
    .map((entry) => `- ${entry.path} (${entry.bytes} bytes, sha256:${entry.sha256.slice(0, 12)})`)
    .join("\n");
  const constraints = [
    "AI is only for initial planning. Runtime transitions are deterministic.",
    "Return valid JSON only. No markdown. No explanations outside JSON.",
    "Use stable deterministic step IDs suitable for resume/replay.",
    "Prefer minimal safe parallelism unless units are independent.",
    args.allowPlanningQuestions
      ? "Clarifying questions are allowed only in planning output assumptions/risks; runtime must not request extra input unless blocked."
      : "Do not ask follow-up questions. Fill assumptions conservatively and continue."
  ];

  return [
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
    "Context digests:",
    docs || "- none",
    "",
    "Additional context bundle (JSON):",
    stableStringify(args.contextBundle ?? {}),
    "",
    "Output: one JSON object only."
  ].join("\n");
}

async function runProcessWithTimeout(args: {
  command: string;
  commandArgs: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const child = spawn(args.command, args.commandArgs, {
    cwd: args.cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      TERM: "dumb"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    stdout = (stdout + text).slice(-500_000);
  });
  child.stderr?.on("data", (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    stderr = (stderr + text).slice(-300_000);
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }, Math.max(1_000, Math.floor(args.timeoutMs)));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  }).finally(() => {
    clearTimeout(timer);
  });

  return { exitCode, stdout, stderr, timedOut };
}

async function runCodexPlanner(args: {
  cwd: string;
  prompt: string;
  timeoutMs: number;
}): Promise<{ rawResponse: string; commandPreview: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mission-planner-codex-"));
  const schemaPath = path.join(tmpDir, "schema.json");
  const outPath = path.join(tmpDir, "out.txt");
  fs.writeFileSync(schemaPath, JSON.stringify(plannerSchemaJson(), null, 2), "utf8");

  const cliArgs = [
    "exec",
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outPath,
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--cd",
    args.cwd,
    "--skip-git-repo-check",
    args.prompt
  ];

  const commandPreview = ["codex", ...cliArgs.map((entry) => (/\s/.test(entry) ? JSON.stringify(entry) : entry))].join(" ");
  const result = await runProcessWithTimeout({
    command: "codex",
    commandArgs: cliArgs,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs
  });

  try {
    if (result.timedOut) {
      throw new Error("Planner timed out.");
    }
    if (result.exitCode !== 0) {
      throw new Error(`Codex exited with code ${result.exitCode}. ${result.stderr}`.trim());
    }
    const raw = fs.readFileSync(outPath, "utf8");
    if (!raw.trim()) throw new Error("Codex returned empty output.");
    return { rawResponse: raw, commandPreview };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function runClaudePlanner(args: {
  cwd: string;
  prompt: string;
  timeoutMs: number;
}): Promise<{ rawResponse: string; commandPreview: string }> {
  const schemaJson = JSON.stringify(plannerSchemaJson());
  const cliArgs = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    schemaJson,
    "--permission-mode",
    "plan",
    "--no-session-persistence",
    args.prompt
  ];
  const commandPreview = ["claude", ...cliArgs.map((entry) => (/\s/.test(entry) ? JSON.stringify(entry) : entry))].join(" ");
  const result = await runProcessWithTimeout({
    command: "claude",
    commandArgs: cliArgs,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs
  });

  if (result.timedOut) {
    throw new Error("Planner timed out.");
  }
  if (result.exitCode !== 0) {
    throw new Error(`Claude exited with code ${result.exitCode}. ${result.stderr}`.trim());
  }
  if (!result.stdout.trim()) {
    throw new Error("Claude returned empty output.");
  }
  return { rawResponse: result.stdout, commandPreview };
}

function normalizePlannerStep(step: unknown, index: number): PlannerStepPlan {
  const record = isRecord(step) ? step : {};
  return {
    stepId: normalizeStepId(typeof record.stepId === "string" ? record.stepId : null, index),
    name: normalizeText(record.name, `Step ${index + 1}`),
    description: normalizeText(record.description, "Execute mission work for this step."),
    taskType: toEnum(record.taskType, TASK_TYPES, "code"),
    executorHint: toEnum(record.executorHint, ["claude", "codex", "gemini", "hosted", "either"] as const, "either"),
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
        lanes: lanes.length > 0 ? lanes : (["analysis"] as PlannerClaimLane[]),
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
  const stepsRaw = Array.isArray(source.steps) ? source.steps : [];
  const normalizedSteps = stepsRaw.map((step, index) => normalizePlannerStep(step, index));

  const validationErrors: string[] = [];
  if (normalizedSteps.length === 0) validationErrors.push("Plan must include at least one step.");

  const seen = new Set<string>();
  for (const step of normalizedSteps) {
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
      parallelismCap: toPositiveInt(missionSummarySource.parallelismCap, 2, 1, 8)
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
}): PlannerPlan {
  const legacy = buildDeterministicMissionPlan({
    prompt: args.prompt,
    laneId: args.laneId
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

function plannerEngineOrder(requested: MissionPlannerEngine): MissionPlannerResolvedEngine[] {
  if (requested === "claude_cli") return commandExists("claude") ? ["claude_cli"] : [];
  if (requested === "codex_cli") return commandExists("codex") ? ["codex_cli"] : [];
  if (requested === "gemini_cli") return commandExists("gemini") ? ["gemini_cli"] : [];
  if (requested === "hosted_ade") return ["hosted_ade"];

  const ordered: MissionPlannerResolvedEngine[] = [];
  if (commandExists("claude")) ordered.push("claude_cli");
  if (commandExists("codex")) ordered.push("codex_cli");
  if (commandExists("gemini")) ordered.push("gemini_cli");
  ordered.push("hosted_ade");
  return [...new Set(ordered)];
}

async function runPlannerAdapter(args: {
  engine: MissionPlannerResolvedEngine;
  cwd: string;
  prompt: string;
  timeoutMs: number;
}): Promise<PlannerAdapterResult> {
  if (args.engine === "codex_cli") {
    const out = await runCodexPlanner({
      cwd: args.cwd,
      prompt: args.prompt,
      timeoutMs: args.timeoutMs
    });
    return {
      engine: "codex_cli",
      rawResponse: out.rawResponse,
      commandPreview: out.commandPreview
    };
  }
  if (args.engine === "claude_cli") {
    const out = await runClaudePlanner({
      cwd: args.cwd,
      prompt: args.prompt,
      timeoutMs: args.timeoutMs
    });
    return {
      engine: "claude_cli",
      rawResponse: out.rawResponse,
      commandPreview: out.commandPreview
    };
  }
  if (args.engine === "gemini_cli") {
    throw new Error("Gemini CLI planner adapter is unavailable in this build.");
  }
  throw new Error("Hosted ADE planner adapter is unavailable in local-first mode.");
}

function mapHintToExecutor(args: {
  hint: PlannerStepPlan["executorHint"];
  taskType: PlannerTaskType;
  executorPolicy: MissionExecutorPolicy;
}): OrchestratorExecutorKind {
  if (args.executorPolicy === "codex") return "codex";
  if (args.executorPolicy === "claude") return "claude";

  if (args.hint === "claude") return "claude";
  if (args.hint === "codex") return "codex";
  if (args.hint === "gemini") return "codex";
  if (args.taskType === "code" || args.taskType === "integration" || args.taskType === "merge" || args.taskType === "test" || args.taskType === "deploy") {
    return "codex";
  }
  return "claude";
}

function toClaimScopes(step: PlannerStepPlan): Array<{ scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number }> {
  const scopes: Array<{ scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number }> = [];
  for (const lane of step.claimPolicy.lanes) {
    scopes.push({
      scopeKind: "lane",
      scopeValue: `lane:${lane}`,
      ttlMs: step.timeoutMs ?? 60_000
    });
  }
  for (const pattern of step.claimPolicy.filePatterns ?? []) {
    scopes.push({
      scopeKind: "file",
      scopeValue: `pattern:${pattern}`,
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
  executorPolicy: MissionExecutorPolicy;
  degraded: boolean;
  reasonCode: MissionPlannerReasonCode | null;
  validationErrors: string[];
}): MissionPlanStepDraft[] {
  const indexByStepId = new Map<string, number>();
  args.plan.steps.forEach((step, index) => indexByStepId.set(step.stepId, index));
  return args.plan.steps.map((step, index) => {
    const requiresNarrative = step.requiresContextProfiles.includes("deterministic_plus_narrative");
    const retryLimit = Math.max(0, step.maxAttempts - 1);
    const dependencyIndices = step.dependencies
      .map((dep) => indexByStepId.get(dep))
      .filter((value): value is number => typeof value === "number");
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
              : step.taskType === "review" || step.taskType === "docs"
                ? "summary"
                : "implementation",
      metadata: {
        stepKey: step.stepId,
        stepType: step.taskType,
        dependencyStepKeys: step.dependencies,
        dependencyIndices,
        joinPolicy: step.joinPolicy ?? "all_success",
        quorumCount: step.joinQuorum ?? null,
        retryLimit,
        executorKind: mapHintToExecutor({
          hint: step.executorHint,
          taskType: step.taskType,
          executorPolicy: args.executorPolicy
        }),
        doneCriteria: step.outputContract.completionCriteria,
        expectedSignals: step.outputContract.expectedSignals,
        artifactHints: step.artifactHints,
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
          includeFullDocs: step.taskType === "analysis" || step.taskType === "integration" || step.taskType === "review",
          docsMaxBytes: requiresNarrative ? 220_000 : 120_000,
          claimScopes: toClaimScopes(step)
        },
        planStep: step
      }
    };
  });
}

export async function planMissionOnce(args: MissionPlanningRequest): Promise<MissionPlanningResult> {
  const startedAt = Date.now();
  const plannerRunId = randomUUID();
  const timeoutMs = Math.max(5_000, Math.min(180_000, Math.floor(args.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
  const requestedEngine: MissionPlannerEngine = args.plannerEngine ?? "auto";
  const order = plannerEngineOrder(requestedEngine);
  const plannerAttempts: MissionPlannerAttempt[] = [];

  const fallback = (
    reasonCode: MissionPlannerReasonCode,
    reasonDetail: string,
    errorDetails: string[] = [],
    commandPreview: string | null = null
  ): MissionPlanningResult => {
    const plan = buildDeterministicPlannerPlan({
      title: args.title,
      prompt: args.prompt,
      laneId: args.laneId
    });
    const normalizedPlanHash = sha256(stableStringify(plan));
    const run: MissionPlannerRun = {
      id: plannerRunId,
      missionId: args.missionId ?? "",
      requestedEngine,
      resolvedEngine: "deterministic_fallback",
      status: "fallback",
      degraded: true,
      reasonCode,
      reasonDetail,
      planHash: normalizedPlanHash,
      normalizedPlanHash,
      commandPreview,
      rawResponse: null,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      validationErrors: errorDetails,
      attempts: plannerAttempts
    };
    args.logger?.warn?.("missions.planner.fallback", {
      plannerRunId,
      requestedEngine,
      reasonCode,
      reasonDetail
    });
    return { plan, run };
  };

  const prompt = buildPlannerPrompt({
    prompt: args.prompt,
    title: args.title,
    laneId: args.laneId,
    allowPlanningQuestions: args.allowPlanningQuestions === true,
    contextBundle: args.contextBundle
  });

  const runtimeErrors: PlannerRuntimeError[] = [];
  if (!order.length) {
    return fallback("planner_unavailable", "Selected planner adapter is unavailable on this machine.");
  }
  for (const engine of order) {
    try {
      const adapterResult = await runPlannerAdapter({
        engine,
        cwd: args.projectRoot,
        prompt,
        timeoutMs
      });

      const rawJson = extractFirstJsonObject(adapterResult.rawResponse);
      if (!rawJson) {
        plannerAttempts.push({
          id: randomUUID(),
          engine,
          status: "failed",
          reasonCode: "planner_parse_error",
          detail: "Planner output did not contain a JSON object.",
          commandPreview: adapterResult.commandPreview,
          rawResponse: adapterResult.rawResponse,
          validationErrors: [],
          createdAt: new Date().toISOString()
        });
        runtimeErrors.push({
          engine,
          reasonCode: "planner_parse_error",
          detail: "Planner output did not contain a JSON object.",
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

      const { plan, validationErrors } = validateAndCanonicalizePlannerPlan(parsed);
      if (validationErrors.length > 0) {
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
      args.logger?.info?.("missions.planner.success", {
        plannerRunId,
        requestedEngine,
        resolvedEngine: engine,
        durationMs: run.durationMs
      });
      return { plan, run };
    } catch (error) {
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

  if (runtimeErrors.length === 0) {
    return fallback("planner_unavailable", "No planner adapter was available.");
  }
  const best = runtimeErrors[runtimeErrors.length - 1]!;
  return fallback(best.reasonCode, best.detail, best.validationErrors ?? [], best.commandPreview ?? null);
}
