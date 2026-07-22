import type {
  DelegationEdge,
  DelegationStatus,
  ManifestPatchOp,
  OrchestrationManifest,
  OrchestrationTaskStatus,
  PlanningStage,
  PlanSpec,
  PlanSpecSectionId,
  ValidationChecklistRun,
} from "../../../shared/types/orchestration";

// ---------------------------------------------------------------------------
// Phase / status constants
// ---------------------------------------------------------------------------

export const ORCHESTRATION_PHASE_IDS = new Set(["planning", "developing", "validating", "wrapup"]);
export const ORCHESTRATION_TASK_STATUSES = new Set<string>([
  "pending",
  "claimed",
  "in_progress",
  "review",
  "done",
  "failed",
]);

const RECEIPT_CAP = 200;
const OUTBOX_TERMINAL_CAP = 200;

const RECEIPT_KINDS = new Set<string>(["spawnAgent", "messageAgent"]);
const RECEIPT_STATUSES = new Set<string>(["pending", "completed"]);
const OUTBOX_KINDS = new Set<string>([
  "brief",
  "ping",
  "lead_status",
  "cancel_interrupt",
  "completion",
]);
const OUTBOX_STATUSES = new Set<string>([
  "pending",
  "delivering",
  "delivered",
  "failed",
]);
const OUTBOX_DELIVERY_OPS = new Set<string>([
  "sendMessage",
  "steer",
  "interrupt-replace",
  "interrupt",
]);

export function isPhaseId(value: unknown): value is OrchestrationManifest["currentPhase"] {
  return typeof value === "string" && ORCHESTRATION_PHASE_IDS.has(value);
}

// ---------------------------------------------------------------------------
// Planning state machine + PlanSpec seeds
// ---------------------------------------------------------------------------

export const PLANNING_STAGES = new Set<string>([
  "intake",
  "round_functional",
  "round_ui",
  "round_extras",
  "rounds_complete",
  "ready",
]);

export function isPlanningStage(value: unknown): value is PlanningStage {
  return typeof value === "string" && PLANNING_STAGES.has(value);
}

/** Required-section coverage map for plan.md (drives the readiness gate). */
const PLAN_SPEC_SECTION_DEFS: { id: PlanSpecSectionId; required: boolean }[] = [
  { id: "goal", required: true },
  { id: "assumptions", required: false },
  { id: "in_scope", required: true },
  { id: "out_of_scope", required: true },
  { id: "alternatives", required: true },
  { id: "implementation_order", required: true },
  { id: "agent_plan", required: true },
  { id: "validation_plan", required: true },
  { id: "ui_decisions", required: true },
  { id: "coordination", required: true },
];

export function createInitialPlanningState(): NonNullable<OrchestrationManifest["leadState"]["planning"]> {
  return { stage: "intake", rounds: [] };
}

export function createInitialPlanSpec(): PlanSpec {
  return {
    sections: PLAN_SPEC_SECTION_DEFS.map((def) => ({
      id: def.id,
      required: def.required,
      status: "missing" as const,
    })),
    approval: { state: "drafting" },
  };
}

function createApprovedLegacyPlanSpec(
  approvedAt: string,
  approvedBySessionId?: string,
): PlanSpec {
  return {
    sections: PLAN_SPEC_SECTION_DEFS.map((def) => ({
      id: def.id,
      required: def.required,
      status: "locked" as const,
      notApplicable: { reason: "legacy run (created before planSpec)" },
    })),
    approval: {
      state: "approved",
      approvedAt,
      ...(approvedBySessionId ? { approvedBySessionId } : {}),
    },
  };
}

/**
 * Seed / repair the deterministic planning state machine and the PlanSpec
 * coverage index. Idempotent — preserves existing well-formed values. A legacy
 * run that was already approved (planApprovedAt set) gets an approved PlanSpec
 * so the readiness gate never retroactively blocks it.
 */
function ensurePlanningAndSpec(manifest: OrchestrationManifest): void {
  const lead = (manifest.leadState ?? ((manifest as { leadState: OrchestrationManifest["leadState"] }).leadState = {})) as OrchestrationManifest["leadState"];
  const planning = lead.planning;
  if (!planning || !isPlanningStage(planning.stage) || !Array.isArray(planning.rounds)) {
    lead.planning = {
      stage: isPlanningStage(planning?.stage) ? (planning!.stage as PlanningStage) : "intake",
      rounds: Array.isArray(planning?.rounds) ? planning!.rounds : [],
      ...(planning?.intake ? { intake: planning.intake } : {}),
      ...(planning?.overrides ? { overrides: planning.overrides } : {}),
    };
  }
  const spec = manifest.planSpec;
  if (!spec || !Array.isArray(spec.sections) || !spec.approval || typeof spec.approval !== "object") {
    manifest.planSpec = lead.planApprovedAt
      ? createApprovedLegacyPlanSpec(lead.planApprovedAt, lead.planApprovedBySessionId)
      : createInitialPlanSpec();
  }
}

export function isTaskStatus(value: unknown): value is OrchestrationTaskStatus {
  return typeof value === "string" && ORCHESTRATION_TASK_STATUSES.has(value);
}

