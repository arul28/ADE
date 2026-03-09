import fs from "node:fs/promises";
import path from "node:path";
import type {
  CoordinatorCheckpoint,
  MissionCloseoutRequirement,
  MissionCoordinatorAvailability,
  MissionStateDecision,
  MissionStateDocument,
  MissionStateDocumentPatch,
  MissionFinalizationPolicy,
  MissionFinalizationState,
  MissionStateIssue,
  MissionStatePendingIntervention,
  MissionRetrospective,
  OrchestratorReflectionEntry,
  MissionStateProgress,
  MissionStateStepOutcome,
  MissionStateStepOutcomePartial,
} from "../../../shared/types";
import { isRecord, nowIso } from "./orchestratorContext";

const MISSION_STATE_DIR = ".ade";
const COORDINATOR_CHECKPOINT_VERSION = 1;
const MAX_DECISIONS = 30;
const MAX_STEP_OUTCOMES = 40;
const MAX_ACTIVE_ISSUES = 20;
const MAX_PENDING_INTERVENTIONS = 10;
const MAX_CHECKPOINT_SUMMARY_CHARS = 8_000;

const missionStateWriteQueues = new Map<string, Promise<MissionStateDocument>>();
const coordinatorCheckpointWriteQueues = new Map<string, Promise<CoordinatorCheckpointDocument>>();

export type CoordinatorCheckpointDocument = CoordinatorCheckpoint;

const stringOr = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const nullableString = (value: unknown): string | null =>
  value === null ? null : stringOr(value).trim() || null;

const nullableBool = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const clampNonNegativeInt = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
};

const normalizeStringArray = (value: unknown, max = 200): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (out.length >= max) break;
    const normalized = String(entry ?? "").trim();
    if (!normalized.length || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const trimSummary = (value: string): string => value.trim().slice(0, 200);

function missionStateQueueKey(projectRoot: string, runId: string): string {
  return `${projectRoot}::${runId}`;
}

export function getMissionStateDocumentPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MISSION_STATE_DIR, `mission-state-${runId}.json`);
}

export function getCoordinatorCheckpointPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MISSION_STATE_DIR, `coordinator-checkpoint-${runId}.json`);
}

function normalizeProgress(value: unknown): MissionStateProgress {
  const raw = isRecord(value) ? value : {};
  return {
    currentPhase: stringOr(raw.currentPhase, "unknown").trim() || "unknown",
    completedSteps: clampNonNegativeInt(raw.completedSteps, 0),
    totalSteps: clampNonNegativeInt(raw.totalSteps, 0),
    activeWorkers: normalizeStringArray(raw.activeWorkers),
    blockedSteps: normalizeStringArray(raw.blockedSteps),
    failedSteps: normalizeStringArray(raw.failedSteps),
  };
}

function normalizeStepOutcome(value: unknown): MissionStateStepOutcome | null {
  const raw = isRecord(value) ? value : null;
  if (!raw) return null;
  const stepKey = stringOr(raw.stepKey).trim();
  if (!stepKey.length) return null;
  const status =
    raw.status === "succeeded" || raw.status === "failed" || raw.status === "skipped" || raw.status === "in_progress"
      ? raw.status
      : "in_progress";
  const testsRunRaw = isRecord(raw.testsRun) ? raw.testsRun : null;
  const testsRun =
    testsRunRaw
      ? {
          passed: clampNonNegativeInt(testsRunRaw.passed, 0),
          failed: clampNonNegativeInt(testsRunRaw.failed, 0),
          skipped: clampNonNegativeInt(testsRunRaw.skipped, 0),
        }
      : undefined;
  const validationRaw = isRecord(raw.validation) ? raw.validation : null;
  const validation =
    validationRaw
      ? (() => {
          const verdict: "pass" | "fail" | null =
            validationRaw.verdict === "pass" || validationRaw.verdict === "fail" || validationRaw.verdict === null
              ? validationRaw.verdict
              : null;
          return {
          verdict,
            findings: normalizeStringArray(validationRaw.findings, 40),
          };
        })()
      : undefined;
  return {
    stepKey,
    stepName: stringOr(raw.stepName, stepKey).trim() || stepKey,
    phase: stringOr(raw.phase, "unknown").trim() || "unknown",
    status,
    summary: trimSummary(stringOr(raw.summary)),
    filesChanged: normalizeStringArray(raw.filesChanged, 50),
    ...(testsRun ? { testsRun } : {}),
    ...(validation ? { validation } : {}),
    warnings: normalizeStringArray(raw.warnings, 40),
    completedAt: raw.completedAt === null ? null : stringOr(raw.completedAt).trim() || null,
  };
}

