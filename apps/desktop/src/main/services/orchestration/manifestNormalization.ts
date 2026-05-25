import type {
  ManifestPatchOp,
  OrchestrationManifest,
  OrchestrationTaskStatus,
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

export function isPhaseId(value: unknown): value is OrchestrationManifest["currentPhase"] {
  return typeof value === "string" && ORCHESTRATION_PHASE_IDS.has(value);
}

export function isTaskStatus(value: unknown): value is OrchestrationTaskStatus {
  return typeof value === "string" && ORCHESTRATION_TASK_STATUSES.has(value);
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
    const status = /\bpass(?:ed)?\b/i.test(note)
      ? "passed"
      : /\bfail(?:ed)?\b/i.test(note)
        ? "failed"
        : "running";
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
    ...(typeof record.supersedes === "string" && record.supersedes.trim() ? { supersedes: record.supersedes } : {}),
  };
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
  const summary = typeof record.summary === "string"
    ? record.summary.trim()
    : typeof record.answer === "string"
      ? record.answer.trim()
      : "";
  if (!summary) return null;
  const source = record.source === "user"
    || record.source === "worker"
    || record.source === "validator"
    || record.source === "lead"
    ? record.source
    : "lead";
  return {
    ...record,
    id: typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : `D-legacy-${index + 1}`,
    at: typeof record.at === "string" && record.at.trim()
      ? record.at.trim()
      : fallbackAt,
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
  const instruction = typeof record.instruction === "string"
    ? record.instruction.trim()
    : typeof record.summary === "string"
      ? record.summary.trim()
      : typeof record.answer === "string"
        ? record.answer.trim()
        : "";
  if (!instruction) return null;
  const scope = record.scope === "phase"
    || record.scope === "task"
    || record.scope === "step"
    || record.scope === "session"
    ? record.scope
    : "session";
  return {
    ...record,
    id: typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : `O-legacy-${index + 1}`,
    at: typeof record.at === "string" && record.at.trim()
      ? record.at.trim()
      : fallbackAt,
    scope,
    instruction,
    ...(typeof record.appliedToId === "string" && record.appliedToId.trim()
      ? { appliedToId: record.appliedToId.trim() }
      : {}),
    ...(typeof record.affectedDefault === "string" && record.affectedDefault.trim()
      ? { affectedDefault: record.affectedDefault.trim() }
      : {}),
  } as OrchestrationManifest["userOverrides"][number];
}

// ---------------------------------------------------------------------------
// Manifest shape validation
// ---------------------------------------------------------------------------

export function validateManifestShape(manifest: OrchestrationManifest): string | null {
  if (!isPhaseId(manifest.currentPhase)) {
    return `manifest.currentPhase must be one of ${[...ORCHESTRATION_PHASE_IDS].join(", ")}`;
  }
  const taskError = validateTasks(manifest.tasks);
  if (taskError) return taskError;
  const vsError = validateValidationStrategy(manifest.validationStrategy);
  if (vsError) return vsError;
  return null;
}

function validateTasks(tasks: OrchestrationManifest["tasks"]): string | null {
  for (const task of tasks ?? []) {
    if (!task || typeof task !== "object") return "manifest.tasks entries must be objects";
    if (typeof task.id !== "string" || !task.id.trim()) {
      return "manifest.tasks entries must include a non-empty id";
    }
    if (!isPhaseId((task as { phaseId?: unknown }).phaseId)) {
      return `manifest task ${task.id} must include phaseId; use phaseId, not phase`;
    }
    if (typeof task.title !== "string" || !task.title.trim()) {
      return `manifest task ${task.id} must include a non-empty title`;
    }
    if (typeof task.description !== "string") {
      return `manifest task ${task.id} must include description`;
    }
    if (!isTaskStatus(task.status)) {
      return `manifest task ${task.id} has invalid status`;
    }
    if (!task.validationGate || typeof task.validationGate !== "object") {
      return `manifest task ${task.id} must include validationGate`;
    }
    if (typeof task.validationGate.required !== "boolean") {
      return `manifest task ${task.id} validationGate.required must be boolean`;
    }
    if (!Array.isArray(task.validationGate.stepIds)) {
      return `manifest task ${task.id} validationGate.stepIds must be an array`;
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

// ManifestPatchOp and OrchestrationTaskStatus imported at top of file

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