// ---------------------------------------------------------------------------
// Delegation lineage seed / repair
// ---------------------------------------------------------------------------

export const DELEGATION_STATUSES = new Set<string>([
  "running",
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

export function isDelegationStatus(value: unknown): value is DelegationStatus {
  return typeof value === "string" && DELEGATION_STATUSES.has(value);
}

/**
 * Default `lineage` to `[]` and drop malformed edges (tolerant of hand-edited
 * manifests), mirroring how decisions/userOverrides are normalized. Runs on
 * every load + write, so an in-memory runtime manifest always has a lineage
 * array — which is what keeps `/lineage/-` patches from hitting a missing-key
 * error in applyPatches.
 */
function ensureLineage(manifest: OrchestrationManifest): void {
  const raw = (manifest as { lineage?: unknown }).lineage;
  if (!Array.isArray(raw)) {
    manifest.lineage = [];
    return;
  }
  const seen = new Set<string>();
  manifest.lineage = raw.filter((entry): entry is DelegationEdge => {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) return false;
    if (typeof record.parentSessionId !== "string" || !record.parentSessionId.trim()) return false;
    if (typeof record.childSessionId !== "string" || !record.childSessionId.trim()) return false;
    if (typeof record.childRole !== "string" || !record.childRole.trim()) return false;
    if (typeof record.spawnedAt !== "string" || !record.spawnedAt.trim()) return false;
    if (typeof record.spawnEtag !== "string" || !record.spawnEtag.trim()) return false;
    if (typeof record.briefDigest !== "string" || !record.briefDigest.trim()) return false;
    if (!isDelegationStatus(record.status)) return false;
    seen.add(id);
    return true;
  });
}

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function ensureReceipts(manifest: OrchestrationManifest): void {
  const raw = (manifest as { receipts?: unknown }).receipts;
  if (!Array.isArray(raw)) {
    manifest.receipts = [];
    return;
  }
  const seen = new Set<string>();
  const valid = raw.filter((entry): entry is NonNullable<OrchestrationManifest["receipts"]>[number] => {
    if (!isNonArrayObject(entry)) return false;
    const requestId = typeof entry.requestId === "string" ? entry.requestId.trim() : "";
    if (!requestId || seen.has(requestId)) return false;
    if (typeof entry.kind !== "string" || !RECEIPT_KINDS.has(entry.kind)) return false;
    if (typeof entry.createdAt !== "string" || !entry.createdAt.trim()) return false;
    if (typeof entry.status !== "string" || !RECEIPT_STATUSES.has(entry.status)) return false;
    if (entry.result !== undefined && !isNonArrayObject(entry.result)) return false;
    seen.add(requestId);
    return true;
  });
  const completed = valid
    .filter((entry) => entry.status === "completed")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const prune = new Set(
    completed.slice(0, Math.max(0, completed.length - RECEIPT_CAP)).map((entry) => entry.requestId),
  );
  manifest.receipts = valid.filter((entry) => !prune.has(entry.requestId));
}

function ensureOutbox(manifest: OrchestrationManifest): void {
  const raw = (manifest as { outbox?: unknown }).outbox;
  if (!Array.isArray(raw)) {
    manifest.outbox = [];
    return;
  }
  const seen = new Set<string>();
  const valid = raw.filter((entry): entry is NonNullable<OrchestrationManifest["outbox"]>[number] => {
    if (!isNonArrayObject(entry)) return false;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || seen.has(id)) return false;
    if (typeof entry.kind !== "string" || !OUTBOX_KINDS.has(entry.kind)) return false;
    if (typeof entry.targetSessionId !== "string" || !entry.targetSessionId.trim()) return false;
    if (!isNonArrayObject(entry.delivery)) return false;
    if (typeof entry.delivery.op !== "string" || !OUTBOX_DELIVERY_OPS.has(entry.delivery.op)) return false;
    if (!validOptionalString(entry.delivery.text)) return false;
    if (entry.delivery.metadata !== undefined && !isNonArrayObject(entry.delivery.metadata)) return false;
    if (typeof entry.status !== "string" || !OUTBOX_STATUSES.has(entry.status)) return false;
    if (!Number.isInteger(entry.attempts) || (entry.attempts as number) < 0) return false;
    if (!Number.isInteger(entry.maxAttempts) || (entry.maxAttempts as number) < 1) return false;
    if (typeof entry.createdAt !== "string" || !entry.createdAt.trim()) return false;
    if (typeof entry.updatedAt !== "string" || !entry.updatedAt.trim()) return false;
    if (!validOptionalString(entry.nextAttemptAt)) return false;
    if (!validOptionalString(entry.lastError)) return false;
    if (!validOptionalString(entry.deliveredAt)) return false;
    if (!validOptionalString(entry.requestId)) return false;
    seen.add(id);
    return true;
  });
  const terminal = valid
    .filter((entry) => entry.status === "delivered" || entry.status === "failed")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const prune = new Set(
    terminal.slice(0, Math.max(0, terminal.length - OUTBOX_TERMINAL_CAP)).map((entry) => entry.id),
  );
  manifest.outbox = valid.filter((entry) => !prune.has(entry.id));
}