function normalizeDecision(value: unknown): MissionStateDecision | null {
  const raw = isRecord(value) ? value : null;
  if (!raw) return null;
  const timestamp = stringOr(raw.timestamp).trim();
  const decision = stringOr(raw.decision).trim();
  const rationale = stringOr(raw.rationale).trim();
  const context = stringOr(raw.context).trim();
  if (!timestamp || !decision) return null;
  return { timestamp, decision, rationale, context };
}

function normalizeIssue(value: unknown): MissionStateIssue | null {
  const raw = isRecord(value) ? value : null;
  if (!raw) return null;
  const id = stringOr(raw.id).trim();
  if (!id.length) return null;
  return {
    id,
    severity: raw.severity === "low" || raw.severity === "medium" || raw.severity === "high" ? raw.severity : "medium",
    description: stringOr(raw.description).trim(),
    affectedSteps: normalizeStringArray(raw.affectedSteps),
    status: raw.status === "open" || raw.status === "mitigated" || raw.status === "resolved" ? raw.status : "open",
  };
}

function normalizePendingIntervention(value: unknown): MissionStatePendingIntervention | null {
  const raw = isRecord(value) ? value : null;
  if (!raw) return null;
  const id = stringOr(raw.id).trim();
  if (!id.length) return null;
  return {
    id,
    type: stringOr(raw.type).trim() || "unknown",
    title: stringOr(raw.title).trim() || id,
    createdAt: stringOr(raw.createdAt).trim() || nowIso(),
  };
}

function normalizeCloseoutRequirement(value: unknown): MissionCloseoutRequirement | null {
  const raw = isRecord(value) ? value : null;
  if (!raw) return null;
  const key = stringOr(raw.key).trim();
  const label = stringOr(raw.label).trim();
  if (!key.length || !label.length) return null;
  return {
    key: key as MissionCloseoutRequirement["key"],
    label,
    required: raw.required === true,
    status:
      raw.status === "present" || raw.status === "missing" || raw.status === "waived"
        ? raw.status
        : "missing",
    detail: nullableString(raw.detail),
    artifactId: nullableString(raw.artifactId),
    uri: nullableString(raw.uri),
    source:
      raw.source === "declared" || raw.source === "discovered" || raw.source === "runtime" || raw.source === "waiver"
        ? raw.source
        : "runtime",
  };
}

function normalizeFinalizationPolicy(value: unknown): MissionFinalizationPolicy | null {
  const raw = isRecord(value) ? value : null;
  if (!raw) return null;
  const kind =
    raw.kind === "disabled" || raw.kind === "manual" || raw.kind === "integration" || raw.kind === "per-lane" || raw.kind === "queue"
      ? raw.kind
      : null;
  if (!kind) return null;
  const prDepth =
    raw.prDepth === "propose-only" || raw.prDepth === "resolve-conflicts" || raw.prDepth === "open-and-comment"
      ? raw.prDepth
      : null;
  return {
    kind,
    targetBranch: nullableString(raw.targetBranch),
    draft: nullableBool(raw.draft),
    prDepth,
    autoRebase: nullableBool(raw.autoRebase),
    ciGating: nullableBool(raw.ciGating),
    autoLand: nullableBool(raw.autoLand),
    rehearseQueue: nullableBool(raw.rehearseQueue),
    autoResolveConflicts: nullableBool(raw.autoResolveConflicts),
    archiveLaneOnLand: nullableBool(raw.archiveLaneOnLand),
    mergeMethod:
      raw.mergeMethod === "merge" || raw.mergeMethod === "squash" || raw.mergeMethod === "rebase"
        ? raw.mergeMethod
        : null,
    conflictResolverModel: nullableString(raw.conflictResolverModel),
    reasoningEffort: nullableString(raw.reasoningEffort),
    description: nullableString(raw.description),
  };
}

