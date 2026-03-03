// ---------------------------------------------------------------------------
// Coordinator Tool Set — AI-first tools for the orchestrator brain.
// Each tool is a thin wrapper around persistence + worker spawning.
// The AI decides everything; tools just execute its decisions.
// ---------------------------------------------------------------------------

import { tool, type Tool } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { createOrchestratorService } from "./orchestratorService";
import type {
  MissionBudgetSnapshot,
  MissionBudgetProviderSnapshot,
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
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createMissionService } from "../missions/missionService";
import { asRecord, nowIso, TERMINAL_STEP_STATUSES } from "./orchestratorContext";
import { readMissionStateDocument, updateMissionStateDocument } from "./missionStateDoc";

const VALIDATION_CONTRACT_SCHEMA = z
  .object({
    level: z.enum(["step", "milestone", "mission"]),
    tier: z.enum(["self", "spot-check", "dedicated"]),
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

export type CoordinatorWorkerDeliveryStatus =
  | { ok: true; delivered: true; method: "send" | "steer" }
  | { ok: true; delivered: false; reason: "worker_busy_steered"; method: "steer" }
  | { ok: false; delivered: false; reason: "no_active_session" | "delivery_failed"; error?: string };

export type CoordinatorSendWorkerMessageFn = (args: {
  sessionId: string;
  text: string;
}) => Promise<CoordinatorWorkerDeliveryStatus>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveStep(
  graph: OrchestratorRunGraph,
  stepKey: string,
): OrchestratorStep | null {
  return graph.steps.find((s) => s.stepKey === stepKey) ?? null;
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
  const activeStep = graph.steps.find((step) => !TERMINAL_STEP_STATUSES.has(step.status)) ?? null;
  const stepMeta = asRecord(activeStep?.metadata);
  const fromStepName = typeof stepMeta?.phaseName === "string" ? stepMeta.phaseName.trim() : "";
  if (fromStepName.length > 0) return fromStepName;
  const fromStepKey = typeof stepMeta?.phaseKey === "string" ? stepMeta.phaseKey.trim() : "";
  if (fromStepKey.length > 0) return fromStepKey;
  return "unknown";
}

function buildMissionStateProgress(graph: OrchestratorRunGraph): MissionStateProgress {
  const completedSteps = graph.steps.filter((step) => TERMINAL_STEP_STATUSES.has(step.status)).length;
  return {
    currentPhase: resolveCurrentPhase(graph),
    completedSteps,
    totalSteps: graph.steps.length,
    activeWorkers: graph.steps.filter((step) => step.status === "running").map((step) => step.stepKey),
    blockedSteps: graph.steps.filter((step) => step.status === "blocked").map((step) => step.stepKey),
    failedSteps: graph.steps.filter((step) => step.status === "failed").map((step) => step.stepKey),
  };
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
    template: teamRuntime.template as TeamRuntimeConfig["template"],
    toolProfiles: teamRuntime.toolProfiles as TeamRuntimeConfig["toolProfiles"],
    mcpServerAllowlist: Array.isArray(teamRuntime.mcpServerAllowlist)
      ? (teamRuntime.mcpServerAllowlist as unknown[])
          .map((entry: unknown) => String(entry ?? "").trim())
          .filter((entry) => entry.length > 0)
      : undefined,
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
    raw.tier !== "spot-check" &&
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

function resolveRequireValidatorPassFlag(metadata: Record<string, unknown> | null): boolean | null {
  if (!metadata) return null;
  const candidates = [
    metadata,
    asRecord(metadata.policyOverrides),
    asRecord(metadata.missionPolicyFlags),
    asRecord(metadata.executionPolicy),
    asRecord(metadata.teamRuntime),
    asRecord(asRecord(metadata.teamRuntime)?.policyOverrides),
    asRecord(asRecord(metadata.executionPolicy)?.teamRuntime),
    asRecord(asRecord(asRecord(metadata.executionPolicy)?.teamRuntime)?.policyOverrides),
    asRecord(metadata.launch),
    asRecord(asRecord(metadata.launch)?.teamRuntime),
    asRecord(asRecord(asRecord(metadata.launch)?.teamRuntime)?.policyOverrides),
    asRecord(asRecord(metadata.launch)?.executionPolicy),
    asRecord(asRecord(asRecord(metadata.launch)?.executionPolicy)?.teamRuntime),
    asRecord(asRecord(asRecord(asRecord(metadata.launch)?.executionPolicy)?.teamRuntime)?.policyOverrides),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate.requireValidatorPass === "boolean") {
      return candidate.requireValidatorPass;
    }
  }
  return null;
}

function buildStalenessSignals(graph: OrchestratorRunGraph): string[] {
  const signals: string[] = [];
  const nowMs = Date.now();
  const repeatedFailures = graph.steps.filter((step) => step.status === "failed" && step.retryCount >= step.retryLimit && step.retryLimit > 0);
  if (repeatedFailures.length > 0) {
    signals.push(`${repeatedFailures.length} step(s) exhausted retries`);
  }
  const runningAttempts = graph.attempts.filter((attempt) => attempt.status === "running");
  const staleRunning = runningAttempts.filter((attempt) => nowMs - Date.parse(attempt.createdAt) > 10 * 60_000);
  if (staleRunning.length > 0) {
    signals.push(`${staleRunning.length} running attempt(s) older than 10 minutes`);
  }
  const blockedSteps = graph.steps.filter((step) => step.status === "blocked");
  if (blockedSteps.length > 0) {
    signals.push(`${blockedSteps.length} blocked step(s)`);
  }
  const validationEscalations = graph.steps.filter(
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
  getMissionBudgetStatus?: () => Promise<MissionBudgetSnapshot | null>;
  runId: string;
  missionId: string;
  logger: Logger;
  db: AdeDb;
  projectRoot: string;
  onDagMutation: (event: DagMutationEvent) => void;
  onRunFinalize?: (args: { runId: string; succeeded: boolean; summary?: string; reason?: string }) => void;
  onHardCapTriggered?: (detail: string) => void;
  onBudgetWarning?: (pressure: "warning" | "critical", detail: string) => void;
  sendWorkerMessageToSession?: CoordinatorSendWorkerMessageFn;
}): Record<string, Tool> {
  const {
    orchestratorService,
    missionService,
    getMissionBudgetStatus,
    runId,
    missionId,
    logger,
    db,
    projectRoot,
    onDagMutation
  } = deps;

  /** Track last emitted budget pressure to avoid spamming soft warnings. */
  let lastEmittedBudgetPressure: "normal" | "warning" | "critical" = "normal";

  /** Shorthand to get a fresh graph snapshot. */
  function graph(): OrchestratorRunGraph {
    return orchestratorService.getRunGraph({ runId });
  }

  function isValidatorPassRequired(g: OrchestratorRunGraph): boolean {
    const runMeta = asRecord(g.run.metadata);
    const fromRun = resolveRequireValidatorPassFlag(runMeta);
    if (typeof fromRun === "boolean") return fromRun;

    try {
      const missionRow = db.get<{ metadata_json: string | null }>(
        `select metadata_json from missions where id = ? limit 1`,
        [missionId]
      );
      if (missionRow?.metadata_json) {
        const missionMetaRaw = JSON.parse(missionRow.metadata_json);
        const missionMeta = asRecord(missionMetaRaw);
        const fromMission = resolveRequireValidatorPassFlag(missionMeta);
        if (typeof fromMission === "boolean") return fromMission;
      }
    } catch {
      // Non-blocking — default policy remains enabled.
    }

    return true;
  }

  function resolveMissionGoal(): string {
    const mission = missionService.get(missionId);
    const prompt = typeof mission?.prompt === "string" ? mission.prompt.trim() : "";
    if (prompt.length > 0) return prompt;
    const title = typeof mission?.title === "string" ? mission.title.trim() : "";
    if (title.length > 0) return title;
    return `Mission ${missionId}`;
  }

  async function deliverToWorkerSession(sessionId: string, text: string): Promise<CoordinatorWorkerDeliveryStatus> {
    if (!deps.sendWorkerMessageToSession) {
      return {
        ok: false,
        delivered: false,
        reason: "delivery_failed",
        error: "Worker delivery transport is unavailable."
      };
    }
    try {
      return await deps.sendWorkerMessageToSession({ sessionId, text });
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
  async function checkBudgetHardCaps(): Promise<{
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
      // Budget check failure is non-blocking — log and continue
      logger.debug("coordinator.budget_hard_cap_check_failed", {
        error: budgetErr instanceof Error ? budgetErr.message : String(budgetErr),
      });
      return { blocked: false };
    }
  }

  // ─── Worker Management ────────────────────────────────────────

  const spawnWorkerStep = (args: {
    stepKey?: string | null;
    name: string;
    provider: "claude" | "codex";
    prompt: string;
    dependsOn: string[];
    roleName?: string | null;
    laneId?: string | null;
    validationContract?: ValidationContract | null;
    specialistRequest?: { requestedBy?: string | null; reason?: string | null } | null;
    replacementForWorkerId?: string | null;
    replacementReason?: string | null;
  }): {
    workerId: string;
    step: OrchestratorStep | null;
    roleName: string | null;
    toolProfile: Record<string, unknown> | null;
  } => {
    const g = graph();
    const teamRuntime = resolveTeamRuntimeConfig(g);
    const roleDef = args.roleName ? resolveRoleDefinition(teamRuntime, args.roleName) : null;
    const roleName = roleDef?.name ?? (args.roleName?.trim().length ? args.roleName.trim() : null);
    const toolProfile = roleName ? resolveRoleToolProfile(teamRuntime, roleName) : null;
    const resolvedProvider = roleDef?.defaultModel.provider ?? args.provider;
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
    const inheritedLaneId = replacementSourceStep?.laneId ?? null;
    const effectiveLaneId = args.laneId ?? inheritedLaneId;
    const maxIndex = g.steps.reduce(
      (max, s) => Math.max(max, s.stepIndex),
      -1,
    );
    const explicitStepKey = args.stepKey?.trim() ?? "";
    const stepKey =
      explicitStepKey.length > 0
        ? explicitStepKey
        : `worker_${args.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}`;
    const created = orchestratorService.addSteps({
      runId,
      steps: [
        {
          stepKey,
          title: args.name,
          stepIndex: maxIndex + 1,
          laneId: effectiveLaneId,
          dependencyStepKeys: args.dependsOn,
          executorKind: resolvedProvider === "codex" ? "codex" : "claude",
          metadata: {
            instructions: args.prompt,
            workerName: args.name,
            spawnedByCoordinator: true,
            role: roleName,
            roleCapabilities: roleDef?.capabilities ?? [],
            roleDefaultModel: roleDef?.defaultModel ?? null,
            toolProfile: toolProfile ?? null,
            mcpServerAllowlist: teamRuntime?.mcpServerAllowlist ?? [],
            ...(args.validationContract ? { validationContract: args.validationContract } : {}),
            ...(replacementSourceStep
              ? {
                  replacementContext: {
                    replacedWorkerId: replacementSourceStep.stepKey,
                    replacedStepId: replacementSourceStep.id,
                    inheritedLaneId,
                    reason: args.replacementReason?.trim() || "Replacement worker requested by coordinator.",
                    sourceSummary:
                      (typeof replacementResultReport.summary === "string" && replacementResultReport.summary.trim().length > 0
                        ? replacementResultReport.summary.trim()
                        : replacementAttempt?.resultEnvelope?.summary) ?? null,
                    changedFiles: Array.isArray(replacementResultReport.filesChanged)
                      ? replacementResultReport.filesChanged
                          .map((entry) => String(entry ?? "").trim())
                          .filter((entry) => entry.length > 0)
                      : [],
                    failedChecks:
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
                        : [],
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
      const replacementPayload = {
        replacedWorkerId: replacementSourceStep.stepKey,
        replacedStepId: replacementSourceStep.id,
        replacementWorkerId: created[0].stepKey,
        replacementStepId: created[0].id,
        laneId: effectiveLaneId,
        reason: args.replacementReason?.trim() || "Replacement worker requested by coordinator.",
        sourceSummary:
          (typeof replacementResultReport.summary === "string" && replacementResultReport.summary.trim().length > 0
            ? replacementResultReport.summary.trim()
            : replacementAttempt?.resultEnvelope?.summary) ?? null,
        changedFiles: Array.isArray(replacementResultReport.filesChanged)
          ? replacementResultReport.filesChanged
              .map((entry) => String(entry ?? "").trim())
              .filter((entry) => entry.length > 0)
          : [],
        failedChecks:
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
            : [],
        priorValidatorFeedback: replacementValidationReport ?? null,
        priorStatusReport: replacementStatusReport ?? null
      };
      orchestratorService.createHandoff({
        missionId,
        runId,
        stepId: created[0].id,
        handoffType: "worker_replacement_handoff",
        producer: "coordinator",
        payload: replacementPayload
      });
    }
    return {
      workerId: stepKey,
      step: created[0] ?? null,
      roleName,
      toolProfile
    };
  };

  const spawn_worker = tool({
    description:
      "Spawn a new agent worker session. The worker will execute the given prompt autonomously. Returns a worker ID (step key) you can use to track, message, or stop the worker.",
    inputSchema: z.object({
      name: z.string().describe("Human-readable name for the worker (e.g. 'auth-implementer', 'test-writer')"),
      provider: z.enum(["claude", "codex"]).optional().describe("Which agent provider to use"),
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
    execute: async ({ name, provider, role, prompt, laneId, replacementForWorkerId, replacementReason, validationContract, dependsOn }) => {
      try {
        const g = graph();
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

        // Resolve provider from current phase card's model config if not explicitly given
        let resolvedProvider: "claude" | "codex" = provider ?? "claude";
        if (!provider) {
          const runMeta = asRecord(g.run.metadata);
          const phaseRuntime = asRecord(runMeta?.phaseRuntime);
          const currentPhaseModel = asRecord(phaseRuntime?.currentPhaseModel);
          if (typeof currentPhaseModel?.provider === "string") {
            resolvedProvider = currentPhaseModel.provider as "claude" | "codex";
          }
        }

        // Hard cap check: refuse to spawn if budget hard caps are triggered
        const budgetCheck = await checkBudgetHardCaps();
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

        const { workerId, step: newStep, roleName, toolProfile } = spawnWorkerStep({
          name,
          provider: resolvedProvider,
          prompt,
          dependsOn,
          roleName: normalizedRole.length > 0 ? normalizedRole : null,
          laneId: typeof laneId === "string" && laneId.trim().length > 0 ? laneId.trim() : null,
          replacementForWorkerId: replacementSourceWorkerId || null,
          replacementReason: replacementReason?.trim() || null,
          validationContract: parsedContract
        });
        if (newStep) {
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
              setTimeout(() => reject(new Error("autopilot_start_timeout")), 5000)
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

        logger.info("coordinator.spawn_worker", {
          name,
          workerId,
          provider: resolvedProvider,
          role: roleName,
          launched,
          launchNote,
        });
        return {
          ok: true,
          workerId,
          launched,
          ...(launchNote ? { launchNote } : {}),
          stepId: newStep?.id ?? null,
          status: newStep?.status ?? "unknown",
          name,
          provider: resolvedProvider,
          role: roleName,
          toolProfile,
          replacementForWorkerId: replacementSourceWorkerId || null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.spawn_worker.error", { name, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const insert_milestone = tool({
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
        const normalizedName = name.trim();
        if (!normalizedName.length) {
          return { ok: false, error: "Milestone name is required." };
        }
        const normalizedCriteria = validationCriteria.trim();
        if (!normalizedCriteria.length) {
          return { ok: false, error: "validationCriteria is required for insert_milestone." };
        }

        const normalizedDependsOn = [...new Set(
          dependsOn.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
        )];
        const unknownDependsOn = normalizedDependsOn.filter((entry) => !resolveStep(g, entry));
        if (unknownDependsOn.length > 0) {
          return {
            ok: false,
            error: `Unknown dependency step keys: ${unknownDependsOn.join(", ")}`
          };
        }

        const normalizedGatesSteps = [...new Set(
          (gatesSteps ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
        )];
        const unknownGates = normalizedGatesSteps.filter((entry) => !resolveStep(g, entry));
        if (unknownGates.length > 0) {
          return {
            ok: false,
            error: `Unknown gatesSteps step keys: ${unknownGates.join(", ")}`
          };
        }

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

  const request_specialist = tool({
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
        const teamRuntime = resolveTeamRuntimeConfig(g);
        const roleDef = resolveRoleDefinition(teamRuntime, role);
        if (!roleDef) {
          return { ok: false, error: `Unknown specialist role '${role}'.` };
        }
        if (!reason.trim().length) {
          return { ok: false, error: "Specialist request requires a non-empty reason." };
        }
        const workerName = (name?.trim().length ? name.trim() : `${roleDef.name}-specialist`).slice(0, 80);
        const parsedLaneId = laneId?.trim().length ? laneId.trim() : null;
        const replacementSourceWorkerId = replacementForWorkerId?.trim().length ? replacementForWorkerId.trim() : null;
        if (replacementSourceWorkerId && !resolveStep(g, replacementSourceWorkerId)) {
          return { ok: false, error: `Replacement source worker '${replacementSourceWorkerId}' was not found.` };
        }

        // Hard cap check: refuse to spawn specialist if budget hard caps are triggered
        const budgetCheck = await checkBudgetHardCaps();
        if (budgetCheck.blocked) {
          logger.warn("coordinator.request_specialist.hard_cap_blocked", { role, detail: budgetCheck.detail });
          return {
            ok: false,
            error: `Cannot spawn specialist: ${budgetCheck.detail}. Mission pausing.`,
            hardCapTriggered: true,
            hardCaps: budgetCheck.hardCaps,
          };
        }

        const { workerId, step, roleName, toolProfile } = spawnWorkerStep({
          name: workerName,
          provider: roleDef.defaultModel.provider,
          prompt: objective,
          dependsOn,
          roleName: roleDef.name,
          laneId: parsedLaneId,
          replacementForWorkerId: replacementSourceWorkerId,
          replacementReason: replacementReason?.trim() || reason.trim(),
          specialistRequest: {
            requestedBy: requestedByWorkerId?.trim() || null,
            reason: reason.trim()
          }
        });

        if (step) {
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
            reason: reason.trim(),
            workerId
          }
        });

        setTimeout(() => {
          void orchestratorService.startReadyAutopilotAttempts({
            runId,
            reason: "coordinator_request_specialist",
          }).catch(() => {});
        }, 100);

        return {
          ok: true,
          workerId,
          role: roleName,
          stepId: step?.id ?? null,
          toolProfile,
          replacementForWorkerId: replacementSourceWorkerId
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.request_specialist.error", { role, error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const stop_worker = tool({
    description:
      "Stop a running worker by canceling its current attempt.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key (workerId) of the worker to stop"),
      reason: z.string().describe("Reason for stopping the worker"),
    }),
    execute: async ({ workerId, reason }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step)
          return { ok: false, error: `Worker not found: ${workerId}` };
        const attempt = findRunningAttempt(g, step.id);
        if (!attempt)
          return {
            ok: false,
            error: `No running attempt found for worker '${workerId}'`,
          };
        orchestratorService.completeAttempt({
          attemptId: attempt.id,
          status: "canceled",
          errorClass: "canceled",
          errorMessage: reason,
        });
        logger.info("coordinator.stop_worker", {
          workerId,
          attemptId: attempt.id,
          reason,
        });
        return { ok: true, workerId, attemptId: attempt.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.stop_worker.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const send_message = tool({
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

  const message_worker = tool({
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
        const delivery = await deliverToWorkerSession(recipientAttempt.executorSessionId, content);
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

  const broadcast = tool({
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

  const get_worker_output = tool({
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
        if (!latest && !running)
          return {
            ok: false,
            error: `No completed or running attempt found for worker '${workerId}'`,
          };
        if (latest) {
          return {
            ok: true,
            workerId,
            attemptId: latest.id,
            status: latest.status,
            summary: latest.resultEnvelope?.summary ?? null,
            success: latest.resultEnvelope?.success ?? null,
            warnings: latest.resultEnvelope?.warnings ?? [],
            errorMessage: latest.errorMessage ?? null,
          };
        }
        return {
          ok: true,
          workerId,
          status: "running",
          summary: "Worker is still running.",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.get_worker_output.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const list_workers = tool({
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

  const report_status = tool({
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
        const report: WorkerStatusReport = {
          workerId,
          stepId: step.id,
          stepKey: step.stepKey,
          runId,
          missionId,
          progressPct: Math.max(0, Math.min(100, Math.round(progressPct))),
          blockers: blockers.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0),
          confidence: confidence == null ? null : Math.max(0, Math.min(1, Number(confidence))),
          nextAction: nextAction.trim(),
          laneId: laneId ?? step.laneId,
          details: details ?? null,
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
          metadata
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
        return { ok: true, report };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.report_status.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const report_result = tool({
    description:
      "Structured worker completion report with outcome, artifacts, file changes, and test results.",
    inputSchema: z.object({
      workerId: z.string().describe("Worker step key"),
      outcome: z.enum(["succeeded", "failed", "partial"]).describe("Outcome classification"),
      summary: z.string().describe("Result summary"),
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
    execute: async ({ workerId, outcome, summary, artifacts, filesChanged, testsRun, laneId }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step) return { ok: false, error: `Worker not found: ${workerId}` };
        const report: WorkerResultReport = {
          workerId,
          stepId: step.id,
          stepKey: step.stepKey,
          runId,
          missionId,
          outcome,
          summary: summary.trim(),
          artifacts: artifacts.map((artifact) => ({
            type: artifact.type,
            title: artifact.title,
            uri: artifact.uri ?? null,
            metadata: artifact.metadata
          })),
          filesChanged: filesChanged.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0),
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
          metadata
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
        return { ok: true, report };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.report_result.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const report_validation = tool({
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
        const normalizedFindings = findings
          .map((entry) => parseValidationFinding(entry))
          .filter((entry): entry is ValidationResultReport["findings"][number] => Boolean(entry));
        const normalizedRemediation = remediationInstructions
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
            metadata: nextMetadata
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
            }).catch(() => {});
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

  const read_mission_status = tool({
    description:
      "Read current mission state including active/completed steps, worker status reports, and staleness signals.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const g = graph();
        const activeSteps = g.steps.filter((step) => !TERMINAL_STEP_STATUSES.has(step.status));
        const completedSteps = g.steps.filter((step) => TERMINAL_STEP_STATUSES.has(step.status));
        const openObligations = g.steps.flatMap((step) => {
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
        const workerReports = g.steps
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
            total: g.steps.length,
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

  const read_mission_state = tool({
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

  const update_mission_state = tool({
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

  const revise_plan = tool({
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
          provider: z.enum(["claude", "codex"]).optional(),
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
        const replacementTargets = (() => {
          if (mode === "full") {
            return initialGraph.steps
              .filter((step) => !TERMINAL_STEP_STATUSES.has(step.status))
              .map((step) => step.stepKey);
          }
          return [
            ...replaceStepKeys.map((entry) => entry.trim()),
            ...replacementMap.map((entry) => entry.oldStepKey.trim()),
            ...newSteps.flatMap((entry) => entry.replaces.map((candidate) => candidate.trim()))
          ].filter((entry) => entry.length > 0);
        })();
        const uniqueTargets = [...new Set(replacementTargets)];
        if (!uniqueTargets.length && newSteps.length === 0 && dependencyPatches.length === 0) {
          return { ok: false, error: "No steps selected for replacement." };
        }

        // Hard cap check: refuse to spawn replacement workers if budget hard caps are triggered
        if (newSteps.length > 0) {
          const budgetCheck = await checkBudgetHardCaps();
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

        const existingStepKeys = new Set(initialGraph.steps.map((step) => step.stepKey));
        const createdSteps: OrchestratorStep[] = [];
        for (const entry of newSteps) {
          const normalizedKey = entry.key.trim();
          if (!normalizedKey.length) {
            return { ok: false, error: "Each new plan step requires a non-empty key." };
          }
          if (
            existingStepKeys.has(normalizedKey) &&
            !uniqueTargets.includes(normalizedKey) &&
            !entry.replaces.some((candidate) => candidate.trim() === normalizedKey)
          ) {
            return { ok: false, error: `Step key '${normalizedKey}' already exists.` };
          }
          const parsedContract = parseValidationContract(entry.validationContract ?? null);
          if (entry.validationContract && !parsedContract) {
            return { ok: false, error: `Invalid validation contract for step '${entry.key}'.` };
          }
          const replacementSourceKey =
            entry.replaces
              .map((candidate) => candidate.trim())
              .find((candidate) => candidate.length > 0 && resolveStep(initialGraph, candidate)) ??
            null;
          const replacementSourceStep = replacementSourceKey ? resolveStep(initialGraph, replacementSourceKey) : null;
          const spawnResult = spawnWorkerStep({
            stepKey: normalizedKey,
            name: entry.title,
            provider: entry.provider ?? "claude",
            prompt: entry.description,
            dependsOn: entry.dependsOn,
            roleName: entry.role ?? null,
            laneId: entry.laneId ?? replacementSourceStep?.laneId ?? null,
            replacementForWorkerId: replacementSourceStep?.stepKey ?? null,
            replacementReason: `Plan revised: ${reason.trim()}`,
            validationContract: parsedContract
          });
          if (spawnResult.step) {
            createdSteps.push(spawnResult.step);
            existingStepKeys.add(spawnResult.step.stepKey);
            onDagMutation({
              runId,
              mutation: { type: "step_added", step: spawnResult.step },
              timestamp: nowIso(),
              source: "coordinator",
            });
          }
        }

        const replacementByOldStepKey = new Map<string, OrchestratorStep | null>();
        for (const stepInput of newSteps) {
          const created = createdSteps.find((step) => step.stepKey === stepInput.key.trim());
          if (!created) continue;
          for (const replacedKey of stepInput.replaces ?? []) {
            const normalized = replacedKey.trim();
            if (normalized.length > 0) {
              replacementByOldStepKey.set(normalized, created);
            }
          }
        }
        for (const entry of replacementMap) {
          const oldStepKey = entry.oldStepKey.trim();
          if (!oldStepKey.length) continue;
          const newStepKey = entry.newStepKey?.trim() ?? "";
          if (!newStepKey.length) {
            replacementByOldStepKey.set(oldStepKey, null);
            continue;
          }
          const mappedStep = createdSteps.find((step) => step.stepKey === newStepKey) ?? resolveStep(graph(), newStepKey);
          if (!mappedStep) {
            return { ok: false, error: `replacementMap references unknown newStepKey '${newStepKey}'.` };
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
          const next = orchestratorService.supersedeStep({
            runId,
            stepId: targetStep.id,
            replacementStepId: replacement?.id ?? null,
            replacementStepKey: replacement?.stepKey ?? null,
            reason
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
        const knownStepKeys = new Set(postSupersede.steps.map((step) => step.stepKey));
        for (const patch of dependencyPatches) {
          const stepKey = patch.stepKey.trim();
          if (!stepKey.length) continue;
          const targetStep = resolveStep(postSupersede, stepKey);
          if (!targetStep) {
            return { ok: false, error: `dependencyPatches references unknown step '${stepKey}'.` };
          }
          const nextDeps = [...new Set(patch.dependencyStepKeys.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
          const unknownDeps = nextDeps.filter((depKey) => !knownStepKeys.has(depKey));
          if (unknownDeps.length > 0) {
            return {
              ok: false,
              error: `dependencyPatches for '${stepKey}' references unknown dependency keys: ${unknownDeps.join(", ")}`
            };
          }
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
            reason,
            replacedStepKeys: uniqueTargets,
            newStepKeys: createdSteps.map((step) => step.stepKey),
            dependencyPatchesApplied: dependencyPatches.length,
            warnings
          }
        });
        orchestratorService.appendTimelineEvent({
          runId,
          eventType: "plan_revised",
          reason: "revise_plan",
          detail: {
            mode,
            reason,
            superseded,
            newStepKeys: createdSteps.map((step) => step.stepKey),
            dependencyPatchesApplied: dependencyPatches.length,
            warnings
          }
        });

        setTimeout(() => {
          void orchestratorService.startReadyAutopilotAttempts({
            runId,
            reason: "coordinator_revise_plan",
          }).catch(() => {});
        }, 100);

        return {
          ok: true,
          mode,
          reason,
          superseded,
          newStepKeys: createdSteps.map((step) => step.stepKey),
          dependencyPatchesApplied: dependencyPatches.length,
          warnings
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.revise_plan.error", { error: msg });
        return { ok: false, error: msg };
      }
    }
  });

  const update_tool_profiles = tool({
    description:
      "Update role-bound tool profiles during a run. Useful when conditions change mid-mission.",
    inputSchema: z.object({
      role: z.string().describe("Role name to update"),
      allowedTools: z.array(z.string()).min(1),
      blockedTools: z.array(z.string()).optional(),
      mcpServers: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }),
    execute: async ({ role, allowedTools, blockedTools, mcpServers, notes }) => {
      try {
        const runRow = db.get<{ metadata_json: string | null }>(
          `select metadata_json from orchestrator_runs where id = ? limit 1`,
          [runId]
        );
        if (!runRow) return { ok: false, error: `Run not found: ${runId}` };
        const metadata = runRow.metadata_json ? (JSON.parse(runRow.metadata_json) as Record<string, unknown>) : {};
        const teamRuntime = asRecord(metadata.teamRuntime) ?? {};
        const currentProfiles = asRecord(teamRuntime.toolProfiles) ?? {};
        const normalizedRole = role.trim().toLowerCase();
        currentProfiles[normalizedRole] = {
          allowedTools: allowedTools.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
          ...(blockedTools && blockedTools.length > 0
            ? { blockedTools: blockedTools.map((entry) => entry.trim()).filter((entry) => entry.length > 0) }
            : {}),
          ...(mcpServers && mcpServers.length > 0
            ? { mcpServers: mcpServers.map((entry) => entry.trim()).filter((entry) => entry.length > 0) }
            : {}),
          ...(notes && notes.trim().length > 0 ? { notes: notes.trim() } : {})
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

  const transfer_lane = tool({
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

  // ─── Task Management ──────────────────────────────────────────

  const create_task = tool({
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
        const maxIndex = g.steps.reduce(
          (max, s) => Math.max(max, s.stepIndex),
          -1,
        );
        const created = orchestratorService.addSteps({
          runId,
          steps: [
            {
              stepKey: key,
              title,
              stepIndex: maxIndex + 1,
              dependencyStepKeys: dependsOn,
              executorKind: "unified",
              metadata: { instructions: description, isTask: true },
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
        logger.info("coordinator.create_task", { key, title });
        return {
          ok: true,
          taskKey: key,
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

  const update_task = tool({
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

  const assign_task = tool({
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

  const list_tasks = tool({
    description:
      "Get all tasks and their current statuses.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const g = graph();
        const total = g.steps.length;
        const byStatus: Record<string, number> = {};
        for (const step of g.steps) {
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

  const skip_step = tool({
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
          orchestratorService.completeAttempt({
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

  const mark_step_complete = tool({
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
        const requireValidatorPass = isValidatorPassRequired(g);
        if (validationContract?.required && validationState !== "pass" && requireValidatorPass) {
          return {
            ok: false,
            error: `Step '${workerId}' requires validator pass before completion (current validation state: ${validationState}).`,
            hint: "Run report_validation with verdict='pass' for this step, or disable the mission policy flag requireValidatorPass to bypass.",
            policy: { requireValidatorPass },
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
          orchestratorService.completeAttempt({
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
          }).catch(() => {});
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

  const mark_step_failed = tool({
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
          orchestratorService.completeAttempt({
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

  const retry_step = tool({
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
          }).catch(() => {});
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

  const complete_mission = tool({
    description:
      "Declare the mission complete. Call this when you are satisfied that all work is done.",
    inputSchema: z.object({
      summary: z.string().describe("Summary of what was accomplished"),
    }),
    execute: async ({ summary }) => {
      try {
        const g = graph();
        const requireValidatorPass = isValidatorPassRequired(g);
        if (requireValidatorPass) {
          const blockers = g.steps
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
              hint: "Submit passing validation reports for blocked steps, or disable requireValidatorPass in mission policy to bypass.",
              policy: { requireValidatorPass },
              blockers
            };
          }
        }

        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "done",
          payload: { summary, completedBy: "coordinator" },
        });
        // Mark all remaining ready/blocked steps as skipped
        for (const step of g.steps) {
          if (step.status === "ready" || step.status === "blocked" || step.status === "pending") {
            orchestratorService.skipStep({
              runId,
              stepId: step.id,
              reason: "Mission completed by coordinator",
            });
          }
        }
        // Finalize via proper lifecycle callback
        if (deps.onRunFinalize) {
          deps.onRunFinalize({ runId, succeeded: true, summary });
        } else {
          // Fallback: raw update if no callback provided (shouldn't happen in practice)
          const ts = nowIso();
          db.run(
            `update orchestrator_runs set status = 'succeeded', completed_at = ?, updated_at = ? where id = ?`,
            [ts, ts, runId],
          );
        }
        logger.info("coordinator.complete_mission", { runId, summary });
        return { ok: true, runId, summary };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.complete_mission.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const fail_mission = tool({
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
        deduped: true
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
      pauseMission: false,
      metadata: {
        source: args.source,
        runId,
        question,
        context: context.length > 0 ? context : null,
        urgency,
        canProceedWithoutAnswer: args.canProceedWithoutAnswer === true
      }
    });

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
        urgency
      },
    });
    orchestratorService.appendTimelineEvent({
      runId,
      eventType: "intervention_opened",
      reason: "coordinator_escalation",
      detail: {
        interventionId: intervention.id,
        source: args.source,
        urgency
      }
    });
    logger.info("coordinator.user_input_requested", {
      runId,
      missionId,
      interventionId: intervention.id,
      source: args.source,
      urgency
    });
    return { ok: true as const, interventionId: intervention.id, question, deduped: false };
  };

  const get_budget_status = tool({
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

  const ask_user = tool({
    description:
      "Escalate a genuinely blocking question to the human user. Creates an intervention visible in the UI.",
    inputSchema: z.object({
      question: z.string().describe("The question to ask the user"),
      context: z
        .string()
        .optional()
        .describe("Additional context for the question"),
      urgency: z.enum(["low", "normal", "high"]).default("normal")
    }),
    execute: async ({ question, context, urgency }) => {
      try {
        return openHumanIntervention({
          source: "ask_user",
          question,
          context: context ?? null,
          urgency
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.ask_user.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const request_user_input = tool({
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

  const read_file = tool({
    description:
      "Read a file from the project. Use to inspect code, configs, or docs when you need to understand the codebase.",
    inputSchema: z.object({
      filePath: z.string().describe("Path relative to project root, e.g. 'src/index.ts' or 'package.json'"),
      maxLines: z.number().optional().describe("Maximum number of lines to read (default: 200)"),
    }),
    execute: async ({ filePath, maxLines }) => {
      try {
        const fullPath = path.resolve(projectRoot, filePath);
        // Security: ensure path is within project root
        if (!fullPath.startsWith(projectRoot)) {
          return { ok: false, error: "Path is outside project root" };
        }
        if (!fs.existsSync(fullPath)) {
          return { ok: false, error: `File not found: ${filePath}` };
        }
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  });

  const read_step_output = tool({
    description:
      "Read a worker's structured step output file (.ade/step-output-{stepKey}.md). Workers write these files as durable output records when they complete their tasks. Use this to understand what a worker accomplished, especially after context compaction.",
    inputSchema: z.object({
      stepKey: z.string().describe("The step key to read the output file for"),
    }),
    execute: async ({ stepKey }) => {
      try {
        const sanitized = stepKey.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filePath = path.resolve(projectRoot, `.ade/step-output-${sanitized}.md`);
        if (!filePath.startsWith(projectRoot)) {
          return { ok: false, error: "Path is outside project root" };
        }
        if (!fs.existsSync(filePath)) {
          return { ok: false, error: `Step output file not found for step: ${stepKey}` };
        }
        const content = fs.readFileSync(filePath, "utf-8");
        return { ok: true, stepKey, content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  });

  const search_files = tool({
    description:
      "Search project files by name pattern or content. Use to find relevant code or files.",
    inputSchema: z.object({
      pattern: z.string().describe("Search pattern — a filename glob (e.g. '**/*.ts') or content regex"),
      searchType: z.enum(["filename", "content"]).default("content").describe("Whether to search file names or file content"),
      maxResults: z.number().optional().describe("Maximum results to return (default: 20)"),
    }),
    execute: async ({ pattern, searchType, maxResults }) => {
      try {
        const limit = maxResults ?? 20;
        if (searchType === "filename") {
          // Simple recursive file listing with glob matching
          const results: string[] = [];
          const walkDir = (dir: string, depth = 0) => {
            if (depth > 6 || results.length >= limit) return;
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (results.length >= limit) break;
                if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
                const rel = path.relative(projectRoot, path.join(dir, entry.name));
                if (entry.isDirectory()) {
                  walkDir(path.join(dir, entry.name), depth + 1);
                } else if (new RegExp(pattern.replace(/\*/g, ".*")).test(entry.name)) {
                  results.push(rel);
                }
              }
            } catch {
              // Skip unreadable dirs
            }
          };
          walkDir(projectRoot);
          return { ok: true, searchType, pattern, results, total: results.length };
        }
        // Content search using a simple line-by-line grep
        const results: Array<{ file: string; line: number; text: string }> = [];
        const regex = new RegExp(pattern, "i");
        const walkDir = (dir: string, depth = 0) => {
          if (depth > 6 || results.length >= limit) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (results.length >= limit) break;
              if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walkDir(fullPath, depth + 1);
              } else {
                try {
                  const stat = fs.statSync(fullPath);
                  if (stat.size > 500_000) continue; // Skip large files
                  const content = fs.readFileSync(fullPath, "utf-8");
                  const lines = content.split("\n");
                  for (let i = 0; i < lines.length && results.length < limit; i++) {
                    if (regex.test(lines[i]!)) {
                      results.push({
                        file: path.relative(projectRoot, fullPath),
                        line: i + 1,
                        text: lines[i]!.slice(0, 200),
                      });
                    }
                  }
                } catch {
                  // Skip unreadable files
                }
              }
            }
          } catch {
            // Skip unreadable dirs
          }
        };
        walkDir(projectRoot);
        return { ok: true, searchType, pattern, results, total: results.length };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  });

  const get_project_context = tool({
    description:
      "Get a summary of the project: key docs, file structure, and config. Use at mission start to understand the codebase.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        // Read key project files
        const keyFiles = ["package.json", "tsconfig.json", "README.md", "CLAUDE.md"];
        const docs: Record<string, string> = {};
        for (const f of keyFiles) {
          const fp = path.resolve(projectRoot, f);
          try {
            if (fs.existsSync(fp)) {
              const content = fs.readFileSync(fp, "utf-8");
              docs[f] = content.slice(0, 4_000);
            }
          } catch {
            // Skip unreadable files
          }
        }
        // Top-level directory listing
        let topLevel: string[] = [];
        try {
          topLevel = fs.readdirSync(projectRoot)
            .filter((e) => !e.startsWith("."))
            .slice(0, 50);
        } catch {
          // Ignore
        }
        return {
          ok: true,
          projectRoot,
          topLevelEntries: topLevel,
          docs,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  });

  return {
    spawn_worker,
    insert_milestone,
    request_specialist,
    stop_worker,
    send_message,
    message_worker,
    broadcast,
    get_worker_output,
    list_workers,
    report_status,
    report_result,
    report_validation,
    read_mission_status,
    read_mission_state,
    update_mission_state,
    revise_plan,
    update_tool_profiles,
    transfer_lane,
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
  };
}