// ---------------------------------------------------------------------------
// Full manifest shape normalization
// ---------------------------------------------------------------------------

export function normalizeManifestShape(manifest: OrchestrationManifest): OrchestrationManifest {
  const next = structuredClone(manifest) as OrchestrationManifest;
  next.decisions = normalizeDecisionEntries(next.decisions, next);
  next.userOverrides = normalizeUserOverrideEntries(next.userOverrides, next);
  next.tasks = (next.tasks ?? []).map((task) => normalizeTask(task));
  normalizeValidationRerunSupersedes(next.tasks);
  normalizeChecklist(next);
  ensurePlanningAndSpec(next);
  ensureLineage(next);
  ensureReceipts(next);
  ensureOutbox(next);
  reconcileActivePhaseProgress(next);
  return next;
}

// ---------------------------------------------------------------------------
// Task normalization
// ---------------------------------------------------------------------------

function normalizeTask(
  task: OrchestrationManifest["tasks"][number],
): OrchestrationManifest["tasks"][number] {
  const record = task as unknown as Record<string, unknown>;
  if (!isPhaseId(record.phaseId) && isPhaseId(record.phase)) {
    record.phaseId = record.phase;
    delete record.phase;
  }
  if (typeof record.description !== "string") {
    record.description = typeof record.title === "string" ? record.title : "";
  }
  if (!Array.isArray(record.filesHint)) {
    delete record.filesHint;
  }
  if (!record.validationGate || typeof record.validationGate !== "object") {
    record.validationGate = { required: true, stepIds: [] };
  } else {
    const gate = record.validationGate as Record<string, unknown>;
    gate.required = gate.required !== false;
    if (!Array.isArray(gate.stepIds)) gate.stepIds = [];
  }
  return record as unknown as OrchestrationManifest["tasks"][number];
}

// ---------------------------------------------------------------------------
// Validation checklist normalization
// ---------------------------------------------------------------------------

function normalizeChecklist(manifest: OrchestrationManifest): void {
  const checklist = manifest.validationStrategy?.checklist;
  if (!Array.isArray(checklist)) return;
  manifest.validationStrategy.checklist = checklist.map((item) => {
    const record = item as unknown as Record<string, unknown>;
    const runs = Array.isArray(record.runs) ? record.runs : [];
    const normalizedRuns = runs
      .map((run, index) => normalizeValidationChecklistRun(run, index, manifest))
      .filter((run): run is ValidationChecklistRun => run !== null);
    record.runs = normalizedRuns;
    if (
      typeof record.latestRunId !== "string" ||
      !normalizedRuns.some((run) => run.id === record.latestRunId)
    ) {
      record.latestRunId = normalizedRuns[normalizedRuns.length - 1]?.id ?? "";
    }
    return record as unknown as OrchestrationManifest["validationStrategy"]["checklist"][number];
  });
}

function normalizeValidationChecklistRun(
  value: unknown,
  index: number,
  manifest: OrchestrationManifest,
): ValidationChecklistRun | null {
  if (typeof value === "string") {
    const note = value.trim();
    if (!note) return null;
    const timestamp = extractIsoTimestamp(note) ?? manifest.updatedAt ?? manifest.createdAt ?? new Date().toISOString();
    const status = inferRunStatusFromNote(note);
    return {
      id: `legacy-${index + 1}`,
      runBySessionId: inferValidationRunSessionId(note, manifest) ?? "",
      status,
      notes: note,
      startedAt: timestamp,
      ...(status !== "running" ? { endedAt: timestamp } : {}),
    };
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const status = isValidationChecklistRunStatus(record.status) ? record.status : "running";
  const startedAt =
    typeof record.startedAt === "string" && record.startedAt.trim()
      ? record.startedAt
      : manifest.updatedAt ?? manifest.createdAt ?? new Date().toISOString();
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id : `legacy-${index + 1}`,
    runBySessionId:
      typeof record.runBySessionId === "string"
        ? record.runBySessionId
        : inferValidationRunSessionId(String(record.notes ?? ""), manifest) ?? "",
    status,
    startedAt,
    ...(typeof record.endedAt === "string" && record.endedAt.trim()
      ? { endedAt: record.endedAt }
      : status !== "running" ? { endedAt: startedAt } : {}),
    ...(typeof record.notes === "string" ? { notes: record.notes } : {}),
    ...(Array.isArray(record.attachedEvidence) ? { attachedEvidence: record.attachedEvidence as ValidationChecklistRun["attachedEvidence"] } : {}),
    ...(Array.isArray(record.findings) ? { findings: record.findings as ValidationChecklistRun["findings"] } : {}),
    ...(typeof record.supersedes === "string" && record.supersedes.trim() ? { supersedes: record.supersedes } : {}),
  };
}

function inferRunStatusFromNote(note: string): ValidationChecklistRun["status"] {
  if (/\bpass(?:ed)?\b/i.test(note)) return "passed";
  if (/\bfail(?:ed)?\b/i.test(note)) return "failed";
  return "running";
}