function normalizeFinalizationState(value: unknown): MissionFinalizationState | null {
  const raw = isRecord(value) ? value : null;
  if (!raw) return null;
  const policy = normalizeFinalizationPolicy(raw.policy);
  if (!policy) return null;
  const VALID_FINALIZATION_STATUSES = new Set([
    "idle", "finalizing", "creating_pr", "rehearsing_queue", "landing_queue",
    "resolving_integration_conflicts", "resolving_queue_conflicts", "waiting_for_green",
    "awaiting_operator_review", "posting_review_comment", "finalization_failed", "completed",
  ]);
  const VALID_WAIT_REASONS = new Set(["ci", "review", "merge_conflict", "resolver_failed", "merge_blocked", "manual", "canceled"]);
  const status = VALID_FINALIZATION_STATUSES.has(raw.status as string)
    ? (raw.status as MissionFinalizationState["status"])
    : "idle";
  const waitReason = VALID_WAIT_REASONS.has(raw.waitReason as string)
    ? (raw.waitReason as MissionFinalizationState["waitReason"])
    : null;
  return {
    policy,
    status,
    executionComplete: raw.executionComplete === true,
    contractSatisfied: raw.contractSatisfied === true,
    blocked: raw.blocked === true,
    blockedReason: nullableString(raw.blockedReason),
    summary: nullableString(raw.summary),
    detail: nullableString(raw.detail),
    resolverJobId: nullableString(raw.resolverJobId),
    integrationLaneId: nullableString(raw.integrationLaneId),
    queueGroupId: nullableString(raw.queueGroupId),
    queueId: nullableString(raw.queueId),
    queueRehearsalId: nullableString(raw.queueRehearsalId),
    scratchLaneId: nullableString(raw.scratchLaneId),
    activePrId: nullableString(raw.activePrId),
    waitReason,
    proposalUrl: nullableString(raw.proposalUrl),
    prUrls: normalizeStringArray(raw.prUrls, 20),
    reviewStatus: nullableString(raw.reviewStatus),
    mergeReadiness: nullableString(raw.mergeReadiness),
    requirements: Array.isArray(raw.requirements)
      ? raw.requirements
          .map((entry) => normalizeCloseoutRequirement(entry))
          .filter((entry): entry is MissionCloseoutRequirement => Boolean(entry))
      : [],
    warnings: normalizeStringArray(raw.warnings, 40),
    updatedAt: stringOr(raw.updatedAt).trim() || nowIso(),
    startedAt: nullableString(raw.startedAt),
    completedAt: nullableString(raw.completedAt),
  };
}

function normalizeCoordinatorAvailability(value: unknown): MissionCoordinatorAvailability | null {
  const raw = isRecord(value) ? value : null;
  if (!raw) return null;
  const mode =
    raw.mode === "offline" || raw.mode === "consult_only" || raw.mode === "continuation_required"
      ? raw.mode
      : null;
  const summary = stringOr(raw.summary).trim();
  if (!mode || !summary.length) return null;
  return {
    available: raw.available === true,
    mode,
    summary,
    detail: nullableString(raw.detail),
    updatedAt: stringOr(raw.updatedAt).trim() || nowIso(),
  };
}


function normalizeReflectionEntry(value: unknown): OrchestratorReflectionEntry | null {
  const raw = isRecord(value) ? value : null;
  if (!raw) return null;
  const id = stringOr(raw.id).trim();
  const missionId = stringOr(raw.missionId).trim();
  const runId = stringOr(raw.runId).trim();
  const observation = stringOr(raw.observation).trim();
  if (!id || !missionId || !runId || !observation) return null;
  const signalTypeRaw = stringOr(raw.signalType).trim();
  const signalType = signalTypeRaw === "wish" || signalTypeRaw === "frustration" || signalTypeRaw === "idea" || signalTypeRaw === "pattern" || signalTypeRaw === "limitation"
    ? signalTypeRaw
    : "idea";
  return {
    id,
    projectId: stringOr(raw.projectId).trim(),
    missionId,
    runId,
    stepId: stringOr(raw.stepId).trim() || null,
    attemptId: stringOr(raw.attemptId).trim() || null,
    agentRole: stringOr(raw.agentRole).trim() || "unknown",
    phase: stringOr(raw.phase).trim() || "unknown",
    signalType,
    observation,
    recommendation: stringOr(raw.recommendation).trim(),
    context: stringOr(raw.context).trim(),
    occurredAt: stringOr(raw.occurredAt).trim() || nowIso(),
    createdAt: stringOr(raw.createdAt).trim() || nowIso(),
    schemaVersion: 1,
  };
}

