import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ConflictProposal,
  ConflictProposalPreview,
  ExternalConflictResolverProvider,
  FinalizeRunArgs,
  FinalizeRunResult,
  MissionExecutionPolicy,
  MissionStepHandoff,
  MissionRetrospective,
  OrchestratorRetrospectivePatternStat,
  OrchestratorRetrospectiveTrend,
  OrchestratorAttempt,
  OrchestratorAttemptResultEnvelope,
  OrchestratorAttemptStatus,
  OrchestratorClaim,
  OrchestratorClaimScope,
  OrchestratorClaimState,
  OrchestratorContextPolicyProfile,
  OrchestratorContextProfileId,
  OrchestratorContextSnapshot,
  OrchestratorContextSnapshotCursor,
  OrchestratorDocsRef,
  OrchestratorErrorClass,
  OrchestratorExecutorKind,
  OrchestratorGateEntry,
  OrchestratorGateReport,
  OrchestratorGateStatus,
  OrchestratorMemoryHierarchy,
  OrchestratorRun,
  OrchestratorRunGraph,
  OrchestratorRunStatus,
  OrchestratorStep,
  OrchestratorStepStatus,
  OrchestratorRuntimeBusEvent,
  OrchestratorReflectionEntry,
  OrchestratorRuntimeEventType,
  OrchestratorTeamRuntimeState,
  OrchestratorTimelineEvent,
  PackExport,
  PrepareResolverSessionArgs,
  PtyCreateArgs,
  RunCompletionEvaluation,
  StartOrchestratorRunArgs,
  StartOrchestratorRunStepInput,
  RecoveryLoopPolicy,
  RecoveryLoopIteration,
  RecoveryLoopState,
  OrchestratorContextView,
  ContextViewPolicy,
  OrchestratorWorkerRole,
  RoleIsolationValidation,
  IntegrationPrPolicy,
  MissionLevelSettings,
  PhaseCard,
  TerminalToolType,
  OrchestratorArtifact,
  OrchestratorArtifactKind,
  OrchestratorWorkerCheckpoint,
  FanOutDecision,
  AgentChatExecutionMode,
  AgentChatPermissionMode,
} from "../../../shared/types";
import {
  DEFAULT_RECOVERY_LOOP_POLICY,
  DEFAULT_CONTEXT_VIEW_POLICIES,
  DEFAULT_ROLE_ISOLATION_RULES,
} from "./orchestratorConstants";
import { evaluateRunCompletion, evaluateRunCompletionFromPhases, validateRunCompletion, DEFAULT_EXECUTION_POLICY } from "./executionPolicy";
import {
  createUnifiedOrchestratorAdapter,
  cleanupMcpConfigFile,
} from "./unifiedOrchestratorAdapter";
import { resolveClaudeCliModel, resolveCodexCliModel } from "../ai/claudeModelUtils";
import { runGit } from "../git/git";
import type { AdeDb, SqlValue } from "../state/kvDb";
import type { createPackService } from "../packs/packService";
import type { createPtyService } from "../pty/ptyService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createPrService } from "../prs/prService";
import type { createMemoryService } from "../memory/memoryService";
import type { createExternalMcpService } from "../externalMcp/externalMcpService";
import { asRecord, nowIso, parseJsonRecord, TERMINAL_STEP_STATUSES, filterExecutionSteps } from "./orchestratorContext";
import { parseNumericDependencyIndices } from "./missionLifecycle";
import { getMissionStateDocumentPath } from "./missionStateDoc";
import { buildFullPrompt, shellEscapeArg, shellInlineDecodedArg } from "./baseOrchestratorAdapter";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import { classifyWorkerExecutionPath, resolveModelDescriptor } from "../../../shared/modelRegistry";
import {
  deriveAgentChatTranscriptSummary,
  hasMaterialWorkerChatEvent,
  hasWorkerChatLifecycleEvent,
  parseAgentChatTranscript,
} from "../../../shared/chatTranscript";
import { isWorkerBootstrapNoiseLine } from "../../../shared/workerRuntimeNoise";
import { deriveSessionSummaryFromText } from "../packs/transcriptInsights";
import {
  type RunRow, type StepRow, type AttemptRow, type ClaimRow,
  type ContextSnapshotRow, type HandoffRow, type TimelineRow,
  type RuntimeEventRow, type GateReportRow, type ArtifactRow,
  DEFAULT_CONTEXT_POLICY, DEFAULT_CONTEXT_PROFILE_ID,
  TERMINAL_RUN_STATUSES, RETRYABLE_ERROR_CLASSES,
  MAX_TIMELINE_LIMIT, GATE_THRESHOLDS,
  normalizeIsoTimestamp, normalizeRunStatus,
  normalizeExecutorKind,
  normalizeJoinPolicy,
  normalizeRuntimeEventType, normalizeProfileId, normalizeTerminalSessionStatus,
  parseArray, isExecutionPolicyRecord,
  asBool, asIntInRange, asNumberInRange, asPositiveNumberOrNull,
  toRun, toStep, toAttempt, toClaim, toContextSnapshot, toHandoff,
  toArtifact, toTimelineEvent, toRuntimeEvent, toGateReport,
  normalizeEnvelope,
  type StepGraphValidationStep,
  normalizeDependencyStepKeys, validateStepGraphIntegrity,
  branchNameFromRef, clipText,
  classifyBlockingWarnings,
} from "./orchestratorQueries";
import {
  type ResolvedOrchestratorRuntimeConfig,
  DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG,
  resolveStepPolicy, resolveContextPolicy,
  parseAutopilotConfig, parseStepPolicyFromMetadata,
  readyStepOrderComparator,
  normalizeRepoRelativePath, normalizeFileClaimScopeValue,
  doesFileClaimMatchPath, doFileClaimsOverlap,
  readDocPaths,
} from "./stepPolicyResolver";
import { normalizeAgentRuntimeFlags } from "./teamRuntimeConfig";
import { normalizeMissionPermissions, providerPermissionsToLegacyConfig, mapPermissionToInProcess } from "./permissionMapping";
import type { MissionPermissionConfig } from "../../../shared/types/missions";
import { resolveAdeLayout } from "../../../shared/adeLayout";

// Row types, StepPolicy, and other extracted types are imported from
// ./orchestratorQueries and ./stepPolicyResolver

type CreateSnapshotResult = {
  snapshotId: string;
  cursor: OrchestratorContextSnapshotCursor;
  laneExport: PackExport | null;
  projectExport: PackExport;
  docsRefs: OrchestratorDocsRef[];
  fullDocs: Array<{ path: string; content: string; truncated: boolean }>;
};

// ResolvedOrchestratorRuntimeConfig is imported from ./stepPolicyResolver

export type OrchestratorEvent = {
  type:
    | "orchestrator-run-updated"
    | "orchestrator-step-updated"
    | "orchestrator-attempt-updated"
    | "orchestrator-claim-updated";
  runId?: string;
  stepId?: string;
  attemptId?: string;
  claimId?: string;
  at: string;
  reason: string;
};

type ManagedWorkerLaunch = {
  prompt: string;
  displayText: string;
  reasoningEffort?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  permissionMode?: AgentChatPermissionMode | null;
};

export type OrchestratorExecutorStartResult =
  | {
      status: "accepted";
      sessionId?: string | null;
      metadata?: Record<string, unknown> | null;
      launch?: ManagedWorkerLaunch | null;
    }
  | {
      status: "completed";
      result: OrchestratorAttemptResultEnvelope;
      metadata?: Record<string, unknown> | null;
    }
  | {
      status: "failed";
      errorClass?: OrchestratorErrorClass;
      errorMessage: string;
      metadata?: Record<string, unknown> | null;
    };

export type OrchestratorExecutorStartArgs = {
  run: OrchestratorRun;
  step: OrchestratorStep;
  attempt: OrchestratorAttempt;
  /** All steps in the run, for building a compact plan view in the worker prompt. */
  allSteps: OrchestratorStep[];
  contextProfile: OrchestratorContextPolicyProfile;
  laneExport: PackExport | null;
  projectExport: PackExport;
  docsRefs: OrchestratorDocsRef[];
  fullDocs: Array<{ path: string; content: string; truncated: boolean }>;
  createTrackedSession: (args: Omit<PtyCreateArgs, "tracked"> & { tracked?: boolean }) => Promise<{ ptyId: string; sessionId: string }>;
  permissionConfig?: {
    cli?: {
      mode?: "read-only" | "edit" | "full-auto";
      sandboxPermissions?: "read-only" | "workspace-write" | "danger-full-access";
      writablePaths?: string[];
      allowedTools?: string[];
    };
    inProcess?: {
      mode?: "plan" | "edit" | "full-auto";
    };
    /** Per-provider permission modes (new unified shape). When present, adapters
     *  should prefer this over the legacy cli/inProcess fields. */
    _providers?: import("../../../shared/types/missions").MissionProviderPermissions;
  };
  /** Checkpoint content from a previous interrupted attempt's worker checkpoint file. */
  previousCheckpoint?: string;
  /** Summary/error from the previous attempt on the same step (for retry context). */
  previousAttemptSummary?: string;
  /** Optional memory service for injecting project memory into prompts and supporting memory tools. */
  memoryService?: unknown;
  /** Project ID for memory service scoping. */
  memoryProjectId?: string;
  /** Precomputed shared memory briefing for prompt assembly. */
  memoryBriefing?: import("../memory/memoryBriefingService").MemoryBriefing | null;
};

export type OrchestratorExecutorAdapter = {
  kind: OrchestratorExecutorKind;
  requiresLaneId?: boolean;
  start: (args: OrchestratorExecutorStartArgs) => Promise<OrchestratorExecutorStartResult>;
};

// Constants (CONTEXT_PROFILES, TERMINAL_RUN_STATUSES, etc.) and
// DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG are imported from
// ./orchestratorQueries and ./stepPolicyResolver

// Normalizer functions are imported from ./orchestratorQueries

// StepGraphValidationStep, normalizeDependencyStepKeys, validateStepGraphIntegrity
// are imported from ./orchestratorQueries

// Row-to-domain mappers, normalizeEnvelope, sha256, clipText,
// file claim helpers, readDocPaths, resolveStepPolicy, resolveContextPolicy,
// parseAutopilotConfig, parseStepPolicyFromMetadata, parseStepAIPriority,
// readyStepOrderComparator are imported from ./orchestratorQueries and ./stepPolicyResolver

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function getWorkerCheckpointPath(worktreePath: string, stepKey: string): string {
  const sanitizedStepKey = stepKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(worktreePath, ".ade", "checkpoints", `${sanitizedStepKey}.md`);
}

type NormalizedValidationContract = {
  level: "step" | "milestone" | "mission";
  tier: "self" | "dedicated";
  required: boolean;
  criteria: string;
  evidence: string[];
  maxRetries: number;
};

function normalizeValidationTier(value: unknown): "none" | "self" | "dedicated" {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "dedicated") return "dedicated";
  if (raw === "self" || raw === "self-check") return "self";
  return "none";
}

function parseValidationContract(value: unknown): NormalizedValidationContract | null {
  const record = asRecord(value);
  if (!record) return null;
  const levelRaw = typeof record.level === "string" ? record.level.trim().toLowerCase() : "";
  const level =
    levelRaw === "step" || levelRaw === "milestone" || levelRaw === "mission"
      ? levelRaw
      : "step";
  const tier = normalizeValidationTier(record.tier);
  if (tier === "none") return null;
  const criteria = typeof record.criteria === "string" ? record.criteria.trim() : "";
  if (!criteria.length) return null;
  const evidence = Array.isArray(record.evidence)
    ? record.evidence
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => entry.length > 0)
    : [];
  const maxRetriesRaw = Number(record.maxRetries);
  const maxRetries = Number.isFinite(maxRetriesRaw)
    ? Math.max(0, Math.min(10, Math.floor(maxRetriesRaw)))
    : 2;
  return {
    level,
    tier,
    required: record.required !== false,
    criteria,
    evidence,
    maxRetries,
  };
}

function hasPassingValidation(metadata: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  const validationState = typeof metadata.validationState === "string"
    ? metadata.validationState.trim().toLowerCase()
    : "";
  if (validationState === "pass") return true;
  const lastValidationReport = asRecord(metadata.lastValidationReport);
  const reportVerdict = typeof lastValidationReport?.verdict === "string"
    ? lastValidationReport.verdict.trim().toLowerCase()
    : "";
  if (reportVerdict === "pass") return true;
  const validationPassedAt = typeof metadata.validationPassedAt === "string" ? metadata.validationPassedAt.trim() : "";
  return validationPassedAt.length > 0;
}

type ReflectionAddInput = {
  missionId: string;
  runId: string;
  stepId?: string | null;
  attemptId?: string | null;
  agentRole: string;
  phase: string;
  signalType: "wish" | "frustration" | "idea" | "pattern" | "limitation";
  observation: string;
  recommendation: string;
  context: string;
  occurredAt?: string;
};

type ReflectionValidationCode =
  | "mission_id_required"
  | "run_id_required"
  | "agent_role_required"
  | "phase_required"
  | "signal_type_invalid"
  | "observation_required"
  | "recommendation_required"
  | "context_required"
  | "occurred_at_invalid"
  | "run_not_found"
  | "run_mission_mismatch"
  | "step_not_found"
  | "step_run_mismatch"
  | "attempt_not_found"
  | "attempt_run_mismatch"
  | "attempt_step_mismatch";

export class ReflectionValidationError extends Error {
  readonly code: ReflectionValidationCode;
  readonly details: Record<string, unknown> | null;

  constructor(code: ReflectionValidationCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ReflectionValidationError";
    this.code = code;
    this.details = details ?? null;
  }
}

type PainPointCounter = Map<string, { label: string; count: number }>;

const RETROSPECTIVE_PATTERN_PROMOTION_THRESHOLD = 2;
const RETROSPECTIVE_TREND_LOOKBACK_LIMIT = 50;
const ISO_8601_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeReflectionSignalType(value: string): OrchestratorReflectionEntry["signalType"] | null {
  if (
    value === "wish" ||
    value === "frustration" ||
    value === "idea" ||
    value === "pattern" ||
    value === "limitation"
  ) {
    return value;
  }
  return null;
}

function normalizePainPointKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isStrictIsoTimestamp(value: string): boolean {
  if (!ISO_8601_TIMESTAMP_RE.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function parseRetrospectivePayload(payload: string | null | undefined): MissionRetrospective | null {
  try {
    const parsed = JSON.parse(String(payload ?? "{}")) as MissionRetrospective;
    if (parsed && typeof parsed.missionId === "string" && typeof parsed.runId === "string" && parsed.missionId && parsed.runId) {
      return parsed;
    }
  } catch {
    // ignore malformed payloads
  }
  return null;
}

function buildPainPointCounter(entries: string[]): PainPointCounter {
  const counter: PainPointCounter = new Map();
  for (const entry of entries) {
    const label = String(entry ?? "").trim();
    if (!label) continue;
    const key = normalizePainPointKey(label);
    if (!key) continue;
    const current = counter.get(key);
    if (current) {
      current.count += 1;
    } else {
      counter.set(key, { label, count: 1 });
    }
  }
  return counter;
}

function computePainTrendStatus(previousPainScore: number, currentPainScore: number): "resolved" | "still_open" | "worsened" {
  if (currentPainScore <= 0) return "resolved";
  if (currentPainScore > previousPainScore) return "worsened";
  return "still_open";
}

function ensureReflectionLedgerDir(projectRoot: string): string {
  const dir = resolveAdeLayout(projectRoot).reflectionsDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendReflectionLedgerEntry(projectRoot: string, missionId: string, payload: Record<string, unknown>): void {
  const dir = ensureReflectionLedgerDir(projectRoot);
  const filePath = path.join(dir, `${missionId}.jsonl`);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function persistRetrospectiveArtifact(projectRoot: string, missionId: string, runId: string, payload: Record<string, unknown>): string {
  const dir = path.join(ensureReflectionLedgerDir(projectRoot), "retrospectives");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${missionId}-${runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

function loadMissionStateDocCounts(projectRoot: string, runId: string): {
  decisions: number;
  activeIssues: number;
  pendingInterventions: number;
  stepOutcomes: number;
} {
  const filePath = getMissionStateDocumentPath(projectRoot, runId);
  if (!fs.existsSync(filePath)) {
    return { decisions: 0, activeIssues: 0, pendingInterventions: 0, stepOutcomes: 0 };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const decisions = Array.isArray(parsed.decisions) ? parsed.decisions.length : 0;
    const activeIssues = Array.isArray(parsed.activeIssues) ? parsed.activeIssues.length : 0;
    const pendingInterventions = Array.isArray(parsed.pendingInterventions) ? parsed.pendingInterventions.length : 0;
    const stepOutcomes = Array.isArray(parsed.stepOutcomes) ? parsed.stepOutcomes.length : 0;
    return { decisions, activeIssues, pendingInterventions, stepOutcomes };
  } catch {
    return { decisions: 0, activeIssues: 0, pendingInterventions: 0, stepOutcomes: 0 };
  }
}

function readUtf8Tail(filePath: string, maxBytes = 64 * 1024): string {
  const stat = fs.statSync(filePath);
  const size = Math.max(0, Number(stat.size) || 0);
  if (size <= maxBytes) {
    return fs.readFileSync(filePath, "utf8");
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function deriveTranscriptSummaryFromPath(filePath: string | null | undefined): string | null {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath || !fs.existsSync(normalizedPath)) return null;
  try {
    const rawTail = readUtf8Tail(normalizedPath);
    if (normalizedPath.endsWith(".chat.jsonl")) {
      const events = parseAgentChatTranscript(rawTail);
      return deriveAgentChatTranscriptSummary(events);
    }
    const sanitizedTail = rawTail
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !isWorkerBootstrapNoiseLine(line))
      .join("\n");
    const summary = deriveSessionSummaryFromText(sanitizedTail).trim();
    if (!summary.length) return null;
    const lowerSummary = summary.toLowerCase();
    if (
      lowerSummary.startsWith("ade_mission_id=")
      || lowerSummary.startsWith("-p \"$(cat ")
      || lowerSummary.includes("worker-prompts/worker-")
      || lowerSummary.includes("exec claude --model")
      || lowerSummary.includes("exec codex ")
    ) {
      return null;
    }
    return summary;
  } catch {
    return null;
  }
}

function analyzeTranscriptFromPath(filePath: string | null | undefined): {
  summary: string | null;
  hasMaterialOutput: boolean;
  hasLifecycleActivity: boolean;
  isStructuredChat: boolean;
} {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return { summary: null, hasMaterialOutput: false, hasLifecycleActivity: false, isStructuredChat: false };
  }
  try {
    const rawTail = readUtf8Tail(normalizedPath);
    if (normalizedPath.endsWith(".chat.jsonl")) {
      const events = parseAgentChatTranscript(rawTail);
      return {
        summary: deriveAgentChatTranscriptSummary(events),
        hasMaterialOutput: hasMaterialWorkerChatEvent(events),
        hasLifecycleActivity: hasWorkerChatLifecycleEvent(events),
        isStructuredChat: true,
      };
    }
    return {
      summary: deriveTranscriptSummaryFromPath(normalizedPath),
      hasMaterialOutput: deriveTranscriptSummaryFromPath(normalizedPath) != null,
      hasLifecycleActivity: deriveTranscriptSummaryFromPath(normalizedPath) != null,
      isStructuredChat: false,
    };
  } catch {
    return {
      summary: null,
      hasMaterialOutput: false,
      hasLifecycleActivity: false,
      isStructuredChat: normalizedPath.endsWith(".chat.jsonl"),
    };
  }
}

function classifySilentWorkerExit(args: {
  stepMetadata: Record<string, unknown> | null | undefined;
  transcriptSummary: string | null;
  hasMaterialOutput: boolean;
  hasLifecycleActivity: boolean;
}): { errorClass: OrchestratorErrorClass; errorMessage: string } | null {
  if (args.transcriptSummary) return null;
  if (isPlanningLikeStepMetadata(args.stepMetadata)) {
    if (args.hasLifecycleActivity && !args.hasMaterialOutput) {
      return {
        errorClass: "interrupted",
        errorMessage: "Planning worker session started but was interrupted before producing any assistant or tool activity.",
      };
    }
    if (!args.hasMaterialOutput) {
      return {
        errorClass: "startup_failure",
        errorMessage: "Planning worker exited before producing any assistant or tool activity.",
      };
    }
    return {
      errorClass: "executor_failure",
      errorMessage: "Planning worker exited after partial activity without reporting a usable plan summary.",
    };
  }
  if (args.hasLifecycleActivity && !args.hasMaterialOutput) {
    return {
      errorClass: "interrupted",
      errorMessage: "Worker session started but was interrupted before producing any assistant or tool activity.",
    };
  }
  if (!args.hasMaterialOutput) {
    return {
      errorClass: "startup_failure",
      errorMessage: "Worker session ended before producing any assistant or tool activity.",
    };
  }
  // VAL-ERR-001: Workers with material output but no transcript summary were
  // interrupted — classify as "interrupted" rather than returning null (which
  // would allow a "succeeded" status to stand for a worker that never reported
  // a proper result).
  return {
    errorClass: "interrupted",
    errorMessage: "Worker session ended after partial activity without reporting a final result.",
  };
}

function resolveRunPhaseCardsFromMetadata(runMetadata: Record<string, unknown> | null | undefined): PhaseCard[] | null {
  if (!runMetadata) return null;
  const phaseConfig = typeof runMetadata.phaseConfiguration === "object" && runMetadata.phaseConfiguration
    ? (runMetadata.phaseConfiguration as Record<string, unknown>)
    : null;
  const phaseCards =
    phaseConfig && Array.isArray(phaseConfig.phases)
      ? phaseConfig.phases as PhaseCard[]
      : phaseConfig && Array.isArray(phaseConfig.selectedPhases)
        ? phaseConfig.selectedPhases as PhaseCard[]
        : Array.isArray(runMetadata.phaseOverride)
          ? runMetadata.phaseOverride as PhaseCard[]
          : null;
  return phaseCards && phaseCards.length > 0 ? phaseCards : null;
}

function buildInitialPhaseRuntime(phaseCards: PhaseCard[] | null | undefined): Record<string, unknown> | null {
  if (!Array.isArray(phaseCards) || phaseCards.length === 0) return null;
  const initialPhase = [...phaseCards].sort((left, right) => left.position - right.position)[0]!;
  const transitionedAt = nowIso();
  return {
    currentPhaseKey: initialPhase.phaseKey,
    currentPhaseName: initialPhase.name,
    currentPhaseModel: initialPhase.model,
    currentPhaseInstructions: initialPhase.instructions,
    currentPhaseValidation: initialPhase.validationGate,
    currentPhaseBudget: initialPhase.budget ?? {},
    transitionedAt,
    transitions: [
      {
        fromPhaseKey: null,
        fromPhaseName: null,
        toPhaseKey: initialPhase.phaseKey,
        toPhaseName: initialPhase.name,
        at: transitionedAt,
        reason: "run_initialized"
      }
    ],
    phaseBudgets: {
      [initialPhase.phaseKey]: {
        enteredAt: transitionedAt,
        usedTokens: 0,
        usedCostUsd: 0
      }
    }
  };
}

function resolveRunMissionLevelSettingsFromMetadata(
  runMetadata: Record<string, unknown> | null | undefined,
): MissionLevelSettings | null {
  if (!runMetadata) return null;
  if (typeof runMetadata.missionLevelSettings === "object" && runMetadata.missionLevelSettings) {
    return runMetadata.missionLevelSettings as MissionLevelSettings;
  }
  const executionPolicy = isExecutionPolicyRecord(runMetadata.executionPolicy)
    ? (runMetadata.executionPolicy as MissionExecutionPolicy)
    : null;
  if (!executionPolicy && !Array.isArray(runMetadata.phaseOverride)) return null;
  return {
    prStrategy: executionPolicy?.prStrategy ?? { kind: "manual" },
    ...(executionPolicy?.integrationPr ? { integrationPr: executionPolicy.integrationPr } : {}),
    ...(executionPolicy?.teamRuntime ? { teamRuntime: executionPolicy.teamRuntime } : {}),
  };
}

function isPlanningLikeStepMetadata(stepMetadata: Record<string, unknown> | null | undefined): boolean {
  if (!stepMetadata) return false;
  const stepType = typeof stepMetadata.stepType === "string" ? stepMetadata.stepType.trim().toLowerCase() : "";
  const phaseKey = typeof stepMetadata.phaseKey === "string" ? stepMetadata.phaseKey.trim().toLowerCase() : "";
  return stepMetadata.readOnlyExecution === true || stepType === "planning" || phaseKey === "planning";
}

function resolveCurrentRunPhaseCard(
  runMetadata: Record<string, unknown> | null | undefined,
  phaseCards: PhaseCard[] | null | undefined,
): PhaseCard | null {
  if (!runMetadata || !Array.isArray(phaseCards) || phaseCards.length === 0) return null;
  const phaseRuntime = asRecord(runMetadata.phaseRuntime);
  const currentPhaseKey = typeof phaseRuntime?.currentPhaseKey === "string" ? phaseRuntime.currentPhaseKey.trim() : "";
  const currentPhaseName = typeof phaseRuntime?.currentPhaseName === "string" ? phaseRuntime.currentPhaseName.trim() : "";
  if (currentPhaseKey.length > 0) {
    const byKey = phaseCards.find((phase) => phase.phaseKey === currentPhaseKey);
    if (byKey) return byKey;
  }
  if (currentPhaseName.length > 0) {
    const byName = phaseCards.find((phase) => phase.name === currentPhaseName);
    if (byName) return byName;
  }
  return null;
}

function resolvePhaseCardForStep(
  step: OrchestratorStep,
  phaseCards: PhaseCard[] | null | undefined,
): PhaseCard | null {
  if (!Array.isArray(phaseCards) || phaseCards.length === 0) return null;
  const stepMetadata = asRecord(step.metadata);
  const stepPhaseKey = typeof stepMetadata?.phaseKey === "string" ? stepMetadata.phaseKey.trim() : "";
  const stepPhaseName = typeof stepMetadata?.phaseName === "string" ? stepMetadata.phaseName.trim() : "";
  if (stepPhaseKey.length > 0) {
    const byKey = phaseCards.find((phase) => phase.phaseKey === stepPhaseKey);
    if (byKey) return byKey;
  }
  if (stepPhaseName.length > 0) {
    const byName = phaseCards.find((phase) => phase.name === stepPhaseName);
    if (byName) return byName;
  }
  return null;
}

function stepRequiresValidation(
  step: OrchestratorStep,
  phaseCards: PhaseCard[] | null | undefined,
): boolean {
  const stepMetadata = asRecord(step.metadata);
  const validationContract = parseValidationContract(stepMetadata?.validationContract ?? null);
  if (validationContract?.required) return true;
  const phaseCard = resolvePhaseCardForStep(step, phaseCards);
  if (!phaseCard) return false;
  return phaseCard.validationGate.required === true && normalizeValidationTier(phaseCard.validationGate.tier) !== "none";
}

function stepMatchesPhase(step: OrchestratorStep, phase: PhaseCard): boolean {
  const stepMetadata = asRecord(step.metadata);
  const stepPhaseKey = typeof stepMetadata?.phaseKey === "string" ? stepMetadata.phaseKey.trim() : "";
  const stepPhaseName = typeof stepMetadata?.phaseName === "string" ? stepMetadata.phaseName.trim() : "";
  return stepPhaseKey === phase.phaseKey || stepPhaseName === phase.name;
}

function getExecutionStepsForPhase(phase: PhaseCard, steps: OrchestratorStep[]): OrchestratorStep[] {
  return filterExecutionSteps(steps.filter((step) => stepMatchesPhase(step, phase)));
}

function phaseHasSuccessfulCompletionRuntime(phase: PhaseCard, steps: OrchestratorStep[]): boolean {
  const phaseKey = phase.phaseKey.trim().toLowerCase();
  const phaseName = phase.name.trim().toLowerCase();
  const phaseSteps = getExecutionStepsForPhase(phase, steps);
  if (phaseSteps.length === 0) return false;
  if (phaseKey === "planning" || phaseName === "planning") {
    return phaseSteps.some((step) => isPlanningLikeStepMetadata(asRecord(step.metadata)) && step.status === "succeeded");
  }
  const allTerminalWithoutFailure = phaseSteps.every(
    (step) => step.status === "succeeded" || step.status === "skipped" || step.status === "superseded",
  );
  const hasConcreteSuccess = phaseSteps.some((step) => step.status === "succeeded");
  return allTerminalWithoutFailure && hasConcreteSuccess;
}

function phaseHasNonTerminalExecutionWork(phase: PhaseCard, steps: OrchestratorStep[]): boolean {
  return getExecutionStepsForPhase(phase, steps).some((step) => !TERMINAL_STEP_STATUSES.has(step.status));
}

function phaseHasAssignedExecutionWork(phase: PhaseCard, steps: OrchestratorStep[]): boolean {
  return getExecutionStepsForPhase(phase, steps).length > 0;
}

function canEnterConfiguredPhase(
  targetPhase: PhaseCard,
  phases: PhaseCard[],
  steps: OrchestratorStep[],
): boolean {
  const targetIndex = phases.findIndex((phase) => phase.phaseKey === targetPhase.phaseKey);
  if (targetIndex < 0) return false;
  for (let index = 0; index < targetIndex; index += 1) {
    const earlier = phases[index]!;
    const mustComplete = earlier.validationGate.required || earlier.orderingConstraints.mustBeFirst;
    if (mustComplete && !phaseHasSuccessfulCompletionRuntime(earlier, steps)) {
      return false;
    }
  }
  const mustFollow = targetPhase.orderingConstraints.mustFollow ?? [];
  for (const rawPredecessor of mustFollow) {
    const predecessorKey = rawPredecessor.trim();
    if (!predecessorKey.length) continue;
    const predecessor = phases.find((phase) => phase.phaseKey === predecessorKey || phase.name === predecessorKey);
    if (predecessor && !phaseHasSuccessfulCompletionRuntime(predecessor, steps)) {
      return false;
    }
  }
  return true;
}

export function createOrchestratorService({
  db,
  projectId,
  projectRoot,
  packService,
  conflictService,
  ptyService,
  agentChatService,
  prService,
  projectConfigService,
  aiIntegrationService,
  memoryService,
  memoryBriefingService,
  missionMemoryLifecycleService,
  episodicSummaryService,
  proceduralLearningService,
  knowledgeCaptureService,
  externalMcpService,
  onEvent
}: {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  packService: ReturnType<typeof createPackService>;
  conflictService?: ReturnType<typeof createConflictService>;
  ptyService?: ReturnType<typeof createPtyService>;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  prService?: ReturnType<typeof createPrService>;
  projectConfigService?: ReturnType<typeof createProjectConfigService> | null;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  memoryService?: ReturnType<typeof createMemoryService> | null;
  memoryBriefingService?: import("../memory/memoryBriefingService").MemoryBriefingService | null;
  missionMemoryLifecycleService?: import("../memory/missionMemoryLifecycleService").MissionMemoryLifecycleService | null;
  episodicSummaryService?: import("../memory/episodicSummaryService").EpisodicSummaryService | null;
  proceduralLearningService?: import("../memory/proceduralLearningService").ProceduralLearningService | null;
  knowledgeCaptureService?: import("../memory/knowledgeCaptureService").KnowledgeCaptureService | null;
  externalMcpService?: ReturnType<typeof createExternalMcpService> | null;
  onEvent?: (event: OrchestratorEvent) => void;
}) {
  const adapters = new Map<OrchestratorExecutorKind, OrchestratorExecutorAdapter>();
  // Register the unified adapter that handles all model providers
  adapters.set("unified", createUnifiedOrchestratorAdapter({
    projectRoot,
    workspaceRoot: projectRoot,
    agentChatService,
    externalMcpService,
  }));
  const autopilotRunLocks = new Set<string>();
  const recoveryLoopStates = new Map<string, RecoveryLoopState>();
  const toOptionalNonEmptyString = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const resolveRunMissionLaneId = (metadata: Record<string, unknown> | null | undefined): string | null => {
    const metadataRecord = metadata ? asRecord(metadata) : null;
    if (!metadataRecord) return null;
    const directLaneId = toOptionalNonEmptyString(metadataRecord.missionLaneId);
    if (directLaneId) return directLaneId;

    const coordinatorMeta = asRecord(metadataRecord.coordinator);
    const coordinatorLaneId = toOptionalNonEmptyString(coordinatorMeta?.missionLaneId);
    if (coordinatorLaneId) return coordinatorLaneId;

    const teamRuntimeMeta = asRecord(metadataRecord.teamRuntime);
    return toOptionalNonEmptyString(teamRuntimeMeta?.missionLaneId);
  };
  const getRuntimeConfig = (): ResolvedOrchestratorRuntimeConfig => {
    const snapshot = projectConfigService?.get();
    const ai = asRecord(snapshot?.effective?.ai);
    const orchestrator = asRecord(ai?.orchestrator);
    if (!orchestrator) return DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG;
    const out: ResolvedOrchestratorRuntimeConfig = { ...DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG };
    const teammatePlanMode = String(orchestrator.teammatePlanMode ?? "").trim();
    if (teammatePlanMode === "off" || teammatePlanMode === "auto" || teammatePlanMode === "required") {
      out.teammatePlanMode = teammatePlanMode;
    }
    out.maxParallelWorkers = asIntInRange(
      orchestrator.maxParallelWorkers,
      out.maxParallelWorkers,
      1,
      32
    );
    const mergePolicy = String(orchestrator.defaultMergePolicy ?? "").trim();
    if (mergePolicy === "sequential" || mergePolicy === "batch-at-end" || mergePolicy === "per-step") {
      out.defaultMergePolicy = mergePolicy;
    }
    const conflictHandoff = String(orchestrator.defaultConflictHandoff ?? "").trim();
    if (conflictHandoff === "auto-resolve" || conflictHandoff === "ask-user" || conflictHandoff === "orchestrator-decides") {
      out.defaultConflictHandoff = conflictHandoff;
    }
    out.workerHeartbeatIntervalMs = asIntInRange(
      orchestrator.workerHeartbeatIntervalMs,
      out.workerHeartbeatIntervalMs,
      1_000,
      600_000
    );
    out.workerHeartbeatTimeoutMs = asIntInRange(
      orchestrator.workerHeartbeatTimeoutMs,
      out.workerHeartbeatTimeoutMs,
      1_000,
      900_000
    );
    out.workerIdleTimeoutMs = asIntInRange(
      orchestrator.workerIdleTimeoutMs,
      out.workerIdleTimeoutMs,
      1_000,
      3_600_000
    );
    out.stepTimeoutDefaultMs = asIntInRange(
      orchestrator.stepTimeoutDefaultMs,
      out.stepTimeoutDefaultMs,
      1_000,
      3_600_000
    );
    out.maxRetriesPerStep = asIntInRange(
      orchestrator.maxRetriesPerStep,
      out.maxRetriesPerStep,
      0,
      8
    );
    out.contextPressureThreshold = asNumberInRange(
      orchestrator.contextPressureThreshold,
      out.contextPressureThreshold,
      0.1,
      0.99
    );
    out.progressiveLoading = asBool(orchestrator.progressiveLoading, out.progressiveLoading);
    out.maxTotalTokenBudget = asPositiveNumberOrNull(orchestrator.maxTotalTokenBudget);
    out.maxPerStepTokenBudget = asPositiveNumberOrNull(orchestrator.maxPerStepTokenBudget);
    const reservationGuardMode = String(
      orchestrator.fileReservationGuardMode
      ?? out.fileReservationGuardMode
    ).trim();
    if (reservationGuardMode === "off" || reservationGuardMode === "warn" || reservationGuardMode === "block") {
      out.fileReservationGuardMode = reservationGuardMode;
    }
    return out;
  };

  const emit = (event: Omit<OrchestratorEvent, "at">) => {
    onEvent?.({
      ...event,
      at: nowIso()
    });
  };

  const appendTimelineEvent = (args: {
    runId: string;
    stepId?: string | null;
    attemptId?: string | null;
    claimId?: string | null;
    eventType: string;
    reason: string;
    detail?: Record<string, unknown> | null;
  }): OrchestratorTimelineEvent => {
    const id = randomUUID();
    const createdAt = nowIso();
    db.run(
      `
        insert into orchestrator_timeline_events(
          id,
          project_id,
          run_id,
          step_id,
          attempt_id,
          claim_id,
          event_type,
          reason,
          detail_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        projectId,
        args.runId,
        args.stepId ?? null,
        args.attemptId ?? null,
        args.claimId ?? null,
        args.eventType,
        args.reason,
        args.detail ? JSON.stringify(args.detail) : null,
        createdAt
      ]
    );
    return {
      id,
      runId: args.runId,
      stepId: args.stepId ?? null,
      attemptId: args.attemptId ?? null,
      claimId: args.claimId ?? null,
      eventType: args.eventType,
      reason: args.reason,
      detail: args.detail ?? null,
      createdAt
    };
  };

  const appendRunNarrative = (runId: string, stepKey: string, summary: string): void => {
    const runRow = getRunRow(runId);
    if (!runRow) return;
    const meta = parseJsonRecord(runRow.metadata_json) ?? {};
    const narrative: Array<{ stepKey: string; summary: string; at: string }> = Array.isArray(meta.runNarrative)
      ? (meta.runNarrative as Array<{ stepKey: string; summary: string; at: string }>)
      : [];
    narrative.push({ stepKey, summary, at: new Date().toISOString() });
    // Keep only the last 20 entries
    if (narrative.length > 20) narrative.splice(0, narrative.length - 20);
    const updatedMeta = { ...meta, runNarrative: narrative };
    db.run(
      `update orchestrator_runs set metadata_json = ?, updated_at = ? where id = ? and project_id = ?`,
      [JSON.stringify(updatedMeta), nowIso(), runId, projectId]
    );
  };

  const persistUsedProcedureIds = (runId: string, usedProcedureIds: string[] | null | undefined): string[] => {
    const normalized = [...new Set((usedProcedureIds ?? []).map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0))];
    if (normalized.length === 0) return [];
    const runRow = getRunRow(runId);
    if (!runRow) return normalized;
    const metadata = parseJsonRecord(runRow.metadata_json) ?? {};
    const existing = Array.isArray(metadata.usedProcedureIds)
      ? metadata.usedProcedureIds.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
      : [];
    const merged = [...new Set([...existing, ...normalized])];
    if (merged.length === existing.length) return merged;
    db.run(
      `update orchestrator_runs set metadata_json = ?, updated_at = ? where id = ? and project_id = ?`,
      [
        JSON.stringify({
          ...metadata,
          usedProcedureIds: merged,
        }),
        nowIso(),
        runId,
        projectId,
      ]
    );
    return merged;
  };

  const applyProcedureOutcomeFeedback = (input: {
    runId: string;
    finalStatus: OrchestratorRunStatus;
    metadata: Record<string, unknown>;
    reason: string;
  }): Record<string, unknown> => {
    if (!proceduralLearningService || (input.finalStatus !== "succeeded" && input.finalStatus !== "failed")) {
      return input.metadata;
    }
    const usedProcedureIds = Array.isArray(input.metadata.usedProcedureIds)
      ? input.metadata.usedProcedureIds.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
      : [];
    if (usedProcedureIds.length === 0) return input.metadata;
    const existingFeedback = asRecord(input.metadata.procedureOutcomeFeedback) ?? {};
    const pending = [...new Set(usedProcedureIds)].filter((procedureId) => !asRecord(existingFeedback[procedureId]));
    if (pending.length === 0) return input.metadata;
    proceduralLearningService.updateProcedureOutcomes(
      pending.map((memoryId) => ({
        memoryId,
        outcome: input.finalStatus === "succeeded" ? "success" : "failure",
        reason: input.reason,
      })),
    );
    const appliedAt = nowIso();
    const nextFeedback = { ...existingFeedback };
    for (const procedureId of pending) {
      nextFeedback[procedureId] = {
        outcome: input.finalStatus,
        reason: input.reason,
        appliedAt,
      };
    }
    return {
      ...input.metadata,
      procedureOutcomeFeedback: nextFeedback,
    };
  };

  const persistRuntimeEvent = (args: {
    runId: string;
    stepId?: string | null;
    attemptId?: string | null;
    sessionId?: string | null;
    eventType: OrchestratorRuntimeEventType;
    eventKey?: string | null;
    occurredAt?: string | null;
    payload?: Record<string, unknown> | null;
  }): OrchestratorRuntimeBusEvent => {
    const createdAt = nowIso();
    const occurredAt = normalizeIsoTimestamp(args.occurredAt, createdAt);
    const baseKey = `${args.runId}:${args.stepId ?? "none"}:${args.attemptId ?? "none"}:${args.sessionId ?? "none"}:${args.eventType}:${occurredAt}`;
    const eventKey = String(args.eventKey ?? baseKey).trim() || baseKey;
    const eventId = randomUUID();
    db.run(
      `
        insert or ignore into orchestrator_runtime_events(
          id,
          project_id,
          run_id,
          step_id,
          attempt_id,
          session_id,
          event_type,
          event_key,
          occurred_at,
          payload_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        eventId,
        projectId,
        args.runId,
        args.stepId ?? null,
        args.attemptId ?? null,
        args.sessionId ?? null,
        args.eventType,
        eventKey,
        occurredAt,
        args.payload ? JSON.stringify(args.payload) : null,
        createdAt
      ]
    );
    const row = db.get<RuntimeEventRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          session_id,
          event_type,
          event_key,
          occurred_at,
          payload_json,
          created_at
        from orchestrator_runtime_events
        where project_id = ?
          and event_key = ?
        limit 1
      `,
      [projectId, eventKey]
    );
    if (!row) {
      throw new Error(`Failed to persist runtime event: ${args.eventType}`);
    }
    return toRuntimeEvent(row);
  };

  const listTimelineRows = (args: { runId: string; limit?: number }): TimelineRow[] => {
    const limitRaw = Number(args.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(MAX_TIMELINE_LIMIT, Math.floor(limitRaw))) : 200;
    return db.all<TimelineRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          claim_id,
          event_type,
          reason,
          detail_json,
          created_at
        from orchestrator_timeline_events
        where project_id = ?
          and run_id = ?
        order by created_at desc
        limit ?
      `,
      [projectId, args.runId, limit]
    );
  };

  const listRuntimeEventRows = (args: {
    runId?: string;
    attemptId?: string;
    sessionId?: string;
    eventTypes?: OrchestratorRuntimeEventType[];
    since?: string | null;
    limit?: number;
  }): RuntimeEventRow[] => {
    const where: string[] = ["project_id = ?"];
    const params: SqlValue[] = [projectId];
    if (args.runId) {
      where.push("run_id = ?");
      params.push(args.runId);
    }
    if (args.attemptId) {
      where.push("attempt_id = ?");
      params.push(args.attemptId);
    }
    if (args.sessionId) {
      where.push("session_id = ?");
      params.push(args.sessionId);
    }
    if (args.eventTypes && args.eventTypes.length > 0) {
      const normalizedTypes = [...new Set(args.eventTypes.map((entry) => normalizeRuntimeEventType(String(entry))))];
      const placeholders = normalizedTypes.map(() => "?").join(", ");
      where.push(`event_type in (${placeholders})`);
      params.push(...normalizedTypes);
    }
    if (args.since && String(args.since).trim().length > 0) {
      where.push("occurred_at >= ?");
      params.push(normalizeIsoTimestamp(args.since, nowIso()));
    }
    const limitRaw = Number(args.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5_000, Math.floor(limitRaw))) : 200;
    return db.all<RuntimeEventRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          session_id,
          event_type,
          event_key,
          occurred_at,
          payload_json,
          created_at
        from orchestrator_runtime_events
        where ${where.join(" and ")}
        order by occurred_at desc, created_at desc
        limit ?
      `,
      [...params, limit]
    );
  };

  const getRunRow = (runId: string): RunRow | null =>
    db.get<RunRow>(
      `
        select
          id,
          mission_id,
          project_id,
          status,
          context_profile,
          scheduler_state,
          runtime_cursor_json,
          last_error,
          metadata_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        from orchestrator_runs
        where id = ?
          and project_id = ?
        limit 1
      `,
      [runId, projectId]
    );

  const getStepRow = (stepId: string): StepRow | null =>
    db.get<StepRow>(
      `
        select
          id,
          run_id,
          mission_step_id,
          step_key,
          step_index,
          title,
          lane_id,
          status,
          join_policy,
          quorum_count,
          dependency_step_ids_json,
          retry_limit,
          retry_count,
          last_attempt_id,
          policy_json,
          metadata_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        from orchestrator_steps
        where id = ?
          and project_id = ?
        limit 1
      `,
      [stepId, projectId]
    );

  const listStepRows = (runId: string): StepRow[] =>
    db.all<StepRow>(
      `
        select
          id,
          run_id,
          mission_step_id,
          step_key,
          step_index,
          title,
          lane_id,
          status,
          join_policy,
          quorum_count,
          dependency_step_ids_json,
          retry_limit,
          retry_count,
          last_attempt_id,
          policy_json,
          metadata_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        from orchestrator_steps
        where run_id = ?
          and project_id = ?
        order by step_index asc, created_at asc
      `,
      [runId, projectId]
    );

  const getAttemptRow = (attemptId: string): AttemptRow | null =>
    db.get<AttemptRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_number,
          status,
          executor_kind,
          executor_session_id,
          tracked_session_enforced,
          context_profile,
          context_snapshot_id,
          error_class,
          error_message,
          retry_backoff_ms,
          result_envelope_json,
          metadata_json,
          created_at,
          started_at,
          completed_at
        from orchestrator_attempts
        where id = ?
          and project_id = ?
        limit 1
      `,
      [attemptId, projectId]
    );

  const listAttemptRows = (runId: string): AttemptRow[] =>
    db.all<AttemptRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_number,
          status,
          executor_kind,
          executor_session_id,
          tracked_session_enforced,
          context_profile,
          context_snapshot_id,
          error_class,
          error_message,
          retry_backoff_ms,
          result_envelope_json,
          metadata_json,
          created_at,
          started_at,
          completed_at
        from orchestrator_attempts
        where run_id = ?
          and project_id = ?
        order by created_at desc
      `,
      [runId, projectId]
    );

  const insertHandoff = (args: {
    missionId: string;
    missionStepId: string | null;
    runId: string | null;
    stepId: string | null;
    attemptId: string | null;
    handoffType: string;
    producer: string;
    payload: Record<string, unknown>;
  }): MissionStepHandoff => {
    const id = randomUUID();
    const createdAt = nowIso();
    db.run(
      `
        insert into mission_step_handoffs(
          id,
          project_id,
          mission_id,
          mission_step_id,
          run_id,
          step_id,
          attempt_id,
          handoff_type,
          producer,
          payload_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        projectId,
        args.missionId,
        args.missionStepId,
        args.runId,
        args.stepId,
        args.attemptId,
        args.handoffType,
        args.producer,
        JSON.stringify(args.payload),
        createdAt
      ]
    );
    return {
      id,
      missionId: args.missionId,
      missionStepId: args.missionStepId,
      runId: args.runId,
      stepId: args.stepId,
      attemptId: args.attemptId,
      handoffType: args.handoffType,
      producer: args.producer,
      payload: args.payload,
      createdAt
    };
  };

  const updateRunStatus = (runId: string, status: OrchestratorRunStatus, patch: Record<string, SqlValue> = {}) => {
    const existing = getRunRow(runId);
    if (!existing) throw new Error(`Run not found: ${runId}`);
    const updatedAt = nowIso();
    const startedAt = (status === "active" || status === "bootstrapping") && !existing.started_at ? updatedAt : existing.started_at;
    const completedAt = TERMINAL_RUN_STATUSES.has(status) ? updatedAt : null;
    db.run(
      `
        update orchestrator_runs
        set status = ?,
            scheduler_state = ?,
            runtime_cursor_json = ?,
            last_error = ?,
            metadata_json = ?,
            started_at = ?,
            completed_at = ?,
            updated_at = ?
        where id = ?
          and project_id = ?
      `,
      [
        status,
        patch.scheduler_state ?? existing.scheduler_state,
        patch.runtime_cursor_json ?? existing.runtime_cursor_json,
        patch.last_error ?? existing.last_error,
        patch.metadata_json ?? existing.metadata_json,
        startedAt,
        completedAt,
        updatedAt,
        runId,
        projectId
      ]
    );
    emit({ type: "orchestrator-run-updated", runId, reason: "status_updated" });
    appendTimelineEvent({
      runId,
      eventType: "run_status_changed",
      reason: "status_updated",
      detail: {
        from: normalizeRunStatus(existing.status),
        to: status,
        schedulerState: patch.scheduler_state ?? existing.scheduler_state
      }
    });
  };

  const runCanStartAttempts = (status: OrchestratorRunStatus): boolean =>
    status === "queued" || status === "bootstrapping" || status === "active";

  const hasOpenBlockingInterventionForRun = (run: OrchestratorRun): boolean => {
    const missionRow = db.get<{ status: string | null }>(
      "select status from missions where id = ? and project_id = ? limit 1",
      [run.missionId, projectId],
    );
    const missionStatus = String(missionRow?.status ?? "").trim();
    const openInterventions = db.all<{ metadata_json: string | null }>(
      `
        select metadata_json
        from mission_interventions
        where project_id = ?
          and mission_id = ?
          and status = 'open'
      `,
      [projectId, run.missionId],
    );
    const hasRelevantOpenIntervention = openInterventions.some((row) => {
      const metadata = parseJsonRecord(row.metadata_json);
      const interventionRunId = typeof metadata?.runId === "string" ? metadata.runId.trim() : "";
      return interventionRunId.length === 0 || interventionRunId === run.id;
    });
    return missionStatus === "intervention_required" || hasRelevantOpenIntervention;
  };

  const expireClaims = () => {
    const now = nowIso();
    const expiring = db.all<ClaimRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          owner_id,
          scope_kind,
          scope_value,
          state,
          acquired_at,
          heartbeat_at,
          expires_at,
          released_at,
          policy_json,
          metadata_json
        from orchestrator_claims
        where project_id = ?
          and state = 'active'
          and expires_at <= ?
      `,
      [projectId, now]
    );
    db.run(
      `
        update orchestrator_claims
        set state = 'expired',
            released_at = ?
        where project_id = ?
          and state = 'active'
          and expires_at <= ?
      `,
      [now, projectId, now]
    );
    for (const row of expiring) {
      appendTimelineEvent({
        runId: row.run_id,
        stepId: row.step_id,
        attemptId: row.attempt_id,
        claimId: row.id,
        eventType: "claim_expired",
        reason: "lease_expired",
        detail: {
          ownerId: row.owner_id,
          scopeKind: row.scope_kind,
          scopeValue: row.scope_value,
          expiresAt: row.expires_at
        }
      });
      emit({ type: "orchestrator-claim-updated", runId: row.run_id, claimId: row.id, reason: "expired" });
    }
  };

  const acquireClaim = (args: {
    runId: string;
    stepId: string | null;
    attemptId: string | null;
    ownerId: string;
    scopeKind: OrchestratorClaimScope;
    scopeValue: string;
    ttlMs: number;
    policy: Record<string, unknown>;
  }): OrchestratorClaim | null => {
    expireClaims();
    const normalizedScopeValue = normalizeClaimScopeValue({
      scopeKind: args.scopeKind,
      scopeValue: args.scopeValue
    });
    if (!normalizedScopeValue) return null;
    const conflict = findActiveClaimConflict({
      scopeKind: args.scopeKind,
      scopeValue: normalizedScopeValue,
      ignoreAttemptId: args.attemptId
    });
    if (conflict) return null;
    const id = randomUUID();
    const acquiredAt = nowIso();
    const expiresAt = new Date(Date.now() + Math.max(1_000, Math.floor(args.ttlMs))).toISOString();
    try {
      db.run(
        `
          insert into orchestrator_claims(
            id,
            project_id,
            run_id,
            step_id,
            attempt_id,
            owner_id,
            scope_kind,
            scope_value,
            state,
            acquired_at,
            heartbeat_at,
            expires_at,
            released_at,
            policy_json,
            metadata_json
          ) values (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, null, ?, ?)
        `,
        [
          id,
          projectId,
          args.runId,
          args.stepId,
            args.attemptId,
            args.ownerId,
            args.scopeKind,
            normalizedScopeValue,
            acquiredAt,
            acquiredAt,
            expiresAt,
          JSON.stringify(args.policy),
          JSON.stringify({})
        ]
      );
      const row = db.get<ClaimRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_id,
            owner_id,
            scope_kind,
            scope_value,
            state,
            acquired_at,
            heartbeat_at,
            expires_at,
            released_at,
            policy_json,
            metadata_json
          from orchestrator_claims
          where id = ?
            and project_id = ?
          limit 1
        `,
        [id, projectId]
      );
      if (!row) return null;
      const claim = toClaim(row);
      emit({ type: "orchestrator-claim-updated", runId: args.runId, claimId: claim.id, reason: "acquired" });
      appendTimelineEvent({
        runId: args.runId,
        stepId: args.stepId,
        attemptId: args.attemptId,
        claimId: claim.id,
        eventType: "claim_acquired",
        reason: "claim_acquired",
        detail: {
          ownerId: claim.ownerId,
          scopeKind: claim.scopeKind,
          scopeValue: claim.scopeValue,
          expiresAt: claim.expiresAt
        }
      });

      // Task-scope claims: mark the step as claimed by updating its metadata
      if (args.scopeKind === "task" && args.stepId) {
        const stepRow = getStepRow(args.stepId);
        if (stepRow) {
          const stepMeta = parseJsonRecord(stepRow.metadata_json) ?? {};
          const updatedMeta = {
            ...stepMeta,
            claimedBy: args.ownerId,
            claimedAt: acquiredAt,
            taskClaimId: claim.id
          };
          db.run(
            `
              update orchestrator_steps
              set metadata_json = ?,
                  updated_at = ?
              where id = ?
                and run_id = ?
                and project_id = ?
            `,
            [JSON.stringify(updatedMeta), acquiredAt, args.stepId, args.runId, projectId]
          );
          emit({ type: "orchestrator-step-updated", runId: args.runId, stepId: args.stepId, reason: "task_claimed" });
        }
      }

      return claim;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("constraint")) return null;
      throw error;
    }
  };

  const releaseClaimsForAttempt = (args: {
    attemptId: string;
    state?: Exclude<OrchestratorClaimState, "active">;
  }): number => {
    const nextState = args.state ?? "released";
    const releasedAt = nowIso();
    const releasable = db.all<ClaimRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          owner_id,
          scope_kind,
          scope_value,
          state,
          acquired_at,
          heartbeat_at,
          expires_at,
          released_at,
          policy_json,
          metadata_json
        from orchestrator_claims
        where project_id = ?
          and attempt_id = ?
          and state = 'active'
      `,
      [projectId, args.attemptId]
    );
    db.run(
      `
        update orchestrator_claims
        set state = ?,
            released_at = ?
        where project_id = ?
          and attempt_id = ?
          and state = 'active'
      `,
      [nextState, releasedAt, projectId, args.attemptId]
    );
    const countRow = db.get<{ count: number }>(
      `
        select count(*) as count
        from orchestrator_claims
        where project_id = ?
          and attempt_id = ?
          and state = ?
      `,
      [projectId, args.attemptId, nextState]
    );
    const count = Number(countRow?.count ?? 0);
    if (count > 0) {
      emit({ type: "orchestrator-claim-updated", attemptId: args.attemptId, reason: "released" });
      for (const claim of releasable) {
        appendTimelineEvent({
          runId: claim.run_id,
          stepId: claim.step_id,
          attemptId: claim.attempt_id,
          claimId: claim.id,
          eventType: nextState === "expired" ? "claim_expired" : "claim_released",
          reason: nextState === "expired" ? "released_as_expired" : "released",
          detail: {
            ownerId: claim.owner_id,
            scopeKind: claim.scope_kind,
            scopeValue: claim.scope_value,
            releasedAt,
            state: nextState
          }
        });
      }
    }
    return count;
  };

  const normalizeClaimScopeValue = (args: {
    scopeKind: OrchestratorClaimScope;
    scopeValue: string;
  }): string | null => {
    const raw = String(args.scopeValue ?? "").trim();
    if (!raw.length) return null;
    // Task claims use step ID as scope value — pass through directly
    if (args.scopeKind === "task") return raw;
    if (args.scopeKind !== "file") return raw;
    return normalizeFileClaimScopeValue(projectRoot, raw);
  };

  const findActiveClaimConflict = (args: {
    scopeKind: OrchestratorClaimScope;
    scopeValue: string;
    ignoreAttemptId?: string | null;
  }): { conflict: ClaimRow; reason: string } | null => {
    const ignoreAttemptId = String(args.ignoreAttemptId ?? "").trim();
    if (args.scopeKind === "file") {
      const activeFileClaims = db.all<ClaimRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_id,
            owner_id,
            scope_kind,
            scope_value,
            state,
            acquired_at,
            heartbeat_at,
            expires_at,
            released_at,
            policy_json,
            metadata_json
          from orchestrator_claims
          where project_id = ?
            and state = 'active'
            and scope_kind = 'file'
        `,
        [projectId]
      );
      for (const claim of activeFileClaims) {
        if (ignoreAttemptId.length > 0 && claim.attempt_id === ignoreAttemptId) continue;
        if (!doFileClaimsOverlap(args.scopeValue, claim.scope_value)) continue;
        return {
          conflict: claim,
          reason: `overlapping_file_scope:${args.scopeValue}<->${claim.scope_value}`
        };
      }
      return null;
    }

    const row = db.get<ClaimRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          owner_id,
          scope_kind,
          scope_value,
          state,
          acquired_at,
          heartbeat_at,
          expires_at,
          released_at,
          policy_json,
          metadata_json
        from orchestrator_claims
        where project_id = ?
          and state = 'active'
          and scope_kind = ?
          and scope_value = ?
          ${ignoreAttemptId.length > 0 ? "and coalesce(attempt_id, '') != ?" : ""}
        limit 1
      `,
      ignoreAttemptId.length > 0
        ? [projectId, args.scopeKind, args.scopeValue, ignoreAttemptId]
        : [projectId, args.scopeKind, args.scopeValue]
    );
    if (!row) return null;
    return {
      conflict: row,
      reason: "exact_scope_collision"
    };
  };

  const collectTouchedRepoPaths = async (args: {
    laneId?: string | null;
    result?: Partial<OrchestratorAttemptResultEnvelope> | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<{ touchedPaths: string[]; rawPaths: string[] }> => {
    const rawPaths: string[] = [];
    const touched = new Set<string>();
    const pushPath = (value: unknown) => {
      if (typeof value !== "string") return;
      const raw = value.trim();
      if (!raw.length) return;
      rawPaths.push(raw);
      const normalized = normalizeRepoRelativePath(projectRoot, raw);
      if (!normalized) return;
      touched.add(normalized);
    };
    const parsePathArray = (value: unknown) => {
      if (!Array.isArray(value)) return;
      for (const entry of value) {
        if (typeof entry === "string") {
          const renameSplit = entry.split(/\s*->\s*/);
          if (renameSplit.length === 2) {
            pushPath(renameSplit[0]);
            pushPath(renameSplit[1]);
          } else {
            pushPath(entry);
          }
          continue;
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        pushPath(record.path);
        pushPath(record.file);
        pushPath(record.from);
        pushPath(record.to);
        pushPath(record.oldPath);
        pushPath(record.newPath);
      }
    };

    const outputs =
      args.result?.outputs && typeof args.result.outputs === "object" && !Array.isArray(args.result.outputs)
        ? (args.result.outputs as Record<string, unknown>)
        : {};
    parsePathArray(outputs.modifiedFiles ?? outputs.modified_files ?? outputs.filesModified ?? outputs.files_modified);
    parsePathArray(outputs.changedFiles ?? outputs.changed_files);
    parsePathArray(outputs.renamedFiles ?? outputs.renamed_files);
    parsePathArray(args.metadata?.changedFiles ?? args.metadata?.changed_files);
    parsePathArray(args.metadata?.modifiedFiles ?? args.metadata?.modified_files);
    parsePathArray(args.metadata?.renamedFiles ?? args.metadata?.renamed_files);

    const laneId = typeof args.laneId === "string" ? args.laneId.trim() : "";
    if (laneId.length > 0) {
      const laneRow = db.get<{ worktree_path: string | null }>(
        `
          select worktree_path
          from lanes
          where id = ?
            and project_id = ?
          limit 1
        `,
        [laneId, projectId]
      );
      const laneRoot = typeof laneRow?.worktree_path === "string" && laneRow.worktree_path.trim().length
        ? laneRow.worktree_path.trim()
        : projectRoot;
      try {
        const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: laneRoot,
          timeoutMs: 15_000,
        });
        if (status.exitCode === 0 && status.stdout.trim().length > 0) {
          const normalizePorcelainPath = (value: string): string => {
            const trimmed = value.trim();
            if (!trimmed.startsWith("\"") || !trimmed.endsWith("\"")) return trimmed;
            return trimmed
              .slice(1, -1)
              .replace(/\\\"/g, "\"")
              .replace(/\\\\/g, "\\");
          };
          for (const line of status.stdout.split(/\r?\n/)) {
            if (line.length < 4) continue;
            const payload = line.slice(3).trim();
            if (!payload.length) continue;
            if (payload.includes(" -> ")) {
              const [left, right] = payload.split(/\s+->\s+/, 2);
              for (const entry of [left, right]) {
                if (!entry) continue;
                const normalizedToken = normalizePorcelainPath(entry);
                rawPaths.push(normalizedToken);
                const normalizedPath = normalizeRepoRelativePath(projectRoot, normalizedToken);
                if (normalizedPath) touched.add(normalizedPath);
              }
              continue;
            }
            const normalizedToken = normalizePorcelainPath(payload);
            rawPaths.push(normalizedToken);
            const normalizedPath = normalizeRepoRelativePath(projectRoot, normalizedToken);
            if (normalizedPath) touched.add(normalizedPath);
          }
        }
      } catch {
        // Best-effort only; runtime metadata remains the primary source.
      }
    }
    return {
      touchedPaths: [...touched].sort((a, b) => a.localeCompare(b)),
      rawPaths
    };
  };

  const evaluateFileReservationViolations = async (args: {
    step: OrchestratorStep;
    result?: Partial<OrchestratorAttemptResultEnvelope> | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<{
    normalizedScopes: string[];
    touchedPaths: string[];
    violations: string[];
    rawPaths: string[];
  }> => {
    const stepPolicy = resolveStepPolicy(args.step);
    const fileScopes = (stepPolicy.claimScopes ?? [])
      .filter((scope) => scope.scopeKind === "file")
      .map((scope) => normalizeClaimScopeValue({ scopeKind: "file", scopeValue: scope.scopeValue }))
      .filter((scope): scope is string => Boolean(scope));
    if (!fileScopes.length) {
      return {
        normalizedScopes: [],
        touchedPaths: [],
        violations: [],
        rawPaths: []
      };
    }
    const touched = await collectTouchedRepoPaths({
      laneId: args.step.laneId,
      result: args.result,
      metadata: args.metadata
    });
    const violations = touched.touchedPaths.filter((repoPath) => {
      for (const scope of fileScopes) {
        if (doesFileClaimMatchPath(scope, repoPath)) return false;
      }
      return true;
    });
    return {
      normalizedScopes: fileScopes,
      touchedPaths: touched.touchedPaths,
      violations,
      rawPaths: touched.rawPaths
    };
  };

  const isPermanentlyBlockedStep = (step: OrchestratorStep): boolean => {
    if (step.status !== "blocked") return false;
    if (step.metadata?.blockedSticky === true) return true;
    return step.metadata?.blockedErrorClass === "policy";
  };

  const isTerminalForDependencyGate = (step: OrchestratorStep | null): boolean => {
    if (!step) return false;
    if (TERMINAL_STEP_STATUSES.has(step.status)) return true;
    return isPermanentlyBlockedStep(step);
  };

  const evaluateDependencyGate = (step: OrchestratorStep, stepsById: Map<string, OrchestratorStep>) => {
    if (!step.dependencyStepIds.length) {
      return { satisfied: true, permanentlyBlocked: false };
    }
    // Advisory dependencies are non-blocking — step proceeds immediately but
    // may receive handoff context from upstream steps when they complete.
    if (step.joinPolicy === "advisory") {
      return { satisfied: true, permanentlyBlocked: false };
    }
    const depSteps = step.dependencyStepIds.map((id) => stepsById.get(id) ?? null);
    const depStatuses = depSteps.map((dep) => dep?.status ?? "pending");
    const successCount = depStatuses.filter((status) => status === "succeeded" || status === "skipped" || status === "superseded").length;
    const allTerminal = depSteps.every((dep) => isTerminalForDependencyGate(dep));
    if (step.joinPolicy === "any_success") {
      if (successCount >= 1) return { satisfied: true, permanentlyBlocked: false };
      return { satisfied: false, permanentlyBlocked: allTerminal };
    }
    if (step.joinPolicy === "quorum") {
      const required = step.quorumCount && step.quorumCount > 0 ? step.quorumCount : Math.max(1, Math.ceil(depStatuses.length / 2));
      if (successCount >= required) return { satisfied: true, permanentlyBlocked: false };
      return { satisfied: false, permanentlyBlocked: allTerminal };
    }
    // all_success
    const allSucceeded = depStatuses.every((status) => status === "succeeded" || status === "skipped" || status === "superseded");
    if (allSucceeded) return { satisfied: true, permanentlyBlocked: false };
    return { satisfied: false, permanentlyBlocked: allTerminal };
  };

  const evaluateConfiguredPhaseGate = (args: {
    step: OrchestratorStep;
    phaseCards: PhaseCard[] | null;
    currentPhase: PhaseCard | null;
  }): {
    satisfied: boolean;
    reason: "no_configured_phases" | "step_unphased" | "phase_runtime_missing" | "inactive_phase" | null;
  } => {
    if (!Array.isArray(args.phaseCards) || args.phaseCards.length === 0) {
      return { satisfied: true, reason: "no_configured_phases" };
    }
    const stepPhase = resolvePhaseCardForStep(args.step, args.phaseCards);
    if (!stepPhase) {
      return { satisfied: true, reason: "step_unphased" };
    }
    if (!args.currentPhase) {
      return { satisfied: false, reason: "phase_runtime_missing" };
    }
    return {
      satisfied: stepPhase.phaseKey === args.currentPhase.phaseKey,
      reason: stepPhase.phaseKey === args.currentPhase.phaseKey ? null : "inactive_phase"
    };
  };

  const evaluateValidationDependencyGate = (args: {
    step: OrchestratorStep;
    stepsById: Map<string, OrchestratorStep>;
    phaseCards: PhaseCard[] | null;
  }): {
    satisfied: boolean;
    blockingDependencyIds: string[];
  } => {
    if (!args.step.dependencyStepIds.length || args.step.joinPolicy === "advisory") {
      return { satisfied: true, blockingDependencyIds: [] };
    }
    const depSteps = args.step.dependencyStepIds
      .map((id) => args.stepsById.get(id) ?? null)
      .filter((dep): dep is OrchestratorStep => Boolean(dep));
    const validatedSuccessCount = depSteps.filter((dep) => {
      if (dep.status !== "succeeded" && dep.status !== "skipped" && dep.status !== "superseded") return false;
      if (!stepRequiresValidation(dep, args.phaseCards)) return true;
      return hasPassingValidation(asRecord(dep.metadata));
    }).length;
    if (args.step.joinPolicy === "any_success") {
      return { satisfied: validatedSuccessCount >= 1, blockingDependencyIds: [] };
    }
    if (args.step.joinPolicy === "quorum") {
      const required = args.step.quorumCount && args.step.quorumCount > 0
        ? args.step.quorumCount
        : Math.max(1, Math.ceil(depSteps.length / 2));
      return { satisfied: validatedSuccessCount >= required, blockingDependencyIds: [] };
    }
    const blockingDependencyIds = depSteps
      .filter((dep) => dep.status === "succeeded" && stepRequiresValidation(dep, args.phaseCards))
      .filter((dep) => !hasPassingValidation(asRecord(dep.metadata)))
      .map((dep) => dep.id);
    return {
      satisfied: blockingDependencyIds.length === 0,
      blockingDependencyIds
    };
  };

  const applyRunPhaseTransition = (args: {
    runId: string;
    targetPhase: PhaseCard;
    reason: string;
    source: "kernel_auto_phase_sync" | "kernel_phase_runtime_init";
  }): {
    changed: boolean;
    currentPhase: PhaseCard;
    metadata: Record<string, unknown>;
  } | null => {
    const runRow = getRunRow(args.runId);
    if (!runRow) return null;
    const metadata = parseJsonRecord(runRow.metadata_json) ?? {};
    const phaseRuntimeSource = asRecord(metadata.phaseRuntime);
    const phaseRuntime: Record<string, unknown> = phaseRuntimeSource ? { ...phaseRuntimeSource } : {};
    const previousPhaseKey = typeof phaseRuntime.currentPhaseKey === "string" ? phaseRuntime.currentPhaseKey.trim() : "";
    const previousPhaseName = typeof phaseRuntime.currentPhaseName === "string" ? phaseRuntime.currentPhaseName.trim() : "";
    if (previousPhaseKey === args.targetPhase.phaseKey && previousPhaseName === args.targetPhase.name) {
      return {
        changed: false,
        currentPhase: args.targetPhase,
        metadata,
      };
    }
    const now = nowIso();
    const transitions = Array.isArray(phaseRuntime.transitions) ? [...phaseRuntime.transitions] : [];
    transitions.unshift({
      fromPhaseKey: previousPhaseKey || null,
      fromPhaseName: previousPhaseName || null,
      toPhaseKey: args.targetPhase.phaseKey,
      toPhaseName: args.targetPhase.name,
      at: now,
      reason: args.reason
    });
    const existingPhaseBudgets = asRecord(phaseRuntime.phaseBudgets) ?? {};
    const targetPhaseBudget = asRecord(existingPhaseBudgets[args.targetPhase.phaseKey]);
    phaseRuntime.transitions = transitions.slice(0, 64);
    phaseRuntime.currentPhaseKey = args.targetPhase.phaseKey;
    phaseRuntime.currentPhaseName = args.targetPhase.name;
    phaseRuntime.currentPhaseModel = args.targetPhase.model;
    phaseRuntime.currentPhaseInstructions = args.targetPhase.instructions;
    phaseRuntime.currentPhaseValidation = args.targetPhase.validationGate;
    phaseRuntime.currentPhaseBudget = args.targetPhase.budget ?? {};
    phaseRuntime.transitionedAt = now;
    phaseRuntime.phaseBudgets = {
      ...existingPhaseBudgets,
      [args.targetPhase.phaseKey]: {
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
    const updatedMetadata = {
      ...metadata,
      phaseRuntime
    };
    db.run(
      `update orchestrator_runs set metadata_json = ?, updated_at = ? where id = ? and project_id = ?`,
      [JSON.stringify(updatedMetadata), now, args.runId, projectId]
    );
    appendTimelineEvent({
      runId: args.runId,
      eventType: "phase_transition",
      reason: args.reason,
      detail: {
        fromPhaseKey: previousPhaseKey || null,
        fromPhaseName: previousPhaseName || null,
        toPhaseKey: args.targetPhase.phaseKey,
        toPhaseName: args.targetPhase.name,
        phaseModel: args.targetPhase.model,
        phaseValidation: args.targetPhase.validationGate,
        phaseBudget: args.targetPhase.budget ?? {},
        transitionedAt: now,
        source: args.source
      }
    });
    emit({ type: "orchestrator-run-updated", runId: args.runId, reason: "phase_transition" });
    emit({
      type: "orchestrator-step-updated",
      runId: args.runId,
      reason: "phase_transition"
    });
    return {
      changed: true,
      currentPhase: args.targetPhase,
      metadata: updatedMetadata,
    };
  };

  const syncConfiguredPhaseRuntime = (runId: string, steps: OrchestratorStep[]): {
    phaseCards: PhaseCard[] | null;
    currentPhase: PhaseCard | null;
  } => {
    const runRow = getRunRow(runId);
    const runMetadata = runRow ? parseJsonRecord(runRow.metadata_json) : null;
    const phaseCards = resolveRunPhaseCardsFromMetadata(runMetadata);
    if (!phaseCards || phaseCards.length === 0) {
      return {
        phaseCards: null,
        currentPhase: null
      };
    }
    const sortedPhases = [...phaseCards].sort((left, right) => left.position - right.position);
    const currentPhase = resolveCurrentRunPhaseCard(runMetadata, sortedPhases);
    const resolveAutoAdvanceTarget = (): PhaseCard | null => {
      if (!currentPhase) {
        return (
          sortedPhases.find((phase) =>
            phaseHasAssignedExecutionWork(phase, steps) && canEnterConfiguredPhase(phase, sortedPhases, steps)
          )
          ?? sortedPhases[0]
          ?? null
        );
      }
      if (phaseHasNonTerminalExecutionWork(currentPhase, steps)) {
        return null;
      }
      const currentIndex = sortedPhases.findIndex((phase) => phase.phaseKey === currentPhase.phaseKey);
      if (currentIndex < 0) return null;
      for (let index = currentIndex + 1; index < sortedPhases.length; index += 1) {
        const candidate = sortedPhases[index]!;
        if (!phaseHasAssignedExecutionWork(candidate, steps)) continue;
        if (canEnterConfiguredPhase(candidate, sortedPhases, steps)) {
          return candidate;
        }
      }
      return null;
    };
    const targetPhase = resolveAutoAdvanceTarget();
    if (!targetPhase) {
      return {
        phaseCards: sortedPhases,
        currentPhase
      };
    }
    if (currentPhase?.phaseKey === targetPhase.phaseKey) {
      return {
        phaseCards: sortedPhases,
        currentPhase
      };
    }
    const applied = applyRunPhaseTransition({
      runId,
      targetPhase,
      reason: currentPhase ? "kernel_auto_advance" : "kernel_initialize_phase_runtime",
      source: currentPhase ? "kernel_auto_phase_sync" : "kernel_phase_runtime_init"
    });
    return {
      phaseCards: sortedPhases,
      currentPhase: applied?.currentPhase ?? targetPhase
    };
  };

  const refreshStepReadiness = (runId: string) => {
    const rows = listStepRows(runId);
    if (!rows.length) return;
    const steps = rows.map(toStep);
    const { phaseCards, currentPhase } = syncConfiguredPhaseRuntime(runId, steps);
    const stepsById = new Map<string, OrchestratorStep>(steps.map((step) => [step.id, step] as const));
    const statusesById = new Map<string, OrchestratorStepStatus>(steps.map((step) => [step.id, step.status] as const));
    const now = nowIso();

    for (const step of steps) {
      const stepMeta = asRecord(step.metadata);
      const isDisplayOnlyStep = stepMeta?.displayOnlyTask === true || stepMeta?.plannerLaunchTracker === true;
      if (isDisplayOnlyStep) {
        statusesById.set(step.id, "pending");
        if (step.status !== "pending") {
          db.run(
            `update orchestrator_steps set status = ?, updated_at = ? where id = ? and run_id = ? and project_id = ?`,
            ["pending", now, step.id, runId, projectId],
          );
        }
        continue;
      }
      if (step.status === "running" || TERMINAL_STEP_STATUSES.has(step.status)) continue;
      const gate = evaluateDependencyGate(step, stepsById);
      const phaseGate = evaluateConfiguredPhaseGate({
        step,
        phaseCards,
        currentPhase
      });
      const validationGate =
        gate.satisfied && phaseGate.satisfied
          ? evaluateValidationDependencyGate({
              step,
              stepsById,
              phaseCards
            })
          : { satisfied: true, blockingDependencyIds: [] };
      const stepPolicy = resolveStepPolicy(step);
      const claimScoped = (stepPolicy.claimScopes ?? []).length > 0;
      const nextRetryAtRaw = typeof step.metadata?.nextRetryAt === "string" ? step.metadata.nextRetryAt : null;
      const nextRetryAtMs = nextRetryAtRaw ? Date.parse(nextRetryAtRaw) : NaN;
      const retryDeferred = Number.isFinite(nextRetryAtMs) && nextRetryAtMs > Date.now();
      const stickyBlocked = step.status === "blocked" && step.metadata?.blockedSticky === true;
      let next: OrchestratorStepStatus = step.status;
      if (gate.satisfied && phaseGate.satisfied && validationGate.satisfied) {
        if (stickyBlocked) {
          next = "blocked";
        } else if (retryDeferred) {
          next = "pending";
        } else if (step.status === "pending" || step.status === "blocked" || step.status === "ready") {
          next = "ready";
        }
      } else if (gate.permanentlyBlocked) {
        next = "blocked";
      } else {
        next = "pending";
      }

      if (next === "ready" && claimScoped && step.status === "blocked") {
        // Claim conflicts can clear when claims expire/release.
        const conflicts = (stepPolicy.claimScopes ?? []).some((scope) => {
          const normalizedScopeValue = normalizeClaimScopeValue({
            scopeKind: scope.scopeKind,
            scopeValue: scope.scopeValue
          });
          if (!normalizedScopeValue) return true;
          return Boolean(
            findActiveClaimConflict({
              scopeKind: scope.scopeKind,
              scopeValue: normalizedScopeValue
            })
          );
        });
        if (conflicts) next = "blocked";
      }

      if (next !== step.status) {
        const nextMetadata = (() => {
          if (!step.metadata || !("nextRetryAt" in step.metadata)) return step.metadata;
          if (next !== "ready") return step.metadata;
          const clone = { ...step.metadata };
          delete clone.nextRetryAt;
          return clone;
        })();
        db.run(
          `
            update orchestrator_steps
            set status = ?,
                metadata_json = ?,
                updated_at = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [next, JSON.stringify(nextMetadata ?? null), now, step.id, runId, projectId]
        );
        stepsById.set(step.id, {
          ...step,
          status: next,
          metadata: nextMetadata ?? null,
          updatedAt: now
        });
        statusesById.set(step.id, next);
        emit({ type: "orchestrator-step-updated", runId, stepId: step.id, reason: "readiness_recomputed" });
        appendTimelineEvent({
          runId,
          stepId: step.id,
          eventType: "step_status_changed",
          reason: "readiness_recomputed",
          detail: {
            from: step.status,
            to: next,
            joinPolicy: step.joinPolicy,
            dependencies: step.dependencyStepIds,
            dependencyGateSatisfied: gate.satisfied,
            phaseGateSatisfied: phaseGate.satisfied,
            phaseGateReason: phaseGate.reason,
            validationGateSatisfied: validationGate.satisfied,
            validationBlockingDependencyIds: validationGate.blockingDependencyIds
          }
        });
      }
    }
  };

  /**
   * Policy-aware run status evaluation.
   * Resolves the execution policy from run metadata and delegates to
   * `evaluateRunCompletion`. This NEVER returns terminal statuses —
   * terminal transitions are exclusively via finalizeRun() or cancelRun().
   * When the evaluation signals completion readiness, the run transitions
   * to "completing" and diagnostics are persisted for downstream consumers.
   */
  const evaluateRunStatusWithPolicy = (runId: string): OrchestratorRunStatus => {
    const steps = listStepRows(runId).map(toStep);
    const runRow = getRunRow(runId);
    const runMetadata = runRow ? parseJsonRecord(runRow.metadata_json) : null;
    const rawPhases = resolveRunPhaseCardsFromMetadata(runMetadata);
    const missionLevelSettings = resolveRunMissionLevelSettingsFromMetadata(runMetadata);

    const executionPolicy = runMetadata && isExecutionPolicyRecord(runMetadata.executionPolicy)
      ? (runMetadata.executionPolicy as MissionExecutionPolicy)
      : DEFAULT_EXECUTION_POLICY;

    const evaluation =
      rawPhases && rawPhases.length > 0 && missionLevelSettings
        ? evaluateRunCompletionFromPhases(steps, rawPhases, missionLevelSettings)
        : evaluateRunCompletion(steps, executionPolicy);

    // When the evaluation signals completion readiness, persist diagnostics
    // into run metadata so they are available via getRunGraph and other consumers.
    if (evaluation.completionReady) {
      const existingMetadata = runMetadata ?? {};
      const updatedMetadata = {
        ...existingMetadata,
        completionDiagnostics: evaluation.diagnostics,
        completionRiskFactors: evaluation.riskFactors
      };
      db.run(
        `
          update orchestrator_runs
          set metadata_json = ?,
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [JSON.stringify(updatedMetadata), nowIso(), runId, projectId]
      );
    }

    // Map evaluation status: NEVER return terminal statuses from this function.
    // Terminal transitions are exclusively via finalizeRun() or cancelRun().
    if (TERMINAL_RUN_STATUSES.has(evaluation.status) || evaluation.completionReady) {
      return "completing";
    }
    return evaluation.status;
  };

  const createContextSnapshotForAttempt = async (args: {
    run: OrchestratorRun;
    step: OrchestratorStep;
    attemptId: string;
    contextProfile: OrchestratorContextPolicyProfile;
  }): Promise<CreateSnapshotResult> => {
    const runtimeConfig = getRuntimeConfig();
    const existingCursor = (() => {
      if (!args.run.metadata) return null;
      const raw = args.run.metadata.runtimeCursor;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      return raw as Record<string, unknown>;
    })();
    const previousPackDeltaSince = typeof existingCursor?.packDeltaSince === "string" ? existingCursor.packDeltaSince : null;
    const stepType = (() => {
      const fromMetadata = typeof args.step.metadata?.stepType === "string" ? args.step.metadata.stepType : null;
      if (fromMetadata && fromMetadata.trim().length) return fromMetadata.trim();
      const missionStepKind = db.get<{ kind: string | null }>(
        `
          select kind
          from mission_steps
          where id = ?
            and mission_id = ?
            and project_id = ?
          limit 1
        `,
        [args.step.missionStepId ?? "", args.run.missionId, projectId]
      );
      return typeof missionStepKind?.kind === "string" && missionStepKind.kind.trim().length ? missionStepKind.kind.trim() : "manual";
    })();
    const laneExportLevel = args.contextProfile.laneExportLevel;
    const projectExportLevel = stepType === "analysis" ? "standard" : args.contextProfile.projectExportLevel;
    const lanePackKey = args.step.laneId ? `lane:${args.step.laneId}` : null;
    const laneExport = args.step.laneId
      ? await packService.getLaneExport({
          laneId: args.step.laneId,
          level: laneExportLevel
        })
      : null;
    const projectExport = await packService.getProjectExport({
      level: projectExportLevel
    });

    const docsPaths = readDocPaths(projectRoot);
    let remainingBytes = args.contextProfile.maxDocBytes;
    let docsConsumedBytes = 0;
    let docsTruncatedCount = 0;
    const docsRefs: OrchestratorDocsRef[] = [];
    const fullDocs: Array<{ path: string; content: string; truncated: boolean }> = [];

    const docReadResults = await Promise.all(
      docsPaths.map(async (abs) => {
        try {
          return { abs, buf: await fs.promises.readFile(abs) };
        } catch {
          return null;
        }
      })
    );

    for (const result of docReadResults) {
      if (!result) continue;
      const { abs, buf } = result;
      const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
      const digest = sha256(buf);
      const bytes = buf.length;
      if (args.contextProfile.docsMode === "full_docs") {
        const used = Math.min(Math.max(0, remainingBytes), bytes);
        const chunk = buf.subarray(0, used).toString("utf8");
        const truncated = used < bytes;
        docsConsumedBytes += used;
        if (truncated) docsTruncatedCount += 1;
        docsRefs.push({
          path: rel,
          sha256: digest,
          bytes,
          truncated,
          mode: "full_body"
        });
        fullDocs.push({
          path: rel,
          content: chunk,
          truncated
        });
        remainingBytes = Math.max(0, remainingBytes - used);
      } else {
        docsConsumedBytes += Math.min(64, bytes); // digest refs use only metadata bytes in prompt budget.
        docsRefs.push({
          path: rel,
          sha256: digest,
          bytes,
          truncated: false,
          mode: "digest_ref"
        });
      }
      if (remainingBytes <= 0 && args.contextProfile.docsMode === "full_docs") break;
    }

    const packDeltaDigest = null;

    const missionStepIds = new Set<string>();
    if (args.step.missionStepId) missionStepIds.add(args.step.missionStepId);
    if (args.step.dependencyStepIds.length) {
      const placeholders = args.step.dependencyStepIds.map(() => "?").join(", ");
      const rows = db.all<{ mission_step_id: string | null }>(
        `
          select mission_step_id
          from orchestrator_steps
          where project_id = ?
            and run_id = ?
            and id in (${placeholders})
        `,
        [projectId, args.run.id, ...args.step.dependencyStepIds]
      );
      for (const row of rows) {
        if (row.mission_step_id) missionStepIds.add(row.mission_step_id);
      }
    }
    const missionHandoffLimit = runtimeConfig.progressiveLoading ? 12 : 30;
    const missionHandoffs = (() => {
      const ids = [...missionStepIds];
      if (!ids.length) return [] as Array<{ id: string; handoff_type: string; created_at: string }>;
      const placeholders = ids.map(() => "?").join(", ");
      return db.all<{ id: string; handoff_type: string; created_at: string }>(
        `
          select id, handoff_type, created_at
          from mission_step_handoffs
          where project_id = ?
            and mission_id = ?
            and mission_step_id in (${placeholders})
          order by created_at desc
          limit 60
        `,
        [projectId, args.run.missionId, ...ids]
      );
    })();
    const missionHandoffIds = missionHandoffs.slice(0, missionHandoffLimit).map((row) => row.id);
    const missionHandoffDigest = (() => {
      if (missionHandoffs.length <= missionHandoffLimit) return null;
      const summarized = missionHandoffs.slice(missionHandoffLimit);
      const byType = summarized.reduce<Record<string, number>>((acc, row) => {
        const key = String(row.handoff_type ?? "unknown").trim() || "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      return {
        summarizedCount: summarized.length,
        byType,
        oldestCreatedAt: summarized[summarized.length - 1]?.created_at ?? null,
        newestCreatedAt: summarized[0]?.created_at ?? null
      };
    })();

    const measureBytes = (value: unknown): number => {
      try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
      } catch {
        return 0;
      }
    };

    const runSteps = listStepRows(args.run.id).map(toStep);
    const frontier = {
      pending: runSteps.filter((step) => step.status === "pending").length,
      ready: runSteps.filter((step) => step.status === "ready").length,
      running: runSteps.filter((step) => step.status === "running").length,
      blocked: runSteps.filter((step) => step.status === "blocked").length,
      terminal: runSteps.filter((step) => TERMINAL_STEP_STATUSES.has(step.status)).length
    };
    const openQuestions = Number(
      db.get<{ count: number }>(
        `
          select count(*) as count
          from mission_interventions
          where project_id = ?
            and mission_id = ?
            and status = 'open'
            and intervention_type = 'manual_input'
        `,
        [projectId, args.run.missionId]
      )?.count ?? 0
    );
    const activeClaimsForRun = db.all<ClaimRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          owner_id,
          scope_kind,
          scope_value,
          state,
          acquired_at,
          heartbeat_at,
          expires_at,
          released_at,
          policy_json,
          metadata_json
        from orchestrator_claims
        where project_id = ?
          and run_id = ?
          and state = 'active'
      `,
      [projectId, args.run.id]
    );
    const activeFileClaims = activeClaimsForRun.filter((claim) => claim.scope_kind === "file");
    let activeClaimConflicts = 0;
    for (let i = 0; i < activeFileClaims.length; i += 1) {
      for (let j = i + 1; j < activeFileClaims.length; j += 1) {
        if (doFileClaimsOverlap(activeFileClaims[i]!.scope_value, activeFileClaims[j]!.scope_value)) {
          activeClaimConflicts += 1;
        }
      }
    }
    const gateState = (() => {
      const latest = db.get<{ report_json: string | null }>(
        `
          select report_json
          from orchestrator_gate_reports
          where project_id = ?
          order by generated_at desc
          limit 1
        `,
        [projectId]
      );
      const report = parseJsonRecord(latest?.report_json ?? null);
      const status = typeof report?.overallStatus === "string" ? report.overallStatus : "unknown";
      if (status === "pass" || status === "warn" || status === "fail") return status;
      return "unknown";
    })();
    const recentDecisions = db.all<{ event_type: string; reason: string }>(
      `
        select event_type, reason
        from orchestrator_timeline_events
        where project_id = ?
          and run_id = ?
          and event_type in ('attempt_retry_scheduled', 'attempt_completed', 'attempt_blocked', 'step_status_changed', 'run_status_changed', 'scheduler_tick')
        order by created_at desc
        limit 12
      `,
      [projectId, args.run.id]
    ).map((row) => `${row.event_type}:${row.reason}`);

    const laneStatusMap = runSteps
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .map((step) => ({
        laneId: step.laneId,
        stepKey: step.stepKey,
        status: step.status
      }));

    const CONTROL_PACK_V2_BUDGET_BYTES = 8_192;
    const EXECUTION_PACK_V2_BUDGET_BYTES = 16_384;
    const DEEP_PACK_V2_BUDGET_BYTES = 4_096;

    let controlPackV2: NonNullable<OrchestratorContextSnapshotCursor["controlPackV2"]> = {
      budgetBytes: CONTROL_PACK_V2_BUDGET_BYTES,
      consumedBytes: 0,
      truncated: false,
      frontier,
      openQuestions,
      activeClaims: activeClaimsForRun.length,
      activeClaimConflicts,
      gateState,
      recentDecisions,
      laneStatusMap
    };
    controlPackV2.consumedBytes = measureBytes(controlPackV2);
    if (controlPackV2.consumedBytes > CONTROL_PACK_V2_BUDGET_BYTES) {
      controlPackV2 = {
        ...controlPackV2,
        truncated: true,
        recentDecisions: controlPackV2.recentDecisions.slice(0, 8),
        laneStatusMap: controlPackV2.laneStatusMap.slice(0, 16)
      };
      controlPackV2.consumedBytes = measureBytes(controlPackV2);
    }
    if (controlPackV2.consumedBytes > CONTROL_PACK_V2_BUDGET_BYTES) {
      controlPackV2 = {
        ...controlPackV2,
        recentDecisions: controlPackV2.recentDecisions.slice(0, 4),
        laneStatusMap: controlPackV2.laneStatusMap.slice(0, 8)
      };
      controlPackV2.consumedBytes = measureBytes(controlPackV2);
    }

    const executionDependencies = args.step.dependencyStepIds
      .map((depId) => runSteps.find((step) => step.id === depId))
      .filter((dep): dep is OrchestratorStep => Boolean(dep))
      .map((dep) => ({ stepId: dep.id, status: dep.status }));
    let executionPackV2: NonNullable<OrchestratorContextSnapshotCursor["executionPackV2"]> = {
      budgetBytes: EXECUTION_PACK_V2_BUDGET_BYTES,
      consumedBytes: 0,
      truncated: false,
      stepKey: args.step.stepKey,
      stepTitle: args.step.title,
      dependencies: executionDependencies,
      handoffIds: missionHandoffIds,
      handoffDigest: missionHandoffDigest
    };
    executionPackV2.consumedBytes = measureBytes(executionPackV2);
    if (executionPackV2.consumedBytes > EXECUTION_PACK_V2_BUDGET_BYTES) {
      executionPackV2 = {
        ...executionPackV2,
        truncated: true,
        dependencies: executionPackV2.dependencies.slice(0, 12),
        handoffIds: executionPackV2.handoffIds.slice(0, 10)
      };
      executionPackV2.consumedBytes = measureBytes(executionPackV2);
    }

    let deepPackV2: NonNullable<OrchestratorContextSnapshotCursor["deepPackV2"]> = {
      budgetBytes: DEEP_PACK_V2_BUDGET_BYTES,
      consumedBytes: 0,
      truncated: false,
      docsMode: args.contextProfile.docsMode === "full_docs" ? "full_body" : "digest_ref",
      docsCount: docsRefs.length,
      fullDocsIncluded: fullDocs.length,
      docsRefsOnly: Math.max(0, docsRefs.length - fullDocs.length)
    };
    deepPackV2.consumedBytes = measureBytes(deepPackV2);
    if (deepPackV2.consumedBytes > DEEP_PACK_V2_BUDGET_BYTES) {
      deepPackV2 = {
        ...deepPackV2,
        truncated: true
      };
      deepPackV2.consumedBytes = measureBytes(deepPackV2);
    }

    const recentWorkerDigests = db.all<{
      step_key: string | null;
      status: string;
      summary: string;
      created_at: string;
    }>(
      `
        select step_key, status, summary, created_at
        from orchestrator_worker_digests
        where project_id = ?
          and mission_id = ?
          and run_id = ?
        order by created_at desc
        limit 12
      `,
      [projectId, args.run.missionId, args.run.id]
    ).map((row) => ({
      stepKey: row.step_key ?? null,
      status: String(row.status ?? "").trim() || "unknown",
      summary: clipText(String(row.summary ?? ""), 360),
      createdAt: row.created_at
    }));

    const recentCheckpoints = db.all<{
      id: string;
      trigger: string;
      summary: string;
      created_at: string;
    }>(
      `
        select id, trigger, summary, created_at
        from orchestrator_context_checkpoints
        where project_id = ?
          and mission_id = ?
          and (run_id = ? or run_id is null)
        order by created_at desc
        limit 8
      `,
      [projectId, args.run.missionId, args.run.id]
    ).map((row) => ({
      id: row.id,
      trigger: row.trigger,
      summary: clipText(String(row.summary ?? ""), 280),
      createdAt: row.created_at
    }));

    const MEMORY_L1_BUDGET_BYTES = 10_240;
    const MEMORY_L2_BUDGET_BYTES = 6_144;

    let memoryL1: OrchestratorMemoryHierarchy["l1"] = {
      budgetBytes: MEMORY_L1_BUDGET_BYTES,
      consumedBytes: 0,
      truncated: false,
      stepKey: executionPackV2.stepKey,
      stepTitle: executionPackV2.stepTitle,
      dependencies: executionPackV2.dependencies,
      handoffIds: executionPackV2.handoffIds,
      handoffDigest: executionPackV2.handoffDigest ?? null,
      recentWorkerDigests,
      recentCheckpoints
    };
    memoryL1.consumedBytes = measureBytes(memoryL1);
    if (memoryL1.consumedBytes > MEMORY_L1_BUDGET_BYTES) {
      memoryL1 = {
        ...memoryL1,
        truncated: true,
        recentWorkerDigests: memoryL1.recentWorkerDigests.slice(0, 8),
        recentCheckpoints: memoryL1.recentCheckpoints.slice(0, 5),
        handoffIds: memoryL1.handoffIds.slice(0, 10)
      };
      memoryL1.consumedBytes = measureBytes(memoryL1);
    }
    if (memoryL1.consumedBytes > MEMORY_L1_BUDGET_BYTES) {
      memoryL1 = {
        ...memoryL1,
        recentWorkerDigests: memoryL1.recentWorkerDigests.slice(0, 5),
        recentCheckpoints: memoryL1.recentCheckpoints.slice(0, 3),
        dependencies: memoryL1.dependencies.slice(0, 10),
        handoffIds: memoryL1.handoffIds.slice(0, 6)
      };
      memoryL1.consumedBytes = measureBytes(memoryL1);
    }

    let memoryL2: OrchestratorMemoryHierarchy["l2"] = {
      budgetBytes: MEMORY_L2_BUDGET_BYTES,
      consumedBytes: 0,
      truncated: false,
      docsMode: deepPackV2.docsMode,
      docsCount: deepPackV2.docsCount,
      fullDocsIncluded: deepPackV2.fullDocsIncluded,
      docsRefsOnly: deepPackV2.docsRefsOnly,
      packRefs: [
        {
          packKey: projectExport.packKey,
          level: projectExport.level,
          approxTokens: projectExport.approxTokens ?? null
        },
        ...(laneExport
          ? [
              {
                packKey: laneExport.packKey,
                level: laneExport.level,
                approxTokens: laneExport.approxTokens ?? null
              }
            ]
          : [])
      ]
    };
    memoryL2.consumedBytes = measureBytes(memoryL2);
    if (memoryL2.consumedBytes > MEMORY_L2_BUDGET_BYTES) {
      memoryL2 = {
        ...memoryL2,
        truncated: true,
        packRefs: memoryL2.packRefs.slice(0, 1)
      };
      memoryL2.consumedBytes = measureBytes(memoryL2);
    }

    const memoryHierarchy: OrchestratorMemoryHierarchy = {
      schema: "ade.contextMemoryHierarchy.v1",
      l0: {
        budgetBytes: controlPackV2.budgetBytes,
        consumedBytes: controlPackV2.consumedBytes,
        truncated: controlPackV2.truncated,
        frontier: controlPackV2.frontier,
        openQuestions: controlPackV2.openQuestions,
        activeClaims: controlPackV2.activeClaims,
        activeClaimConflicts: controlPackV2.activeClaimConflicts,
        gateState: controlPackV2.gateState,
        recentDecisions: controlPackV2.recentDecisions
      },
      l1: memoryL1,
      l2: memoryL2
    };

    const laneVersionId =
      laneExport?.header.versionId ??
      laneExport?.header.contentHash ??
      (laneExport ? `live:${laneExport.packKey}:${sha256(laneExport.content)}` : null);
    const projectVersionId =
      projectExport.header.versionId ??
      projectExport.header.contentHash ??
      `live:${projectExport.packKey}:${sha256(projectExport.content)}`;
    const cursor: OrchestratorContextSnapshotCursor = {
      lanePackKey,
      lanePackVersionId: laneVersionId,
      lanePackVersionNumber: laneExport?.header.versionNumber ?? null,
      projectPackKey: "project",
      projectPackVersionId: projectVersionId,
      projectPackVersionNumber: projectExport.header.versionNumber ?? null,
      packDeltaSince: previousPackDeltaSince,
	      docs: docsRefs,
	      packDeltaDigest,
	      missionHandoffIds,
	      missionHandoffDigest,
	      controlPackV2,
	      executionPackV2,
	      deepPackV2,
        memoryHierarchy,
	      contextSources: [
	        "control_pack_v2",
	        "execution_pack_v2",
	        "deep_pack_v2",
          "memory_hierarchy_v1",
	        `context_export:project:${projectExport.level}`,
	        ...(lanePackKey ? [`context_export:${lanePackKey}:${laneExport?.level ?? laneExportLevel}`] : []),
        ...(packDeltaDigest ? ["delta_digest"] : []),
        ...(missionHandoffIds.length ? ["mission_handoffs"] : []),
        ...(missionHandoffDigest ? ["mission_handoff_digest"] : []),
        `docs:${args.contextProfile.docsMode}`
      ],
      docsMode: args.contextProfile.docsMode === "full_docs" ? "full_body" : "digest_ref",
      docsBudgetBytes: args.contextProfile.maxDocBytes,
      docsConsumedBytes,
      docsTruncatedCount
    };

    const contextPressure =
      (cursor.docsConsumedBytes ?? 0)
        / Math.max(1, cursor.docsBudgetBytes ?? args.contextProfile.maxDocBytes ?? 120_000);
    if (contextPressure >= runtimeConfig.contextPressureThreshold) {
      appendTimelineEvent({
        runId: args.run.id,
        stepId: args.step.id,
        attemptId: args.attemptId,
        eventType: "context_pressure_warning",
        reason: "context_threshold_reached",
        detail: {
          pressure: contextPressure,
          threshold: runtimeConfig.contextPressureThreshold,
          docsConsumedBytes: cursor.docsConsumedBytes ?? 0,
          docsBudgetBytes: cursor.docsBudgetBytes ?? 0,
          handoffIds: missionHandoffIds.length,
          summarizedHandoffs: missionHandoffDigest?.summarizedCount ?? 0
        }
      });
    }
    appendTimelineEvent({
      runId: args.run.id,
      stepId: args.step.id,
      attemptId: args.attemptId,
      eventType: "context_pack_v2_metrics",
      reason:
        controlPackV2.truncated || executionPackV2.truncated || deepPackV2.truncated
          ? "pack_v2_truncated"
          : "pack_v2_within_budget",
      detail: {
        control: {
          consumedBytes: controlPackV2.consumedBytes,
          budgetBytes: controlPackV2.budgetBytes,
          truncated: controlPackV2.truncated
        },
        execution: {
          consumedBytes: executionPackV2.consumedBytes,
          budgetBytes: executionPackV2.budgetBytes,
          truncated: executionPackV2.truncated
        },
        deep: {
          consumedBytes: deepPackV2.consumedBytes,
          budgetBytes: deepPackV2.budgetBytes,
          truncated: deepPackV2.truncated
        }
      }
    });

    const snapshotId = randomUUID();
    const createdAt = nowIso();
    db.run(
      `
        insert into orchestrator_context_snapshots(
          id,
          project_id,
          run_id,
          step_id,
          attempt_id,
          snapshot_type,
          context_profile,
          cursor_json,
          created_at
        ) values (?, ?, ?, ?, ?, 'attempt', ?, ?, ?)
      `,
      [
        snapshotId,
        projectId,
        args.run.id,
        args.step.id,
        args.attemptId,
        args.contextProfile.id,
        JSON.stringify(cursor),
        createdAt
      ]
    );
    appendTimelineEvent({
      runId: args.run.id,
      stepId: args.step.id,
      attemptId: args.attemptId,
      eventType: "context_snapshot_created",
      reason: "attempt_context_resolved",
      detail: {
        snapshotId,
        docsMode: cursor.docsMode,
        docsCount: docsRefs.length,
        docsTruncatedCount,
        stepType,
        hasDeltaDigest: Boolean(packDeltaDigest),
        handoffCount: missionHandoffIds.length
      }
    });

    const runtimeCursorPayload = {
      runtimeCursor: {
        ...cursor,
        packDeltaSince: createdAt
      }
    };
    const currentMetadata = args.run.metadata ?? {};
    db.run(
      `
        update orchestrator_runs
        set runtime_cursor_json = ?,
            metadata_json = ?,
            updated_at = ?
        where id = ?
          and project_id = ?
      `,
      [
        JSON.stringify(runtimeCursorPayload.runtimeCursor),
        JSON.stringify({
          ...currentMetadata,
          ...runtimeCursorPayload
        }),
        createdAt,
        args.run.id,
        projectId
      ]
    );

    return {
      snapshotId,
      cursor,
      laneExport,
      projectExport,
      docsRefs,
      fullDocs
    };
  };

  const tryRunConflictResolverChain = async (args: {
    run: OrchestratorRun;
    step: OrchestratorStep;
    attempt: OrchestratorAttempt;
  }): Promise<
    | {
        status: "succeeded" | "blocked" | "failed";
        result?: OrchestratorAttemptResultEnvelope;
        errorClass?: OrchestratorErrorClass;
        errorMessage?: string;
        metadata?: Record<string, unknown> | null;
      }
    | null
  > => {
    const metadata = args.step.metadata ?? {};
    const integrationConfig =
      metadata.integration && typeof metadata.integration === "object" && !Array.isArray(metadata.integration)
        ? (metadata.integration as Record<string, unknown>)
        : metadata;
    const isMergeFlowStep =
      integrationConfig.integrationFlow === true
      || integrationConfig.requiresConflictResolver === true
      || integrationConfig.stepType === "merge";
    if (!isMergeFlowStep) return null;

    const targetLaneId =
      typeof integrationConfig.targetLaneId === "string" && integrationConfig.targetLaneId.trim().length
        ? integrationConfig.targetLaneId.trim()
        : "";
    const sourceLaneIds = Array.isArray(integrationConfig.sourceLaneIds)
      ? integrationConfig.sourceLaneIds.map((value) => String(value ?? "").trim()).filter(Boolean)
      : [];
    if (!targetLaneId || sourceLaneIds.length === 0) {
      return {
        status: "blocked",
        errorClass: "policy",
        errorMessage: "Integration step is missing targetLaneId/sourceLaneIds metadata.",
        metadata: {
          integrationConfigInvalid: true
        }
      };
    }
    if (!conflictService) {
      return {
        status: "blocked",
        errorClass: "policy",
        errorMessage: "Conflict service is unavailable for integration step execution."
      };
    }

    const externalProvider: ExternalConflictResolverProvider =
      integrationConfig.externalProvider === "claude" ? "claude" : "codex";
    const scenario: PrepareResolverSessionArgs["scenario"] =
      sourceLaneIds.length > 1
        ? "integration-merge"
        : (integrationConfig.scenario as PrepareResolverSessionArgs["scenario"] | undefined) ?? "single-merge";
    const integrationLaneName =
      typeof integrationConfig.integrationLaneName === "string" ? integrationConfig.integrationLaneName : undefined;
    const allowSubscriptionFallback = integrationConfig.allowSubscriptionFallback === true;

    appendTimelineEvent({
      runId: args.run.id,
      stepId: args.step.id,
      attemptId: args.attempt.id,
      eventType: "integration_chain_started",
      reason: "external_cli_first",
      detail: {
        targetLaneId,
        sourceLaneIds,
        externalProvider,
        scenario,
        allowSubscriptionFallback
      }
    });

    const prepared = await conflictService.prepareResolverSession({
      provider: externalProvider,
      targetLaneId,
      sourceLaneIds,
      integrationLaneName,
      scenario
    });
    appendTimelineEvent({
      runId: args.run.id,
      stepId: args.step.id,
      attemptId: args.attempt.id,
      eventType: "integration_chain_stage",
      reason: "external_cli_prepare_completed",
      detail: {
        status: prepared.status,
        runId: prepared.runId,
        integrationLaneId: prepared.integrationLaneId,
        contextGaps: prepared.contextGaps
      }
    });

    if (prepared.status === "ready") {
      return {
        status: "blocked",
        errorClass: "policy",
        errorMessage: "External resolver session prepared. Operator action required to run CLI resolver.",
        result: normalizeEnvelope({
          success: false,
          summary: "External CLI resolver is prepared and awaiting operator execution.",
          outputs: {
            resolverRunId: prepared.runId,
            promptFilePath: prepared.promptFilePath,
            cwdWorktreePath: prepared.cwdWorktreePath,
            cwdLaneId: prepared.cwdLaneId,
            integrationLaneId: prepared.integrationLaneId
          },
          warnings: prepared.warnings,
          trackedSession: true
        }),
        metadata: {
          integrationStage: "external_cli_ready",
          externalProvider,
          resolverRunId: prepared.runId
        }
      };
    }

    if (allowSubscriptionFallback && sourceLaneIds.length === 1) {
      try {
        const preview: ConflictProposalPreview = await conflictService.prepareProposal({
          laneId: sourceLaneIds[0]!,
          peerLaneId: targetLaneId
        });
        const proposal: ConflictProposal = await conflictService.requestProposal({
          laneId: sourceLaneIds[0]!,
          peerLaneId: targetLaneId,
          contextDigest: preview.contextDigest
        });
        appendTimelineEvent({
          runId: args.run.id,
          stepId: args.step.id,
          attemptId: args.attempt.id,
          eventType: "integration_chain_stage",
          reason: "subscription_fallback_completed",
          detail: {
            proposalId: proposal.id,
            source: proposal.source
          }
        });
        return {
          status: "succeeded",
          result: normalizeEnvelope({
            success: true,
            summary: "Subscription fallback generated a deterministic conflict proposal.",
            outputs: {
              proposalId: proposal.id,
              confidence: proposal.confidence,
              source: proposal.source
            },
            warnings: [],
            trackedSession: true
          }),
          metadata: {
            integrationStage: "subscription_fallback",
            proposalId: proposal.id,
            proposalSource: proposal.source
          }
        };
      } catch (error) {
        appendTimelineEvent({
          runId: args.run.id,
          stepId: args.step.id,
          attemptId: args.attempt.id,
          eventType: "integration_chain_stage",
          reason: "subscription_fallback_failed",
          detail: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }

    appendTimelineEvent({
      runId: args.run.id,
      stepId: args.step.id,
      attemptId: args.attempt.id,
      eventType: "integration_chain_stage",
      reason: "manual_intervention_required",
      detail: {
        targetLaneId,
        sourceLaneIds
      }
    });
    return {
      status: "blocked",
      errorClass: "policy",
      errorMessage: "Integration resolver chain reached intervention stage.",
      metadata: {
        integrationStage: "intervention_required",
        targetLaneId,
        sourceLaneIds
      }
    };
  };

  const tryRunMergePrAutomation = async (args: {
    run: OrchestratorRun;
    step: OrchestratorStep;
    attempt: OrchestratorAttempt;
  }): Promise<
    | {
        status: "succeeded" | "blocked" | "failed";
        result?: OrchestratorAttemptResultEnvelope;
        errorClass?: OrchestratorErrorClass;
        errorMessage?: string;
        metadata?: Record<string, unknown> | null;
      }
    | null
  > => {
    const metadata = args.step.metadata ?? {};
    const stepType = typeof metadata.stepType === "string" ? metadata.stepType.trim().toLowerCase() : "";
    if (stepType !== "merge") return null;
    if (metadata.prAutomationDisabled === true) return null;
    if (!prService) return null;

    const mergeModeRaw = typeof metadata.mergeMode === "string" ? metadata.mergeMode.trim() : "manual";
    const mergeMode = mergeModeRaw === "auto_if_green" ? "auto_if_green" : "manual";
    const mergeMethodRaw = typeof metadata.mergeMethod === "string" ? metadata.mergeMethod.trim() : "squash";
    const mergeMethod: "merge" | "squash" | "rebase" =
      mergeMethodRaw === "merge" || mergeMethodRaw === "squash" || mergeMethodRaw === "rebase"
        ? mergeMethodRaw
        : "squash";

    const targetLaneId =
      typeof metadata.targetLaneId === "string" && metadata.targetLaneId.trim().length
        ? metadata.targetLaneId.trim()
        : args.step.laneId ?? null;
    const sourceLaneIds = (
      Array.isArray(metadata.sourceLaneIds)
        ? metadata.sourceLaneIds.map((entry) => String(entry ?? "").trim()).filter(Boolean)
        : args.step.laneId
          ? [args.step.laneId]
          : []
    ).filter((entry, index, all) => all.indexOf(entry) === index);
    if (!sourceLaneIds.length) {
      return {
        status: "blocked",
        errorClass: "policy",
        errorMessage: "Merge step could not resolve a source lane for PR automation.",
        metadata: {
          mergeMode,
          missingSourceLane: true
        }
      };
    }

    const getLaneBranch = (laneId: string | null): string | null => {
      if (!laneId) return null;
      const lane = db.get<{ branch_ref: string | null }>(
        `
          select branch_ref
          from lanes
          where id = ?
            and project_id = ?
          limit 1
        `,
        [laneId, projectId]
      );
      const branch = typeof lane?.branch_ref === "string" ? branchNameFromRef(lane.branch_ref) : "";
      return branch.length > 0 ? branch : null;
    };

    const persistStepMergeMetadata = (patch: Record<string, unknown>): void => {
      const row = getStepRow(args.step.id);
      if (!row) return;
      const next = {
        ...(parseJsonRecord(row.metadata_json) ?? {}),
        ...patch
      };
      db.run(
        `
          update orchestrator_steps
          set metadata_json = ?,
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [JSON.stringify(next), nowIso(), args.step.id, projectId]
      );
    };

    const prTitleBase =
      typeof metadata.prTitle === "string" && metadata.prTitle.trim().length
        ? metadata.prTitle.trim()
        : args.step.title.trim().length
          ? args.step.title.trim()
          : "Orchestrator merge";
    const prBodyBase =
      typeof metadata.prBody === "string" && metadata.prBody.trim().length
        ? metadata.prBody.trim()
        : [
            "Automated merge step generated by ADE orchestrator.",
            "",
            `Run: ${args.run.id}`,
            `Step: ${args.step.stepKey}`
          ].join("\n");

    appendTimelineEvent({
      runId: args.run.id,
      stepId: args.step.id,
      attemptId: args.attempt.id,
      eventType: "integration_chain_started",
      reason: "merge_pr_automation_started",
      detail: {
        mergeMode,
        sourceLaneIds,
        targetLaneId
      }
    });

    try {
      let prSummary: ReturnType<NonNullable<typeof prService>["getForLane"]> | null = null;
      let integrationLaneId: string | null = null;

      if (sourceLaneIds.length === 1) {
        const laneId = sourceLaneIds[0]!;
        const existing = prService.getForLane(laneId);
        const fresh =
          existing
            ? (await prService.refresh({ prId: existing.id }).then((rows) => rows[0] ?? existing).catch(() => existing))
            : null;
        if (fresh && (fresh.state === "open" || fresh.state === "draft")) {
          prSummary = fresh;
        } else if (fresh && fresh.state === "merged") {
          prSummary = fresh;
        } else {
          const created = await prService.createFromLane({
            laneId,
            title: prTitleBase,
            body: prBodyBase,
            draft: false,
            ...(getLaneBranch(targetLaneId) ? { baseBranch: getLaneBranch(targetLaneId)! } : {})
          });
          prSummary = created;
          appendTimelineEvent({
            runId: args.run.id,
            stepId: args.step.id,
            attemptId: args.attempt.id,
            eventType: "integration_chain_stage",
            reason: "merge_pr_created",
            detail: {
              prId: created.id,
              laneId
            }
          });
        }
      } else {
        const priorIntegrationLaneId =
          typeof metadata.integrationLaneId === "string" && metadata.integrationLaneId.trim().length
            ? metadata.integrationLaneId.trim()
            : null;
        if (priorIntegrationLaneId) {
          const existing = prService.getForLane(priorIntegrationLaneId);
          if (existing) {
            prSummary = await prService.refresh({ prId: existing.id }).then((rows) => rows[0] ?? existing).catch(() => existing);
            integrationLaneId = priorIntegrationLaneId;
          }
        }
        if (!prSummary) {
          const baseBranch =
            getLaneBranch(targetLaneId)
            ?? getLaneBranch(sourceLaneIds[0]!)
            ?? "";
          if (!baseBranch.length) {
            return {
              status: "blocked",
              errorClass: "policy",
              errorMessage: "Merge PR automation could not resolve a base branch for integration PR.",
              metadata: {
                mergeMode,
                sourceLaneIds,
                targetLaneId
              }
            };
          }
          const integrationLaneName =
            typeof metadata.integrationLaneName === "string" && metadata.integrationLaneName.trim().length
              ? metadata.integrationLaneName.trim()
              : `orchestrator-${args.run.id.slice(0, 8)}-${args.step.stepKey.slice(0, 24)}`;
          const createPrArgs = {
            sourceLaneIds,
            integrationLaneName,
            baseBranch,
            title: prTitleBase,
            body: prBodyBase,
            draft: false
          };
          let created: Awaited<ReturnType<typeof prService.createIntegrationPr>>;
          try {
            created = await prService.createIntegrationPr(createPrArgs);
          } catch (firstError) {
            // Retry once after a short delay
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            try {
              created = await prService.createIntegrationPr(createPrArgs);
            } catch (retryError) {
              // Fallback: attempt to create as a draft PR
              try {
                created = await prService.createIntegrationPr({ ...createPrArgs, draft: true });
                appendTimelineEvent({
                  runId: args.run.id,
                  stepId: args.step.id,
                  attemptId: args.attempt.id,
                  eventType: "integration_chain_stage",
                  reason: "integration_pr_created_as_draft_fallback",
                  detail: {
                    originalError: firstError instanceof Error ? firstError.message : String(firstError),
                    retryError: retryError instanceof Error ? retryError.message : String(retryError),
                    sourceLaneIds
                  }
                });
              } catch (draftError) {
                // Both retry and draft fallback failed — request user intervention
                const errorDetail = {
                  originalError: firstError instanceof Error ? firstError.message : String(firstError),
                  retryError: retryError instanceof Error ? retryError.message : String(retryError),
                  draftError: draftError instanceof Error ? draftError.message : String(draftError)
                };
                appendTimelineEvent({
                  runId: args.run.id,
                  stepId: args.step.id,
                  attemptId: args.attempt.id,
                  eventType: "intervention_opened",
                  reason: "integration_pr_creation_failed",
                  detail: {
                    ...errorDetail,
                    sourceLaneIds,
                    integrationLaneName,
                    baseBranch,
                    message: "Integration PR creation failed after retry and draft fallback. Manual intervention required."
                  }
                });
                return {
                  status: "blocked",
                  errorClass: "transient",
                  errorMessage: `Integration PR creation failed after retry and draft fallback. Please create the PR manually. Errors: ${JSON.stringify(errorDetail)}`,
                  metadata: {
                    mergeMode,
                    sourceLaneIds,
                    targetLaneId,
                    requiresUserIntervention: true
                  }
                };
              }
            }
          }
          prSummary = created.pr;
          integrationLaneId = created.integrationLaneId;
          persistStepMergeMetadata({
            integrationLaneId,
            integrationPrId: created.pr.id
          });
          appendTimelineEvent({
            runId: args.run.id,
            stepId: args.step.id,
            attemptId: args.attempt.id,
            eventType: "integration_chain_stage",
            reason: "integration_pr_created",
            detail: {
              prId: created.pr.id,
              integrationLaneId,
              sourceLaneIds
            }
          });
        }
      }

      if (!prSummary) {
        return {
          status: "blocked",
          errorClass: "policy",
          errorMessage: "Merge PR automation did not produce a pull request.",
          metadata: {
            mergeMode,
            sourceLaneIds
          }
        };
      }

      if (prSummary.state === "merged") {
        return {
          status: "succeeded",
          result: normalizeEnvelope({
            success: true,
            summary: "Merge PR is already merged.",
            outputs: {
              prId: prSummary.id,
              prNumber: prSummary.githubPrNumber,
              prUrl: prSummary.githubUrl,
              integrationLaneId
            },
            warnings: [],
            trackedSession: true
          }),
          metadata: {
            mergeStage: "already_merged",
            prId: prSummary.id
          }
        };
      }

      if (mergeMode === "manual") {
        return {
          status: "blocked",
          errorClass: "policy",
          errorMessage: "Merge PR is ready and awaiting operator approval.",
          result: normalizeEnvelope({
            success: false,
            summary: "Merge PR prepared. Operator approval required before landing.",
            outputs: {
              prId: prSummary.id,
              prNumber: prSummary.githubPrNumber,
              prUrl: prSummary.githubUrl,
              mergeMode,
              integrationLaneId
            },
            warnings: [],
            trackedSession: true
          }),
          metadata: {
            mergeStage: "awaiting_approval",
            prId: prSummary.id,
            integrationLaneId
          }
        };
      }

      const status = await prService.getStatus(prSummary.id);
      const mergeReasons: string[] = [];
      if (status.state !== "open" && status.state !== "draft") mergeReasons.push(`state=${status.state}`);
      if (status.checksStatus === "failing" || status.checksStatus === "pending") mergeReasons.push(`checks=${status.checksStatus}`);
      if (status.reviewStatus === "changes_requested") mergeReasons.push(`review=${status.reviewStatus}`);
      if (status.mergeConflicts) mergeReasons.push("merge_conflicts=true");
      if (status.behindBaseBy > 0) mergeReasons.push(`behind_base_by=${status.behindBaseBy}`);
      if (!status.isMergeable) mergeReasons.push("is_mergeable=false");
      if (mergeReasons.length > 0) {
        appendTimelineEvent({
          runId: args.run.id,
          stepId: args.step.id,
          attemptId: args.attempt.id,
          eventType: "integration_chain_stage",
          reason: "merge_pr_not_green",
          detail: {
            prId: prSummary.id,
            reasons: mergeReasons
          }
        });
        return {
          status: "blocked",
          errorClass: "policy",
          errorMessage: `Merge PR is not green for auto-merge (${mergeReasons.join(", ")}).`,
          result: normalizeEnvelope({
            success: false,
            summary: "Merge PR created but not merge-ready yet.",
            outputs: {
              prId: prSummary.id,
              prNumber: prSummary.githubPrNumber,
              prUrl: prSummary.githubUrl,
              checksStatus: status.checksStatus,
              reviewStatus: status.reviewStatus,
              mergeConflicts: status.mergeConflicts,
              behindBaseBy: status.behindBaseBy,
              isMergeable: status.isMergeable,
              integrationLaneId
            },
            warnings: mergeReasons,
            trackedSession: true
          }),
          metadata: {
            mergeStage: "waiting_green",
            prId: prSummary.id
          }
        };
      }

      const landed = await prService.land({
        prId: prSummary.id,
        method: mergeMethod
      });
      if (!landed.success) {
        return {
          status: "failed",
          errorClass: "executor_failure",
          errorMessage: landed.error ?? "Merge API returned failure.",
          metadata: {
            mergeStage: "land_failed",
            prId: prSummary.id,
            mergeMethod
          }
        };
      }

      appendTimelineEvent({
        runId: args.run.id,
        stepId: args.step.id,
        attemptId: args.attempt.id,
        eventType: "integration_chain_stage",
        reason: "merge_pr_landed",
        detail: {
          prId: prSummary.id,
          mergeCommitSha: landed.mergeCommitSha,
          mergeMethod
        }
      });
      return {
        status: "succeeded",
        result: normalizeEnvelope({
          success: true,
          summary: "Merge PR landed successfully.",
          outputs: {
            prId: prSummary.id,
            prNumber: prSummary.githubPrNumber,
            prUrl: prSummary.githubUrl,
            mergeCommitSha: landed.mergeCommitSha,
            branchDeleted: landed.branchDeleted,
            laneArchived: landed.laneArchived,
            integrationLaneId
          },
          warnings: [],
          trackedSession: true
        }),
        metadata: {
          mergeStage: "landed",
          prId: prSummary.id,
          mergeMethod
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendTimelineEvent({
        runId: args.run.id,
        stepId: args.step.id,
        attemptId: args.attempt.id,
        eventType: "intervention_opened",
        reason: "merge_pr_automation_failed",
        detail: {
          error: message,
          message: "Merge PR automation failed. User intervention is required to resolve this step."
        }
      });
      return {
        status: "blocked",
        errorClass: "transient",
        errorMessage: `Merge PR automation failed: ${message}. User intervention required.`,
        metadata: {
          requiresUserIntervention: true
        }
      };
    }
  };

  const defaultAdapterFor = (kind: OrchestratorExecutorKind): OrchestratorExecutorAdapter | null => {
    if (kind !== "unified") return null;
    return {
      kind,
      requiresLaneId: true,
      start: async (args) => {
        if (!args.step.laneId) {
          return {
            status: "failed",
            errorClass: "policy",
            errorMessage: "Executor scaffolds require step.laneId to create tracked sessions."
          };
        }
        const title = `[orchestrator:${kind}] ${args.step.title}`;
        try {
          const contextDir = path.join(resolveAdeLayout(projectRoot).orchestratorContextsDir, args.run.id);
          fs.mkdirSync(contextDir, { recursive: true });
          const contextFilePath = path.join(contextDir, `${args.attempt.id}.json`);
          const memoryHierarchy = (() => {
            const snapshotId = args.attempt.contextSnapshotId;
            if (!snapshotId) return null;
            const row = db.get<{ cursor_json: string | null }>(
              `
                select cursor_json
                from orchestrator_context_snapshots
                where id = ?
                  and project_id = ?
                limit 1
              `,
              [snapshotId, projectId]
            );
            if (!row?.cursor_json) return null;
            try {
              const parsed = JSON.parse(row.cursor_json) as Record<string, unknown>;
              const hierarchy = parsed?.memoryHierarchy;
              if (!hierarchy || typeof hierarchy !== "object" || Array.isArray(hierarchy)) return null;
              return hierarchy as OrchestratorMemoryHierarchy;
            } catch {
              return null;
            }
          })();
          const contextManifest = {
            schema: "ade.orchestratorWorkerContext.v1",
            mission: {
              missionId: args.run.missionId,
              runId: args.run.id,
              stepId: args.step.id,
              attemptId: args.attempt.id,
              stepKey: args.step.stepKey,
              title: args.step.title,
              joinPolicy: args.step.joinPolicy,
              dependencyStepIds: args.step.dependencyStepIds
            },
            contextProfile: args.contextProfile.id,
            packs: {
              lane: args.laneExport
                ? {
                    packKey: args.laneExport.packKey,
                    level: args.laneExport.level,
                    approxTokens: args.laneExport.approxTokens,
                    contentPreview: clipText(args.laneExport.content, 3_000)
                  }
                : null,
              project: {
                packKey: args.projectExport.packKey,
                level: args.projectExport.level,
                approxTokens: args.projectExport.approxTokens,
                contentPreview: clipText(args.projectExport.content, 2_000)
              }
            },
            docs: args.docsRefs.slice(0, 24),
            fullDocsPreview: args.fullDocs.slice(0, 3).map((entry) => ({
              path: entry.path,
              truncated: entry.truncated,
              contentPreview: clipText(entry.content, 1_200)
            })),
            contextBroker: {
              assembly: "memory_hierarchy_v1",
              availableTiers: memoryHierarchy ? ["l0", "l1", "l2"] : []
            },
            memoryHierarchy,
            generatedAt: nowIso()
          };
          fs.writeFileSync(contextFilePath, `${JSON.stringify(contextManifest, null, 2)}\n`, "utf8");

          const requiresPlanApproval =
            args.step.metadata?.requiresPlanApproval === true || args.step.metadata?.coordinationPattern === "plan_then_implement";
          const readOnlyExecution = args.step.metadata?.readOnlyExecution === true || requiresPlanApproval;
          const promptParts = [
            `You are an ADE mission worker for step "${args.step.title}".`,
            requiresPlanApproval
              ? "Work in planning mode only. Do not mutate files. Return a concise implementation plan and risk notes."
              : "Implement the step with focused, minimal edits and run the relevant validation commands.",
            `Load full context from: ${contextFilePath}`,
            "Keep output concise and structured for orchestrator ingestion."
          ];

          // Inject recovery context for retry attempts in default adapter
          if (args.previousCheckpoint || args.previousAttemptSummary) {
            const recoveryLines: string[] = ["RECOVERY CONTEXT — PREVIOUS PROGRESS:", "Your previous attempt on this step was interrupted."];
            if (args.previousCheckpoint) {
              recoveryLines.push("Checkpoint from before interruption:", "---", args.previousCheckpoint, "---");
            }
            if (args.previousAttemptSummary) {
              recoveryLines.push("Previous attempt outcome:", args.previousAttemptSummary);
            }
            recoveryLines.push("Resume from where you left off. Do not redo completed work. Verify file state before continuing.");
            promptParts.push(recoveryLines.join("\n"));
          }

          const prompt = promptParts.join("\n");

          const modelRef = typeof args.step.metadata?.modelId === "string" ? args.step.metadata.modelId.trim() : "";
          if (!modelRef.length) {
            return {
              status: "failed",
              errorClass: "policy",
              errorMessage: `Step '${args.step.stepKey}' is missing required metadata.modelId.`,
              metadata: {
                adapterKind: kind,
                adapterState: "model_id_missing"
              }
            };
          }
          const descriptor = resolveModelDescriptor(modelRef);
          if (!descriptor) {
            return {
              status: "failed",
              errorClass: "policy",
              errorMessage: `Model '${modelRef}' is not registered.`,
              metadata: {
                adapterKind: kind,
                adapterState: "model_not_registered",
                modelId: modelRef
              }
            };
          }
          const cliCommand = descriptor?.cliCommand === "codex" ? "codex" : "claude";
          const commandParts: string[] = [cliCommand];
          const model = modelRef;
          if (model) {
            const effectiveModel = cliCommand === "claude"
              ? resolveClaudeCliModel(model)
              : cliCommand === "codex"
                ? resolveCodexCliModel(model)
                : model;
            commandParts.push("--model", shellEscapeArg(effectiveModel));
          }
          const cliMode = args.permissionConfig?.cli?.mode ?? "full-auto";
          if (cliCommand === "codex") {
            commandParts.push("--sandbox", readOnlyExecution ? "read-only" : args.permissionConfig?.cli?.sandboxPermissions ?? "workspace-write");
          } else {
            if (!readOnlyExecution && cliMode === "full-auto") {
              commandParts.push("--dangerously-skip-permissions");
            } else {
              commandParts.push("--permission-mode", readOnlyExecution || cliMode === "read-only" ? "plan" : "acceptEdits");
            }
          }
          commandParts.push(shellInlineDecodedArg(prompt));
          const startupCommand = commandParts.join(" ");

          const session = await args.createTrackedSession({
            laneId: args.step.laneId,
            cols: 120,
            rows: 36,
            title,
            toolType: `${kind}-orchestrated` as TerminalToolType,
            startupCommand
          });
          return {
            status: "accepted",
            sessionId: session.sessionId,
            metadata: {
              adapterKind: kind,
              adapterState: "worker_spawned",
              contextFilePath,
              contextDigest: sha256(JSON.stringify(contextManifest)),
              planMode: readOnlyExecution,
              startupCommandPreview: startupCommand.slice(0, 320),
              localFirst: true
            }
          };
        } catch (error) {
          return {
            status: "failed",
            errorClass: "executor_failure",
            errorMessage: error instanceof Error ? error.message : String(error),
            metadata: {
              adapterKind: kind,
              adapterState: "scaffold_start_failed"
            }
          };
        }
      }
    };
  };

  return {
    getContextProfile(): OrchestratorContextPolicyProfile {
      return DEFAULT_CONTEXT_POLICY;
    },

    registerExecutorAdapter(adapter: OrchestratorExecutorAdapter) {
      adapters.set(adapter.kind, adapter);
    },

    unregisterExecutorAdapter(kind: OrchestratorExecutorKind) {
      adapters.delete(kind);
    },

    async createOrchestratedSession(
      args: Omit<PtyCreateArgs, "tracked"> & { tracked?: boolean }
    ): Promise<{ ptyId: string; sessionId: string }> {
      if (!ptyService) throw new Error("PTY service unavailable for orchestrator execution.");
      if (args.tracked === false) {
        throw new Error("Orchestrated execution requires tracked=true sessions.");
      }
      return ptyService.create({
        ...args,
        tracked: true
      });
    },

    listRuns(args: { status?: OrchestratorRunStatus; missionId?: string; limit?: number } = {}): OrchestratorRun[] {
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.status) {
        where.push("status = ?");
        params.push(args.status);
      }
      if (args.missionId) {
        where.push("mission_id = ?");
        params.push(args.missionId);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 100))) : 100;
      const rows = db.all<RunRow>(
        `
          select
            id,
            mission_id,
            project_id,
            status,
            context_profile,
            scheduler_state,
            runtime_cursor_json,
            last_error,
            metadata_json,
            created_at,
            updated_at,
            started_at,
            completed_at
          from orchestrator_runs
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map(toRun);
    },

    listSteps(runId: string): OrchestratorStep[] {
      return listStepRows(runId).map(toStep);
    },

    listAttempts(args: { runId?: string; limit?: number } = {}): OrchestratorAttempt[] {
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.runId) {
        where.push("run_id = ?");
        params.push(args.runId);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 200))) : 200;
      const rows = db.all<AttemptRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_number,
            status,
            executor_kind,
            executor_session_id,
            tracked_session_enforced,
            context_profile,
            context_snapshot_id,
            error_class,
            error_message,
            retry_backoff_ms,
            result_envelope_json,
            metadata_json,
            created_at,
            started_at,
            completed_at
          from orchestrator_attempts
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map(toAttempt);
    },

    listClaims(args: { runId?: string; state?: OrchestratorClaimState; limit?: number } = {}): OrchestratorClaim[] {
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.runId) {
        where.push("run_id = ?");
        params.push(args.runId);
      }
      if (args.state) {
        where.push("state = ?");
        params.push(args.state);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 200))) : 200;
      const rows = db.all<ClaimRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_id,
            owner_id,
            scope_kind,
            scope_value,
            state,
            acquired_at,
            heartbeat_at,
            expires_at,
            released_at,
            policy_json,
            metadata_json
          from orchestrator_claims
          where ${where.join(" and ")}
          order by acquired_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map(toClaim);
    },

    listContextSnapshots(args: { runId?: string; limit?: number } = {}): OrchestratorContextSnapshot[] {
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.runId) {
        where.push("run_id = ?");
        params.push(args.runId);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 200))) : 200;
      const rows = db.all<ContextSnapshotRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_id,
            snapshot_type,
            context_profile,
            cursor_json,
            created_at
          from orchestrator_context_snapshots
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map(toContextSnapshot);
    },

    listHandoffs(args: { missionId?: string; runId?: string; limit?: number } = {}): MissionStepHandoff[] {
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.missionId) {
        where.push("mission_id = ?");
        params.push(args.missionId);
      }
      if (args.runId) {
        where.push("run_id = ?");
        params.push(args.runId);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 200))) : 200;
      const rows = db.all<HandoffRow>(
        `
          select
            id,
            mission_id,
            mission_step_id,
            run_id,
            step_id,
            attempt_id,
            handoff_type,
            producer,
            payload_json,
            created_at
          from mission_step_handoffs
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map(toHandoff);
    },

    createHandoff(args: {
      missionId: string;
      missionStepId?: string | null;
      runId?: string | null;
      stepId?: string | null;
      attemptId?: string | null;
      handoffType: string;
      producer: string;
      payload: Record<string, unknown>;
    }): MissionStepHandoff {
      const missionId = String(args.missionId ?? "").trim();
      if (!missionId) throw new Error("missionId is required.");
      const handoffType = String(args.handoffType ?? "").trim();
      if (!handoffType) throw new Error("handoffType is required.");
      const producer = String(args.producer ?? "").trim();
      if (!producer) throw new Error("producer is required.");
      return insertHandoff({
        missionId,
        missionStepId: args.missionStepId ?? null,
        runId: args.runId ?? null,
        stepId: args.stepId ?? null,
        attemptId: args.attemptId ?? null,
        handoffType,
        producer,
        payload: args.payload ?? {}
      });
    },

    listTimeline(args: { runId: string; limit?: number }): OrchestratorTimelineEvent[] {
      return listTimelineRows(args).map(toTimelineEvent);
    },

    appendTimelineEvent(args: {
      runId: string;
      stepId?: string | null;
      attemptId?: string | null;
      claimId?: string | null;
      eventType: string;
      reason: string;
      detail?: Record<string, unknown> | null;
    }): OrchestratorTimelineEvent {
      return appendTimelineEvent(args);
    },

    appendRuntimeEvent(args: {
      runId: string;
      stepId?: string | null;
      attemptId?: string | null;
      sessionId?: string | null;
      eventType: OrchestratorRuntimeEventType;
      eventKey?: string | null;
      occurredAt?: string | null;
      payload?: Record<string, unknown> | null;
    }): OrchestratorRuntimeBusEvent {
      return persistRuntimeEvent(args);
    },

    emitRuntimeUpdate(args: { runId: string; stepId?: string | null; reason: string }): void {
      emit({
        type: "orchestrator-step-updated",
        runId: args.runId,
        ...(args.stepId ? { stepId: args.stepId } : {}),
        reason: args.reason
      });
    },

    listRuntimeEvents(args: {
      runId?: string;
      attemptId?: string;
      sessionId?: string;
      eventTypes?: OrchestratorRuntimeEventType[];
      since?: string | null;
      limit?: number;
    } = {}): OrchestratorRuntimeBusEvent[] {
      return listRuntimeEventRows(args).map(toRuntimeEvent);
    },

    addReflection(input: ReflectionAddInput): OrchestratorReflectionEntry {
      const missionId = String(input.missionId ?? "").trim();
      const runId = String(input.runId ?? "").trim();
      const stepId = String(input.stepId ?? "").trim() || null;
      const attemptId = String(input.attemptId ?? "").trim() || null;
      const agentRole = String(input.agentRole ?? "").trim();
      const phase = String(input.phase ?? "").trim();
      const observation = String(input.observation ?? "").trim();
      const recommendation = String(input.recommendation ?? "").trim();
      const context = String(input.context ?? "").trim();
      const signalType = normalizeReflectionSignalType(String(input.signalType ?? "").trim());
      const occurredAtRaw = String(input.occurredAt ?? "").trim();

      if (!missionId) {
        throw new ReflectionValidationError("mission_id_required", "missionId is required.");
      }
      if (!runId) {
        throw new ReflectionValidationError("run_id_required", "runId is required.");
      }
      if (!agentRole) {
        throw new ReflectionValidationError("agent_role_required", "agentRole is required.");
      }
      if (!phase) {
        throw new ReflectionValidationError("phase_required", "phase is required.");
      }
      if (!signalType) {
        throw new ReflectionValidationError("signal_type_invalid", "signalType must be one of wish|frustration|idea|pattern|limitation.");
      }
      if (!observation) {
        throw new ReflectionValidationError("observation_required", "observation is required.");
      }
      if (!recommendation) {
        throw new ReflectionValidationError("recommendation_required", "recommendation is required.");
      }
      if (!context) {
        throw new ReflectionValidationError("context_required", "context is required.");
      }
      if (!occurredAtRaw) {
        throw new ReflectionValidationError("occurred_at_invalid", "occurredAt is required and must be a valid ISO-8601 timestamp.");
      }
      if (!isStrictIsoTimestamp(occurredAtRaw)) {
        throw new ReflectionValidationError("occurred_at_invalid", "occurredAt is required and must be a valid ISO-8601 timestamp.", { occurredAt: occurredAtRaw });
      }
      const occurredAtMs = Date.parse(occurredAtRaw);
      const occurredAt = new Date(occurredAtMs).toISOString();

      const runRow = getRunRow(runId);
      if (!runRow) {
        throw new ReflectionValidationError("run_not_found", `Run not found: ${runId}`, { runId });
      }
      if (String(runRow.mission_id) !== missionId) {
        throw new ReflectionValidationError("run_mission_mismatch", "runId does not belong to missionId.", { runId, missionId, actualMissionId: runRow.mission_id });
      }
      if (stepId) {
        const stepRow = getStepRow(stepId);
        if (!stepRow) {
          throw new ReflectionValidationError("step_not_found", `Step not found: ${stepId}`, { stepId });
        }
        if (String(stepRow.run_id) !== runId) {
          throw new ReflectionValidationError("step_run_mismatch", "stepId does not belong to runId.", { stepId, runId, actualRunId: stepRow.run_id });
        }
      }
      if (attemptId) {
        const attemptRow = getAttemptRow(attemptId);
        if (!attemptRow) {
          throw new ReflectionValidationError("attempt_not_found", `Attempt not found: ${attemptId}`, { attemptId });
        }
        if (String(attemptRow.run_id) !== runId) {
          throw new ReflectionValidationError("attempt_run_mismatch", "attemptId does not belong to runId.", { attemptId, runId, actualRunId: attemptRow.run_id });
        }
        if (stepId && String(attemptRow.step_id) !== stepId) {
          throw new ReflectionValidationError("attempt_step_mismatch", "attemptId does not belong to stepId.", { attemptId, stepId, actualStepId: attemptRow.step_id });
        }
      }

      const id = randomUUID();
      const createdAt = nowIso();
      const entry: OrchestratorReflectionEntry = {
        id,
        projectId,
        missionId,
        runId,
        stepId,
        attemptId,
        agentRole,
        phase,
        signalType,
        observation,
        recommendation,
        context,
        occurredAt,
        createdAt,
        schemaVersion: 1,
      };

      db.run("begin immediate");
      try {
        db.run(
          `
            insert into orchestrator_reflections(
              id, project_id, mission_id, run_id, step_id, attempt_id,
              agent_role, phase, signal_type, observation, recommendation,
              context, occurred_at, created_at, schema_version
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          `,
          [id, projectId, missionId, runId, stepId, attemptId, agentRole, phase, signalType, observation, recommendation, context, occurredAt, createdAt]
        );
        appendReflectionLedgerEntry(projectRoot, missionId, entry as unknown as Record<string, unknown>);
        db.run("commit");
      } catch (error) {
        try {
          db.run("rollback");
        } catch {
          // best effort rollback
        }
        throw error;
      }

      persistRuntimeEvent({ runId, stepId, attemptId, eventType: "reflection_added", payload: { reflectionId: id, signalType, phase, agentRole } });
      return entry;
    },

    listReflections(args: { runId?: string; missionId?: string; limit?: number } = {}): OrchestratorReflectionEntry[] {
      const runId = String(args.runId ?? "").trim();
      const missionId = String(args.missionId ?? "").trim();
      const limit = Math.max(1, Math.min(500, Math.floor(Number(args.limit ?? 200) || 200)));
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (runId) {
        where.push("run_id = ?");
        params.push(runId);
      }
      if (missionId) {
        where.push("mission_id = ?");
        params.push(missionId);
      }
      params.push(limit);
      const rows = db.all<any>(`select * from orchestrator_reflections where ${where.join(" and ")} order by occurred_at desc, created_at desc limit ?`, params);
      return rows.map((row) => ({
        id: String(row.id),
        projectId: String(row.project_id),
        missionId: String(row.mission_id),
        runId: String(row.run_id),
        stepId: row.step_id ? String(row.step_id) : null,
        attemptId: row.attempt_id ? String(row.attempt_id) : null,
        agentRole: String(row.agent_role),
        phase: String(row.phase),
        signalType: row.signal_type as OrchestratorReflectionEntry["signalType"],
        observation: String(row.observation),
        recommendation: String(row.recommendation ?? ""),
        context: String(row.context ?? ""),
        occurredAt: String(row.occurred_at),
        createdAt: String(row.created_at),
        schemaVersion: 1,
      }));
    },

    listRetrospectives(args: { missionId?: string; limit?: number } = {}): MissionRetrospective[] {
      const missionId = String(args.missionId ?? "").trim();
      const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit ?? 20) || 20)));
      const where = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (missionId) {
        where.push("mission_id = ?");
        params.push(missionId);
      }
      params.push(limit);
      const rows = db.all<{ payload_json: string }>(
        `select payload_json from orchestrator_retrospectives where ${where.join(" and ")} order by generated_at desc limit ?`,
        params
      );
      const out: MissionRetrospective[] = [];
      for (const row of rows) {
        const parsed = parseRetrospectivePayload(row.payload_json);
        if (parsed) out.push(parsed);
      }
      return out;
    },

    listRetrospectiveTrends(args: { missionId?: string; runId?: string; limit?: number } = {}): OrchestratorRetrospectiveTrend[] {
      const missionId = String(args.missionId ?? "").trim();
      const runId = String(args.runId ?? "").trim();
      const limit = Math.max(1, Math.min(500, Math.floor(Number(args.limit ?? 100) || 100)));
      const where = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (missionId) {
        where.push("mission_id = ?");
        params.push(missionId);
      }
      if (runId) {
        where.push("run_id = ?");
        params.push(runId);
      }
      params.push(limit);
      const rows = db.all<any>(
        `select * from orchestrator_retrospective_trends where ${where.join(" and ")} order by created_at desc limit ?`,
        params
      );
      return rows.map((row) => ({
        id: String(row.id),
        projectId: String(row.project_id),
        missionId: String(row.mission_id),
        runId: String(row.run_id),
        retrospectiveId: String(row.retrospective_id),
        sourceMissionId: String(row.source_mission_id),
        sourceRunId: String(row.source_run_id),
        sourceRetrospectiveId: String(row.source_retrospective_id),
        painPointKey: String(row.pain_point_key),
        painPointLabel: String(row.pain_point_label),
        status: row.status as OrchestratorRetrospectiveTrend["status"],
        previousPainScore: Number(row.previous_pain_score ?? 0),
        currentPainScore: Number(row.current_pain_score ?? 0),
        createdAt: String(row.created_at),
      }));
    },

    listRetrospectivePatternStats(args: { limit?: number } = {}): OrchestratorRetrospectivePatternStat[] {
      const limit = Math.max(1, Math.min(500, Math.floor(Number(args.limit ?? 100) || 100)));
      const rows = db.all<any>(
        `
          select *
          from orchestrator_reflection_pattern_stats
          where project_id = ?
          order by occurrence_count desc, updated_at desc
          limit ?
        `,
        [projectId, limit]
      );
      return rows.map((row) => ({
        id: String(row.id),
        projectId: String(row.project_id),
        patternKey: String(row.pattern_key),
        patternLabel: String(row.pattern_label),
        occurrenceCount: Number(row.occurrence_count ?? 0),
        firstSeenRetrospectiveId: String(row.first_seen_retrospective_id),
        firstSeenRunId: String(row.first_seen_run_id),
        lastSeenRetrospectiveId: String(row.last_seen_retrospective_id),
        lastSeenRunId: String(row.last_seen_run_id),
        promotedMemoryId: row.promoted_memory_id ? String(row.promoted_memory_id) : null,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }));
    },

    generateRunRetrospective(args: { runId: string }): MissionRetrospective | null {
      const runId = String(args.runId ?? "").trim();
      if (!runId) return null;
      const runRow = getRunRow(runId);
      if (!runRow) return null;
      const run = toRun(runRow);
      if (!TERMINAL_RUN_STATUSES.has(run.status)) return null;
      const existingRow = db.get<{ payload_json: string }>(
        `
          select payload_json
          from orchestrator_retrospectives
          where project_id = ?
            and run_id = ?
          limit 1
        `,
        [projectId, runId]
      );
      const existing = parseRetrospectivePayload(existingRow?.payload_json);
      if (existing) return existing;

      const graph = this.getRunGraph({ runId, timelineLimit: 500 });
      const reflections = this.listReflections({ runId, limit: 500 });
      const missionStateDocCounts = loadMissionStateDocCounts(projectRoot, runId);
      const generatedAt = nowIso();

      const painPointSignals = reflections
        .filter((entry) => entry.signalType === "frustration" || entry.signalType === "limitation")
        .map((entry) => entry.observation)
        .filter(Boolean);
      const improvementSignals = reflections
        .filter((entry) => entry.signalType === "idea" || entry.signalType === "wish")
        .map((entry) => (entry.recommendation || entry.observation).trim())
        .filter(Boolean);
      const patternSignals = reflections
        .filter((entry) => entry.signalType === "pattern")
        .map((entry) => entry.observation)
        .filter(Boolean);

      const painPointCounter = buildPainPointCounter(painPointSignals);
      const topPainPoints = [...painPointCounter.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label))
        .slice(0, 12)
        .map((entry) => entry[1].label);
      const topImprovements = [...new Set(improvementSignals.map((item) => item.trim()).filter(Boolean))]
        .slice(0, 12);
      const patternsToCapture = [...new Set(patternSignals.map((item) => item.trim()).filter(Boolean))]
        .slice(0, 12);

      const previousRows = db.all<{ id: string; mission_id: string; run_id: string; payload_json: string }>(
        `
          select id, mission_id, run_id, payload_json
          from orchestrator_retrospectives
          where project_id = ?
            and mission_id != ?
            and run_id != ?
          order by generated_at desc
          limit ?
        `,
        [projectId, run.missionId, runId, RETROSPECTIVE_TREND_LOOKBACK_LIMIT]
      );
      const previousPainScores = new Map<string, { label: string; score: number; sourceRetrospectiveId: string; sourceMissionId: string; sourceRunId: string }>();
      const trendEntries: Array<{
        sourceMissionId: string;
        sourceRunId: string;
        sourceRetrospectiveId: string;
        painPointKey: string;
        painPointLabel: string;
        status: "resolved" | "still_open" | "worsened";
        previousPainScore: number;
        currentPainScore: number;
      }> = [];
      for (const row of previousRows) {
        const previousRetrospective = parseRetrospectivePayload(row.payload_json);
        if (!previousRetrospective) continue;
        const counter = buildPainPointCounter(previousRetrospective.topPainPoints ?? []);
        for (const [key, value] of counter.entries()) {
          const currentPainScore = painPointCounter.get(key)?.count ?? 0;
          trendEntries.push({
            sourceMissionId: String(row.mission_id),
            sourceRunId: String(row.run_id),
            sourceRetrospectiveId: String(row.id),
            painPointKey: key,
            painPointLabel: value.label,
            status: computePainTrendStatus(value.count, currentPainScore),
            previousPainScore: value.count,
            currentPainScore,
          });
          const existingScore = previousPainScores.get(key);
          if (!existingScore || value.count > existingScore.score) {
            previousPainScores.set(key, {
              label: value.label,
              score: value.count,
              sourceRetrospectiveId: String(row.id),
              sourceMissionId: String(row.mission_id),
              sourceRunId: String(row.run_id),
            });
          }
        }
      }
      const changelog = [...previousPainScores.entries()]
        .sort((a, b) => b[1].score - a[1].score || a[1].label.localeCompare(b[1].label))
        .slice(0, 12)
        .map(([key, prev]) => {
          const currentPainScore = painPointCounter.get(key)?.count ?? 0;
          const status = computePainTrendStatus(prev.score, currentPainScore);
          const currentState = status === "resolved"
            ? "Pain point did not recur in latest run."
            : status === "worsened"
              ? "Pain point frequency increased in latest run."
              : "Pain point persisted in latest run.";
          return {
            previousPainPoint: prev.label,
            status,
            currentState,
            sourceRetrospectiveId: prev.sourceRetrospectiveId,
            sourceMissionId: prev.sourceMissionId,
            sourceRunId: prev.sourceRunId,
            previousPainScore: prev.score,
            currentPainScore,
          };
        });
      const runtimeEventCount = graph.runtimeEvents?.length ?? 0;

      const retrospective: MissionRetrospective = {
        id: `retro:${runId}`,
        missionId: run.missionId,
        runId,
        generatedAt,
        schemaVersion: 1,
        finalStatus: run.status,
        wins: graph.steps.filter((step) => step.status === "succeeded").slice(0, 12).map((step) => `Completed ${step.stepKey}: ${step.title}`),
        failures: graph.steps.filter((step) => step.status === "failed").slice(0, 12).map((step) => `Failed ${step.stepKey}: ${step.title}`),
        unresolvedRisks: graph.steps.filter((step) => step.status === "blocked").slice(0, 12).map((step) => `Blocked ${step.stepKey}: ${step.title}`),
        followUpActions: topImprovements.slice(0, 12),
        topPainPoints,
        topImprovements,
        patternsToCapture,
        estimatedImpact: topImprovements.length
          ? `Signals: timeline=${graph.timeline.length}, runtimeEvents=${runtimeEventCount}, reflections=${reflections.length}, decisions=${missionStateDocCounts.decisions}, activeIssues=${missionStateDocCounts.activeIssues}. Addressing top improvements should reduce retries and unresolved blockers in subsequent missions.`
          : `Signals: timeline=${graph.timeline.length}, runtimeEvents=${runtimeEventCount}, reflections=${reflections.length}, decisions=${missionStateDocCounts.decisions}, activeIssues=${missionStateDocCounts.activeIssues}. No clear improvements captured from reflections in this run.`,
        changelog,
      };

      db.run(
        `
          insert or ignore into orchestrator_retrospectives(
            id, project_id, mission_id, run_id, generated_at, final_status, payload_json, schema_version, created_at
          ) values (?, ?, ?, ?, ?, ?, ?, 1, ?)
        `,
        [retrospective.id, projectId, retrospective.missionId, retrospective.runId, retrospective.generatedAt, retrospective.finalStatus, JSON.stringify(retrospective), generatedAt]
      );
      const persistedRow = db.get<{ payload_json: string }>(
        `
          select payload_json
          from orchestrator_retrospectives
          where project_id = ?
            and run_id = ?
          limit 1
        `,
        [projectId, runId]
      );
      const persisted = parseRetrospectivePayload(persistedRow?.payload_json);
      if (!persisted) return null;

      persistRetrospectiveArtifact(projectRoot, persisted.missionId, persisted.runId, persisted as unknown as Record<string, unknown>);

      db.run(
        `delete from orchestrator_retrospective_trends where project_id = ? and retrospective_id = ?`,
        [projectId, persisted.id]
      );
      for (const entry of trendEntries) {
        const trendId = randomUUID();
        db.run(
          `
            insert into orchestrator_retrospective_trends(
              id, project_id, mission_id, run_id, retrospective_id,
              source_mission_id, source_run_id, source_retrospective_id,
              pain_point_key, pain_point_label, status, previous_pain_score, current_pain_score, created_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            trendId,
            projectId,
            persisted.missionId,
            persisted.runId,
            persisted.id,
            entry.sourceMissionId,
            entry.sourceRunId,
            entry.sourceRetrospectiveId,
            entry.painPointKey,
            entry.painPointLabel,
            entry.status,
            entry.previousPainScore,
            entry.currentPainScore,
            generatedAt
          ]
        );
      }

      if (memoryService) {
        const seenPatternKeys = new Set<string>();
        for (const patternLabel of persisted.patternsToCapture) {
          const normalizedLabel = String(patternLabel ?? "").trim();
          const patternKey = normalizePainPointKey(normalizedLabel);
          if (!patternKey || seenPatternKeys.has(patternKey)) continue;
          seenPatternKeys.add(patternKey);
          const existingPattern = db.get<any>(
            `
              select *
              from orchestrator_reflection_pattern_stats
              where project_id = ?
                and pattern_key = ?
              limit 1
            `,
            [projectId, patternKey]
          );
          let patternStatId: string;
          let nextCount = 1;
          let promotedMemoryId: string | null = null;
          if (existingPattern) {
            patternStatId = String(existingPattern.id);
            nextCount = Number(existingPattern.occurrence_count ?? 0) + 1;
            promotedMemoryId = existingPattern.promoted_memory_id ? String(existingPattern.promoted_memory_id) : null;
            db.run(
              `
                update orchestrator_reflection_pattern_stats
                set
                  pattern_label = ?,
                  occurrence_count = ?,
                  last_seen_retrospective_id = ?,
                  last_seen_run_id = ?,
                  updated_at = ?
                where id = ?
              `,
              [normalizedLabel, nextCount, persisted.id, persisted.runId, generatedAt, patternStatId]
            );
          } else {
            patternStatId = randomUUID();
            db.run(
              `
                insert into orchestrator_reflection_pattern_stats(
                  id, project_id, pattern_key, pattern_label,
                  occurrence_count, first_seen_retrospective_id, first_seen_run_id,
                  last_seen_retrospective_id, last_seen_run_id, promoted_memory_id,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
              [patternStatId, projectId, patternKey, normalizedLabel, 1, persisted.id, persisted.runId, persisted.id, persisted.runId, null, generatedAt, generatedAt]
            );
          }
          db.run(
            `
              insert or ignore into orchestrator_reflection_pattern_sources(
                id, project_id, pattern_stat_id, retrospective_id, mission_id, run_id, created_at
              ) values (?, ?, ?, ?, ?, ?, ?)
            `,
            [randomUUID(), projectId, patternStatId, persisted.id, persisted.missionId, persisted.runId, generatedAt]
          );
          if (!promotedMemoryId && nextCount >= RETROSPECTIVE_PATTERN_PROMOTION_THRESHOLD) {
            try {
              const confidence = Math.min(0.95, 0.7 + ((nextCount - RETROSPECTIVE_PATTERN_PROMOTION_THRESHOLD) * 0.05));
              const memory = memoryService.addCandidateMemory({
                projectId,
                scope: "project",
                category: "pattern",
                content: `[retrospective] ${normalizedLabel}`,
                importance: "medium",
                confidence,
                sourceRunId: runId,
              });
              promotedMemoryId = memory.id;
              db.run(
                `
                  update orchestrator_reflection_pattern_stats
                  set promoted_memory_id = ?, updated_at = ?
                  where id = ?
                `,
                [promotedMemoryId, generatedAt, patternStatId]
              );
            } catch {
              // best-effort only
            }
          }
        }
      }

      persistRuntimeEvent({ runId, eventType: "retrospective_generated", payload: { retrospectiveId: persisted.id } });
      return persisted;
    },

    getRunGraph(args: { runId: string; timelineLimit?: number }): OrchestratorRunGraph {
      const runRow = getRunRow(args.runId);
      if (!runRow) throw new Error(`Run not found: ${args.runId}`);
      const run = toRun(runRow);
      const steps = listStepRows(args.runId).map(toStep);
      const runMetadata = run.metadata ?? {};
      const graphPhases = resolveRunPhaseCardsFromMetadata(runMetadata);
      const graphSettings = resolveRunMissionLevelSettingsFromMetadata(runMetadata);

      let completion: RunCompletionEvaluation;
      if (graphPhases && graphPhases.length > 0 && graphSettings) {
        completion = evaluateRunCompletionFromPhases(steps, graphPhases, graphSettings);
      } else {
        const executionPolicy = isExecutionPolicyRecord(runMetadata.executionPolicy)
          ? (runMetadata.executionPolicy as MissionExecutionPolicy)
          : DEFAULT_EXECUTION_POLICY;
        completion = evaluateRunCompletion(steps, executionPolicy);
      }
      return {
        run,
        steps,
        attempts: listAttemptRows(args.runId).map(toAttempt),
        claims: this.listClaims({ runId: args.runId, limit: 1_000 }),
        contextSnapshots: this.listContextSnapshots({ runId: args.runId, limit: 1_000 }),
        handoffs: this.listHandoffs({ runId: args.runId, limit: 1_000 }),
        timeline: this.listTimeline({ runId: args.runId, limit: args.timelineLimit ?? 300 }),
        runtimeEvents: this.listRuntimeEvents({ runId: args.runId, limit: 1_000 }),
        completionEvaluation: completion
      };
    },

    startRunFromMission(args: {
      missionId: string;
      runId?: string;
      contextProfile?: OrchestratorContextProfileId;
      schedulerState?: string;
      metadata?: Record<string, unknown> | null;
      runMode?: "autopilot" | "manual";
      autopilotOwnerId?: string;
      defaultExecutorKind?: OrchestratorExecutorKind;
      defaultRetryLimit?: number;
    }): { run: OrchestratorRun; steps: OrchestratorStep[] } {
      const missionId = String(args.missionId ?? "").trim();
      if (!missionId) throw new Error("missionId is required.");
      const mission = db.get<{ id: string; prompt: string | null; lane_id: string | null; metadata_json: string | null }>(
        `
          select id, prompt, lane_id, metadata_json
          from missions
          where id = ?
            and project_id = ?
          limit 1
        `,
        [missionId, projectId]
      );
      if (!mission?.id) throw new Error(`Mission not found: ${missionId}`);
      const runtimeConfig = getRuntimeConfig();
      const missionSteps = db.all<{
        id: string;
        step_index: number;
        title: string;
        detail: string | null;
        kind: string;
        lane_id: string | null;
        metadata_json: string | null;
      }>(
        `
          select id, step_index, title, detail, kind, lane_id, metadata_json
          from mission_steps
          where mission_id = ?
            and project_id = ?
          order by step_index asc, created_at asc
        `,
        [missionId, projectId]
      );
      const requestedRunMode = args.runMode === "manual" ? "manual" : "autopilot";
      const requestedExecutor = normalizeExecutorKind(String(args.defaultExecutorKind ?? "unified"));
      const fallbackExecutor = requestedRunMode === "manual" ? "manual" : requestedExecutor === "manual" ? "unified" : requestedExecutor;
      const autopilotEnabled = requestedRunMode === "autopilot" && fallbackExecutor !== "manual";
      const autopilotOwnerId = String(args.autopilotOwnerId ?? "").trim() || "orchestrator-autopilot";
      const missionMetadata = parseJsonRecord(mission.metadata_json) ?? {};
      const missionPhaseConfiguration = asRecord(missionMetadata.phaseConfiguration);
      const missionLevelSettings = asRecord(missionMetadata.missionLevelSettings);
      const missionExecutionPolicy = isExecutionPolicyRecord(missionMetadata.executionPolicy)
        ? (missionMetadata.executionPolicy as MissionExecutionPolicy)
        : null;
      const missionPhaseOverride = Array.isArray(missionMetadata.phaseOverride)
        ? missionMetadata.phaseOverride as PhaseCard[]
        : null;
      const missionPhaseProfileId =
        typeof missionMetadata.phaseProfileId === "string" && missionMetadata.phaseProfileId.trim().length > 0
          ? missionMetadata.phaseProfileId.trim()
          : null;
      const plannerSummary = asRecord(asRecord(missionMetadata.plannerPlan)?.missionSummary);
      const plannerParallelismRaw = Number(
        args.metadata?.plannerParallelismCap ?? plannerSummary?.parallelismCap ?? Number.NaN
      );
      const plannerParallelismCap =
        Number.isFinite(plannerParallelismRaw) && plannerParallelismRaw > 0 ? Math.floor(plannerParallelismRaw) : null;
      const autopilotParallelismCap = Math.max(
        1,
        Math.min(runtimeConfig.maxParallelWorkers, plannerParallelismCap ?? runtimeConfig.maxParallelWorkers)
      );

      const descriptors = missionSteps.map((row, index) => {
        const metadata = parseJsonRecord(row.metadata_json) ?? {};
        const stepIndex = Number.isFinite(Number(row.step_index)) ? Number(row.step_index) : index;
        const explicitKey = typeof metadata.stepKey === "string" ? metadata.stepKey.trim() : "";
        const stepKey = explicitKey.length ? explicitKey : `mission_step_${stepIndex}_${index}`;
        return {
          row,
          index,
          metadata,
          stepIndex,
          stepKey
        };
      });

      const stepKeysByIndex = new Map<number, string[]>();
      for (const descriptor of descriptors) {
        const bucket = stepKeysByIndex.get(descriptor.stepIndex) ?? [];
        bucket.push(descriptor.stepKey);
        stepKeysByIndex.set(descriptor.stepIndex, bucket);
      }
      const descriptorByStepKey = new Map(descriptors.map((descriptor) => [descriptor.stepKey, descriptor] as const));

      const resolveDependencyKeys = (descriptor: (typeof descriptors)[number]): string[] => {
        const hasExplicitDependencies =
          Array.isArray(descriptor.metadata.dependencyStepKeys)
          || Array.isArray(descriptor.metadata.dependencyIndices);
        const explicitKeys = Array.isArray(descriptor.metadata.dependencyStepKeys)
          ? descriptor.metadata.dependencyStepKeys
              .map((entry) => String(entry ?? "").trim())
              .filter((entry) => entry.length > 0)
          : [];
        const indexedKeys = parseNumericDependencyIndices(descriptor.metadata).flatMap((depIndex) => stepKeysByIndex.get(depIndex) ?? []);
        const joined = [...explicitKeys, ...indexedKeys];
        const deduped = [...new Set(joined.filter((key) => key !== descriptor.stepKey))];
        if (deduped.length) return deduped;
        if (hasExplicitDependencies) return [];
        if (descriptor.index > 0) {
          return [descriptors[descriptor.index - 1]!.stepKey];
        }
        return [];
      };

      const normalized: StartOrchestratorRunStepInput[] = descriptors.map((descriptor) => {
        const { row, metadata } = descriptor;
        const explicitExecutor =
          typeof metadata.executorKind === "string" ? normalizeExecutorKind(metadata.executorKind) : fallbackExecutor;
        const retryLimitRaw = Number(metadata.retryLimit);
        const configuredRetryLimit = Number(args.defaultRetryLimit ?? runtimeConfig.maxRetriesPerStep);
        const retryLimit = Number.isFinite(retryLimitRaw)
          ? Math.max(0, Math.floor(retryLimitRaw))
          : Math.max(0, Math.floor(configuredRetryLimit));
        const joinPolicy =
          typeof metadata.joinPolicy === "string" ? normalizeJoinPolicy(String(metadata.joinPolicy)) : "all_success";
        const quorumRaw = Number(metadata.quorumCount);
        const quorumCount = Number.isFinite(quorumRaw) && quorumRaw > 0 ? Math.floor(quorumRaw) : undefined;
        const dependencyStepKeys = resolveDependencyKeys(descriptor);
        const stepType = String(metadata.stepType ?? row.kind ?? "").trim() || "manual";
        const integrationHints = (() => {
          if (stepType !== "integration" && stepType !== "merge") {
            return {
              targetLaneId: null as string | null,
              sourceLaneIds: [] as string[]
            };
          }
          const existingTarget = typeof metadata.targetLaneId === "string" ? metadata.targetLaneId.trim() : "";
          const targetLaneId =
            existingTarget.length > 0
              ? existingTarget
              : typeof row.lane_id === "string" && row.lane_id.trim().length > 0
                ? row.lane_id.trim()
                : typeof mission.lane_id === "string" && mission.lane_id.trim().length > 0
                  ? mission.lane_id.trim()
                  : null;
          const explicitSourceLaneIds = Array.isArray(metadata.sourceLaneIds)
            ? metadata.sourceLaneIds
                .map((entry) => String(entry ?? "").trim())
                .filter((entry) => entry.length > 0)
            : [];
          if (explicitSourceLaneIds.length > 0) {
            return {
              targetLaneId,
              sourceLaneIds: [...new Set(explicitSourceLaneIds.filter((entry) => entry !== targetLaneId))]
            };
          }
          const derivedSourceLaneIds = dependencyStepKeys
            .map((depKey) => {
              const depDescriptor = descriptorByStepKey.get(depKey);
              const depLaneId = depDescriptor?.row?.lane_id;
              return typeof depLaneId === "string" ? depLaneId.trim() : "";
            })
            .filter((laneId) => laneId.length > 0 && laneId !== targetLaneId);
          return {
            targetLaneId,
            sourceLaneIds: [...new Set(derivedSourceLaneIds)]
          };
        })();
        const inferredPattern =
          joinPolicy === "any_success"
            ? "speculative_parallel"
            : dependencyStepKeys.length > 1
              ? "fan_in_merge"
              : stepType === "analysis"
                ? "plan_then_implement"
                : stepType === "review"
                  ? "review_and_revise"
                  : dependencyStepKeys.length === 0 && requestedRunMode === "autopilot"
                    ? "parallel_fan_out"
                    : "sequential_chain";
        const stepInstructions =
          typeof metadata.instructions === "string" && metadata.instructions.trim().length
            ? metadata.instructions.trim()
            : typeof row.detail === "string" && row.detail.trim().length
              ? row.detail.trim()
              : "";
        const explicitRequiresPlanApproval =
          typeof metadata.requiresPlanApproval === "boolean" ? metadata.requiresPlanApproval : null;
        const inferredRequiresPlanApproval =
          inferredPattern === "plan_then_implement" || stepType === "analysis";
        const isAiTeammate = normalizeExecutorKind(String(explicitExecutor ?? "manual")) === "unified";
        const requiresPlanApproval = explicitRequiresPlanApproval != null
          ? explicitRequiresPlanApproval
          : runtimeConfig.teammatePlanMode === "required" && isAiTeammate
            ? true
            : runtimeConfig.teammatePlanMode === "off"
              ? false
              : inferredRequiresPlanApproval;
        const mergedMetadata: Record<string, unknown> = {
          ...metadata,
          instructions: stepInstructions,
          stepType,
          requiresPlanApproval,
          teammatePlanMode: runtimeConfig.teammatePlanMode,
          coordinationPattern: metadata.coordinationPattern ?? inferredPattern
        };
        if (
          (stepType === "integration" || stepType === "merge")
          && integrationHints.targetLaneId
          && typeof mergedMetadata.targetLaneId !== "string"
        ) {
          mergedMetadata.targetLaneId = integrationHints.targetLaneId;
        }
        if (
          (stepType === "integration" || stepType === "merge")
          && integrationHints.sourceLaneIds.length > 0
          && !Array.isArray(mergedMetadata.sourceLaneIds)
        ) {
          mergedMetadata.sourceLaneIds = integrationHints.sourceLaneIds;
        }
        return {
          missionStepId: row.id,
          stepKey: descriptor.stepKey,
          title: row.title,
          stepIndex: descriptor.stepIndex,
          laneId: row.lane_id,
          dependencyStepKeys,
          joinPolicy,
          quorumCount,
          retryLimit,
          executorKind: explicitExecutor,
          policy: parseStepPolicyFromMetadata(metadata),
          metadata: mergedMetadata
        };
      });

      if (!normalized.length) {
        normalized.push({
          stepKey: "mission_step_0_0",
          title: "Execute mission objective",
          stepIndex: 0,
          laneId: null,
          retryLimit: Math.max(0, Math.floor(args.defaultRetryLimit ?? runtimeConfig.maxRetriesPerStep)),
          executorKind: fallbackExecutor,
          metadata: {
            stepType: "manual",
            missionPrompt: mission.prompt ?? "",
            requiresPlanApproval: false,
            coordinationPattern: "sequential_chain"
          }
        });
      }

      const plannerMetadata = descriptors
        .map((descriptor) => descriptor.metadata?.planner)
        .find((planner) => planner && typeof planner === "object" && !Array.isArray(planner)) as Record<string, unknown> | undefined;

      const coordinationPatterns = normalized.reduce<Record<string, number>>((acc, stepInput) => {
        const key =
          stepInput.metadata && typeof stepInput.metadata.coordinationPattern === "string"
            ? stepInput.metadata.coordinationPattern
            : "sequential_chain";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      const launchMeta = asRecord(missionMetadata.launch);
      const launchTeamRuntime = asRecord(launchMeta?.teamRuntime);
      const launchAgentRuntime = asRecord(launchMeta?.agentRuntime);

      const started = this.startRun({
        missionId,
        runId: args.runId,
        contextProfile: args.contextProfile,
        schedulerState: args.schedulerState,
        metadata: {
          ...(args.metadata ?? {}),
          missionGoal: mission.prompt ?? "",
          missionPrompt: mission.prompt ?? "",
          runMode: requestedRunMode,
          ...(missionLevelSettings ? { missionLevelSettings } : {}),
          ...(missionPhaseConfiguration ? { phaseConfiguration: missionPhaseConfiguration } : {}),
          ...(missionExecutionPolicy ? { executionPolicy: missionExecutionPolicy } : {}),
          ...(missionPhaseOverride ? { phaseOverride: missionPhaseOverride } : {}),
          ...(missionPhaseProfileId ? { phaseProfileId: missionPhaseProfileId } : {}),
          ...(launchTeamRuntime
            ? {
                teamRuntime: {
                  ...launchTeamRuntime,
                  ...normalizeAgentRuntimeFlags(launchTeamRuntime)
                }
              }
            : {}),
          ...(launchAgentRuntime
            ? {
                agentRuntime: normalizeAgentRuntimeFlags(launchAgentRuntime)
              }
            : {}),
          planner: {
            source: "mission_steps",
            stepCount: normalized.length,
            strategy: typeof plannerMetadata?.strategy === "string" ? plannerMetadata.strategy : null,
            version: typeof plannerMetadata?.version === "string" ? plannerMetadata.version : null,
            parallelismCap: autopilotParallelismCap
          },
          coordination: {
            patterns: coordinationPatterns
          },
	          orchestratorConfig: {
	            teammatePlanMode: runtimeConfig.teammatePlanMode,
	            maxParallelWorkers: runtimeConfig.maxParallelWorkers,
	            contextPressureThreshold: runtimeConfig.contextPressureThreshold,
	            progressiveLoading: runtimeConfig.progressiveLoading,
	            fileReservationGuardMode: runtimeConfig.fileReservationGuardMode
	          },
          autopilot: {
            enabled: autopilotEnabled,
            executorKind: autopilotEnabled ? fallbackExecutor : "manual",
            ownerId: autopilotOwnerId,
            parallelismCap: autopilotParallelismCap
          }
        },
        steps: normalized
      });

      if (autopilotEnabled) {
        void this
          .startReadyAutopilotAttempts({
            runId: started.run.id,
            reason: "run_started"
          })
          .catch(() => {});
      }

      return started;
    },

    async startReadyAutopilotAttempts(args: { runId: string; reason?: string }): Promise<number> {
      const runId = String(args.runId ?? "").trim();
      if (!runId.length) return 0;

      // Early guard: skip if the run is paused or missing (before lock acquisition)
      const preCheckRow = getRunRow(runId);
      if (!preCheckRow) {
        return 0;
      }
      const preCheckRun = toRun(preCheckRow);
      if (preCheckRun.status === "paused" || hasOpenBlockingInterventionForRun(preCheckRun)) {
        return 0;
      }

      if (autopilotRunLocks.has(runId)) {
        if (args.reason === "initial_ramp_up") {
          let waited = 0;
          while (autopilotRunLocks.has(runId) && waited < 2000) {
            await new Promise((r) => setTimeout(r, 100));
            waited += 100;
          }
          if (autopilotRunLocks.has(runId)) return 0;
        } else {
          return 0;
        }
      }

      autopilotRunLocks.add(runId);
      try {
        const runRow = getRunRow(runId);
        if (!runRow) return 0;
        const run = toRun(runRow);
        if (!runCanStartAttempts(run.status) || hasOpenBlockingInterventionForRun(run)) return 0;

        const autopilot = parseAutopilotConfig(run.metadata, DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG.maxParallelWorkers);
        if (!autopilot.enabled) return 0;
        const parallelismCap = Math.max(1, Math.min(32, autopilot.parallelismCap));
        const computeEffectiveParallelismCap = (): {
          cap: number;
          reasons: string[];
        } => {
          const latestRunRow = getRunRow(runId);
          const latestRunMetadata = latestRunRow ? parseJsonRecord(latestRunRow.metadata_json) : null;
          const aiDecisions = asRecord(latestRunMetadata?.aiDecisions);
          const aiParallelismRaw = Number(aiDecisions?.parallelismCap ?? Number.NaN);
          const aiParallelismCap = Number.isFinite(aiParallelismRaw)
            ? Math.max(1, Math.min(32, Math.floor(aiParallelismRaw)))
            : null;
          if (aiParallelismCap != null) return { cap: aiParallelismCap, reasons: ["ai_decision_cap"] };
          return { cap: parallelismCap, reasons: ["configured_cap"] };
        };
        let lastCapSignature = "";

        let startedAttempts = 0;
        const startedByExecutor: Record<string, number> = {};
        let loops = 0;
        while (loops < 12) {
          loops += 1;
          const loopRunRow = getRunRow(runId);
          if (!loopRunRow) break;
          const loopRun = toRun(loopRunRow);
          if (!runCanStartAttempts(loopRun.status) || hasOpenBlockingInterventionForRun(loopRun)) break;
          this.tick({ runId });
          const effectiveCapState = computeEffectiveParallelismCap();
          const effectiveCap = effectiveCapState.cap;
          const capSignature = `${effectiveCap}:${effectiveCapState.reasons.join(",")}`;
          if (capSignature !== lastCapSignature) {
            lastCapSignature = capSignature;
            appendTimelineEvent({
              runId,
              eventType: "autopilot_parallelism_cap_adjusted",
              reason: effectiveCapState.reasons[0] ?? "configured_cap",
              detail: {
                configuredCap: parallelismCap,
                effectiveCap,
                reasons: effectiveCapState.reasons
              }
            });
          }
          let runningAttemptCount = listAttemptRows(runId)
            .map(toAttempt)
            .filter((attempt) => attempt.status === "running").length;
          if (runningAttemptCount >= effectiveCap) break;

          const readySteps = filterExecutionSteps(listStepRows(runId)
            .map(toStep))
            .filter((step) => step.status === "ready")
            .sort(readyStepOrderComparator);
          if (!readySteps.length) break;

          // Phase 1 (sequential): pre-validate steps and collect spawn descriptors
          // up to the effective cap. This keeps freshness checks and manual-step
          // filtering sequential so we don't over-commit slots.
          const spawnDescriptors: Array<{ step: typeof readySteps[number]; executor: OrchestratorExecutorKind }> = [];
          for (const step of readySteps) {
            if (runningAttemptCount + spawnDescriptors.length >= effectiveCap) break;
            const fresh = getStepRow(step.id);
            if (!fresh) continue;
            if (toStep(fresh).status !== "ready") continue;
            const stepMetadata = asRecord(step.metadata);
            if (asBool(stepMetadata?.isMilestone, false)) {
              const contract = asRecord(stepMetadata?.validationContract);
              const validationCriteria =
                typeof contract?.criteria === "string"
                  ? contract.criteria.trim()
                  : typeof stepMetadata?.validationCriteria === "string"
                    ? stepMetadata.validationCriteria.trim()
                    : "";
              appendTimelineEvent({
                runId,
                stepId: step.id,
                eventType: "autopilot_step_skipped",
                reason: "milestone_requires_validation_gate",
                detail: {
                  stepKey: step.stepKey,
                  validationCriteria: validationCriteria || null
                }
              });
              continue;
            }
            const explicitStepExecutor =
              typeof step.metadata?.executorKind === "string"
                ? normalizeExecutorKind(String(step.metadata.executorKind))
                : null;
            const stepExecutor = explicitStepExecutor ?? autopilot.executorKind;
            if (stepExecutor === "manual") {
              appendTimelineEvent({
                runId,
                stepId: step.id,
                eventType: "autopilot_step_skipped",
                reason: "manual_step_requires_operator",
                detail: {
                  stepKey: step.stepKey
                }
              });
              continue;
            }
            spawnDescriptors.push({ step, executor: stepExecutor });
          }

          // Phase 2 (parallel): spawn all validated steps concurrently.
          // Claims inside startAttempt are synchronous SQLite operations and
          // serialize naturally. Context snapshots and PTY sessions are the
          // expensive async work that benefits from parallelism.
          // Promise.allSettled ensures one failure does not cancel others.
          let startedInLoop = 0;
          if (spawnDescriptors.length > 0) {
            const results = await Promise.allSettled(
              spawnDescriptors.map(({ step, executor }) =>
                this.startAttempt({
                  runId,
                  stepId: step.id,
                  ownerId: autopilot.ownerId,
                  executorKind: executor
                }).then(
                  () => ({ ok: true as const, step, executor }),
                  (error: unknown) => {
                    appendTimelineEvent({
                      runId,
                      stepId: step.id,
                      eventType: "autopilot_attempt_start_failed",
                      reason: "autopilot_start_failed",
                      detail: {
                        message: error instanceof Error ? error.message : String(error)
                      }
                    });
                    return { ok: false as const, step, executor };
                  }
                )
              )
            );
            for (const result of results) {
              // allSettled with the inner .then() catch means all results are
              // "fulfilled" — the inner catch converts rejections to { ok: false }.
              if (result.status === "fulfilled" && result.value.ok) {
                startedAttempts += 1;
                startedInLoop += 1;
                runningAttemptCount += 1;
                startedByExecutor[result.value.executor] =
                  (startedByExecutor[result.value.executor] ?? 0) + 1;
              }
            }
          }
          if (startedInLoop === 0) break;
        }

        if (startedAttempts > 0) {
          appendTimelineEvent({
            runId,
            eventType: "autopilot_advance",
            reason: args.reason ?? "autopilot_advance",
            detail: {
              startedAttempts,
              executorKind: autopilot.executorKind,
              executorRouting: "step_policy",
              startedByExecutor,
              parallelismCap: parallelismCap
            }
          });
        }

        this.tick({ runId });
        return startedAttempts;
      } finally {
        autopilotRunLocks.delete(runId);
      }
    },

    async onTrackedSessionEnded(args: { sessionId: string; laneId?: string | null; exitCode: number | null }): Promise<number> {
      const sessionId = String(args.sessionId ?? "").trim();
      if (!sessionId.length) return 0;
      const sessionRow = db.get<{ status: string | null; exit_code: number | null; transcript_path: string | null }>(
        `
          select status, exit_code, transcript_path
          from terminal_sessions
          where id = ?
          limit 1
        `,
        [sessionId]
      );
      const sessionStatus = normalizeTerminalSessionStatus(sessionRow?.status);
      const resolvedExitCode = (() => {
        const fromArgs = Number(args.exitCode);
        if (Number.isFinite(fromArgs)) return Math.floor(fromArgs);
        const fromRow = Number(sessionRow?.exit_code);
        if (Number.isFinite(fromRow)) return Math.floor(fromRow);
        return null;
      })();
      const runningAttempts = db.all<AttemptRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_number,
            status,
            executor_kind,
            executor_session_id,
            tracked_session_enforced,
            context_profile,
            context_snapshot_id,
            error_class,
            error_message,
            retry_backoff_ms,
            result_envelope_json,
            metadata_json,
            created_at,
            started_at,
            completed_at
          from orchestrator_attempts
          where project_id = ?
            and executor_session_id = ?
            and status = 'running'
          order by created_at asc
        `,
        [projectId, sessionId]
      );
      if (!runningAttempts.length) return 0;

      const completion = (() => {
        if (resolvedExitCode != null) {
          if (resolvedExitCode === 0) {
            return {
              status: "succeeded" as const,
              errorClass: null,
              errorMessage: null
            };
          }
          return {
            status: "failed" as const,
            errorClass: "executor_failure" as const,
            errorMessage: `Tracked session exited with code ${resolvedExitCode}.`
          };
        }
        if (sessionStatus === "completed") {
          return {
            status: "succeeded" as const,
            errorClass: null,
            errorMessage: null
          };
        }
        if (sessionStatus === "disposed") {
          return {
            status: "canceled" as const,
            errorClass: "canceled" as const,
            errorMessage: "Tracked session was disposed before completion."
          };
        }
        return {
          status: "failed" as const,
          errorClass: "executor_failure" as const,
          errorMessage:
            sessionStatus === "failed"
              ? "Tracked session reported failed status."
              : "Tracked session ended unexpectedly without an exit code."
        };
      })();

      const touchedRunIds = new Set<string>();
      for (const attempt of runningAttempts) {
        touchedRunIds.add(attempt.run_id);
        const stepRow = getStepRow(attempt.step_id);
        const step = stepRow ? toStep(stepRow) : null;
        const stepMetadata = asRecord(step?.metadata) ?? {};
        const attemptMetadata = parseJsonRecord(attempt.metadata_json);
        const transcriptPath =
          typeof attemptMetadata?.transcriptPath === "string"
            ? attemptMetadata.transcriptPath.trim()
            : (typeof sessionRow?.transcript_path === "string" ? sessionRow.transcript_path.trim() : "");
        const transcriptAnalysis = analyzeTranscriptFromPath(transcriptPath);
        const transcriptSummary = transcriptAnalysis.summary;
        const silentFailure = classifySilentWorkerExit({
          stepMetadata,
          transcriptSummary,
          hasMaterialOutput: transcriptAnalysis.hasMaterialOutput,
          hasLifecycleActivity: transcriptAnalysis.hasLifecycleActivity,
        });
        const completionForAttempt =
          completion.status === "succeeded" && silentFailure
            ? {
                status: "failed" as const,
                errorClass: silentFailure.errorClass,
                errorMessage: silentFailure.errorMessage,
              }
            : completion;
        persistRuntimeEvent({
          runId: attempt.run_id,
          stepId: attempt.step_id,
          attemptId: attempt.id,
          sessionId,
          eventType: "session_ended",
          eventKey: `session_ended:${attempt.id}:${sessionId}:${sessionStatus}:${resolvedExitCode ?? "none"}`,
          payload: {
            sessionStatus,
            exitCode: resolvedExitCode
          }
        });
        await this.completeAttempt({
          attemptId: attempt.id,
          status: completionForAttempt.status,
          ...(completionForAttempt.errorClass
            ? {
                errorClass: completionForAttempt.errorClass,
                errorMessage: completionForAttempt.errorMessage
              }
            : {}),
          metadata: {
            reconciledFromTrackedSession: true,
            trackedSessionId: sessionId,
            laneId: args.laneId ?? null,
            exitCode: resolvedExitCode,
            sessionStatus
          }
        });
      }

      for (const runId of touchedRunIds) {
        await this.startReadyAutopilotAttempts({
          runId,
          reason: "session_ended"
        });
      }

      return runningAttempts.length;
    },

    evaluateGateReport(): OrchestratorGateReport {
      const now = Date.now();
      const gateEntries: OrchestratorGateEntry[] = [];
      const notes: string[] = [];

      const pipelineRows = db.all<{
        session_id: string;
        ended_at: string | null;
        delta_at: string | null;
        checkpoint_at: string | null;
      }>(
        `
          select
            s.id as session_id,
            s.ended_at as ended_at,
            (
              select d.computed_at
              from session_deltas d
              where d.project_id = ?
                and d.session_id = s.id
              order by d.computed_at desc
              limit 1
            ) as delta_at,
            (
              select c.created_at
              from checkpoints c
              where c.project_id = ?
                and c.session_id = s.id
              order by c.created_at desc
              limit 1
            ) as checkpoint_at
          from terminal_sessions s
          join lanes l on l.id = s.lane_id
          where l.project_id = ?
            and s.tracked = 1
            and s.ended_at is not null
          order by s.ended_at desc
          limit 400
        `,
        [projectId, projectId, projectId]
      );
      const pipelineSamples = pipelineRows
        .map((row) => {
          const endedAt = row.ended_at ? Date.parse(row.ended_at) : NaN;
          if (!Number.isFinite(endedAt)) return null;
          const materializedAt = [row.delta_at, row.checkpoint_at]
            .map((value) => (value ? Date.parse(value) : NaN))
            .filter((value) => Number.isFinite(value));
          if (!materializedAt.length) return null;
          return Math.max(0, Math.max(...materializedAt) - endedAt);
        })
        .filter((value): value is number => Number.isFinite(value));
      const pipelineWithin = pipelineSamples.filter((value) => value <= GATE_THRESHOLDS.maxTrackedPipelineLatencyMs).length;
      const pipelineRate = pipelineSamples.length > 0 ? pipelineWithin / pipelineSamples.length : 0;
      const averagePipelineLatency =
        pipelineSamples.length > 0 ? Math.round(pipelineSamples.reduce((sum, value) => sum + value, 0) / pipelineSamples.length) : 0;
      gateEntries.push({
        key: "session_delta_checkpoint_pack_latency",
        label: "Tracked session -> delta/checkpoint latency",
        status:
          pipelineSamples.length === 0
            ? "warn"
            : averagePipelineLatency <= GATE_THRESHOLDS.maxTrackedPipelineLatencyMs
              ? "pass"
              : "fail",
        measuredValue: averagePipelineLatency,
        threshold: GATE_THRESHOLDS.maxTrackedPipelineLatencyMs,
        comparator: "<=",
        samples: pipelineSamples.length,
        reasons:
          pipelineSamples.length === 0
            ? ["No tracked session pipeline samples were available."]
            : averagePipelineLatency <= GATE_THRESHOLDS.maxTrackedPipelineLatencyMs
              ? []
              : [`Average latency ${averagePipelineLatency}ms exceeded threshold (${GATE_THRESHOLDS.maxTrackedPipelineLatencyMs}ms).`],
        metadata: {
          withinBudgetRate: pipelineSamples.length > 0 ? pipelineRate : 0
        }
      });

      const snapshotRows = db.all<{ created_at: string }>(
        `
          select created_at
          from orchestrator_context_snapshots
          where project_id = ?
          order by created_at desc
          limit 400
        `,
        [projectId]
      );
      const freshnessWindowMs = GATE_THRESHOLDS.freshnessMaxAgeByPackTypeMs.lane;
      const freshCount = snapshotRows.filter((row) => {
        const updatedAt = row.created_at ? Date.parse(row.created_at) : NaN;
        if (!Number.isFinite(updatedAt)) return false;
        return now - updatedAt <= freshnessWindowMs;
      }).length;
      const freshnessRate = snapshotRows.length > 0 ? freshCount / snapshotRows.length : 0;
      gateEntries.push({
        key: "pack_freshness_by_type",
        label: "Live context snapshot freshness",
        status:
          snapshotRows.length === 0
            ? "warn"
            : freshnessRate >= GATE_THRESHOLDS.minFreshnessByTypeRate
              ? "pass"
              : "fail",
        measuredValue: Number(freshnessRate.toFixed(4)),
        threshold: GATE_THRESHOLDS.minFreshnessByTypeRate,
        comparator: ">=",
        samples: snapshotRows.length,
        reasons:
          snapshotRows.length === 0
            ? ["No context snapshots exist yet."]
            : freshnessRate >= GATE_THRESHOLDS.minFreshnessByTypeRate
              ? []
              : [`Fresh context snapshots ${freshCount}/${snapshotRows.length} fell below threshold.`],
        metadata: {
          freshCount,
          total: snapshotRows.length,
          freshnessWindowMs
        }
      });

      const attemptRows = db.all<{ context_snapshot_id: string | null; cursor_json: string | null; status: string }>(
        `
          select
            a.context_snapshot_id,
            a.status,
            s.cursor_json
          from orchestrator_attempts a
          left join orchestrator_context_snapshots s on s.id = a.context_snapshot_id
          where a.project_id = ?
            and a.status in ('running', 'succeeded', 'failed', 'blocked', 'canceled')
        `,
        [projectId]
      );
      const completeCount = attemptRows.filter((row) => {
        if (!row.context_snapshot_id || !row.cursor_json) return false;
        try {
          const cursor = JSON.parse(row.cursor_json) as OrchestratorContextSnapshotCursor;
          return Boolean(cursor.projectPackVersionId) && Array.isArray(cursor.docs) && cursor.docs.length > 0;
        } catch {
          return false;
        }
      }).length;
      const completenessRate = attemptRows.length > 0 ? completeCount / attemptRows.length : 0;
      gateEntries.push({
        key: "context_completeness_rate",
        label: "Context completeness rate for orchestrated steps",
        status:
          attemptRows.length === 0
            ? "warn"
            : completenessRate >= GATE_THRESHOLDS.minContextCompletenessRate
              ? "pass"
              : "fail",
        measuredValue: Number(completenessRate.toFixed(4)),
        threshold: GATE_THRESHOLDS.minContextCompletenessRate,
        comparator: ">=",
        samples: attemptRows.length,
        reasons:
          attemptRows.length === 0
            ? ["No orchestrator attempts exist yet."]
            : completenessRate >= GATE_THRESHOLDS.minContextCompletenessRate
              ? []
              : [`Only ${completeCount}/${attemptRows.length} attempts had context snapshots.`]
      });

      const runCount = Number(
        db.get<{ count: number }>("select count(*) as count from orchestrator_runs where project_id = ?", [projectId])?.count ?? 0
      );
      const insufficientRows = db.all<{
        run_id: string;
        error_message: string | null;
        metadata_json: string | null;
      }>(
        `
          select run_id, error_message, metadata_json
          from orchestrator_attempts
          where project_id = ?
            and status = 'blocked'
            and (
              error_message like '%insufficient%'
              or metadata_json like '%insufficient_context%'
              or metadata_json like '%insufficientContext%'
            )
        `,
        [projectId]
      );
      const blockedRunIds = new Set<string>();
      const reasonCodes = new Set<string>();
      for (const row of insufficientRows) {
        if (row.run_id) blockedRunIds.add(row.run_id);
        const metadata = parseJsonRecord(row.metadata_json);
        const rawCodes = Array.isArray(metadata?.reasonCodes)
          ? (metadata?.reasonCodes as unknown[])
          : Array.isArray(metadata?.insufficientReasons)
            ? (metadata?.insufficientReasons as unknown[])
            : [];
        for (const code of rawCodes) reasonCodes.add(String(code));
        if (typeof row.error_message === "string" && row.error_message.trim().length) {
          reasonCodes.add(row.error_message.trim());
        }
      }
      const blockedRate = runCount > 0 ? blockedRunIds.size / runCount : 0;
      gateEntries.push({
        key: "blocked_run_rate_insufficient_context",
        label: "Blocked-run rate due to insufficient context",
        status: runCount === 0 ? "warn" : blockedRate <= GATE_THRESHOLDS.maxBlockedInsufficientContextRate ? "pass" : "fail",
        measuredValue: Number(blockedRate.toFixed(4)),
        threshold: GATE_THRESHOLDS.maxBlockedInsufficientContextRate,
        comparator: "<=",
        samples: runCount,
        reasons:
          runCount === 0
            ? ["No orchestrator runs exist yet."]
            : blockedRate <= GATE_THRESHOLDS.maxBlockedInsufficientContextRate
              ? []
              : [`Blocked runs ${blockedRunIds.size}/${runCount} exceeded threshold.`],
        metadata: {
          reasonCodes: [...reasonCodes]
        }
      });

      const overallStatus: OrchestratorGateStatus = gateEntries.some((entry) => entry.status === "fail")
        ? "fail"
        : gateEntries.some((entry) => entry.status === "warn")
          ? "warn"
          : "pass";
      if (overallStatus !== "pass") {
        notes.push("Phase 1.5 quality gates are not fully passing.");
      }

      const report: OrchestratorGateReport = {
        id: randomUUID(),
        generatedAt: nowIso(),
        generatedBy: "deterministic_kernel",
        overallStatus,
        gates: gateEntries,
        notes
      };
      db.run(
        `
          insert into orchestrator_gate_reports(
            id,
            project_id,
            generated_at,
            report_json
          ) values (?, ?, ?, ?)
        `,
        [report.id, projectId, report.generatedAt, JSON.stringify(report)]
      );
      return report;
    },

    getLatestGateReport(args: { refresh?: boolean } = {}): OrchestratorGateReport {
      if (args.refresh === true) {
        return this.evaluateGateReport();
      }
      const latest = db.get<GateReportRow>(
        `
          select id, generated_at, report_json
          from orchestrator_gate_reports
          where project_id = ?
          order by generated_at desc
          limit 1
        `,
        [projectId]
      );
      const parsed = latest ? toGateReport(latest) : null;
      if (parsed) return parsed;
      return this.evaluateGateReport();
    },

    startRun(args: StartOrchestratorRunArgs): { run: OrchestratorRun; steps: OrchestratorStep[] } {
      const missionId = String(args.missionId ?? "").trim();
      if (!missionId) throw new Error("missionId is required.");
      const mission = db.get<{ id: string }>(
        `
          select id
          from missions
          where id = ?
            and project_id = ?
          limit 1
        `,
        [missionId, projectId]
      );
      if (!mission?.id) throw new Error(`Mission not found: ${missionId}`);

      const runId = String(args.runId ?? "").trim() || randomUUID();
      const profileId = normalizeProfileId(args.contextProfile);
      const createdAt = nowIso();
      const schedulerState = String(args.schedulerState ?? "initialized").trim() || "initialized";
      const rawMetadata = args.metadata ?? {};
      const phaseCards = resolveRunPhaseCardsFromMetadata(rawMetadata);
      const metadata: Record<string, unknown> = { ...rawMetadata };
      if (phaseCards && !asRecord(metadata.phaseRuntime)) {
        const phaseRuntime = buildInitialPhaseRuntime(phaseCards);
        if (phaseRuntime) metadata.phaseRuntime = phaseRuntime;
      }

      const byKey = new Map<string, string>();
      const dependencyStepKeysByStepKey = new Map<string, string[]>();
      const stepRows = [...args.steps]
        .sort((a, b) => a.stepIndex - b.stepIndex || a.stepKey.localeCompare(b.stepKey))
        .map((input, index) => {
          const id = randomUUID();
          const stepKey = input.stepKey.trim();
          if (!stepKey) throw new Error("stepKey is required for every orchestrator step.");
          if (byKey.has(stepKey)) throw new Error(`Duplicate stepKey in run: ${stepKey}`);
          byKey.set(stepKey, id);
          const dependencyStepKeys = normalizeDependencyStepKeys(input.dependencyStepKeys);
          dependencyStepKeysByStepKey.set(stepKey, dependencyStepKeys);
          return {
            id,
            input,
            createdAt,
            order: Number.isFinite(input.stepIndex) ? input.stepIndex : index,
            stepKey,
            dependencyStepKeys
          };
        });

      validateStepGraphIntegrity({
        context: "startRun",
        steps: stepRows.map(({ stepKey, dependencyStepKeys, input }) => ({
          stepKey,
          dependencyStepKeys,
          joinPolicy: normalizeJoinPolicy(String(input.joinPolicy ?? "all_success")),
          quorumCount: input.quorumCount != null ? Math.floor(Number(input.quorumCount)) : null
        }))
      });

      db.run(
        `
          insert into orchestrator_runs(
            id,
            project_id,
            mission_id,
            status,
            context_profile,
            scheduler_state,
            runtime_cursor_json,
            last_error,
            metadata_json,
            created_at,
            updated_at,
            started_at,
            completed_at
          ) values (?, ?, ?, 'queued', ?, ?, null, null, ?, ?, ?, null, null)
        `,
        [runId, projectId, missionId, profileId, schedulerState, JSON.stringify(metadata), createdAt, createdAt]
      );
      appendTimelineEvent({
        runId,
        eventType: "run_created",
        reason: "start_run",
        detail: {
          missionId,
          contextProfile: profileId,
          schedulerState
        }
      });

      for (const { id, input, createdAt: created, stepKey } of stepRows) {
        const policy: Record<string, unknown> = {
          ...(typeof input.policy?.docsMaxBytes === "number" ? { docsMaxBytes: Math.floor(input.policy.docsMaxBytes) } : {}),
          claimScopes: Array.isArray(input.policy?.claimScopes)
            ? input.policy?.claimScopes?.map((scope) => ({
                scopeKind: scope.scopeKind,
                scopeValue: scope.scopeValue,
                ...(typeof scope.ttlMs === "number" ? { ttlMs: Math.floor(scope.ttlMs) } : {})
              }))
            : []
        };
        const metadataJson = JSON.stringify({
          ...(input.metadata ?? {}),
          ...(input.executorKind ? { executorKind: input.executorKind } : {}),
          policy
        });
        db.run(
          `
            insert into orchestrator_steps(
              id,
              run_id,
              project_id,
              mission_step_id,
              step_key,
              step_index,
              title,
              lane_id,
              status,
              join_policy,
              quorum_count,
              dependency_step_ids_json,
              retry_limit,
              retry_count,
              last_attempt_id,
              policy_json,
              metadata_json,
              created_at,
              updated_at,
              started_at,
              completed_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, '[]', ?, 0, null, ?, ?, ?, ?, null, null)
          `,
          [
            id,
            runId,
            projectId,
            input.missionStepId ?? null,
            stepKey,
            Number.isFinite(input.stepIndex) ? Math.floor(input.stepIndex) : 0,
            input.title.trim() || stepKey,
            input.laneId ?? null,
            input.joinPolicy ?? "all_success",
            input.quorumCount ?? null,
            Math.max(0, Math.floor(input.retryLimit ?? 0)),
            JSON.stringify(policy),
            metadataJson,
            created,
            created
          ]
        );
        appendTimelineEvent({
          runId,
          stepId: id,
          eventType: "step_registered",
          reason: "start_run",
          detail: {
            stepKey,
            stepIndex: Number.isFinite(input.stepIndex) ? Math.floor(input.stepIndex) : 0,
            joinPolicy: input.joinPolicy ?? "all_success",
            retryLimit: Math.max(0, Math.floor(input.retryLimit ?? 0))
          }
        });
      }

      // Fill resolved dependency IDs after all step rows exist.
      for (const { id, stepKey } of stepRows) {
        const depKeys = dependencyStepKeysByStepKey.get(stepKey) ?? [];
        const depIds = depKeys.map((key) => {
          const depId = byKey.get(key);
          if (!depId) {
            throw new Error(`Unknown dependency stepKey '${key}' referenced by step '${stepKey}'.`);
          }
          return depId;
        });
        db.run(
          `
            update orchestrator_steps
            set dependency_step_ids_json = ?,
                updated_at = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [JSON.stringify(depIds), createdAt, id, runId, projectId]
        );
        appendTimelineEvent({
          runId,
          stepId: id,
          eventType: "step_dependencies_resolved",
          reason: "start_run",
          detail: {
            dependencyStepIds: depIds
          }
        });
      }

      const run = toRun(
        getRunRow(runId) ??
          ({
            id: runId,
            mission_id: missionId,
            project_id: projectId,
            status: "queued",
            context_profile: profileId,
            scheduler_state: schedulerState,
            runtime_cursor_json: null,
            last_error: null,
            metadata_json: JSON.stringify(metadata),
            created_at: createdAt,
            updated_at: createdAt,
            started_at: null,
            completed_at: null
          } satisfies RunRow)
      );

      this.tick({ runId });

      return {
        run,
        steps: listStepRows(runId).map(toStep)
      };
    },

    tick(args: { runId: string }): OrchestratorRun {
      const run = getRunRow(args.runId);
      if (!run) throw new Error(`Run not found: ${args.runId}`);
      const runStatus = normalizeRunStatus(run.status);
      if (TERMINAL_RUN_STATUSES.has(runStatus)) return toRun(run);
      // Paused runs (e.g. budget exceeded) should not auto-resume via tick
      if (runStatus === "paused") return toRun(run);
      // "completing" runs are awaiting explicit finalizeRun — tick should not interfere
      if (runStatus === "completing") return toRun(run);

      // ── Maintenance only: claim expiry + step readiness refresh ──
      expireClaims();
      refreshStepReadiness(args.runId);

      // Promote queued → bootstrapping (or active if no planning needed)
      const current = runStatus;
      if (current === "queued") {
        updateRunStatus(args.runId, "bootstrapping");
      }

      // tick() does NOT transition runs to terminal states.
      // Terminal transitions are exclusively via finalizeRun() or cancelRun().
      // However, tick still updates the timestamp for liveness tracking.
      db.run(
        `
          update orchestrator_runs
          set updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [nowIso(), args.runId, projectId]
      );

      appendTimelineEvent({
        runId: args.runId,
        eventType: "scheduler_tick",
        reason: "tick",
        detail: {
          fromStatus: current,
          maintenance: true
        }
      });

      const updated = getRunRow(args.runId);
      if (!updated) throw new Error(`Run not found after tick: ${args.runId}`);
      return toRun(updated);
    },

    heartbeatClaims(args: { attemptId: string; ownerId: string }): number {
      const now = nowIso();
      const runtimeConfig = getRuntimeConfig();
      const activeClaims = db.all<ClaimRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_id,
            owner_id,
            scope_kind,
            scope_value,
            state,
            acquired_at,
            heartbeat_at,
            expires_at,
            released_at,
            policy_json,
            metadata_json
          from orchestrator_claims
          where project_id = ?
            and attempt_id = ?
            and owner_id = ?
            and state = 'active'
        `,
        [projectId, args.attemptId, args.ownerId]
      );
      for (const claim of activeClaims) {
        const policy = parseJsonRecord(claim.policy_json) ?? {};
        const ttlMsRaw = Number(policy.ttlMs ?? runtimeConfig.workerHeartbeatTimeoutMs);
        const ttlMs =
          Number.isFinite(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : runtimeConfig.workerHeartbeatTimeoutMs;
        db.run(
          `
            update orchestrator_claims
            set heartbeat_at = ?,
                expires_at = ?
            where id = ?
              and project_id = ?
            and state = 'active'
          `,
          [now, new Date(Date.now() + ttlMs).toISOString(), claim.id, projectId]
        );
        appendTimelineEvent({
          runId: claim.run_id,
          stepId: claim.step_id,
          attemptId: claim.attempt_id,
          claimId: claim.id,
          eventType: "claim_heartbeat",
          reason: "heartbeat",
          detail: {
            ownerId: claim.owner_id,
            ttlMs
          }
        });
      }
      if (activeClaims.length) {
        emit({ type: "orchestrator-claim-updated", attemptId: args.attemptId, reason: "heartbeat" });
      }
      return activeClaims.length;
    },

    async startAttempt(args: {
      runId: string;
      stepId: string;
      ownerId: string;
      executorKind?: OrchestratorExecutorKind;
    }): Promise<OrchestratorAttempt> {
      const runtimeConfig = getRuntimeConfig();
      const runRow = getRunRow(args.runId);
      if (!runRow) throw new Error(`Run not found: ${args.runId}`);
      const stepRow = getStepRow(args.stepId);
      if (!stepRow || stepRow.run_id !== args.runId) throw new Error(`Step not found in run: ${args.stepId}`);

      const run = toRun(runRow);
      let step = toStep(stepRow);
      if (run.status === "paused") {
        throw new Error(`Cannot start attempt for run in status 'paused' (run ${run.id} is paused).`);
      }
      if (!runCanStartAttempts(run.status)) {
        throw new Error(`Cannot start attempt for run in status '${run.status}'.`);
      }
      if (step.status !== "ready") {
        throw new Error(`Step is not ready: ${step.id} (${step.status})`);
      }

      // ── Populate handoff summaries from predecessor worker digests ──
      if (step.dependencyStepIds.length > 0) {
        const HANDOFF_SUMMARY_MAX_CHARS = 500;
        const depIds = step.dependencyStepIds;
        const placeholders = depIds.map(() => "?").join(", ");

        // For each dependency step, get the latest succeeded/failed worker digest.
        // We use a subquery with ROW_NUMBER to pick the most recent digest per step.
        const digestRows = db.all<{
          step_id: string;
          step_key: string | null;
          status: string;
          summary: string;
          files_changed_json: string | null;
          tests_run_json: string | null;
        }>(
          `
            select d.step_id, d.step_key, d.status, d.summary, d.files_changed_json, d.tests_run_json
            from orchestrator_worker_digests d
            inner join (
              select step_id, max(created_at) as max_created
              from orchestrator_worker_digests
              where project_id = ?
                and mission_id = ?
                and run_id = ?
                and step_id in (${placeholders})
                and status in ('succeeded', 'failed')
              group by step_id
            ) latest on d.step_id = latest.step_id and d.created_at = latest.max_created
            where d.project_id = ?
              and d.mission_id = ?
              and d.run_id = ?
          `,
          [
            projectId, run.missionId, run.id,
            ...depIds,
            projectId, run.missionId, run.id
          ]
        );

        if (digestRows.length > 0) {
          const handoffSummaries: string[] = digestRows.map((row) => {
            const stepLabel = row.step_key ?? row.step_id.slice(0, 8);
            const status = String(row.status ?? "unknown").trim();
            const summaryText = clipText(String(row.summary ?? "").trim(), HANDOFF_SUMMARY_MAX_CHARS);

            const filesChanged: string[] = (() => {
              if (!row.files_changed_json) return [];
              try {
                const parsed = JSON.parse(row.files_changed_json);
                return Array.isArray(parsed) ? parsed.map((f: unknown) => String(f ?? "").trim()).filter(Boolean) : [];
              } catch { return []; }
            })();

            const testsRun: { passed?: number; failed?: number; skipped?: number; summary?: string | null } = (() => {
              if (!row.tests_run_json) return {};
              try {
                const parsed = JSON.parse(row.tests_run_json);
                return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
              } catch { return {}; }
            })();

            const parts: string[] = [`[${stepLabel}] (${status}) ${summaryText}`];

            if (filesChanged.length > 0) {
              const fileList = filesChanged.length <= 5
                ? filesChanged.join(", ")
                : `${filesChanged.slice(0, 5).join(", ")} (+${filesChanged.length - 5} more)`;
              parts.push(`Files: ${fileList}`);
            }

            const testPassed = Number(testsRun.passed ?? 0);
            const testFailed = Number(testsRun.failed ?? 0);
            const testSkipped = Number(testsRun.skipped ?? 0);
            if (testPassed > 0 || testFailed > 0 || testSkipped > 0) {
              const testParts: string[] = [];
              if (testPassed > 0) testParts.push(`${testPassed} passed`);
              if (testFailed > 0) testParts.push(`${testFailed} failed`);
              if (testSkipped > 0) testParts.push(`${testSkipped} skipped`);
              parts.push(`Tests: ${testParts.join(", ")}`);
            }

            return clipText(parts.join(" | "), HANDOFF_SUMMARY_MAX_CHARS);
          });

          // Persist updated metadata with handoff summaries so the adapter can read them
          const updatedMetadata = {
            ...(step.metadata ?? {}),
            handoffSummaries
          };
          db.run(
            `
              update orchestrator_steps
              set metadata_json = ?,
                  updated_at = ?
              where id = ?
                and run_id = ?
                and project_id = ?
            `,
            [JSON.stringify(updatedMetadata), nowIso(), step.id, run.id, projectId]
          );
          // Re-read the step so downstream code sees the updated metadata
          const refreshedStepRow = getStepRow(step.id);
          if (refreshedStepRow) {
            step = toStep(refreshedStepRow);
          }
        }
      }

      const attemptNumRow = db.get<{ max_attempt: number }>(
        `
          select max(attempt_number) as max_attempt
          from orchestrator_attempts
          where project_id = ?
            and step_id = ?
        `,
        [projectId, step.id]
      );
      const attemptNumber = Number(attemptNumRow?.max_attempt ?? 0) + 1;
      const attemptId = randomUUID();
      const createdAt = nowIso();
      const executorKind = normalizeExecutorKind(
        String(args.executorKind ?? step.metadata?.executorKind ?? "manual"),
      );
      const runMissionLaneId = run.missionId ? resolveRunMissionLaneId(run.metadata) : null;
      const registeredAdapter = adapters.get(executorKind) ?? null;
      const defaultAdapter = registeredAdapter ? null : defaultAdapterFor(executorKind);
      const requiresLaneId =
        executorKind !== "manual"
        && (registeredAdapter?.requiresLaneId === true || defaultAdapter?.requiresLaneId === true);
      if (!step.laneId) {
        if (runMissionLaneId && executorKind !== "manual") {
          throw new Error(
            `Mission step '${step.stepKey}' cannot start with executor '${executorKind}' because the dedicated mission lane is missing.`,
          );
        }
        if (requiresLaneId) {
          throw new Error(
            `Step '${step.stepKey}' cannot start with executor '${executorKind}' because laneId is missing.`,
          );
        }
      }
      const stepPolicy = resolveStepPolicy(step);
      const contextPolicy = resolveContextPolicy({ stepPolicy });

      // Insert the attempt row early so that all downstream tables with
      // foreign key(attempt_id) references orchestrator_attempts(id) —
      // including orchestrator_claims, orchestrator_timeline_events,
      // orchestrator_runtime_events, and mission_step_handoffs — can
      // reference it without FK constraint violations.
      // We start with status='running' and update to 'blocked' if claims fail,
      // and backfill context_snapshot_id after snapshot creation.
      db.run(
        `
          insert into orchestrator_attempts(
            id,
            run_id,
            step_id,
            project_id,
            attempt_number,
            status,
            executor_kind,
            executor_session_id,
            tracked_session_enforced,
            context_profile,
            context_snapshot_id,
            error_class,
            error_message,
            retry_backoff_ms,
            result_envelope_json,
            metadata_json,
            created_at,
            started_at,
            completed_at
          ) values (?, ?, ?, ?, ?, 'running', ?, null, 1, ?, null, 'none', null, 0, null, ?, ?, ?, null)
        `,
        [
          attemptId,
          run.id,
          step.id,
          projectId,
          attemptNumber,
          executorKind,
          contextPolicy.id,
          JSON.stringify({
            ownerId: args.ownerId,
            workerState: "initializing",
            workerStartedAt: createdAt
          }),
          createdAt,
          createdAt
        ]
      );

      // Claims are acquired before attempt state transitions so collisions are deterministic.
      const acquiredClaims: OrchestratorClaim[] = [];
      for (const scope of stepPolicy.claimScopes ?? []) {
        const normalizedScopeValue = normalizeClaimScopeValue({
          scopeKind: scope.scopeKind,
          scopeValue: scope.scopeValue
        });
        const failClaimStart = (failure: {
          errorMessage: string;
          detail: Record<string, unknown>;
          reason: string;
        }): OrchestratorAttempt => {
          releaseClaimsForAttempt({ attemptId, state: "released" });
          db.run(
            `
              update orchestrator_attempts
              set status = 'blocked',
                  error_class = 'claim_conflict',
                  error_message = ?,
                  metadata_json = ?,
                  completed_at = ?
              where id = ?
                and project_id = ?
            `,
            [
              failure.errorMessage,
              JSON.stringify({
                ownerId: args.ownerId,
                claimScope: {
                  scopeKind: scope.scopeKind,
                  scopeValue: normalizedScopeValue ?? scope.scopeValue,
                  ttlMs: scope.ttlMs
                },
                workerState: "disposed",
                claimConflict: failure.detail
              }),
              createdAt,
              attemptId,
              projectId
            ]
          );
          db.run(
            `
              update orchestrator_steps
              set status = 'blocked',
                  last_attempt_id = ?,
                  updated_at = ?
              where id = ?
                and run_id = ?
                and project_id = ?
            `,
            [attemptId, createdAt, step.id, run.id, projectId]
          );
          insertHandoff({
            missionId: run.missionId,
            missionStepId: step.missionStepId,
            runId: run.id,
            stepId: step.id,
            attemptId,
            handoffType: "attempt_blocked",
            producer: "orchestrator",
            payload: {
              reason: "claim_conflict",
              scopeKind: scope.scopeKind,
              scopeValue: normalizedScopeValue ?? scope.scopeValue,
              contextProfile: contextPolicy.id,
              ...failure.detail
            }
          });
          emit({ type: "orchestrator-attempt-updated", runId: run.id, stepId: step.id, attemptId, reason: "claim_blocked" });
          appendTimelineEvent({
            runId: run.id,
            stepId: step.id,
            attemptId,
            eventType: "attempt_blocked",
            reason: failure.reason,
            detail: {
              scopeKind: scope.scopeKind,
              scopeValue: normalizedScopeValue ?? scope.scopeValue,
              ...failure.detail
            }
          });
          persistRuntimeEvent({
            runId: run.id,
            stepId: step.id,
            attemptId,
            eventType: "claim_conflict",
            eventKey: `claim_conflict:${attemptId}:${scope.scopeKind}:${normalizedScopeValue ?? scope.scopeValue}`,
            occurredAt: createdAt,
            payload: {
              reason: failure.reason,
              scopeKind: scope.scopeKind,
              scopeValue: normalizedScopeValue ?? scope.scopeValue,
              ...failure.detail
            }
          });
          this.tick({ runId: run.id });
          const blockedRow = getAttemptRow(attemptId);
          if (!blockedRow) throw new Error("Failed to create blocked attempt.");
          return toAttempt(blockedRow);
        };

        if (!normalizedScopeValue) {
          return failClaimStart({
            errorMessage: `Invalid file reservation scope: ${scope.scopeValue}`,
            reason: "claim_scope_invalid",
            detail: {
              invalidScopeValue: scope.scopeValue
            }
          });
        }
        const existingConflict = findActiveClaimConflict({
          scopeKind: scope.scopeKind,
          scopeValue: normalizedScopeValue,
          ignoreAttemptId: attemptId
        });
        if (existingConflict) {
          return failClaimStart({
            errorMessage: `Claim collision for ${scope.scopeKind}:${normalizedScopeValue}`,
            reason: "claim_conflict",
            detail: {
              conflictingClaimId: existingConflict.conflict.id,
              conflictingRunId: existingConflict.conflict.run_id,
              conflictingStepId: existingConflict.conflict.step_id,
              conflictingAttemptId: existingConflict.conflict.attempt_id,
              conflictingScopeValue: existingConflict.conflict.scope_value,
              conflictReason: existingConflict.reason
            }
          });
        }
        const ttlMs = scope.ttlMs ?? runtimeConfig.workerHeartbeatTimeoutMs;
        const claim = acquireClaim({
          runId: run.id,
          stepId: step.id,
          attemptId,
          ownerId: args.ownerId.trim() || "orchestrator",
          scopeKind: scope.scopeKind,
          scopeValue: normalizedScopeValue,
          ttlMs,
          policy: { ttlMs }
        });
        if (!claim) {
          const postConflict = findActiveClaimConflict({
            scopeKind: scope.scopeKind,
            scopeValue: normalizedScopeValue,
            ignoreAttemptId: attemptId
          });
          return failClaimStart({
            errorMessage: `Claim collision for ${scope.scopeKind}:${normalizedScopeValue}`,
            reason: "claim_conflict",
            detail: postConflict
              ? {
                  conflictingClaimId: postConflict.conflict.id,
                  conflictingRunId: postConflict.conflict.run_id,
                  conflictingStepId: postConflict.conflict.step_id,
                  conflictingAttemptId: postConflict.conflict.attempt_id,
                  conflictingScopeValue: postConflict.conflict.scope_value,
                  conflictReason: postConflict.reason
                }
              : {}
          });
        }
        acquiredClaims.push(claim);
      }

      // (Attempt row already inserted above at the early-insert site for FK satisfaction.)

      // Budget guard: check total token budget before dispatching
      const tokensConsumed = Number(run.metadata?.tokensConsumed ?? 0);
      if (runtimeConfig.maxTotalTokenBudget != null && tokensConsumed >= runtimeConfig.maxTotalTokenBudget) {
        releaseClaimsForAttempt({ attemptId, state: "released" });
        updateRunStatus(run.id, "paused", {
          last_error: `Total token budget exceeded: ${tokensConsumed} >= ${runtimeConfig.maxTotalTokenBudget}`
        });
        appendTimelineEvent({
          runId: run.id,
          stepId: step.id,
          attemptId,
          eventType: "budget_exceeded",
          reason: "total_budget_limit",
          detail: {
            tokensConsumed,
            maxTotalTokenBudget: runtimeConfig.maxTotalTokenBudget
          }
        });
        throw new Error(`Total token budget exceeded: ${tokensConsumed} >= ${runtimeConfig.maxTotalTokenBudget}`);
      }

      const snapshot = await createContextSnapshotForAttempt({
        run,
        step,
        attemptId,
        contextProfile: contextPolicy
      });

      // Update attempt with the resolved snapshot id and full metadata
      db.run(
        `
          update orchestrator_attempts
          set context_snapshot_id = ?,
              metadata_json = ?
          where id = ?
            and project_id = ?
        `,
        [
          snapshot.snapshotId,
          JSON.stringify({
            ownerId: args.ownerId,
            docsMode: contextPolicy.docsMode,
            docsCount: snapshot.docsRefs.length,
            workerState: "initializing",
            workerStartedAt: createdAt
          }),
          attemptId,
          projectId
        ]
      );

      db.run(
        `
          update orchestrator_steps
          set status = 'running',
              last_attempt_id = ?,
              updated_at = ?,
              started_at = coalesce(started_at, ?)
          where id = ?
            and run_id = ?
            and project_id = ?
        `,
        [attemptId, createdAt, createdAt, step.id, run.id, projectId]
      );

      insertHandoff({
        missionId: run.missionId,
        missionStepId: step.missionStepId,
        runId: run.id,
        stepId: step.id,
        attemptId,
        handoffType: "attempt_started",
        producer: "orchestrator",
        payload: {
          contextProfile: contextPolicy.id,
          contextSnapshotId: snapshot.snapshotId,
          docsMode: contextPolicy.docsMode,
          docsRefs: snapshot.docsRefs,
          laneExportLevel: snapshot.laneExport?.level ?? null,
          projectExportLevel: snapshot.projectExport.level,
          claims: acquiredClaims.map((claim) => ({
            id: claim.id,
            scopeKind: claim.scopeKind,
            scopeValue: claim.scopeValue,
            expiresAt: claim.expiresAt
          }))
        }
      });

      emit({ type: "orchestrator-step-updated", runId: run.id, stepId: step.id, reason: "attempt_started" });
      emit({ type: "orchestrator-attempt-updated", runId: run.id, stepId: step.id, attemptId, reason: "started" });
      appendTimelineEvent({
        runId: run.id,
        stepId: step.id,
        attemptId,
        eventType: "attempt_started",
        reason: "attempt_started",
        detail: {
          executorKind,
          contextProfile: contextPolicy.id,
          contextSnapshotId: snapshot.snapshotId,
          workerState: "initializing"
        }
      });

      const attemptRow = getAttemptRow(attemptId);
      if (!attemptRow) throw new Error("Attempt creation failed.");
      const attempt = toAttempt(attemptRow);
      const completeAndAdvance = async (completeArgs: {
        attemptId: string;
        status: Extract<OrchestratorAttemptStatus, "succeeded" | "failed" | "blocked" | "canceled">;
        result?: OrchestratorAttemptResultEnvelope;
        errorClass?: OrchestratorErrorClass;
        errorMessage?: string;
        metadata?: Record<string, unknown> | null;
      }): Promise<OrchestratorAttempt> => {
        const completedAttempt = await this.completeAttempt(completeArgs);
        await this.startReadyAutopilotAttempts({
          runId: run.id,
          reason: "attempt_completed_inline"
        });
        return completedAttempt;
      };

      const integrationResult = await tryRunConflictResolverChain({
        run,
        step,
        attempt
      });
      if (integrationResult) {
        return completeAndAdvance({
          attemptId: attempt.id,
          status: integrationResult.status,
          result: integrationResult.result,
          errorClass: integrationResult.errorClass,
          errorMessage: integrationResult.errorMessage,
          metadata: integrationResult.metadata ?? null
        });
      }

      const mergeResult = await tryRunMergePrAutomation({
        run,
        step,
        attempt
      });
      if (mergeResult) {
        return completeAndAdvance({
          attemptId: attempt.id,
          status: mergeResult.status,
          result: mergeResult.result,
          errorClass: mergeResult.errorClass,
          errorMessage: mergeResult.errorMessage,
          metadata: mergeResult.metadata ?? null
        });
      }

      let unifiedStepModelId: string | null = null;
      if (executorKind === "unified") {
        const stepModelRaw = typeof step.metadata?.modelId === "string" ? step.metadata.modelId.trim() : "";
        const phaseModel = asRecord(step.metadata?.phaseModel);
        const phaseModelIdRaw = typeof phaseModel?.modelId === "string" ? phaseModel.modelId.trim() : "";
        const runMeta = asRecord(run.metadata);
        const phaseRuntime = asRecord(runMeta?.phaseRuntime);
        const runtimePhaseModel = asRecord(phaseRuntime?.currentPhaseModel);
        const runtimePhaseModelIdRaw = typeof runtimePhaseModel?.modelId === "string" ? runtimePhaseModel.modelId.trim() : "";
        const unifiedModelRef = stepModelRaw || phaseModelIdRaw || runtimePhaseModelIdRaw;
        if (!unifiedModelRef.length) {
          appendTimelineEvent({
            runId: run.id,
            stepId: step.id,
            attemptId: attempt.id,
            eventType: "execution_path_unsupported",
            reason: "unified_model_missing",
            detail: {
              executorKind,
              message: `Step '${step.stepKey}' is missing required metadata.modelId (and no phase model is available).`
            }
          });
          return completeAndAdvance({
            attemptId: attempt.id,
            status: "failed",
            errorClass: "policy",
            errorMessage: `Step '${step.stepKey}' is missing required metadata.modelId.`,
            metadata: {
              executorKind,
              adapterState: "model_id_missing"
            }
          });
        }
        const descriptor = resolveModelDescriptor(unifiedModelRef);
        unifiedStepModelId = descriptor?.id ?? null;
        const executionPath = descriptor ? classifyWorkerExecutionPath(descriptor) : "api";
        if (!descriptor) {
          appendTimelineEvent({
            runId: run.id,
            stepId: step.id,
            attemptId: attempt.id,
            eventType: "execution_path_unsupported",
            reason: "unified_model_unregistered",
            detail: {
              executorKind,
              modelId: unifiedModelRef,
              message: `Model '${unifiedModelRef}' is not registered.`
            }
          });
          return completeAndAdvance({
            attemptId: attempt.id,
            status: "failed",
            errorClass: "policy",
            errorMessage: `Model '${unifiedModelRef}' is not registered.`,
            metadata: {
              executorKind,
              adapterState: "model_not_registered",
              modelId: unifiedModelRef
            }
          });
        }

        // API/local models execute in-process and complete attempts directly.
        if (executionPath !== "cli") {
          if (!aiIntegrationService) {
            return completeAndAdvance({
              attemptId: attempt.id,
              status: "failed",
              errorClass: "executor_failure",
              errorMessage: "AI integration service is unavailable for in-process worker execution.",
              metadata: {
                executorKind,
                modelId: descriptor.id,
                executionPath,
                adapterState: "in_process_unavailable",
              }
            });
          }

          // Resolve lane worktree path BEFORE building the prompt so the constraint
          // can be injected into the worker prompt via step.metadata.laneWorktreePath.
          const laneWorktreePath = (() => {
            if (!step.laneId) return runMissionLaneId ? null : projectRoot;
            const row = db.get<{ worktree_path: string | null }>(
              `select worktree_path from lanes where id = ? and project_id = ? limit 1`,
              [step.laneId, projectId],
            );
            const worktree = typeof row?.worktree_path === "string" ? row.worktree_path.trim() : "";
            return worktree.length > 0 ? worktree : null;
          })();

          if (!laneWorktreePath) {
            const errorMsg = runMissionLaneId
              ? `Mission step '${step.stepKey}' cannot start without the dedicated mission lane/worktree.`
              : `Lane '${step.laneId}' has no worktree_path configured. Cannot start worker for step '${step.stepKey}' without a valid worktree.`;
            appendTimelineEvent({
              runId: run.id,
              stepId: step.id,
              attemptId: attempt.id,
              eventType: "worker_failed",
              reason: "worktree_configuration_error",
              detail: {
                executorKind,
                modelId: descriptor.id,
                executionPath,
                laneId: step.laneId ?? null,
                error: errorMsg,
              }
            });
            return completeAndAdvance({
              attemptId: attempt.id,
              status: "failed",
              errorClass: "configuration_error",
              errorMessage: errorMsg,
              metadata: {
                executorKind,
                modelId: descriptor.id,
                executionPath,
                adapterState: "worktree_path_missing",
                laneId: step.laneId,
              }
            });
          }

          const resolvedCwd = laneWorktreePath ?? projectRoot;

          // Inject laneWorktreePath into step metadata for the prompt builder
          const stepWithWorktree: typeof step = step.laneId && laneWorktreePath
            ? {
                ...step,
                metadata: {
                  ...(step.metadata ?? {}),
                  laneWorktreePath,
                },
              }
            : step;

          const allSteps = listStepRows(run.id).map(toStep);
          const briefingFilePatterns = Array.isArray(stepWithWorktree.metadata?.fileScopes)
            ? stepWithWorktree.metadata.fileScopes.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
            : [];
          const employeeAgentId =
            typeof run.metadata?.employeeAgentId === "string" && run.metadata.employeeAgentId.trim().length > 0
              ? run.metadata.employeeAgentId.trim()
              : null;
          const memoryBriefing = memoryBriefingService
            ? await memoryBriefingService.buildBriefing({
                projectId,
                missionId: run.missionId,
                runId: run.id,
                ...(employeeAgentId ? { agentId: employeeAgentId, includeAgentMemory: true } : {}),
                taskDescription: stepWithWorktree.title,
                phaseContext: typeof stepWithWorktree.metadata?.phaseInstructions === "string"
                  ? stepWithWorktree.metadata.phaseInstructions
                  : typeof stepWithWorktree.metadata?.instructions === "string"
                    ? stepWithWorktree.metadata.instructions
                    : null,
                handoffSummaries: Array.isArray(stepWithWorktree.metadata?.handoffSummaries)
                  ? stepWithWorktree.metadata.handoffSummaries.map((entry) => String(entry ?? ""))
                  : [],
                filePatterns: briefingFilePatterns,
                mode: "mission_worker",
              })
            : null;
          persistUsedProcedureIds(run.id, memoryBriefing?.usedProcedureIds);
          const promptPack = buildFullPrompt(
            {
              run,
              step: stepWithWorktree,
              attempt,
              allSteps,
              contextProfile: contextPolicy,
              laneExport: snapshot.laneExport,
              projectExport: snapshot.projectExport,
              docsRefs: snapshot.docsRefs,
              fullDocs: snapshot.fullDocs,
              createTrackedSession: async () => {
                throw new Error("In-process execution does not create tracked terminal sessions.");
              },
              ...(memoryBriefing ? { memoryBriefing } : {}),
            },
            "unified",
            memoryService
              ? { memoryService, projectId, workerRuntime: "in_process", memoryBriefing }
              : { projectId, workerRuntime: "in_process" },
          );

          const stepType = String(step.metadata?.stepType ?? step.metadata?.taskType ?? "").trim().toLowerCase();
          const taskType: import("../ai/aiIntegrationService").AiTaskType =
            stepType === "analysis" || stepType === "planning"
              ? "planning"
              : stepType === "review" || stepType === "test_review" || stepType === "review_test"
                ? "review"
                : stepType === "conflict" || stepType === "conflict_resolution"
                  ? "conflict_resolution"
                  : "implementation";

          const reasoningEffort = (() => {
            const fromMeta = typeof step.metadata?.reasoningEffort === "string" ? step.metadata.reasoningEffort.trim() : "";
            if (fromMeta.length > 0) return fromMeta;
            const fromPhase = typeof phaseModel?.thinkingLevel === "string" ? phaseModel.thinkingLevel.trim() : "";
            return fromPhase.length > 0 ? fromPhase : undefined;
          })();

          const timeoutMs = Number.isFinite(Number(step.metadata?.timeoutMs))
            ? Math.max(1_000, Math.floor(Number(step.metadata?.timeoutMs)))
            : runtimeConfig.stepTimeoutDefaultMs;

          const requiresPlanApproval =
            step.metadata?.requiresPlanApproval === true || step.metadata?.coordinationPattern === "plan_then_implement";
          const readOnlyExecution = step.metadata?.readOnlyExecution === true || requiresPlanApproval;

          // Resolve in-process permission from project + mission config
          const inProcessPermissionMode: "read-only" | "edit" | "full-auto" = (() => {
            if (readOnlyExecution) return "read-only" as const;
            // Build unified provider permissions for this mission
            const projPerms: MissionPermissionConfig = {};
            const aiCfg = asRecord(projectConfigService?.get()?.effective?.ai);
            const perms = asRecord(aiCfg?.permissions);
            if (perms) {
              const ip = asRecord(perms.inProcess);
              if (ip) {
                const m = typeof ip.mode === "string" ? ip.mode : "";
                if (m === "plan" || m === "edit" || m === "full-auto") projPerms.inProcess = { mode: m };
              }
            }
            let providers = normalizeMissionPermissions(projPerms);
            if (run.missionId) {
              try {
                const mRow = db.get<{ metadata_json: string | null }>(
                  `select metadata_json from missions where id = ? and project_id = ? limit 1`,
                  [run.missionId, projectId]
                );
                if (mRow?.metadata_json) {
                  const meta = asRecord(JSON.parse(mRow.metadata_json));
                  const mpc = asRecord(asRecord(meta?.launch)?.permissionConfig) as MissionPermissionConfig | undefined;
                  if (mpc) {
                    const mp = normalizeMissionPermissions(mpc);
                    providers = { ...providers, ...mp };
                  }
                }
              } catch { /* non-critical */ }
            }
            return mapPermissionToInProcess(providers.unified);
          })();

          try {
            const aiResult = await aiIntegrationService.executeViaUnified({
              feature: "orchestrator",
              taskType,
              prompt: promptPack.prompt,
              cwd: resolvedCwd,
              model: descriptor.id,
              ...(reasoningEffort ? { reasoningEffort } : {}),
              timeoutMs,
              permissionMode: inProcessPermissionMode,
              oneShot: true,
              projectId,
              runId: run.id,
              stepId: step.id,
              attemptId: attempt.id,
              ...(memoryService ? { memoryService } : {}),
            });

            appendTimelineEvent({
              runId: run.id,
              stepId: step.id,
              attemptId: attempt.id,
              eventType: "worker_started",
              reason: "in_process_worker_started",
              detail: {
                executorKind,
                modelId: descriptor.id,
                executionPath,
                workerState: "running"
              }
            });

            const summary = aiResult.text.trim().length > 0
              ? clipText(aiResult.text, 1_500)
              : `Completed ${taskType} step with ${descriptor.displayName}.`;
            return completeAndAdvance({
              attemptId: attempt.id,
              status: "succeeded",
              result: normalizeEnvelope({
                success: true,
                summary,
                outputs: {
                  text: aiResult.text,
                  structuredOutput: aiResult.structuredOutput ?? null,
                  modelId: descriptor.id,
                  executionPath,
                },
                warnings: [],
                sessionId: aiResult.sessionId,
                trackedSession: false
              }),
              metadata: {
                executorKind,
                modelId: descriptor.id,
                executionPath,
                adapterState: "in_process_completed",
                promptLength: promptPack.prompt.length,
                steeringDirectiveCount: promptPack.steeringDirectiveCount,
              }
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            appendTimelineEvent({
              runId: run.id,
              stepId: step.id,
              attemptId: attempt.id,
              eventType: "worker_failed",
              reason: "in_process_worker_failed",
              detail: {
                executorKind,
                modelId: descriptor.id,
                executionPath,
                error: errorMessage
              }
            });
            return completeAndAdvance({
              attemptId: attempt.id,
              status: "failed",
              errorClass: "executor_failure",
              errorMessage,
              metadata: {
                executorKind,
                modelId: descriptor.id,
                executionPath,
                adapterState: "in_process_failed",
              }
            });
          }
        }
      }

      const adapter = registeredAdapter ?? defaultAdapter;
      if (adapter) {
        // Build unified permission config: project-level → mission-level override.
        // Both old (cli/inProcess) and new (providers) shapes are normalized through
        // the same `normalizeMissionPermissions` pipeline.
        const permissionConfig = (() => {
          // 1. Start with project-level permission config (old shape from config file)
          const projectPerms: MissionPermissionConfig = {};
          const snapshot = projectConfigService?.get();
          const ai = asRecord(snapshot?.effective?.ai);
          const permissions = asRecord(ai?.permissions);
          if (permissions) {
            const cli = asRecord(permissions.cli);
            const inProc = asRecord(permissions.inProcess);
            if (cli) {
              projectPerms.cli = {
                ...(typeof cli.mode === "string" ? { mode: cli.mode as MissionPermissionConfig["cli"] extends { mode?: infer M } ? M : never } : {}),
                ...(typeof cli.sandboxPermissions === "string" ? { sandboxPermissions: cli.sandboxPermissions as "read-only" | "workspace-write" | "danger-full-access" } : {}),
                ...(Array.isArray(cli.writablePaths) ? { writablePaths: cli.writablePaths.filter((e): e is string => typeof e === "string").map(e => e.trim()).filter(e => e.length > 0) } : {}),
                ...(Array.isArray(cli.allowedTools) ? { allowedTools: cli.allowedTools.filter((e): e is string => typeof e === "string").map(e => e.trim()).filter(e => e.length > 0) } : {}),
              };
            }
            if (inProc) {
              const mode = typeof inProc.mode === "string" ? inProc.mode : "";
              if (mode === "plan" || mode === "edit" || mode === "full-auto") {
                projectPerms.inProcess = { mode };
              }
            }
          }

          // Normalize project-level to unified provider shape
          let providers = normalizeMissionPermissions(projectPerms);

          // 2. Layer mission-level overrides if present
          if (run.missionId) {
            try {
              const missionRow = db.get<{ metadata_json: string | null }>(
                `select metadata_json from missions where id = ? and project_id = ? limit 1`,
                [run.missionId, projectId]
              );
              if (missionRow?.metadata_json) {
                const meta = asRecord(JSON.parse(missionRow.metadata_json));
                const missionPermConfig = asRecord(asRecord(meta?.launch)?.permissionConfig) as MissionPermissionConfig | undefined;
                if (missionPermConfig) {
                  // Re-normalize with mission overrides applied on top.
                  // normalizeMissionPermissions handles both old (cli/inProcess) and new (providers) shapes.
                  const missionProviders = normalizeMissionPermissions(missionPermConfig);
                  // Merge: mission-level overrides take precedence
                  providers = { ...providers, ...missionProviders };
                }
              }
            } catch {
              // Non-critical: fall back to project-level permissions
            }
          }

          // 3. Convert back to legacy shape for adapter compatibility, carrying _providers through
          return providerPermissionsToLegacyConfig(providers);
        })();

        // Recovery-aware retry: read checkpoint and previous attempt data when retrying
        const recoveryContext = await (async (): Promise<{ previousCheckpoint?: string; previousAttemptSummary?: string }> => {
          if (attemptNumber <= 1) return {};
          const result: { previousCheckpoint?: string; previousAttemptSummary?: string } = {};

          // 1. Read checkpoint file from the lane worktree if available, fall back to DB
          if (step.laneId) {
            const laneRow = db.get<{ worktree_path: string | null }>(
              `select worktree_path from lanes where id = ? and project_id = ? limit 1`,
              [step.laneId, projectId]
            );
            const worktreePath = typeof laneRow?.worktree_path === "string" && laneRow.worktree_path.trim().length
              ? laneRow.worktree_path.trim()
              : null;
            if (worktreePath) {
              const checkpointPath = getWorkerCheckpointPath(worktreePath, step.stepKey);
              try {
                const content = fs.readFileSync(checkpointPath, "utf8");
                if (content.trim().length > 0) {
                  // Cap checkpoint content to avoid oversized prompts
                  result.previousCheckpoint = content.length > 12_000
                    ? content.slice(0, 12_000) + "\n\n[checkpoint truncated]"
                    : content;
                }
              } catch {
                // File does not exist or is unreadable — continue to DB fallback.
              }
            }
          }

          // 1b. Fall back to DB-persisted checkpoint if filesystem read did not yield one
          if (!result.previousCheckpoint) {
            const dbCheckpoint = this.getWorkerCheckpoint({ missionId: run.missionId, stepKey: step.stepKey });
            if (dbCheckpoint && dbCheckpoint.content.trim().length > 0) {
              result.previousCheckpoint = dbCheckpoint.content.length > 12_000
                ? dbCheckpoint.content.slice(0, 12_000) + "\n\n[checkpoint truncated]"
                : dbCheckpoint.content;
            }
          }

          // 2. Gather summary from the most recent previous attempt on this step
          const prevAttemptRow = db.get<{ result_envelope_json: string | null; error_message: string | null; status: string | null }>(
            `
              select result_envelope_json, error_message, status
              from orchestrator_attempts
              where project_id = ?
                and step_id = ?
                and attempt_number = ?
              limit 1
            `,
            [projectId, step.id, attemptNumber - 1]
          );
          if (prevAttemptRow) {
            const parts: string[] = [];
            const prevStatus = prevAttemptRow.status ?? "unknown";
            parts.push(`Previous attempt status: ${prevStatus}`);
            if (prevAttemptRow.error_message) {
              parts.push(`Error: ${prevAttemptRow.error_message}`);
            }
            if (prevAttemptRow.result_envelope_json) {
              try {
                const envelope = JSON.parse(prevAttemptRow.result_envelope_json) as Record<string, unknown>;
                const summary = typeof envelope.summary === "string" ? envelope.summary.trim() : "";
                if (summary.length > 0) {
                  parts.push(`Summary: ${summary}`);
                }
                const warnings = Array.isArray(envelope.warnings)
                  ? (envelope.warnings as unknown[]).map((w) => String(w ?? "").trim()).filter(Boolean)
                  : [];
                if (warnings.length > 0) {
                  parts.push(`Warnings: ${warnings.join("; ")}`);
                }
              } catch {
                // malformed envelope — skip
              }
            }
            if (parts.length > 0) {
              result.previousAttemptSummary = parts.join("\n");
            }
          }

          return result;
        })();

        const allSteps = listStepRows(run.id).map(toStep);

        // Resolve lane worktree path for CLI adapter prompt injection
        const cliLaneWorktreePath = (() => {
          if (!step.laneId) return null;
          const row = db.get<{ worktree_path: string | null }>(
            `select worktree_path from lanes where id = ? and project_id = ? limit 1`,
            [step.laneId, projectId],
          );
          const wt = typeof row?.worktree_path === "string" ? row.worktree_path.trim() : "";
          return wt.length > 0 ? wt : null;
        })();

        if (cliLaneWorktreePath) {
          try {
            fs.mkdirSync(path.join(cliLaneWorktreePath, ".ade", "plans"), { recursive: true });
            fs.mkdirSync(path.join(cliLaneWorktreePath, ".ade", "checkpoints"), { recursive: true });
          } catch {
            // Directory creation is best-effort. Worker prompts still instruct
            // the model to create the directories if needed.
          }
        }

        const stepForExecutor = (() => {
          let s = step;
          if (unifiedStepModelId && !(typeof step.metadata?.modelId === "string" && step.metadata.modelId.trim().length > 0)) {
            s = {
              ...s,
              metadata: {
                ...(s.metadata ?? {}),
                modelId: unifiedStepModelId,
              }
            } satisfies OrchestratorStep;
          }
          if (cliLaneWorktreePath) {
            s = {
              ...s,
              metadata: {
                ...(s.metadata ?? {}),
                laneWorktreePath: cliLaneWorktreePath,
              }
            } satisfies OrchestratorStep;
          }
          return s;
        })();
        const employeeAgentId =
          typeof run.metadata?.employeeAgentId === "string" && run.metadata.employeeAgentId.trim().length > 0
            ? run.metadata.employeeAgentId.trim()
            : null;
        const memoryBriefing = memoryBriefingService
          ? await memoryBriefingService.buildBriefing({
              projectId,
              missionId: run.missionId,
              runId: run.id,
              ...(employeeAgentId ? { agentId: employeeAgentId, includeAgentMemory: true } : {}),
              taskDescription: stepForExecutor.title,
              phaseContext: typeof stepForExecutor.metadata?.phaseInstructions === "string"
                ? stepForExecutor.metadata.phaseInstructions
                : typeof stepForExecutor.metadata?.instructions === "string"
                  ? stepForExecutor.metadata.instructions
                  : null,
              handoffSummaries: Array.isArray(stepForExecutor.metadata?.handoffSummaries)
                ? stepForExecutor.metadata.handoffSummaries.map((entry) => String(entry ?? ""))
                : [],
              filePatterns: Array.isArray(stepForExecutor.metadata?.fileScopes)
                ? stepForExecutor.metadata.fileScopes.map((entry) => String(entry ?? ""))
                : [],
              mode: "mission_worker",
            })
          : null;
        persistUsedProcedureIds(run.id, memoryBriefing?.usedProcedureIds);
        const result = await adapter.start({
          run,
          step: stepForExecutor,
          attempt,
          allSteps,
          contextProfile: contextPolicy,
          laneExport: snapshot.laneExport,
          projectExport: snapshot.projectExport,
          docsRefs: snapshot.docsRefs,
          fullDocs: snapshot.fullDocs,
          createTrackedSession: (sessionArgs) =>
            this.createOrchestratedSession({
              ...sessionArgs,
              tracked: true
            }),
          permissionConfig,
          ...recoveryContext,
          ...(memoryBriefing ? { memoryBriefing } : {}),
          ...(memoryService ? { memoryService, memoryProjectId: projectId } : {})
        });
        if (result.status === "accepted") {
          const sessionId = typeof result.sessionId === "string" ? result.sessionId.trim() : "";
          const managedLaunch = result.launch ?? null;
          const attachedWorkerState = managedLaunch ? "initializing" : "working";
          if (sessionId) {
            const sessionRow = db.get<{ transcript_path: string | null }>(
              `
                select transcript_path
                from terminal_sessions
                where id = ?
                limit 1
              `,
              [sessionId]
            );
            if (!sessionRow) {
              appendTimelineEvent({
                runId: run.id,
                stepId: step.id,
                attemptId: attempt.id,
                eventType: "executor_session_missing",
                reason: "session_row_not_found",
                detail: {
                  executorKind,
                  sessionId,
                  workerState: "error"
                }
              });
              return completeAndAdvance({
                attemptId: attempt.id,
                status: "failed",
                errorClass: "executor_failure",
                errorMessage: `Session row not found for accepted session: ${sessionId}`
              });
            }
            db.run(
              `
                update orchestrator_attempts
                set executor_session_id = ?,
                    metadata_json = ?
                where id = ?
                  and project_id = ?
              `,
              [
                sessionId,
                JSON.stringify({
                  ...(attempt.metadata ?? {}),
                  ...(result.metadata ?? {}),
                  transcriptPath: sessionRow?.transcript_path ?? null,
                  workerState: attachedWorkerState,
                  workerSessionAttachedAt: nowIso()
                }),
                attempt.id,
                projectId
              ]
            );
            emit({ type: "orchestrator-attempt-updated", runId: run.id, stepId: step.id, attemptId: attempt.id, reason: "session_attached" });
            appendTimelineEvent({
              runId: run.id,
              stepId: step.id,
              attemptId: attempt.id,
              eventType: "executor_session_attached",
              reason: "adapter_accepted",
              detail: {
                executorKind,
                sessionId,
                transcriptPath: sessionRow?.transcript_path ?? null,
                workerState: attachedWorkerState
              }
            });
          }

          if (sessionId && managedLaunch && agentChatService) {
            void (async () => {
              try {
                await agentChatService.sendMessage({
                  sessionId,
                  text: managedLaunch.prompt,
                  displayText: managedLaunch.displayText,
                  ...(managedLaunch.reasoningEffort ? { reasoningEffort: managedLaunch.reasoningEffort } : {}),
                  ...(managedLaunch.executionMode ? { executionMode: managedLaunch.executionMode } : {}),
                });
                const currentAttemptRow = getAttemptRow(attempt.id);
                if (!currentAttemptRow || currentAttemptRow.status !== "running") return;
                const currentStep = getStepRow(step.id);
                const currentStepMetadata = asRecord(toStep(currentStep ?? stepRow).metadata) ?? {};
                const attemptMetadata = parseJsonRecord(currentAttemptRow.metadata_json);
                const transcriptPath =
                  typeof attemptMetadata?.transcriptPath === "string"
                    ? attemptMetadata.transcriptPath.trim()
                    : "";
                const transcriptAnalysis = analyzeTranscriptFromPath(transcriptPath);
                const hasStructuredResult = asRecord(currentStepMetadata.lastResultReport) != null;
                const silentFailure = hasStructuredResult
                  ? null
                  : classifySilentWorkerExit({
                      stepMetadata: currentStepMetadata,
                      transcriptSummary: transcriptAnalysis.summary,
                      hasMaterialOutput: transcriptAnalysis.hasMaterialOutput,
                      hasLifecycleActivity: transcriptAnalysis.hasLifecycleActivity,
                    });
                if (silentFailure) {
                  await this.completeAttempt({
                    attemptId: attempt.id,
                    status: "failed",
                    errorClass: silentFailure.errorClass,
                    errorMessage: silentFailure.errorMessage,
                  });
                } else {
                  await this.completeAttempt({
                    attemptId: attempt.id,
                    status: "succeeded",
                  });
                }
              } catch (error) {
                const currentAttemptRow = getAttemptRow(attempt.id);
                if (!currentAttemptRow || currentAttemptRow.status !== "running") return;
                const currentStep = getStepRow(step.id);
                const currentStepMetadata = asRecord(toStep(currentStep ?? stepRow).metadata) ?? {};
                const attemptMetadata = parseJsonRecord(currentAttemptRow.metadata_json);
                const transcriptPath =
                  typeof attemptMetadata?.transcriptPath === "string"
                    ? attemptMetadata.transcriptPath.trim()
                    : "";
                const transcriptAnalysis = analyzeTranscriptFromPath(transcriptPath);
                const errorText = error instanceof Error ? error.message : String(error);
                const silentFailure = classifySilentWorkerExit({
                  stepMetadata: currentStepMetadata,
                  transcriptSummary: transcriptAnalysis.summary,
                  hasMaterialOutput: transcriptAnalysis.hasMaterialOutput,
                  hasLifecycleActivity: transcriptAnalysis.hasLifecycleActivity,
                });
                await this.completeAttempt({
                  attemptId: attempt.id,
                  status: "failed",
                  errorClass: silentFailure?.errorClass ?? "executor_failure",
                  errorMessage: silentFailure?.errorMessage ?? errorText,
                });
              } finally {
                try {
                  await agentChatService.dispose({ sessionId });
                } catch {
                  // Ignore disposal failures — tracked session reconciliation is best-effort here.
                }
              }
            })();
          }

          // ── Critical fix: trigger autopilot pass for OTHER ready steps ──
          // The "accepted" status means this step is now running (not complete),
          // so we must NOT call completeAndAdvance. But we DO need to kick off
          // a new autopilot cycle so sibling steps that are ready can start.
          const acceptedAttemptRunId = run.id;
          const acceptedAttemptId = attempt.id;
          const acceptedSessionId = sessionId;
          // 200ms delay allows the current autopilot pass to finish and release
          // `autopilotRunLocks`. The lock guards against re-entrance: if the
          // current pass hasn't released yet, the deferred call returns 0
          // immediately (reason "accepted_step_advance" does NOT wait on the
          // lock, unlike "initial_ramp_up"). 200ms (up from 50ms) ensures the
          // initial pass has time to complete even when spawning multiple PTY
          // sessions, so the deferred call reliably picks up remaining siblings.
          setTimeout(() => {
            void this.startReadyAutopilotAttempts({
              runId: acceptedAttemptRunId,
              reason: "accepted_step_advance"
            }).catch(() => {});
          }, 200);

          // ── Startup verification watchdog ──
          // After a short grace period, verify the accepted session has produced output.
          // If not, emit a warning event so the coordinator/health sweep can act.
          // Quiet read-only planning workers are excluded here because some providers
          // produce little or no PTY output until they finish, and that silence was
          // creating false "stalled" signals even while the worker was legitimately
          // thinking. Long-running health sweeps still cover genuinely wedged sessions.
          const stepMeta = asRecord(step.metadata) ?? {};
          const stepPhaseKey = typeof stepMeta.phaseKey === "string" ? stepMeta.phaseKey.trim().toLowerCase() : "";
          const stepType = typeof stepMeta.stepType === "string" ? stepMeta.stepType.trim().toLowerCase() : "";
          const skipStartupVerification =
            stepMeta.readOnlyExecution === true
            || stepPhaseKey === "planning"
            || stepType === "planning";
          if (acceptedSessionId && !skipStartupVerification) {
            setTimeout(() => {
              try {
                const verifyRow = db.get<{ last_output_at: string | null; status: string | null }>(
                  `
                    select last_output_at, status
                    from terminal_sessions
                    where id = ?
                    limit 1
                  `,
                  [acceptedSessionId]
                );
                const hasOutput = Boolean(verifyRow?.last_output_at);
                const sessionStatus = verifyRow?.status ?? "unknown";
                if (!hasOutput && sessionStatus !== "completed" && sessionStatus !== "exited") {
                  appendTimelineEvent({
                    runId: acceptedAttemptRunId,
                    stepId: step.id,
                    attemptId: acceptedAttemptId,
                    eventType: "startup_verification_warning",
                    reason: "no_output_after_startup",
                    detail: {
                      executorKind,
                      sessionId: acceptedSessionId,
                      sessionStatus,
                      elapsedMs: 15_000,
                      workerState: "stalled"
                    }
                  });
                  emit({
                    type: "orchestrator-attempt-updated",
                    runId: acceptedAttemptRunId,
                    stepId: step.id,
                    attemptId: acceptedAttemptId,
                    reason: "startup_verification_warning"
                  });
                }
              } catch {
                // Ignore verification errors — health sweep will catch persistent issues
              }
            }, 15_000);
          }

          return toAttempt(getAttemptRow(attempt.id) ?? attemptRow);
        }
        if (result.status === "completed") {
          return completeAndAdvance({
            attemptId: attempt.id,
            status: "succeeded",
            result: result.result
          });
        }
        return completeAndAdvance({
          attemptId: attempt.id,
          status: "failed",
          errorClass: result.errorClass ?? "executor_failure",
          errorMessage: result.errorMessage,
          metadata: result.metadata ?? null
        });
      }

      appendTimelineEvent({
        runId: run.id,
        stepId: step.id,
        attemptId: attempt.id,
        eventType: "executor_adapter_missing",
        reason: "manual_wait",
        detail: {
          executorKind
        }
      });
      this.tick({ runId: run.id });
      return attempt;
    },

    async completeAttempt(args: {
      attemptId: string;
      status: Extract<OrchestratorAttemptStatus, "succeeded" | "failed" | "blocked" | "canceled">;
      result?: OrchestratorAttemptResultEnvelope;
      errorClass?: OrchestratorErrorClass;
      errorMessage?: string | null;
      retryBackoffMs?: number;
      metadata?: Record<string, unknown> | null;
    }): Promise<OrchestratorAttempt> {
      const attemptRow = getAttemptRow(args.attemptId);
      if (!attemptRow) throw new Error(`Attempt not found: ${args.attemptId}`);
      const stepRow = getStepRow(attemptRow.step_id);
      if (!stepRow) throw new Error(`Step not found for attempt: ${args.attemptId}`);
      const runRow = getRunRow(attemptRow.run_id);
      if (!runRow) throw new Error(`Run not found for attempt: ${args.attemptId}`);
	      const attempt = toAttempt(attemptRow);
	      const step = toStep(stepRow);
	      const run = toRun(runRow);

	      const completedAt = nowIso();
	      const runtimeConfig = getRuntimeConfig();
	      let status = args.status;
	      const fileReservationCheck =
	        status === "succeeded"
	          ? await evaluateFileReservationViolations({
	              step,
	              result: args.result ?? null,
	              metadata: args.metadata ?? null
	            })
	          : null;
	      const fileReservationMessage = (() => {
	        if (!fileReservationCheck || fileReservationCheck.violations.length === 0) return null;
	        const preview = fileReservationCheck.violations.slice(0, 4).join(", ");
	        const suffix = fileReservationCheck.violations.length > 4 ? ` (+${fileReservationCheck.violations.length - 4} more)` : "";
	        return `File reservation violation: modified files outside claimed scope (${preview}${suffix}).`;
	      })();
	      const reservationGuardMode = runtimeConfig.fileReservationGuardMode;
	      const reservationBlocks = status === "succeeded" && Boolean(fileReservationMessage) && reservationGuardMode === "block";
	      const reservationWarns = status === "succeeded" && Boolean(fileReservationMessage) && reservationGuardMode === "warn";
	      if (reservationBlocks) {
	        status = "blocked";
	      }
	      const stepMetadata = asRecord(step.metadata) ?? {};
	      const phaseKey = typeof stepMetadata.phaseKey === "string" ? stepMetadata.phaseKey.trim().toLowerCase() : "";
	      const stepType = typeof stepMetadata.stepType === "string" ? stepMetadata.stepType.trim().toLowerCase() : "";
	      const planningStep =
	        stepMetadata.readOnlyExecution === true ||
	        phaseKey === "planning" ||
	        stepType === "planning";
	      const lastResultReport = asRecord(stepMetadata.lastResultReport);
	      const reportedPlan = asRecord(lastResultReport?.plan);
	      const reportedPlanMarkdown =
	        typeof reportedPlan?.markdown === "string" ? reportedPlan.markdown.trim() : "";
	      const expectedPlanPath =
	        typeof reportedPlan?.artifactPath === "string" && reportedPlan.artifactPath.trim().length > 0
	          ? reportedPlan.artifactPath.trim()
	          : ".ade/plans/mission-plan.md";
	      const plannerContractViolation =
	        status === "succeeded" &&
	        planningStep &&
	        reportedPlanMarkdown.length === 0;
	      const reportedSummary =
	        typeof lastResultReport?.summary === "string" ? lastResultReport.summary.trim() : "";
	      const transcriptPath =
	        typeof attempt.metadata?.transcriptPath === "string" ? attempt.metadata.transcriptPath.trim() : "";
	      const transcriptSummary =
	        !args.result && status === "succeeded"
	          ? deriveTranscriptSummaryFromPath(transcriptPath)
	          : null;
	      // Detect blocking soft-failures: attempt says "succeeded" but warnings
	      // contain sandbox blocks, permission denials, tool startup failures, etc.
	      // Use the same derived summary path that transcript-only completions rely on,
	      // so planner/worker sessions cannot silently succeed with a blocked write summary.
	      let softFailureOverride: ReturnType<typeof classifyBlockingWarnings> | null = null;
	      if (status === "succeeded") {
	        const warningsToCheck = Array.isArray(args.result?.warnings) ? args.result.warnings : [];
	        const explicitSummary =
	          typeof args.result?.summary === "string" ? args.result.summary.trim() : "";
	        const summaryToCheck =
	          explicitSummary
	          || reportedSummary
	          || transcriptSummary
	          || null;
	        softFailureOverride = classifyBlockingWarnings({ warnings: warningsToCheck, summary: summaryToCheck });
	        if (softFailureOverride.hasBlockingFailure) {
	          status = "failed";
	        } else {
	          softFailureOverride = null;
	        }
	      }
	      if (plannerContractViolation) {
	        status = "failed";
	      }
	      const effectiveErrorMessage = plannerContractViolation
	        ? "PLANNER CONTRACT VIOLATION: Planning worker completed without returning report_result.plan.markdown."
	        : softFailureOverride
	          ? softFailureOverride.detail
	          : reservationBlocks
	            ? fileReservationMessage
	            : args.errorMessage ?? null;
	      const errorClass =
	        plannerContractViolation
	          ? "planner_contract_violation" as OrchestratorErrorClass
	          : softFailureOverride
	          ? "soft_success_blocking_failure" as OrchestratorErrorClass
	          : status === "failed"
	            ? args.errorClass ?? "executor_failure"
	            : status === "blocked"
	              ? args.errorClass ?? (reservationBlocks ? "policy" : "policy")
	              : status === "canceled"
	                ? "canceled"
	                : "none";
	      if (plannerContractViolation) {
	        appendTimelineEvent({
	          runId: run.id,
	          stepId: step.id,
	          attemptId: attempt.id,
	          eventType: "planning_artifact_missing",
	          reason: "planner_plan_missing",
	          detail: {
	            expectedPlanPath,
	            phaseKey: phaseKey || null,
	            stepType: stepType || null,
	          }
	        });
	        this.appendRuntimeEvent({
	          runId: run.id,
	          stepId: step.id,
	          attemptId: attempt.id,
	          sessionId: attempt.executorSessionId ?? null,
	          eventType: "planning_artifact_missing",
	          eventKey: `planning_artifact_missing:${attempt.id}`,
	          payload: {
	            expectedPlanPath,
	            phaseKey: phaseKey || null,
	            stepType: stepType || null,
	            reason: "planner_plan_missing",
	          }
	        });
	      }
	      const retryable = status === "failed" ? RETRYABLE_ERROR_CLASSES.has(errorClass) : false;
	      const retryRemaining = status === "failed" ? step.retryCount < step.retryLimit : false;
	      const shouldRetry = status === "failed" ? retryable && retryRemaining : false;
	      const aiRetryBackoffRaw = Number(
	        step.metadata?.aiRetryBackoffMs ?? step.metadata?.ai_retry_backoff_ms ?? Number.NaN
	      );
	      const aiRetryBackoffMs =
	        Number.isFinite(aiRetryBackoffRaw) && aiRetryBackoffRaw >= 0
	          ? Math.min(10 * 60_000, Math.floor(aiRetryBackoffRaw))
	          : null;
	      const computedBackoff = shouldRetry ? (aiRetryBackoffMs ?? 0) : 0;
	      const reportedFilesChanged = Array.isArray(lastResultReport?.filesChanged)
	        ? lastResultReport.filesChanged
	            .map((entry) => String(entry ?? "").trim())
	            .filter((entry) => entry.length > 0)
	        : [];
	      const reportedTests = asRecord(lastResultReport?.testsRun);
	      const implicitOutputs = (() => {
	        if (status !== "succeeded") return null;
		        const outputs: Record<string, unknown> = {};
		        if (typeof reportedPlan?.markdown === "string" && reportedPlan.markdown.trim().length > 0) {
		          outputs.planMarkdown = reportedPlan.markdown.trim();
		          outputs.planPath =
		            typeof reportedPlan.artifactPath === "string" && reportedPlan.artifactPath.trim().length > 0
		              ? reportedPlan.artifactPath.trim()
		              : ".ade/plans/mission-plan.md";
		          if (typeof reportedPlan.summary === "string" && reportedPlan.summary.trim().length > 0) {
		            outputs.planSummary = reportedPlan.summary.trim();
		          }
		        }
		        if (reportedFilesChanged.length > 0) {
		          outputs.filesChanged = reportedFilesChanged;
		        }
		        if (reportedTests) {
		          if (typeof reportedTests.command === "string" && reportedTests.command.trim().length > 0) {
		            outputs.testsCommand = reportedTests.command.trim();
		          }
		          const passed = Number(reportedTests.passed);
		          if (Number.isFinite(passed)) outputs.testsPassed = Math.max(0, Math.floor(passed));
		          const failed = Number(reportedTests.failed);
		          if (Number.isFinite(failed)) outputs.testsFailed = Math.max(0, Math.floor(failed));
		          const skipped = Number(reportedTests.skipped);
		          if (Number.isFinite(skipped)) outputs.testsSkipped = Math.max(0, Math.floor(skipped));
		          if (typeof reportedTests.raw === "string" && reportedTests.raw.trim().length > 0) {
		            outputs.testsSummary = reportedTests.raw.trim();
		          }
		        }
		        return Object.keys(outputs).length > 0 ? outputs : null;
		      })();
		      const defaultSummary =
		        status === "succeeded"
		          ? reportedSummary
		            || transcriptSummary
		            || (
		              stepMetadata.readOnlyExecution === true
		                || String(stepMetadata.stepType ?? "").trim().toLowerCase() === "planning"
		                ? "Planning session completed."
		                : "Step completed."
		            )
		          : status === "failed"
		            ? effectiveErrorMessage?.trim() || "Step attempt failed."
		            : status === "blocked"
	              ? effectiveErrorMessage?.trim() || "Step attempt blocked."
	              : "Step attempt canceled.";
		      const envelope: OrchestratorAttemptResultEnvelope = normalizeEnvelope(
		        args.result ?? {
		          success: status === "succeeded",
	          summary: defaultSummary,
	          outputs: implicitOutputs,
	          warnings: status === "failed" || status === "blocked" ? [defaultSummary] : [],
	          sessionId: attemptRow.executor_session_id,
		          trackedSession: true
	        }
	      );
	      if (reservationWarns && fileReservationMessage && !envelope.warnings.includes(fileReservationMessage)) {
	        envelope.warnings.push(fileReservationMessage);
	      }
      const workerState = status === "succeeded" ? "idle" : "disposed";
      let validationContractUnfulfilledSignal = false;
      let validationSelfCheckReminder = false;

      if (status === "failed") {
        const gotchaLines = [
          `Step "${step.stepKey}" failed.`,
          `Summary: ${String(envelope.summary ?? effectiveErrorMessage ?? defaultSummary).trim() || "Unknown failure."}`,
          `Error class: ${errorClass}`,
          shouldRetry
            ? `Retry scheduled (${step.retryCount + 1}/${step.retryLimit}).`
            : "No retries remain for this failure.",
        ];
        missionMemoryLifecycleService?.recordFailureGotcha({
          projectId,
          missionId: run.missionId,
          runId: run.id,
          content: gotchaLines.join(" "),
          confidence: shouldRetry ? 0.8 : 0.95,
        });
        void knowledgeCaptureService?.captureFailureGotcha({
          missionId: run.missionId,
          runId: run.id,
          stepId: step.id,
          attemptId: attempt.id,
          stepKey: step.stepKey,
          summary: String(envelope.summary ?? defaultSummary).trim() || defaultSummary,
          errorMessage: effectiveErrorMessage ?? null,
          fileScopePattern: typeof stepMetadata.fileScopePattern === "string"
            ? stepMetadata.fileScopePattern
            : Array.isArray(stepMetadata.fileScopes)
              ? String(stepMetadata.fileScopes[0] ?? "").trim() || null
              : null,
        }).catch(() => {});
      }

      db.run(
        `
          update orchestrator_attempts
          set status = ?,
              error_class = ?,
              error_message = ?,
              retry_backoff_ms = ?,
              result_envelope_json = ?,
              metadata_json = ?,
              completed_at = ?,
              started_at = coalesce(started_at, ?)
          where id = ?
            and project_id = ?
        `,
	        [
	          status,
	          errorClass,
	          effectiveErrorMessage,
	          computedBackoff,
	          JSON.stringify(envelope),
	          JSON.stringify({
	            ...(parseJsonRecord(attemptRow.metadata_json) ?? {}),
	            ...(args.metadata ?? {}),
	            ...(fileReservationCheck
	              ? {
	                  fileReservationGuardMode: reservationGuardMode,
	                  fileReservationScopes: fileReservationCheck.normalizedScopes,
	                  fileReservationTouchedPaths: fileReservationCheck.touchedPaths,
	                  fileReservationViolations: fileReservationCheck.violations
	                }
	              : {}),
	            ...(softFailureOverride
	              ? {
	                  softFailureOverride: {
	                    category: softFailureOverride.category,
	                    detail: softFailureOverride.detail,
	                    originalStatus: 'succeeded',
	                    overriddenAt: completedAt,
	                  }
	                }
	              : {}),
	            workerState,
	            workerCompletedAt: completedAt
	          }),
          completedAt,
          completedAt,
          args.attemptId,
          projectId
        ]
      );

      releaseClaimsForAttempt({
        attemptId: args.attemptId,
        state: status === "failed" ? "released" : "released"
      });

      // Clean up temporary MCP config files for this worker.
      const laneWorktreeRow = step.laneId
        ? db.get<{ worktree_path: string | null }>(
            `select worktree_path from lanes where id = ? and project_id = ? limit 1`,
            [step.laneId, projectId]
          )
        : null;
      const laneWorktreePath = typeof laneWorktreeRow?.worktree_path === "string" && laneWorktreeRow.worktree_path.trim().length > 0
        ? laneWorktreeRow.worktree_path.trim()
        : null;
      cleanupMcpConfigFile(projectRoot, args.attemptId, laneWorktreePath);

      // Sync worker checkpoint file to DB for all completion states
      if (step.laneId) {
        const ckLaneRow = db.get<{ worktree_path: string | null }>(
          `select worktree_path from lanes where id = ? and project_id = ? limit 1`,
          [step.laneId, projectId]
        );
        const ckWorktreePath = typeof ckLaneRow?.worktree_path === "string" && ckLaneRow.worktree_path.trim().length
          ? ckLaneRow.worktree_path.trim()
          : null;
        if (ckWorktreePath) {
          const ckPath = getWorkerCheckpointPath(ckWorktreePath, step.stepKey);
          try {
            const ckContent = fs.readFileSync(ckPath, "utf8");
            if (ckContent.trim().length > 0) {
              this.upsertWorkerCheckpoint({
                missionId: run.missionId,
                runId: run.id,
                stepId: step.id,
                attemptId: args.attemptId,
                stepKey: step.stepKey,
                content: ckContent,
                filePath: ckPath
              });
            }
          } catch {
            // File may not exist — expected when no checkpoint was written.
          }
        }
      }

      if (status === "succeeded") {
        db.run(
          `
            update orchestrator_steps
            set status = 'succeeded',
                updated_at = ?,
                completed_at = ?,
                last_attempt_id = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [completedAt, completedAt, args.attemptId, step.id, run.id, projectId]
        );

        // Clean up checkpoint file on success (DB sync already done above)
        if (step.laneId) {
          const laneRow = db.get<{ worktree_path: string | null }>(
            `select worktree_path from lanes where id = ? and project_id = ? limit 1`,
            [step.laneId, projectId]
          );
          const worktreePath = typeof laneRow?.worktree_path === "string" && laneRow.worktree_path.trim().length
            ? laneRow.worktree_path.trim()
            : null;
          if (worktreePath) {
            const checkpointPath = getWorkerCheckpointPath(worktreePath, step.stepKey);
            try {
              fs.unlinkSync(checkpointPath);
            } catch {
              // File may not exist — expected when no checkpoint was written.
            }
          }
        }

        const latestStepRow = getStepRow(step.id);
        const latestStep = latestStepRow ? toStep(latestStepRow) : step;
        const latestStepMeta = asRecord(latestStep.metadata) ?? {};
        const isAutoSpawnedValidationStep = latestStepMeta.autoSpawnedValidation === true;
        if (!isAutoSpawnedValidationStep) {
          const runMetadata = asRecord(run.metadata);
          const phaseCards = resolveRunPhaseCardsFromMetadata(runMetadata) ?? [];
          const stepPhaseKey = typeof latestStepMeta.phaseKey === "string" ? latestStepMeta.phaseKey.trim() : "";
          const stepPhaseName = typeof latestStepMeta.phaseName === "string" ? latestStepMeta.phaseName.trim() : "";
          const phaseCard =
            phaseCards.find((phase) => phase.phaseKey === stepPhaseKey)
            ?? phaseCards.find((phase) => phase.name === stepPhaseName)
            ?? null;
          const validationPhaseCard =
            phaseCards.find((phase) => phase.phaseKey.trim().toLowerCase() === "validation")
            ?? phaseCards.find((phase) => phase.name.trim().toLowerCase() === "validation")
            ?? null;
          const phaseTier = normalizeValidationTier(phaseCard?.validationGate?.tier);
          const phaseRequiresValidation = phaseCard?.validationGate?.required === true && phaseTier !== "none";
          const existingContract = parseValidationContract(latestStepMeta.validationContract ?? null);
          const requiresValidation = existingContract?.required === true || phaseRequiresValidation;
          if (requiresValidation) {
            const normalizedContract: NormalizedValidationContract = {
              level: existingContract?.level ?? "step",
              tier: existingContract?.tier ?? (phaseTier === "dedicated" ? "dedicated" : "self"),
              required: true,
              criteria:
                existingContract?.criteria
                ?? (typeof phaseCard?.validationGate?.criteria === "string" && phaseCard.validationGate.criteria.trim().length > 0
                  ? phaseCard.validationGate.criteria.trim()
                  : `Validate completed output for step "${latestStep.stepKey}".`),
              evidence: existingContract?.evidence ?? [],
              maxRetries: existingContract?.maxRetries ?? 2,
            };
            const validationStateRaw = typeof latestStepMeta.validationState === "string"
              ? latestStepMeta.validationState.trim().toLowerCase()
              : "";
            const nextValidationState =
              validationStateRaw === "pass" || validationStateRaw === "fail"
                ? validationStateRaw
                : "pending";
            const nextStepMetadata = {
              ...latestStepMeta,
              validationContract: normalizedContract,
              validationState: nextValidationState,
            };
            db.run(
              `
                update orchestrator_steps
                set metadata_json = ?,
                    updated_at = ?
                where id = ?
                  and run_id = ?
                  and project_id = ?
              `,
              [JSON.stringify(nextStepMetadata), completedAt, latestStep.id, run.id, projectId]
            );

            if (!hasPassingValidation(nextStepMetadata)) {
              const detail = `Step "${latestStep.stepKey}" completed without required validation pass (${normalizedContract.tier} tier).`;
              appendTimelineEvent({
                runId: run.id,
                stepId: latestStep.id,
                attemptId: args.attemptId,
                eventType: "validation_contract_unfulfilled",
                reason: "required_validation_missing",
                detail: {
                  stepKey: latestStep.stepKey,
                  phaseKey: stepPhaseKey || null,
                  phaseName: stepPhaseName || null,
                  tier: normalizedContract.tier,
                  criteria: normalizedContract.criteria,
                  autoSpawnedValidation: normalizedContract.tier === "dedicated"
                }
              });
              persistRuntimeEvent({
                runId: run.id,
                stepId: latestStep.id,
                attemptId: args.attemptId,
                sessionId: attemptRow.executor_session_id,
                eventType: "validation_contract_unfulfilled",
                eventKey: `validation_contract_unfulfilled:${run.id}:${latestStep.id}:${args.attemptId}:${completedAt}`,
                occurredAt: completedAt,
                payload: {
                  stepId: latestStep.id,
                  stepKey: latestStep.stepKey,
                  phaseKey: stepPhaseKey || null,
                  phaseName: stepPhaseName || null,
                  tier: normalizedContract.tier,
                  required: true,
                  detail
                }
              });
              emit({
                type: "orchestrator-step-updated",
                runId: run.id,
                stepId: latestStep.id,
                reason: "validation_contract_unfulfilled"
              });
              validationContractUnfulfilledSignal = true;

              if (normalizedContract.tier === "dedicated") {
                const existingSteps = listStepRows(run.id).map(toStep);
                const existingValidator = existingSteps.find((candidate) => {
                  const candidateMeta = asRecord(candidate.metadata);
                  const targetStepId = typeof candidateMeta?.targetStepId === "string" ? candidateMeta.targetStepId.trim() : "";
                  return candidateMeta?.autoSpawnedValidation === true && targetStepId === latestStep.id;
                });

                if (!existingValidator) {
                  const templateRoles = Array.isArray(asRecord(asRecord(runMetadata?.teamRuntime)?.template)?.roles)
                    ? (asRecord(asRecord(runMetadata?.teamRuntime)?.template)?.roles as Array<Record<string, unknown>>)
                    : [];
                  const validatorRole =
                    templateRoles.find((role) => {
                      const roleName = typeof role.name === "string" ? role.name.trim().toLowerCase() : "";
                      if (roleName.includes("validator")) return true;
                      const capabilities = Array.isArray(role.capabilities)
                        ? role.capabilities.map((entry) => String(entry ?? "").trim().toLowerCase())
                        : [];
                      return capabilities.some((entry) => entry.includes("validation") || entry.includes("review"));
                    }) ?? null;
                  const validatorRoleName =
                    typeof validatorRole?.name === "string" && validatorRole.name.trim().length > 0
                      ? validatorRole.name.trim()
                      : "validator";

                  const validatorPhaseModel = asRecord(validationPhaseCard?.model);
                  const phaseModel = asRecord(latestStepMeta.phaseModel);
                  const phaseModelId = typeof validatorPhaseModel?.modelId === "string"
                    ? validatorPhaseModel.modelId.trim()
                    : typeof phaseModel?.modelId === "string"
                      ? phaseModel.modelId.trim()
                      : "";
                  const runtimePhaseModel = asRecord(asRecord(runMetadata?.phaseRuntime)?.currentPhaseModel);
                  const runtimePhaseModelId = typeof runtimePhaseModel?.modelId === "string" ? runtimePhaseModel.modelId.trim() : "";
                  const candidateModelIds = [
                    phaseModelId,
                    runtimePhaseModelId,
                  ].filter((entry) => entry.length > 0);
                  const validatorModelId = candidateModelIds.find((entry) => Boolean(resolveModelDescriptor(entry))) ?? "";
                  if (!validatorModelId.length) {
                    appendTimelineEvent({
                      runId: run.id,
                      stepId: latestStep.id,
                      attemptId: args.attemptId,
                      eventType: "validation_auto_spawned",
                      reason: "phase_model_missing",
                      detail: {
                        targetStepId: latestStep.id,
                        targetStepKey: latestStep.stepKey,
                        phaseModelId: phaseModelId || null,
                        runtimePhaseModelId: runtimePhaseModelId || null,
                        message: "Dedicated validator could not be auto-spawned because the active phase model is missing or unregistered."
                      }
                    });
                    emit({
                      type: "orchestrator-step-updated",
                      runId: run.id,
                      stepId: latestStep.id,
                      reason: "validation_auto_spawned"
                    });
                  } else {
                    const outputs = asRecord(envelope.outputs);
                    const collectStringList = (value: unknown): string[] => {
                      if (!Array.isArray(value)) return [];
                      return value
                        .map((entry) => String(entry ?? "").trim())
                        .filter((entry) => entry.length > 0);
                    };
                    const filesChanged = [
                      ...collectStringList(outputs?.filesChanged),
                      ...collectStringList(outputs?.changedFiles),
                      ...collectStringList(outputs?.modifiedFiles),
                      ...collectStringList(outputs?.files_changed),
                      ...collectStringList(outputs?.changed_files),
                      ...collectStringList(outputs?.modified_files),
                    ].filter((entry, index, all) => all.indexOf(entry) === index);
                    const testsRun = asRecord(outputs?.testsRun ?? outputs?.tests_run);
                    const testsSummary = testsRun
                      ? [
                          `passed=${Number(testsRun.passed ?? 0)}`,
                          `failed=${Number(testsRun.failed ?? 0)}`,
                          `skipped=${Number(testsRun.skipped ?? 0)}`
                        ].join(", ")
                      : "not reported";
                    const validatorPrompt = [
                      `Validate completed worker output for step "${latestStep.stepKey}" (${latestStep.title}).`,
                      `Validation criteria: ${normalizedContract.criteria}`,
                      `Worker summary: ${envelope.summary}`,
                      filesChanged.length > 0 ? `Files changed:\n- ${filesChanged.join("\n- ")}` : "Files changed: none reported.",
                      `Tests summary: ${testsSummary}`,
                      `Use report_validation with targetWorkerId="${latestStep.stepKey}" and verdict "pass" or "fail".`,
                      "When failing, include findings with concrete remediation steps."
                    ].join("\n\n");

                    const existingStepKeys = new Set(existingSteps.map((candidate) => candidate.stepKey));
                    const baseValidatorKey = `validate_${latestStep.stepKey}`.replace(/[^a-zA-Z0-9_-]/g, "_");
                    let validatorStepKey = baseValidatorKey;
                    let keyCounter = 1;
                    while (existingStepKeys.has(validatorStepKey)) {
                      validatorStepKey = `${baseValidatorKey}_${keyCounter}`;
                      keyCounter += 1;
                    }
                    const maxStepIndex = existingSteps.reduce((max, candidate) => Math.max(max, candidate.stepIndex), -1);
                    const spawned = this.addSteps({
                      runId: run.id,
                      steps: [
                        {
                          stepKey: validatorStepKey,
                          title: `Validate: ${latestStep.title}`,
                          stepIndex: maxStepIndex + 1,
                          laneId: latestStep.laneId,
                          dependencyStepKeys: [latestStep.stepKey],
                          executorKind: "unified",
                          metadata: {
                            stepType: "validation",
                            taskType: "validation",
                            instructions: validatorPrompt,
                            modelId: validatorModelId,
                            role: validatorRoleName,
                            autoSpawnedValidation: true,
                            targetStepId: latestStep.id,
                            targetStepKey: latestStep.stepKey,
                            targetAttemptId: args.attemptId,
                            targetStepSummary: envelope.summary,
                            phaseKey: validationPhaseCard?.phaseKey ?? (stepPhaseKey || phaseCard?.phaseKey || null),
                            phaseName: validationPhaseCard?.name ?? (stepPhaseName || phaseCard?.name || null),
                            phasePosition: validationPhaseCard?.position
                              ?? (typeof latestStepMeta.phasePosition === "number"
                                ? latestStepMeta.phasePosition
                                : phaseCard?.position ?? null),
                            ...(validationPhaseCard?.model ? { phaseModel: validationPhaseCard.model } : {}),
                            ...(typeof validationPhaseCard?.instructions === "string" && validationPhaseCard.instructions.trim().length > 0
                              ? { phaseInstructions: validationPhaseCard.instructions.trim() }
                              : {}),
                            ...(validationPhaseCard?.validationGate ? { phaseValidation: validationPhaseCard.validationGate } : {}),
                            ...(validationPhaseCard?.budget ? { phaseBudget: validationPhaseCard.budget } : {}),
                            validationContract: normalizedContract
                          }
                        }
                      ]
                    });
                    if (spawned.length > 0) {
                      appendTimelineEvent({
                        runId: run.id,
                        stepId: spawned[0]!.id,
                        eventType: "validation_auto_spawned",
                        reason: "dedicated_required_validation",
                        detail: {
                          targetStepId: latestStep.id,
                          targetStepKey: latestStep.stepKey,
                          validatorStepKey: spawned[0]!.stepKey,
                          validatorModelId
                        }
                      });
                      void this.startReadyAutopilotAttempts({
                        runId: run.id,
                        reason: "validation_auto_spawned"
                      }).catch(() => {});
                    }
                  }
                }
              } else {
                const reminder = `Step "${latestStep.stepKey}" requires self-validation. Review output and call report_validation with verdict pass/fail.`;
                appendTimelineEvent({
                  runId: run.id,
                  stepId: latestStep.id,
                  attemptId: args.attemptId,
                  eventType: "validation_self_check_reminder",
                  reason: "required_validation_missing",
                  detail: {
                    stepKey: latestStep.stepKey,
                    reminder
                  }
                });
                persistRuntimeEvent({
                  runId: run.id,
                  stepId: latestStep.id,
                  attemptId: args.attemptId,
                  sessionId: attemptRow.executor_session_id,
                  eventType: "validation_self_check_reminder",
                  eventKey: `validation_self_check_reminder:${run.id}:${latestStep.id}:${completedAt}`,
                  occurredAt: completedAt,
                  payload: {
                    audience: "coordinator",
                    stepId: latestStep.id,
                    stepKey: latestStep.stepKey,
                    message: reminder
                  }
                });
                emit({
                  type: "orchestrator-step-updated",
                  runId: run.id,
                  stepId: latestStep.id,
                  reason: "validation_self_check_reminder"
                });
                validationSelfCheckReminder = true;
              }
            }
          }
        }
      } else if (status === "canceled") {
        db.run(
          `
            update orchestrator_steps
            set status = 'canceled',
                updated_at = ?,
                completed_at = ?,
                last_attempt_id = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [completedAt, completedAt, args.attemptId, step.id, run.id, projectId]
        );
      } else if (status === "blocked") {
        const blockedMetadata = {
          ...(step.metadata ?? {}),
          blockedAt: completedAt,
	          blockedByAttemptId: args.attemptId,
	          blockedErrorClass: errorClass,
	          blockedErrorMessage: effectiveErrorMessage ?? defaultSummary,
	          blockedSticky: errorClass === "policy"
	        };
        db.run(
          `
            update orchestrator_steps
            set status = 'blocked',
                metadata_json = ?,
                updated_at = ?,
                last_attempt_id = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
        [JSON.stringify(blockedMetadata), completedAt, args.attemptId, step.id, run.id, projectId]
      );
      } else {
        if (shouldRetry) {
          const nextRetryAt = new Date(Date.now() + computedBackoff).toISOString();
          db.run(
            `
              update orchestrator_steps
              set status = 'pending',
                  retry_count = retry_count + 1,
                  metadata_json = ?,
                  updated_at = ?,
                  last_attempt_id = ?
              where id = ?
                and run_id = ?
                and project_id = ?
            `,
            [
              JSON.stringify({
                ...(step.metadata ?? {}),
                nextRetryAt,
                lastRetryBackoffMs: computedBackoff
              }),
              completedAt,
              args.attemptId,
              step.id,
              run.id,
              projectId
            ]
          );
	      appendTimelineEvent({
	        runId: run.id,
	        stepId: step.id,
	        attemptId: args.attemptId,
            eventType: "attempt_retry_scheduled",
            reason: "retryable_failure",
            detail: {
              retryBackoffMs: computedBackoff,
              nextRetryAt,
              retryCount: step.retryCount + 1,
              retryLimit: step.retryLimit
            }
          });
          persistRuntimeEvent({
            runId: run.id,
            stepId: step.id,
            attemptId: args.attemptId,
            sessionId: attemptRow.executor_session_id,
            eventType: "retry_scheduled",
            eventKey: `retry_scheduled:${args.attemptId}:${step.retryCount + 1}:${nextRetryAt}`,
            occurredAt: completedAt,
            payload: {
              retryBackoffMs: computedBackoff,
              nextRetryAt,
              retryCount: step.retryCount + 1,
              retryLimit: step.retryLimit,
              errorClass
            }
          });
        } else {
          db.run(
            `
              update orchestrator_steps
              set status = 'failed',
                  updated_at = ?,
                  completed_at = ?,
                  last_attempt_id = ?
              where id = ?
                and run_id = ?
                and project_id = ?
            `,
	          [completedAt, completedAt, args.attemptId, step.id, run.id, projectId]
        );
          persistRuntimeEvent({
            runId: run.id,
            stepId: step.id,
            attemptId: args.attemptId,
            sessionId: attemptRow.executor_session_id,
            eventType: "retry_exhausted",
            eventKey: `retry_exhausted:${args.attemptId}:${step.retryCount}:${step.retryLimit}`,
            occurredAt: completedAt,
            payload: {
	              retryCount: step.retryCount,
	              retryLimit: step.retryLimit,
	              errorClass,
	              errorMessage: effectiveErrorMessage ?? defaultSummary
	            }
	          });
	        }
      }

      insertHandoff({
        missionId: run.missionId,
        missionStepId: step.missionStepId,
        runId: run.id,
        stepId: step.id,
        attemptId: args.attemptId,
        handoffType:
          status === "succeeded"
            ? "attempt_succeeded"
            : status === "failed"
              ? "attempt_failed"
              : status === "blocked"
                ? "attempt_blocked"
                : "attempt_canceled",
        producer: "orchestrator",
        payload: {
          contextProfile: normalizeProfileId(attemptRow.context_profile),
	          status,
	          errorClass,
	          errorMessage: effectiveErrorMessage,
	          retryBackoffMs: computedBackoff,
	          result: envelope
	        }
      });

      emit({ type: "orchestrator-attempt-updated", runId: run.id, stepId: step.id, attemptId: args.attemptId, reason: "completed" });
      emit({ type: "orchestrator-step-updated", runId: run.id, stepId: step.id, reason: "attempt_completed" });
      appendTimelineEvent({
        runId: run.id,
        stepId: step.id,
        attemptId: args.attemptId,
        eventType: "attempt_completed",
        reason: status,
        detail: {
          status,
          errorClass,
          retryBackoffMs: computedBackoff,
	          shouldRetry
	        }
	      });
	      if (fileReservationMessage && fileReservationCheck) {
	        appendTimelineEvent({
	          runId: run.id,
	          stepId: step.id,
	          attemptId: args.attemptId,
	          eventType: "file_reservation_guard",
	          reason: reservationBlocks ? "block" : reservationWarns ? "warn" : "off",
	          detail: {
	            guardMode: reservationGuardMode,
	            normalizedScopes: fileReservationCheck.normalizedScopes,
	            touchedPaths: fileReservationCheck.touchedPaths,
	            violations: fileReservationCheck.violations,
	            rawPaths: fileReservationCheck.rawPaths
	          }
	        });
	      }
	      if (softFailureOverride) {
	        appendTimelineEvent({
	          runId: run.id,
	          stepId: step.id,
	          attemptId: args.attemptId,
	          eventType: "soft_success_blocking_failure",
	          reason: softFailureOverride.category ?? "unknown",
	          detail: {
	            category: softFailureOverride.category,
	            detail: softFailureOverride.detail,
	            originalStatus: "succeeded",
	            overriddenStatus: "failed",
	            errorClass: "soft_success_blocking_failure"
	          }
	        });
	        persistRuntimeEvent({
	          runId: run.id,
	          stepId: step.id,
	          attemptId: args.attemptId,
	          sessionId: attemptRow.executor_session_id,
	          eventType: "blocked",
	          eventKey: `soft_failure_override:${args.attemptId}:${softFailureOverride.category}:${completedAt}`,
	          occurredAt: completedAt,
	          payload: {
	            errorClass: "soft_success_blocking_failure",
	            category: softFailureOverride.category,
	            errorMessage: softFailureOverride.detail,
	            originalStatus: "succeeded"
	          }
	        });
	      }
	      if (status === "succeeded") {
	        persistRuntimeEvent({
          runId: run.id,
          stepId: step.id,
          attemptId: args.attemptId,
          sessionId: attemptRow.executor_session_id,
          eventType: "done",
          eventKey: `done:${args.attemptId}:${completedAt}`,
          occurredAt: completedAt,
          payload: {
            summary: envelope.summary
          }
        });
        if (validationContractUnfulfilledSignal) {
          emit({
            type: "orchestrator-run-updated",
            runId: run.id,
            reason: "validation_contract_unfulfilled"
          });
        } else if (validationSelfCheckReminder) {
          emit({
            type: "orchestrator-run-updated",
            runId: run.id,
            reason: "validation_self_check_reminder"
          });
        }
      } else if (status === "blocked") {
        persistRuntimeEvent({
          runId: run.id,
          stepId: step.id,
          attemptId: args.attemptId,
          sessionId: attemptRow.executor_session_id,
          eventType: "blocked",
          eventKey: `blocked:${args.attemptId}:${errorClass}:${completedAt}`,
          occurredAt: completedAt,
	          payload: {
	            errorClass,
	            errorMessage: effectiveErrorMessage ?? defaultSummary
	          }
	        });
	      }

      // Budget accumulation: if attempt metadata includes tokensConsumed, accumulate into run
      const attemptTokens = Number(args.metadata?.tokensConsumed ?? 0);
      if (attemptTokens > 0) {
        const currentRunRow = getRunRow(run.id);
        const currentRunMeta = currentRunRow ? (parseJsonRecord(currentRunRow.metadata_json) ?? {}) : (run.metadata ?? {});
        const currentTotal = Number(currentRunMeta.tokensConsumed ?? 0);
        const newTotal = currentTotal + attemptTokens;
        const updatedMeta = { ...currentRunMeta, tokensConsumed: newTotal };
        db.run(
          `
            update orchestrator_runs
            set metadata_json = ?,
                updated_at = ?
            where id = ?
              and project_id = ?
          `,
          [JSON.stringify(updatedMeta), nowIso(), run.id, projectId]
        );
        appendTimelineEvent({
          runId: run.id,
          stepId: step.id,
          attemptId: args.attemptId,
          eventType: "budget_updated",
          reason: "attempt_budget_accumulated",
          detail: {
            attemptTokens,
            totalTokensConsumed: newTotal
          }
        });
        // Check if total exceeds limit; if so, pause the run
        const runtimeConfig = getRuntimeConfig();
        if (runtimeConfig.maxTotalTokenBudget != null && newTotal >= runtimeConfig.maxTotalTokenBudget) {
          updateRunStatus(run.id, "paused", {
            last_error: `Total token budget exceeded: ${newTotal} >= ${runtimeConfig.maxTotalTokenBudget}`,
            metadata_json: JSON.stringify(updatedMeta)
          });
          appendTimelineEvent({
            runId: run.id,
            stepId: step.id,
            attemptId: args.attemptId,
            eventType: "budget_exceeded",
            reason: "total_budget_limit",
            detail: {
              tokensConsumed: newTotal,
              maxTotalTokenBudget: runtimeConfig.maxTotalTokenBudget
            }
          });
          // VAL-BUDGET-001: Emit runtime event so aiOrchestratorService can
          // create a budget_limit_reached intervention (matching the hard cap
          // path in coordinatorTools).
          persistRuntimeEvent({
            runId: run.id,
            stepId: step.id,
            attemptId: args.attemptId,
            eventType: "budget_exceeded",
            eventKey: `budget_exceeded:${run.id}:${args.attemptId}:${newTotal}`,
            payload: {
              tokensConsumed: newTotal,
              maxTotalTokenBudget: runtimeConfig.maxTotalTokenBudget,
              missionId: run.missionId,
              source: "completeAttempt",
            }
          });
          emit({
            type: "orchestrator-run-updated",
            runId: run.id,
            reason: "budget_exceeded",
          });
        }
      }

      // Append run narrative entry for step completion
      appendRunNarrative(run.id, step.stepKey, `${status}: ${envelope.summary.slice(0, 200)}`);

      // VAL-STATE-002: When a step completes, check if it is a fan-out child
      // and all siblings are terminal. If so, update the parent step status.
      if (status === "succeeded" || status === "failed") {
        this.checkFanOutCompletion({ runId: run.id, completedStepKey: step.stepKey });
      }

      const updatedRun = this.tick({ runId: run.id });
      // When the run transitions to "completing" (all steps terminal) or is already terminal,
      // mark worker state as disposed for cleanup.
      if (
        updatedRun.status === "completing" ||
        updatedRun.status === "succeeded" ||
        updatedRun.status === "failed" ||
        updatedRun.status === "canceled"
      ) {
        const latestAttempt = getAttemptRow(args.attemptId);
        const latestMetadata =
          (latestAttempt ? toAttempt(latestAttempt).metadata : null) ?? parseJsonRecord(attemptRow.metadata_json) ?? {};
        db.run(
          `
            update orchestrator_attempts
            set metadata_json = ?
            where id = ?
              and project_id = ?
          `,
          [
            JSON.stringify({
              ...latestMetadata,
              workerState: "disposed",
              workerDisposedAt: nowIso()
            }),
            args.attemptId,
            projectId
          ]
        );
      }
      // Store last error on the run when a failed attempt completes
      if (status === "failed") {
        db.run(
          `
            update orchestrator_runs
            set last_error = ?,
                updated_at = ?
            where id = ?
              and project_id = ?
          `,
          [effectiveErrorMessage ?? defaultSummary, nowIso(), run.id, projectId]
        );
      }
      const updatedAttemptRow = getAttemptRow(args.attemptId);
      if (!updatedAttemptRow) throw new Error("Attempt not found after completion update.");
      return toAttempt(updatedAttemptRow);
    },

    resumeRun(args: { runId: string }): OrchestratorRun {
      const runRow = getRunRow(args.runId);
      if (!runRow) throw new Error(`Run not found: ${args.runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
      if (run.status === "completing") return run;
      if (run.status === "paused") {
        updateRunStatus(run.id, "active", {
          last_error: null
        });
      }

      // Recover in-flight attempts as restart-failures so scheduler can retry deterministically.
      const runningAttempts = db.all<AttemptRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_number,
            status,
            executor_kind,
            executor_session_id,
            tracked_session_enforced,
            context_profile,
            context_snapshot_id,
            error_class,
            error_message,
            retry_backoff_ms,
            result_envelope_json,
            metadata_json,
            created_at,
            started_at,
            completed_at
          from orchestrator_attempts
          where project_id = ?
            and run_id = ?
            and status = 'running'
          order by created_at asc
        `,
        [projectId, run.id]
      );

      for (const attemptRow of runningAttempts) {
        const step = getStepRow(attemptRow.step_id);
        if (!step) continue;
        releaseClaimsForAttempt({ attemptId: attemptRow.id, state: "expired" });
        const completedAt = nowIso();
        db.run(
          `
            update orchestrator_attempts
            set status = 'failed',
                error_class = 'resume_recovered',
                error_message = ?,
                result_envelope_json = ?,
                completed_at = ?,
                started_at = coalesce(started_at, ?)
            where id = ?
              and project_id = ?
          `,
          [
            "Attempt was orphaned by app restart; worker session was lost. Recovered into deterministic retry path.",
            JSON.stringify({
              schema: "ade.orchestratorAttempt.v1",
              success: false,
              summary: "Recovered after app restart; worker session lost.",
              outputs: null,
              warnings: ["resume_recovered"],
              sessionId: attemptRow.executor_session_id,
              trackedSession: true
            } satisfies OrchestratorAttemptResultEnvelope),
            completedAt,
            completedAt,
            attemptRow.id,
            projectId
          ]
        );
        db.run(
          `
            update orchestrator_steps
            set status = case
              when retry_count < retry_limit then 'ready'
              else 'failed'
            end,
            retry_count = case
              when retry_count < retry_limit then retry_count + 1
              else retry_count
            end,
            updated_at = ?,
            completed_at = case
              when retry_count < retry_limit then completed_at
              else ?
            end
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [completedAt, completedAt, step.id, run.id, projectId]
        );
        insertHandoff({
          missionId: run.missionId,
          missionStepId: step.mission_step_id,
          runId: run.id,
          stepId: step.id,
          attemptId: attemptRow.id,
          handoffType: "attempt_recovered_after_restart",
          producer: "orchestrator",
          payload: {
            errorClass: "resume_recovered",
            message: "Attempt orphaned by app restart and converted to deterministic recovery path.",
            contextProfile: normalizeProfileId(attemptRow.context_profile)
          }
        });
        appendTimelineEvent({
          runId: run.id,
          stepId: step.id,
          attemptId: attemptRow.id,
          eventType: "attempt_recovered_after_restart",
          reason: "resume_recovered",
          detail: {
            retryLimit: step.retry_limit,
            retryCount: step.retry_count
          }
        });
      }

      const resumed = this.tick({ runId: run.id });
      const autopilot = parseAutopilotConfig(resumed.metadata, DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG.maxParallelWorkers);
      if (autopilot.enabled && runCanStartAttempts(resumed.status)) {
        void this
          .startReadyAutopilotAttempts({
            runId: run.id,
            reason: "resume_run"
          })
          .catch(() => {});
      }
      appendTimelineEvent({
        runId: run.id,
        eventType: "run_resumed",
        reason: "resume_run",
        detail: {
          recoveredAttempts: runningAttempts.length,
          status: resumed.status
        }
      });
      return resumed;
    },

    pauseRun(args: { runId: string; reason?: string; metadata?: Record<string, unknown> | null }): OrchestratorRun {
      const runRow = getRunRow(args.runId);
      if (!runRow) throw new Error(`Run not found: ${args.runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status) || run.status === "paused") return run;

      const patch: Record<string, SqlValue> = {};
      if (typeof args.reason === "string" && args.reason.trim().length > 0) {
        patch.last_error = args.reason.trim();
      }
      if (args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) {
        patch.metadata_json = JSON.stringify({
          ...(parseJsonRecord(runRow.metadata_json) ?? {}),
          ...args.metadata
        });
      }

      updateRunStatus(run.id, "paused", patch);
      appendTimelineEvent({
        runId: run.id,
        eventType: "run_paused",
        reason: args.reason ?? "paused",
        detail: {
          previousStatus: run.status,
          reason: args.reason ?? null
        }
      });
      const updated = getRunRow(run.id);
      if (!updated) throw new Error(`Run not found after pause: ${run.id}`);
      return toRun(updated);
    },

    cancelRun(args: { runId: string; reason?: string }) {
      const run = getRunRow(args.runId);
      if (!run) throw new Error(`Run not found: ${args.runId}`);
      const now = nowIso();
      db.run(
        `
          update orchestrator_attempts
          set status = 'canceled',
              error_class = 'canceled',
              error_message = ?,
              completed_at = coalesce(completed_at, ?)
          where run_id = ?
            and project_id = ?
            and status in ('queued', 'running', 'blocked')
        `,
        [args.reason ?? "Run canceled.", now, args.runId, projectId]
      );
      db.run(
        `
          update orchestrator_steps
          set status = case
            when status in ('succeeded', 'failed', 'skipped', 'canceled') then status
            else 'canceled'
          end,
          updated_at = ?,
          completed_at = case
            when status in ('succeeded', 'failed', 'skipped', 'canceled') then completed_at
            else ?
          end
          where run_id = ?
            and project_id = ?
        `,
        [now, now, args.runId, projectId]
      );
      db.run(
        `
          update orchestrator_claims
          set state = 'released',
              released_at = ?
          where run_id = ?
            and project_id = ?
            and state = 'active'
        `,
        [now, args.runId, projectId]
      );
      updateRunStatus(args.runId, "canceled", {
        last_error: args.reason ?? null
      });
      appendTimelineEvent({
        runId: args.runId,
        eventType: "run_canceled",
        reason: "cancel_run",
        detail: {
          reason: args.reason ?? null
        }
      });
      try {
        void this.generateRunRetrospective({ runId: args.runId });
      } catch {
        // best-effort
      }
    },

    addSteps(args: {
      runId: string;
      steps: StartOrchestratorRunStepInput[];
    }): OrchestratorStep[] {
      const runId = String(args.runId ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);
      // Only reject step additions for truly terminal states.
      // "bootstrapping", "active", "completing", "paused", "queued" all allow step additions.
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new Error(`Cannot add steps to a terminal run (status: ${run.status}).`);
      }
      if (!args.steps.length) return [];
      const missionLaneId = run.missionId ? resolveRunMissionLaneId(run.metadata) : null;

      // Get existing steps to compute next step_index and resolve dependency keys
      const existingStepRows = listStepRows(runId);
      const existingSteps = existingStepRows.map(toStep);
      const existingKeyToId = new Map<string, string>();
      for (const step of existingSteps) {
        existingKeyToId.set(step.stepKey, step.id);
      }
      const existingKeyById = new Map<string, string>();
      for (const step of existingSteps) {
        existingKeyById.set(step.id, step.stepKey);
      }
      const maxExistingIndex = existingSteps.reduce((max, step) => Math.max(max, step.stepIndex), -1);

      const createdAt = nowIso();
      const newKeyToId = new Map<string, string>();
      const dependencyStepKeysByNewStepKey = new Map<string, string[]>();
      const sorted = [...args.steps].sort(
        (a, b) => a.stepIndex - b.stepIndex || a.stepKey.localeCompare(b.stepKey)
      );
      const stepEntries = sorted.map((input, index) => {
        const id = randomUUID();
        const stepKey = input.stepKey.trim();
        if (!stepKey) throw new Error("stepKey is required for every orchestrator step.");
        if (existingKeyToId.has(stepKey) || newKeyToId.has(stepKey)) {
          throw new Error(`Duplicate stepKey: ${stepKey}`);
        }
        newKeyToId.set(stepKey, id);
        const dependencyStepKeys = normalizeDependencyStepKeys(input.dependencyStepKeys);
        dependencyStepKeysByNewStepKey.set(stepKey, dependencyStepKeys);
        return {
          id,
          input,
          stepIndex: Number.isFinite(input.stepIndex) ? input.stepIndex : maxExistingIndex + 1 + index,
          stepKey,
          dependencyStepKeys
        };
      });

      const existingGraphSteps: StepGraphValidationStep[] = existingSteps.map((step) => ({
        stepKey: step.stepKey,
        dependencyStepKeys: step.dependencyStepIds
          .map((depId) => existingKeyById.get(depId) ?? "")
          .filter((depKey): depKey is string => depKey.length > 0),
        joinPolicy: step.joinPolicy,
        quorumCount: step.quorumCount
      }));
      const newGraphSteps: StepGraphValidationStep[] = stepEntries.map(({ stepKey, dependencyStepKeys, input }) => ({
        stepKey,
        dependencyStepKeys,
        joinPolicy: normalizeJoinPolicy(String(input.joinPolicy ?? "all_success")),
        quorumCount: input.quorumCount != null ? Math.floor(Number(input.quorumCount)) : null
      }));
      validateStepGraphIntegrity({
        context: "addSteps",
        steps: [...existingGraphSteps, ...newGraphSteps]
      });

      // Insert step rows
      for (const { id, input, stepIndex, stepKey } of stepEntries) {
        const explicitLaneId = toOptionalNonEmptyString(input.laneId);
        const effectiveLaneId = explicitLaneId ?? missionLaneId;
        const policy: Record<string, unknown> = {
          ...(typeof input.policy?.docsMaxBytes === "number" ? { docsMaxBytes: Math.floor(input.policy.docsMaxBytes) } : {}),
          claimScopes: Array.isArray(input.policy?.claimScopes)
            ? input.policy?.claimScopes?.map((scope) => ({
                scopeKind: scope.scopeKind,
                scopeValue: scope.scopeValue,
                ...(typeof scope.ttlMs === "number" ? { ttlMs: Math.floor(scope.ttlMs) } : {})
              }))
            : []
        };
        const metadataJson = JSON.stringify({
          ...(input.metadata ?? {}),
          ...(input.executorKind ? { executorKind: input.executorKind } : {}),
          policy
        });
        db.run(
          `
            insert into orchestrator_steps(
              id,
              run_id,
              project_id,
              mission_step_id,
              step_key,
              step_index,
              title,
              lane_id,
              status,
              join_policy,
              quorum_count,
              dependency_step_ids_json,
              retry_limit,
              retry_count,
              last_attempt_id,
              policy_json,
              metadata_json,
              created_at,
              updated_at,
              started_at,
              completed_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, '[]', ?, 0, null, ?, ?, ?, ?, null, null)
          `,
          [
            id,
            runId,
            projectId,
            input.missionStepId ?? null,
            stepKey,
            stepIndex,
            input.title.trim() || stepKey,
            effectiveLaneId,
            input.joinPolicy ?? "all_success",
            input.quorumCount ?? null,
            Math.max(0, Math.floor(input.retryLimit ?? 0)),
            JSON.stringify(policy),
            metadataJson,
            createdAt,
            createdAt
          ]
        );
        appendTimelineEvent({
          runId,
          stepId: id,
          eventType: "step_registered",
          reason: "add_steps",
          detail: {
            stepKey,
            stepIndex,
            joinPolicy: input.joinPolicy ?? "all_success",
            retryLimit: Math.max(0, Math.floor(input.retryLimit ?? 0)),
            laneId: effectiveLaneId,
          }
        });
      }

      // Resolve dependency IDs from keys (can reference both existing and new steps)
      const combinedKeyToId = new Map([...existingKeyToId, ...newKeyToId]);
      for (const { id, stepKey } of stepEntries) {
        const depKeys = dependencyStepKeysByNewStepKey.get(stepKey) ?? [];
        const depIds = depKeys.map((key) => {
          const depId = combinedKeyToId.get(key);
          if (!depId) {
            throw new Error(`Unknown dependency stepKey '${key}' referenced by step '${stepKey}'.`);
          }
          return depId;
        });
        db.run(
          `
            update orchestrator_steps
            set dependency_step_ids_json = ?,
                updated_at = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [JSON.stringify(depIds), createdAt, id, runId, projectId]
        );
        appendTimelineEvent({
          runId,
          stepId: id,
          eventType: "step_dependencies_resolved",
          reason: "add_steps",
          detail: { dependencyStepIds: depIds }
        });
      }

      // Re-evaluate readiness and emit
      refreshStepReadiness(runId);
      emit({ type: "orchestrator-run-updated", runId, reason: "steps_added" });

      return stepEntries.map(({ id }) => {
        const row = getStepRow(id);
        if (!row) throw new Error(`Step not found after insertion: ${id}`);
        return toStep(row);
      });
    },

    /**
     * Like addSteps, but allows adding steps to a terminal (succeeded/failed) run.
     * Transitions the run back to "active" before inserting steps, enabling
     * post-completion workflows like conflict resolution workers.
     */
    addPostCompletionSteps(args: {
      runId: string;
      steps: StartOrchestratorRunStepInput[];
    }): OrchestratorStep[] {
      const runId = String(args.runId ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);

      // If the run is terminal, transition back to active so new steps can be scheduled
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        updateRunStatus(runId, "active");
        appendTimelineEvent({
          runId,
          eventType: "run_reopened",
          reason: "post_completion_steps",
          detail: { previousStatus: run.status, newStepCount: args.steps.length }
        });
        emit({ type: "orchestrator-run-updated", runId, reason: "run_reopened" });
      }

      // Delegate to addSteps which now operates on a non-terminal run
      return this.addSteps(args);
    },

    // ─── Fan-out Step Injection ────────────────────────────────────

    /**
     * Execute an external_parallel fan-out: create child steps from subtasks,
     * wire them to depend on the parent step, and update any downstream
     * successor steps to depend on ALL children (fan-in).
     */
    executeFanOutExternal(args: {
      runId: string;
      parentStepKey: string;
      decision: FanOutDecision;
    }): OrchestratorStep[] {
      const { runId, parentStepKey, decision } = args;
      if (!decision.subtasks.length) return [];

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const existingSteps = listStepRows(runId).map(toStep);
      const maxIndex = existingSteps.reduce((max, s) => Math.max(max, s.stepIndex), -1);

      // Find successor steps that depend on the parent
      const parentStep = existingSteps.find((s) => s.stepKey === parentStepKey);
      const parentId = parentStep?.id;
      const successorSteps = parentId
        ? existingSteps.filter((s) => s.dependencyStepIds.includes(parentId))
        : [];

      // Create child steps
      const childStepKeys: string[] = [];
      const childStepInputs: StartOrchestratorRunStepInput[] = decision.subtasks.map((subtask, i) => {
        const childKey = `${parentStepKey}_fanout_${i}`;
        childStepKeys.push(childKey);
        return {
          stepKey: childKey,
          title: subtask.title,
          stepIndex: maxIndex + 1 + i,
          dependencyStepKeys: [parentStepKey],
          retryLimit: 1,
          metadata: {
            fanOutParent: parentStepKey,
            fanOutStrategy: decision.strategy,
            instructions: subtask.instructions,
            files: subtask.files,
            complexity: subtask.complexity,
            ...(subtask.estimatedTokens != null ? { estimatedTokens: subtask.estimatedTokens } : {})
          }
        };
      });

      const createdSteps = this.addSteps({ runId, steps: childStepInputs });

      // Update parent step metadata with fan-out tracking
      if (parentStep) {
        const parentMeta = (parentStep.metadata ?? {}) as Record<string, unknown>;
        const updatedMeta = {
          ...parentMeta,
          fanOut: { ...(typeof parentMeta.fanOut === "object" && parentMeta.fanOut ? parentMeta.fanOut : {}), enabled: true, maxChildren: 8 },
          fanOutChildren: childStepKeys,
          fanOutStrategy: decision.strategy,
          fanOutComplete: false
        };
        db.run(
          `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ? and project_id = ?`,
          [JSON.stringify(updatedMeta), nowIso(), parentStep.id, runId, projectId]
        );
      }

      // Rewire successors: each successor now depends on ALL children instead of the parent
      for (const successor of successorSteps) {
        const existingDepKeys = successor.dependencyStepIds
          .map((depId) => existingSteps.find((s) => s.id === depId)?.stepKey)
          .filter((key): key is string => key != null);
        // Replace the parent key with all child keys
        const newDepKeys = existingDepKeys
          .filter((key) => key !== parentStepKey)
          .concat(childStepKeys);
        this.updateStepDependencies({
          runId,
          stepId: successor.id,
          dependencyStepKeys: newDepKeys
        });
      }

      appendTimelineEvent({
        runId,
        stepId: parentStep?.id ?? null,
        eventType: "fan_out_dispatched",
        reason: "external_parallel",
        detail: {
          parentStepKey,
          strategy: decision.strategy,
          childCount: createdSteps.length,
          childStepKeys,
          reasoning: decision.reasoning
        }
      });

      return createdSteps;
    },

    /**
     * Execute a hybrid fan-out: group subtasks into clusters, each cluster
     * becomes one external agent. Within each cluster, the agent handles
     * multiple subtasks using internal parallelism.
     */
    executeFanOutHybrid(args: {
      runId: string;
      parentStepKey: string;
      decision: FanOutDecision;
    }): OrchestratorStep[] {
      const { runId, parentStepKey, decision } = args;
      if (!decision.subtasks.length || !decision.clusters?.length) {
        // Fallback to external parallel if no clusters defined
        return this.executeFanOutExternal(args);
      }

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const existingSteps = listStepRows(runId).map(toStep);
      const maxIndex = existingSteps.reduce((max, s) => Math.max(max, s.stepIndex), -1);

      const parentStep = existingSteps.find((s) => s.stepKey === parentStepKey);
      const parentId = parentStep?.id;
      const successorSteps = parentId
        ? existingSteps.filter((s) => s.dependencyStepIds.includes(parentId))
        : [];

      // Create one step per cluster
      const childStepKeys: string[] = [];
      const childStepInputs: StartOrchestratorRunStepInput[] = decision.clusters.map((cluster, clusterIdx) => {
        const childKey = `${parentStepKey}_fanout_cluster_${clusterIdx}`;
        childStepKeys.push(childKey);
        const clusterSubtasks = cluster.subtaskIndices
          .filter((i) => i >= 0 && i < decision.subtasks.length)
          .map((i) => decision.subtasks[i]);
        const combinedInstructions = clusterSubtasks
          .map((st, j) => `## Subtask ${j + 1}: ${st.title}\n${st.instructions}`)
          .join("\n\n");
        const allFiles = [...new Set(clusterSubtasks.flatMap((st) => st.files))];
        return {
          stepKey: childKey,
          title: `Cluster ${clusterIdx + 1}: ${cluster.reason || clusterSubtasks.map((s) => s.title).join(", ")}`,
          stepIndex: maxIndex + 1 + clusterIdx,
          dependencyStepKeys: [parentStepKey],
          retryLimit: 1,
          metadata: {
            fanOutParent: parentStepKey,
            fanOutStrategy: "hybrid",
            clusterIndex: clusterIdx,
            clusterReason: cluster.reason,
            instructions: combinedInstructions,
            files: allFiles,
            subtaskCount: clusterSubtasks.length
          }
        };
      });

      const createdSteps = this.addSteps({ runId, steps: childStepInputs });

      // Update parent metadata
      if (parentStep) {
        const parentMeta = (parentStep.metadata ?? {}) as Record<string, unknown>;
        const updatedMeta = {
          ...parentMeta,
          fanOut: { ...(typeof parentMeta.fanOut === "object" && parentMeta.fanOut ? parentMeta.fanOut : {}), enabled: true, maxChildren: 8 },
          fanOutChildren: childStepKeys,
          fanOutStrategy: "hybrid",
          fanOutComplete: false
        };
        db.run(
          `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ? and project_id = ?`,
          [JSON.stringify(updatedMeta), nowIso(), parentStep.id, runId, projectId]
        );
      }

      // Rewire successors to depend on all cluster steps
      for (const successor of successorSteps) {
        const existingDepKeys = successor.dependencyStepIds
          .map((depId) => existingSteps.find((s) => s.id === depId)?.stepKey)
          .filter((key): key is string => key != null);
        const newDepKeys = existingDepKeys
          .filter((key) => key !== parentStepKey)
          .concat(childStepKeys);
        this.updateStepDependencies({
          runId,
          stepId: successor.id,
          dependencyStepKeys: newDepKeys
        });
      }

      appendTimelineEvent({
        runId,
        stepId: parentStep?.id ?? null,
        eventType: "fan_out_dispatched",
        reason: "hybrid",
        detail: {
          parentStepKey,
          strategy: "hybrid",
          clusterCount: createdSteps.length,
          childStepKeys,
          reasoning: decision.reasoning
        }
      });

      return createdSteps;
    },

    /**
     * Check if all fan-out children of a parent step have completed.
     * If so, mark fanOutComplete on the parent and emit a timeline event.
     */
    checkFanOutCompletion(args: { runId: string; completedStepKey: string }): boolean {
      const { runId, completedStepKey } = args;
      const allSteps = listStepRows(runId).map(toStep);
      const completedStep = allSteps.find((s) => s.stepKey === completedStepKey);
      if (!completedStep) return false;

      // Find the parent via fanOutParent in metadata
      const meta = (completedStep.metadata ?? {}) as Record<string, unknown>;
      const parentStepKey = meta.fanOutParent as string | undefined;
      if (!parentStepKey) return false;

      const parentStep = allSteps.find((s) => s.stepKey === parentStepKey);
      if (!parentStep) return false;

      const parentMeta = (parentStep.metadata ?? {}) as Record<string, unknown>;
      const childKeys = parentMeta.fanOutChildren as string[] | undefined;
      if (!Array.isArray(childKeys) || childKeys.length === 0) return false;

      // Check if all children are in a terminal state
      const terminalStatuses = new Set<string>(["succeeded", "failed", "skipped", "superseded", "canceled"]);
      const allDone = childKeys.every((key) => {
        const child = allSteps.find((s) => s.stepKey === key);
        return child && terminalStatuses.has(child.status);
      });

      if (allDone && parentMeta.fanOutComplete !== true) {
        const updatedMeta = { ...parentMeta, fanOutComplete: true };
        const now = nowIso();
        const succeededCount = childKeys.filter((key) => allSteps.find((s) => s.stepKey === key)?.status === "succeeded").length;
        const failedCount = childKeys.filter((key) => allSteps.find((s) => s.stepKey === key)?.status === "failed").length;

        // VAL-STATE-002: Update parent step status to reflect variant outcomes.
        // If any child succeeded → parent succeeded; if all failed → parent failed.
        const parentTerminalStatus = succeededCount > 0 ? "succeeded" : "failed";
        db.run(
          `update orchestrator_steps set status = ?, metadata_json = ?, updated_at = ?, completed_at = coalesce(completed_at, ?) where id = ? and run_id = ? and project_id = ?`,
          [parentTerminalStatus, JSON.stringify(updatedMeta), now, now, parentStep.id, runId, projectId]
        );
        appendTimelineEvent({
          runId,
          stepId: parentStep.id,
          eventType: "fan_out_complete",
          reason: "all_children_done",
          detail: {
            parentStepKey,
            childKeys,
            childCount: childKeys.length,
            succeeded: succeededCount,
            failed: failedCount,
            parentTerminalStatus,
          }
        });
        emit({ type: "orchestrator-step-updated", runId, stepId: parentStep.id, reason: "fan_out_complete" });
        return true;
      }

      return false;
    },

    skipStep(args: {
      runId: string;
      stepId: string;
      reason?: string;
    }): OrchestratorStep {
      const runId = String(args.runId ?? "").trim();
      const stepId = String(args.stepId ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      if (!stepId) throw new Error("stepId is required.");

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new Error(`Cannot skip step in a terminal run (status: ${run.status}).`);
      }

      const stepRow = getStepRow(stepId);
      if (!stepRow || stepRow.run_id !== runId) throw new Error(`Step not found in run: ${stepId}`);
      const step = toStep(stepRow);
      if (TERMINAL_STEP_STATUSES.has(step.status)) {
        throw new Error(`Step is already terminal (status: ${step.status}).`);
      }

      const now = nowIso();
      const reason = args.reason?.trim() || "Manually skipped.";
      db.run(
        `
          update orchestrator_steps
          set status = 'skipped',
              updated_at = ?,
              completed_at = ?
          where id = ?
            and run_id = ?
            and project_id = ?
        `,
        [now, now, stepId, runId, projectId]
      );

      appendTimelineEvent({
        runId,
        stepId,
        eventType: "step_skipped",
        reason: "skip_step",
        detail: { reason }
      });
      emit({ type: "orchestrator-step-updated", runId, stepId, reason: "skipped" });

      // Re-evaluate downstream steps that may now be unblocked
      refreshStepReadiness(runId);

      // Re-derive run status using policy-aware evaluation
      const nextRunStatus = evaluateRunStatusWithPolicy(runId);
      const currentRunStatus = normalizeRunStatus(runRow.status);
      if (nextRunStatus !== currentRunStatus) {
        updateRunStatus(runId, nextRunStatus);
      }

      const updatedRow = getStepRow(stepId);
      if (!updatedRow) throw new Error(`Step not found after skip: ${stepId}`);
      return toStep(updatedRow);
    },

    async supersedeStep(args: {
      runId: string;
      stepId: string;
      replacementStepId?: string | null;
      replacementStepKey?: string | null;
      reason?: string;
    }): Promise<OrchestratorStep> {
      const runId = String(args.runId ?? "").trim();
      const stepId = String(args.stepId ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      if (!stepId) throw new Error("stepId is required.");

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new Error(`Cannot supersede step in a terminal run (status: ${run.status}).`);
      }

      const stepRow = getStepRow(stepId);
      if (!stepRow || stepRow.run_id !== runId) throw new Error(`Step not found in run: ${stepId}`);
      const step = toStep(stepRow);
      if (step.status === "superseded") return step;
      if (TERMINAL_STEP_STATUSES.has(step.status)) {
        throw new Error(`Step is already terminal (status: ${step.status}).`);
      }

      const runningAttempts = listAttemptRows(runId)
        .filter((attempt) => attempt.step_id === stepId && attempt.status === "running")
        .map(toAttempt);
      for (const runningAttempt of runningAttempts) {
        await this.completeAttempt({
          attemptId: runningAttempt.id,
          status: "canceled",
          errorClass: "canceled",
          errorMessage: "Step superseded by plan revision."
        });
      }

      const now = nowIso();
      const reason = args.reason?.trim() || "Superseded by revised plan.";
      const replacementStepId = args.replacementStepId ? String(args.replacementStepId).trim() : null;
      const replacementStepKey = args.replacementStepKey ? String(args.replacementStepKey).trim() : null;
      const existingMeta =
        step.metadata && typeof step.metadata === "object" && !Array.isArray(step.metadata)
          ? (step.metadata as Record<string, unknown>)
          : {};
      const metadata = {
        ...existingMeta,
        superseded: true,
        supersededAt: now,
        supersededReason: reason,
        supersededByStepId: replacementStepId,
        supersededByStepKey: replacementStepKey,
        priorStatus: step.status
      };

      db.run(
        `
          update orchestrator_steps
          set status = 'superseded',
              metadata_json = ?,
              updated_at = ?,
              completed_at = ?
          where id = ?
            and run_id = ?
            and project_id = ?
        `,
        [JSON.stringify(metadata), now, now, stepId, runId, projectId]
      );

      insertHandoff({
        missionId: run.missionId,
        missionStepId: step.missionStepId,
        runId: run.id,
        stepId: step.id,
        attemptId: null,
        handoffType: "step_superseded",
        producer: "coordinator",
        payload: {
          reason,
          replacementStepId,
          replacementStepKey
        }
      });

      appendTimelineEvent({
        runId,
        stepId,
        eventType: "step_superseded",
        reason: "supersede_step",
        detail: {
          reason,
          replacementStepId,
          replacementStepKey
        }
      });
      emit({ type: "orchestrator-step-updated", runId, stepId, reason: "superseded" });

      refreshStepReadiness(runId);
      const nextRunStatus = evaluateRunStatusWithPolicy(runId);
      const currentRunStatus = normalizeRunStatus(runRow.status);
      if (nextRunStatus !== currentRunStatus) {
        updateRunStatus(runId, nextRunStatus);
      }

      const updatedRow = getStepRow(stepId);
      if (!updatedRow) throw new Error(`Step not found after supersede: ${stepId}`);
      return toStep(updatedRow);
    },

    transferStepLane(args: {
      runId: string;
      stepId: string;
      laneId: string | null;
      reason: string;
      transferredBy?: string;
      allowTerminal?: boolean;
    }): OrchestratorStep {
      const runId = String(args.runId ?? "").trim();
      const stepId = String(args.stepId ?? "").trim();
      const laneId = args.laneId == null ? null : String(args.laneId).trim();
      const reason = String(args.reason ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      if (!stepId) throw new Error("stepId is required.");
      if (!reason) throw new Error("reason is required.");

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new Error(`Cannot transfer lane in a terminal run (status: ${run.status}).`);
      }

      const stepRow = getStepRow(stepId);
      if (!stepRow || stepRow.run_id !== runId) throw new Error(`Step not found in run: ${stepId}`);
      const step = toStep(stepRow);
      if (TERMINAL_STEP_STATUSES.has(step.status) && args.allowTerminal !== true) {
        throw new Error(`Step is already terminal (status: ${step.status}).`);
      }
      if ((step.laneId ?? null) === laneId) {
        return step;
      }
      if (laneId) {
        const laneExists = db.get<{ id: string }>(
          `select id from lanes where id = ? and project_id = ? limit 1`,
          [laneId, projectId]
        );
        if (!laneExists?.id) {
          throw new Error(`Lane not found: ${laneId}`);
        }
      }

      const now = nowIso();
      const actor = args.transferredBy?.trim() || "coordinator";
      const existingMeta =
        step.metadata && typeof step.metadata === "object" && !Array.isArray(step.metadata)
          ? (step.metadata as Record<string, unknown>)
          : {};
      const history = Array.isArray(existingMeta.laneTransferHistory)
        ? [...existingMeta.laneTransferHistory]
        : [];
      history.push({
        fromLaneId: step.laneId ?? null,
        toLaneId: laneId,
        reason,
        transferredBy: actor,
        at: now
      });
      const metadata = {
        ...existingMeta,
        laneTransferHistory: history.slice(-20),
        laneTransferReason: reason,
        lastTransferredBy: actor,
        lastTransferredAt: now
      };

      db.run(
        `
          update orchestrator_steps
          set lane_id = ?,
              metadata_json = ?,
              updated_at = ?
          where id = ?
            and run_id = ?
            and project_id = ?
        `,
        [laneId, JSON.stringify(metadata), now, stepId, runId, projectId]
      );

      insertHandoff({
        missionId: run.missionId,
        missionStepId: step.missionStepId,
        runId: run.id,
        stepId: step.id,
        attemptId: null,
        handoffType: "lane_transfer",
        producer: actor,
        payload: {
          fromLaneId: step.laneId ?? null,
          toLaneId: laneId,
          reason
        }
      });

      appendTimelineEvent({
        runId,
        stepId,
        eventType: "lane_transfer",
        reason: "transfer_step_lane",
        detail: {
          fromLaneId: step.laneId ?? null,
          toLaneId: laneId,
          reason,
          transferredBy: actor
        }
      });
      emit({ type: "orchestrator-step-updated", runId, stepId, reason: "lane_transferred" });

      const updatedRow = getStepRow(stepId);
      if (!updatedRow) throw new Error(`Step not found after lane transfer: ${stepId}`);
      return toStep(updatedRow);
    },

    // ─── Step Dependency & Consolidation ──────────────────────────

    updateStepDependencies(args: {
      runId: string;
      stepId: string;
      dependencyStepKeys: string[];
    }): OrchestratorStep {
      const runId = String(args.runId ?? "").trim();
      const stepId = String(args.stepId ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      if (!stepId) throw new Error("stepId is required.");

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new Error(`Cannot update step dependencies in a terminal run (status: ${run.status}).`);
      }

      const stepRow = getStepRow(stepId);
      if (!stepRow || stepRow.run_id !== runId) throw new Error(`Step not found in run: ${stepId}`);
      const step = toStep(stepRow);
      if (TERMINAL_STEP_STATUSES.has(step.status)) {
        throw new Error(`Step is already terminal (status: ${step.status}).`);
      }

      // Build key<->id maps from all steps in this run
      const allStepRows = listStepRows(runId);
      const allSteps = allStepRows.map(toStep);
      const keyToId = new Map<string, string>();
      const idToKey = new Map<string, string>();
      for (const s of allSteps) {
        keyToId.set(s.stepKey, s.id);
        idToKey.set(s.id, s.stepKey);
      }

      // Normalize and resolve dependency keys to IDs
      const dependencyStepKeys = normalizeDependencyStepKeys(args.dependencyStepKeys);
      const depIds = dependencyStepKeys.map((key) => {
        const depId = keyToId.get(key);
        if (!depId) {
          throw new Error(`Unknown dependency stepKey '${key}' referenced by step '${step.stepKey}'.`);
        }
        return depId;
      });

      // Validate the full graph with updated dependencies
      const graphSteps: StepGraphValidationStep[] = allSteps.map((s) => ({
        stepKey: s.stepKey,
        dependencyStepKeys: s.id === stepId
          ? dependencyStepKeys
          : s.dependencyStepIds
              .map((depId) => idToKey.get(depId) ?? "")
              .filter((depKey): depKey is string => depKey.length > 0),
        joinPolicy: s.joinPolicy,
        quorumCount: s.quorumCount
      }));
      validateStepGraphIntegrity({
        context: "updateStepDependencies",
        steps: graphSteps
      });

      // Persist the updated dependency list
      const now = nowIso();
      db.run(
        `
          update orchestrator_steps
          set dependency_step_ids_json = ?,
              updated_at = ?
          where id = ?
            and run_id = ?
            and project_id = ?
        `,
        [JSON.stringify(depIds), now, stepId, runId, projectId]
      );

      appendTimelineEvent({
        runId,
        stepId,
        eventType: "step_dependencies_updated",
        reason: "update_step_dependencies",
        detail: { dependencyStepKeys, dependencyStepIds: depIds }
      });
      emit({ type: "orchestrator-step-updated", runId, stepId, reason: "dependencies_updated" });

      // Refresh readiness so newly-unblocked steps can proceed
      refreshStepReadiness(runId);

      const resultRow = getStepRow(stepId);
      if (!resultRow) throw new Error(`Step not found after dependency update: ${stepId}`);
      return toStep(resultRow);
    },

    consolidateSteps(args: {
      runId: string;
      keepStepId: string;
      removeStepId: string;
      mergedInstructions: string;
    }): OrchestratorStep {
      const runId = String(args.runId ?? "").trim();
      const keepStepId = String(args.keepStepId ?? "").trim();
      const removeStepId = String(args.removeStepId ?? "").trim();
      const mergedInstructions = String(args.mergedInstructions ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      if (!keepStepId) throw new Error("keepStepId is required.");
      if (!removeStepId) throw new Error("removeStepId is required.");
      if (!mergedInstructions) throw new Error("mergedInstructions is required.");
      if (keepStepId === removeStepId) throw new Error("keepStepId and removeStepId must be different.");

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new Error(`Cannot consolidate steps in a terminal run (status: ${run.status}).`);
      }

      const keepRow = getStepRow(keepStepId);
      if (!keepRow || keepRow.run_id !== runId) throw new Error(`Keep step not found in run: ${keepStepId}`);
      const keepStep = toStep(keepRow);
      if (TERMINAL_STEP_STATUSES.has(keepStep.status)) {
        throw new Error(`Keep step is already terminal (status: ${keepStep.status}).`);
      }

      const removeRow = getStepRow(removeStepId);
      if (!removeRow || removeRow.run_id !== runId) throw new Error(`Remove step not found in run: ${removeStepId}`);
      const removeStep = toStep(removeRow);
      if (TERMINAL_STEP_STATUSES.has(removeStep.status)) {
        throw new Error(`Remove step is already terminal (status: ${removeStep.status}).`);
      }

      const now = nowIso();

      // Build key<->id maps from all steps in this run
      const allStepRows = listStepRows(runId);
      const allSteps = allStepRows.map(toStep);
      const idToKey = new Map<string, string>();
      for (const s of allSteps) {
        idToKey.set(s.id, s.stepKey);
      }

      // 1. Skip the removeStep with a consolidation reason
      db.run(
        `
          update orchestrator_steps
          set status = 'skipped',
              updated_at = ?,
              completed_at = ?
          where id = ?
            and run_id = ?
            and project_id = ?
        `,
        [now, now, removeStepId, runId, projectId]
      );
      appendTimelineEvent({
        runId,
        stepId: removeStepId,
        eventType: "step_skipped",
        reason: "consolidate_steps",
        detail: { reason: `consolidated into ${keepStep.stepKey}` }
      });
      emit({ type: "orchestrator-step-updated", runId, stepId: removeStepId, reason: "skipped" });

      // 2. Update keepStep metadata with merged instructions
      const keepMeta: Record<string, unknown> = parseJsonRecord(keepRow.metadata_json) ?? {};
      keepMeta.mergedInstructions = mergedInstructions;
      keepMeta.consolidatedFrom = removeStep.stepKey;
      db.run(
        `
          update orchestrator_steps
          set metadata_json = ?,
              updated_at = ?
          where id = ?
            and run_id = ?
            and project_id = ?
        `,
        [JSON.stringify(keepMeta), now, keepStepId, runId, projectId]
      );
      appendTimelineEvent({
        runId,
        stepId: keepStepId,
        eventType: "step_consolidated",
        reason: "consolidate_steps",
        detail: { mergedInstructions, consolidatedFrom: removeStep.stepKey }
      });
      emit({ type: "orchestrator-step-updated", runId, stepId: keepStepId, reason: "consolidated" });

      // 3. Re-wire dependencies: any step that depended on removeStepId now depends on keepStepId
      for (const s of allSteps) {
        if (s.id === removeStepId || s.id === keepStepId) continue;
        if (!s.dependencyStepIds.includes(removeStepId)) continue;

        const updatedDepIds = s.dependencyStepIds.map((depId) =>
          depId === removeStepId ? keepStepId : depId
        );
        // De-duplicate in case the step already depended on keepStepId
        const uniqueDepIds = [...new Set(updatedDepIds)];

        db.run(
          `
            update orchestrator_steps
            set dependency_step_ids_json = ?,
                updated_at = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [JSON.stringify(uniqueDepIds), now, s.id, runId, projectId]
        );
        appendTimelineEvent({
          runId,
          stepId: s.id,
          eventType: "step_dependencies_updated",
          reason: "consolidate_steps",
          detail: {
            previousDependencyStepIds: s.dependencyStepIds,
            updatedDependencyStepIds: uniqueDepIds,
            rewiredFrom: removeStep.stepKey,
            rewiredTo: keepStep.stepKey
          }
        });
      }

      // 4. Validate the full graph after all changes
      const postAllSteps = listStepRows(runId).map(toStep);
      const postIdToKey = new Map<string, string>();
      for (const s of postAllSteps) {
        postIdToKey.set(s.id, s.stepKey);
      }
      const graphSteps: StepGraphValidationStep[] = postAllSteps
        .filter((s) => !TERMINAL_STEP_STATUSES.has(s.status))
        .map((s) => ({
          stepKey: s.stepKey,
          dependencyStepKeys: s.dependencyStepIds
            .map((depId) => postIdToKey.get(depId) ?? "")
            .filter((depKey): depKey is string => depKey.length > 0),
          joinPolicy: s.joinPolicy,
          quorumCount: s.quorumCount
        }));
      // Include terminal steps that are referenced as dependencies
      const nonTerminalKeys = new Set(graphSteps.map((s) => s.stepKey));
      for (const s of postAllSteps) {
        if (!nonTerminalKeys.has(s.stepKey)) {
          graphSteps.push({
            stepKey: s.stepKey,
            dependencyStepKeys: [],
            joinPolicy: s.joinPolicy,
            quorumCount: s.quorumCount
          });
        }
      }
      validateStepGraphIntegrity({
        context: "consolidateSteps",
        steps: graphSteps
      });

      // 5. Refresh readiness and re-evaluate run status
      refreshStepReadiness(runId);

      const nextRunStatus = evaluateRunStatusWithPolicy(runId);
      const currentRunStatus = normalizeRunStatus(runRow.status);
      if (nextRunStatus !== currentRunStatus) {
        updateRunStatus(runId, nextRunStatus);
      }

      const resultRow = getStepRow(keepStepId);
      if (!resultRow) throw new Error(`Keep step not found after consolidation: ${keepStepId}`);
      return toStep(resultRow);
    },

    updateStepMetadata(args: {
      runId: string;
      stepId: string;
      metadata: Record<string, unknown>;
      allowTerminal?: boolean;
    }): OrchestratorStep {
      const runId = String(args.runId ?? "").trim();
      const stepId = String(args.stepId ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      if (!stepId) throw new Error("stepId is required.");

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new Error(`Cannot update step metadata in a terminal run (status: ${run.status}).`);
      }

      const stepRow = getStepRow(stepId);
      if (!stepRow || stepRow.run_id !== runId) throw new Error(`Step not found in run: ${stepId}`);
      const step = toStep(stepRow);
      if (!args.allowTerminal && TERMINAL_STEP_STATUSES.has(step.status)) {
        throw new Error(`Step is already terminal (status: ${step.status}).`);
      }

      const existingMeta = (step.metadata && typeof step.metadata === "object" && !Array.isArray(step.metadata)) ? step.metadata as Record<string, unknown> : {};
      const mergedMeta = { ...existingMeta, ...args.metadata };

      const now = nowIso();
      db.run(
        `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ? and project_id = ?`,
        [JSON.stringify(mergedMeta), now, stepId, runId, projectId]
      );

      appendTimelineEvent({
        runId,
        stepId,
        eventType: "step_metadata_updated",
        reason: "update_step_metadata",
        detail: { updatedKeys: Object.keys(args.metadata) }
      });
      emit({ type: "orchestrator-step-updated", runId, stepId, reason: "metadata_updated" });

      const updatedRow = getStepRow(stepId);
      if (!updatedRow) throw new Error(`Step not found after metadata update: ${stepId}`);
      return toStep(updatedRow);
    },

    updateStepExecutorKind(args: {
      runId: string;
      stepId: string;
      executorKind: string;
    }): OrchestratorStep {
      const runId = String(args.runId ?? "").trim();
      const stepId = String(args.stepId ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      if (!stepId) throw new Error("stepId is required.");

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      if (TERMINAL_RUN_STATUSES.has(toRun(runRow).status)) {
        throw new Error(`Cannot update step in a terminal run.`);
      }

      const stepRow = getStepRow(stepId);
      if (!stepRow || stepRow.run_id !== runId) throw new Error(`Step not found in run: ${stepId}`);
      if (TERMINAL_STEP_STATUSES.has(toStep(stepRow).status)) {
        throw new Error(`Step is already terminal (status: ${toStep(stepRow).status}).`);
      }

      const now = nowIso();
      db.run(
        `update orchestrator_steps set executor_kind = ?, updated_at = ? where id = ? and run_id = ? and project_id = ?`,
        [args.executorKind, now, stepId, runId, projectId]
      );
      appendTimelineEvent({
        runId,
        stepId,
        eventType: "step_metadata_updated",
        reason: "executor_kind_updated",
        detail: { newExecutorKind: args.executorKind }
      });
      emit({ type: "orchestrator-step-updated", runId, stepId, reason: "executor_kind_updated" });

      const result = getStepRow(stepId);
      if (!result) throw new Error(`Step not found after executor kind update: ${stepId}`);
      return toStep(result);
    },

    // ─── Recovery Loop ────────────────────────────────────────────

    triggerRecoveryLoop(args: {
      runId: string;
      failedStepId: string;
      failurePhase: string;
      failureReason: string;
    }): { action: "fix"; fixStepId: string; recheckStepId: string } | { action: "stop"; reason: string } {
      const runId = String(args.runId ?? "").trim();
      const failedStepId = String(args.failedStepId ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      if (!failedStepId) throw new Error("failedStepId is required.");

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);

      // Resolve recovery policy from run metadata or use default
      let policy: RecoveryLoopPolicy = DEFAULT_RECOVERY_LOOP_POLICY;
      if (runRow.metadata_json) {
        try {
          const meta = JSON.parse(runRow.metadata_json);
          if (meta?.recoveryLoop && typeof meta.recoveryLoop === "object") {
            policy = { ...DEFAULT_RECOVERY_LOOP_POLICY, ...meta.recoveryLoop };
          }
        } catch {
          // fall through to default
        }
      }

      if (!policy.enabled) {
        return { action: "stop", reason: "Recovery loops are disabled by policy." };
      }

      // Get or create recovery loop state for this run
      let state = recoveryLoopStates.get(runId);
      if (!state) {
        state = {
          runId,
          iterations: [],
          currentIteration: 0,
          exhausted: false,
          stopReason: null
        };
        recoveryLoopStates.set(runId, state);
      }

      // Check if max iterations reached
      if (state.currentIteration >= policy.maxIterations) {
        state.exhausted = true;
        state.stopReason = `Max recovery iterations reached (${policy.maxIterations}). onExhaustion=${policy.onExhaustion}`;
        appendTimelineEvent({
          runId,
          stepId: failedStepId,
          eventType: "recovery_loop_exhausted",
          reason: "max_iterations",
          detail: {
            maxIterations: policy.maxIterations,
            onExhaustion: policy.onExhaustion,
            failurePhase: args.failurePhase,
            failureReason: args.failureReason
          }
        });
        return { action: "stop", reason: state.stopReason };
      }

      // Create new iteration
      const iterationNum = state.currentIteration + 1;
      const now = nowIso();

      // Insert fix step
      const fixStepId = randomUUID();
      const fixStepKey = `recovery_fix_${iterationNum}`;
      const existingStepRows = listStepRows(runId);
      const maxIndex = existingStepRows.reduce((max, row) => Math.max(max, row.step_index), -1);

      db.run(
        `
          insert into orchestrator_steps(
            id, run_id, project_id, mission_step_id, step_key, step_index,
            title, lane_id, status, join_policy, quorum_count,
            dependency_step_ids_json, retry_limit, retry_count, last_attempt_id,
            policy_json, metadata_json, created_at, updated_at, started_at, completed_at
          ) values (?, ?, ?, null, ?, ?, ?, null, 'pending', 'all_success', null, ?, 1, 0, null, '{}', ?, ?, ?, null, null)
        `,
        [
          fixStepId,
          runId,
          projectId,
          fixStepKey,
          maxIndex + 1,
          `Recovery fix (iteration ${iterationNum})`,
          JSON.stringify([failedStepId]),
          JSON.stringify({
            stepType: "implementation",
            recoveryIteration: iterationNum,
            failedStepId,
            failurePhase: args.failurePhase,
            failureReason: args.failureReason,
            instructions: `Fix the issues found in step ${failedStepId}: ${args.failureReason}`
          }),
          now,
          now
        ]
      );

      // Insert re-review step dependent on the fix step
      const recheckStepId = randomUUID();
      const recheckStepKey = `recovery_recheck_${iterationNum}`;

      db.run(
        `
          insert into orchestrator_steps(
            id, run_id, project_id, mission_step_id, step_key, step_index,
            title, lane_id, status, join_policy, quorum_count,
            dependency_step_ids_json, retry_limit, retry_count, last_attempt_id,
            policy_json, metadata_json, created_at, updated_at, started_at, completed_at
          ) values (?, ?, ?, null, ?, ?, ?, null, 'pending', 'all_success', null, ?, 1, 0, null, '{}', ?, ?, ?, null, null)
        `,
        [
          recheckStepId,
          runId,
          projectId,
          recheckStepKey,
          maxIndex + 2,
          `Recovery re-review (iteration ${iterationNum})`,
          JSON.stringify([fixStepId]),
          JSON.stringify({
            stepType: "code_review",
            recoveryIteration: iterationNum,
            instructions: `Re-review the fix applied in recovery iteration ${iterationNum}. Verify the original issue is resolved.`
          }),
          now,
          now
        ]
      );

      // Record the iteration
      const iteration: RecoveryLoopIteration = {
        iteration: iterationNum,
        triggerStepId: failedStepId,
        triggerPhase: args.failurePhase,
        failureReason: args.failureReason,
        fixStepId,
        reReviewStepId: recheckStepId,
        reTestStepId: null,
        outcome: "still_failing",
        startedAt: now,
        completedAt: null
      };
      state.iterations.push(iteration);
      state.currentIteration = iterationNum;

      // Emit timeline events
      appendTimelineEvent({
        runId,
        stepId: failedStepId,
        eventType: "recovery_loop_started",
        reason: "quality_gate_failure",
        detail: {
          iteration: iterationNum,
          maxIterations: policy.maxIterations,
          failurePhase: args.failurePhase,
          failureReason: args.failureReason,
          fixStepId,
          recheckStepId
        }
      });
      emit({ type: "orchestrator-step-updated", runId, stepId: fixStepId, reason: "recovery_fix_inserted" });
      emit({ type: "orchestrator-step-updated", runId, stepId: recheckStepId, reason: "recovery_recheck_inserted" });

      refreshStepReadiness(runId);

      return { action: "fix", fixStepId, recheckStepId };
    },

    // ─── Context View for Role ────────────────────────────────────

    getContextViewForRole(args: {
      role: OrchestratorWorkerRole;
    }): ContextViewPolicy {
      const role = args.role;
      let viewKey: OrchestratorContextView;
      switch (role) {
        case "implementation":
        case "planning":
        case "integration":
          viewKey = "implementation";
          break;
        case "code_review":
          viewKey = "review";
          break;
        case "test_review":
        case "testing":
          viewKey = "test_review";
          break;
        default:
          viewKey = "implementation";
          break;
      }
      return DEFAULT_CONTEXT_VIEW_POLICIES[viewKey];
    },

    // ─── Role Isolation Validation ────────────────────────────────

    validateRunRoleIsolation(args: {
      runId: string;
    }): RoleIsolationValidation {
      const runId = String(args.runId ?? "").trim();
      if (!runId) throw new Error("runId is required.");

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);

      const stepRows = listStepRows(runId);
      const attemptRows = listAttemptRows(runId);

      // Group attempts by executor_session_id, collecting the role from step metadata
      const rolesBySession = new Map<string, Set<OrchestratorWorkerRole>>();
      const stepIdsBySession = new Map<string, Set<string>>();

      for (const attempt of attemptRows) {
        const sessionId = attempt.executor_session_id;
        if (!sessionId) continue;

        // Find the step for this attempt to determine its role
        const stepRow = stepRows.find((s) => s.id === attempt.step_id);
        if (!stepRow) continue;

        let role: OrchestratorWorkerRole | null = null;
        if (stepRow.metadata_json) {
          try {
            const meta = JSON.parse(stepRow.metadata_json);
            if (meta?.stepType) {
              role = meta.stepType as OrchestratorWorkerRole;
            }
            if (meta?.role) {
              role = meta.role as OrchestratorWorkerRole;
            }
          } catch {
            // skip
          }
        }
        if (!role) continue;

        if (!rolesBySession.has(sessionId)) {
          rolesBySession.set(sessionId, new Set());
          stepIdsBySession.set(sessionId, new Set());
        }
        rolesBySession.get(sessionId)!.add(role);
        stepIdsBySession.get(sessionId)!.add(stepRow.id);
      }

      // Check each session against isolation rules
      const violations: RoleIsolationValidation["violations"] = [];

      for (const [sessionId, roles] of rolesBySession) {
        for (const rule of DEFAULT_ROLE_ISOLATION_RULES) {
          const [roleA, roleB] = rule.mutuallyExclusive;
          if (roles.has(roleA) && roles.has(roleB)) {
            const affectedStepIds = Array.from(stepIdsBySession.get(sessionId) ?? []);
            violations.push({
              rule,
              affectedStepIds,
              correctionApplied: false,
              correctionDetail: `Session ${sessionId} has conflicting roles: ${roleA} and ${roleB}.`
            });
          }
        }
      }

      const result: RoleIsolationValidation = {
        valid: violations.length === 0,
        violations,
        correctedPlan: false
      };

      if (violations.length > 0) {
        appendTimelineEvent({
          runId,
          eventType: "role_isolation_violation",
          reason: "isolation_check",
          detail: {
            violationCount: violations.length,
            violations: violations.map((v) => ({
              roles: v.rule.mutuallyExclusive,
              enforcement: v.rule.enforcement,
              affectedStepIds: v.affectedStepIds,
              reason: v.rule.reason
            }))
          }
        });
      }

      return result;
    },

    // ─── Worker Checkpoint Persistence ──────────────────────────────

    upsertWorkerCheckpoint(args: {
      missionId: string;
      runId: string;
      stepId: string;
      attemptId: string;
      stepKey: string;
      content: string;
      filePath: string;
    }): OrchestratorWorkerCheckpoint {
      const now = nowIso();
      const existingRow = db.get<{ id: string }>(
        `select id from orchestrator_worker_checkpoints where mission_id = ? and step_key = ? and project_id = ? limit 1`,
        [args.missionId, args.stepKey, projectId]
      );
      if (existingRow) {
        db.run(
          `
            update orchestrator_worker_checkpoints
            set run_id = ?,
                step_id = ?,
                attempt_id = ?,
                content = ?,
                file_path = ?,
                updated_at = ?
            where id = ?
              and project_id = ?
          `,
          [args.runId, args.stepId, args.attemptId, args.content, args.filePath, now, existingRow.id, projectId]
        );
        return {
          id: existingRow.id,
          missionId: args.missionId,
          runId: args.runId,
          stepId: args.stepId,
          attemptId: args.attemptId,
          stepKey: args.stepKey,
          content: args.content,
          filePath: args.filePath,
          createdAt: now,
          updatedAt: now
        };
      }
      const id = randomUUID();
      db.run(
        `
          insert into orchestrator_worker_checkpoints(
            id, project_id, mission_id, run_id, step_id, attempt_id,
            step_key, content, file_path, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [id, projectId, args.missionId, args.runId, args.stepId, args.attemptId, args.stepKey, args.content, args.filePath, now, now]
      );
      return {
        id,
        missionId: args.missionId,
        runId: args.runId,
        stepId: args.stepId,
        attemptId: args.attemptId,
        stepKey: args.stepKey,
        content: args.content,
        filePath: args.filePath,
        createdAt: now,
        updatedAt: now
      };
    },

    getWorkerCheckpoint(args: { missionId: string; stepKey: string }): OrchestratorWorkerCheckpoint | null {
      const row = db.get<{
        id: string;
        mission_id: string;
        run_id: string;
        step_id: string;
        attempt_id: string;
        step_key: string;
        content: string;
        file_path: string;
        created_at: string;
        updated_at: string;
      }>(
        `
          select id, mission_id, run_id, step_id, attempt_id, step_key, content, file_path, created_at, updated_at
          from orchestrator_worker_checkpoints
          where mission_id = ? and step_key = ? and project_id = ?
          order by updated_at desc
          limit 1
        `,
        [args.missionId, args.stepKey, projectId]
      );
      if (!row) return null;
      return {
        id: row.id,
        missionId: row.mission_id,
        runId: row.run_id,
        stepId: row.step_id,
        attemptId: row.attempt_id,
        stepKey: row.step_key,
        content: row.content,
        filePath: row.file_path,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },

    getWorkerCheckpointsForMission(args: { missionId: string }): OrchestratorWorkerCheckpoint[] {
      const rows = db.all<{
        id: string;
        mission_id: string;
        run_id: string;
        step_id: string;
        attempt_id: string;
        step_key: string;
        content: string;
        file_path: string;
        created_at: string;
        updated_at: string;
      }>(
        `
          select id, mission_id, run_id, step_id, attempt_id, step_key, content, file_path, created_at, updated_at
          from orchestrator_worker_checkpoints
          where mission_id = ? and project_id = ?
          order by updated_at desc
        `,
        [args.missionId, projectId]
      );
      return rows.map((row) => ({
        id: row.id,
        missionId: row.mission_id,
        runId: row.run_id,
        stepId: row.step_id,
        attemptId: row.attempt_id,
        stepKey: row.step_key,
        content: row.content,
        filePath: row.file_path,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    },

    getWorkerCheckpointsForRun(args: { runId: string }): OrchestratorWorkerCheckpoint[] {
      const rows = db.all<{
        id: string;
        mission_id: string;
        run_id: string;
        step_id: string;
        attempt_id: string;
        step_key: string;
        content: string;
        file_path: string;
        created_at: string;
        updated_at: string;
      }>(
        `
          select id, mission_id, run_id, step_id, attempt_id, step_key, content, file_path, created_at, updated_at
          from orchestrator_worker_checkpoints
          where run_id = ? and project_id = ?
          order by updated_at desc
        `,
        [args.runId, projectId]
      );
      return rows.map((row) => ({
        id: row.id,
        missionId: row.mission_id,
        runId: row.run_id,
        stepId: row.step_id,
        attemptId: row.attempt_id,
        stepKey: row.step_key,
        content: row.content,
        filePath: row.file_path,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    },

    // ─── Integration PR Trigger ───────────────────────────────────

    triggerIntegrationPr(args: {
      runId: string;
      policy: IntegrationPrPolicy;
    }): { stepId: string } | null {
      const runId = String(args.runId ?? "").trim();
      if (!runId) throw new Error("runId is required.");

      const policy = args.policy;
      if (!policy.enabled) return null;

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);

      // Get all steps and collect unique lane IDs
      const stepRows = listStepRows(runId);
      const laneIds = new Set<string>();
      for (const row of stepRows) {
        if (row.lane_id) laneIds.add(row.lane_id);
      }

      // Only create integration step if multiple lanes are involved
      if (laneIds.size < 2) return null;

      const now = nowIso();
      const stepId = randomUUID();
      const stepKey = "integration_pr";

      // All existing non-skipped/non-canceled step IDs become dependencies
      const allStepIds = stepRows
        .filter((r) => r.status !== "skipped" && r.status !== "canceled")
        .map((r) => r.id);
      const maxIndex = stepRows.reduce((max, row) => Math.max(max, row.step_index), -1);

      db.run(
        `
          insert into orchestrator_steps(
            id, run_id, project_id, mission_step_id, step_key, step_index,
            title, lane_id, status, join_policy, quorum_count,
            dependency_step_ids_json, retry_limit, retry_count, last_attempt_id,
            policy_json, metadata_json, created_at, updated_at, started_at, completed_at
          ) values (?, ?, ?, null, ?, ?, ?, null, 'pending', 'all_success', null, ?, 1, 0, null, '{}', ?, ?, ?, null, null)
        `,
        [
          stepId,
          runId,
          projectId,
          stepKey,
          maxIndex + 1,
          "Integration PR",
          JSON.stringify(allStepIds),
          JSON.stringify({
            stepType: "merge",
            instructions: "Create integration PR merging all parallel lanes, resolve any merge conflicts first",
            laneIds: Array.from(laneIds),
            policy: {
              createIntegrationLane: policy.createIntegrationLane,
              prDepth: policy.prDepth,
              draft: policy.draft,
              baseBranch: policy.baseBranch ?? null
            }
          }),
          now,
          now
        ]
      );

      appendTimelineEvent({
        runId,
        stepId,
        eventType: "integration_pr_step_inserted",
        reason: "multi_lane_integration",
        detail: {
          laneIds: Array.from(laneIds),
          dependencyCount: allStepIds.length,
          policy: {
            createIntegrationLane: policy.createIntegrationLane,
            prDepth: policy.prDepth,
            draft: policy.draft
          }
        }
      });
      emit({ type: "orchestrator-step-updated", runId, stepId, reason: "integration_pr_inserted" });

      refreshStepReadiness(runId);

      return { stepId };
    },

    // ── Artifact Registry ──────────────────────────────────────────────

    registerArtifact(artifact: {
      id?: string;
      missionId: string;
      runId: string;
      stepId: string;
      attemptId: string;
      artifactKey: string;
      kind: OrchestratorArtifactKind;
      value: string;
      metadata?: Record<string, unknown>;
      declared?: boolean;
    }): OrchestratorArtifact {
      const id = artifact.id ?? randomUUID();
      const now = nowIso();
      db.run(
        `
          insert or ignore into orchestrator_artifacts(
            id, project_id, mission_id, run_id, step_id, attempt_id,
            artifact_key, kind, value, metadata_json, declared, created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          projectId,
          artifact.missionId,
          artifact.runId,
          artifact.stepId,
          artifact.attemptId,
          artifact.artifactKey,
          artifact.kind,
          artifact.value,
          JSON.stringify(artifact.metadata ?? {}),
          artifact.declared ? 1 : 0,
          now
        ]
      );
      return {
        id,
        missionId: artifact.missionId,
        runId: artifact.runId,
        stepId: artifact.stepId,
        attemptId: artifact.attemptId,
        artifactKey: artifact.artifactKey,
        kind: artifact.kind,
        value: artifact.value,
        metadata: artifact.metadata ?? {},
        declared: artifact.declared ?? false,
        createdAt: now
      };
    },

    getArtifactsForStep(stepId: string): OrchestratorArtifact[] {
      const rows = db.all<ArtifactRow>(
        `
          select id, project_id, mission_id, run_id, step_id, attempt_id,
                 artifact_key, kind, value, metadata_json, declared, created_at
          from orchestrator_artifacts
          where step_id = ?
            and project_id = ?
          order by created_at asc
        `,
        [stepId, projectId]
      );
      return rows.map(toArtifact);
    },

    getArtifactsForMission(missionId: string): OrchestratorArtifact[] {
      const rows = db.all<ArtifactRow>(
        `
          select id, project_id, mission_id, run_id, step_id, attempt_id,
                 artifact_key, kind, value, metadata_json, declared, created_at
          from orchestrator_artifacts
          where mission_id = ?
            and project_id = ?
          order by created_at asc
        `,
        [missionId, projectId]
      );
      return rows.map(toArtifact);
    },

    getArtifactsByKey(missionId: string, artifactKey: string): OrchestratorArtifact[] {
      const rows = db.all<ArtifactRow>(
        `
          select id, project_id, mission_id, run_id, step_id, attempt_id,
                 artifact_key, kind, value, metadata_json, declared, created_at
          from orchestrator_artifacts
          where mission_id = ?
            and artifact_key = ?
            and project_id = ?
          order by created_at asc
        `,
        [missionId, artifactKey, projectId]
      );
      return rows.map(toArtifact);
    },

    // ─── Explicit Completion: finalizeRun ─────────────────────────────
    //
    // This is the ONLY path to terminal success. tick() never closes runs.
    // The coordinator requests completion → kernel validates → kernel finalizes.

    finalizeRun(args: FinalizeRunArgs): FinalizeRunResult {
      const runId = String(args.runId ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);

      // Already terminal — return current state
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        try {
          void this.generateRunRetrospective({ runId });
        } catch {
          // best-effort
        }
        return {
          finalized: true,
          blockers: [],
          finalStatus: run.status
        };
      }

      // Read run state to check completion_requested
      const runState = this.getRunState(runId);

      // If not in "completing" status, transition to it first
      if (run.status !== "completing") {
        updateRunStatus(runId, "completing");
        appendTimelineEvent({
          runId,
          eventType: "run_completing",
          reason: "finalize_run_requested",
          detail: { previousStatus: run.status, force: args.force ?? false }
        });
      }

      // Run the completion validator
      const steps = listStepRows(runId).map(toStep);
      const attempts = listAttemptRows(runId).map(toAttempt);
      const claims = db.all<ClaimRow>(
        `
          select id, run_id, step_id, attempt_id, owner_id, scope_kind,
                 scope_value, state, acquired_at, heartbeat_at, expires_at,
                 released_at, policy_json, metadata_json
          from orchestrator_claims
          where project_id = ? and run_id = ? and state = 'active'
        `,
        [projectId, runId]
      ).map(toClaim);

      // Fetch unresolved interventions for the run.
      // Runtime events don't have a dedicated status column; treat each
      // intervention_opened row as "open" unless a matching intervention_resolved
      // event exists for the same step.
      const interventionRows = db.all<{ status: string }>(
        `
          select 'open' as status
          from orchestrator_runtime_events e
          where e.project_id = ? and e.run_id = ? and e.event_type = 'intervention_opened'
            and not exists (
              select 1 from orchestrator_runtime_events r
              where r.project_id = e.project_id and r.run_id = e.run_id
                and r.event_type = 'intervention_resolved'
                and (
                  (
                    json_extract(e.payload_json, '$.interventionId') is not null
                    and json_extract(r.payload_json, '$.interventionId') = json_extract(e.payload_json, '$.interventionId')
                  )
                  or (
                    json_extract(e.payload_json, '$.interventionId') is null
                    and (
                      r.step_id = e.step_id
                      or (r.step_id is null and e.step_id is null)
                    )
                  )
                )
            )
        `,
        [projectId, runId]
      );

      const validation = validateRunCompletion(run, steps, attempts, claims, runState, interventionRows);
      const finalRunMeta = parseJsonRecord(runRow.metadata_json);
      const finalPhases = resolveRunPhaseCardsFromMetadata(finalRunMeta);
      const finalSettings = resolveRunMissionLevelSettingsFromMetadata(finalRunMeta);
      const hasConfiguredPhaseEvaluation = Boolean(finalPhases && finalPhases.length > 0 && finalSettings);

      let evaluation: RunCompletionEvaluation;
      if (finalPhases && finalPhases.length > 0 && finalSettings) {
        evaluation = evaluateRunCompletionFromPhases(steps, finalPhases, finalSettings);
      } else {
        evaluation = evaluateRunCompletion(
          steps,
          finalRunMeta && isExecutionPolicyRecord(finalRunMeta.executionPolicy)
            ? (finalRunMeta.executionPolicy as MissionExecutionPolicy)
            : DEFAULT_EXECUTION_POLICY
        );
      }

      const evaluationBlockers = evaluation.diagnostics
        .filter((diagnostic) => diagnostic.blocking)
        .filter((diagnostic) => hasConfiguredPhaseEvaluation || diagnostic.code === "required_validation_missing")
        .map((diagnostic) => ({
          code: diagnostic.code,
          message: diagnostic.message,
          detail: diagnostic.details ?? null,
        }));
      const completionBlockers = [...validation.blockers, ...evaluationBlockers];
      const completionReady =
        validation.canComplete
        && evaluationBlockers.length === 0
        && (!hasConfiguredPhaseEvaluation || evaluation.completionReady);

      if (!completionReady) {
        // Store the validation error in run state
        if (runState) {
          this.upsertRunState(runId, {
            ...runState,
            lastValidationError: completionBlockers.map((b) => b.message).join("; "),
            completionValidated: false
          });
        }

        appendTimelineEvent({
          runId,
          eventType: "run_completion_blocked",
          reason: "completion_gates_failed",
          detail: {
            blockers: completionBlockers,
            validatedAt: validation.validatedAt,
            completionReady: evaluation.completionReady,
            evaluationStatus: evaluation.status
          }
        });

        return {
          finalized: false,
          blockers: completionBlockers.map((b) => b.message),
          finalStatus: "completing"
        };
      }

      // Determine final terminal status
      let finalStatus: OrchestratorRunStatus;
      if (hasConfiguredPhaseEvaluation) {
        finalStatus = evaluation.status === "failed" ? "failed" : "succeeded";
      } else {
        const allStepStatuses = filterExecutionSteps(steps).map((step) => step.status);
        finalStatus = allStepStatuses.some((status) => status === "failed") ? "failed" : "succeeded";
      }

      // Persist completion diagnostics
      const existingMeta = parseJsonRecord(runRow.metadata_json) ?? {};
      const finalizedAt = nowIso();
      const updatedMeta = applyProcedureOutcomeFeedback({
        runId,
        finalStatus,
        metadata: {
          ...existingMeta,
          completionDiagnostics: evaluation.diagnostics,
          completionRiskFactors: evaluation.riskFactors,
          completionValidation: validation,
          finalizedAt,
        },
        reason:
          finalStatus === "succeeded"
            ? "Mission run completed successfully."
            : toOptionalNonEmptyString(runRow.last_error)
              || (evaluation.diagnostics[0] ? JSON.stringify(evaluation.diagnostics[0]) : null)
              || "Mission run failed.",
      });
      updateRunStatus(runId, finalStatus, {
        metadata_json: JSON.stringify(updatedMeta)
      });

      // Update run state to mark completion validated
      if (runState) {
        this.upsertRunState(runId, {
          ...runState,
          phase: "done",
          completionValidated: true,
          lastValidationError: null
        });
      }

      const missionEntries = missionMemoryLifecycleService?.listMissionEntries({
        projectId,
        missionId: run.missionId,
        runId,
        status: "all",
      }) ?? [];
      const sharedFacts = missionEntries
        .filter((entry) =>
          entry.category === "fact"
          || entry.category === "decision"
          || entry.category === "gotcha"
          || entry.category === "handoff"
          || entry.category === "digest"
          || entry.category === "pattern"
          || entry.category === "procedure"
        )
        .map((entry) => `[${entry.category}] ${entry.content}`);
      try {
        missionMemoryLifecycleService?.finalizeMission({
          projectId,
          missionId: run.missionId,
          runId,
          finalStatus: finalStatus === "succeeded" ? "succeeded" : finalStatus === "failed" ? "failed" : "canceled",
        });
      } catch {
        // Mission lifecycle cleanup is best-effort.
      }
      if (episodicSummaryService) {
        const decisions = missionEntries
          .filter((entry) => entry.category === "decision")
          .map((entry) => entry.content);
        const gotchas = missionEntries
          .filter((entry) => entry.category === "gotcha")
          .map((entry) => entry.content);
        episodicSummaryService.enqueueMissionSummary({
          missionId: run.missionId,
          runId,
          taskDescription: typeof run.metadata?.missionGoal === "string" && run.metadata.missionGoal.trim().length > 0
            ? run.metadata.missionGoal.trim()
            : `Mission ${run.missionId}`,
          finalStatus: finalStatus === "succeeded" ? "success" : finalStatus === "failed" ? "failure" : "partial",
          startedAt: run.startedAt,
          endedAt: finalizedAt,
          sharedFacts,
          decisions,
          gotchas,
          workerOutputs: steps
            .filter((step) => step.status === "succeeded" || step.status === "failed")
            .map((step) => `${step.stepKey}: ${step.title} (${step.status})`),
        });
      }

      appendTimelineEvent({
        runId,
        eventType: "run_finalized",
        reason: "finalize_run",
        detail: {
          finalStatus,
          forceRequested: args.force ?? false,
          diagnosticCount: evaluation.diagnostics.length,
          riskFactors: evaluation.riskFactors
        }
      });
      emit({ type: "orchestrator-run-updated", runId, reason: "finalized" });
      try {
        void this.generateRunRetrospective({ runId });
      } catch {
        // best-effort
      }

      return {
        finalized: true,
        blockers: [],
        finalStatus
      };
    },

    // ─── Status transitions ─────────────────────────────────────────

    /** Transition run from bootstrapping → active (planning done, coordinator online) */
    activateRun(runId: string): OrchestratorRun {
      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);
      if (run.status !== "bootstrapping" && run.status !== "queued") {
        throw new Error(`Cannot activate run in status '${run.status}' — must be 'bootstrapping' or 'queued'.`);
      }
      updateRunStatus(runId, "active");
      appendTimelineEvent({
        runId,
        eventType: "run_activated",
        reason: "activate_run",
        detail: { previousStatus: run.status }
      });
      emit({ type: "orchestrator-run-updated", runId, reason: "activated" });
      const updated = getRunRow(runId);
      if (!updated) throw new Error(`Run not found after activation: ${runId}`);
      return toRun(updated);
    },

    /** Transition run to "completing" when coordinator requests completion */
    requestCompletion(runId: string): OrchestratorRun {
      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
      if (run.status === "completing") return run;
      updateRunStatus(runId, "completing");

      // Mark completion as requested in run state
      const runState = this.getRunState(runId);
      if (runState) {
        this.upsertRunState(runId, { ...runState, completionRequested: true });
      }

      appendTimelineEvent({
        runId,
        eventType: "run_completion_requested",
        reason: "request_completion",
        detail: { previousStatus: run.status }
      });
      emit({ type: "orchestrator-run-updated", runId, reason: "completion_requested" });
      const updated = getRunRow(runId);
      if (!updated) throw new Error(`Run not found after requesting completion: ${runId}`);
      return toRun(updated);
    },

    // ─── Run State CRUD (orchestrator_run_state) ──────────────────────

    upsertRunState(runId: string, state: Partial<OrchestratorTeamRuntimeState>): OrchestratorTeamRuntimeState {
      const now = nowIso();
      const existing = this.getRunState(runId);
      if (existing) {
        const phase = state.phase ?? existing.phase;
        const completionRequested = state.completionRequested ?? existing.completionRequested;
        const completionValidated = state.completionValidated ?? existing.completionValidated;
        const lastValidationError = state.lastValidationError !== undefined ? state.lastValidationError : existing.lastValidationError;
        const coordinatorSessionId = state.coordinatorSessionId !== undefined ? state.coordinatorSessionId : existing.coordinatorSessionId;
        const teammateIds = state.teammateIds ?? existing.teammateIds;
        db.run(
          `
            update orchestrator_run_state
            set phase = ?,
                completion_requested = ?,
                completion_validated = ?,
                last_validation_error = ?,
                coordinator_session_id = ?,
                teammate_ids_json = ?,
                updated_at = ?
            where run_id = ?
          `,
          [
            phase,
            completionRequested ? 1 : 0,
            completionValidated ? 1 : 0,
            lastValidationError,
            coordinatorSessionId,
            JSON.stringify(teammateIds),
            now,
            runId
          ]
        );
        return {
          runId,
          phase,
          completionRequested,
          completionValidated,
          lastValidationError,
          coordinatorSessionId,
          teammateIds,
          createdAt: existing.createdAt,
          updatedAt: now
        };
      } else {
        const phase = state.phase ?? "bootstrapping";
        const completionRequested = state.completionRequested ?? false;
        const completionValidated = state.completionValidated ?? false;
        const lastValidationError = state.lastValidationError ?? null;
        const coordinatorSessionId = state.coordinatorSessionId ?? null;
        const teammateIds = state.teammateIds ?? [];
        db.run(
          `
            insert into orchestrator_run_state(
              run_id, phase, completion_requested, completion_validated,
              last_validation_error, coordinator_session_id, teammate_ids_json,
              created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            runId,
            phase,
            completionRequested ? 1 : 0,
            completionValidated ? 1 : 0,
            lastValidationError,
            coordinatorSessionId,
            JSON.stringify(teammateIds),
            now,
            now
          ]
        );
        return {
          runId,
          phase,
          completionRequested,
          completionValidated,
          lastValidationError,
          coordinatorSessionId,
          teammateIds,
          createdAt: now,
          updatedAt: now
        };
      }
    },

    getRunState(runId: string): OrchestratorTeamRuntimeState | null {
      const row = db.get<{
        run_id: string;
        phase: string;
        completion_requested: number;
        completion_validated: number;
        last_validation_error: string | null;
        coordinator_session_id: string | null;
        teammate_ids_json: string;
        created_at: string;
        updated_at: string;
      }>(
        `
          select run_id, phase, completion_requested, completion_validated,
                 last_validation_error, coordinator_session_id, teammate_ids_json,
                 created_at, updated_at
          from orchestrator_run_state
          where run_id = ?
          limit 1
        `,
        [runId]
      );
      if (!row) return null;
      return {
        runId: row.run_id,
        phase: row.phase as OrchestratorTeamRuntimeState["phase"],
        completionRequested: row.completion_requested === 1,
        completionValidated: row.completion_validated === 1,
        lastValidationError: row.last_validation_error,
        coordinatorSessionId: row.coordinator_session_id,
        teammateIds: parseArray(row.teammate_ids_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },

  };
}