function isValidationChecklistRunStatus(value: unknown): value is ValidationChecklistRun["status"] {
  return value === "running" || value === "passed" || value === "failed";
}

function extractIsoTimestamp(text: string): string | null {
  const match = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/.exec(text);
  return match?.[0] ?? null;
}

function inferValidationRunSessionId(
  note: string,
  manifest: OrchestrationManifest,
): string | null {
  const lower = note.toLowerCase();
  const validator = manifest.agents.find(
    (agent) =>
      agent.role === "validator" &&
      ((agent.tag && lower.includes(agent.tag.toLowerCase())) ||
        lower.includes(agent.sessionId.toLowerCase())),
  );
  return validator?.sessionId ?? manifest.agents.find((agent) => agent.role === "validator")?.sessionId ?? null;
}

// ---------------------------------------------------------------------------
// Shared string helpers for normalization
// ---------------------------------------------------------------------------

function nonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractFirstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const trimmed = nonEmptyTrimmedString(record[key]);
    if (trimmed) return trimmed;
  }
  return "";
}

function isDecisionSource(value: unknown): value is "user" | "worker" | "validator" | "lead" {
  return value === "user" || value === "worker" || value === "validator" || value === "lead";
}

function isOverrideScope(value: unknown): value is "phase" | "task" | "step" | "session" {
  return value === "phase" || value === "task" || value === "step" || value === "session";
}

// ---------------------------------------------------------------------------
// Decision / override normalization (tolerant of legacy string entries)
// ---------------------------------------------------------------------------

function normalizeDecisionEntries(
  entries: OrchestrationManifest["decisions"] | unknown,
  manifest: OrchestrationManifest,
): OrchestrationManifest["decisions"] {
  if (!Array.isArray(entries)) return [];
  const fallbackAt = manifest.updatedAt || manifest.createdAt || new Date().toISOString();
  return entries
    .map((entry, index) => normalizeSingleDecision(entry, index, fallbackAt))
    .filter((entry): entry is OrchestrationManifest["decisions"][number] => entry !== null);
}

function normalizeSingleDecision(
  entry: unknown,
  index: number,
  fallbackAt: string,
): OrchestrationManifest["decisions"][number] | null {
  if (typeof entry === "string") {
    const summary = entry.trim();
    if (!summary) return null;
    return { id: `D-legacy-${index + 1}`, at: fallbackAt, source: "lead" as const, summary };
  }
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const summary = extractFirstString(record, ["summary", "answer"]);
  if (!summary) return null;
  const source = isDecisionSource(record.source) ? record.source : "lead";
  return {
    ...record,
    id: nonEmptyTrimmedString(record.id) ?? `D-legacy-${index + 1}`,
    at: nonEmptyTrimmedString(record.at) ?? fallbackAt,
    source,
    summary,
  } as OrchestrationManifest["decisions"][number];
}

function normalizeUserOverrideEntries(
  entries: OrchestrationManifest["userOverrides"] | unknown,
  manifest: OrchestrationManifest,
): OrchestrationManifest["userOverrides"] {
  if (!Array.isArray(entries)) return [];
  const fallbackAt = manifest.updatedAt || manifest.createdAt || new Date().toISOString();
  return entries
    .map((entry, index) => normalizeSingleUserOverride(entry, index, fallbackAt))
    .filter((entry): entry is OrchestrationManifest["userOverrides"][number] => entry !== null);
}

function normalizeSingleUserOverride(
  entry: unknown,
  index: number,
  fallbackAt: string,
): OrchestrationManifest["userOverrides"][number] | null {
  if (typeof entry === "string") {
    const instruction = entry.trim();
    if (!instruction) return null;
    return { id: `O-legacy-${index + 1}`, at: fallbackAt, scope: "session" as const, instruction };
  }
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const instruction = extractFirstString(record, ["instruction", "summary", "answer"]);
  if (!instruction) return null;
  const scope = isOverrideScope(record.scope) ? record.scope : "session";
  const appliedToId = nonEmptyTrimmedString(record.appliedToId);
  const affectedDefault = nonEmptyTrimmedString(record.affectedDefault);
  return {
    ...record,
    id: nonEmptyTrimmedString(record.id) ?? `O-legacy-${index + 1}`,
    at: nonEmptyTrimmedString(record.at) ?? fallbackAt,
    scope,
    instruction,
    ...(appliedToId ? { appliedToId } : {}),
    ...(affectedDefault ? { affectedDefault } : {}),
  } as OrchestrationManifest["userOverrides"][number];
}

// ---------------------------------------------------------------------------
// Manifest shape validation
// ---------------------------------------------------------------------------

export function validateManifestShape(manifest: OrchestrationManifest): string | null {
  if (!isPhaseId(manifest.currentPhase)) {
    return `manifest.currentPhase must be one of ${[...ORCHESTRATION_PHASE_IDS].join(", ")}`;
  }
  const agentError = validateAgents(manifest.agents);
  if (agentError) return agentError;
  const taskError = validateTasks(manifest.tasks);
  if (taskError) return taskError;
  const vsError = validateValidationStrategy(manifest.validationStrategy);
  if (vsError) return vsError;
  const planningError = validatePlanningState(manifest.leadState?.planning);
  if (planningError) return planningError;
  const lineageError = validateLineage(manifest.lineage);
  if (lineageError) return lineageError;
  const receiptsError = validateReceipts(manifest.receipts);
  if (receiptsError) return receiptsError;
  const outboxError = validateOutbox(manifest.outbox);
  if (outboxError) return outboxError;
  return null;
}

