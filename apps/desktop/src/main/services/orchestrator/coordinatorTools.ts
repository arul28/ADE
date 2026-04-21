// ---------------------------------------------------------------------------
// Coordinator Tool Set — AI-first tools for the orchestrator brain.
// Each tool is a thin wrapper around persistence + worker spawning.
// The AI decides everything; tools just execute its decisions.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { createOrchestratorService } from "./orchestratorService";
import type {
  DelegationContract,
  DelegationIntent,
  DelegationMode,
  MissionBudgetSnapshot,
  MissionBudgetHardCapStatus,
  MissionStateDecision,
  MissionStateDocumentPatch,
  MissionStateIssue,
  MissionStateProgress,
  MissionStateStepOutcome,
  MissionStateStepOutcomePartial,
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorAttempt,
  DagMutationEvent,
  TeamRuntimeConfig,
  RoleDefinition,
  WorkerStatusReport,
  WorkerResultReport,
  ValidationContract,
  ValidationResultReport,
  PhaseCard,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createMissionService } from "../missions/missionService";
import {
  asRecord,
  filterExecutionSteps,
  nowIso,
  TERMINAL_STEP_STATUSES,
} from "./orchestratorContext";
import { readMissionStateDocument, updateMissionStateDocument } from "./missionStateDoc";
import { escapeRegExp, resolvePathWithinRoot } from "../shared/utils";
import { normalizeAgentRuntimeFlags } from "./teamRuntimeConfig";
import { registerTeamMember } from "./teamRuntimeState";
import type { createMemoryService } from "../memory/memoryService";
import {
  classifyWorkerExecutionPath,
  resolveModelDescriptor,
  resolveProviderGroupForModel,
} from "../../../shared/modelRegistry";
import {
  checkCoordinatorToolPermission,
  createDelegationContract,
  createDelegationScope,
  extractActiveDelegationContracts,
  hasConflictingDelegationContract,
  updateDelegationContract,
} from "./delegationContracts";

/** Timeout for autopilot agent startup (Promise.race guard). */
const AUTOPILOT_START_TIMEOUT_MS = 15_000;

const VALIDATION_CONTRACT_SCHEMA = z
  .object({
    level: z.enum(["step", "milestone", "mission"]),
    tier: z.enum(["self", "dedicated"]),
    required: z.boolean(),
    criteria: z.string(),
    evidence: z.array(z.string()).default([]),
    maxRetries: z.number().int().min(0).max(10).default(1),
  })
  .optional();

const STEP_OUTCOME_SCHEMA = z.object({
  stepKey: z.string(),
  stepName: z.string(),
  phase: z.string(),
  status: z.enum(["succeeded", "failed", "skipped", "in_progress"]),
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  testsRun: z
    .object({
      passed: z.number().int().min(0),
      failed: z.number().int().min(0),
      skipped: z.number().int().min(0),
    })
    .optional(),
  validation: z
    .object({
      verdict: z.enum(["pass", "fail"]).nullable(),
      findings: z.array(z.string()).default([]),
    })
    .optional(),
  warnings: z.array(z.string()).default([]),
  completedAt: z.string().nullable(),
});

const STEP_OUTCOME_PARTIAL_SCHEMA = z.object({
  stepName: z.string().optional(),
  phase: z.string().optional(),
  status: z.enum(["succeeded", "failed", "skipped", "in_progress"]).optional(),
  summary: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  testsRun: z
    .object({
      passed: z.number().int().min(0).optional(),
      failed: z.number().int().min(0).optional(),
      skipped: z.number().int().min(0).optional(),
    })
    .optional(),
  validation: z
    .object({
      verdict: z.enum(["pass", "fail"]).nullable().optional(),
      findings: z.array(z.string()).optional(),
    })
    .optional(),
  warnings: z.array(z.string()).optional(),
  completedAt: z.string().nullable().optional(),
});

const RUNNING_WORKER_OUTPUT_RECHECK_COOLDOWN_MS = 15_000;

const DECISION_SCHEMA = z.object({
  timestamp: z.string(),
  decision: z.string(),
  rationale: z.string(),
  context: z.string(),
});

const ISSUE_SCHEMA = z.object({
  id: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  description: z.string(),
  affectedSteps: z.array(z.string()).default([]),
  status: z.enum(["open", "mitigated", "resolved"]),
});

const PROGRESS_PARTIAL_SCHEMA = z.object({
  currentPhase: z.string().optional(),
  completedSteps: z.number().int().min(0).optional(),
  totalSteps: z.number().int().min(0).optional(),
  activeWorkers: z.array(z.string()).optional(),
  blockedSteps: z.array(z.string()).optional(),
  failedSteps: z.array(z.string()).optional(),
});

export const COORDINATOR_TOOL_NAMES = [
  "spawn_worker",
  "insert_milestone",
  "request_specialist",
  "delegate_to_subagent",
  "delegate_parallel",
  "stop_worker",
  "send_message",
  "message_worker",
  "broadcast",
  "get_worker_output",
  "list_workers",
  "report_status",
  "reflection_add",
  "report_result",
  "report_validation",
  "read_mission_status",
  "read_mission_state",
  "update_mission_state",
  "memory_search",
  "memory_add",
  "revise_plan",
  "update_tool_profiles",
  "transfer_lane",
  "provision_lane",
  "set_current_phase",
  "create_task",
  "update_task",
  "assign_task",
  "list_tasks",
  "skip_step",
  "mark_step_complete",
  "mark_step_failed",
  "retry_step",
  "complete_mission",
  "fail_mission",
  "get_budget_status",
  "ask_user",
  "request_user_input",
  "read_file",
  "read_step_output",
  "search_files",
  "get_project_context",
  "check_finalization_status",
] as const;

const COORDINATOR_OBSERVATION_TOOL_NAMES = [
  "get_mission",
  "get_run_graph",
  "get_step_output",
  "get_worker_states",
  "get_timeline",
  "get_final_diff",
  "stream_events",
] as const;

export type PlannerLaunchFailureCategory =
  | "run_context_bug"
  | "provider_unreachable"
  | "permission_denied"
  | "tool_schema_error"
  | "unknown";

export type PlannerLaunchFailureClassification = {
  category: PlannerLaunchFailureCategory;
  interventionType: "provider_unreachable" | "policy_block" | "unrecoverable_error" | "failed_step";
  reasonCode: string;
  retryable: boolean;
  recoveryOptions: Array<"retry" | "switch_to_fallback_model" | "cancel_run">;
};

export function classifyPlannerLaunchFailure(error: unknown): PlannerLaunchFailureClassification {
  const message = typeof error === "string"
    ? error.trim()
    : error instanceof Error
      ? error.message.trim()
      : String(error ?? "").trim();
  const normalized = message.toLowerCase();

  if (
    normalized.includes("run not found")
    || normalized.includes("mission not found")
    || normalized.includes("project not found")
    || normalized.includes("caller context")
    || normalized.includes("missing run context")
  ) {
    return {
      category: "run_context_bug",
      interventionType: "unrecoverable_error",
      reasonCode: "planner_launch_run_context_bug",
      retryable: false,
      recoveryOptions: ["cancel_run"],
    };
  }

  if (
    normalized.includes("requires approval")
    || normalized.includes("permission denied")
    || normalized.includes("policy block")
    || normalized.includes("not allowed")
    || normalized.includes("approval denied")
  ) {
    return {
      category: "permission_denied",
      interventionType: "policy_block",
      reasonCode: "planner_launch_permission_denied",
      retryable: false,
      recoveryOptions: ["retry", "cancel_run"],
    };
  }

  if (
    normalized.includes("inputvalidationerror")
    || normalized.includes("invalid input")
    || normalized.includes("unexpected command")
    || normalized.includes("schema")
    || normalized.includes("validation error")
  ) {
    return {
      category: "tool_schema_error",
      interventionType: "failed_step",
      reasonCode: "planner_launch_tool_schema_error",
      retryable: false,
      recoveryOptions: ["retry", "cancel_run"],
    };
  }

  if (
    normalized.includes("rate limit")
    || normalized.includes("timed out")
    || normalized.includes("timeout")
    || normalized.includes("temporarily unavailable")
    || normalized.includes("connection refused")
    || normalized.includes("network")
    || normalized.includes("provider")
    || normalized.includes("model")
    || normalized.includes("api key")
    || normalized.includes("authentication")
    || normalized.includes("unauthorized")
  ) {
    return {
      category: "provider_unreachable",
      interventionType: "provider_unreachable",
      reasonCode: "planner_launch_provider_unreachable",
      retryable: true,
      recoveryOptions: ["retry", "switch_to_fallback_model", "cancel_run"],
    };
  }

  return {
    category: "unknown",
    interventionType: "failed_step",
    reasonCode: "planner_launch_unknown_failure",
    retryable: false,
    recoveryOptions: ["retry", "cancel_run"],
  };
}

export type CoordinatorWorkerDeliveryStatus =
  | { ok: true; delivered: true; method: "send" | "steer" }
  | { ok: true; delivered: false; reason: "worker_busy_steered"; method: "steer" }
  | { ok: false; delivered: false; reason: "no_active_session" | "delivery_failed"; error?: string };

export type CoordinatorSendWorkerMessageFn = (args: {
  sessionId: string;
  text: string;
  priority?: "normal" | "urgent";
}) => Promise<CoordinatorWorkerDeliveryStatus>;

export type CoordinatorExecutableTool = {
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

function defineCoordinatorTool<TSchema extends z.ZodTypeAny>(definition: {
  description: string;
  inputSchema: TSchema;
  execute: (args: z.infer<TSchema>) => Promise<unknown>;
}): CoordinatorExecutableTool {
  return {
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: async (args: Record<string, unknown>) => await definition.execute(args as z.infer<TSchema>),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveStep(
  graph: OrchestratorRunGraph,
  stepRef: string,
): OrchestratorStep | null {
  const normalizedRef = normalizeText(stepRef);
  if (!normalizedRef.length) return null;
  return graph.steps.find((s) => s.stepKey === normalizedRef || s.id === normalizedRef) ?? null;
}

function findRunningAttempt(
  graph: OrchestratorRunGraph,
  stepId: string,
): OrchestratorAttempt | null {
  return (
    graph.attempts.find(
      (a) => a.stepId === stepId && a.status === "running",
    ) ?? null
  );
}

function resolveCurrentPhase(graph: OrchestratorRunGraph): string {
  const runMeta = asRecord(graph.run.metadata);
  const phaseRuntime = asRecord(runMeta?.phaseRuntime);
  const phaseName = typeof phaseRuntime?.currentPhaseName === "string" ? phaseRuntime.currentPhaseName.trim() : "";
  if (phaseName.length > 0) return phaseName;
  const phaseKey = typeof phaseRuntime?.currentPhaseKey === "string" ? phaseRuntime.currentPhaseKey.trim() : "";
  if (phaseKey.length > 0) return phaseKey;
  const relevantSteps = filterExecutionSteps(graph.steps);
  const activeStep = relevantSteps.find((step) => !TERMINAL_STEP_STATUSES.has(step.status)) ?? null;
  const stepMeta = asRecord(activeStep?.metadata);
  const fromStepName = typeof stepMeta?.phaseName === "string" ? stepMeta.phaseName.trim() : "";
  if (fromStepName.length > 0) return fromStepName;
  const fromStepKey = typeof stepMeta?.phaseKey === "string" ? stepMeta.phaseKey.trim() : "";
  if (fromStepKey.length > 0) return fromStepKey;
  return "unknown";
}

function buildMissionStateProgress(graph: OrchestratorRunGraph): MissionStateProgress {
  const relevantSteps = filterExecutionSteps(graph.steps);
  const completedSteps = relevantSteps.filter((step) => TERMINAL_STEP_STATUSES.has(step.status)).length;
  return {
    currentPhase: resolveCurrentPhase(graph),
    completedSteps,
    totalSteps: relevantSteps.length,
    activeWorkers: relevantSteps.filter((step) => step.status === "running").map((step) => step.stepKey),
    blockedSteps: relevantSteps.filter((step) => step.status === "blocked").map((step) => step.stepKey),
    failedSteps: relevantSteps.filter((step) => step.status === "failed").map((step) => step.stepKey),
  };
}

function resolveDependencyStepKeys(graph: OrchestratorRunGraph, step: OrchestratorStep): string[] {
  return step.dependencyStepIds
    .map((depId) => graph.steps.find((candidate) => candidate.id === depId)?.stepKey ?? "")
    .filter((depKey): depKey is string => depKey.length > 0);
}

function dedupeKeys(keys: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(keys)) return [];
  return [
    ...new Set(
      keys
        .map((key) => String(key ?? "").trim())
        .filter((key) => key.length > 0),
    ),
  ];
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDependencyReferences(args: {
  graph: OrchestratorRunGraph;
  refs: readonly unknown[] | null | undefined;
  label: string;
  additionalKnownKeys?: ReadonlySet<string>;
}): string[] {
  const normalizedRefs = dedupeKeys(args.refs);
  const normalizedKeys: string[] = [];
  const unknownRefs: string[] = [];
  for (const ref of normalizedRefs) {
    const resolvedStep = resolveStep(args.graph, ref);
    if (resolvedStep) {
      normalizedKeys.push(resolvedStep.stepKey);
      continue;
    }
    if (args.additionalKnownKeys?.has(ref)) {
      normalizedKeys.push(ref);
      continue;
    }
    unknownRefs.push(ref);
  }
  if (unknownRefs.length > 0) {
    throw new Error(`${args.label} references unknown dependency keys: ${unknownRefs.join(", ")}`);
  }
  return dedupeKeys(normalizedKeys);
}

function isTaskShellStep(step: OrchestratorStep | null | undefined): boolean {
  const metadata = asRecord(step?.metadata) ?? {};
  return metadata.isTask === true;
}

function resolveExecutableDependencyKeys(graph: OrchestratorRunGraph, dependencyKeys: string[]): string[] {
  const visited = new Set<string>();
  const resolved: string[] = [];

  const visit = (stepKey: string) => {
    const normalizedKey = stepKey.trim();
    if (!normalizedKey || visited.has(normalizedKey)) return;
    visited.add(normalizedKey);

    const step = resolveStep(graph, normalizedKey);
    if (!step) {
      resolved.push(normalizedKey);
      return;
    }
    if (!isTaskShellStep(step)) {
      resolved.push(step.stepKey);
      return;
    }

    const meta = asRecord(step.metadata) ?? {};
    const assignedTo = typeof meta.assignedTo === "string" ? meta.assignedTo.trim() : "";
    if (assignedTo.length > 0) {
      visit(assignedTo);
      return;
    }

    for (const dependencyKey of resolveDependencyStepKeys(graph, step)) {
      visit(dependencyKey);
    }
  };

  for (const dependencyKey of dependencyKeys) {
    visit(dependencyKey);
  }

  return dedupeKeys(resolved);
}

function resolveTeamRuntimeConfig(graph: OrchestratorRunGraph): TeamRuntimeConfig | null {
  const runMeta = asRecord(graph.run.metadata);
  const teamRuntime = asRecord(runMeta?.teamRuntime);
  if (!teamRuntime || teamRuntime.enabled !== true) return null;
  return {
    enabled: true,
    targetProvider:
      teamRuntime.targetProvider === "claude" ||
      teamRuntime.targetProvider === "codex" ||
      teamRuntime.targetProvider === "auto"
        ? teamRuntime.targetProvider
        : "auto",
    teammateCount: Number.isFinite(Number(teamRuntime.teammateCount))
      ? Math.max(0, Math.min(20, Math.floor(Number(teamRuntime.teammateCount))))
      : 2,
    ...normalizeAgentRuntimeFlags(teamRuntime),
    template: teamRuntime.template as TeamRuntimeConfig["template"],
    toolProfiles: teamRuntime.toolProfiles as TeamRuntimeConfig["toolProfiles"],
    policyOverrides: teamRuntime.policyOverrides as TeamRuntimeConfig["policyOverrides"]
  };
}

function resolveRoleDefinition(teamRuntime: TeamRuntimeConfig | null, roleName: string): RoleDefinition | null {
  if (!teamRuntime?.template?.roles?.length) return null;
  const normalized = roleName.trim().toLowerCase();
  if (!normalized.length) return null;
  const byName = teamRuntime.template.roles.find((role) => role.name.trim().toLowerCase() === normalized) ?? null;
  if (byName) return byName;
  return (
    teamRuntime.template.roles.find((role) =>
      role.capabilities.some((capability) => capability.trim().toLowerCase() === normalized)
    ) ?? null
  );
}

function resolveRoleToolProfile(teamRuntime: TeamRuntimeConfig | null, roleName: string): Record<string, unknown> | null {
  const normalized = roleName.trim().toLowerCase();
  if (!normalized.length) return null;
  if (teamRuntime?.toolProfiles) {
    for (const [key, profile] of Object.entries(teamRuntime.toolProfiles)) {
      if (key.trim().toLowerCase() === normalized) {
        return profile as unknown as Record<string, unknown>;
      }
    }
  }
  const roleDef = resolveRoleDefinition(teamRuntime, normalized);
  return (roleDef?.toolProfile as unknown as Record<string, unknown>) ?? null;
}

function parseValidationContract(value: unknown): ValidationContract | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (
    raw.level !== "step" &&
    raw.level !== "milestone" &&
    raw.level !== "mission"
  ) {
    return null;
  }
  if (
    raw.tier !== "self" &&
    raw.tier !== "dedicated"
  ) {
    return null;
  }
  const criteria = typeof raw.criteria === "string" ? raw.criteria.trim() : "";
  if (!criteria.length) return null;
  return {
    level: raw.level,
    tier: raw.tier,
    required: raw.required !== false,
    criteria,
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
      : [],
    maxRetries: Number.isFinite(Number(raw.maxRetries))
      ? Math.max(0, Math.min(10, Math.floor(Number(raw.maxRetries))))
      : 1
  };
}

function resolveValidationStateFromStepMetadata(metadata: Record<string, unknown>): "pass" | "fail" | "pending" {
  const stateRaw = typeof metadata.validationState === "string" ? metadata.validationState.trim().toLowerCase() : "";
  if (stateRaw === "pass" || stateRaw === "fail") {
    return stateRaw;
  }
  const lastValidationReport = asRecord(metadata.lastValidationReport);
  const reportVerdict = typeof lastValidationReport?.verdict === "string"
    ? lastValidationReport.verdict.trim().toLowerCase()
    : "";
  if (reportVerdict === "pass" || reportVerdict === "fail") {
    return reportVerdict;
  }
  return "pending";
}

function buildStalenessSignals(graph: OrchestratorRunGraph): string[] {
  const signals: string[] = [];
  const nowMs = Date.now();
  const relevantSteps = filterExecutionSteps(graph.steps);
  const repeatedFailures = relevantSteps.filter((step) => step.status === "failed" && step.retryCount >= step.retryLimit && step.retryLimit > 0);
  if (repeatedFailures.length > 0) {
    signals.push(`${repeatedFailures.length} step(s) exhausted retries`);
  }
  const runningAttempts = graph.attempts.filter((attempt) => attempt.status === "running");
  const staleRunning = runningAttempts.filter((attempt) => nowMs - Date.parse(attempt.createdAt) > 10 * 60_000);
  if (staleRunning.length > 0) {
    signals.push(`${staleRunning.length} running attempt(s) older than 10 minutes`);
  }
  const blockedSteps = relevantSteps.filter((step) => step.status === "blocked");
  if (blockedSteps.length > 0) {
    signals.push(`${blockedSteps.length} blocked step(s)`);
  }
  const validationEscalations = relevantSteps.filter(
    (step) => asRecord(step.metadata)?.validationEscalationRequired === true
  );
  if (validationEscalations.length > 0) {
    signals.push(`${validationEscalations.length} validation gate(s) exceeded retry budget`);
  }
  return signals;
}

function findLatestCompletedAttempt(graph: OrchestratorRunGraph, stepId: string): OrchestratorAttempt | null {
  const attempts = graph.attempts
    .filter((attempt) => attempt.stepId === stepId && attempt.status !== "running")
    .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt));
  return attempts[0] ?? null;
}