function normalizeRetrospective(value: unknown): MissionRetrospective | null {
  const raw = isRecord(value) ? value : null;
  if (!raw) return null;
  const id = stringOr(raw.id).trim();
  const missionId = stringOr(raw.missionId).trim();
  const runId = stringOr(raw.runId).trim();
  if (!id || !missionId || !runId) return null;
  const finalStatusRaw = stringOr(raw.finalStatus).trim();
  const finalStatus = finalStatusRaw === "queued" || finalStatusRaw === "bootstrapping" || finalStatusRaw === "active" || finalStatusRaw === "paused" || finalStatusRaw === "completing" || finalStatusRaw === "succeeded" || finalStatusRaw === "failed" || finalStatusRaw === "canceled" ? finalStatusRaw : "failed";
  return {
    id,
    missionId,
    runId,
    generatedAt: stringOr(raw.generatedAt).trim() || nowIso(),
    schemaVersion: 1,
    finalStatus,
    wins: normalizeStringArray(raw.wins, 30),
    failures: normalizeStringArray(raw.failures, 30),
    unresolvedRisks: normalizeStringArray(raw.unresolvedRisks, 30),
    followUpActions: normalizeStringArray(raw.followUpActions, 30),
    topPainPoints: normalizeStringArray(raw.topPainPoints, 30),
    topImprovements: normalizeStringArray(raw.topImprovements, 30),
    patternsToCapture: normalizeStringArray(raw.patternsToCapture, 30),
    estimatedImpact: stringOr(raw.estimatedImpact).trim(),
    changelog: Array.isArray(raw.changelog)
      ? raw.changelog
          .filter(
            (x): x is MissionRetrospective["changelog"][number] =>
              isRecord(x) &&
              typeof x.previousPainPoint === "string" &&
              typeof x.currentState === "string" &&
              (x.status === "resolved" || x.status === "still_open" || x.status === "worsened"),
          )
          .map((x) => {
            const previousPainScore = Number(x.previousPainScore);
            const currentPainScore = Number(x.currentPainScore);
            return {
              previousPainPoint: String(x.previousPainPoint),
              status: x.status as MissionRetrospective["changelog"][number]["status"],
              currentState: String(x.currentState),
              ...(typeof x.fixApplied === "string" && x.fixApplied.trim() ? { fixApplied: x.fixApplied.trim() } : {}),
              ...(typeof x.sourceRetrospectiveId === "string" && x.sourceRetrospectiveId.trim().length
                ? { sourceRetrospectiveId: x.sourceRetrospectiveId.trim() }
                : {}),
              ...(typeof x.sourceMissionId === "string" && x.sourceMissionId.trim().length
                ? { sourceMissionId: x.sourceMissionId.trim() }
                : {}),
              ...(typeof x.sourceRunId === "string" && x.sourceRunId.trim().length
                ? { sourceRunId: x.sourceRunId.trim() }
                : {}),
              ...(Number.isFinite(previousPainScore) ? { previousPainScore } : {}),
              ...(Number.isFinite(currentPainScore) ? { currentPainScore } : {}),
            };
          })
      : [],
  };
}