function validateReceipts(receipts: OrchestrationManifest["receipts"]): string | null {
  if (receipts === undefined) return null;
  if (!Array.isArray(receipts)) return "manifest.receipts must be an array";
  const seen = new Set<string>();
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object") return "manifest.receipts entries must be objects";
    if (typeof receipt.requestId !== "string" || !receipt.requestId.trim()) {
      return "manifest.receipts entries must include a non-empty requestId";
    }
    if (seen.has(receipt.requestId)) {
      return `manifest.receipts contains duplicate requestId ${receipt.requestId}`;
    }
    seen.add(receipt.requestId);
    if (!RECEIPT_KINDS.has(receipt.kind)) {
      return `manifest receipt ${receipt.requestId} has invalid kind`;
    }
    if (typeof receipt.createdAt !== "string" || !receipt.createdAt.trim()) {
      return `manifest receipt ${receipt.requestId} must include createdAt`;
    }
    if (!RECEIPT_STATUSES.has(receipt.status)) {
      return `manifest receipt ${receipt.requestId} has invalid status`;
    }
    if (receipt.result !== undefined && !isNonArrayObject(receipt.result)) {
      return `manifest receipt ${receipt.requestId} result must be an object`;
    }
  }
  return null;
}

function validateOutbox(outbox: OrchestrationManifest["outbox"]): string | null {
  if (outbox === undefined) return null;
  if (!Array.isArray(outbox)) return "manifest.outbox must be an array";
  const seen = new Set<string>();
  for (const entry of outbox) {
    if (!entry || typeof entry !== "object") return "manifest.outbox entries must be objects";
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      return "manifest.outbox entries must include a non-empty id";
    }
    if (seen.has(entry.id)) return `manifest.outbox contains duplicate id ${entry.id}`;
    seen.add(entry.id);
    if (!OUTBOX_KINDS.has(entry.kind)) return `manifest outbox entry ${entry.id} has invalid kind`;
    if (typeof entry.targetSessionId !== "string" || !entry.targetSessionId.trim()) {
      return `manifest outbox entry ${entry.id} must include targetSessionId`;
    }
    if (!entry.delivery || typeof entry.delivery !== "object") {
      return `manifest outbox entry ${entry.id} must include delivery`;
    }
    if (!OUTBOX_DELIVERY_OPS.has(entry.delivery.op)) {
      return `manifest outbox entry ${entry.id} has invalid delivery op`;
    }
    if (!validOptionalString(entry.delivery.text)) {
      return `manifest outbox entry ${entry.id} delivery.text must be a string`;
    }
    if (entry.delivery.metadata !== undefined && !isNonArrayObject(entry.delivery.metadata)) {
      return `manifest outbox entry ${entry.id} delivery.metadata must be an object`;
    }
    if (!OUTBOX_STATUSES.has(entry.status)) {
      return `manifest outbox entry ${entry.id} has invalid status`;
    }
    if (!Number.isInteger(entry.attempts) || entry.attempts < 0) {
      return `manifest outbox entry ${entry.id} attempts must be a non-negative integer`;
    }
    if (!Number.isInteger(entry.maxAttempts) || entry.maxAttempts < 1) {
      return `manifest outbox entry ${entry.id} maxAttempts must be a positive integer`;
    }
    if (typeof entry.createdAt !== "string" || !entry.createdAt.trim()) {
      return `manifest outbox entry ${entry.id} must include createdAt`;
    }
    if (typeof entry.updatedAt !== "string" || !entry.updatedAt.trim()) {
      return `manifest outbox entry ${entry.id} must include updatedAt`;
    }
    for (const [field, value] of [
      ["nextAttemptAt", entry.nextAttemptAt],
      ["lastError", entry.lastError],
      ["deliveredAt", entry.deliveredAt],
      ["requestId", entry.requestId],
    ] as const) {
      if (!validOptionalString(value)) {
        return `manifest outbox entry ${entry.id} ${field} must be a string`;
      }
    }
  }
  return null;
}