function parseValidationFinding(value: unknown): ValidationResultReport["findings"][number] | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const code = typeof raw.code === "string" ? raw.code.trim() : "";
  const severity =
    raw.severity === "low" || raw.severity === "medium" || raw.severity === "high"
      ? raw.severity
      : "medium";
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!code || !message) return null;
  const references = Array.isArray(raw.references)
    ? raw.references
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => entry.length > 0)
    : undefined;
  return {
    code,
    severity,
    message,
    remediation: typeof raw.remediation === "string" && raw.remediation.trim().length > 0 ? raw.remediation.trim() : undefined,
    ...(references && references.length > 0 ? { references } : {})
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCoordinatorToolSet(deps: {
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  missionService: ReturnType<typeof createMissionService>;
  memoryService?: ReturnType<typeof createMemoryService> | null;
  getMissionBudgetStatus?: () => Promise<MissionBudgetSnapshot | null>;
  runId: string;
  missionId: string;
  projectId?: string;
  logger: Logger;
  db: AdeDb;
  projectRoot: string;
  workspaceRoot: string;
  onDagMutation: (event: DagMutationEvent) => void;
  onRunFinalize?: (args: { runId: string; succeeded: boolean; summary?: string; reason?: string }) => void;
  onHardCapTriggered?: (detail: string) => void;
  onBudgetWarning?: (pressure: "warning" | "critical", detail: string) => void;
  sendWorkerMessageToSession?: CoordinatorSendWorkerMessageFn;
  /** Primary mission lane ID — used by provision_lane to branch new lanes. */
  missionLaneId?: string;
  /** Callback to create a new lane branching from the mission's base lane. */
  provisionLane?: (name: string, description?: string) => Promise<{ laneId: string; name: string }>;
}): Record<string, CoordinatorExecutableTool> {
  const {
    orchestratorService,
    missionService,
    getMissionBudgetStatus,
    runId,
    missionId,
    logger,
    db,
    projectRoot,
    workspaceRoot,
    onDagMutation
  } = deps;
  const projectId = typeof deps.projectId === "string" && deps.projectId.trim().length > 0
    ? deps.projectId.trim()
    : null;
  const memoryService = deps.memoryService ?? null;
  const missionLaneId = typeof deps.missionLaneId === "string" && deps.missionLaneId.trim().length > 0
    ? deps.missionLaneId.trim()
    : null;
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedWorkspaceRootReal = fs.existsSync(resolvedWorkspaceRoot)
    ? fs.realpathSync(resolvedWorkspaceRoot)
    : resolvedWorkspaceRoot;
  const resolveWorkspacePath = (candidatePath: string, allowMissing: boolean = false): string | null => {
    try {
      return resolvePathWithinRoot(resolvedWorkspaceRoot, candidatePath, { allowMissing });
    } catch {
      return null;
    }
  };
  const getFsErrorCode = (error: unknown): string | null => {
    if (!error || typeof error !== "object" || !("code" in error)) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  };
  const formatWorkspaceReadError = (kind: "file" | "step output", reference: string, error: unknown): string => {
    const code = getFsErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return `file not found: ${reference}`;
    }
    if (code === "EACCES" || code === "EPERM") {
      return `permission denied: ${reference}`;
    }
    return `failed to read ${kind}: ${reference}`;
  };
  const MAX_CONTENT_SEARCH_PATTERN_LENGTH = 200;
  const filenamePatternToRegExp = (pattern: string): RegExp => {
    const normalized = pattern.replace(/\\/g, "/").trim();
    if (!normalized.length) return /^$/i;
    let source = "^";
    for (let index = 0; index < normalized.length; index += 1) {
      const char = normalized[index]!;
      if (char === "*") {
        const next = normalized[index + 1];
        if (next === "*") {
          if (normalized[index + 2] === "/") {
            source += "(?:.*/)?";
            index += 2;
          } else {
            source += ".*";
            index += 1;
          }
        } else {
          source += "[^/]*";
        }
        continue;
      }
      source += escapeRegExp(char);
    }
    source += "$";
    return new RegExp(source, "i");
  };
  const isUnsafeContentSearchPattern = (pattern: string): boolean => {
    if (pattern.length > MAX_CONTENT_SEARCH_PATTERN_LENGTH) return true;
    return /\\[1-9]/.test(pattern)
      || /\(\?[:!=<]/.test(pattern)
      || /\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)
      || /(?:^|[^\\])(?:\*|\+|\{[^}]+\})(?:\s*)(?:\*|\+|\{[^}]+\})/.test(pattern);
  };
  const compileContentSearchRegex = (pattern: string, explicitRegexMode: boolean = false): RegExp => {
    const normalized = pattern.trim();
    if (!normalized.length) {
      throw new Error("pattern is required");
    }
    if (!explicitRegexMode) {
      return new RegExp(escapeRegExp(normalized), "i");
    }
    try {
      if (isUnsafeContentSearchPattern(normalized)) {
        throw new Error("Unsafe regular expression pattern.");
      }
      return new RegExp(normalized, "i");
    } catch (error) {
      if (error instanceof Error && error.message === "Unsafe regular expression pattern.") {
        throw error;
      }
      throw new Error(`Invalid regular expression pattern: ${normalized}`);
    }
  };

  const normalizeLaneId = (value: string | null | undefined): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  /** Track last emitted budget pressure to avoid spamming soft warnings. */
  let lastEmittedBudgetPressure: "normal" | "warning" | "critical" = "normal";
  const runningWorkerOutputChecks = new Map<string, { checkedAtMs: number; signalFingerprint: string }>();

  /** Shorthand to get a fresh graph snapshot. */
  function graph(): OrchestratorRunGraph {
    return orchestratorService.getRunGraph({ runId });
  }

  /** Register a spawned worker/sub-agent as a team member for tracking. */
  function trackTeamMember(args: {
    workerId: string;
    provider: string;
    modelId: string;
    role: string | null;
    source: "ade-worker" | "ade-subagent";
    isSubAgent?: boolean;
    parentWorkerId?: string | null;
  }): void {
    try {
      const now = nowIso();
      registerTeamMember(
        { db, logger } as import("./orchestratorContext").OrchestratorContext,
        {
          id: args.workerId,
          runId,
          missionId,
          provider: args.provider,
          model: args.modelId,
          role: args.isSubAgent ? "teammate" : "worker",
          source: args.source,
          parentWorkerId: args.parentWorkerId ?? null,
          sessionId: null,
          status: "spawning",
          claimedTaskIds: [],
          metadata: {
            source: args.source,
            ...(args.role ? { teamRole: args.role } : {}),
            ...(args.isSubAgent ? { isSubAgent: true } : {}),
            ...(args.parentWorkerId ? { parentWorkerId: args.parentWorkerId } : {}),
          },
          createdAt: now,
          updatedAt: now,
        },
      );
    } catch (err) {
      // Non-critical — team member tracking is best-effort
      logger.debug("coordinator.track_team_member_failed", {
        workerId: args.workerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function resolveMissionGoal(): string {
    const mission = missionService.get(missionId);
    const prompt = typeof mission?.prompt === "string" ? mission.prompt.trim() : "";
    if (prompt.length > 0) return prompt;
    const title = typeof mission?.title === "string" ? mission.title.trim() : "";
    if (title.length > 0) return title;
    return `Mission ${missionId}`;
  }

  function mapMemoryCategoryToFactType(category: "fact" | "convention" | "pattern" | "decision" | "gotcha" | "preference") {
    switch (category) {
      case "pattern":
        return "api_pattern" as const;
      case "gotcha":
        return "gotcha" as const;
      case "convention":
      case "preference":
        return "config" as const;
      default:
        return "architectural" as const;
    }
  }

  function resolveMemoryScopeOwnerId(scope: "project" | "agent" | "mission", explicit?: string | null): string | undefined {
    const trimmed = typeof explicit === "string" ? explicit.trim() : "";
    if (trimmed.length > 0) return trimmed;
    if (scope === "agent") return `coordinator:${runId}`;
    if (scope === "mission") return missionId;
    return undefined;
  }

  async function deliverToWorkerSession(
    sessionId: string,
    text: string,
    priority: "normal" | "urgent" = "normal",
  ): Promise<CoordinatorWorkerDeliveryStatus> {
    if (!deps.sendWorkerMessageToSession) {
      return {
        ok: false,
        delivered: false,
        reason: "delivery_failed",
        error: "Worker delivery transport is unavailable."
      };
    }
    try {
      return await deps.sendWorkerMessageToSession({ sessionId, text, priority });
    } catch (error) {
      return {
        ok: false,
        delivered: false,
        reason: "delivery_failed",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Shared budget hard cap check — refuses worker spawning when budget limits are triggered.
   * Returns `{ blocked: false }` if spawning is allowed, or `{ blocked: true, detail, hardCaps }` if blocked.
   */
  async function checkBudgetHardCaps(options?: {
    failClosedOnTelemetryError?: boolean;
    operation?: "spawn_worker" | "request_specialist" | "revise_plan" | "delegate_to_subagent" | "delegate_parallel";
  }): Promise<{
    blocked: boolean;
    detail?: string;
    hardCaps?: MissionBudgetHardCapStatus;
  }> {
    if (!getMissionBudgetStatus) return { blocked: false };
    try {
      const budgetSnap = await getMissionBudgetStatus();
      if (!budgetSnap?.hardCaps) return { blocked: false };
      const caps = budgetSnap.hardCaps;
      const anyTriggered = caps.fiveHourTriggered || caps.weeklyTriggered || caps.apiKeyTriggered;
      if (!anyTriggered) return { blocked: false };
      const reasons: string[] = [];
      if (caps.fiveHourTriggered) {
        const prov = budgetSnap.perProvider.find((p) => {
          const pct = p.fiveHour.usedPct ?? 0;
          return pct >= (caps.fiveHourHardStopPercent ?? 100);
        });
        const provName = prov?.provider ?? "aggregate";
        const usedPct = prov?.fiveHour.usedPct ?? 0;
        reasons.push(`${provName} 5hr usage at ${Math.round(usedPct)}% (hard cap: ${caps.fiveHourHardStopPercent ?? 100}%)`);
      }
      if (caps.weeklyTriggered) {
        const prov = budgetSnap.perProvider.find((p) => {
          const pct = p.weekly.usedPct ?? 0;
          return pct >= (caps.weeklyHardStopPercent ?? 100);
        });
        const provName = prov?.provider ?? "aggregate";
        const usedPct = prov?.weekly.usedPct ?? 0;
        reasons.push(`${provName} weekly usage at ${Math.round(usedPct)}% (hard cap: ${caps.weeklyHardStopPercent ?? 100}%)`);
      }
      if (caps.apiKeyTriggered) {
        reasons.push(`API key spend $${caps.apiKeySpentUsd.toFixed(2)} (hard cap: $${caps.apiKeyMaxSpendUsd?.toFixed(2) ?? "?"} )`);
      }
      const detail = reasons.join("; ");
      if (deps.onHardCapTriggered) {
        deps.onHardCapTriggered(detail);
      }
      return { blocked: true, detail, hardCaps: caps };
    } catch (budgetErr) {
      const errorMessage = budgetErr instanceof Error ? budgetErr.message : String(budgetErr);
      logger.debug("coordinator.budget_hard_cap_check_failed", {
        error: errorMessage,
        failClosedOnTelemetryError: options?.failClosedOnTelemetryError === true,
        operation: options?.operation ?? null,
      });
      if (options?.failClosedOnTelemetryError) {
        const operation = options.operation ?? "high_cost_operation";
        const detail = `Budget telemetry unavailable while evaluating ${operation}: ${errorMessage}`;
        if (deps.onHardCapTriggered) {
          deps.onHardCapTriggered(detail);
        }
        return { blocked: true, detail };
      }
      return { blocked: false };
    }
  }

  type PhaseModelResolution =
    | {
        ok: true;
        modelId: string;
      }
    | {
        ok: false;
        error: string;
      };

  function resolveModelFromPhaseModel(g: OrchestratorRunGraph): PhaseModelResolution {
    const phaseContext = resolveConfiguredPhaseContext(g);
    if (!phaseContext.ok) {
      return {
        ok: false,
        error: phaseContext.error,
      };
    }
    const runMeta = asRecord(g.run.metadata);
    const phaseRuntime = asRecord(runMeta?.phaseRuntime);
    const currentPhaseModel = asRecord(phaseRuntime?.currentPhaseModel);
    const modelIdHint = typeof currentPhaseModel?.modelId === "string" ? currentPhaseModel.modelId.trim() : "";
    if (modelIdHint.length > 0) {
      const descriptor = resolveModelDescriptor(modelIdHint);
      if (!descriptor) {
        return {
          ok: false,
          error: `Current phase model '${modelIdHint}' is not registered. Select a valid model ID before spawning workers.`
        };
      }
      return { ok: true, modelId: descriptor.id };
    }

    return { ok: false, error: "Current phase does not define modelId. Configure a phase model before spawning workers." };
  }

  type WorkerSpawnPolicyResult =
    | {
        ok: true;
        missionPhases: PhaseCard[];
        currentPhase: PhaseCard | null;
        resolvedModelId: string;
        resolvedProvider: string;
      }
    | {
        ok: false;
        error: string;
        blockedByPhaseOrdering?: boolean;
        blockedByValidationGate?: boolean;
      };

  function authorizeWorkerSpawnPolicy(args: {
    g: OrchestratorRunGraph;
    requestedModelId?: string | null;
  }): WorkerSpawnPolicyResult {
    const missionPhases = resolveMissionPhases(args.g);
    const phaseContext = resolveConfiguredPhaseContext(args.g, missionPhases);
    if (!phaseContext.ok) {
      return { ok: false, error: phaseContext.error };
    }
    if (missionPhases.length > 0) {
      const phaseCheck = validatePhaseOrdering(missionPhases, args.g);
      if (!phaseCheck.valid) {
        return {
          ok: false,
          error: phaseCheck.reason,
          blockedByPhaseOrdering: true,
        };
      }
      const validationGateCheck = validateRequiredValidationGates(missionPhases, args.g);
      if (!validationGateCheck.valid) {
        return {
          ok: false,
          error: validationGateCheck.reason,
          blockedByValidationGate: true,
        };
      }
    }

    const explicitModelId = typeof args.requestedModelId === "string" ? args.requestedModelId.trim() : "";
    let resolvedModelId = explicitModelId;
    if (!resolvedModelId.length) {
      const phaseModelResolution = resolveModelFromPhaseModel(args.g);
      if (!phaseModelResolution.ok) {
        return { ok: false, error: phaseModelResolution.error };
      }
      resolvedModelId = phaseModelResolution.modelId;
    }
    const resolvedDescriptor = resolveModelDescriptor(resolvedModelId);
    if (!resolvedDescriptor) {
      return { ok: false, error: `Model '${resolvedModelId}' is not registered.` };
    }

    const currentPhaseModelId =
      missionPhases.length > 0 && typeof phaseContext.currentPhase?.model?.modelId === "string"
        ? phaseContext.currentPhase.model.modelId.trim()
        : "";
    if (explicitModelId.length > 0 && currentPhaseModelId.length > 0) {
      const currentPhaseDescriptor = resolveModelDescriptor(currentPhaseModelId);
      const normalizedPhaseModelId = currentPhaseDescriptor?.id ?? currentPhaseModelId;
      if (resolvedDescriptor.id !== normalizedPhaseModelId) {
        const phaseLabel = phaseContext.currentPhase?.name;
        return {
          ok: false,
          error:
            `${phaseLabel ? `Current phase "${phaseLabel}"` : "Current phase"} is configured for model "${normalizedPhaseModelId}". ` +
            `Omit modelId to use the phase model, or call set_current_phase before switching models.`
        };
      }
    }

    const resolvedProvider = resolveProviderGroupForModel(resolvedDescriptor);

    return {
      ok: true,
      missionPhases,
      currentPhase: phaseContext.currentPhase,
      resolvedModelId: resolvedDescriptor.id,
      resolvedProvider,
    };
  }

  // ─── Worker Management ────────────────────────────────────────

  const spawnWorkerStep = (args: {
    stepKey?: string | null;
    name: string;
    modelId: string;
    prompt: string;
    dependsOn?: string[] | null;
    requestedDependsOn?: string[] | null;
    inferredDependsOn?: string[] | null;
    roleName?: string | null;
    laneId?: string | null;
    validationContract?: ValidationContract | null;
    specialistRequest?: { requestedBy?: string | null; reason?: string | null } | null;
    replacementForWorkerId?: string | null;
    replacementReason?: string | null;
    delegationContract?: DelegationContract | null;
  }): {
    workerId: string;
    step: OrchestratorStep | null;
    roleName: string | null;
    modelId: string;
    toolProfile: Record<string, unknown> | null;
    reusedExistingStep: boolean;
  } => {
    const g = graph();
    const requestedDependencyStepKeys = normalizeDependencyReferences({
      graph: g,
      refs: args.requestedDependsOn ?? args.dependsOn,
      label: `Worker '${args.name}'`,
    });
    const inferredDependencyStepKeys = normalizeDependencyReferences({
      graph: g,
      refs: args.inferredDependsOn,
      label: `Worker '${args.name}'`,
    });
    const resolvedDependencyStepKeys = normalizeDependencyReferences({
      graph: g,
      refs: args.dependsOn,
      label: `Worker '${args.name}'`,
    });
    const executableDependencyStepKeys = resolveExecutableDependencyKeys(g, resolvedDependencyStepKeys);
    const taskShellDependencyKeys = requestedDependencyStepKeys.filter((dependencyKey) => {
      const dependencyStep = resolveStep(g, dependencyKey);
      return Boolean(dependencyStep && isTaskShellStep(dependencyStep));
    });
    const teamRuntime = resolveTeamRuntimeConfig(g);
    const roleDef = args.roleName ? resolveRoleDefinition(teamRuntime, args.roleName) : null;
    const roleName = roleDef?.name ?? (args.roleName?.trim().length ? args.roleName.trim() : null);
    const toolProfile = roleName ? resolveRoleToolProfile(teamRuntime, roleName) : null;
    const resolvedModelId = args.modelId.trim();
    if (!resolvedModelId.length) {
      throw new Error("spawnWorkerStep requires a non-empty modelId.");
    }
    const resolvedDescriptor = resolveModelDescriptor(resolvedModelId);
    const resolvedProvider = resolvedDescriptor
      ? resolveProviderGroupForModel(resolvedDescriptor)
      : "unknown";
    const replacementForWorkerId = args.replacementForWorkerId?.trim() || null;
    const replacementSourceStep = replacementForWorkerId ? resolveStep(g, replacementForWorkerId) : null;
    if (replacementForWorkerId && !replacementSourceStep) {
      throw new Error(`Replacement source worker not found: ${replacementForWorkerId}`);
    }
    const replacementSourceMeta = asRecord(replacementSourceStep?.metadata) ?? {};
    const replacementStatusReport = asRecord(replacementSourceMeta.lastStatusReport) ?? {};
    const replacementResultReport = asRecord(replacementSourceMeta.lastResultReport) ?? {};
    const replacementValidationReport = asRecord(replacementSourceMeta.lastValidationReport);
    const replacementAttempt = replacementSourceStep ? findLatestCompletedAttempt(g, replacementSourceStep.id) : null;
    const inheritedLaneId = normalizeLaneId(replacementSourceStep?.laneId ?? null);
    const replacementReason = args.replacementReason?.trim() || "Replacement worker requested by coordinator.";
    const replacementSourceSummary =
      (typeof replacementResultReport.summary === "string" && replacementResultReport.summary.trim().length > 0
        ? replacementResultReport.summary.trim()
        : replacementAttempt?.resultEnvelope?.summary) ?? null;
    const replacementChangedFiles = Array.isArray(replacementResultReport.filesChanged)
      ? replacementResultReport.filesChanged
          .map((entry) => String(entry ?? "").trim())
          .filter((entry) => entry.length > 0)
      : [];
    const replacementFailedChecks =
      replacementResultReport.testsRun &&
      typeof replacementResultReport.testsRun === "object" &&
      Number((replacementResultReport.testsRun as Record<string, unknown>).failed ?? 0) > 0
        ? [
            {
              failed: Number((replacementResultReport.testsRun as Record<string, unknown>).failed ?? 0),
              raw:
                typeof (replacementResultReport.testsRun as Record<string, unknown>).raw === "string"
                  ? (replacementResultReport.testsRun as Record<string, unknown>).raw
                  : null
            }
          ]
        : [];
    const explicitLaneId = normalizeLaneId(args.laneId ?? null);
    const effectiveLaneId = explicitLaneId ?? inheritedLaneId ?? missionLaneId;
    const maxIndex = g.steps.reduce(
      (max, s) => Math.max(max, s.stepIndex),
      -1,
    );
    const explicitStepKey = args.stepKey?.trim() ?? "";
    const stepKey =
      explicitStepKey.length > 0
        ? explicitStepKey
        : `worker_${args.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}`;
    const missionPhases = resolveMissionPhases();
    const phaseMetadata = buildPhaseMetadataForNewStep(g, missionPhases);
    const reusableTaskShell =
      !replacementSourceStep
        ? (() => {
            const candidate = resolveStep(g, stepKey);
            if (!candidate) return null;
            if (!isTaskShellStep(candidate)) return null;
            if (TERMINAL_STEP_STATUSES.has(candidate.status)) return null;
            return candidate;
          })()
        : null;
    if (reusableTaskShell) {
      let preparedStep = orchestratorService.updateStepMetadata({
        runId,
        stepId: reusableTaskShell.id,
        metadata: {
          ...phaseMetadata,
          executorKind: resolvedProvider,
          instructions: args.prompt,
          workerName: args.name,
          requestedDependencyStepKeys,
          ...(inferredDependencyStepKeys.length > 0 ? { inferredDependencyStepKeys } : {}),
          planningTaskDependencies: taskShellDependencyKeys,
          spawnedByCoordinator: true,
          modelId: resolvedModelId,
          modelProviderHint: resolvedProvider,
          modelExecutionPath: resolvedDescriptor ? classifyWorkerExecutionPath(resolvedDescriptor) : "api",
          role: roleName,
          roleCapabilities: roleDef?.capabilities ?? [],
          toolProfile: toolProfile ?? null,
          isTask: false,
          convertedFromTaskShell: true,
          ...(args.delegationContract ? { delegationContract: args.delegationContract } : {}),
          ...(args.validationContract ? { validationContract: args.validationContract } : {}),
        }
      });
      if ((preparedStep.laneId ?? null) !== (effectiveLaneId ?? null)) {
        preparedStep = orchestratorService.transferStepLane({
          runId,
          stepId: preparedStep.id,
          laneId: effectiveLaneId,
          reason: "Converted task shell into an executable worker step.",
          transferredBy: "coordinator",
        });
      }
      preparedStep = orchestratorService.updateStepDependencies({
        runId,
        stepId: preparedStep.id,
        dependencyStepKeys: executableDependencyStepKeys,
      });
      return {
        workerId: preparedStep.stepKey,
        step: preparedStep,
        roleName,
        modelId: resolvedModelId,
        toolProfile,
        reusedExistingStep: true,
      };
    }
    const created = orchestratorService.addSteps({
      runId,
      steps: [
        {
          stepKey,
          title: args.name,
          stepIndex: maxIndex + 1,
          laneId: effectiveLaneId,
          dependencyStepKeys: executableDependencyStepKeys,
          executorKind: resolvedProvider,
          metadata: {
            ...phaseMetadata,
            instructions: args.prompt,
            workerName: args.name,
            requestedDependencyStepKeys,
            ...(inferredDependencyStepKeys.length > 0 ? { inferredDependencyStepKeys } : {}),
            planningTaskDependencies: taskShellDependencyKeys,
            spawnedByCoordinator: true,
            modelId: resolvedModelId,
            modelProviderHint: resolvedProvider,
            modelExecutionPath: resolvedDescriptor ? classifyWorkerExecutionPath(resolvedDescriptor) : "api",
            role: roleName,
            roleCapabilities: roleDef?.capabilities ?? [],
            toolProfile: toolProfile ?? null,
            ...(args.delegationContract ? { delegationContract: args.delegationContract } : {}),
            ...(args.validationContract ? { validationContract: args.validationContract } : {}),
            ...(replacementSourceStep
              ? {
                  replacementContext: {
                    replacedWorkerId: replacementSourceStep.stepKey,
                    replacedStepId: replacementSourceStep.id,
                    inheritedLaneId,
                    reason: replacementReason,
                    sourceSummary: replacementSourceSummary,
                    changedFiles: replacementChangedFiles,
                    failedChecks: replacementFailedChecks,
                    priorValidatorFeedback: replacementValidationReport ?? null
                  }
                }
              : {}),
            ...(args.specialistRequest
              ? {
                  specialistRequest: {
                    requestedBy: args.specialistRequest.requestedBy ?? null,
                    reason: args.specialistRequest.reason ?? null
                  }
                }
              : {})
          },
        },
      ],
    });
    if (replacementSourceStep && created[0]) {
      orchestratorService.createHandoff({
        missionId,
        runId,
        stepId: created[0].id,
        handoffType: "worker_replacement_handoff",
        producer: "coordinator",
        payload: {
          replacedWorkerId: replacementSourceStep.stepKey,
          replacedStepId: replacementSourceStep.id,
          replacementWorkerId: created[0].stepKey,
          replacementStepId: created[0].id,
          laneId: effectiveLaneId,
          reason: replacementReason,
          sourceSummary: replacementSourceSummary,
          changedFiles: replacementChangedFiles,
          failedChecks: replacementFailedChecks,
          priorValidatorFeedback: replacementValidationReport ?? null,
          priorStatusReport: replacementStatusReport ?? null
        },
      });
    }
    return {
      workerId: stepKey,
      step: created[0] ?? null,
      roleName,
      modelId: resolvedModelId,
      toolProfile,
      reusedExistingStep: false,
    };
  };

  // ─── Phase Ordering Helpers ─────────────────────────────────────

  /**
   * Resolve mission phase cards from the mission's metadata in the DB.
   * Returns an empty array when no phases are configured.
   */
  function resolveMissionPhases(g?: OrchestratorRunGraph | null): PhaseCard[] {
    try {
      const runMeta = g ? asRecord(g.run.metadata) : null;
      const runPhaseConfig = asRecord(runMeta?.phaseConfiguration);
      if (runPhaseConfig) {
        if (Array.isArray(runPhaseConfig.selectedPhases)) return runPhaseConfig.selectedPhases as PhaseCard[];
        if (Array.isArray(runPhaseConfig.phases)) return runPhaseConfig.phases as PhaseCard[];
      }
      if (Array.isArray(runMeta?.phaseOverride)) return runMeta.phaseOverride as PhaseCard[];
      const runPhaseOverride = asRecord(runMeta?.phaseOverride);
      if (runPhaseOverride) {
        if (Array.isArray(runPhaseOverride.selectedPhases)) return runPhaseOverride.selectedPhases as PhaseCard[];
        if (Array.isArray(runPhaseOverride.phases)) return runPhaseOverride.phases as PhaseCard[];
      }
      if (Array.isArray(runMeta?.phases)) return runMeta.phases as PhaseCard[];

      const missionRow = db.get<{ metadata_json: string | null }>(
        `select metadata_json from missions where id = ? limit 1`,
        [missionId],
      );
      if (!missionRow?.metadata_json) return [];
      const meta = JSON.parse(missionRow.metadata_json);
      const raw = asRecord(meta);
      if (!raw) return [];
      const phaseConfig = asRecord(raw.phaseConfiguration);
      if (phaseConfig) {
        if (Array.isArray(phaseConfig.selectedPhases)) return phaseConfig.selectedPhases as PhaseCard[];
        if (Array.isArray(phaseConfig.phases)) return phaseConfig.phases as PhaseCard[];
      }
      if (Array.isArray(raw.phaseOverride)) return raw.phaseOverride as PhaseCard[];
      if (Array.isArray(raw.phases)) return raw.phases as PhaseCard[];
      return [];
    } catch {
      return [];
    }
  }

  type PhaseContextResolution =
    | {
        ok: true;
        phases: PhaseCard[];
        currentPhase: PhaseCard | null;
        phaseRuntime: Record<string, unknown> | null;
      }
    | {
        ok: false;
        phases: PhaseCard[];
        error: string;
      };

  function resolveConfiguredPhaseContext(
    g: OrchestratorRunGraph,
    phasesInput?: PhaseCard[],
  ): PhaseContextResolution {
    const phases = [...(phasesInput ?? resolveMissionPhases(g))].sort((a, b) => a.position - b.position);
    const runMeta = asRecord(g.run.metadata);
    const phaseRuntime = asRecord(runMeta?.phaseRuntime);
    if (phases.length === 0) {
      return {
        ok: true,
        phases,
        currentPhase: null,
        phaseRuntime,
      };
    }
    if (!phaseRuntime) {
      return {
        ok: false,
        phases,
        error:
          "Mission phases are configured, but phase runtime is missing. Call set_current_phase before spawning or delegating workers."
      };
    }
    const runtimePhaseKey = typeof phaseRuntime.currentPhaseKey === "string" ? phaseRuntime.currentPhaseKey.trim() : "";
    const runtimePhaseName = typeof phaseRuntime.currentPhaseName === "string" ? phaseRuntime.currentPhaseName.trim() : "";
    if (!runtimePhaseKey && !runtimePhaseName) {
      return {
        ok: false,
        phases,
        error:
          "Mission phases are configured, but the current phase is unset. Call set_current_phase before spawning or delegating workers."
      };
    }
    const currentPhase = phases.find(
      (phase) => phase.phaseKey === runtimePhaseKey || phase.name === runtimePhaseName,
    );
    if (!currentPhase) {
      const requestedLabel = runtimePhaseName || runtimePhaseKey;
      return {
        ok: false,
        phases,
        error:
          `Current phase "${requestedLabel}" is not present in the configured mission phases. ` +
          "Call set_current_phase with a valid phase before spawning or delegating workers."
      };
    }
    return {
      ok: true,
      phases,
      currentPhase,
      phaseRuntime,
    };
  }

  function validateDelegationPromptForCurrentPhase(args: {
    currentPhaseKey: string;
    workerName: string;
    roleName: string | null;
    prompt: string;
    validationContract: ValidationContract | null;
    validationHeuristics?: "strict" | "prompt_only";
  }): { ok: true } | { ok: false; error: string } {
    if (args.currentPhaseKey === "planning" && promptContainsImplementationDirectives(args.prompt)) {
      return {
        ok: false,
        error:
          'Current phase is "planning". Planning workers must stay read-only and produce research/plan output only. ' +
          'This prompt contains implementation or commit instructions. Use a research prompt now, then call set_current_phase with phaseKey "development" before implementation work.'
      };
    }
    const validationHeuristics = args.validationHeuristics ?? "strict";
    if (
      args.currentPhaseKey !== "validation"
      && looksLikeValidationWorkerRequest({
        name: args.workerName,
        roleName: validationHeuristics === "strict" ? args.roleName : null,
        prompt: args.prompt,
        validationContract: args.validationContract,
        includeNameHeuristics: validationHeuristics === "strict",
      })
    ) {
      return {
        ok: false,
        error:
          'Validation workers can only be spawned during the "validation" phase. ' +
          'Finish the active work, call set_current_phase with phaseKey "validation", and depend on the worker you are validating.'
      };
    }
    return { ok: true };
  }

  function buildDelegationFailurePolicy(args: {
    mode: DelegationMode;
    intent: DelegationIntent;
  }): DelegationContract["failurePolicy"] {
    if (args.intent === "planner") {
      return {
        retryLimit: 1,
        escalation: "intervention",
      };
    }
    if (args.mode === "recovery") {
      return {
        retryLimit: 0,
        escalation: "intervention",
      };
    }
    return {
      retryLimit: 0,
      escalation: "retry",
    };
  }

  function buildCoordinatorDelegationContract(args: {
    graph: OrchestratorRunGraph;
    workerId: string;
    phaseKey: string;
    workerName: string;
    intent: DelegationIntent;
    mode: DelegationMode;
    scopeKind: "phase" | "step" | "worker" | "batch";
    scopeKey: string;
    scopeLabel?: string | null;
    batchId?: string | null;
    parentContractId?: string | null;
    launchState?: DelegationContract["launchState"];
    metadata?: Record<string, unknown> | null;
  }): DelegationContract {
    const currentPhaseLabel =
      args.phaseKey.trim().length > 0
        ? args.phaseKey.trim()
        : resolveCurrentPhase(args.graph);
    return createDelegationContract({
      contractId: randomUUID(),
      runId,
      workerIntent: args.intent,
      mode: args.mode,
      scope: createDelegationScope({
        kind: args.scopeKind,
        key: args.scopeKey,
        label: args.scopeLabel ?? currentPhaseLabel,
      }),
      phaseKey: currentPhaseLabel,
      status: args.intent === "planner" && args.mode === "exclusive" ? "launching" : "active",
      launchState: args.launchState ?? (args.intent === "planner" ? "awaiting_worker_launch" : "waiting_on_worker"),
      activeWorkerIds: [args.workerId],
      launchPolicy: {
        maxLaunchAttempts: args.intent === "planner" ? 2 : 1,
      },
      failurePolicy: buildDelegationFailurePolicy({
        mode: args.mode,
        intent: args.intent,
      }),
      batchId: args.batchId ?? null,
      parentContractId: args.parentContractId ?? null,
      metadata: {
        workerName: args.workerName,
        ...(args.metadata ?? {}),
      },
    });
  }

  function persistDelegationContract(args: {
    contract: DelegationContract;
    stepId: string | null;
    reason: string;
    action: "created" | "updated";
  }): void {
    const detail = {
      source: "coordinator_delegation",
      action: args.action,
      contract: args.contract,
    };
    orchestratorService.appendRuntimeEvent({
      runId,
      stepId: args.stepId,
      eventType: "progress",
      eventKey: `coordinator_delegation:${args.contract.contractId}:${args.action}:${args.contract.status}:${args.contract.updatedAt}`,
      occurredAt: args.contract.updatedAt,
      payload: detail,
    });
    orchestratorService.appendTimelineEvent({
      runId,
      stepId: args.stepId,
      eventType: "delegation_contract",
      reason: args.reason,
      detail,
    });
    orchestratorService.emitRuntimeUpdate({
      runId,
      stepId: args.stepId,
      reason: args.reason,
    });
  }

  function applyDelegationContractToStep(args: {
    stepId: string | null;
    contract: DelegationContract;
    additionalMetadata?: Record<string, unknown> | null;
    allowTerminal?: boolean;
  }): void {
    if (!args.stepId) return;
    orchestratorService.updateStepMetadata({
      runId,
      stepId: args.stepId,
      metadata: {
        delegationContract: args.contract,
        delegationOwnerKind: "coordinator",
        delegationIntent: args.contract.workerIntent,
        delegationMode: args.contract.mode,
        delegationScopeKey: args.contract.scope.key,
        ...(args.additionalMetadata ?? {}),
      },
      allowTerminal: args.allowTerminal,
    });
  }

  function resolvePhaseStepType(phaseKey: string): string {
    const normalized = phaseKey.trim().toLowerCase();
    if (normalized === "planning" || normalized === "analysis") return "planning";
    if (normalized === "development" || normalized === "implementation") return "implementation";
    if (normalized === "testing" || normalized === "test") return "testing";
    if (normalized === "validation") return "validation";
    if (normalized === "code_review" || normalized === "review") return "review";
    if (normalized === "test_review") return "test_review";
    if (normalized === "integration" || normalized === "merge") return "integration";
    return normalized || "implementation";
  }

  function resolveCurrentPhaseCard(
    g: OrchestratorRunGraph,
    phases: PhaseCard[]
  ): PhaseCard | null {
    if (phases.length === 0) return null;
    const runMeta = asRecord(g.run.metadata);
    const phaseRuntime = asRecord(runMeta?.phaseRuntime);
    const runtimePhaseKey = typeof phaseRuntime?.currentPhaseKey === "string" ? phaseRuntime.currentPhaseKey.trim() : "";
    const runtimePhaseName = typeof phaseRuntime?.currentPhaseName === "string" ? phaseRuntime.currentPhaseName.trim() : "";
    const sorted = [...phases].sort((a, b) => a.position - b.position);
    if (runtimePhaseKey.length > 0) {
      const byKey = sorted.find((phase) => phase.phaseKey === runtimePhaseKey);
      if (byKey) return byKey;
    }
    if (runtimePhaseName.length > 0) {
      const byName = sorted.find((phase) => phase.name === runtimePhaseName);
      if (byName) return byName;
    }
    return sorted[0] ?? null;
  }

  function buildPhaseMetadataForNewStep(
    g: OrchestratorRunGraph,
    phases: PhaseCard[]
  ): Record<string, unknown> {
    const current = resolveCurrentPhaseCard(g, phases);
    if (!current) return {};
    const stepType = resolvePhaseStepType(current.phaseKey);
    return {
      phaseKey: current.phaseKey,
      phaseName: current.name,
      phasePosition: current.position,
      phaseModel: current.model,
      phaseInstructions: current.instructions,
      phaseAskQuestions: {
        enabled: current.askQuestions.enabled === true,
        maxQuestions: current.askQuestions.enabled === true
          ? Math.max(1, Math.min(10, Number(current.askQuestions.maxQuestions ?? 5) || 5))
          : undefined,
      },
      phaseValidation: current.validationGate,
      phaseBudget: current.budget ?? {},
      stepType,
      taskType: stepType,
      readOnlyExecution: stepType === "planning"
    };
  }

  function getStepsForPhase(g: OrchestratorRunGraph, phase: PhaseCard): OrchestratorStep[] {
    return g.steps.filter((step) => {
      const stepMeta = asRecord(step.metadata);
      const stepPhaseKey = typeof stepMeta?.phaseKey === "string" ? stepMeta.phaseKey.trim() : "";
      const stepPhaseName = typeof stepMeta?.phaseName === "string" ? stepMeta.phaseName.trim() : "";
      return stepPhaseKey === phase.phaseKey || stepPhaseName === phase.name;
    });
  }

  function stepBelongsToPhase(step: OrchestratorStep, phase: PhaseCard): boolean {
    const stepMeta = asRecord(step.metadata);
    const stepPhaseKey = typeof stepMeta?.phaseKey === "string" ? stepMeta.phaseKey.trim().toLowerCase() : "";
    const stepPhaseName = typeof stepMeta?.phaseName === "string" ? stepMeta.phaseName.trim().toLowerCase() : "";
    const phaseKey = phase.phaseKey.trim().toLowerCase();
    const phaseName = phase.name.trim().toLowerCase();
    return stepPhaseKey === phaseKey || stepPhaseName === phaseName;
  }

  function isImplicitDependencyCandidate(step: OrchestratorStep): boolean {
    if (isTaskShellStep(step)) return false;
    return step.status === "succeeded" || step.status === "running" || step.status === "blocked";
  }

  function resolveImplicitDependencyStepKeys(
    g: OrchestratorRunGraph,
    phases: PhaseCard[],
  ): string[] {
    const currentPhase = resolveCurrentPhaseCard(g, phases);
    const currentPhaseKey = currentPhase?.phaseKey.trim().toLowerCase() ?? "";
    const currentPhaseName = currentPhase?.name.trim().toLowerCase() ?? "";
    if (!currentPhase || currentPhaseKey === "planning" || currentPhaseName === "planning") {
      return [];
    }

    const sorted = [...phases].sort((a, b) => a.position - b.position);
    const currentIndex = sorted.findIndex((phase) => phase.id === currentPhase.id);
    if (currentIndex > 0) {
      for (let index = currentIndex - 1; index >= 0; index -= 1) {
        const priorPhase = sorted[index];
        if (!priorPhase) continue;
        const priorPhaseStepKeys = filterExecutionSteps(g.steps)
          .filter((step) => stepBelongsToPhase(step, priorPhase))
          .filter(isImplicitDependencyCandidate)
          .map((step) => step.stepKey);
        if (priorPhaseStepKeys.length > 0) {
          return dedupeKeys(priorPhaseStepKeys);
        }
      }
    }

    return filterExecutionSteps(g.steps)
      .filter(isPlanningExecutionStep)
      .filter(isImplicitDependencyCandidate)
      .map((step) => step.stepKey);
  }

  function getPlanningInputBlockReason(g: OrchestratorRunGraph): string | null {
    const phases = resolveMissionPhases(g);
    const current = resolveCurrentPhaseCard(g, phases);
    const currentKey = current?.phaseKey.trim().toLowerCase() ?? "";
    const currentName = current?.name.trim().toLowerCase() ?? "";
    if (currentKey !== "planning" && currentName !== "planning") return null;
    const mission = missionService.get(missionId);
    if (!mission) return null;
    const blocking = mission.interventions.filter((entry) => {
      if (entry.status !== "open" || entry.interventionType !== "manual_input") return false;
      const metadata = asRecord(entry.metadata);
      if (metadata?.canProceedWithoutAnswer === true) return false;
      const phase = typeof metadata?.phase === "string" ? metadata.phase.trim().toLowerCase() : "";
      return phase.length === 0 || phase === "planning" || phase === currentKey || phase === currentName;
    });
    if (blocking.length === 0) return null;
    return `Planning input is still pending. Resolve ${blocking.length === 1 ? "the open question" : "the open questions"} before executing planning actions.`;
  }

  function resolveCurrentPhaseQuestionPolicy(g: OrchestratorRunGraph): {
    phase: PhaseCard | null;
    phaseKey: string;
    enabled: boolean;
    maxQuestions: number | null;
    isPlanning: boolean;
  } {
    const phases = resolveMissionPhases(g);
    const current = resolveCurrentPhaseCard(g, phases);
    const currentKey = current?.phaseKey.trim().toLowerCase() ?? "";
    const currentName = current?.name.trim().toLowerCase() ?? "";
    const inPlanning = currentKey === "planning" || currentName === "planning";
    return {
      phase: current ?? null,
      phaseKey: current?.phaseKey ?? current?.name ?? "",
      enabled: current?.askQuestions.enabled === true,
      maxQuestions: inPlanning && current?.askQuestions.maxQuestions == null
        ? null
        : Math.max(1, Math.min(10, Number(current?.askQuestions.maxQuestions ?? 5) || 5)),
      isPlanning: inPlanning,
    };
  }

  function resolvePlanningQuestionPolicy(g: OrchestratorRunGraph): {
    phase: PhaseCard | null;
    phaseKey: string;
    enabled: boolean;
    maxQuestions: number | null;
  } {
    const policy = resolveCurrentPhaseQuestionPolicy(g);
    return {
      phase: policy.phase,
      phaseKey: policy.phaseKey,
      enabled: policy.isPlanning && policy.enabled,
      maxQuestions: policy.maxQuestions,
    };
  }

  function listPhaseQuestionInterventions(g: OrchestratorRunGraph): import("../../../shared/types").MissionIntervention[] {
    const mission = missionService.get(missionId);
    if (!mission) return [];
    const policy = resolveCurrentPhaseQuestionPolicy(g);
    const normalizedPhase = policy.phaseKey.trim().toLowerCase();
    return mission.interventions.filter((entry) => {
      if (entry.interventionType !== "manual_input") return false;
      const metadata = asRecord(entry.metadata);
      if (metadata?.source !== "ask_user") return false;
      const phase = typeof metadata?.phase === "string" ? metadata.phase.trim().toLowerCase() : "";
      return phase.length === 0 || phase === "planning" || phase === normalizedPhase;
    });
  }

  function getPlanningQuestionPolicyBlockReason(g: OrchestratorRunGraph): string | null {
    const policy = resolvePlanningQuestionPolicy(g);
    if (!policy.enabled) return null;
    const interventions = listPhaseQuestionInterventions(g);
    const openQuestion = interventions.find((entry) => entry.status === "open") ?? null;
    if (openQuestion) {
      return "Planning questions are still open. Resolve them before spawning the planning worker.";
    }
    return null;
  }

  function getQuestionAskingBlockReason(g: OrchestratorRunGraph): string | null {
    const policy = resolveCurrentPhaseQuestionPolicy(g);
    if (policy.enabled) return null;
    return "Ask Questions is disabled for the current phase. Proceed with the best reasonable assumption unless runtime opens its own intervention.";
  }

  function buildCoordinatorQuestionOwnerMetadata(args: {
    phaseKey?: string | null;
    phaseName?: string | null;
  }): Record<string, unknown> {
    return {
      questionOwnerKind: "coordinator",
      questionOwnerLabel: "Coordinator question",
      ownerRole: "coordinator",
      phase: args.phaseKey ?? null,
      phaseName: args.phaseName ?? null,
    };
  }

  function getPlanningRepoReadBlockReason(g: OrchestratorRunGraph): string | null {
    const permission = checkCoordinatorToolPermission({
      toolName: "read_file",
      contracts: extractActiveDelegationContracts(g),
    });
    if (!permission.allowed) {
      return permission.reason;
    }
    const phases = resolveMissionPhases(g);
    const current = resolveCurrentPhaseCard(g, phases);
    const currentKey = current?.phaseKey.trim().toLowerCase() ?? "";
    const currentName = current?.name.trim().toLowerCase() ?? "";
    if (currentKey === "planning" || currentName === "planning") {
      return "Coordinator-side repo inspection is disabled during Planning. Use get_project_context to brief the planner, wait for the planning worker output, then transition phases before doing coordinator-side file reads.";
    }
    return null;
  }

  function promptContainsImplementationDirectives(prompt: string): boolean {
    const compact = prompt.trim();
    if (!compact.length) return false;
    const normalized = compact.toLowerCase();
    return (
      normalized.includes("all file edits must")
      || normalized.includes("files to change")
      || normalized.includes("files to modify")
      || normalized.includes("files to edit")
      || normalized.includes("exact changes required")
      || normalized.includes("i have already researched the codebase")
      || normalized.includes("here is the complete plan")
      || normalized.includes("please output a brief confirmation of this plan")
      || normalized.includes("create new file")
      || normalized.includes("new file:")
      || normalized.includes("run `git add")
      || normalized.includes("run `git commit")
      || normalized.includes("done criteria")
      || normalized.includes("apply in the worktree")
      || /(?:^|\n)###\s*\d+\.\s*(?:create|edit)\b/i.test(compact)
      || /(?:^|\n)\d+\.\s+new file:/i.test(compact)
      || /(?:^|\n)-\s*add\b.+\bimport\b/i.test(compact)
      || /(?:^|\n)-\s*add\b.+\broute\b/i.test(compact)
      || /(?:^|\n)-\s*edit\s+`[^`]+`/i.test(compact)
    );
  }

  function looksLikeValidationWorkerRequest(args: {
    name: string;
    roleName: string | null;
    prompt: string;
    validationContract: ValidationContract | null;
    includeNameHeuristics?: boolean;
  }): boolean {
    if (args.validationContract?.level === "step" || args.validationContract?.level === "milestone" || args.validationContract?.level === "mission") {
      return true;
    }
    const includeNameHeuristics = args.includeNameHeuristics ?? true;
    const name = args.name.trim().toLowerCase();
    const roleName = args.roleName?.trim().toLowerCase() ?? "";
    const prompt = args.prompt.trim().toLowerCase();
    const validationPattern = /\b(validat(?:e|ion|or))\b/;
    return (
      (includeNameHeuristics && validationPattern.test(name))
      || (includeNameHeuristics && validationPattern.test(roleName))
      || prompt.includes("report_validation")
      || prompt.includes("validation checklist")
      || prompt.includes("verdict: \"pass\"")
      || prompt.includes("verdict \"pass\"")
    );
  }

  function isPlanningExecutionStep(step: OrchestratorStep): boolean {
    const stepMeta = asRecord(step.metadata);
    const stepPhaseKey = typeof stepMeta?.phaseKey === "string" ? stepMeta.phaseKey.trim().toLowerCase() : "";
    const stepPhaseName = typeof stepMeta?.phaseName === "string" ? stepMeta.phaseName.trim().toLowerCase() : "";
    return !isTaskShellStep(step) && (stepPhaseKey === "planning" || stepPhaseName === "planning");
  }

  function phaseHasCompletionEligibleStep(
    phase: PhaseCard,
    stepsForPhase: (phase: PhaseCard) => OrchestratorStep[],
  ): boolean {
    const phaseKey = phase.phaseKey.trim().toLowerCase();
    const phaseName = phase.name.trim().toLowerCase();
    const phaseSteps = filterExecutionSteps(stepsForPhase(phase));
    if (phaseKey === "planning" || phaseName === "planning") {
      return phaseSteps.some((step) => isPlanningExecutionStep(step) && step.status === "succeeded");
    }
    return phaseSteps.some((step) => TERMINAL_STEP_STATUSES.has(step.status));
  }

  function phaseHasSuccessfulCompletion(
    phase: PhaseCard,
    stepsForPhase: (phase: PhaseCard) => OrchestratorStep[],
  ): boolean {
    const phaseKey = phase.phaseKey.trim().toLowerCase();
    const phaseName = phase.name.trim().toLowerCase();
    const phaseSteps = filterExecutionSteps(stepsForPhase(phase));
    if (phaseSteps.length === 0) return false;
    if (phaseKey === "planning" || phaseName === "planning") {
      return phaseSteps.some((step) => isPlanningExecutionStep(step) && step.status === "succeeded");
    }
    const allTerminalWithoutFailure = phaseSteps.every(
      (step) => step.status === "succeeded" || step.status === "skipped" || step.status === "superseded",
    );
    const hasConcreteSuccess = phaseSteps.some((step) => step.status === "succeeded");
    return allTerminalWithoutFailure && hasConcreteSuccess;
  }

  function stopReasonLooksLikeNormalCompletion(reason: string): boolean {
    const normalized = reason.trim().toLowerCase();
    if (!normalized.length) return false;
    return (
      normalized.includes("work is committed and complete")
      || normalized.includes("proceed to validation")
      || normalized.includes("normal completion")
      || normalized.includes("finished successfully")
      || normalized.includes("already complete")
    );
  }

  function stopReasonIndicatesHardFailure(reason: string): boolean {
    const normalized = reason.trim().toLowerCase();
    if (!normalized.length) return false;
    return (
      normalized.includes("fatal")
      || normalized.includes("panic")
      || normalized.includes("crash")
      || normalized.includes("exception")
      || normalized.includes("process exited unexpectedly")
      || normalized.includes("session exited unexpectedly")
      || normalized.includes("hard failure")
      || normalized.includes("unrecoverable error")
    );
  }

  /**
   * Validate that spawning a worker for the current phase respects ordering constraints.
   *
   * Checks:
   * 1. `mustFollow` — named predecessor phases must have at least one terminal step.
   * 2. Required earlier phases (by position) must have at least one terminal step.
   * 3. `mustBeFirst` — that phase must complete before any other phase starts work.
   * 4. `mustBeLast` — all earlier phases must be fully terminal before it can start.
   */
  function validatePhaseOrdering(
    phases: PhaseCard[],
    g: OrchestratorRunGraph,
  ): { valid: true } | { valid: false; reason: string } {
    if (phases.length === 0) return { valid: true };
    const phaseContext = resolveConfiguredPhaseContext(g, phases);
    if (!phaseContext.ok) {
      return { valid: false, reason: phaseContext.error };
    }
    if (!phaseContext.currentPhase) return { valid: true };
    const sorted = phaseContext.phases;
    const currentPhase = phaseContext.currentPhase;

    const currentIndex = sorted.indexOf(currentPhase);

    const phaseHasSucceeded = (phase: PhaseCard): boolean =>
      phaseHasSuccessfulCompletion(phase, (p) => getStepsForPhase(g, p));

    const phaseHasNonTerminalStep = (phase: PhaseCard): boolean =>
      getStepsForPhase(g, phase).some((step) => !TERMINAL_STEP_STATUSES.has(step.status));

    const currentPhaseKeyNormalized = currentPhase.phaseKey.trim().toLowerCase();
    const currentPhaseNameNormalized = currentPhase.name.trim().toLowerCase();
    if (currentPhaseKeyNormalized === "planning" || currentPhaseNameNormalized === "planning") {
      const planningExecutionSteps = filterExecutionSteps(getStepsForPhase(g, currentPhase));
      if (planningExecutionSteps.some((step) => !TERMINAL_STEP_STATUSES.has(step.status))) {
        return {
          valid: false,
          reason: "Planning already has an active worker. Wait for it to finish before spawning another planning worker.",
        };
      }
      if (planningExecutionSteps.some((step) => step.status === "succeeded")) {
        return {
          valid: false,
          reason: 'Planning phase already produced a completed worker result. Call set_current_phase with phaseKey "development" before spawning more workers.',
        };
      }
    }

    // Check mustFollow constraints
    const mustFollow = currentPhase.orderingConstraints.mustFollow;
    if (mustFollow && mustFollow.length > 0) {
      for (const predecessor of mustFollow) {
        const trimmed = predecessor.trim();
        if (!trimmed.length) continue;
        const predecessorPhase = sorted.find((p) => p.phaseKey === trimmed || p.name === trimmed);
        if (predecessorPhase && !phaseHasSucceeded(predecessorPhase)) {
          return {
            valid: false,
            reason: `Phase "${currentPhase.name}" requires phase "${predecessorPhase.name}" to succeed first (mustFollow constraint). No successful completion was found for "${predecessorPhase.name}".`,
          };
        }
      }
    }

    // Check that all required earlier phases have at least one terminal step
    for (let i = 0; i < currentIndex; i++) {
      const earlier = sorted[i];
      if (!earlier.validationGate.required) continue;
      if (!phaseHasSucceeded(earlier)) {
        return {
          valid: false,
          reason: `Required phase "${earlier.name}" (position ${earlier.position}) has not succeeded yet. It must succeed before starting phase "${currentPhase.name}" (position ${currentPhase.position}).`,
        };
      }
    }

    // Check mustBeLast: all earlier phases must be fully terminal
    if (currentPhase.orderingConstraints.mustBeLast) {
      for (let i = 0; i < currentIndex; i++) {
        const earlier = sorted[i];
        if (phaseHasNonTerminalStep(earlier)) {
          return {
            valid: false,
            reason: `Phase "${currentPhase.name}" is marked mustBeLast but phase "${earlier.name}" still has active (non-terminal) steps.`,
          };
        }
      }
    }

    // Check mustBeFirst: if a phase is mustBeFirst, it must succeed before others start
    const firstPhase = sorted.find((p) => p.orderingConstraints.mustBeFirst);
    if (firstPhase && firstPhase !== currentPhase && !phaseHasSucceeded(firstPhase)) {
      return {
        valid: false,
        reason: `Phase "${firstPhase.name}" is marked mustBeFirst and has not succeeded yet. Cannot start phase "${currentPhase.name}" until it succeeds.`,
      };
    }

    return { valid: true };
  }

  function stepHasPassingRequiredValidation(step: OrchestratorStep): boolean {
    const stepMeta = asRecord(step.metadata) ?? {};
    const validationContract = parseValidationContract(stepMeta.validationContract ?? null);
    if (!validationContract?.required) return true;
    if (resolveValidationStateFromStepMetadata(stepMeta) === "pass") return true;
    const validationPassedAt = typeof stepMeta.validationPassedAt === "string" ? stepMeta.validationPassedAt.trim() : "";
    return validationPassedAt.length > 0;
  }

  function validateRequiredValidationGates(
    phases: PhaseCard[],
    g: OrchestratorRunGraph,
  ): { valid: true } | { valid: false; reason: string } {
    if (phases.length === 0) return { valid: true };
    const phaseContext = resolveConfiguredPhaseContext(g, phases);
    if (!phaseContext.ok) {
      return { valid: false, reason: phaseContext.error };
    }
    if (!phaseContext.currentPhase) return { valid: true };
    const sorted = phaseContext.phases;
    const currentPhase = phaseContext.currentPhase;
    const currentIndex = sorted.indexOf(currentPhase);

    for (let i = 0; i < currentIndex; i += 1) {
      const earlier = sorted[i]!;
      if (!earlier.validationGate.required) continue;
      const missingRequiredValidation = getStepsForPhase(g, earlier)
        .filter((step) => step.status === "succeeded")
        .filter((step) => !stepHasPassingRequiredValidation(step));
      if (missingRequiredValidation.length > 0) {
        return {
          valid: false,
          reason: `Phase "${earlier.name}" validation gate has not passed. ${missingRequiredValidation.length} step(s) are missing required validation.`,
        };
      }
    }

    return { valid: true };
  }

  const spawn_worker = defineCoordinatorTool({
    description:
      "Spawn a new agent worker session. The worker will execute the given prompt autonomously. Returns a worker ID (step key) you can use to track, message, or stop the worker.",
    inputSchema: z.object({
      name: z.string().describe("Human-readable name for the worker (e.g. 'auth-implementer', 'test-writer')"),
      modelId: z.string().optional().describe("Optional model ID override for this worker (for example: openai/gpt-5.3-codex)"),
      role: z.string().optional().describe("Optional team role to bind (e.g. implementer, validator, researcher)"),
      prompt: z.string().describe("The full task prompt for the worker — be specific about what to do"),
      laneId: z.string().optional().describe("Optional lane ID override for the worker step"),
      replacementForWorkerId: z
        .string()
        .optional()
        .describe("Optional source worker step key to replace. When set, lane and handoff context are inherited."),
      replacementReason: z.string().optional().describe("Optional reason for replacement"),
      validationContract: VALIDATION_CONTRACT_SCHEMA
        .describe("Optional validation contract attached to this worker step"),
      dependsOn: z
        .array(z.string())
        .default([])
        .describe("Step keys this worker depends on (must complete before worker starts)"),
    }),
    execute: async ({ name, modelId, role, prompt, laneId, replacementForWorkerId, replacementReason, validationContract, dependsOn }) => {
      try {
        const g = graph();
        const planningInputBlockReason = getPlanningInputBlockReason(g);
        if (planningInputBlockReason) {
          return { ok: false, error: planningInputBlockReason };
        }
        const planningQuestionPolicyBlockReason = getPlanningQuestionPolicyBlockReason(g);
        if (planningQuestionPolicyBlockReason) {
          return { ok: false, error: planningQuestionPolicyBlockReason };
        }
        const normalizedName = normalizeText(name);
        if (!normalizedName.length) {
          return { ok: false, error: "Worker name is required." };
        }
        const normalizedPrompt = normalizeText(prompt);
        if (!normalizedPrompt.length) {
          return { ok: false, error: "Worker prompt is required." };
        }
        const requestedDependsOn = normalizeDependencyReferences({
          graph: g,
          refs: dependsOn,
          label: `Worker '${normalizedName}'`,
        });
        const teamRuntime = resolveTeamRuntimeConfig(g);
        const normalizedRole = typeof role === "string" ? role.trim() : "";
        if (normalizedRole.length > 0 && !resolveRoleDefinition(teamRuntime, normalizedRole)) {
          return { ok: false, error: `Unknown role '${normalizedRole}' in active team template.` };
        }
        const replacementSourceWorkerId = typeof replacementForWorkerId === "string" ? replacementForWorkerId.trim() : "";
        if (replacementSourceWorkerId.length > 0 && !resolveStep(g, replacementSourceWorkerId)) {
          return { ok: false, error: `Replacement source worker '${replacementSourceWorkerId}' was not found.` };
        }
        const parsedContract = parseValidationContract(validationContract ?? null);
        if (validationContract && !parsedContract) {
          return { ok: false, error: "Invalid validationContract payload." };
        }
        const missionPhases = resolveMissionPhases(g);
        const phaseContext = resolveConfiguredPhaseContext(g, missionPhases);
        if (!phaseContext.ok) {
          return { ok: false, error: phaseContext.error };
        }
        const currentPhase = phaseContext.currentPhase;
        const currentPhaseKey = currentPhase?.phaseKey.trim().toLowerCase() ?? "";
        const inferredDependsOn =
          requestedDependsOn.length === 0 && missionPhases.length > 0
            ? resolveImplicitDependencyStepKeys(g, missionPhases)
            : [];
        const normalizedDependsOn =
          requestedDependsOn.length > 0 ? requestedDependsOn : inferredDependsOn;
        const phaseValidation = validateDelegationPromptForCurrentPhase({
          currentPhaseKey,
          workerName: normalizedName,
          roleName: normalizedRole.length > 0 ? normalizedRole : null,
          prompt: normalizedPrompt,
          validationContract: parsedContract,
          validationHeuristics: "strict",
        });
        if (!phaseValidation.ok) {
          return { ok: false, error: phaseValidation.error };
        }
        const spawnPolicy = authorizeWorkerSpawnPolicy({
          g,
          requestedModelId: modelId,
        });
        if (!spawnPolicy.ok) {
          if (spawnPolicy.blockedByValidationGate) {
            logger.info("coordinator.spawn_worker.validation_gate_blocked", {
              name,
              reason: spawnPolicy.error,
            });
            const gateBlockedAt = nowIso();
            const graphStep = resolveStep(
              g,
              replacementSourceWorkerId.length > 0
                ? replacementSourceWorkerId
                : requestedDependsOn[requestedDependsOn.length - 1] ?? "",
            );
            const gateBlockedDetail = {
              workerName: name,
              requestedRole: normalizedRole.length > 0 ? normalizedRole : null,
              phase: resolveCurrentPhase(g),
              reason: spawnPolicy.error,
              blockedByValidationGate: true,
              laneId: typeof laneId === "string" && laneId.trim().length > 0 ? laneId.trim() : null,
              stepKey: graphStep?.stepKey ?? null
            };
            orchestratorService.appendTimelineEvent({
              runId,
              stepId: graphStep?.id ?? null,
              eventType: "validation_gate_blocked",
              reason: "required_validation_gate_blocked",
              detail: gateBlockedDetail
            });
            orchestratorService.appendRuntimeEvent({
              runId,
              stepId: graphStep?.id ?? null,
              eventType: "validation_gate_blocked",
              eventKey: `validation_gate_blocked:${runId}:${name}:${normalizedRole}:${gateBlockedAt}`,
              occurredAt: gateBlockedAt,
              payload: gateBlockedDetail
            });
            orchestratorService.emitRuntimeUpdate({
              runId,
              stepId: graphStep?.id ?? null,
              reason: "validation_gate_blocked"
            });
          } else if (spawnPolicy.blockedByPhaseOrdering) {
            logger.info("coordinator.spawn_worker.phase_ordering_blocked", {
              name,
              reason: spawnPolicy.error,
            });
          }
          return { ok: false, error: spawnPolicy.error };
        }
        let resolvedModelId = spawnPolicy.resolvedModelId;
        const resolvedProvider = spawnPolicy.resolvedProvider;

        // Hard cap check: refuse to spawn if budget hard caps are triggered
        const budgetCheck = await checkBudgetHardCaps({
          failClosedOnTelemetryError: true,
          operation: "spawn_worker",
        });
        if (budgetCheck.blocked) {
          logger.warn("coordinator.spawn_worker.hard_cap_blocked", { name, detail: budgetCheck.detail });
          return {
            ok: false,
            error: `Cannot spawn worker: ${budgetCheck.detail}. Mission pausing.`,
            hardCapTriggered: true,
            hardCaps: budgetCheck.hardCaps,
          };
        }

        // Emit soft budget warning on spawn if pressure is elevated (deduped)
        if (deps.onBudgetWarning && getMissionBudgetStatus) {
          try {
            const snap = await getMissionBudgetStatus();
            if (
              snap &&
              (snap.pressure === "warning" || snap.pressure === "critical") &&
              snap.pressure !== lastEmittedBudgetPressure
            ) {
              const detail = snap.recommendation || `Budget pressure is now ${snap.pressure} while spawning worker '${name}'`;
              lastEmittedBudgetPressure = snap.pressure;
              deps.onBudgetWarning(snap.pressure, detail);
            }
          } catch {
            // Non-blocking — budget warning is best-effort
          }
        }

        // ── VAL-USAGE-003: Model downgrade runtime ──
        // Check if usage exceeds the configured model downgrade threshold.
        // If so, override the resolved model ID with a cheaper alternative.
        if (getMissionBudgetStatus) {
          try {
            const usageSnap = await getMissionBudgetStatus();
            if (usageSnap) {
              const runMeta = asRecord(g.run.metadata);
              const budgetConfig = asRecord(runMeta?.budgetConfig);
              const thresholdPct = Number(budgetConfig?.modelDowngradeThresholdPct ?? 0);
              if (thresholdPct > 0) {
                const maxUsagePct = Math.max(
                  ...(usageSnap.perProvider ?? []).map((p: any) =>
                    Math.max(Number(p.fiveHour?.usedPct ?? 0), Number(p.weekly?.usedPct ?? 0))
                  ),
                  0
                );
                if (maxUsagePct >= thresholdPct) {
                  const { evaluateModelDowngrade } = await import("./adaptiveRuntime");
                  const downgradeResult = evaluateModelDowngrade({
                    currentModelId: resolvedModelId,
                    downgradeThresholdPct: thresholdPct,
                    currentUsagePct: maxUsagePct,
                  });
                  if (downgradeResult.downgraded) {
                    logger.info("coordinator.spawn_worker.model_downgrade", {
                      name,
                      originalModel: downgradeResult.originalModelId,
                      downgradedModel: downgradeResult.resolvedModelId,
                      reason: downgradeResult.reason,
                      usagePct: Math.round(maxUsagePct),
                      thresholdPct,
                    });
                    resolvedModelId = downgradeResult.resolvedModelId;
                  }
                }
              }
            }
          } catch {
            // Non-blocking — downgrade check is best-effort
          }
        }

        // Parallel agent enforcement: if disabled, block when a worker is already running
        const teamRuntimeForPolicy = resolveTeamRuntimeConfig(g);
        if (teamRuntimeForPolicy?.allowParallelAgents === false) {
          const hasRunningAttempt = g.attempts.some((a) => a.status === "running");
          if (hasRunningAttempt) {
            return {
              ok: false,
              error: "Parallel agents disabled — wait for current worker to complete before spawning another.",
            };
          }
        }

        // Phase ordering enforcement is handled centrally. Planning still gets
        // a dedicated post-completion guard because only one planning worker result
        // should exist before transitioning phases.
        if (missionPhases.length > 0) {
          if (currentPhaseKey === "planning") {
            const completedPlanningWorker = g.steps.some((step) => {
              const stepMeta = asRecord(step.metadata);
              const stepPhaseKey = typeof stepMeta?.phaseKey === "string" ? stepMeta.phaseKey.trim().toLowerCase() : "";
              const stepPhaseName = typeof stepMeta?.phaseName === "string" ? stepMeta.phaseName.trim().toLowerCase() : "";
              return !isTaskShellStep(step)
                && (stepPhaseKey === "planning" || stepPhaseName === "planning")
                && step.status === "succeeded";
            });
            if (completedPlanningWorker) {
              return {
                ok: false,
                error: "Planning phase already produced a completed worker result. Call set_current_phase with phaseKey \"development\" before spawning more workers."
              };
            }
          }
        }

        const delegationIntent: DelegationIntent =
          replacementSourceWorkerId.length > 0
            ? "recovery"
            : currentPhaseKey === "planning"
              ? "planner"
              : currentPhaseKey === "validation" || parsedContract?.required
                ? "validation"
                : "implementation";
        const delegationMode: DelegationMode =
          delegationIntent === "planner"
            ? "exclusive"
            : delegationIntent === "recovery"
              ? "recovery"
              : "bounded_parallel";
        const provisionalWorkerId = replacementSourceWorkerId.length > 0
          ? `replacement_${replacementSourceWorkerId}_${Date.now()}`
          : `worker_${normalizedName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}`;
        const delegationScopeKey =
          delegationIntent === "planner"
            ? "phase:planning"
            : replacementSourceWorkerId.length > 0
              ? `worker:${replacementSourceWorkerId}`
              : currentPhaseKey.length > 0
                ? `phase:${currentPhaseKey}`
                : `phase:${resolveCurrentPhase(g).trim().toLowerCase() || "unknown"}`;
        const delegationContract = buildCoordinatorDelegationContract({
          graph: g,
          workerId: provisionalWorkerId,
          phaseKey: currentPhaseKey,
          workerName: normalizedName,
          intent: delegationIntent,
          mode: delegationMode,
          scopeKind: delegationIntent === "planner" ? "phase" : replacementSourceWorkerId.length > 0 ? "worker" : "phase",
          scopeKey: delegationScopeKey,
          scopeLabel: currentPhase?.name ?? currentPhase?.phaseKey ?? null,
          metadata: {
            role: normalizedRole.length > 0 ? normalizedRole : null,
            replacementForWorkerId: replacementSourceWorkerId || null,
          },
        });
        const conflictingContract = hasConflictingDelegationContract({
          graph: g,
          contract: delegationContract,
        });
        if (conflictingContract) {
          return {
            ok: false,
            error:
              `Delegation scope '${delegationContract.scope.key}' is already owned by active ${conflictingContract.mode} delegation ` +
              `(${conflictingContract.workerIntent}). Wait for it to finish or recover explicitly before spawning more work in the same scope.`,
          };
        }

        const { workerId, step: newStep, roleName, modelId: spawnedModelId, toolProfile, reusedExistingStep } = spawnWorkerStep({
          stepKey: provisionalWorkerId,
          name: normalizedName,
          modelId: resolvedModelId,
          prompt: normalizedPrompt,
          dependsOn: normalizedDependsOn,
          requestedDependsOn,
          inferredDependsOn,
          roleName: normalizedRole.length > 0 ? normalizedRole : null,
          laneId: typeof laneId === "string" && laneId.trim().length > 0 ? laneId.trim() : null,
          replacementForWorkerId: replacementSourceWorkerId || null,
          replacementReason: replacementReason?.trim() || null,
          validationContract: parsedContract,
          delegationContract: updateDelegationContract(delegationContract, {
            activeWorkerIds: [provisionalWorkerId],
          }),
        });
        if (newStep && !reusedExistingStep) {
          onDagMutation({
            runId,
            mutation: { type: "step_added", step: newStep },
            timestamp: nowIso(),
            source: "coordinator",
          });
        }

        // Trigger autopilot to pick up the new step — await with timeout
        // so we can tell the coordinator whether the worker actually launched.
        let launched = false;
        let launchNote: string | undefined;
        try {
          const startedCount = await Promise.race([
            orchestratorService.startReadyAutopilotAttempts({
              runId,
              reason: "coordinator_spawn_worker",
            }),
            new Promise<number>((_, reject) =>
              setTimeout(() => reject(new Error("autopilot_start_timeout")), AUTOPILOT_START_TIMEOUT_MS)
            ),
          ]);
          // Verify an attempt is actually running for this step
          if (newStep) {
            const freshGraph = graph();
            const runningAttempt = freshGraph.attempts.find(
              (a) => a.stepId === newStep.id && a.status === "running",
            );
            launched = !!runningAttempt;
            if (!launched && startedCount > 0) {
              // Autopilot started attempts but not for this step (e.g. other ready steps got priority)
              launchNote = "autopilot_started_other_steps";
            } else if (!launched) {
              launchNote = "step_queued_not_yet_started";
            }
          } else {
            launched = startedCount > 0;
          }
        } catch {
          // Autopilot didn't finish in time — step is created and will be picked up on next cycle
          launchNote = "autopilot_start_timeout_step_queued";
          logger.warn("coordinator.spawn_worker.autopilot_timeout", { name, workerId });
        }

        trackTeamMember({
          workerId,
          provider: resolvedProvider,
          modelId: spawnedModelId,
          role: roleName,
          source: "ade-worker",
        });

        const finalizedDelegationContract = updateDelegationContract(delegationContract, {
          activeWorkerIds: [workerId],
          status:
            delegationIntent === "planner"
              ? "active"
              : launched || delegationMode !== "exclusive"
                ? "active"
                : "launching",
          launchState:
            delegationIntent === "planner"
              ? "waiting_on_worker"
              : launched
                ? "waiting_on_worker"
                : "awaiting_worker_launch",
          startedAt: launched ? nowIso() : null,
          metadata: {
            ...(delegationContract.metadata ?? {}),
            launchNote: launchNote ?? null,
            launched,
          },
        });
        if (newStep?.id) {
          applyDelegationContractToStep({
            stepId: newStep.id,
            contract: finalizedDelegationContract,
          });
          persistDelegationContract({
            contract: finalizedDelegationContract,
            stepId: newStep.id,
            reason: "delegation_contract_created",
            action: "created",
          });
        }

        logger.info("coordinator.spawn_worker", {
          name: normalizedName,
          workerId,
          provider: resolvedProvider,
          role: roleName,
          launched,
          launchNote,
          delegationIntent,
          delegationMode,
        });
        return {
          ok: true,
          workerId,
          launched,
          ...(launchNote ? { launchNote } : {}),
          stepId: newStep?.id ?? null,
          status: newStep?.status ?? "unknown",
          name: normalizedName,
          modelId: spawnedModelId,
          provider: resolvedProvider,
          role: roleName,
          toolProfile,
          replacementForWorkerId: replacementSourceWorkerId || null,
          delegationContract: finalizedDelegationContract,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.spawn_worker.error", { name, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const insert_milestone = defineCoordinatorTool({
    description:
      "Insert a milestone gate into the mission DAG. Milestones require dedicated validator pass before they can be completed.",
    inputSchema: z.object({
      name: z.string().describe("Human-readable milestone name"),
      dependsOn: z
        .array(z.string())
        .default([])
        .describe("Step keys this milestone depends on"),
      validationCriteria: z.string().describe("Validation criteria that must pass for this milestone"),
      gatesSteps: z
        .array(z.string())
        .optional()
        .describe("Optional step keys that should be gated on this milestone"),
    }),
    execute: async ({ name, dependsOn, validationCriteria, gatesSteps }) => {
      try {
        const g = graph();
        const normalizedName = normalizeText(name);
        if (!normalizedName.length) {
          return { ok: false, error: "Milestone name is required." };
        }
        const normalizedCriteria = normalizeText(validationCriteria);
        if (!normalizedCriteria.length) {
          return { ok: false, error: "validationCriteria is required for insert_milestone." };
        }

        const normalizedDependsOn = normalizeDependencyReferences({
          graph: g,
          refs: dependsOn,
          label: `Milestone '${normalizedName}'`,
        });

        const normalizedGatesSteps = normalizeDependencyReferences({
          graph: g,
          refs: gatesSteps,
          label: `Milestone '${normalizedName}' gates`,
        });

        const maxIndex = g.steps.reduce(
          (max, step) => Math.max(max, step.stepIndex),
          -1,
        );
        const slug = normalizedName
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "_")
          .replace(/^_+|_+$/g, "") || "milestone";
        let milestoneStepKey = `milestone_${slug}_${Date.now()}`;
        let disambiguator = 1;
        while (resolveStep(g, milestoneStepKey)) {
          disambiguator += 1;
          milestoneStepKey = `milestone_${slug}_${Date.now()}_${disambiguator}`;
        }
        const milestoneContract: ValidationContract = {
          level: "milestone",
          tier: "dedicated",
          required: true,
          criteria: normalizedCriteria,
          maxRetries: 2,
          evidence: []
        };
        const created = orchestratorService.addSteps({
          runId,
          steps: [
            {
              stepKey: milestoneStepKey,
              title: normalizedName,
              stepIndex: maxIndex + 1,
              dependencyStepKeys: normalizedDependsOn,
              executorKind: "manual",
              metadata: {
                instructions: `Milestone gate: ${normalizedCriteria}`,
                stepType: "milestone",
                isMilestone: true,
                milestoneValidationCriteria: normalizedCriteria,
                validationContract: milestoneContract
              }
            }
          ]
        });
        const milestoneStep = created[0] ?? null;
        if (!milestoneStep) {
          return { ok: false, error: "Failed to create milestone step." };
        }

        onDagMutation({
          runId,
          mutation: { type: "step_added", step: milestoneStep },
          timestamp: nowIso(),
          source: "coordinator",
        });

        const gatedStepsPatched: Array<{ stepKey: string; dependencyStepKeys: string[] }> = [];
        if (normalizedGatesSteps.length > 0) {
          const refreshed = graph();
          const stepKeyById = new Map(refreshed.steps.map((step) => [step.id, step.stepKey] as const));
          for (const gatedStepKey of normalizedGatesSteps) {
            const gatedStep = resolveStep(refreshed, gatedStepKey);
            if (!gatedStep) continue;
            const existingDependencyStepKeys = gatedStep.dependencyStepIds
              .map((depId) => stepKeyById.get(depId))
              .filter((depKey): depKey is string => typeof depKey === "string" && depKey.length > 0);
            const nextDependencyStepKeys = [...new Set([
              ...existingDependencyStepKeys,
              milestoneStep.stepKey
            ])];
            orchestratorService.updateStepDependencies({
              runId,
              stepId: gatedStep.id,
              dependencyStepKeys: nextDependencyStepKeys
            });
            onDagMutation({
              runId,
              mutation: { type: "dependency_changed", stepKey: gatedStep.stepKey, newDeps: nextDependencyStepKeys },
              timestamp: nowIso(),
              source: "coordinator",
            });
            gatedStepsPatched.push({
              stepKey: gatedStep.stepKey,
              dependencyStepKeys: nextDependencyStepKeys
            });
          }
        }

        logger.info("coordinator.insert_milestone", {
          milestoneStepKey: milestoneStep.stepKey,
          dependsOn: normalizedDependsOn,
          gatesSteps: normalizedGatesSteps
        });
        return {
          ok: true,
          milestone: {
            stepId: milestoneStep.id,
            stepKey: milestoneStep.stepKey,
            name: milestoneStep.title,
            status: milestoneStep.status,
            validationContract: milestoneContract
          },
          dependsOn: normalizedDependsOn,
          gatesStepsPatched: gatedStepsPatched
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.insert_milestone.error", { name, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const request_specialist = defineCoordinatorTool({
    description:
      "Request a specialist worker for a specific role. Use when the current worker should not continue alone.",
    inputSchema: z.object({
      role: z.string().describe("Requested specialist role (must exist in team template)"),
      objective: z.string().describe("Task objective for the specialist"),
      reason: z.string().describe("Why current worker cannot or should not continue alone"),
      requestedByWorkerId: z.string().optional().describe("Worker ID that requested this specialist"),
      name: z.string().optional().describe("Optional worker display name"),
      dependsOn: z.array(z.string()).default([]).describe("Dependencies for the specialist step"),
      laneId: z.string().optional().describe("Optional lane ID override"),
      replacementForWorkerId: z
        .string()
        .optional()
        .describe("Optional source worker this specialist replaces; lane + handoff package are inherited"),
      replacementReason: z.string().optional().describe("Optional replacement reason"),
    }),
    execute: async ({
      role,
      objective,
      reason,
      requestedByWorkerId,
      name,
      dependsOn,
      laneId,
      replacementForWorkerId,
      replacementReason,
    }) => {
      try {
        const g = graph();
        const planningInputBlockReason = getPlanningInputBlockReason(g);
        if (planningInputBlockReason) {
          return { ok: false, error: planningInputBlockReason };
        }
        const planningQuestionPolicyBlockReason = getPlanningQuestionPolicyBlockReason(g);
        if (planningQuestionPolicyBlockReason) {
          return { ok: false, error: planningQuestionPolicyBlockReason };
        }
        const teamRuntime = resolveTeamRuntimeConfig(g);
        const normalizedRole = normalizeText(role);
        const roleDef = resolveRoleDefinition(teamRuntime, normalizedRole);
        if (!roleDef) {
          return { ok: false, error: `Unknown specialist role '${normalizedRole || role}'.` };
        }
        const normalizedReason = normalizeText(reason);
        if (!normalizedReason.length) {
          return { ok: false, error: "Specialist request requires a non-empty reason." };
        }
        const normalizedObjective = normalizeText(objective);
        if (!normalizedObjective.length) {
          return { ok: false, error: "Specialist request requires a non-empty objective." };
        }
        const workerName = (normalizeText(name) || `${roleDef.name}-specialist`).slice(0, 80);
        const normalizedDependsOn = normalizeDependencyReferences({
          graph: g,
          refs: dependsOn,
          label: `Specialist '${workerName}'`,
        });
        const parsedLaneId = laneId?.trim().length ? laneId.trim() : null;
        const replacementSourceWorkerId = replacementForWorkerId?.trim().length ? replacementForWorkerId.trim() : null;
        if (replacementSourceWorkerId && !resolveStep(g, replacementSourceWorkerId)) {
          return { ok: false, error: `Replacement source worker '${replacementSourceWorkerId}' was not found.` };
        }

        // Hard cap check: refuse to spawn specialist if budget hard caps are triggered
        const budgetCheck = await checkBudgetHardCaps({
          failClosedOnTelemetryError: true,
          operation: "request_specialist",
        });
        if (budgetCheck.blocked) {
          logger.warn("coordinator.request_specialist.hard_cap_blocked", { role: normalizedRole, detail: budgetCheck.detail });
          return {
            ok: false,
            error: `Cannot spawn specialist: ${budgetCheck.detail}. Mission pausing.`,
            hardCapTriggered: true,
            hardCaps: budgetCheck.hardCaps,
          };
        }

        const missionPhases = resolveMissionPhases(g);
        const phaseContext = resolveConfiguredPhaseContext(g, missionPhases);
        if (!phaseContext.ok) {
          return { ok: false, error: phaseContext.error };
        }
        const currentPhase = phaseContext.currentPhase;
        const currentPhaseKey = currentPhase?.phaseKey.trim().toLowerCase() ?? "";
        const phaseValidation = validateDelegationPromptForCurrentPhase({
          currentPhaseKey,
          workerName,
          roleName: null,
          prompt: normalizedObjective,
          validationContract: null,
          validationHeuristics: "prompt_only",
        });
        if (!phaseValidation.ok) {
          return { ok: false, error: phaseValidation.error };
        }

        const spawnPolicy = authorizeWorkerSpawnPolicy({ g });
        if (!spawnPolicy.ok) {
          return { ok: false, error: spawnPolicy.error };
        }
        const specialistModelId = spawnPolicy.resolvedModelId;
        const delegationIntent: DelegationIntent = replacementSourceWorkerId ? "recovery" : "specialist";
        const delegationMode: DelegationMode = replacementSourceWorkerId ? "recovery" : "bounded_parallel";
        const delegationContract = buildCoordinatorDelegationContract({
          graph: g,
          workerId: `worker_${workerName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}`,
          phaseKey: currentPhaseKey,
          workerName,
          intent: delegationIntent,
          mode: delegationMode,
          scopeKind: replacementSourceWorkerId ? "worker" : "phase",
          scopeKey: replacementSourceWorkerId ? `worker:${replacementSourceWorkerId}` : `phase:${currentPhaseKey || "unknown"}`,
          scopeLabel: currentPhase?.name ?? roleDef.name,
          metadata: {
            requestedByWorkerId: requestedByWorkerId?.trim() || null,
            role: roleDef.name,
          },
        });
        const conflictingContract = hasConflictingDelegationContract({
          graph: g,
          contract: delegationContract,
        });
        if (conflictingContract) {
          return {
            ok: false,
            error:
              `Delegation scope '${delegationContract.scope.key}' is already owned by active ${conflictingContract.mode} delegation ` +
              `(${conflictingContract.workerIntent}). Wait for it to finish or recover explicitly before spawning more work in the same scope.`,
          };
        }

        const { workerId, step, roleName, modelId: spawnedModelId, toolProfile } = spawnWorkerStep({
          stepKey: delegationContract.activeWorkerIds[0],
          name: workerName,
          modelId: specialistModelId,
          prompt: normalizedObjective,
          dependsOn: normalizedDependsOn,
          roleName: roleDef.name,
          laneId: parsedLaneId,
          replacementForWorkerId: replacementSourceWorkerId,
          replacementReason: replacementReason?.trim() || normalizedReason,
          specialistRequest: {
            requestedBy: requestedByWorkerId?.trim() || null,
            reason: normalizedReason
          },
          delegationContract,
        });

        const specialistDescriptor = resolveModelDescriptor(spawnedModelId);
        const specialistProvider = specialistDescriptor?.family === "anthropic"
          ? "claude"
          : specialistDescriptor?.family === "openai"
            ? "codex"
            : specialistDescriptor?.family ?? "unknown";

        trackTeamMember({
          workerId,
          provider: specialistProvider,
          modelId: spawnedModelId,
          role: roleName,
          source: "ade-worker",
        });

        if (step) {
          const finalizedDelegationContract = updateDelegationContract(delegationContract, {
            activeWorkerIds: [workerId],
            status: "active",
            launchState: "waiting_on_worker",
            metadata: {
              ...(delegationContract.metadata ?? {}),
              requestedByWorkerId: requestedByWorkerId?.trim() || null,
            },
          });
          applyDelegationContractToStep({
            stepId: step.id,
            contract: finalizedDelegationContract,
          });
          persistDelegationContract({
            contract: finalizedDelegationContract,
            stepId: step.id,
            reason: "delegation_contract_created",
            action: "created",
          });
          onDagMutation({
            runId,
            mutation: { type: "step_added", step },
            timestamp: nowIso(),
            source: "coordinator",
          });
        }

        orchestratorService.appendRuntimeEvent({
          runId,
          stepId: step?.id ?? null,
          eventType: "progress",
          payload: {
            type: "specialist_requested",
            requestedByWorkerId: requestedByWorkerId ?? null,
            role: roleDef.name,
            reason: normalizedReason,
            workerId
          }
        });

        setTimeout(() => {
          void orchestratorService.startReadyAutopilotAttempts({
            runId,
            reason: "coordinator_request_specialist",
          }).catch((error) => {
            logger.debug("coordinator.request_specialist.autopilot_schedule_failed", {
              runId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, 100);

        return {
          ok: true,
          workerId,
          role: roleName,
          stepId: step?.id ?? null,
          toolProfile,
          replacementForWorkerId: replacementSourceWorkerId,
          delegationContract: updateDelegationContract(delegationContract, {
            activeWorkerIds: [workerId],
            status: "active",
            launchState: "waiting_on_worker",
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.request_specialist.error", { role, error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const stop_worker = defineCoordinatorTool({
    description:
      "Stop a running worker by canceling its current attempt.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key (workerId) of the worker to stop"),
      reason: z.string().describe("Reason for stopping the worker"),
    }),
    execute: async ({ workerId, reason }) => {
      try {
        const normalizedReason = typeof reason === "string" ? reason.trim() : "";
        if (!normalizedReason.length) {
          return {
            ok: false,
            error:
              "Cancellation reason is required. stop_worker is a destructive cancel tool; " +
              "use it only when abandoning a stuck or off-track worker, not for normal completion."
          };
        }
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step)
          return { ok: false, error: `Worker not found: ${workerId}` };
        if (stopReasonLooksLikeNormalCompletion(normalizedReason)) {
          return {
            ok: false,
            error:
              "stop_worker is cancel-only. Do not use it to end successful work or advance phases after completion. " +
              "Let the worker finish and read its output instead."
          };
        }
        const attempt = findRunningAttempt(g, step.id);
        if (!attempt)
          return {
            ok: false,
            error: `No running attempt found for worker '${workerId}'`,
          };
        const currentPhase = resolveCurrentPhaseCard(g, resolveMissionPhases(g));
        const currentPhaseKey = currentPhase?.phaseKey.trim().toLowerCase() ?? "";
        if (currentPhaseKey === "planning" && isPlanningExecutionStep(step) && !stopReasonIndicatesHardFailure(normalizedReason)) {
          return {
            ok: false,
            error:
              "Do not cancel the active planning worker just because the coordinator believes planning is complete. " +
              "Wait for the planner to finish, or let runtime surface a concrete failure before retrying."
          };
        }
        await orchestratorService.completeAttempt({
          attemptId: attempt.id,
          status: "canceled",
          errorClass: "canceled",
          errorMessage: normalizedReason,
        });
        logger.info("coordinator.stop_worker", {
          workerId,
          attemptId: attempt.id,
          reason: normalizedReason,
        });
        return { ok: true, workerId, attemptId: attempt.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.stop_worker.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const send_message = defineCoordinatorTool({
    description:
      "Send a message to a specific running worker. The worker will see it as steering input.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key of the target worker"),
      content: z.string().describe("Message content to send"),
    }),
    execute: async ({ workerId, content }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step)
          return {
            ok: false,
            delivered: false,
            reason: "no_active_session" as const,
            error: `Worker not found: ${workerId}`
          };
        const attempt = findRunningAttempt(g, step.id);
        if (!attempt)
          return {
            ok: false,
            delivered: false,
            reason: "no_active_session" as const,
            error: `No running attempt found for worker '${workerId}'`,
          };
        const sessionId = attempt.executorSessionId;
        if (!sessionId)
          return {
            ok: false,
            delivered: false,
            reason: "no_active_session" as const,
            error: `No session ID for running worker '${workerId}'`,
          };
        const messageId = randomUUID();
        const delivery = await deliverToWorkerSession(sessionId, content);
        orchestratorService.appendRuntimeEvent({
          runId,
          stepId: step.id,
          attemptId: attempt.id,
          sessionId,
          eventType: "coordinator_steering",
          payload: {
            message: content,
            priority: "normal",
            messageId,
            delivered: delivery.delivered,
            method: delivery.ok ? delivery.method : null,
            reason: delivery.ok
              ? (delivery.delivered ? null : delivery.reason)
              : delivery.reason
          },
        });
        logger.info("coordinator.send_message", {
          workerId,
          sessionId,
          delivered: delivery.delivered,
          method: delivery.ok ? delivery.method : null,
          reason: delivery.ok
            ? (delivery.delivered ? null : delivery.reason)
            : delivery.reason
        });
        return {
          ...delivery,
          workerId,
          sessionId,
          messageId
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.send_message.error", { workerId, error: msg });
        return { ok: false, delivered: false, reason: "delivery_failed", error: msg };
      }
    },
  });

  const message_worker = defineCoordinatorTool({
    description:
      "Route a message from one worker to another through the coordinator for full visibility.",
    inputSchema: z.object({
      fromWorkerId: z.string().describe("Worker step key of the sender"),
      toWorkerId: z.string().describe("Worker step key of the recipient"),
      content: z.string().describe("Message content"),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    }),
    execute: async ({ fromWorkerId, toWorkerId, content, priority }) => {
      try {
        const g = graph();
        const fromStep = resolveStep(g, fromWorkerId);
        if (!fromStep) {
          return {
            ok: false,
            delivered: false,
            reason: "no_active_session",
            error: `Sender worker not found: ${fromWorkerId}`
          };
        }
        const toStep = resolveStep(g, toWorkerId);
        if (!toStep) {
          return {
            ok: false,
            delivered: false,
            reason: "no_active_session",
            error: `Recipient worker not found: ${toWorkerId}`
          };
        }
        const recipientAttempt = findRunningAttempt(g, toStep.id);
        if (!recipientAttempt?.executorSessionId) {
          return {
            ok: false,
            delivered: false,
            reason: "no_active_session",
            error: `Recipient worker '${toWorkerId}' has no running session.`
          };
        }
        const deliveryPriority = priority === "high" || priority === "urgent" ? "urgent" : "normal";
        const messageId = randomUUID();
        const fromAttemptId = findRunningAttempt(g, fromStep.id)?.id ?? null;
        const delivery = await deliverToWorkerSession(recipientAttempt.executorSessionId, content, deliveryPriority);
        orchestratorService.appendRuntimeEvent({
          runId,
          stepId: toStep.id,
          attemptId: recipientAttempt.id,
          sessionId: recipientAttempt.executorSessionId,
          eventType: "worker_message",
          payload: {
            fromWorkerId,
            toWorkerId,
            message: content,
            priority,
            deliveryPriority,
            messageId,
            delivered: delivery.delivered,
            method: delivery.ok ? delivery.method : null,
            reason: delivery.ok
              ? (delivery.delivered ? null : delivery.reason)
              : delivery.reason,
            fromAttemptId
          },
        });
        orchestratorService.appendTimelineEvent({
          runId,
          stepId: toStep.id,
          attemptId: recipientAttempt.id,
          eventType: "worker_message_routed",
          reason: "message_worker",
          detail: {
            fromWorkerId,
            toWorkerId,
            priority,
            deliveryPriority,
            messageId,
            delivered: delivery.delivered,
            method: delivery.ok ? delivery.method : null,
            reason: delivery.ok
              ? (delivery.delivered ? null : delivery.reason)
              : delivery.reason,
            fromAttemptId
          },
        });
        return {
          ...delivery,
          messageId,
          fromWorkerId,
          toWorkerId,
          priority
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.message_worker.error", {
          fromWorkerId,
          toWorkerId,
          error: msg
        });
        return { ok: false, delivered: false, reason: "delivery_failed", error: msg };
      }
    }
  });

  const broadcast = defineCoordinatorTool({
    description:
      "Broadcast a message to ALL currently running workers.",
    inputSchema: z.object({
      content: z.string().describe("Message content to broadcast"),
    }),
    execute: async ({ content }) => {
      try {
        const g = graph();
        const runningAttempts = g.attempts.filter((a) => a.status === "running");
        const results = await Promise.all(
          runningAttempts.map(async (attempt) => {
            const step = g.steps.find((candidate) => candidate.id === attempt.stepId) ?? null;
            const sessionId = attempt.executorSessionId ?? null;
            const messageId = randomUUID();
            if (!sessionId) {
              return {
                workerId: step?.stepKey ?? null,
                stepId: step?.id ?? attempt.stepId,
                attemptId: attempt.id,
                sessionId: null,
                messageId,
                ok: false as const,
                delivered: false as const,
                reason: "no_active_session" as const,
              };
            }
            const delivery = await deliverToWorkerSession(sessionId, content);
            return {
              workerId: step?.stepKey ?? null,
              stepId: step?.id ?? attempt.stepId,
              attemptId: attempt.id,
              sessionId,
              messageId,
              ...delivery
            };
          })
        );
        const delivered = results.filter((result) => result.ok && result.delivered).length;
        const queued = results.filter((result) => result.ok && !result.delivered).length;
        const failed = results.filter((result) => !result.ok).length;
        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "coordinator_broadcast",
          payload: {
            content,
            recipientCount: results.length,
            delivered,
            queued,
            failed,
            results
          },
        });
        logger.info("coordinator.broadcast", { recipients: results.length, delivered, queued, failed });
        return {
          ok: true,
          recipientCount: results.length,
          delivered,
          queued,
          failed,
          results
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.broadcast.error", { error: msg });
        return { ok: false, error: msg, delivered: false, reason: "delivery_failed" };
      }
    },
  });

  const get_worker_output = defineCoordinatorTool({
    description:
      "Read what a completed (or running) worker has produced. Returns summary, status, files changed, and any errors.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key of the worker to get output for"),
    }),
    execute: async ({ workerId }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step)
          return { ok: false, error: `Worker not found: ${workerId}` };
        const stepMeta = asRecord(step.metadata) ?? {};
        const stepPhaseKey = typeof stepMeta.phaseKey === "string" ? stepMeta.phaseKey.trim().toLowerCase() : "";
        const stepType = typeof stepMeta.stepType === "string" ? stepMeta.stepType.trim().toLowerCase() : "";
        const isReadOnlyPlanningStep =
          stepMeta.readOnlyExecution === true
          || stepPhaseKey === "planning"
          || stepType === "planning";
        // Find the latest completed attempt (succeeded or failed)
        const completedAttempts = g.attempts
          .filter(
            (a) =>
              a.stepId === step.id &&
              (a.status === "succeeded" || a.status === "failed"),
          )
          .sort((a, b) => {
            const at = a.completedAt ?? a.createdAt;
            const bt = b.completedAt ?? b.createdAt;
            return bt.localeCompare(at);
          });
        const latest = completedAttempts[0];
        // Also check for running attempt
        const running = findRunningAttempt(g, step.id);
        const runningCheckKey = step.id;
        if (!latest && !running)
          return {
            ok: false,
            error: `No completed or running attempt found for worker '${workerId}'`,
          };
        if (latest) {
          runningWorkerOutputChecks.delete(runningCheckKey);
          // Extract filesChanged from the result envelope outputs
          const outputs = latest.resultEnvelope?.outputs as Record<string, unknown> | null | undefined;
          let filesChanged: string[] = [];
          if (outputs) {
            const raw = outputs.filesChanged ?? outputs.files_changed ?? [];
            if (Array.isArray(raw)) {
              filesChanged = raw.map((f) => String(f ?? "").trim()).filter(Boolean);
            }
          }
          // Fallback: check worker digest table if no files from envelope
          if (filesChanged.length === 0) {
            try {
              const digestRow = db.get<{ files_changed_json: string | null }>(
                `select files_changed_json from orchestrator_worker_digests where attempt_id = ? limit 1`,
                [latest.id],
              );
              if (digestRow?.files_changed_json) {
                const parsed = JSON.parse(digestRow.files_changed_json);
                if (Array.isArray(parsed)) {
                  filesChanged = parsed.map((f: unknown) => String(f ?? "").trim()).filter(Boolean);
                }
              }
            } catch {
              // Non-fatal: digest lookup failure doesn't block output retrieval
            }
          }
          return {
            ok: true,
            workerId,
            attemptId: latest.id,
            status: latest.status,
            summary: latest.resultEnvelope?.summary ?? null,
            success: latest.resultEnvelope?.success ?? null,
            warnings: latest.resultEnvelope?.warnings ?? [],
            errorMessage: latest.errorMessage ?? null,
            filesChanged,
          };
        }
        const lastStatusReport = asRecord(stepMeta.lastStatusReport);
        const lastStatusReportedAt =
          typeof lastStatusReport?.reportedAt === "string" ? lastStatusReport.reportedAt.trim() : "";
        const signalFingerprint = [
          step.updatedAt ?? "",
          step.startedAt ?? "",
          lastStatusReportedAt,
          running?.id ?? "",
          running?.createdAt ?? "",
        ].join("::");
        const nowMs = Date.now();
        const previousRunningCheck = runningWorkerOutputChecks.get(runningCheckKey) ?? null;
        if (
          previousRunningCheck
          && previousRunningCheck.signalFingerprint === signalFingerprint
          && nowMs - previousRunningCheck.checkedAtMs < RUNNING_WORKER_OUTPUT_RECHECK_COOLDOWN_MS
        ) {
          const remainingSeconds = Math.max(
            1,
            Math.ceil((RUNNING_WORKER_OUTPUT_RECHECK_COOLDOWN_MS - (nowMs - previousRunningCheck.checkedAtMs)) / 1000),
          );
          return {
            ok: false,
            error: isReadOnlyPlanningStep
              ? `Planning worker '${workerId}' is still running and has not produced any new reported output since your last check. Wait for a fresh worker event or at least ${remainingSeconds}s before calling get_worker_output again.`
              : `Worker '${workerId}' is still running and has not produced any new reported output since your last check. Wait for a fresh worker event or at least ${remainingSeconds}s before calling get_worker_output again.`,
            status: "running",
            recheckAfterSeconds: remainingSeconds,
          };
        }
        runningWorkerOutputChecks.set(runningCheckKey, {
          checkedAtMs: nowMs,
          signalFingerprint,
        });
        return {
          ok: true,
          workerId,
          status: "running",
          summary: (() => {
            const nextAction =
              typeof lastStatusReport?.nextAction === "string"
                ? lastStatusReport.nextAction.trim()
                : "";
            const details =
              typeof lastStatusReport?.details === "string"
                ? lastStatusReport.details.trim()
                : "";
            if (details.length > 0) {
              return details;
            }
            if (nextAction.length > 0) {
              return `Worker is still running. Latest next action: ${nextAction}`;
            }
            if (isReadOnlyPlanningStep) {
              return "Planning worker is still running. Planning/research workers can stay quiet for a while before they report back. Do not cancel solely for lack of terminal output unless the session exits or reports an explicit error.";
            }
            return "Worker is still running.";
          })(),
          progressPct:
            Number.isFinite(Number(asRecord(stepMeta.lastStatusReport)?.progressPct))
              ? Number(asRecord(stepMeta.lastStatusReport)?.progressPct)
              : null,
          blockers: Array.isArray(asRecord(stepMeta.lastStatusReport)?.blockers)
            ? (asRecord(stepMeta.lastStatusReport)?.blockers as unknown[])
                .map((entry) => String(entry ?? "").trim())
                .filter((entry) => entry.length > 0)
            : [],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.get_worker_output.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const list_workers = defineCoordinatorTool({
    description:
      "Get status of all workers (active, completed, failed, etc.).",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const g = graph();
        const workers = g.steps
          .filter((s) => s.stepKey !== "__planner__")
          .map((s) => {
            const attempt = findRunningAttempt(g, s.id);
            const latestCompleted = g.attempts
              .filter((a) => a.stepId === s.id && a.status !== "running")
              .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt))[0];
            return {
              workerId: s.stepKey,
              title: s.title,
              status: s.status,
              hasRunningAttempt: !!attempt,
              lastResult: latestCompleted?.status ?? null,
              retryCount: s.retryCount,
            };
          });
        return { ok: true, workers, total: workers.length };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.list_workers.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const report_status = defineCoordinatorTool({
    description:
      "Structured worker-to-coordinator status report with progress, blockers, confidence, and next action.",
    inputSchema: z.object({
      workerId: z.string().describe("Worker step key"),
      progressPct: z.number().min(0).max(100).describe("Percent complete"),
      blockers: z.array(z.string()).default([]).describe("Current blockers"),
      confidence: z.number().min(0).max(1).nullable().optional().describe("Confidence score from 0 to 1"),
      nextAction: z.string().describe("Planned next action"),
      laneId: z.string().nullable().optional().describe("Optional lane context"),
      details: z.string().nullable().optional().describe("Optional extra details"),
    }),
    execute: async ({ workerId, progressPct, blockers, confidence, nextAction, laneId, details }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step) return { ok: false, error: `Worker not found: ${workerId}` };
        const normalizedProgressPct = Math.max(0, Math.min(100, Math.round(Number(progressPct) || 0)));
        const normalizedBlockers = Array.isArray(blockers)
          ? blockers.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
          : [];
        const normalizedConfidence = Number(confidence);
        const normalizedNextAction = typeof nextAction === "string" ? nextAction.trim() : "";
        const normalizedDetails = typeof details === "string" ? details : details == null ? null : String(details);
        const report: WorkerStatusReport = {
          workerId,
          stepId: step.id,
          stepKey: step.stepKey,
          runId,
          missionId,
          progressPct: normalizedProgressPct,
          blockers: normalizedBlockers,
          confidence: Number.isFinite(normalizedConfidence) ? Math.max(0, Math.min(1, normalizedConfidence)) : null,
          nextAction: normalizedNextAction || "continue working",
          laneId: laneId ?? step.laneId,
          details: normalizedDetails,
          reportedAt: nowIso()
        };
        const existingMeta = asRecord(step.metadata) ?? {};
        const metadata = {
          ...existingMeta,
          lastStatusReport: report
        };
        orchestratorService.updateStepMetadata({
          runId,
          stepId: step.id,
          metadata,
          allowTerminal: true,
        });
        orchestratorService.appendRuntimeEvent({
          runId,
          stepId: step.id,
          eventType: "worker_status_report",
          payload: report as unknown as Record<string, unknown>
        });
        orchestratorService.appendTimelineEvent({
          runId,
          stepId: step.id,
          eventType: "worker_status_reported",
          reason: "report_status",
          detail: report as unknown as Record<string, unknown>
        });
        orchestratorService.emitRuntimeUpdate({
          runId,
          stepId: step.id,
          reason: "worker_status_report"
        });
        return { ok: true, report };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.report_status.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const reflection_add = defineCoordinatorTool({
    description:
      "Record a structured reflection entry for mission introspection and retrospective synthesis.",
    inputSchema: z.object({
      workerId: z.string().optional().describe("Optional worker step key used to infer step/attempt scope."),
      stepId: z.string().optional().describe("Optional explicit step ID."),
      attemptId: z.string().optional().describe("Optional explicit attempt ID."),
      agentRole: z.string().optional().describe("Role submitting the reflection (defaults to coordinator)."),
      phase: z.string().min(1).describe("Mission phase where this reflection was observed."),
      signalType: z.enum(["wish", "frustration", "idea", "pattern", "limitation"]),
      observation: z.string().min(1),
      recommendation: z.string().min(1),
      context: z.string().min(1),
      occurredAt: z.string().optional().describe("ISO-8601 timestamp; defaults to now.")
    }),
    execute: async ({ workerId, stepId, attemptId, agentRole, phase, signalType, observation, recommendation, context, occurredAt }) => {
      try {
        const g = graph();
        const resolvedStep = workerId ? resolveStep(g, workerId) : null;
        const resolvedStepId = typeof stepId === "string" && stepId.trim().length > 0
          ? stepId.trim()
          : resolvedStep?.id ?? null;
        const runningAttempt = resolvedStepId
          ? findRunningAttempt(g, resolvedStepId)
          : null;
        const latestAttempt = resolvedStepId
          ? findLatestCompletedAttempt(g, resolvedStepId)
          : null;
        const resolvedAttemptId = typeof attemptId === "string" && attemptId.trim().length > 0
          ? attemptId.trim()
          : runningAttempt?.id ?? latestAttempt?.id ?? null;

        const reflection = orchestratorService.addReflection({
          missionId,
          runId,
          stepId: resolvedStepId,
          attemptId: resolvedAttemptId,
          agentRole: (agentRole ?? "coordinator").trim() || "coordinator",
          phase: phase.trim(),
          signalType,
          observation: observation.trim(),
          recommendation: recommendation.trim(),
          context: context.trim(),
          occurredAt: typeof occurredAt === "string" && occurredAt.trim().length > 0 ? occurredAt.trim() : nowIso()
        });
        return { ok: true, reflection };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.reflection_add.error", { error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const report_result = defineCoordinatorTool({
    description:
      "Structured worker completion report with outcome, artifacts, file changes, and test results.",
    inputSchema: z.object({
      workerId: z.string().describe("Worker step key"),
      outcome: z.enum(["succeeded", "failed", "partial"]).describe("Outcome classification"),
      summary: z.string().describe("Result summary"),
      plan: z.object({
        markdown: z.string().min(1).describe("Markdown plan content for planning/read-only planning steps"),
        summary: z.string().optional().describe("One-line plan summary"),
        title: z.string().optional().describe("Optional display title"),
        format: z.literal("markdown").optional(),
        artifactPath: z.string().optional().describe("Optional canonical relative plan path hint"),
      }).nullable().optional(),
      artifacts: z.array(
        z.object({
          type: z.string(),
          title: z.string(),
          uri: z.string().nullable().optional(),
          metadata: z.record(z.string(), z.unknown()).optional()
        })
      ).default([]),
      filesChanged: z.array(z.string()).default([]),
      testsRun: z.object({
        command: z.string().optional(),
        passed: z.number().int().optional(),
        failed: z.number().int().optional(),
        skipped: z.number().int().optional(),
        raw: z.string().nullable().optional()
      }).nullable().optional(),
      laneId: z.string().nullable().optional(),
    }),
    execute: async ({ workerId, outcome, summary, plan, artifacts, filesChanged, testsRun, laneId }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step) return { ok: false, error: `Worker not found: ${workerId}` };
        const stepMetadata = asRecord(step.metadata) ?? {};
        const stepType = typeof stepMetadata.stepType === "string" ? stepMetadata.stepType.trim().toLowerCase() : "";
        const phaseKey = typeof stepMetadata.phaseKey === "string" ? stepMetadata.phaseKey.trim().toLowerCase() : "";
        const requiresPlanPayload =
          stepType === "planning"
          || stepType === "analysis"
          || phaseKey === "planning";
        const normalizedPlan = (() => {
          const rawPlan = plan;
          return rawPlan && typeof rawPlan.markdown === "string" && rawPlan.markdown.trim().length > 0
            ? {
                markdown: rawPlan.markdown.trim(),
                ...(typeof rawPlan.summary === "string" && rawPlan.summary.trim().length > 0 ? { summary: rawPlan.summary.trim() } : {}),
                ...(typeof rawPlan.title === "string" && rawPlan.title.trim().length > 0 ? { title: rawPlan.title.trim() } : {}),
                ...(rawPlan.format === "markdown" ? { format: "markdown" as const } : {}),
                ...(typeof rawPlan.artifactPath === "string" && rawPlan.artifactPath.trim().length > 0 ? { artifactPath: rawPlan.artifactPath.trim() } : {}),
              }
            : null;
        })();
        if (requiresPlanPayload && outcome === "succeeded" && !normalizedPlan) {
          return {
            ok: false,
            error: "Planning workers must return a non-empty plan.markdown payload in report_result. ADE will persist the plan artifact after completion.",
          };
        }
        const normalizedArtifacts = Array.isArray(artifacts) ? artifacts : [];
        const normalizedFilesChanged = Array.isArray(filesChanged) ? filesChanged : [];
        const normalizedSummary = typeof summary === "string" ? summary.trim() : "";
        const report: WorkerResultReport = {
          workerId,
          stepId: step.id,
          stepKey: step.stepKey,
          runId,
          missionId,
          outcome,
          summary: normalizedSummary || "Worker completed without a structured summary.",
          ...(normalizedPlan ? { plan: normalizedPlan } : {}),
          artifacts: normalizedArtifacts.map((artifact) => ({
            type: typeof artifact?.type === "string" ? artifact.type : "artifact",
            title: typeof artifact?.title === "string" ? artifact.title : "Untitled artifact",
            uri: artifact.uri ?? null,
            metadata: artifact.metadata
          })),
          filesChanged: normalizedFilesChanged.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0),
          testsRun: testsRun
            ? {
                ...(testsRun.command ? { command: testsRun.command } : {}),
                ...(Number.isFinite(Number(testsRun.passed)) ? { passed: Number(testsRun.passed) } : {}),
                ...(Number.isFinite(Number(testsRun.failed)) ? { failed: Number(testsRun.failed) } : {}),
                ...(Number.isFinite(Number(testsRun.skipped)) ? { skipped: Number(testsRun.skipped) } : {}),
                ...(testsRun.raw != null ? { raw: testsRun.raw } : {})
              }
            : null,
          laneId: laneId ?? step.laneId,
          reportedAt: nowIso()
        };
        const existingMeta = asRecord(step.metadata) ?? {};
        const metadata = {
          ...existingMeta,
          lastResultReport: report
        };
        orchestratorService.updateStepMetadata({
          runId,
          stepId: step.id,
          metadata,
          allowTerminal: true,
        });
        orchestratorService.appendRuntimeEvent({
          runId,
          stepId: step.id,
          eventType: "worker_result_report",
          payload: report as unknown as Record<string, unknown>
        });
        orchestratorService.appendTimelineEvent({
          runId,
          stepId: step.id,
          eventType: "worker_result_reported",
          reason: "report_result",
          detail: report as unknown as Record<string, unknown>
        });
        orchestratorService.createHandoff({
          missionId,
          runId,
          stepId: step.id,
          handoffType: "worker_result_report",
          producer: workerId,
          payload: report as unknown as Record<string, unknown>
        });
        orchestratorService.emitRuntimeUpdate({
          runId,
          stepId: step.id,
          reason: "worker_result_report"
        });
        return { ok: true, report };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.report_result.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const report_validation = defineCoordinatorTool({
    description:
      "Structured validator report for step/milestone/mission gates. Persists pass/fail findings and remediation guidance.",
    inputSchema: z.object({
      validatorWorkerId: z.string().optional().describe("Validator worker step key"),
      targetWorkerId: z.string().optional().describe("Target worker step key being validated (optional for mission-level reports)"),
      validationId: z.string().optional().describe("Optional caller-provided validation id"),
      contract: VALIDATION_CONTRACT_SCHEMA,
      verdict: z.enum(["pass", "fail"]),
      summary: z.string(),
      findings: z
        .array(
          z.object({
            code: z.string(),
            severity: z.enum(["low", "medium", "high"]),
            message: z.string(),
            remediation: z.string().optional(),
            references: z.array(z.string()).optional(),
          })
        )
        .default([]),
      remediationInstructions: z.array(z.string()).default([]),
      retriesUsed: z.number().int().min(0).optional(),
    }),
    execute: async ({
      validatorWorkerId,
      targetWorkerId,
      validationId,
      contract,
      verdict,
      summary,
      findings,
      remediationInstructions,
      retriesUsed,
    }) => {
      try {
        const g = graph();
        const normalizedTargetWorkerId = typeof targetWorkerId === "string" ? targetWorkerId.trim() : "";
        const targetStep = normalizedTargetWorkerId ? resolveStep(g, normalizedTargetWorkerId) : null;
        if (normalizedTargetWorkerId && !targetStep) {
          return { ok: false, error: `Target worker not found: ${targetWorkerId}` };
        }
        const validatorStep =
          typeof validatorWorkerId === "string" && validatorWorkerId.trim().length > 0
            ? resolveStep(g, validatorWorkerId.trim())
            : null;
        if (validatorWorkerId && !validatorStep) {
          return { ok: false, error: `Validator worker not found: ${validatorWorkerId}` };
        }

        const existingMeta = asRecord(targetStep?.metadata) ?? {};
        const resolvedContract =
          parseValidationContract(contract ?? null) ??
          parseValidationContract(existingMeta.validationContract ?? null) ?? {
            level: "step",
            tier: "self",
            required: false,
            criteria: "Validation criteria unspecified.",
            evidence: [],
            maxRetries: 1,
          };
        if (!targetStep && resolvedContract.level === "step") {
          return { ok: false, error: "Step-level validation requires targetWorkerId." };
        }
        const history = Array.isArray(existingMeta.validationHistory)
          ? existingMeta.validationHistory.filter((entry) => asRecord(entry))
          : [];
        const priorFailureCount = history.filter((entry) => asRecord(entry)?.verdict === "fail").length;
        const normalizedRetriesUsed = Number.isFinite(Number(retriesUsed))
          ? Math.max(0, Math.min(50, Math.floor(Number(retriesUsed))))
          : verdict === "fail"
            ? priorFailureCount + 1
            : priorFailureCount;
        const findingsInput = Array.isArray(findings) ? findings : [];
        const remediationInput = Array.isArray(remediationInstructions) ? remediationInstructions : [];
        const normalizedFindings = findingsInput
          .map((entry) => parseValidationFinding(entry))
          .filter((entry): entry is ValidationResultReport["findings"][number] => Boolean(entry));
        const normalizedRemediation = remediationInput
          .map((entry) => String(entry ?? "").trim())
          .filter((entry) => entry.length > 0);
        const report: ValidationResultReport = {
          validationId: validationId?.trim().length ? validationId.trim() : randomUUID(),
          scope: {
            runId,
            stepId: targetStep?.id ?? null,
            stepKey: targetStep?.stepKey ?? null,
            missionId,
            laneId: targetStep?.laneId ?? null
          },
          contract: resolvedContract,
          verdict,
          summary: summary.trim(),
          findings: normalizedFindings,
          remediationInstructions: normalizedRemediation,
          retriesUsed: normalizedRetriesUsed,
          createdAt: nowIso(),
          validatorWorkerId: validatorStep?.stepKey ?? validatorWorkerId?.trim() ?? null
        };
        const maxRetriesExceeded = verdict === "fail" && report.retriesUsed >= resolvedContract.maxRetries;
        const targetStepMeta = asRecord(targetStep?.metadata) ?? {};
        const targetIsMilestone = targetStepMeta.isMilestone === true;
        const nextMetadata = {
          ...existingMeta,
          lastValidationReport: report,
          validationHistory: [...history, report].slice(-20),
          validationRetriesUsed: report.retriesUsed,
          validationMaxRetries: resolvedContract.maxRetries,
          validationState: verdict,
          ...(verdict === "pass" ? { validationPassedAt: report.createdAt } : {}),
          ...(maxRetriesExceeded
            ? {
                validationEscalationRequired: true,
                validationEscalatedAt: report.createdAt
              }
            : {})
        };
        if (targetStep) {
          orchestratorService.updateStepMetadata({
            runId,
            stepId: targetStep.id,
            metadata: nextMetadata,
            allowTerminal: true,
          });
        }
        let milestoneMarkedComplete = false;
        if (targetStep && targetIsMilestone && verdict === "pass" && !TERMINAL_STEP_STATUSES.has(targetStep.status)) {
          const ts = nowIso();
          db.run(
            `update orchestrator_steps set status = 'succeeded', completed_at = ?, updated_at = ? where id = ? and run_id = ?`,
            [ts, ts, targetStep.id, runId],
          );
          onDagMutation({
            runId,
            mutation: { type: "status_changed", stepKey: targetStep.stepKey, newStatus: "succeeded" },
            timestamp: ts,
            source: "coordinator",
          });
          setTimeout(() => {
            void orchestratorService.startReadyAutopilotAttempts({
              runId,
              reason: "milestone_validation_passed",
            }).catch((error) => {
              logger.debug("coordinator.report_validation.autopilot_schedule_failed", {
                runId,
                stepKey: targetStep.stepKey,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }, 100);
          milestoneMarkedComplete = true;
        }
        orchestratorService.appendRuntimeEvent({
          runId,
          stepId: targetStep?.id ?? null,
          eventType: "validation_report",
          payload: {
            ...(report as unknown as Record<string, unknown>),
            maxRetriesExceeded
          }
        });
        orchestratorService.appendTimelineEvent({
          runId,
          stepId: targetStep?.id ?? null,
          eventType: "validation_reported",
          reason: "report_validation",
          detail: {
            validationId: report.validationId,
            validatorWorkerId: report.validatorWorkerId ?? null,
            verdict,
            retriesUsed: report.retriesUsed,
            maxRetries: resolvedContract.maxRetries
          }
        });
        orchestratorService.createHandoff({
          missionId,
          runId,
          stepId: targetStep?.id ?? null,
          handoffType: "validation_report",
          producer: report.validatorWorkerId ?? "validator",
          payload: report as unknown as Record<string, unknown>
        });
        orchestratorService.emitRuntimeUpdate({
          runId,
          stepId: targetStep?.id ?? validatorStep?.id ?? null,
          reason: "validation_report"
        });
        if (maxRetriesExceeded) {
          orchestratorService.appendTimelineEvent({
            runId,
            stepId: targetStep?.id ?? null,
            eventType: "validation_escalated",
            reason: "validation_retry_exhausted",
            detail: {
              validationId: report.validationId,
              retriesUsed: report.retriesUsed,
              maxRetries: resolvedContract.maxRetries
            }
          });
        }
        let escalationInterventionId: string | null = null;
        if (maxRetriesExceeded && resolvedContract.required) {
          const findingSummary = report.findings.slice(0, 3).map((entry) => `${entry.code}: ${entry.message}`).join("; ");
          const escalationQuestion = targetStep
            ? `Validation retries exhausted for "${targetStep.stepKey}". Should we continue with a workaround, re-scope, or pause this mission?`
            : "Validation retries exhausted for a required contract. Should we continue with a workaround, re-scope, or pause this mission?";
          const escalationContext = [
            `Validation contract tier: ${resolvedContract.tier}`,
            `Validation level: ${resolvedContract.level}`,
            `Retries used: ${report.retriesUsed}/${resolvedContract.maxRetries}`,
            `Summary: ${report.summary}`,
            findingSummary.length > 0 ? `Findings: ${findingSummary}` : null,
          ]
            .filter((entry): entry is string => Boolean(entry))
            .join("\n");
          const escalation = openHumanIntervention({
            question: escalationQuestion,
            context: escalationContext,
            urgency: "high",
            source: "request_user_input",
            canProceedWithoutAnswer: false,
          });
          if (escalation.ok) {
            escalationInterventionId = escalation.interventionId;
          }
        }
        return {
          ok: true,
          report,
          maxRetriesExceeded,
          milestoneMarkedComplete,
          interventionId: escalationInterventionId,
          recommendedAction: maxRetriesExceeded
            ? "escalate_human_or_replan"
            : verdict === "fail"
              ? "rework_same_lane"
              : "proceed"
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.report_validation.error", { targetWorkerId: targetWorkerId ?? null, error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const read_mission_status = defineCoordinatorTool({
    description:
      "Read current mission state including active/completed steps, worker status reports, and staleness signals.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const g = graph();
        const relevantSteps = filterExecutionSteps(g.steps);
        const activeSteps = relevantSteps.filter((step) => !TERMINAL_STEP_STATUSES.has(step.status));
        const completedSteps = relevantSteps.filter((step) => TERMINAL_STEP_STATUSES.has(step.status));
        const openObligations = relevantSteps.flatMap((step) => {
          const stepMeta = asRecord(step.metadata) ?? {};
          const lastStatusReport = asRecord(stepMeta.lastStatusReport);
          const lastResultReport = asRecord(stepMeta.lastResultReport);
          const lastValidationReport = asRecord(stepMeta.lastValidationReport);
          const validationContract = parseValidationContract(stepMeta.validationContract ?? null);
          const runningAttempt = g.attempts.some((attempt) => attempt.stepId === step.id && attempt.status === "running");
          const obligations: Array<{
            code: string;
            stepKey: string;
            stepId: string;
            laneId: string | null;
            severity: "low" | "medium" | "high";
            summary: string;
          }> = [];
          if (runningAttempt && !lastStatusReport) {
            obligations.push({
              code: "missing_status_report",
              stepKey: step.stepKey,
              stepId: step.id,
              laneId: step.laneId,
              severity: "medium",
              summary: "Running worker has not submitted a structured status report."
            });
          }
          if (
            (step.status === "succeeded" || step.status === "failed") &&
            stepMeta.spawnedByCoordinator === true &&
            !lastResultReport
          ) {
            obligations.push({
              code: "missing_result_report",
              stepKey: step.stepKey,
              stepId: step.id,
              laneId: step.laneId,
              severity: "high",
              summary: "Completed worker has no structured result report."
            });
          }
          if (validationContract?.required && !lastValidationReport) {
            obligations.push({
              code: "missing_validation_report",
              stepKey: step.stepKey,
              stepId: step.id,
              laneId: step.laneId,
              severity: "high",
              summary: "Required validation contract has no validator report."
            });
          }
          if (
            validationContract &&
            lastValidationReport?.verdict === "fail" &&
            stepMeta.validationEscalationRequired !== true
          ) {
            obligations.push({
              code: "validation_rework_pending",
              stepKey: step.stepKey,
              stepId: step.id,
              laneId: step.laneId,
              severity: "high",
              summary: "Validation failed and requires coordinator rework routing."
            });
          }
          return obligations;
        });
        const workerReports = relevantSteps
          .map((step) => ({
            workerId: step.stepKey,
            stepId: step.id,
            status: step.status,
            laneId: step.laneId,
            lastStatusReport: asRecord(step.metadata)?.lastStatusReport ?? null,
            lastResultReport: asRecord(step.metadata)?.lastResultReport ?? null,
            lastValidationReport: asRecord(step.metadata)?.lastValidationReport ?? null,
            validationContract: parseValidationContract(asRecord(step.metadata)?.validationContract ?? null)
          }));
        return {
          ok: true,
          missionId,
          runId,
          runStatus: g.run.status,
          counts: {
            total: relevantSteps.length,
            active: activeSteps.length,
            completed: completedSteps.length,
            runningAttempts: g.attempts.filter((attempt) => attempt.status === "running").length
          },
          activeSteps: activeSteps.map((step) => ({
            stepId: step.id,
            stepKey: step.stepKey,
            title: step.title,
            status: step.status,
            laneId: step.laneId
          })),
          completedSteps: completedSteps.map((step) => ({
            stepId: step.id,
            stepKey: step.stepKey,
            status: step.status
          })),
          workerReports,
          openObligations,
          stalenessSignals: buildStalenessSignals(g)
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.read_mission_status.error", { error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const read_mission_state = defineCoordinatorTool({
    description:
      "Read the durable mission state document from disk. Use this to refresh your understanding before major decisions.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const state = await readMissionStateDocument({
          projectRoot,
          runId,
        });
        return {
          ok: true,
          exists: Boolean(state),
          state,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.read_mission_state.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const update_mission_state = defineCoordinatorTool({
    description:
      "Write a partial update into the durable mission state document (merge semantics). Use after significant decisions and updates.",
    inputSchema: z
      .object({
        addStepOutcome: STEP_OUTCOME_SCHEMA.optional(),
        updateStepOutcome: z
          .object({
            stepKey: z.string(),
            updates: STEP_OUTCOME_PARTIAL_SCHEMA,
          })
          .optional(),
        addDecision: DECISION_SCHEMA.optional(),
        addIssue: ISSUE_SCHEMA.optional(),
        resolveIssue: z.object({ id: z.string(), resolution: z.string() }).optional(),
        updateProgress: PROGRESS_PARTIAL_SCHEMA.optional(),
      })
      .refine(
        (value) =>
          Boolean(
            value.addStepOutcome ||
            value.updateStepOutcome ||
            value.addDecision ||
            value.addIssue ||
            value.resolveIssue ||
            value.updateProgress
          ),
        { message: "At least one mission state update field is required." }
      ),
    execute: async ({ addStepOutcome, updateStepOutcome, addDecision, addIssue, resolveIssue, updateProgress }) => {
      try {
        const graphSnapshot = graph();
        const patch: MissionStateDocumentPatch = {
          updateProgress: {
            ...buildMissionStateProgress(graphSnapshot),
            ...(updateProgress ?? {}),
          },
        };
        if (addStepOutcome) patch.addStepOutcome = addStepOutcome as MissionStateStepOutcome;
        if (updateStepOutcome) {
          patch.updateStepOutcome = {
            stepKey: updateStepOutcome.stepKey,
            updates: updateStepOutcome.updates as MissionStateStepOutcomePartial,
          };
        }
        if (addDecision) patch.addDecision = addDecision as MissionStateDecision;
        if (addIssue) patch.addIssue = addIssue as MissionStateIssue;
        if (resolveIssue) patch.resolveIssue = resolveIssue;

        const nextState = await updateMissionStateDocument({
          projectRoot,
          missionId,
          runId,
          goal: resolveMissionGoal(),
          patch,
          initialProgress: buildMissionStateProgress(graphSnapshot),
        });
        return {
          ok: true,
          state: nextState,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.update_mission_state.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const memory_search = defineCoordinatorTool({
    description:
      "Search project memory BEFORE starting work that might repeat past mistakes. Use at mission start for orientation, before architectural decisions, before writing worker briefs on unfamiliar subsystems, and when you hit unexpected behavior that might be a known gotcha. Do NOT search for things discoverable via get_project_context, read_file, search_files, or git history.",
    inputSchema: z.object({
      query: z.string().describe("Search query for relevant memory"),
      scope: z.enum(["project", "agent", "mission"]).optional().describe("Optional scope filter"),
      scopeOwnerId: z.string().optional().describe("Optional explicit owner id for agent/mission scope"),
      limit: z.number().int().min(1).max(20).optional().default(5).describe("Maximum number of memory hits to return"),
    }),
    execute: async ({ query, scope, scopeOwnerId, limit }) => {
      try {
        if (!memoryService || !projectId) {
          return { ok: false, error: "Project memory is not configured for this coordinator." };
        }
        const effectiveLimit = limit ?? 5;
        const memories = scope === "mission"
          ? await memoryService.searchAcrossScopeOwners({
              projectId,
              query,
              scope: "mission",
              scopeOwnerIds: [missionId, runId, scopeOwnerId ?? null],
              limit: effectiveLimit,
            })
          : await memoryService.search({
              projectId,
              query,
              ...(scope ? { scope } : {}),
              ...(scope ? { scopeOwnerId: resolveMemoryScopeOwnerId(scope, scopeOwnerId) ?? null } : {}),
              limit: effectiveLimit,
            });
        return {
          ok: true,
          memories: memories.map((memory) => ({
            id: memory.id,
            scope: memory.scope,
            scopeOwnerId: memory.scopeOwnerId,
            status: memory.status,
            category: memory.category,
            content: memory.content,
            importance: memory.importance,
            confidence: memory.confidence,
            pinned: memory.pinned,
            sourceRunId: memory.sourceRunId,
            createdAt: memory.createdAt,
          })),
          count: memories.length,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.memory_search.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const memory_add = defineCoordinatorTool({
    description: `Persist a durable insight to project memory. Quality bar: "Would a developer joining this project find this useful on their first day?" If not, do not save it.

GOOD memories (save these):
- "Convention: always use snake_case for database columns — the ORM breaks with camelCase"
- "Decision: chose PostgreSQL over MongoDB because we need ACID transactions for payment processing"
- "Pitfall: the CI pipeline silently skips tests if the test file doesn't match *.test.ts pattern"
- "Pattern: all API routes must call validateSession() before accessing req.user — middleware doesn't cover /internal/* paths"

BAD memories (never save these):
- File paths, doc paths, or directory listings (derivable from the project)
- Raw error messages or stack traces without a lesson learned
- Task/mission progress, status updates, or session metadata
- Things findable via git log, git blame, or reading existing code
- Obvious patterns already visible in the codebase

Format: Lead with the concrete rule or fact, then brief context for WHY. One actionable insight per memory.`,
    inputSchema: z.object({
      content: z.string().describe("A single actionable insight — lead with the rule/fact, then brief WHY"),
      category: z.enum(["fact", "convention", "pattern", "decision", "gotcha", "preference"]).describe("Memory category"),
      scope: z.enum(["project", "agent", "mission"]).optional().default("project").describe("Where to store the memory"),
      scopeOwnerId: z.string().optional().describe("Optional explicit owner id for agent/mission scope"),
      importance: z.enum(["low", "medium", "high"]).optional().default("medium").describe("Memory importance"),
      pin: z.boolean().optional().default(false).describe("Pin this memory into Tier-1 context"),
      writeMode: z.enum(["default", "strict"]).optional().default("default").describe("Write gate strictness"),
    }),
    execute: async ({ content, category, scope, scopeOwnerId, importance, pin, writeMode }) => {
      try {
        if (!memoryService || !projectId) {
          return { ok: false, error: "Project memory is not configured for this coordinator." };
        }
        const effectiveScope = scope ?? "project";
        const effectiveImportance = importance ?? "medium";
        const effectivePin = pin ?? false;
        const effectiveWriteMode = writeMode ?? "default";
        const result = memoryService.writeMemory({
          projectId,
          scope: effectiveScope,
          scopeOwnerId: resolveMemoryScopeOwnerId(effectiveScope, scopeOwnerId),
          tier: effectivePin ? 1 : 2,
          category,
          content,
          importance: effectiveImportance,
          pinned: effectivePin,
          status: "promoted",
          confidence: 1,
          sourceType: "system",
          sourceRunId: runId,
          sourceId: `coordinator:${runId}`,
          writeGateMode: effectiveWriteMode,
        });

        if (!result.accepted || !result.memory) {
          return {
            ok: false,
            error: result.reason ?? "Project memory write was rejected.",
          };
        }

        return {
          ok: true,
          saved: true,
          id: result.memory.id,
          tier: result.memory.tier,
          deduped: result.deduped === true,
          mergedIntoId: result.mergedIntoId ?? null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.memory_add.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const revise_plan = defineCoordinatorTool({
    description:
      "Revise mission plan by partially or fully replacing steps. Replaced steps are marked superseded (not deleted).",
    inputSchema: z.object({
      mode: z.enum(["partial", "full"]).default("partial"),
      replaceStepKeys: z.array(z.string()).default([]),
      replacementMap: z
        .array(
          z.object({
            oldStepKey: z.string(),
            newStepKey: z.string().nullable().optional(),
          })
        )
        .default([])
        .describe("Explicit supersede mapping. Runtime will not infer replacement targets when this is provided."),
      dependencyPatches: z
        .array(
          z.object({
            stepKey: z.string(),
            dependencyStepKeys: z.array(z.string()),
          })
        )
        .default([])
        .describe("Explicit dependency updates to apply after replanning."),
      reason: z.string().describe("Why replanning is needed"),
      newSteps: z.array(
        z.object({
          key: z.string(),
          title: z.string(),
          description: z.string(),
          dependsOn: z.array(z.string()).default([]),
          modelId: z.string().optional(),
          role: z.string().optional(),
          laneId: z.string().nullable().optional(),
          replaces: z.array(z.string()).default([]),
          validationContract: VALIDATION_CONTRACT_SCHEMA,
        })
      ).default([]),
    }),
    execute: async ({ mode, replaceStepKeys, replacementMap, dependencyPatches, reason, newSteps }) => {
      try {
        const initialGraph = graph();
        const normalizedReason = normalizeText(reason) || "Plan revision requested.";
        const normalizedNewSteps = Array.isArray(newSteps) ? newSteps : [];
        const normalizedReplacementMap = Array.isArray(replacementMap) ? replacementMap : [];
        const normalizedDependencyPatches = Array.isArray(dependencyPatches) ? dependencyPatches : [];
        const normalizedReplaceStepKeys = dedupeKeys(replaceStepKeys);
        const replacementTargets = (() => {
          if (mode === "full") {
            return initialGraph.steps
              .filter((step) => !TERMINAL_STEP_STATUSES.has(step.status))
              .map((step) => step.stepKey);
          }
          return [
            ...normalizedReplaceStepKeys,
            ...normalizedReplacementMap
              .map((entry) => normalizeText((entry as { oldStepKey?: unknown }).oldStepKey))
              .filter((entry) => entry.length > 0),
            ...normalizedNewSteps.flatMap((entry) => dedupeKeys((entry as { replaces?: unknown[] }).replaces))
          ].filter((entry) => entry.length > 0);
        })();
        const uniqueTargets = [...new Set(replacementTargets)];
        if (!uniqueTargets.length && normalizedNewSteps.length === 0 && normalizedDependencyPatches.length === 0) {
          return { ok: false, error: "No steps selected for replacement." };
        }

        // Hard cap check: refuse to spawn replacement workers if budget hard caps are triggered
        if (normalizedNewSteps.length > 0) {
          const budgetCheck = await checkBudgetHardCaps({
            failClosedOnTelemetryError: true,
            operation: "revise_plan",
          });
          if (budgetCheck.blocked) {
            logger.warn("coordinator.revise_plan.hard_cap_blocked", { detail: budgetCheck.detail });
            return {
              ok: false,
              error: `Cannot revise plan (spawning blocked): ${budgetCheck.detail}. Mission pausing.`,
              hardCapTriggered: true,
              hardCaps: budgetCheck.hardCaps,
            };
          }
        }

        const teamRuntime = resolveTeamRuntimeConfig(initialGraph);
        const stepByKey = new Map(initialGraph.steps.map((step) => [step.stepKey, step] as const));
        const existingStepKeys = new Set(initialGraph.steps.map((step) => step.stepKey));
        const requestNewStepKeys = new Set<string>();
        const knownStepKeysAfterCreation = new Set(existingStepKeys);
        const parsedNewSteps: Array<{
          key: string;
          title: string;
          description: string;
          modelId: string;
          roleName: string | null;
          laneId: string | null;
          dependsOn: string[];
          replaces: string[];
          parsedContract: ValidationContract | null;
          replacementSourceStep: OrchestratorStep | null;
        }> = [];
        const parsedDependencyPatches: Array<{ stepKey: string; dependencyStepKeys: string[] }> = [];
        const replacementPlanByOldStepKey = new Map<string, string | null>();

        for (const targetKey of uniqueTargets) {
          if (!stepByKey.has(targetKey)) {
            return { ok: false, error: `Replacement target step '${targetKey}' was not found.` };
          }
        }

        for (const entry of normalizedNewSteps) {
          const normalizedKey = normalizeText(entry.key);
          if (!normalizedKey.length) {
            return { ok: false, error: "Each new plan step requires a non-empty key." };
          }
          const normalizedTitle = normalizeText(entry.title);
          if (!normalizedTitle.length) {
            return { ok: false, error: `New step '${normalizedKey}' requires a non-empty title.` };
          }
          const normalizedDescription = normalizeText(entry.description);
          if (!normalizedDescription.length) {
            return { ok: false, error: `New step '${normalizedKey}' requires a non-empty description.` };
          }
          if (requestNewStepKeys.has(normalizedKey)) {
            return { ok: false, error: `Duplicate new step key '${normalizedKey}' in revise_plan request.` };
          }
          const replaces = dedupeKeys(entry.replaces);
          const unknownReplacements = replaces.filter((candidate) => !stepByKey.has(candidate));
          if (unknownReplacements.length > 0) {
            return {
              ok: false,
              error: `Step '${normalizedKey}' replaces unknown step keys: ${unknownReplacements.join(", ")}`
            };
          }
          if (
            existingStepKeys.has(normalizedKey) &&
            !uniqueTargets.includes(normalizedKey) &&
            !replaces.includes(normalizedKey)
          ) {
            return { ok: false, error: `Step key '${normalizedKey}' already exists.` };
          }
          const normalizedRole = normalizeText(entry.role);
          const roleDef = normalizedRole.length > 0 ? resolveRoleDefinition(teamRuntime, normalizedRole) : null;
          if (normalizedRole.length > 0 && !roleDef) {
            return { ok: false, error: `Unknown role '${normalizedRole}' in active team template.` };
          }
          const parsedContract = parseValidationContract(entry.validationContract ?? null);
          if (entry.validationContract && !parsedContract) {
            return { ok: false, error: `Invalid validation contract for step '${entry.key}'.` };
          }
          const dependsOn = normalizeDependencyReferences({
            graph: initialGraph,
            refs: entry.dependsOn,
            label: `Revised step '${normalizedKey}'`,
            additionalKnownKeys: knownStepKeysAfterCreation,
          });
          const replacementSourceStep = replaces.length > 0 ? (stepByKey.get(replaces[0]) ?? null) : null;
          const modelOverride = normalizeText(entry.modelId);
          const spawnPolicy = authorizeWorkerSpawnPolicy({
            g: initialGraph,
            requestedModelId: modelOverride,
          });
          if (!spawnPolicy.ok) {
            return { ok: false, error: spawnPolicy.error };
          }
          parsedNewSteps.push({
            key: normalizedKey,
            title: normalizedTitle,
            description: normalizedDescription,
            modelId: spawnPolicy.resolvedModelId,
            roleName: normalizedRole.length > 0 ? normalizedRole : null,
            laneId: entry.laneId ?? replacementSourceStep?.laneId ?? null,
            dependsOn,
            replaces,
            parsedContract,
            replacementSourceStep,
          });
          requestNewStepKeys.add(normalizedKey);
          knownStepKeysAfterCreation.add(normalizedKey);
          for (const replacedKey of replaces) {
            replacementPlanByOldStepKey.set(replacedKey, normalizedKey);
          }
        }

        for (const planned of parsedNewSteps) {
          const unknownDeps = planned.dependsOn.filter((depKey) => !knownStepKeysAfterCreation.has(depKey));
          if (unknownDeps.length > 0) {
            return {
              ok: false,
              error: `New step '${planned.key}' references unknown dependency keys: ${unknownDeps.join(", ")}`
            };
          }
        }

        for (const entry of normalizedReplacementMap) {
          const oldStepKey = normalizeText(entry.oldStepKey);
          if (!oldStepKey.length) continue;
          if (!stepByKey.has(oldStepKey)) {
            return { ok: false, error: `replacementMap references unknown oldStepKey '${oldStepKey}'.` };
          }
          const newStepKey = normalizeText(entry.newStepKey);
          if (!newStepKey.length) {
            replacementPlanByOldStepKey.set(oldStepKey, null);
            continue;
          }
          if (!knownStepKeysAfterCreation.has(newStepKey)) {
            return { ok: false, error: `replacementMap references unknown newStepKey '${newStepKey}'.` };
          }
          replacementPlanByOldStepKey.set(oldStepKey, newStepKey);
        }

        for (const patch of normalizedDependencyPatches) {
          const stepKey = normalizeText(patch.stepKey);
          if (!stepKey.length) continue;
          if (!knownStepKeysAfterCreation.has(stepKey)) {
            return { ok: false, error: `dependencyPatches references unknown step '${stepKey}'.` };
          }
          const nextDeps = normalizeDependencyReferences({
            graph: initialGraph,
            refs: patch.dependencyStepKeys,
            label: `Dependency patch '${stepKey}'`,
            additionalKnownKeys: knownStepKeysAfterCreation,
          });
          const unknownDeps = nextDeps.filter((depKey) => !knownStepKeysAfterCreation.has(depKey));
          if (unknownDeps.length > 0) {
            return {
              ok: false,
              error: `dependencyPatches for '${stepKey}' references unknown dependency keys: ${unknownDeps.join(", ")}`
            };
          }
          parsedDependencyPatches.push({ stepKey, dependencyStepKeys: nextDeps });
        }

        const createdSteps: OrchestratorStep[] = [];
        const createdStepByKey = new Map<string, OrchestratorStep>();
        for (const plannedStep of parsedNewSteps) {
          const spawnResult = spawnWorkerStep({
            stepKey: plannedStep.key,
            name: plannedStep.title,
            modelId: plannedStep.modelId,
            prompt: plannedStep.description,
            dependsOn: plannedStep.dependsOn,
            roleName: plannedStep.roleName,
            laneId: plannedStep.laneId,
            replacementForWorkerId: plannedStep.replacementSourceStep?.stepKey ?? null,
            replacementReason: `Plan revised: ${normalizedReason}`,
            validationContract: plannedStep.parsedContract
          });
          if (spawnResult.step) {
            createdSteps.push(spawnResult.step);
            createdStepByKey.set(spawnResult.step.stepKey, spawnResult.step);
            onDagMutation({
              runId,
              mutation: { type: "step_added", step: spawnResult.step },
              timestamp: nowIso(),
              source: "coordinator",
            });
          }
        }

        const replacementByOldStepKey = new Map<string, OrchestratorStep | null>();
        for (const [oldStepKey, newStepKey] of replacementPlanByOldStepKey.entries()) {
          if (!newStepKey?.length) {
            replacementByOldStepKey.set(oldStepKey, null);
            continue;
          }
          const mappedStep = createdStepByKey.get(newStepKey) ?? resolveStep(graph(), newStepKey);
          if (!mappedStep) {
            throw new Error(`Replacement step '${newStepKey}' is unavailable while applying revise_plan.`);
          }
          replacementByOldStepKey.set(oldStepKey, mappedStep);
        }

        const superseded: Array<{ stepKey: string; replacementStepKey: string | null }> = [];
        for (const targetKey of uniqueTargets) {
          const g = graph();
          const targetStep = resolveStep(g, targetKey);
          if (!targetStep) continue;
          if (TERMINAL_STEP_STATUSES.has(targetStep.status)) continue;
          const replacement = replacementByOldStepKey.get(targetKey) ?? null;
          const next = await orchestratorService.supersedeStep({
            runId,
            stepId: targetStep.id,
            replacementStepId: replacement?.id ?? null,
            replacementStepKey: replacement?.stepKey ?? null,
            reason: normalizedReason
          });
          superseded.push({
            stepKey: targetStep.stepKey,
            replacementStepKey: replacement?.stepKey ?? null
          });
          onDagMutation({
            runId,
            mutation: { type: "status_changed", stepKey: next.stepKey, newStatus: "superseded" },
            timestamp: nowIso(),
            source: "coordinator",
          });
        }

        const postSupersede = graph();
        for (const patch of parsedDependencyPatches) {
          const targetStep = resolveStep(postSupersede, patch.stepKey);
          if (!targetStep) {
            throw new Error(`Dependency patch target step '${patch.stepKey}' is unavailable while applying revise_plan.`);
          }
          const nextDeps = patch.dependencyStepKeys;
          orchestratorService.updateStepDependencies({
            runId,
            stepId: targetStep.id,
            dependencyStepKeys: nextDeps
          });
          onDagMutation({
            runId,
            mutation: { type: "dependency_changed", stepKey: targetStep.stepKey, newDeps: nextDeps },
            timestamp: nowIso(),
            source: "coordinator",
          });
        }

        const refreshed = graph();
        const supersededIds = new Set(refreshed.steps.filter((step) => step.status === "superseded").map((step) => step.id));
        const danglingDependencySteps = refreshed.steps
          .filter((step) => !TERMINAL_STEP_STATUSES.has(step.status))
          .filter((step) => step.dependencyStepIds.some((depId) => supersededIds.has(depId)))
          .map((step) => step.stepKey);
        const warnings: string[] = [];
        if (danglingDependencySteps.length > 0) {
          warnings.push(
            `Steps depend on superseded predecessors and require explicit dependency patching: ${[...new Set(danglingDependencySteps)].join(", ")}`
          );
        }

        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "plan_revised",
          payload: {
            mode,
            reason: normalizedReason,
            replacedStepKeys: uniqueTargets,
            newStepKeys: createdSteps.map((step) => step.stepKey),
            dependencyPatchesApplied: normalizedDependencyPatches.length,
            warnings
          }
        });
        orchestratorService.appendTimelineEvent({
          runId,
          eventType: "plan_revised",
          reason: "revise_plan",
          detail: {
            mode,
            reason: normalizedReason,
            superseded,
            newStepKeys: createdSteps.map((step) => step.stepKey),
            dependencyPatchesApplied: normalizedDependencyPatches.length,
            warnings
          }
        });

        setTimeout(() => {
          void orchestratorService.startReadyAutopilotAttempts({
            runId,
            reason: "coordinator_revise_plan",
          }).catch((error) => {
            logger.debug("coordinator.revise_plan.autopilot_schedule_failed", {
              runId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, 100);

        return {
          ok: true,
          mode,
          reason: normalizedReason,
          superseded,
          newStepKeys: createdSteps.map((step) => step.stepKey),
          dependencyPatchesApplied: normalizedDependencyPatches.length,
          warnings
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.revise_plan.error", { error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const update_tool_profiles = defineCoordinatorTool({
    description:
      "Update role-bound tool profiles during a run. Useful when conditions change mid-mission.",
    inputSchema: z.object({
      role: z.string().describe("Role name to update"),
      allowedTools: z.array(z.string()).min(1),
      blockedTools: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }),
    execute: async ({ role, allowedTools, blockedTools, notes }) => {
      try {
        const runRow = db.get<{ metadata_json: string | null }>(
          `select metadata_json from orchestrator_runs where id = ? limit 1`,
          [runId]
        );
        if (!runRow) return { ok: false, error: `Run not found: ${runId}` };
        const metadata = runRow.metadata_json ? (JSON.parse(runRow.metadata_json) as Record<string, unknown>) : {};
        const teamRuntime = asRecord(metadata.teamRuntime) ?? {};
        const currentProfiles = asRecord(teamRuntime.toolProfiles) ?? {};
        const normalizedRole = normalizeText(role).toLowerCase();
        if (!normalizedRole.length) {
          return { ok: false, error: "Role is required." };
        }
        currentProfiles[normalizedRole] = {
          allowedTools: dedupeKeys(allowedTools),
          ...(Array.isArray(blockedTools) && blockedTools.length > 0
            ? { blockedTools: dedupeKeys(blockedTools) }
            : {}),
          ...(normalizeText(notes).length > 0 ? { notes: normalizeText(notes) } : {})
        };
        metadata.teamRuntime = {
          ...teamRuntime,
          enabled: teamRuntime.enabled === true,
          toolProfiles: currentProfiles
        };
        db.run(
          `update orchestrator_runs set metadata_json = ?, updated_at = ? where id = ?`,
          [JSON.stringify(metadata), nowIso(), runId]
        );
        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "tool_profiles_updated",
          payload: {
            role: normalizedRole,
            allowedTools: currentProfiles[normalizedRole]
          }
        });
        orchestratorService.appendTimelineEvent({
          runId,
          eventType: "tool_profiles_updated",
          reason: "update_tool_profiles",
          detail: {
            role: normalizedRole,
            allowedToolCount: (currentProfiles[normalizedRole] as Record<string, unknown>)?.allowedTools instanceof Array
              ? ((currentProfiles[normalizedRole] as Record<string, unknown>).allowedTools as unknown[]).length
              : 0
          }
        });
        return { ok: true, role: normalizedRole };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.update_tool_profiles.error", { error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const transfer_lane = defineCoordinatorTool({
    description:
      "Transfer a step to a different lane. Lane transfers are explicit coordinator actions and fully logged.",
    inputSchema: z.object({
      workerId: z.string().describe("Worker step key to transfer"),
      laneId: z.string().nullable().describe("Destination lane id (or null to unassign)"),
      reason: z.string().describe("Why the lane transfer is needed"),
    }),
    execute: async ({ workerId, laneId, reason }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step) return { ok: false, error: `Worker not found: ${workerId}` };
        const updated = orchestratorService.transferStepLane({
          runId,
          stepId: step.id,
          laneId,
          reason,
          transferredBy: "coordinator"
        });
        orchestratorService.appendRuntimeEvent({
          runId,
          stepId: step.id,
          eventType: "lane_transfer",
          payload: {
            workerId,
            fromLaneId: step.laneId,
            toLaneId: laneId,
            reason
          }
        });
        return {
          ok: true,
          workerId,
          fromLaneId: step.laneId,
          toLaneId: updated.laneId
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.transfer_lane.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const provision_lane = defineCoordinatorTool({
    description:
      "Create a new lane (git worktree) branching from the base lane. Use this when you need to isolate parallel workstreams or when tasks might touch overlapping files.",
    inputSchema: z.object({
      name: z.string().describe("Human-readable name for the lane (e.g. 'auth-backend', 'ui-refactor')"),
      description: z.string().optional().describe("Optional description of what this lane is for"),
    }),
    execute: async ({ name, description }) => {
      if (!deps.provisionLane) {
        return { ok: false, error: "Lane provisioning is not available (no lane service configured)." };
      }
      try {
        const result = await deps.provisionLane(name, description);
        return { ok: true, laneId: result.laneId, name: result.name };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.provision_lane.error", { name, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  // ─── Task Management ──────────────────────────────────────────

  const set_current_phase = defineCoordinatorTool({
    description:
      "Set the active mission phase. Use after planning is complete to transition into implementation/testing/validation phases.",
    inputSchema: z.object({
      phaseKey: z.string().describe("Phase key to activate, for example: planning, development, testing, validation"),
      reason: z.string().optional().describe("Optional reason for the phase transition"),
    }),
    execute: async ({ phaseKey, reason }) => {
      try {
        const g = graph();
        const missionPhases = [...resolveMissionPhases(g)].sort((a, b) => a.position - b.position);
        if (missionPhases.length === 0) {
          return { ok: false, error: "Mission phase configuration is unavailable." };
        }
        const normalizedKey = phaseKey.trim();
        if (!normalizedKey.length) {
          return { ok: false, error: "phaseKey is required." };
        }
        const targetPhase = missionPhases.find((phase) => phase.phaseKey === normalizedKey);
        if (!targetPhase) {
          return {
            ok: false,
            error: `Unknown phase '${normalizedKey}'. Available phases: ${missionPhases.map((phase) => phase.phaseKey).join(", ")}`
          };
        }

        const currentPhase = resolveCurrentPhaseCard(g, missionPhases);
        if (currentPhase?.phaseKey === targetPhase.phaseKey) {
          return {
            ok: true,
            changed: false,
            currentPhaseKey: currentPhase.phaseKey,
            currentPhaseName: currentPhase.name,
          };
        }

        const hasSuccessfulCompletion = (phase: PhaseCard): boolean =>
          phaseHasSuccessfulCompletion(phase, (p) => getStepsForPhase(g, p));

        const targetIndex = missionPhases.findIndex((phase) => phase.phaseKey === targetPhase.phaseKey);
        if (targetIndex < 0) {
          return { ok: false, error: `Could not resolve target phase index for '${targetPhase.phaseKey}'.` };
        }

        if (
          currentPhase?.phaseKey === "planning"
          && targetPhase.phaseKey !== "planning"
          && !hasSuccessfulCompletion(currentPhase)
        ) {
          return {
            ok: false,
            error: "Planning phase has not completed yet. Wait for a planning worker to succeed before transitioning."
          };
        }

        for (let i = 0; i < targetIndex; i += 1) {
          const earlier = missionPhases[i]!;
          const mustComplete = earlier.validationGate.required || earlier.orderingConstraints.mustBeFirst;
          if (mustComplete && !hasSuccessfulCompletion(earlier)) {
            return {
              ok: false,
              error: `Cannot enter phase '${targetPhase.name}' before '${earlier.name}' has succeeded.`
            };
          }
        }

        const mustFollow = targetPhase.orderingConstraints.mustFollow ?? [];
        for (const rawPredecessor of mustFollow) {
          const predecessorKey = rawPredecessor.trim();
          if (!predecessorKey.length) continue;
          const predecessor = missionPhases.find((phase) => phase.phaseKey === predecessorKey || phase.name === predecessorKey);
          if (predecessor && !hasSuccessfulCompletion(predecessor)) {
            return {
              ok: false,
              error: `Cannot enter phase '${targetPhase.name}' until '${predecessor.name}' succeeds (mustFollow).`
            };
          }
        }

        // ── VAL-PLAN-005 / VAL-PLAN-007: Approval gate ──
        // Before leaving any phase with requiresApproval=true, require user approval.
        if (currentPhase && currentPhase.requiresApproval === true) {
          const mission = missionService.get(missionId);
          const approvalInterventions = (mission?.interventions ?? []).filter((entry: any) => {
            if (entry.interventionType !== "phase_approval") return false;
            const meta = asRecord(entry.metadata);
            const phase = typeof meta?.phaseKey === "string" ? meta.phaseKey.trim() : "";
            const targetPhaseKey = typeof meta?.targetPhaseKey === "string" ? meta.targetPhaseKey.trim() : "";
            const approvalRunId = typeof meta?.runId === "string" ? meta.runId.trim() : "";
            if (approvalRunId && approvalRunId !== runId) return false;
            if (phase !== currentPhase.phaseKey && phase !== "") return false;
            if (targetPhaseKey && targetPhaseKey !== targetPhase.phaseKey) return false;
            return true;
          });
          const hasResolvedApproval = approvalInterventions.some((entry: any) => entry.status === "resolved");
          if (!hasResolvedApproval) {
            // Create a blocking phase_approval intervention if none exists yet
            const hasOpenApproval = approvalInterventions.some((entry: any) => entry.status === "open");
            if (!hasOpenApproval) {
              missionService.addIntervention({
                missionId,
                interventionType: "phase_approval",
                title: `Approve transition from "${currentPhase.name}" phase`,
                body: `The "${currentPhase.name}" phase requires manual approval before the mission can proceed to "${targetPhase.name}". Please review the phase output and approve to continue.`,
                requestedAction: `Approve the "${currentPhase.name}" output to proceed to "${targetPhase.name}".`,
                pauseMission: true,
                metadata: {
                  runId,
                  phaseKey: currentPhase.phaseKey,
                  phaseName: currentPhase.name,
                  targetPhaseKey: targetPhase.phaseKey,
                  targetPhaseName: targetPhase.name,
                  source: "phase_approval_gate",
                },
              });
            }
            return {
              ok: false,
              error: `Phase "${currentPhase.name}" requires manual approval before transitioning to "${targetPhase.name}". A phase_approval intervention has been created. Wait for the user to approve.`,
              pendingApproval: true,
              phaseKey: currentPhase.phaseKey,
            };
          }
        }

        const now = nowIso();
        const runRow = db.get<{ metadata_json: string | null }>(
          `select metadata_json from orchestrator_runs where id = ? limit 1`,
          [runId]
        );
        const metadata = (() => {
          try {
            const parsed = runRow?.metadata_json ? JSON.parse(runRow.metadata_json) : {};
            return asRecord(parsed) ?? {};
          } catch {
            return {} as Record<string, unknown>;
          }
        })();
        const phaseRuntimeSource = asRecord(metadata.phaseRuntime);
        const phaseRuntime: Record<string, unknown> = phaseRuntimeSource ? { ...phaseRuntimeSource } : {};
        const previousPhaseKey = typeof phaseRuntime.currentPhaseKey === "string" ? phaseRuntime.currentPhaseKey : null;
        const previousPhaseName = typeof phaseRuntime.currentPhaseName === "string" ? phaseRuntime.currentPhaseName : null;
        const transitions = Array.isArray(phaseRuntime.transitions) ? [...phaseRuntime.transitions] : [];
        const transitionReason = typeof reason === "string" && reason.trim().length > 0
          ? reason.trim()
          : "coordinator_set_current_phase";
        transitions.unshift({
          fromPhaseKey: previousPhaseKey,
          fromPhaseName: previousPhaseName,
          toPhaseKey: targetPhase.phaseKey,
          toPhaseName: targetPhase.name,
          at: now,
          reason: transitionReason
        });
        const existingPhaseBudgets = asRecord(phaseRuntime.phaseBudgets) ?? {};
        const targetPhaseBudget = asRecord(existingPhaseBudgets[targetPhase.phaseKey]);
        phaseRuntime.transitions = transitions.slice(0, 64);
        phaseRuntime.currentPhaseKey = targetPhase.phaseKey;
        phaseRuntime.currentPhaseName = targetPhase.name;
        phaseRuntime.currentPhaseModel = targetPhase.model;
        phaseRuntime.currentPhaseInstructions = targetPhase.instructions;
        phaseRuntime.currentPhaseValidation = targetPhase.validationGate;
        phaseRuntime.currentPhaseBudget = targetPhase.budget ?? {};
        phaseRuntime.transitionedAt = now;
        phaseRuntime.phaseBudgets = {
          ...existingPhaseBudgets,
          [targetPhase.phaseKey]: {
            enteredAt: typeof targetPhaseBudget?.enteredAt === "string" && targetPhaseBudget.enteredAt.trim().length > 0
              ? targetPhaseBudget.enteredAt
              : now,
            usedTokens: Number.isFinite(Number(targetPhaseBudget?.usedTokens))
              ? Number(targetPhaseBudget?.usedTokens)
              : 0,
            usedCostUsd: Number.isFinite(Number(targetPhaseBudget?.usedCostUsd))
              ? Number(targetPhaseBudget?.usedCostUsd)
              : 0
          }
        };
        metadata.phaseRuntime = phaseRuntime;

        db.run(
          `update orchestrator_runs set metadata_json = ?, updated_at = ? where id = ?`,
          [JSON.stringify(metadata), now, runId]
        );

        orchestratorService.appendTimelineEvent({
          runId,
          eventType: "phase_transition",
          reason: transitionReason,
          detail: {
            fromPhaseKey: previousPhaseKey,
            fromPhaseName: previousPhaseName,
            toPhaseKey: targetPhase.phaseKey,
            toPhaseName: targetPhase.name,
            phaseModel: targetPhase.model,
            phaseValidation: targetPhase.validationGate,
            phaseBudget: targetPhase.budget ?? {},
            transitionedAt: now,
            source: "coordinator_set_current_phase"
          }
        });
        orchestratorService.emitRuntimeUpdate({
          runId,
          reason: "phase_transition"
        });

        return {
          ok: true,
          changed: true,
          previousPhaseKey,
          previousPhaseName,
          currentPhaseKey: targetPhase.phaseKey,
          currentPhaseName: targetPhase.name
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.set_current_phase.error", { phaseKey, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const create_task = defineCoordinatorTool({
    description:
      "Create a task in the mission DAG. Tasks show up in the UI as a visual work breakdown. Use this to plan the work before spawning workers.",
    inputSchema: z.object({
      key: z.string().describe("Unique key for this task (e.g. 'design-oauth', 'impl-tokens')"),
      title: z.string().describe("Human-readable title for the task"),
      description: z.string().describe("Description of what needs to be done"),
      dependsOn: z
        .array(z.string())
        .default([])
        .describe("Task keys this task depends on"),
    }),
    execute: async ({ key, title, description, dependsOn }) => {
      try {
        const g = graph();
        const planningInputBlockReason = getPlanningInputBlockReason(g);
        if (planningInputBlockReason) {
          return { ok: false, error: planningInputBlockReason };
        }
        const missionPhases = resolveMissionPhases(g);
        const currentPhase = missionPhases.length > 0 ? resolveCurrentPhaseCard(g, missionPhases) : null;
        const currentPhaseKey = currentPhase?.phaseKey.trim().toLowerCase() ?? "";
        if (currentPhaseKey === "planning") {
          return {
            ok: false,
            error:
              "Planning should be represented by the planning worker itself. " +
              "Spawn the read-only planning worker, review its output, then call set_current_phase with phaseKey \"development\" before creating execution tasks."
          };
        }
        const normalizedKey = String(key ?? "").trim();
        const normalizedTitle = String(title ?? "").trim();
        const normalizedDescription = String(description ?? "").trim();
        const requestedDependsOn = normalizeDependencyReferences({
          graph: g,
          refs: dependsOn,
          label: `Task '${normalizedKey}'`,
        });
        if (!normalizedKey.length) {
          return { ok: false, error: "Task key is required." };
        }
        if (!normalizedTitle.length) {
          return { ok: false, error: "Task title is required." };
        }
        if (!normalizedDescription.length) {
          return { ok: false, error: "Task description is required." };
        }
        const inferredDependsOn =
          requestedDependsOn.length === 0 && missionPhases.length > 0
            ? resolveImplicitDependencyStepKeys(g, missionPhases)
            : [];
        const normalizedDependsOn =
          requestedDependsOn.length > 0 ? requestedDependsOn : inferredDependsOn;
        const phaseMetadata = buildPhaseMetadataForNewStep(g, missionPhases);
        const maxIndex = g.steps.reduce(
          (max, s) => Math.max(max, s.stepIndex),
          -1,
        );
        const created = orchestratorService.addSteps({
          runId,
          steps: [
            {
              stepKey: normalizedKey,
              title: normalizedTitle,
              stepIndex: maxIndex + 1,
              laneId: missionLaneId ?? undefined,
              dependencyStepKeys: normalizedDependsOn,
              executorKind: "manual",
              metadata: {
                ...phaseMetadata,
                instructions: normalizedDescription,
                stepType: "task",
                requestedDependencyStepKeys: requestedDependsOn,
                ...(inferredDependsOn.length > 0 ? { inferredDependencyStepKeys: inferredDependsOn } : {}),
              },
            },
          ],
        });
        const newStep = created[0];
        if (newStep) {
          onDagMutation({
            runId,
            mutation: { type: "step_added", step: newStep },
            timestamp: nowIso(),
            source: "coordinator",
          });
        }
        logger.info("coordinator.create_task", { key: normalizedKey, title: normalizedTitle });
        return {
          ok: true,
          taskKey: normalizedKey,
          stepId: newStep?.id ?? null,
          status: newStep?.status ?? "unknown",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.create_task.error", { key, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const update_task = defineCoordinatorTool({
    description:
      "Update a task's status or description. Use this to mark tasks as done, failed, or to update their instructions.",
    inputSchema: z.object({
      key: z.string().describe("Task key to update"),
      status: z.enum(["succeeded", "failed", "skipped", "superseded"]).optional().describe("New status for the task"),
      result: z.string().optional().describe("Result summary or failure reason"),
    }),
    execute: async ({ key, status, result }) => {
      try {
        const g = graph();
        const step = resolveStep(g, key);
        if (!step)
          return { ok: false, error: `Task not found: ${key}` };
        if (status === "skipped") {
          orchestratorService.skipStep({
            runId,
            stepId: step.id,
            reason: result ?? "Skipped by coordinator",
          });
        } else if (status) {
          const ts = nowIso();
          db.run(
            `update orchestrator_steps set status = ?, completed_at = ?, updated_at = ? where id = ? and run_id = ?`,
            [status, ts, ts, step.id, runId],
          );
        }
        onDagMutation({
          runId,
          mutation: { type: "status_changed", stepKey: key, newStatus: status ?? step.status },
          timestamp: nowIso(),
          source: "coordinator",
        });
        logger.info("coordinator.update_task", { key, status });
        return { ok: true, taskKey: key, newStatus: status ?? step.status };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.update_task.error", { key, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const assign_task = defineCoordinatorTool({
    description:
      "Assign a task to a worker. Links the task to the worker in the UI.",
    inputSchema: z.object({
      taskKey: z.string().describe("Task key to assign"),
      workerId: z.string().describe("Worker step key to assign the task to"),
    }),
    execute: async ({ taskKey, workerId }) => {
      try {
        const g = graph();
        const step = resolveStep(g, taskKey);
        if (!step)
          return { ok: false, error: `Task not found: ${taskKey}` };
        // Store assignment in step metadata
        const existingMeta = (step.metadata ?? {}) as Record<string, unknown>;
        const updatedMeta = { ...existingMeta, assignedTo: workerId };
        db.run(
          `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ?`,
          [JSON.stringify(updatedMeta), nowIso(), step.id, runId],
        );
        logger.info("coordinator.assign_task", { taskKey, workerId });
        return { ok: true, taskKey, workerId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.assign_task.error", { taskKey, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const list_tasks = defineCoordinatorTool({
    description:
      "Get all tasks and their current statuses.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const g = graph();
        const relevantSteps = filterExecutionSteps(g.steps);
        const total = relevantSteps.length;
        const byStatus: Record<string, number> = {};
        for (const step of relevantSteps) {
          byStatus[step.status] = (byStatus[step.status] ?? 0) + 1;
        }
        const terminal =
          (byStatus.succeeded ?? 0) +
          (byStatus.failed ?? 0) +
          (byStatus.skipped ?? 0) +
          (byStatus.superseded ?? 0) +
          (byStatus.canceled ?? 0);
        const progressPct = total > 0 ? Math.round((terminal / total) * 100) : 0;
        const tasks = g.steps.map((s) => {
          const attempt = findRunningAttempt(g, s.id);
          const meta = (s.metadata ?? {}) as Record<string, unknown>;
          return {
            key: s.stepKey,
            title: s.title,
            status: s.status,
            assignedTo: meta.assignedTo ?? null,
            hasRunningWorker: !!attempt,
            retryCount: s.retryCount,
            stepType: typeof meta.stepType === "string" ? meta.stepType : null,
          };
        });
        return {
          ok: true,
          runId,
          progressPct,
          total,
          byStatus,
          tasks,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.list_tasks.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  // ─── Step Control ───────────────────────────────────────────

  const skip_step = defineCoordinatorTool({
    description:
      "Skip a step/task that you've decided is non-critical or unnecessary. Unblocks downstream steps that depend on it.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key of the step to skip"),
      reason: z.string().describe("Why you're skipping this step"),
    }),
    execute: async ({ workerId, reason }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step)
          return { ok: false, error: `Step not found: ${workerId}` };
        if (step.status === "succeeded" || step.status === "skipped")
          return { ok: false, error: `Step '${workerId}' is already ${step.status}` };
        // Cancel running attempt if any
        const running = findRunningAttempt(g, step.id);
        if (running) {
          await orchestratorService.completeAttempt({
            attemptId: running.id,
            status: "canceled",
            errorClass: "canceled",
            errorMessage: reason,
          });
        }
        orchestratorService.skipStep({
          runId,
          stepId: step.id,
          reason,
        });
        onDagMutation({
          runId,
          mutation: { type: "status_changed", stepKey: workerId, newStatus: "skipped" },
          timestamp: nowIso(),
          source: "coordinator",
        });
        logger.info("coordinator.skip_step", { workerId, reason });
        return { ok: true, workerId, newStatus: "skipped" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.skip_step.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const mark_step_complete = defineCoordinatorTool({
    description:
      "Mark a step as succeeded. Use when YOU (the coordinator) have verified a worker's output is satisfactory, or when completing a task/milestone yourself.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key of the step to mark complete"),
      summary: z.string().optional().describe("Optional completion summary"),
    }),
    execute: async ({ workerId, summary }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step) return { ok: false, error: `Step not found: ${workerId}` };
        if (TERMINAL_STEP_STATUSES.has(step.status)) {
          return { ok: false, error: `Step '${workerId}' is already terminal (${step.status})` };
        }
        const stepMeta = asRecord(step.metadata) ?? {};
        const validationContract = parseValidationContract(stepMeta.validationContract ?? null);
        const validationState = resolveValidationStateFromStepMetadata(stepMeta);
        if (validationContract?.required && validationState !== "pass") {
          return {
            ok: false,
            error: `Step '${workerId}' requires validator pass before completion (current validation state: ${validationState}).`,
            hint: "Run report_validation with verdict='pass' for this step before marking it complete.",
            validation: {
              required: true,
              state: validationState,
              tier: validationContract.tier,
              criteria: validationContract.criteria
            }
          };
        }
        // Cancel running attempt if any
        const running = findRunningAttempt(g, step.id);
        if (running) {
          await orchestratorService.completeAttempt({
            attemptId: running.id,
            status: "succeeded",
            result: {
              schema: "ade.orchestratorAttempt.v1",
              success: true,
              summary: summary ?? "Marked complete by coordinator",
              outputs: null,
              warnings: [],
              sessionId: running.executorSessionId ?? null,
              trackedSession: false,
            },
          });
        }
        const ts = nowIso();
        db.run(
          `update orchestrator_steps set status = 'succeeded', completed_at = ?, updated_at = ? where id = ? and run_id = ?`,
          [ts, ts, step.id, runId],
        );
        onDagMutation({
          runId,
          mutation: { type: "status_changed", stepKey: workerId, newStatus: "succeeded" },
          timestamp: ts,
          source: "coordinator",
        });
        // Trigger autopilot to pick up newly unblocked steps
        setTimeout(() => {
          void orchestratorService.startReadyAutopilotAttempts({
            runId,
            reason: "coordinator_mark_step_complete",
          }).catch((error) => {
            logger.debug("coordinator.mark_step_complete.autopilot_schedule_failed", {
              runId,
              workerId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, 100);
        logger.info("coordinator.mark_step_complete", { workerId, summary });
        return { ok: true, workerId, newStatus: "succeeded" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.mark_step_complete.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const mark_step_failed = defineCoordinatorTool({
    description:
      "Mark a step as failed. Use when YOU (the coordinator) have determined a worker's output is unsatisfactory or the task cannot be completed as planned. After marking failed, you can retry_step with adjusted instructions or skip_step.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key of the step to mark failed"),
      reason: z.string().describe("Why the step failed"),
    }),
    execute: async ({ workerId, reason }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step) return { ok: false, error: `Step not found: ${workerId}` };
        if (TERMINAL_STEP_STATUSES.has(step.status)) {
          return { ok: false, error: `Step '${workerId}' is already terminal (${step.status})` };
        }
        // Cancel running attempt if any
        const running = findRunningAttempt(g, step.id);
        if (running) {
          await orchestratorService.completeAttempt({
            attemptId: running.id,
            status: "failed",
            errorClass: "deterministic",
            errorMessage: reason,
          });
        }
        const ts = nowIso();
        db.run(
          `update orchestrator_steps set status = 'failed', completed_at = ?, updated_at = ?, last_error = ? where id = ? and run_id = ?`,
          [ts, ts, reason, step.id, runId],
        );
        onDagMutation({
          runId,
          mutation: { type: "status_changed", stepKey: workerId, newStatus: "failed" },
          timestamp: ts,
          source: "coordinator",
        });
        logger.info("coordinator.mark_step_failed", { workerId, reason });
        return { ok: true, workerId, newStatus: "failed", reason };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.mark_step_failed.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const retry_step = defineCoordinatorTool({
    description:
      "Retry a failed step with adjusted instructions. Creates a new attempt with the revised prompt. Use when a worker failed but you believe it can succeed with different guidance.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key of the failed step to retry"),
      adjustedInstructions: z.string().describe("New/revised instructions for the retry — explain what went wrong and how to fix it"),
    }),
    execute: async ({ workerId, adjustedInstructions }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step)
          return { ok: false, error: `Step not found: ${workerId}` };
        const running = findRunningAttempt(g, step.id);
        if (running) {
          return {
            ok: false,
            error: `Cannot retry step '${workerId}' while attempt '${running.id}' is still running.`
          };
        }
        if (step.status !== "failed" && !TERMINAL_STEP_STATUSES.has(step.status)) {
          return {
            ok: false,
            error: `Step '${workerId}' must be failed or terminal before retry (current status: ${step.status}).`
          };
        }
        // Update step metadata with revised instructions
        const existingMeta = (step.metadata ?? {}) as Record<string, unknown>;
        const originalInstructions = existingMeta.instructions;
        const updatedMeta = {
          ...existingMeta,
          instructions: adjustedInstructions,
          previousInstructions: originalInstructions,
          retriedByCoordinator: true,
          retryReason: `Coordinator retry at ${nowIso()}`,
        };
        // Reset step to pending so autopilot picks it up
        const ts = nowIso();
        db.run(
          `update orchestrator_steps set status = 'pending', metadata_json = ?, retry_count = retry_count + 1, completed_at = null, updated_at = ? where id = ? and run_id = ?`,
          [JSON.stringify(updatedMeta), ts, step.id, runId],
        );
        onDagMutation({
          runId,
          mutation: { type: "status_changed", stepKey: workerId, newStatus: "pending" },
          timestamp: ts,
          source: "coordinator",
        });
        // Trigger autopilot to start the retry
        setTimeout(() => {
          void orchestratorService.startReadyAutopilotAttempts({
            runId,
            reason: "coordinator_retry_step",
          }).catch((error) => {
            logger.debug("coordinator.retry_step.autopilot_schedule_failed", {
              runId,
              workerId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, 100);
        logger.info("coordinator.retry_step", { workerId });
        return { ok: true, workerId, newStatus: "pending", retryCount: step.retryCount + 1 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.retry_step.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  // ─── Mission Lifecycle ────────────────────────────────────────

  const complete_mission = defineCoordinatorTool({
    description:
      "Request mission success finalization. The runtime still enforces completion gates before success is granted.",
    inputSchema: z.object({
      summary: z.string().describe("Summary of what was accomplished"),
    }),
    execute: async ({ summary }) => {
      try {
        const g = graph();
        const relevantSteps = filterExecutionSteps(g.steps);
        const activeWorkers = relevantSteps
          .filter((step) => step.status === "running")
          .map((step) => ({
            stepKey: step.stepKey,
            title: step.title,
          }));
        if (activeWorkers.length > 0) {
          return {
            ok: false,
            error: `Mission cannot be completed while ${activeWorkers.length} worker(s) are still running.`,
            hint: "Wait for running workers to finish, or cancel them explicitly if the work should be abandoned.",
            activeWorkers,
          };
        }
        const blockers = relevantSteps
          .filter((step) => step.status === "succeeded")
          .flatMap((step) => {
            const stepMeta = asRecord(step.metadata) ?? {};
            const validationContract = parseValidationContract(stepMeta.validationContract ?? null);
            if (!validationContract?.required) return [];
            const validationState = resolveValidationStateFromStepMetadata(stepMeta);
            if (validationState === "pass") return [];
            return [{
              stepKey: step.stepKey,
              status: step.status,
              validationState,
              tier: validationContract.tier,
              criteria: validationContract.criteria
            }];
          });
        if (blockers.length > 0) {
          return {
            ok: false,
            error: `Mission cannot be completed: ${blockers.length} step(s) require validator pass before completion.`,
            hint: "Submit passing validation reports for blocked steps before completing the mission.",
            blockers
          };
        }
        const finalized = orchestratorService.finalizeRun({ runId });
        if (!finalized.finalized) {
          return {
            ok: false,
            error: "Mission cannot be completed until the runtime completion gates pass.",
            blockers: finalized.blockers,
          };
        }
        if (finalized.finalStatus !== "succeeded") {
          return {
            ok: false,
            error: `Mission completion request did not resolve to success (final status: ${finalized.finalStatus}).`,
            blockers: finalized.blockers,
            finalStatus: finalized.finalStatus,
          };
        }

        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "done",
          payload: { summary, completedBy: "coordinator" },
        });
        if (deps.onRunFinalize) {
          deps.onRunFinalize({ runId, succeeded: true, summary });
        }
        logger.info("coordinator.complete_mission", { runId, summary });
        return { ok: true, runId, summary, finalStatus: finalized.finalStatus };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.complete_mission.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const fail_mission = defineCoordinatorTool({
    description:
      "Declare the mission failed. Use when you determine the mission cannot succeed.",
    inputSchema: z.object({
      reason: z.string().describe("Reason why the mission failed"),
    }),
    execute: async ({ reason }) => {
      try {
        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "done",
          payload: { reason, failedBy: "coordinator", failed: true },
        });
        // Finalize via proper lifecycle callback
        if (deps.onRunFinalize) {
          deps.onRunFinalize({ runId, succeeded: false, reason });
        } else {
          // Fallback: raw update if no callback provided
          const ts = nowIso();
          db.run(
            `update orchestrator_runs set status = 'failed', completed_at = ?, updated_at = ?, last_error = ? where id = ?`,
            [ts, ts, reason, runId],
          );
          try {
            deps.orchestratorService.generateRunRetrospective({ runId });
          } catch {
            // best-effort
          }
        }
        logger.info("coordinator.fail_mission", { runId, reason });
        return { ok: true, runId, reason };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.fail_mission.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const openHumanIntervention = (args: {
    question: string;
    context?: string | null;
    urgency?: "low" | "normal" | "high";
    source: "ask_user" | "request_user_input";
    canProceedWithoutAnswer?: boolean;
  }) => {
    const question = args.question.trim();
    if (!question.length) {
      return { ok: false as const, error: "Question is required." };
    }
    const context = typeof args.context === "string" ? args.context.trim() : "";
    const urgency = args.urgency ?? "normal";
    const mission = missionService.get(missionId);
    if (!mission) {
      return { ok: false as const, error: `Mission not found: ${missionId}` };
    }
    const currentGraph = graph();
    const currentPhase = resolveCurrentPhaseCard(currentGraph, resolveMissionPhases(currentGraph));

    const existing = mission.interventions.find((entry) => {
      if (entry.status !== "open" || entry.interventionType !== "manual_input") return false;
      const metadata = asRecord(entry.metadata);
      return (
        metadata?.runId === runId
        && metadata?.source === args.source
        && metadata?.question === question
      );
    });
    if (existing) {
      return {
        ok: true as const,
        interventionId: existing.id,
        question,
        deduped: true,
        awaitingUserResponse: args.canProceedWithoutAnswer !== true,
        blocking: args.canProceedWithoutAnswer !== true,
      };
    }

    const title = question.length > 96
      ? "Coordinator requested user input"
      : `Coordinator input needed: ${question}`;
    const body = context.length > 0 ? `${question}\n\nContext:\n${context}` : question;
    const intervention = missionService.addIntervention({
      missionId,
      interventionType: "manual_input",
      title,
      body,
      requestedAction: args.canProceedWithoutAnswer
        ? "Optional: provide guidance. Coordinator may continue with best-effort assumptions."
        : "Provide guidance to unblock coordinator execution.",
      pauseMission: args.canProceedWithoutAnswer !== true,
        metadata: {
          source: args.source,
          runId,
          question,
          context: context.length > 0 ? context : null,
          urgency,
          canProceedWithoutAnswer: args.canProceedWithoutAnswer === true,
          blocking: args.canProceedWithoutAnswer !== true,
          category: "user_input" as const,
          ...buildCoordinatorQuestionOwnerMetadata({
            phaseKey: currentPhase?.phaseKey ?? null,
            phaseName: currentPhase?.name ?? null,
          }),
        }
      });

    // If the intervention is blocking, also pause the orchestrator run
    if (args.canProceedWithoutAnswer !== true) {
      try {
        orchestratorService.pauseRun({
          runId,
          reason: `Blocking user input required: ${question.slice(0, 100)}`,
          metadata: { interventionSource: args.source, interventionId: intervention.id },
        });
      } catch (e) {
        // Run may already be paused or in a terminal state
        logger.warn(`Could not pause run for blocking intervention: ${e}`);
      }
    }

    orchestratorService.appendRuntimeEvent({
      runId,
      eventType: "intervention_opened",
      payload: {
        missionId,
        interventionId: intervention.id,
        interventionType: intervention.interventionType,
        source: args.source,
        question,
        context: context.length > 0 ? context : null,
        urgency,
        canProceedWithoutAnswer: args.canProceedWithoutAnswer === true,
        blocking: args.canProceedWithoutAnswer !== true,
        category: "user_input",
        phase: currentPhase?.phaseKey ?? null
      },
    });
    orchestratorService.appendTimelineEvent({
      runId,
      eventType: "intervention_opened",
      reason: "coordinator_escalation",
      detail: {
        interventionId: intervention.id,
        source: args.source,
        urgency,
        blocking: args.canProceedWithoutAnswer !== true
      }
    });
    logger.info("coordinator.user_input_requested", {
      runId,
      missionId,
      interventionId: intervention.id,
      source: args.source,
      urgency,
      blocking: args.canProceedWithoutAnswer !== true
    });
    return {
      ok: true as const,
      interventionId: intervention.id,
      question,
      deduped: false,
      awaitingUserResponse: args.canProceedWithoutAnswer !== true,
      blocking: args.canProceedWithoutAnswer !== true,
    };
  };

  const get_budget_status = defineCoordinatorTool({
    description:
      "Get the current mission budget pressure and usage snapshot. Use this before deciding parallelism, validation depth, or model strategy.",
    inputSchema: z.object({
      includePerPhase: z.boolean().default(true).describe("Include per-phase budget usage details."),
      includePerWorker: z.boolean().default(false).describe("Include per-worker budget usage details."),
    }),
    execute: async ({ includePerPhase, includePerWorker }) => {
      const current = graph();
      const activeStep =
        current.steps.find((step) => step.status === "running")
        ?? current.steps.find((step) => step.status === "ready")
        ?? null;
      const activeMeta = asRecord(activeStep?.metadata);
      const currentPhaseKey = typeof activeMeta?.phaseKey === "string" ? activeMeta.phaseKey.trim() : "";
      const currentPhaseName = typeof activeMeta?.phaseName === "string" ? activeMeta.phaseName.trim() : "";

      if (!getMissionBudgetStatus) {
        const activeWorkers = current.attempts.filter((attempt) => attempt.status === "running").length;
        return {
          ok: true,
          pressure: "normal",
          mode: "unknown",
          mission: { used: 0, limit: null, remaining: null },
          currentPhase: currentPhaseKey.length > 0 || currentPhaseName.length > 0
            ? { phaseKey: currentPhaseKey || "unknown", phaseName: currentPhaseName || currentPhaseKey || "Current phase", used: 0, limit: null, remaining: null }
            : null,
          activeWorkers,
          recommendation: "Budget service unavailable; use conservative parallelism until telemetry is available."
        };
      }

      try {
        const snapshot = await getMissionBudgetStatus();
        if (!snapshot) {
          return { ok: false, error: "Mission budget status unavailable." };
        }
        const phaseSnapshot =
          (currentPhaseKey.length > 0
            ? snapshot.perPhase.find((phase) => phase.phaseKey === currentPhaseKey)
            : null)
          ?? (currentPhaseName.length > 0
            ? snapshot.perPhase.find((phase) => phase.phaseName === currentPhaseName)
            : null)
          ?? null;

        // Emit soft budget warnings on pressure transitions (deduped)
        if (
          deps.onBudgetWarning &&
          (snapshot.pressure === "warning" || snapshot.pressure === "critical") &&
          snapshot.pressure !== lastEmittedBudgetPressure
        ) {
          const pctUsed = snapshot.mission.maxTokens
            ? Math.round((snapshot.mission.usedTokens / snapshot.mission.maxTokens) * 100)
            : null;
          const costDetail = snapshot.mission.usedCostUsd != null
            ? `$${snapshot.mission.usedCostUsd.toFixed(2)} spent`
            : null;
          const parts = [
            pctUsed != null ? `${pctUsed}% of token budget used` : null,
            costDetail,
            snapshot.recommendation,
          ].filter(Boolean);
          const detail = parts.join("; ") || `Budget pressure is now ${snapshot.pressure}`;
          lastEmittedBudgetPressure = snapshot.pressure;
          deps.onBudgetWarning(snapshot.pressure, detail);
          logger.info("coordinator.budget_soft_warning_emitted", {
            runId,
            missionId,
            pressure: snapshot.pressure,
          });
        } else if (snapshot.pressure === "normal" && lastEmittedBudgetPressure !== "normal") {
          // Reset dedup tracker when pressure drops back to normal
          lastEmittedBudgetPressure = "normal";
        }

        return {
          ok: true,
          pressure: snapshot.pressure,
          mode: snapshot.mode,
          mission: {
            used: snapshot.mission.usedTokens,
            limit: snapshot.mission.maxTokens ?? null,
            remaining: snapshot.mission.remainingTokens ?? null,
            usedCostUsd: snapshot.mission.usedCostUsd,
            limitCostUsd: snapshot.mission.maxCostUsd ?? null,
            remainingCostUsd: snapshot.mission.remainingCostUsd ?? null,
            usedTimeMs: snapshot.mission.usedTimeMs,
            limitTimeMs: snapshot.mission.maxTimeMs ?? null,
            remainingTimeMs: snapshot.mission.remainingTimeMs ?? null,
          },
          currentPhase: phaseSnapshot
            ? {
                phaseKey: phaseSnapshot.phaseKey,
                phaseName: phaseSnapshot.phaseName,
                used: phaseSnapshot.usedTokens,
                limit: phaseSnapshot.maxTokens ?? null,
                remaining: phaseSnapshot.remainingTokens ?? null,
                usedCostUsd: phaseSnapshot.usedCostUsd,
                usedTimeMs: phaseSnapshot.usedTimeMs
              }
            : null,
          activeWorkers: snapshot.activeWorkers,
          recommendation: snapshot.recommendation,
          estimatedRemainingCapacity: snapshot.estimatedRemainingCapacity,
          rateLimits: snapshot.rateLimits,
          perProvider: snapshot.perProvider.map((prov) => ({
            provider: prov.provider,
            fiveHour: {
              usedTokens: prov.fiveHour.usedTokens,
              limitTokens: prov.fiveHour.limitTokens,
              usedPct: prov.fiveHour.usedPct,
              usedCostUsd: prov.fiveHour.usedCostUsd,
              timeUntilResetMs: prov.fiveHour.timeUntilResetMs,
            },
            weekly: {
              usedTokens: prov.weekly.usedTokens,
              limitTokens: prov.weekly.limitTokens,
              usedPct: prov.weekly.usedPct,
              usedCostUsd: prov.weekly.usedCostUsd,
              timeUntilResetMs: prov.weekly.timeUntilResetMs,
            },
          })),
          hardCaps: {
            fiveHourHardStopPercent: snapshot.hardCaps.fiveHourHardStopPercent,
            weeklyHardStopPercent: snapshot.hardCaps.weeklyHardStopPercent,
            apiKeyMaxSpendUsd: snapshot.hardCaps.apiKeyMaxSpendUsd,
            apiKeySpentUsd: snapshot.hardCaps.apiKeySpentUsd,
            fiveHourTriggered: snapshot.hardCaps.fiveHourTriggered,
            weeklyTriggered: snapshot.hardCaps.weeklyTriggered,
            apiKeyTriggered: snapshot.hardCaps.apiKeyTriggered,
            anyTriggered: snapshot.hardCaps.fiveHourTriggered || snapshot.hardCaps.weeklyTriggered || snapshot.hardCaps.apiKeyTriggered,
          },
          ...(includePerPhase
            ? {
                perPhase: snapshot.perPhase.map((phase) => ({
                  phaseKey: phase.phaseKey,
                  phaseName: phase.phaseName,
                  used: phase.usedTokens,
                  limit: phase.maxTokens ?? null,
                  remaining: phase.remainingTokens ?? null,
                  usedCostUsd: phase.usedCostUsd,
                  usedTimeMs: phase.usedTimeMs
                }))
              }
            : {}),
          ...(includePerWorker
            ? {
                perWorker: snapshot.perWorker.map((worker) => ({
                  workerId: worker.stepKey,
                  stepId: worker.stepId,
                  title: worker.title,
                  phaseKey: worker.phaseKey,
                  phaseName: worker.phaseName,
                  used: worker.usedTokens,
                  limit: worker.maxTokens ?? null,
                  remaining: worker.remainingTokens ?? null,
                  usedCostUsd: worker.usedCostUsd,
                  usedTimeMs: worker.usedTimeMs
                }))
              }
            : {})
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.get_budget_status.error", { runId, missionId, error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const ask_user = defineCoordinatorTool({
    description:
      "Open one or more structured blocking questions for the current phase. Prefer letting the active phase worker ask these directly instead of the coordinator. Bundle all related questions in one call.",
    inputSchema: z.object({
      questions: z.array(z.object({
        question: z.string().describe("The question text"),
        context: z.string().optional().describe("Additional context for this question"),
        options: z.array(z.string()).optional().describe("Optional multiple-choice options"),
        defaultAssumption: z.string().optional().describe("What you will assume if the user does not answer"),
        impact: z.string().optional().describe("Why this question matters / what it affects"),
      })).min(1).describe("Array of structured questions to ask"),
      phase: z.string().optional().describe("Which phase this quiz is for"),
    }),
    execute: async ({ questions, phase }) => {
      try {
        const g = graph();
        const questionBlockReason = getQuestionAskingBlockReason(g);
        if (questionBlockReason) {
          return { ok: false as const, error: questionBlockReason };
        }
        const policy = resolveCurrentPhaseQuestionPolicy(g);
        if (policy.isPlanning) {
          return {
            ok: false as const,
            error: "During Planning, the active planning worker must ask any clarification directly. Spawn or wait for the planner instead of opening coordinator-owned planning questions.",
          };
        }
        const priorInterventions = listPhaseQuestionInterventions(g);
        const openQuestion = priorInterventions.find((entry) => entry.status === "open") ?? null;
        if (openQuestion) {
          const openMeta = asRecord(openQuestion.metadata);
          return {
            ok: true as const,
            interventionId: openQuestion.id,
            questionCount: Math.max(1, Number(openMeta?.questionCount ?? 1) || 1),
            deduped: true,
            awaitingUserResponse: true as const,
            blocking: true as const,
          };
        }
        if (!policy.enabled) {
          return { ok: false as const, error: "Ask Questions is disabled for the current phase." };
        }
        // VAL-PLAN-006: Multi-round deliberation — when phase has canLoop=true,
        // bypass the maxQuestions ceiling to allow unbounded ask_user + re-plan cycles.
        const phaseCanLoop = policy.phase?.orderingConstraints?.canLoop === true;
        if (!phaseCanLoop && policy.maxQuestions != null && priorInterventions.length >= policy.maxQuestions) {
          return {
            ok: false as const,
            error: `This phase already reached its Ask Questions limit (${policy.maxQuestions}). Continue with the best grounded assumptions you can.`,
          };
        }
        const firstQuestion = questions[0].question.trim();
        if (!firstQuestion.length) {
          return { ok: false as const, error: "First question text is required." };
        }

        const mission = missionService.get(missionId);
        if (!mission) {
          return { ok: false as const, error: `Mission not found: ${missionId}` };
        }

        const title = questions.length === 1
          ? (firstQuestion.length > 96 ? "Coordinator question ready" : `Question: ${firstQuestion}`)
          : `Coordinator has ${questions.length} questions`;
        const bodyLines = questions.map((q: { question: string }, i: number) => `Q${i + 1}: ${q.question}`);
        const body = bodyLines.join("\n");

        const intervention = missionService.addIntervention({
          missionId,
          interventionType: "manual_input",
          title,
          body,
          requestedAction: "Answer the planning questions to unblock coordinator execution.",
          pauseMission: true,
          metadata: {
            source: "ask_user",
            runId,
            quizMode: true,
            canProceedWithoutAnswer: false,
            blocking: true,
            category: "user_input" as const,
            questions,
            ...buildCoordinatorQuestionOwnerMetadata({
              phaseKey: phase ?? policy.phaseKey ?? null,
              phaseName: policy.phase?.name ?? null,
            }),
            questionCount: questions.length,
          }
        });

        // ask_user is always blocking (planning phase) — pause the run
        try {
          orchestratorService.pauseRun({
            runId,
            reason: `Blocking planning questions (${questions.length}): ${firstQuestion.slice(0, 100)}`,
            metadata: { interventionSource: "ask_user", interventionId: intervention.id },
          });
        } catch (e) {
          // Run may already be paused or in a terminal state
          logger.warn(`Could not pause run for ask_user intervention: ${e}`);
        }

        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "intervention_opened",
          payload: {
            missionId,
            interventionId: intervention.id,
            interventionType: intervention.interventionType,
            source: "ask_user",
            quizMode: true,
            blocking: true,
            category: "user_input",
            questionCount: questions.length,
            phase: phase ?? policy.phaseKey ?? null,
          },
        });
        orchestratorService.appendTimelineEvent({
          runId,
          eventType: "intervention_opened",
          reason: "coordinator_escalation",
          detail: {
            interventionId: intervention.id,
            source: "ask_user",
            quizMode: true,
            blocking: true,
            questionCount: questions.length,
          }
        });
        logger.info("coordinator.ask_user_quiz", {
          runId,
          missionId,
          interventionId: intervention.id,
          questionCount: questions.length,
          blocking: true,
          phase: phase ?? policy.phaseKey ?? null,
        });
        return {
          ok: true as const,
          interventionId: intervention.id,
          questionCount: questions.length,
          deduped: false,
          awaitingUserResponse: true as const,
          blocking: true as const,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.ask_user.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const request_user_input = defineCoordinatorTool({
    description:
      "Request user guidance from the coordinator flow. Prefer this over direct worker-to-human escalation.",
    inputSchema: z.object({
      question: z.string().describe("The exact question for the user."),
      context: z.string().optional().describe("Optional context and current assumptions."),
      urgency: z.enum(["low", "normal", "high"]).default("normal"),
      canProceedWithoutAnswer: z
        .boolean()
        .default(false)
        .describe("Whether coordinator can continue with assumptions if no response arrives.")
    }),
    execute: async ({ question, context, urgency, canProceedWithoutAnswer }) => {
      try {
        return openHumanIntervention({
          source: "request_user_input",
          question,
          context: context ?? null,
          urgency,
          canProceedWithoutAnswer
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.request_user_input.error", { error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  // ─── Context Tools ────────────────────────────────────────────

  const read_file = defineCoordinatorTool({
    description:
      "Read a file from the project. Use to inspect code, configs, or docs when you need to understand the codebase.",
    inputSchema: z.object({
      filePath: z.string().describe("Path relative to project root, e.g. 'src/index.ts' or 'package.json'"),
      maxLines: z.number().optional().describe("Maximum number of lines to read (default: 200)"),
    }),
    execute: async ({ filePath, maxLines }) => {
      try {
        const g = graph();
        const planningReadBlockReason = getPlanningRepoReadBlockReason(g);
        if (planningReadBlockReason) {
          return { ok: false, error: planningReadBlockReason };
        }
        const fullPath = resolveWorkspacePath(filePath, true);
        if (!fullPath) {
          return { ok: false, error: "Path is outside mission workspace root" };
        }
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            const entries = fs.readdirSync(fullPath).slice(0, 100);
            return { ok: true, type: "directory", entries };
          }
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          const limit = maxLines ?? 200;
          const truncated = lines.length > limit;
          const result = truncated ? lines.slice(0, limit).join("\n") : content;
          return {
            ok: true,
            type: "file",
            filePath,
            content: result,
            totalLines: lines.length,
            truncated,
          };
        } catch (error) {
          return { ok: false, error: formatWorkspaceReadError("file", filePath, error) };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  });

  const read_step_output = defineCoordinatorTool({
    description:
      "Read a worker's structured step output file (.ade/step-output-{stepKey}.md). Workers write these files as durable output records when they complete their tasks. Use this to understand what a worker accomplished, especially after context compaction.",
    inputSchema: z.object({
      stepKey: z.string().describe("The step key to read the output file for"),
    }),
    execute: async ({ stepKey }) => {
      try {
        const sanitized = stepKey.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filePath = resolveWorkspacePath(`.ade/step-output-${sanitized}.md`, true);
        if (!filePath) {
          return { ok: false, error: "Path is outside mission workspace root" };
        }
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          return { ok: true, stepKey, content };
        } catch (error) {
          return { ok: false, error: formatWorkspaceReadError("step output", stepKey, error) };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  });

  const search_files = defineCoordinatorTool({
    description:
      "Search project files by name pattern or content. Use to find relevant code or files.",
    inputSchema: z.object({
      pattern: z.string().describe("Search pattern — a filename glob (e.g. '**/*.ts') or literal content text"),
      searchType: z.enum(["filename", "content"]).default("content").describe("Whether to search file names or file content"),
      maxResults: z.number().optional().describe("Maximum results to return (default: 20)"),
      explicitRegexMode: z.boolean().default(false).describe("Treat content patterns as regular expressions instead of literal text."),
    }),
    execute: async ({ pattern, searchType, maxResults, explicitRegexMode }) => {
      try {
        const g = graph();
        const planningReadBlockReason = getPlanningRepoReadBlockReason(g);
        if (planningReadBlockReason) {
          return { ok: false, error: planningReadBlockReason };
        }
        const limit = maxResults ?? 20;
        if (searchType === "filename") {
          // Simple recursive file listing with glob matching
          const results: string[] = [];
          const filenameRegex = filenamePatternToRegExp(pattern);
          const visited = new Set<string>();
          const walkDir = (dir: string, depth = 0) => {
            if (depth > 6 || results.length >= limit) return;
            try {
              const realDir = fs.realpathSync(dir);
              if (visited.has(realDir)) return;
              visited.add(realDir);
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (results.length >= limit) break;
                if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
                const fullPath = resolveWorkspacePath(path.join(dir, entry.name));
                if (!fullPath) continue;
                const rel = path.relative(resolvedWorkspaceRootReal, fullPath);
                try {
                  if (fs.statSync(fullPath).isDirectory()) {
                    walkDir(fullPath, depth + 1);
                  } else if (filenameRegex.test(rel.replace(/\\/g, "/"))) {
                    results.push(rel);
                  }
                } catch {
                  // Skip entries whose stat fails (broken symlinks, etc.)
                }
              }
            } catch {
              // Skip unreadable dirs
            }
          };
          walkDir(resolvedWorkspaceRoot);
          return { ok: true, searchType, pattern, results, total: results.length };
        }
        // Content search using a simple line-by-line grep
        const results: Array<{ file: string; line: number; text: string }> = [];
        const regex = compileContentSearchRegex(pattern, explicitRegexMode);
        const visited = new Set<string>();
        const walkDir = (dir: string, depth = 0) => {
          if (depth > 6 || results.length >= limit) return;
          try {
            const realDir = fs.realpathSync(dir);
            if (visited.has(realDir)) return;
            visited.add(realDir);
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (results.length >= limit) break;
              if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
              const fullPath = resolveWorkspacePath(path.join(dir, entry.name));
              if (!fullPath) continue;
              try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                  walkDir(fullPath, depth + 1);
                } else {
                  if (stat.size > 500_000) continue; // Skip large files
                  const content = fs.readFileSync(fullPath, "utf-8");
                  const lines = content.split("\n");
                  for (let i = 0; i < lines.length && results.length < limit; i++) {
                    if (regex.test(lines[i]!)) {
                      results.push({
                        file: path.relative(resolvedWorkspaceRootReal, fullPath),
                        line: i + 1,
                        text: lines[i]!.slice(0, 200),
                      });
                    }
                  }
                }
              } catch {
                // Skip entries whose stat/read fails (broken symlinks, etc.)
              }
            }
          } catch {
            // Skip unreadable dirs
          }
        };
        walkDir(resolvedWorkspaceRoot);
        return { ok: true, searchType, pattern, results, total: results.length };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  });

  const get_project_context = defineCoordinatorTool({
    description:
      "Get a summary of the project: key docs, file structure, and config. Use at mission start to understand the codebase.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        // Read key project files
        const keyFiles = ["package.json", "tsconfig.json", "README.md", "CLAUDE.md"];
        const docs: Record<string, string> = {};
        for (const f of keyFiles) {
          const fp = resolveWorkspacePath(f, true);
          if (!fp) continue;
          try {
            const content = fs.readFileSync(fp, "utf-8");
            docs[f] = content.slice(0, 4_000);
          } catch {
            // Skip missing/unreadable files
          }
        }
        // Top-level directory listing
        let topLevel: string[] = [];
        try {
          topLevel = fs.readdirSync(workspaceRoot)
            .filter((e) => !e.startsWith("."))
            .slice(0, 50);
        } catch {
          // Ignore
        }
        const workspaceRootLabel = "./";
        return {
          ok: true,
          projectRoot: workspaceRootLabel,
          projectRootRedacted: true,
          rootLabel: workspaceRootLabel,
          topLevelEntries: topLevel,
          docs,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  });

  // ─── Sub-Agent Delegation ──────────────────────────────────────

  const delegate_to_subagent = defineCoordinatorTool({
    description:
      "Delegate a subtask to a child agent under an existing worker. Creates a child step linked to the parent worker. Use this for nested decomposition when a worker's task naturally splits into sub-problems.",
    inputSchema: z.object({
      parentWorkerId: z.string().describe("Step key of the parent worker that owns this subtask"),
      name: z.string().describe("Human-readable name for the sub-agent"),
      prompt: z.string().describe("Full task prompt for the sub-agent"),
      modelId: z.string().optional().describe("Optional model ID override for the sub-agent"),
      role: z.string().optional().describe("Optional team role to bind (e.g. implementer, validator)"),
    }),
    execute: async ({ parentWorkerId, name, prompt, modelId, role }) => {
      try {
        const g = graph();
        const planningInputBlockReason = getPlanningInputBlockReason(g);
        if (planningInputBlockReason) {
          return { ok: false, error: planningInputBlockReason };
        }
        const planningQuestionPolicyBlockReason = getPlanningQuestionPolicyBlockReason(g);
        if (planningQuestionPolicyBlockReason) {
          return { ok: false, error: planningQuestionPolicyBlockReason };
        }
        const teamRuntime = resolveTeamRuntimeConfig(g);

        // Hard constraint: allowSubAgents must be enabled
        const subAgentsAllowed = teamRuntime?.allowSubAgents !== false;
        if (!subAgentsAllowed) {
          return { ok: false, error: "Sub-agent delegation is disabled (allowSubAgents=false). Use spawn_worker instead." };
        }

        // Verify parent worker exists and is not terminal
        const parentStep = resolveStep(g, parentWorkerId);
        if (!parentStep) {
          return { ok: false, error: `Parent worker '${parentWorkerId}' not found.` };
        }
        if (TERMINAL_STEP_STATUSES.has(parentStep.status)) {
          return {
            ok: false,
            error: `Parent worker '${parentWorkerId}' is already ${parentStep.status}. Cannot delegate to a completed worker.`,
          };
        }

        const roleDef = role?.trim().length ? resolveRoleDefinition(teamRuntime, role.trim()) : null;
        const spawnPolicy = authorizeWorkerSpawnPolicy({
          g,
          requestedModelId: modelId,
        });
        if (!spawnPolicy.ok) {
          return { ok: false, error: spawnPolicy.error };
        }
        const resolvedModelId = spawnPolicy.resolvedModelId;
        const resolvedProvider = spawnPolicy.resolvedProvider;
        const resolvedDescriptor = resolveModelDescriptor(resolvedModelId);
        if (!resolvedDescriptor) {
          return { ok: false, error: `Model '${resolvedModelId}' is not registered.` };
        }

        // Hard constraint: allowClaudeAgentTeams must be enabled for Claude CLI sub-agents
        if (resolvedProvider === "claude" && resolvedDescriptor.isCliWrapped && teamRuntime?.allowClaudeAgentTeams === false) {
          return {
            ok: false,
            error: "Claude agent teams are disabled (allowClaudeAgentTeams=false). Cannot delegate claude sub-agent.",
          };
        }

        // Validate role if specified
        const normalizedRole = typeof role === "string" ? role.trim() : "";
        if (normalizedRole.length > 0 && !resolveRoleDefinition(teamRuntime, normalizedRole)) {
          return { ok: false, error: `Unknown role '${normalizedRole}' in active team template.` };
        }
        const missionPhases = resolveMissionPhases(g);
        const phaseContext = resolveConfiguredPhaseContext(g, missionPhases);
        if (!phaseContext.ok) {
          return { ok: false, error: phaseContext.error };
        }
        const currentPhase = phaseContext.currentPhase;
        const currentPhaseKey = currentPhase?.phaseKey.trim().toLowerCase() ?? "";
        const phaseValidation = validateDelegationPromptForCurrentPhase({
          currentPhaseKey,
          workerName: name,
          roleName: null,
          prompt,
          validationContract: null,
          validationHeuristics: "prompt_only",
        });
        if (!phaseValidation.ok) {
          return { ok: false, error: phaseValidation.error };
        }

        // Budget hard cap check
        const budgetCheck = await checkBudgetHardCaps({
          failClosedOnTelemetryError: true,
          operation: "delegate_to_subagent",
        });
        if (budgetCheck.blocked) {
          logger.warn("coordinator.delegate_to_subagent.hard_cap_blocked", { name, detail: budgetCheck.detail });
          return {
            ok: false,
            error: `Cannot delegate sub-agent: ${budgetCheck.detail}. Mission pausing.`,
            hardCapTriggered: true,
            hardCaps: budgetCheck.hardCaps,
          };
        }

        const delegationContract = buildCoordinatorDelegationContract({
          graph: g,
          workerId: `worker_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}`,
          phaseKey: currentPhaseKey,
          workerName: name,
          intent: "subagent",
          mode: "bounded_parallel",
          scopeKind: "worker",
          scopeKey: `worker:${parentWorkerId}:child:${name.trim().toLowerCase() || "child"}`,
          scopeLabel: currentPhase?.name ?? parentWorkerId,
          metadata: {
            parentWorkerId,
          },
        });
        const conflictingContract = hasConflictingDelegationContract({
          graph: g,
          contract: delegationContract,
        });
        if (conflictingContract) {
          return {
            ok: false,
            error:
              `Delegation scope '${delegationContract.scope.key}' is already owned by active ${conflictingContract.mode} delegation ` +
              `(${conflictingContract.workerIntent}). Wait for it to finish before launching an overlapping child task.`,
          };
        }

        // Create child step via spawnWorkerStep with parent linkage
        const { workerId, step: newStep, roleName, modelId: spawnedModelId, toolProfile } = spawnWorkerStep({
          stepKey: delegationContract.activeWorkerIds[0],
          name,
          modelId: resolvedModelId,
          prompt,
          dependsOn: [parentWorkerId],
          roleName: normalizedRole.length > 0 ? normalizedRole : null,
          laneId: parentStep.laneId ?? null,
          delegationContract,
        });

        // Attach parent linkage metadata to the new step
        if (newStep) {
          const finalizedDelegationContract = updateDelegationContract(delegationContract, {
            activeWorkerIds: [workerId],
            status: "active",
            launchState: "waiting_on_worker",
          });
          orchestratorService.updateStepMetadata({
            runId,
            stepId: newStep.id,
            metadata: {
              parentWorkerId,
              parentStepId: parentStep.id,
              isSubAgent: true,
              delegationContract: finalizedDelegationContract,
            },
          });
          persistDelegationContract({
            contract: finalizedDelegationContract,
            stepId: newStep.id,
            reason: "delegation_contract_created",
            action: "created",
          });

          onDagMutation({
            runId,
            mutation: { type: "step_added", step: newStep },
            timestamp: nowIso(),
            source: "coordinator",
          });
        }

        // Trigger autopilot to pick up the new step
        let launched = false;
        let launchNote: string | undefined;
        try {
          const startedCount = await Promise.race([
            orchestratorService.startReadyAutopilotAttempts({
              runId,
              reason: "coordinator_delegate_subagent",
            }),
            new Promise<number>((_, reject) =>
              setTimeout(() => reject(new Error("autopilot_start_timeout")), AUTOPILOT_START_TIMEOUT_MS)
            ),
          ]);
          if (newStep) {
            const freshGraph = graph();
            const runningAttempt = freshGraph.attempts.find(
              (a) => a.stepId === newStep.id && a.status === "running",
            );
            launched = !!runningAttempt;
            if (!launched && startedCount > 0) {
              launchNote = "autopilot_started_other_steps";
            } else if (!launched) {
              launchNote = "step_queued_not_yet_started";
            }
          } else {
            launched = startedCount > 0;
          }
        } catch {
          launchNote = "autopilot_start_timeout_step_queued";
          logger.warn("coordinator.delegate_to_subagent.autopilot_timeout", { name, workerId });
        }

        trackTeamMember({
          workerId,
          provider: resolvedProvider,
          modelId: spawnedModelId,
          role: roleName,
          source: "ade-subagent",
          isSubAgent: true,
          parentWorkerId
        });

        logger.info("coordinator.delegate_to_subagent", {
          name,
          workerId,
          parentWorkerId,
          provider: resolvedProvider,
          role: roleName,
          launched,
          launchNote,
        });

        return {
          ok: true,
          workerId,
          parentWorkerId,
          launched,
          ...(launchNote ? { launchNote } : {}),
          stepId: newStep?.id ?? null,
          status: newStep?.status ?? "unknown",
          name,
          modelId: spawnedModelId,
          provider: resolvedProvider,
          role: roleName,
          toolProfile,
          delegationContract: updateDelegationContract(delegationContract, {
            activeWorkerIds: [workerId],
            status: "active",
            launchState: "waiting_on_worker",
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.delegate_to_subagent.error", { name, parentWorkerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const delegate_parallel = defineCoordinatorTool({
    description:
      "Delegate multiple subtasks to child agents in a single atomic batch under one parent worker.",
    inputSchema: z.object({
      parentWorkerId: z.string().describe("Step key of the parent worker that owns this subtask batch"),
      tasks: z.array(
        z.object({
          name: z.string().describe("Human-readable name for the sub-agent"),
          prompt: z.string().describe("Full task prompt for the sub-agent"),
          modelId: z.string().optional().describe("Optional model ID override for this sub-agent"),
          role: z.string().optional().describe("Optional team role to bind (e.g. implementer, validator)"),
        })
      ).min(1).max(32).describe("Batch of child tasks to spawn under the same parent worker"),
    }),
    execute: async ({ parentWorkerId, tasks }) => {
      try {
        const g = graph();
        const planningInputBlockReason = getPlanningInputBlockReason(g);
        if (planningInputBlockReason) {
          return { ok: false, error: planningInputBlockReason };
        }
        const planningQuestionPolicyBlockReason = getPlanningQuestionPolicyBlockReason(g);
        if (planningQuestionPolicyBlockReason) {
          return { ok: false, error: planningQuestionPolicyBlockReason };
        }
        const teamRuntime = resolveTeamRuntimeConfig(g);

        if (teamRuntime?.allowSubAgents === false) {
          return { ok: false, error: "Sub-agent delegation is disabled (allowSubAgents=false). Use spawn_worker instead." };
        }
        if (teamRuntime?.allowParallelAgents === false) {
          return { ok: false, error: "Parallel agents disabled (allowParallelAgents=false). Batch delegation is not allowed." };
        }

        const parentStep = resolveStep(g, parentWorkerId);
        if (!parentStep) {
          return { ok: false, error: `Parent worker '${parentWorkerId}' not found.` };
        }
        if (TERMINAL_STEP_STATUSES.has(parentStep.status)) {
          return {
            ok: false,
            error: `Parent worker '${parentWorkerId}' is already ${parentStep.status}. Cannot delegate from a completed worker.`,
          };
        }

        const budgetCheck = await checkBudgetHardCaps({
          failClosedOnTelemetryError: true,
          operation: "delegate_parallel",
        });
        if (budgetCheck.blocked) {
          logger.warn("coordinator.delegate_parallel.hard_cap_blocked", {
            parentWorkerId,
            detail: budgetCheck.detail,
            taskCount: tasks.length,
          });
          return {
            ok: false,
            error: `Cannot delegate sub-agents: ${budgetCheck.detail}. Mission pausing.`,
            hardCapTriggered: true,
            hardCaps: budgetCheck.hardCaps,
          };
        }

        const missionPhases = resolveMissionPhases(g);
        const phaseContext = resolveConfiguredPhaseContext(g, missionPhases);
        if (!phaseContext.ok) {
          return { ok: false, error: phaseContext.error };
        }
        const currentPhase = phaseContext.currentPhase;
        const currentPhaseKey = currentPhase?.phaseKey.trim().toLowerCase() ?? "";
        const batchId = `delegation_batch_${Date.now()}`;

        const validatedTasks: Array<{
          name: string;
          prompt: string;
          normalizedRole: string | null;
          roleName: string | null;
          resolvedModelId: string;
          provider: string;
          toolProfile: Record<string, unknown> | null;
          delegationContract: DelegationContract;
        }> = [];

        for (let i = 0; i < tasks.length; i += 1) {
          const rawTask = tasks[i]!;
          const taskName = rawTask.name.trim();
          const taskPrompt = rawTask.prompt.trim();
          if (!taskName.length) {
            return { ok: false, error: `tasks[${i}].name is required.` };
          }
          if (!taskPrompt.length) {
            return { ok: false, error: `tasks[${i}].prompt is required.` };
          }
          const phaseValidation = validateDelegationPromptForCurrentPhase({
            currentPhaseKey,
            workerName: taskName,
            roleName: null,
            prompt: taskPrompt,
            validationContract: null,
            validationHeuristics: "prompt_only",
          });
          if (!phaseValidation.ok) {
            return { ok: false, error: phaseValidation.error };
          }
          const normalizedRole = typeof rawTask.role === "string" && rawTask.role.trim().length > 0
            ? rawTask.role.trim()
            : null;
          const roleDef = normalizedRole ? resolveRoleDefinition(teamRuntime, normalizedRole) : null;
          if (normalizedRole && !roleDef) {
            return { ok: false, error: `Unknown role '${normalizedRole}' in active team template.` };
          }
          const spawnPolicy = authorizeWorkerSpawnPolicy({
            g,
            requestedModelId: rawTask.modelId,
          });
          if (!spawnPolicy.ok) {
            return { ok: false, error: spawnPolicy.error };
          }
          const descriptor = resolveModelDescriptor(spawnPolicy.resolvedModelId);
          if (!descriptor) {
            return { ok: false, error: `Model '${spawnPolicy.resolvedModelId}' is not registered.` };
          }
          const provider = spawnPolicy.resolvedProvider;

          if (provider === "claude" && descriptor.isCliWrapped && teamRuntime?.allowClaudeAgentTeams === false) {
            return {
              ok: false,
              error: `Claude agent teams are disabled (allowClaudeAgentTeams=false). Cannot delegate claude sub-agent '${taskName}'.`,
            };
          }

          const delegationContract = buildCoordinatorDelegationContract({
            graph: g,
            workerId: `worker_${taskName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}_${i + 1}`,
            phaseKey: currentPhaseKey,
            workerName: taskName,
            intent: "parallel_subtasks",
            mode: "bounded_parallel",
            scopeKind: "batch",
            scopeKey: `worker:${parentWorkerId}:batch:${batchId}:task:${taskName.trim().toLowerCase() || i + 1}`,
            scopeLabel: currentPhase?.name ?? parentWorkerId,
            batchId,
            metadata: {
              parentWorkerId,
              taskIndex: i,
            },
          });
          const conflictingContract = hasConflictingDelegationContract({
            graph: g,
            contract: delegationContract,
          });
          if (conflictingContract) {
            return {
              ok: false,
              error:
                `Delegation scope '${delegationContract.scope.key}' is already owned by active ${conflictingContract.mode} delegation ` +
                `(${conflictingContract.workerIntent}). Wait for it to finish before launching an overlapping child task.`,
            };
          }

          validatedTasks.push({
            name: taskName,
            prompt: taskPrompt,
            normalizedRole,
            roleName: roleDef?.name ?? normalizedRole,
            resolvedModelId: spawnPolicy.resolvedModelId,
            provider,
            toolProfile: normalizedRole ? resolveRoleToolProfile(teamRuntime, normalizedRole) : null,
            delegationContract,
          });
        }

        const createdChildren: Array<{
          workerId: string;
          stepId: string | null;
          status: string;
          name: string;
          modelId: string;
          provider: string;
          role: string | null;
          toolProfile: Record<string, unknown> | null;
          delegationContract: DelegationContract;
        }> = [];

        for (const task of validatedTasks) {
          const { workerId, step: childStep, roleName, modelId: spawnedModelId, toolProfile } = spawnWorkerStep({
            stepKey: task.delegationContract.activeWorkerIds[0],
            name: task.name,
            modelId: task.resolvedModelId,
            prompt: task.prompt,
            dependsOn: [parentWorkerId],
            roleName: task.normalizedRole,
            laneId: parentStep.laneId ?? null,
            delegationContract: task.delegationContract,
          });

          if (childStep) {
            const finalizedDelegationContract = updateDelegationContract(task.delegationContract, {
              activeWorkerIds: [workerId],
              status: "active",
              launchState: "waiting_on_worker",
            });
            orchestratorService.updateStepMetadata({
              runId,
              stepId: childStep.id,
              metadata: {
                parentWorkerId,
                parentStepId: parentStep.id,
                isSubAgent: true,
                delegationContract: finalizedDelegationContract,
              },
            });
            persistDelegationContract({
              contract: finalizedDelegationContract,
              stepId: childStep.id,
              reason: "delegation_contract_created",
              action: "created",
            });

            onDagMutation({
              runId,
              mutation: { type: "step_added", step: childStep },
              timestamp: nowIso(),
              source: "coordinator",
            });
          }

          trackTeamMember({
            workerId,
            provider: task.provider,
            modelId: spawnedModelId,
            role: roleName,
            source: "ade-subagent",
            isSubAgent: true,
            parentWorkerId,
          });

          createdChildren.push({
            workerId,
            stepId: childStep?.id ?? null,
            status: childStep?.status ?? "unknown",
            name: task.name,
            modelId: spawnedModelId,
            provider: task.provider,
            role: roleName,
            toolProfile: toolProfile ?? task.toolProfile,
            delegationContract: updateDelegationContract(task.delegationContract, {
              activeWorkerIds: [workerId],
              status: "active",
              launchState: "waiting_on_worker",
            }),
          });
        }

        let launchNote: string | undefined;
        try {
          await Promise.race([
            orchestratorService.startReadyAutopilotAttempts({
              runId,
              reason: "coordinator_delegate_parallel",
            }),
            new Promise<number>((_, reject) =>
              setTimeout(() => reject(new Error("autopilot_start_timeout")), AUTOPILOT_START_TIMEOUT_MS)
            ),
          ]);
        } catch {
          launchNote = "autopilot_start_timeout_steps_queued";
          logger.warn("coordinator.delegate_parallel.autopilot_timeout", {
            parentWorkerId,
            taskCount: tasks.length,
          });
        }

        const freshGraph = graph();
        const launchedCount = createdChildren.reduce((count, child) => {
          if (!child.stepId) return count;
          const hasRunningAttempt = freshGraph.attempts.some((attempt) => attempt.stepId === child.stepId && attempt.status === "running");
          return count + (hasRunningAttempt ? 1 : 0);
        }, 0);

        logger.info("coordinator.delegate_parallel", {
          batchId,
          parentWorkerId,
          taskCount: createdChildren.length,
          launchedCount,
          launchNote,
        });

        return {
          ok: true,
          batchId,
          parentWorkerId,
          total: createdChildren.length,
          launchedCount,
          pendingCount: Math.max(0, createdChildren.length - launchedCount),
          ...(launchNote ? { launchNote } : {}),
          children: createdChildren,
          delegationContracts: createdChildren.map((child) => child.delegationContract),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.delegate_parallel.error", { parentWorkerId, error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const check_finalization_status = defineCoordinatorTool({
    description:
      "Check the current finalization/queue-landing status for this mission. Returns contractSatisfied, executionComplete, queue landing state, closeout requirements, and any blockers. Use this before deciding to complete_mission when finalization is in progress, or after receiving a queue landing event.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const state = await readMissionStateDocument({
          projectRoot,
          runId,
        });
        if (!state) {
          return {
            ok: true,
            finalizationActive: false,
            summary: "No mission state document found. Finalization has not been configured.",
          };
        }
        const fin = state.finalization;
        if (!fin) {
          return {
            ok: true,
            finalizationActive: false,
            summary: "No finalization policy is active for this mission.",
          };
        }
        return {
          ok: true,
          finalizationActive: true,
          status: fin.status,
          executionComplete: fin.executionComplete,
          contractSatisfied: fin.contractSatisfied,
          blocked: fin.blocked,
          blockedReason: fin.blockedReason,
          waitReason: fin.waitReason,
          summary: fin.summary,
          detail: fin.detail,
          prUrls: fin.prUrls,
          mergeReadiness: fin.mergeReadiness,
          requirements: fin.requirements,
          warnings: fin.warnings,
          updatedAt: fin.updatedAt,
          completedAt: fin.completedAt,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.check_finalization_status.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  return {
    spawn_worker,
    insert_milestone,
    request_specialist,
    delegate_to_subagent,
    delegate_parallel,
    stop_worker,
    send_message,
    message_worker,
    broadcast,
    get_worker_output,
    list_workers,
    report_status,
    reflection_add,
    report_result,
    report_validation,
    read_mission_status,
    read_mission_state,
    update_mission_state,
    memory_search,
    memory_add,
    revise_plan,
    update_tool_profiles,
    transfer_lane,
    provision_lane,
    set_current_phase,
    create_task,
    update_task,
    assign_task,
    list_tasks,
    skip_step,
    mark_step_complete,
    mark_step_failed,
    retry_step,
    complete_mission,
    fail_mission,
    get_budget_status,
    ask_user,
    request_user_input,
    read_file,
    read_step_output,
    search_files,
    get_project_context,
    check_finalization_status,
  };
}