function normalizeDocument(rawDoc: unknown): MissionStateDocument | null {
  const raw = isRecord(rawDoc) ? rawDoc : null;
  if (!raw) return null;
  if (Number(raw.schemaVersion) !== 1) return null;
  const missionId = stringOr(raw.missionId).trim();
  const runId = stringOr(raw.runId).trim();
  if (!missionId.length || !runId.length) return null;
  const stepOutcomes = Array.isArray(raw.stepOutcomes)
    ? raw.stepOutcomes
        .map((entry) => normalizeStepOutcome(entry))
        .filter((entry): entry is MissionStateStepOutcome => Boolean(entry))
    : [];
  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions
        .map((entry) => normalizeDecision(entry))
        .filter((entry): entry is MissionStateDecision => Boolean(entry))
    : [];
  const activeIssues = Array.isArray(raw.activeIssues)
    ? raw.activeIssues
        .map((entry) => normalizeIssue(entry))
        .filter((entry): entry is MissionStateIssue => Boolean(entry))
    : [];
  const pendingInterventions = Array.isArray(raw.pendingInterventions)
    ? raw.pendingInterventions
        .map((entry) => normalizePendingIntervention(entry))
        .filter((entry): entry is MissionStatePendingIntervention => Boolean(entry))
    : [];
  const modifiedFiles = normalizeStringArray(raw.modifiedFiles);
  const finalization = normalizeFinalizationState(raw.finalization);
  const coordinatorAvailability = normalizeCoordinatorAvailability(raw.coordinatorAvailability);
  return {
    schemaVersion: 1,
    missionId,
    runId,
    goal: stringOr(raw.goal).trim(),
    updatedAt: stringOr(raw.updatedAt).trim() || nowIso(),
    progress: normalizeProgress(raw.progress),
    stepOutcomes: stepOutcomes.slice(-MAX_STEP_OUTCOMES),
    decisions: decisions.slice(-MAX_DECISIONS),
    activeIssues: activeIssues.slice(-MAX_ACTIVE_ISSUES),
    modifiedFiles,
    pendingInterventions: pendingInterventions.slice(-MAX_PENDING_INTERVENTIONS),
    finalization,
    coordinatorAvailability,
    reflections: Array.isArray(raw.reflections)
      ? raw.reflections.map((entry) => normalizeReflectionEntry(entry)).filter((entry): entry is OrchestratorReflectionEntry => Boolean(entry)).slice(-200)
      : [],
    latestRetrospective: normalizeRetrospective(raw.latestRetrospective),
  };
}

function normalizeCoordinatorCheckpoint(rawDoc: unknown): CoordinatorCheckpointDocument | null {
  const raw = isRecord(rawDoc) ? rawDoc : null;
  if (!raw) return null;
  const runId = stringOr(raw.runId).trim();
  const missionId = stringOr(raw.missionId).trim();
  if (!runId.length || !missionId.length) return null;
  const lastEventTimestampRaw = raw.lastEventTimestamp;
  const lastEventTimestamp =
    typeof lastEventTimestampRaw === "string" && lastEventTimestampRaw.trim().length > 0
      ? lastEventTimestampRaw.trim()
      : null;
  return {
    version: COORDINATOR_CHECKPOINT_VERSION,
    runId,
    missionId,
    conversationSummary: stringOr(raw.conversationSummary).trim().slice(0, MAX_CHECKPOINT_SUMMARY_CHARS),
    lastEventTimestamp,
    turnCount: clampNonNegativeInt(raw.turnCount, 0),
    compactionCount: clampNonNegativeInt(raw.compactionCount, 0),
    savedAt: stringOr(raw.savedAt).trim() || nowIso(),
  };
}

