import type {
  ManifestPatchOp,
  OrchestrationManifest,
  OrchestrationRole,
} from "../../../shared/types/orchestration";

/**
 * Patch-path policy for orchestration manifest patches.
 *
 * Paths use either RFC-6902 JSON-pointer style for top-level scalars
 * (e.g. `/currentPhase`) OR an id-predicate addressing form for array elements:
 *
 *   `/tasks/{id:T-003}/status`     -> tasks element whose .id === "T-003"
 *   `/agents/{sessionId:S-1}/...`  -> agents element whose .sessionId === "S-1"
 *
 * Numeric indices are deliberately rejected — arrays are addressed by id only.
 */
export type PatchPathSegment =
  | { kind: "literal"; key: string }
  | { kind: "predicate"; field: string; value: string }
  | { kind: "append" }; // "-" at end of array path

export type ParsedPatchPath = {
  segments: PatchPathSegment[];
  raw: string;
};

const PREDICATE_RE = /^\{([a-zA-Z][a-zA-Z0-9]*):([^}]+)\}$/;

export function parsePatchPath(path: string): ParsedPatchPath {
  if (!path.startsWith("/")) {
    throw new Error(`patch path must be absolute, got "${path}"`);
  }
  const raw = path;
  const parts = path
    .slice(1)
    .split("/")
    .filter((segment) => segment.length > 0);
  const segments: PatchPathSegment[] = parts.map((part) => {
    if (part === "-") return { kind: "append" };
    const match = PREDICATE_RE.exec(part);
    if (match) {
      return { kind: "predicate", field: match[1]!, value: match[2]! };
    }
    if (/^\d+$/.test(part)) {
      throw new Error(
        `numeric array indices are not allowed in patch paths (got "${part}" in "${path}"); use {id:VALUE} predicates instead`,
      );
    }
    return { kind: "literal", key: part };
  });
  return { segments, raw };
}

export type PatchActorRole = OrchestrationRole;

/**
 * Returns true if the path matches the supplied pattern. Patterns use the same
 * grammar but may include a wildcard `*` in place of any literal/predicate
 * segment and `**` at the trailing position to match zero or more segments.
 */
export function pathMatchesPattern(
  parsed: ParsedPatchPath,
  pattern: string,
): boolean {
  const parts = pattern
    .slice(1)
    .split("/")
    .filter((segment) => segment.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const want = parts[i]!;
    if (want === "**") return true;
    const got = parsed.segments[i];
    if (!got) return false;
    if (want === "*") continue;
    if (got.kind === "predicate") {
      const m = PREDICATE_RE.exec(want);
      if (m && m[1] === got.field && (m[2] === "*" || m[2] === got.value)) continue;
      if (want === got.field || want === `{${got.field}}`) continue;
      return false;
    }
    if (got.kind === "append") {
      if (want === "-") continue;
      return false;
    }
    if (got.kind === "literal") {
      if (want === got.key) continue;
      return false;
    }
  }
  return parsed.segments.length === parts.length;
}

/**
 * Policy decision context. `actorSessionId` is the session that emitted the
 * patch (for workers/validators) — used to enforce "you may only patch your
 * own row" rules.
 */
export type PatchPolicyContext = {
  actorRole: PatchActorRole;
  actorSessionId?: string;
  manifest: OrchestrationManifest;
};

export type PatchPolicyResult =
  | { allowed: true }
  | { allowed: false; reason: string; path: string };

/** Lead can write anywhere EXCEPT a small set of immutable / system-owned paths. */
const LEAD_DENY_PATTERNS = [
  "/runId",
  "/version",
  "/etag",
  "/serverGeneration",
  "/createdAt",
  "/bundlePath",
  "/laneId",
  "/agents/*/sessionId",
  "/leadState",
  "/leadState/planApprovedAt",
  "/leadState/planApprovedBySessionId",
  "/leadState/planApprovalSummary",
  // Planning state machine + plan-approval index are gate-controlled state:
  // writable only through dedicated service methods (recordPlanningIntake,
  // recordPlanningRound, markPlanningReady, setPlanApprovalState), never raw
  // manifestPatch — so the deterministic sequence cannot be forged.
  "/leadState/planning",
  "/leadState/planning/**",
  "/planSpec",
  "/planSpec/**",
  "/phases/{id:planning}/status",
  "/phases/{id:planning}/completedAt",
  "/currentPhase",
];