function validateLineage(lineage: OrchestrationManifest["lineage"]): string | null {
  if (lineage === undefined) return null;
  if (!Array.isArray(lineage)) return "manifest.lineage must be an array";
  const seen = new Set<string>();
  for (const edge of lineage) {
    if (!edge || typeof edge !== "object") return "manifest.lineage entries must be objects";
    if (typeof edge.id !== "string" || !edge.id.trim()) {
      return "manifest.lineage entries must include a non-empty id";
    }
    if (seen.has(edge.id)) return `manifest.lineage contains duplicate id ${edge.id}`;
    seen.add(edge.id);
    if (typeof edge.parentSessionId !== "string" || !edge.parentSessionId.trim()) {
      return `manifest.lineage edge ${edge.id} must include parentSessionId`;
    }
    if (typeof edge.childSessionId !== "string" || !edge.childSessionId.trim()) {
      return `manifest.lineage edge ${edge.id} must include childSessionId`;
    }
    if (typeof edge.childRole !== "string" || !edge.childRole.trim()) {
      return `manifest.lineage edge ${edge.id} must include childRole`;
    }
    if (typeof edge.spawnedAt !== "string" || !edge.spawnedAt.trim()) {
      return `manifest.lineage edge ${edge.id} must include spawnedAt`;
    }
    if (typeof edge.spawnEtag !== "string" || !edge.spawnEtag.trim()) {
      return `manifest.lineage edge ${edge.id} must include spawnEtag`;
    }
    if (typeof edge.briefDigest !== "string" || !edge.briefDigest.trim()) {
      return `manifest.lineage edge ${edge.id} must include briefDigest`;
    }
    if (!isDelegationStatus(edge.status)) {
      return `manifest.lineage edge ${edge.id} has invalid status`;
    }
  }
  return null;
}

function validatePlanningState(
  planning: OrchestrationManifest["leadState"]["planning"],
): string | null {
  if (planning === undefined) return null;
  if (!planning || typeof planning !== "object") {
    return "manifest.leadState.planning must be an object";
  }
  if (!isPlanningStage(planning.stage)) {
    return `manifest.leadState.planning.stage must be one of ${[...PLANNING_STAGES].join(", ")}`;
  }
  if (!Array.isArray(planning.rounds)) {
    return "manifest.leadState.planning.rounds must be an array";
  }
  const seen = new Set<string>();
  for (const round of planning.rounds) {
    if (!round || typeof round !== "object") return "planning round entries must be objects";
    if (typeof round.id !== "string" || !round.id.trim()) return "planning round entries must include a non-empty id";
    if (seen.has(round.id)) return `planning rounds contain duplicate id ${round.id}`;
    seen.add(round.id);
    if (round.kind !== "functional" && round.kind !== "ui" && round.kind !== "extras") {
      return `planning round ${round.id} has invalid kind`;
    }
    if (typeof round.question !== "string" || !round.question.trim()) {
      return `planning round ${round.id} must include a non-empty question`;
    }
    if (typeof round.lockedSummary !== "string" || !round.lockedSummary.trim()) {
      return `planning round ${round.id} must include a non-empty lockedSummary`;
    }
  }
  return null;
}

function validateAgents(agents: OrchestrationManifest["agents"]): string | null {
  if (!Array.isArray(agents) || agents.length === 0) {
    return "manifest.agents must include at least one agent";
  }
  const seenSessionIds = new Set<string>();
  for (const agent of agents) {
    if (!agent || typeof agent !== "object") return "manifest.agents entries must be objects";
    if (typeof agent.sessionId !== "string" || !agent.sessionId.trim()) {
      return "manifest.agents entries must include a non-empty sessionId";
    }
    const sessionId = agent.sessionId.trim();
    if (seenSessionIds.has(sessionId)) {
      return `manifest.agents contains duplicate sessionId ${sessionId}`;
    }
    seenSessionIds.add(sessionId);
  }
  return null;
}

function validateTasks(tasks: OrchestrationManifest["tasks"]): string | null {
  const seenIds = new Set<string>();
  for (const task of tasks ?? []) {
    if (!task || typeof task !== "object") return "manifest.tasks entries must be objects";
    if (typeof task.id !== "string" || !task.id.trim()) {
      return "manifest.tasks entries must include a non-empty id";
    }
    const taskId = task.id.trim();
    if (seenIds.has(taskId)) {
      return `manifest.tasks contains duplicate id ${taskId}`;
    }
    seenIds.add(taskId);
    if (!isPhaseId((task as { phaseId?: unknown }).phaseId)) {
      return `manifest task ${taskId} must include phaseId; use phaseId, not phase`;
    }
    if (typeof task.title !== "string" || !task.title.trim()) {
      return `manifest task ${taskId} must include a non-empty title`;
    }
    if (typeof task.description !== "string") {
      return `manifest task ${taskId} must include description`;
    }
    if (!isTaskStatus(task.status)) {
      return `manifest task ${taskId} has invalid status`;
    }
    if (!task.validationGate || typeof task.validationGate !== "object") {
      return `manifest task ${taskId} must include validationGate`;
    }
    if (typeof task.validationGate.required !== "boolean") {
      return `manifest task ${taskId} validationGate.required must be boolean`;
    }
    if (!Array.isArray(task.validationGate.stepIds)) {
      return `manifest task ${taskId} validationGate.stepIds must be an array`;
    }
  }
  return null;
}