function mergeStepOutcomeUpdates(
  current: MissionStateStepOutcome,
  updates: MissionStateStepOutcomePartial
): MissionStateStepOutcome {
  const testsRun = (() => {
    if (updates.testsRun === undefined) return current.testsRun;
    const existing = current.testsRun ?? { passed: 0, failed: 0, skipped: 0 };
    return {
      passed: clampNonNegativeInt(updates.testsRun.passed, existing.passed),
      failed: clampNonNegativeInt(updates.testsRun.failed, existing.failed),
      skipped: clampNonNegativeInt(updates.testsRun.skipped, existing.skipped),
    };
  })();
  const validation = (() => {
    if (updates.validation === undefined) return current.validation;
    const existing = current.validation ?? { verdict: null, findings: [] };
    return {
      verdict:
        updates.validation.verdict === "pass" || updates.validation.verdict === "fail" || updates.validation.verdict === null
          ? updates.validation.verdict
          : existing.verdict,
      findings: updates.validation.findings ? normalizeStringArray(updates.validation.findings) : existing.findings,
    };
  })();
  const status =
    updates.status === "succeeded" || updates.status === "failed" || updates.status === "skipped" || updates.status === "in_progress"
      ? updates.status
      : current.status;
  return {
    ...current,
    stepName: updates.stepName ? updates.stepName.trim() || current.stepName : current.stepName,
    phase: updates.phase ? updates.phase.trim() || current.phase : current.phase,
    status,
    summary: updates.summary !== undefined ? trimSummary(updates.summary) : current.summary,
    filesChanged: updates.filesChanged ? normalizeStringArray(updates.filesChanged, 50) : current.filesChanged,
    warnings: updates.warnings ? normalizeStringArray(updates.warnings, 40) : current.warnings,
    completedAt: updates.completedAt !== undefined ? updates.completedAt : current.completedAt,
    ...(testsRun ? { testsRun } : {}),
    ...(validation ? { validation } : {}),
  };
}

function createDefaultStepOutcome(stepKey: string): MissionStateStepOutcome {
  return {
    stepKey,
    stepName: stepKey,
    phase: "unknown",
    status: "in_progress",
    summary: "",
    filesChanged: [],
    warnings: [],
    completedAt: null,
  };
}

function applyPatch(doc: MissionStateDocument, patch: MissionStateDocumentPatch): MissionStateDocument {
  const next: MissionStateDocument = {
    ...doc,
    progress: { ...doc.progress },
    stepOutcomes: [...doc.stepOutcomes],
    decisions: [...doc.decisions],
    activeIssues: [...doc.activeIssues],
    modifiedFiles: [...doc.modifiedFiles],
    pendingInterventions: [...doc.pendingInterventions],
    finalization: doc.finalization ?? null,
    coordinatorAvailability: doc.coordinatorAvailability ?? null,
    reflections: [...(doc.reflections ?? [])],
    latestRetrospective: doc.latestRetrospective ?? null,
    updatedAt: nowIso(),
  };

  if (patch.updateProgress) {
    const progress = patch.updateProgress;
    if (progress.currentPhase !== undefined) next.progress.currentPhase = stringOr(progress.currentPhase, "unknown").trim() || "unknown";
    if (progress.completedSteps !== undefined) next.progress.completedSteps = clampNonNegativeInt(progress.completedSteps, next.progress.completedSteps);
    if (progress.totalSteps !== undefined) next.progress.totalSteps = clampNonNegativeInt(progress.totalSteps, next.progress.totalSteps);
    if (progress.activeWorkers !== undefined) next.progress.activeWorkers = normalizeStringArray(progress.activeWorkers);
    if (progress.blockedSteps !== undefined) next.progress.blockedSteps = normalizeStringArray(progress.blockedSteps);
    if (progress.failedSteps !== undefined) next.progress.failedSteps = normalizeStringArray(progress.failedSteps);
  }

  if (patch.addStepOutcome) {
    const normalized = normalizeStepOutcome(patch.addStepOutcome);
    if (normalized) {
      const idx = next.stepOutcomes.findIndex((entry) => entry.stepKey === normalized.stepKey);
      if (idx >= 0) {
        next.stepOutcomes[idx] = mergeStepOutcomeUpdates(next.stepOutcomes[idx]!, normalized);
      } else {
        next.stepOutcomes.push(normalized);
      }
    }
  }

  if (patch.updateStepOutcome) {
    const stepKey = patch.updateStepOutcome.stepKey.trim();
    if (stepKey.length) {
      const idx = next.stepOutcomes.findIndex((entry) => entry.stepKey === stepKey);
      const current = idx >= 0 ? next.stepOutcomes[idx]! : createDefaultStepOutcome(stepKey);
      const merged = mergeStepOutcomeUpdates(current, patch.updateStepOutcome.updates);
      if (idx >= 0) {
        next.stepOutcomes[idx] = merged;
      } else {
        next.stepOutcomes.push(merged);
      }
    }
  }

  if (patch.addDecision) {
    const normalized = normalizeDecision(patch.addDecision);
    if (normalized) {
      next.decisions.push(normalized);
    }
  }

  if (patch.addIssue) {
    const normalized = normalizeIssue(patch.addIssue);
    if (normalized) {
      const idx = next.activeIssues.findIndex((entry) => entry.id === normalized.id);
      if (idx >= 0) {
        next.activeIssues[idx] = normalized;
      } else {
        next.activeIssues.push(normalized);
      }
    }
  }

  if (patch.resolveIssue) {
    const issueId = patch.resolveIssue.id.trim();
    const idx = next.activeIssues.findIndex((entry) => entry.id === issueId);
    if (idx >= 0) {
      next.activeIssues[idx] = {
        ...next.activeIssues[idx]!,
        status: "resolved",
      };
    }
    const resolution = patch.resolveIssue.resolution.trim();
    if (issueId.length && resolution.length) {
      next.decisions.push({
        timestamp: nowIso(),
        decision: `Resolved issue ${issueId}`,
        rationale: resolution,
        context: "Issue resolution",
      });
    }
  }

  if (patch.pendingInterventions) {
    next.pendingInterventions = patch.pendingInterventions
      .map((entry) => normalizePendingIntervention(entry))
      .filter((entry): entry is MissionStatePendingIntervention => Boolean(entry))
      .slice(-MAX_PENDING_INTERVENTIONS);
  }

  if (patch.finalization !== undefined) {
    next.finalization = patch.finalization ? normalizeFinalizationState(patch.finalization) : null;
  }

  if (patch.coordinatorAvailability !== undefined) {
    next.coordinatorAvailability = patch.coordinatorAvailability
      ? normalizeCoordinatorAvailability(patch.coordinatorAvailability)
      : null;
  }

  if (patch.reflections) {
    next.reflections = patch.reflections
      .map((entry) => normalizeReflectionEntry(entry))
      .filter((entry): entry is OrchestratorReflectionEntry => Boolean(entry))
      .slice(-200);
  }

  if (patch.latestRetrospective !== undefined) {
    next.latestRetrospective = patch.latestRetrospective ? normalizeRetrospective(patch.latestRetrospective) : null;
  }

  next.stepOutcomes = next.stepOutcomes.slice(-MAX_STEP_OUTCOMES);
  next.decisions = next.decisions.slice(-MAX_DECISIONS);
  next.activeIssues = next.activeIssues.slice(-MAX_ACTIVE_ISSUES);
  next.modifiedFiles = normalizeStringArray(next.stepOutcomes.flatMap((entry) => entry.filesChanged), 150);
  return next;
}