/**
 * Worker allow-list. Workers may patch:
 *  - their own agent row's status/currentStepId/lastHeartbeatAt
 *  - tasks they have claimed: status, evidence, attempts
 *  - never validationGate or validationStrategy.checklist rows
 *
 * Validation proof is written through planAppend + recordValidationRun so the
 * service can enforce task/step applicability before mutating gate state.
 */
const WORKER_ALLOW_PATTERNS = [
  "/agents/{sessionId:SELF}/status",
  "/agents/{sessionId:SELF}/currentStepId",
  "/agents/{sessionId:SELF}/lastHeartbeatAt",
  "/agents/{sessionId:SELF}/usage",
  "/tasks/{id:*}/status",
  "/tasks/{id:*}/evidence",
  "/tasks/{id:*}/attempts",
  "/tasks/{id:*}/attempts/-",
  "/tasks/{id:*}/currentAttemptId",
];

const WORKER_DENY_PATTERNS = [
  "/tasks/{id:*}/validationGate",
  "/tasks/{id:*}/validationGate/**",
  "/validationStrategy/checklist",
  "/validationStrategy/checklist/**",
  "/validationStrategy/steps",
  "/validationStrategy/steps/**",
];

const VALIDATOR_ALLOW_PATTERNS = [
  "/agents/{sessionId:SELF}/status",
  "/agents/{sessionId:SELF}/currentStepId",
  "/agents/{sessionId:SELF}/lastHeartbeatAt",
  "/agents/{sessionId:SELF}/usage",
];

const VALIDATOR_DENY_PATTERNS = [
  "/tasks/{id:*}/status",
  "/tasks/{id:*}/validationGate",
  "/tasks/{id:*}/validationGate/**",
  "/validationStrategy/checklist",
  "/validationStrategy/checklist/**",
  "/validationStrategy/steps",
  "/validationStrategy/steps/**",
];

function matchesAny(parsed: ParsedPatchPath, patterns: readonly string[]): boolean {
  return patterns.some((p) => pathMatchesPattern(parsed, p));
}

function rewriteSelf(pattern: string, actorSessionId?: string): string {
  if (!actorSessionId) return pattern;
  return pattern.replace(":SELF}", `:${actorSessionId}}`);
}

function matchesAnyWithSelf(
  parsed: ParsedPatchPath,
  patterns: readonly string[],
  actorSessionId?: string,
): boolean {
  return patterns.some((p) =>
    pathMatchesPattern(parsed, rewriteSelf(p, actorSessionId)),
  );
}

/**
 * Decide whether a single patch op is allowed for the actor.
 */