function validateValidationStrategy(vs: OrchestrationManifest["validationStrategy"]): string | null {
  if (!vs || typeof vs !== "object") {
    return "manifest.validationStrategy must be an object";
  }
  if (!Array.isArray(vs.steps)) {
    return "manifest.validationStrategy.steps must be an array";
  }
  if (!Array.isArray(vs.checklist)) {
    return "manifest.validationStrategy.checklist must be an array";
  }
  for (const item of vs.checklist) {
    if (!item || typeof item !== "object") return "validation checklist entries must be objects";
    if (typeof item.id !== "string" || !item.id.trim()) {
      return "validation checklist entries must include a non-empty id";
    }
    if (typeof item.stepId !== "string" || !item.stepId.trim()) {
      return `validation checklist item ${item.id} must include stepId`;
    }
    if (!Array.isArray(item.runs)) {
      return `validation checklist item ${item.id} runs must be an array`;
    }
    for (const run of item.runs) {
      const runError = validateValidationChecklistRun(run);
      if (runError) return `validation checklist item ${item.id} ${runError}`;
    }
    if (
      item.latestRunId &&
      !item.runs.some((run) => run.id === item.latestRunId)
    ) {
      return `validation checklist item ${item.id} latestRunId must reference an existing run`;
    }
  }
  return null;
}