async function loadDocumentFromDisk(filePath: string): Promise<MissionStateDocument | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeDocument(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeDocumentToDisk(filePath: string, doc: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(doc, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

export function createInitialMissionStateDocument(args: {
  missionId: string;
  runId: string;
  goal: string;
  progress?: Partial<MissionStateProgress>;
}): MissionStateDocument {
  return {
    schemaVersion: 1,
    missionId: args.missionId,
    runId: args.runId,
    goal: args.goal,
    updatedAt: nowIso(),
    progress: normalizeProgress(args.progress),
    stepOutcomes: [],
    decisions: [],
    activeIssues: [],
    modifiedFiles: [],
    pendingInterventions: [],
    reflections: [],
    latestRetrospective: null,
  };
}

export async function updateMissionStateDocument(args: {
  projectRoot: string;
  missionId: string;
  runId: string;
  goal: string;
  patch: MissionStateDocumentPatch;
  initialProgress?: Partial<MissionStateProgress>;
}): Promise<MissionStateDocument> {
  const filePath = getMissionStateDocumentPath(args.projectRoot, args.runId);
  const key = missionStateQueueKey(args.projectRoot, args.runId);
  const previous = missionStateWriteQueues.get(key) ?? Promise.resolve(
    createInitialMissionStateDocument({
      missionId: args.missionId,
      runId: args.runId,
      goal: args.goal,
      progress: args.initialProgress,
    })
  );
  const nextJob = previous
    .catch(() =>
      createInitialMissionStateDocument({
        missionId: args.missionId,
        runId: args.runId,
        goal: args.goal,
        progress: args.initialProgress,
      })
    )
    .then(async () => {
      const existing = await loadDocumentFromDisk(filePath);
      const base =
        existing ??
        createInitialMissionStateDocument({
          missionId: args.missionId,
          runId: args.runId,
          goal: args.goal,
          progress: args.initialProgress,
        });
      const nextDoc = applyPatch(base, args.patch);
      await writeDocumentToDisk(filePath, nextDoc);
      return nextDoc;
    });
  missionStateWriteQueues.set(key, nextJob);
  try {
    return await nextJob;
  } finally {
    if (missionStateWriteQueues.get(key) === nextJob) {
      missionStateWriteQueues.delete(key);
    }
  }
}

export async function readMissionStateDocument(args: {
  projectRoot: string;
  runId: string;
}): Promise<MissionStateDocument | null> {
  const key = missionStateQueueKey(args.projectRoot, args.runId);
  const pending = missionStateWriteQueues.get(key);
  if (pending) {
    try {
      await pending;
    } catch {
      // Best-effort wait; continue reading last persisted content.
    }
  }
  return loadDocumentFromDisk(getMissionStateDocumentPath(args.projectRoot, args.runId));
}

export async function writeCoordinatorCheckpoint(
  projectRoot: string,
  runId: string,
  checkpoint: CoordinatorCheckpointDocument
): Promise<CoordinatorCheckpointDocument> {
  const filePath = getCoordinatorCheckpointPath(projectRoot, runId);
  const key = missionStateQueueKey(projectRoot, runId);
  const normalizedInput = normalizeCoordinatorCheckpoint({
    ...checkpoint,
    version: COORDINATOR_CHECKPOINT_VERSION,
    runId,
  });
  if (!normalizedInput) {
    throw new Error(`Invalid coordinator checkpoint payload for run '${runId}'.`);
  }
  const previous = coordinatorCheckpointWriteQueues.get(key) ?? Promise.resolve(normalizedInput);
  const nextJob = previous
    .catch(() => normalizedInput)
    .then(async () => {
      const normalized = normalizeCoordinatorCheckpoint(normalizedInput);
      if (!normalized) {
        throw new Error(`Unable to normalize coordinator checkpoint for run '${runId}'.`);
      }
      await writeDocumentToDisk(filePath, normalized);
      return normalized;
    });
  coordinatorCheckpointWriteQueues.set(key, nextJob);
  try {
    return await nextJob;
  } finally {
    if (coordinatorCheckpointWriteQueues.get(key) === nextJob) {
      coordinatorCheckpointWriteQueues.delete(key);
    }
  }
}

export async function readCoordinatorCheckpoint(
  projectRoot: string,
  runId: string
): Promise<CoordinatorCheckpointDocument | null> {
  const key = missionStateQueueKey(projectRoot, runId);
  const pending = coordinatorCheckpointWriteQueues.get(key);
  if (pending) {
    try {
      await pending;
    } catch {
      // Best-effort wait; continue reading last persisted content.
    }
  }
  const filePath = getCoordinatorCheckpointPath(projectRoot, runId);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    // ENOENT is the expected case (no checkpoint written yet) — silent.
    // Any other read error is unexpected; log it.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[missionStateDoc] Failed to read coordinator checkpoint for run '${runId}':`, error);
    }
    return null;
  }
  try {
    return normalizeCoordinatorCheckpoint(JSON.parse(raw));
  } catch (error) {
    // File exists but could not be parsed — warn so corrupt checkpoints are visible.
    console.warn(`[missionStateDoc] Corrupt coordinator checkpoint for run '${runId}' — ignoring:`, error);
    return null;
  }
}

export async function deleteCoordinatorCheckpoint(
  projectRoot: string,
  runId: string
): Promise<void> {
  const key = missionStateQueueKey(projectRoot, runId);
  const pending = coordinatorCheckpointWriteQueues.get(key);
  if (pending) {
    try {
      await pending;
    } catch {
      // Ignore pending write failures; cleanup should still proceed.
    }
  }
  try {
    await fs.unlink(getCoordinatorCheckpointPath(projectRoot, runId));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}