export function checkPatchOp(
  op: ManifestPatchOp,
  ctx: PatchPolicyContext,
): PatchPolicyResult {
  let parsed: ParsedPatchPath;
  try {
    parsed = parsePatchPath(op.path);
  } catch (err) {
    return { allowed: false, reason: (err as Error).message, path: op.path };
  }

  if (ctx.actorRole === "lead") {
    if (matchesAny(parsed, LEAD_DENY_PATTERNS)) {
      return {
        allowed: false,
        reason: "lead may not patch system-owned / immutable field",
        path: op.path,
      };
    }
    return { allowed: true };
  }

  if (ctx.actorRole === "worker") {
    if (matchesAny(parsed, WORKER_DENY_PATTERNS)) {
      return {
        allowed: false,
        reason: "workers may not patch validation gates or checklist; use recordValidationRun",
        path: op.path,
      };
    }
    if (!matchesAnyWithSelf(parsed, WORKER_ALLOW_PATTERNS, ctx.actorSessionId)) {
      return {
        allowed: false,
        reason: "worker patch path not in allow-list",
        path: op.path,
      };
    }
    if (op.path.includes("/tasks/{id:")) {
      const taskId = extractTaskId(op.path);
      if (taskId) {
        const task = ctx.manifest.tasks.find((t) => t.id === taskId);
        if (task && task.assigneeSessionId !== ctx.actorSessionId) {
          return {
            allowed: false,
            reason: task.assigneeSessionId
              ? `worker ${ctx.actorSessionId} does not own task ${taskId}`
              : `worker ${ctx.actorSessionId} must claim task ${taskId} before patching it`,
            path: op.path,
          };
        }
      }
    }
    return { allowed: true };
  }

  if (ctx.actorRole === "validator") {
    if (matchesAny(parsed, VALIDATOR_DENY_PATTERNS)) {
      return {
        allowed: false,
        reason: "validators may not modify tasks, steps, or checklist directly; use recordValidationRun",
        path: op.path,
      };
    }
    if (!matchesAnyWithSelf(parsed, VALIDATOR_ALLOW_PATTERNS, ctx.actorSessionId)) {
      return {
        allowed: false,
        reason: "validator patch path not in allow-list",
        path: op.path,
      };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: "unknown actor role", path: op.path };
}

function extractTaskId(path: string): string | null {
  const m = /\/tasks\/\{id:([^}]+)\}/.exec(path);
  return m ? m[1]! : null;
}

/** Exported alias of extractTaskId for use by orchestrationService. */
export const extractTaskIdFromPath = extractTaskId;

/**
 * Inspect a patch transaction holistically — used by IPC handler to detect
 * coordinated patches (e.g. status="done" together with humanOverride +
 * UserOverrideEntry permits bypassing validation gates).
 */
export function patchTransactionTouches(
  ops: readonly ManifestPatchOp[],
  matcher: (op: ManifestPatchOp) => boolean,
): boolean {
  return ops.some(matcher);
}

export function isTaskStatusDonePatch(op: ManifestPatchOp): boolean {
  if (op.op === "remove") return false;
  if (!/^\/tasks\/\{id:[^}]+\}\/status$/.test(op.path)) return false;
  return op.value === "done";
}

export function isTaskHumanOverridePatch(op: ManifestPatchOp): boolean {
  if (op.op === "remove") return false;
  return /^\/tasks\/\{id:[^}]+\}\/humanOverride$/.test(op.path);
}

export function isUserOverrideEntryAppend(op: ManifestPatchOp): boolean {
  if (op.op === "remove") return false;
  if (op.path === "/userOverrides/-") return true;
  return /^\/userOverrides\/\{id:[^}]+\}$/.test(op.path);
}

export function taskValidationGatesSatisfied(
  manifest: OrchestrationManifest,
  taskId: string,
): boolean {
  const task = manifest.tasks.find((entry) => entry.id === taskId);
  if (!task || !task.validationGate.required) return true;
  return task.validationGate.stepIds.every((stepId) => {
    const step = manifest.validationStrategy.steps.find((entry) => entry.id === stepId);
    const items = manifest.validationStrategy.checklist.filter(
      (entry) =>
        entry.stepId === stepId &&
        (entry.taskId === taskId || (!entry.taskId && step?.scope !== "per_worker")),
    );
    if (!items.length) return false;
    return items.every((item) => {
      const latest = item.runs.find((run) => run.id === item.latestRunId);
      return latest?.status === "passed";
    });
  });
}

export function isValidationGateRequiredOff(op: ManifestPatchOp): boolean {
  if (op.op === "remove") return false;
  return (
    /^\/tasks\/\{id:[^}]+\}\/validationGate\/required$/.test(op.path) &&
    op.value === false
  );
}

export const PATCH_POLICY_TEST_HELPERS = {
  LEAD_DENY_PATTERNS,
  WORKER_ALLOW_PATTERNS,
  WORKER_DENY_PATTERNS,
  VALIDATOR_ALLOW_PATTERNS,
  VALIDATOR_DENY_PATTERNS,
};