function validateValidationChecklistRun(run: unknown): string | null {
  if (!run || typeof run !== "object") return "runs must contain objects";
  const record = run as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) return "run.id must be non-empty";
  if (typeof record.runBySessionId !== "string") return "run.runBySessionId must be a string";
  if (!isValidationChecklistRunStatus(record.status)) {
    return "run.status must be running, passed, or failed";
  }
  if (typeof record.startedAt !== "string" || !record.startedAt.trim()) {
    return "run.startedAt must be non-empty";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase lifecycle reconciliation
// ---------------------------------------------------------------------------

const ORCHESTRATION_PHASE_ORDER = ["planning", "developing", "validating", "wrapup"] as const;

export function reconcileActivePhaseProgress(manifest: OrchestrationManifest): void {
  const phase = manifest.phases.find((entry) => entry.id === manifest.currentPhase);
  if (!phase || phase.status !== "active") return;
  // Planning never auto-advances during normalize: the only legitimate
  // planning→developing transition goes through setPlanApprovalState (which
  // stamps currentPhase=developing + planApprovedAt together). Guarding here
  // prevents a done planning-phase task from bypassing plan approval.
  if (phase.id === "planning") return;
  const supersededTaskIds = collectSupersededTaskIds(manifest.tasks);
  const activePhaseTasks = manifest.tasks.filter(
    (task) => task.phaseId === phase.id && !supersededTaskIds.has(task.id),
  );
  const allDone = activePhaseTasks.length > 0
    ? activePhaseTasks.every((task) => task.status === "done")
    : phase.id === "wrapup";
  if (!allDone) return;

  const timestamp = manifest.updatedAt || manifest.createdAt || new Date().toISOString();
  phase.status = "done";
  phase.completedAt ??= timestamp;
  const nextPhase = nextPendingPhase(manifest, phase.id);
  if (!nextPhase) return;
  manifest.currentPhase = nextPhase.id;
  nextPhase.status = "active";
  nextPhase.startedAt ??= timestamp;
  if (nextPhase.id === "wrapup") {
    const wrapupTasks = manifest.tasks.filter(
      (task) => task.phaseId === "wrapup" && !supersededTaskIds.has(task.id),
    );
    if (!wrapupTasks.length || wrapupTasks.every((task) => task.status === "done")) {
      nextPhase.status = "done";
      nextPhase.completedAt ??= timestamp;
    }
  }
}

export function buildPhaseTransitionOpsAfterTaskRelease(
  manifest: OrchestrationManifest,
  releasedTaskId: string,
  releasedStatus: OrchestrationTaskStatus,
  timestamp: string,
): ManifestPatchOp[] {
  if (releasedStatus !== "done") return [];
  const releasedTask = manifest.tasks.find((task) => task.id === releasedTaskId);
  if (!releasedTask) return [];
  const phase = manifest.phases.find((entry) => entry.id === releasedTask.phaseId);
  if (!phase || (manifest.currentPhase !== phase.id && phase.status !== "active")) {
    return [];
  }
  // Planning never auto-advances: the only legitimate planning→developing
  // transition goes through setPlanApprovalState (which stamps
  // currentPhase=developing + planApprovedAt together). Guarding here prevents
  // a done planning-phase task from bypassing plan approval.
  if (phase.id === "planning") return [];

  const tasksAfterRelease = manifest.tasks.map((task) =>
    task.id === releasedTaskId
      ? { ...task, status: releasedStatus }
      : task,
  );
  const supersededTaskIds = collectSupersededTaskIds(tasksAfterRelease);
  const activePhaseTasks = tasksAfterRelease.filter(
    (task) => task.phaseId === phase.id && !supersededTaskIds.has(task.id),
  );
  if (!activePhaseTasks.length || activePhaseTasks.some((task) => task.status !== "done")) {
    return [];
  }

  const ops: ManifestPatchOp[] = [];
  if (phase.status !== "done") {
    ops.push(
      { op: "replace", path: `/phases/{id:${phase.id}}/status`, value: "done" },
      { op: "replace", path: `/phases/{id:${phase.id}}/completedAt`, value: timestamp },
    );
  }
  if (manifest.currentPhase !== phase.id) return ops;
  const nextPhaseObj = nextPendingPhase(manifest, phase.id);
  if (!nextPhaseObj) return ops;
  ops.push(
    { op: "replace", path: "/currentPhase", value: nextPhaseObj.id },
    { op: "replace", path: `/phases/{id:${nextPhaseObj.id}}/status`, value: "active" },
  );
  if (!nextPhaseObj.startedAt) {
    ops.push({ op: "replace", path: `/phases/{id:${nextPhaseObj.id}}/startedAt`, value: timestamp });
  }
  if (nextPhaseObj.id === "wrapup") {
    const wrapupTasks = tasksAfterRelease.filter(
      (task) => task.phaseId === "wrapup" && !supersededTaskIds.has(task.id),
    );
    if (!wrapupTasks.length || wrapupTasks.every((task) => task.status === "done")) {
      ops.push(
        { op: "replace", path: `/phases/{id:wrapup}/status`, value: "done" },
        { op: "replace", path: `/phases/{id:wrapup}/completedAt`, value: timestamp },
      );
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Supersede inference helpers
// ---------------------------------------------------------------------------

export function inferValidationRerunSupersedes(
  manifest: OrchestrationManifest,
  releasedTask: OrchestrationManifest["tasks"][number],
  releasedStatus: OrchestrationTaskStatus,
): string[] {
  if (
    releasedStatus !== "done" ||
    releasedTask.phaseId !== "validating" ||
    releasedTask.status === "failed" ||
    !releasedTask.tag
  ) {
    return [];
  }
  const releasedTaskIndex = manifest.tasks.findIndex((task) => task.id === releasedTask.id);
  const releasedGate = normalizedStepIds(releasedTask.validationGate.stepIds);
  if (releasedTaskIndex < 0 || !releasedGate.length) return [];
  const explicit = new Set(taskSupersedesIds(releasedTask));
  return manifest.tasks
    .slice(0, releasedTaskIndex)
    .filter((task) => {
      if (task.id === releasedTask.id || explicit.has(task.id)) return false;
      if (task.phaseId !== "validating" || task.status !== "failed") return false;
      if (task.tag !== releasedTask.tag) return false;
      return sameStringSet(normalizedStepIds(task.validationGate.stepIds), releasedGate);
    })
    .map((task) => task.id);
}

export function mergeSupersedes(existing: readonly string[], inferred: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const id of [...existing, ...inferred]) {
    const trimmed = id.trim();
    if (trimmed) ids.add(trimmed);
  }
  return [...ids];
}

export function taskSupersedesIds(task: OrchestrationManifest["tasks"][number]): string[] {
  const value = (task as unknown as { supersedes?: unknown }).supersedes;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  return typeof value === "string" && value.trim() ? [value] : [];
}

function normalizeValidationRerunSupersedes(
  tasks: OrchestrationManifest["tasks"],
): void {
  tasks.forEach((task, index) => {
    if (task.phaseId !== "validating" || task.status !== "done" || !task.tag) return;
    const gate = normalizedStepIds(task.validationGate.stepIds);
    if (!gate.length) return;
    const inferred = tasks
      .slice(0, index)
      .filter((priorTask) => {
        if (priorTask.phaseId !== "validating" || priorTask.status !== "failed") return false;
        if (priorTask.tag !== task.tag) return false;
        return sameStringSet(normalizedStepIds(priorTask.validationGate.stepIds), gate);
      })
      .map((priorTask) => priorTask.id);
    if (inferred.length) {
      task.supersedes = mergeSupersedes(taskSupersedesIds(task), inferred);
    }
  });
}

function collectSupersededTaskIds(
  tasks: readonly OrchestrationManifest["tasks"][number][],
): Set<string> {
  const ids = new Set<string>();
  tasks.forEach((task, index) => {
    for (const id of taskSupersedesIds(task)) ids.add(id);
    if (task.phaseId !== "validating" || task.status !== "done" || !task.tag) return;
    const gate = normalizedStepIds(task.validationGate.stepIds);
    if (!gate.length) return;
    for (const priorTask of tasks.slice(0, index)) {
      if (priorTask.phaseId !== "validating" || priorTask.status !== "failed") continue;
      if (priorTask.tag !== task.tag) continue;
      if (sameStringSet(normalizedStepIds(priorTask.validationGate.stepIds), gate)) {
        ids.add(priorTask.id);
      }
    }
  });
  return ids;
}

function nextPendingPhase(
  manifest: OrchestrationManifest,
  phaseId: OrchestrationManifest["currentPhase"],
): OrchestrationManifest["phases"][number] | null {
  const phaseOrderIndex = ORCHESTRATION_PHASE_ORDER.indexOf(phaseId);
  const orderedIds = phaseOrderIndex >= 0
    ? ORCHESTRATION_PHASE_ORDER.slice(phaseOrderIndex + 1)
    : ORCHESTRATION_PHASE_ORDER;
  for (const id of orderedIds) {
    const phase = manifest.phases.find((entry) => entry.id === id);
    if (phase?.status === "pending") return phase;
  }
  return null;
}

function normalizedStepIds(value: readonly string[] | undefined): string[] {
  return [...new Set((value ?? []).filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim()))].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry === right[index]);
}
