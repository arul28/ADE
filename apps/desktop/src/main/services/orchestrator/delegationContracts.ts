import type {
  CoordinatorCapability,
  DelegationContract,
  DelegationContractStatus,
  DelegationIntent,
  DelegationLaunchState,
  DelegationMode,
  DelegationScope,
  OrchestratorRunGraph,
  OrchestratorStep,
} from "../../../shared/types";
import { asRecord, TERMINAL_STEP_STATUSES } from "./orchestratorContext";

type DelegationFailure = NonNullable<DelegationContract["failure"]>;
type DelegationFailureCategory = DelegationFailure["category"];
type DelegationRecoveryOption = DelegationFailure["recoveryOptions"][number];

const PLANNER_STARTUP_OBSERVATION_TOOL_NAMES = new Set([
  "get_mission",
  "get_run_graph",
  "get_step_output",
  "get_worker_states",
  "get_timeline",
  "stream_events",
]);

const COORDINATOR_TOOL_CAPABILITIES: Array<{
  capability: CoordinatorCapability;
  toolNames: string[];
}> = [
  { capability: "fetch_project_context", toolNames: ["get_project_context"] },
  { capability: "spawn_top_level_worker", toolNames: ["spawn_worker", "request_specialist"] },
  { capability: "spawn_nested_worker", toolNames: ["delegate_to_subagent"] },
  { capability: "spawn_parallel_workers", toolNames: ["delegate_parallel"] },
  { capability: "observe", toolNames: [...PLANNER_STARTUP_OBSERVATION_TOOL_NAMES, "get_worker_output", "list_workers", "read_mission_status", "read_mission_state", "read_step_output"] },
  { capability: "read_repo", toolNames: ["read_file", "search_files"] },
  { capability: "message_workers", toolNames: ["send_message", "message_worker", "broadcast"] },
  { capability: "run_control", toolNames: ["stop_worker", "skip_step", "mark_step_complete", "mark_step_failed", "retry_step", "complete_mission", "fail_mission"] },
  { capability: "ask_user", toolNames: ["ask_user", "request_user_input"] },
  { capability: "update_mission_state", toolNames: ["update_mission_state", "report_status", "report_result", "report_validation", "revise_plan"] },
];

export function normalizeCoordinatorToolName(toolName: string): string {
  const trimmed = toolName.trim();
  if (trimmed.startsWith("mcp__")) {
    const parts = trimmed.split("__");
    return (parts[2] ?? trimmed).trim();
  }
  return trimmed;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createDelegationScope(args: {
  kind: DelegationScope["kind"];
  key: string;
  label?: string | null;
}): DelegationScope {
  return {
    kind: args.kind,
    key: args.key.trim(),
    label: typeof args.label === "string" && args.label.trim().length > 0 ? args.label.trim() : null,
  };
}

export function createDelegationContract(args: {
  contractId: string;
  runId: string;
  workerIntent: DelegationIntent;
  mode: DelegationMode;
  scope: DelegationScope;
  phaseKey?: string | null;
  status?: DelegationContractStatus;
  launchState?: DelegationLaunchState | null;
  activeWorkerIds?: string[];
  coordinatorCapabilities?: CoordinatorCapability[];
  launchPolicy?: DelegationContract["launchPolicy"];
  failurePolicy?: DelegationContract["failurePolicy"];
  batchId?: string | null;
  parentContractId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  failure?: DelegationContract["failure"] | null;
}): DelegationContract {
  const createdAt = args.createdAt ?? nowIso();
  const updatedAt = args.updatedAt ?? createdAt;
  const status = args.status ?? "launching";
  const contract: DelegationContract = {
    schemaVersion: 1,
    contractId: args.contractId.trim(),
    runId: args.runId.trim(),
    ownerKind: "coordinator",
    workerIntent: args.workerIntent,
    mode: args.mode,
    scope: args.scope,
    phaseKey: typeof args.phaseKey === "string" && args.phaseKey.trim().length > 0 ? args.phaseKey.trim() : null,
    status,
    launchState: args.launchState ?? null,
    activeWorkerIds: Array.isArray(args.activeWorkerIds)
      ? [...new Set(args.activeWorkerIds.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0))]
      : [],
    coordinatorCapabilities: args.coordinatorCapabilities ?? deriveCoordinatorCapabilities({
      mode: args.mode,
      workerIntent: args.workerIntent,
      status,
      launchState: args.launchState ?? null,
    }),
    launchPolicy: args.launchPolicy ?? { maxLaunchAttempts: 1 },
    failurePolicy: args.failurePolicy ?? { retryLimit: 0, escalation: "intervention" },
    batchId: typeof args.batchId === "string" && args.batchId.trim().length > 0 ? args.batchId.trim() : null,
    parentContractId:
      typeof args.parentContractId === "string" && args.parentContractId.trim().length > 0
        ? args.parentContractId.trim()
        : null,
    failure: args.failure ?? null,
    metadata: args.metadata ?? null,
    createdAt,
    updatedAt,
    startedAt: args.startedAt ?? null,
    completedAt: args.completedAt ?? null,
  };
  return contract;
}

export function updateDelegationContract(
  contract: DelegationContract,
  patch: Partial<Omit<DelegationContract, "schemaVersion" | "contractId" | "runId" | "ownerKind" | "scope" | "createdAt">>,
): DelegationContract {
  const nextStatus = patch.status ?? contract.status;
  const nextLaunchState = patch.launchState === undefined ? contract.launchState : patch.launchState ?? null;
  const updatedAt = patch.updatedAt ?? nowIso();
  return {
    ...contract,
    ...patch,
    status: nextStatus,
    launchState: nextLaunchState,
    updatedAt,
    coordinatorCapabilities: patch.coordinatorCapabilities ?? deriveCoordinatorCapabilities({
      mode: patch.mode ?? contract.mode,
      workerIntent: patch.workerIntent ?? contract.workerIntent,
      status: nextStatus,
      launchState: nextLaunchState,
    }),
  };
}

export function deriveCoordinatorCapabilities(args: {
  mode: DelegationMode;
  workerIntent: DelegationIntent;
  status: DelegationContractStatus;
  launchState?: DelegationLaunchState | null;
}): CoordinatorCapability[] {
  if (args.mode === "bounded_parallel") {
    return [
      "observe",
      "read_repo",
      "fetch_project_context",
      "spawn_top_level_worker",
      "spawn_nested_worker",
      "spawn_parallel_workers",
      "message_workers",
      "ask_user",
      "run_control",
      "update_mission_state",
    ];
  }

  if (args.mode === "recovery") {
    return [
      "observe",
      "spawn_top_level_worker",
      "message_workers",
      "run_control",
      "update_mission_state",
    ];
  }

  if (args.workerIntent === "planner") {
    if (args.status === "active" || args.launchState === "waiting_on_worker") {
      return ["observe", "run_control", "update_mission_state"];
    }
    return ["observe", "fetch_project_context", "spawn_top_level_worker", "run_control", "update_mission_state"];
  }

  return ["observe", "run_control", "update_mission_state"];
}

export function getCoordinatorToolCapability(toolName: string): CoordinatorCapability | null {
  const normalizedToolName = normalizeCoordinatorToolName(toolName);
  for (const entry of COORDINATOR_TOOL_CAPABILITIES) {
    if (entry.toolNames.includes(normalizedToolName)) return entry.capability;
  }
  return null;
}

export function extractDelegationContract(value: unknown): DelegationContract | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (Number(raw.schemaVersion) !== 1) return null;
  const contractId = typeof raw.contractId === "string" ? raw.contractId.trim() : "";
  const runId = typeof raw.runId === "string" ? raw.runId.trim() : "";
  const ownerKind = raw.ownerKind === "coordinator" ? raw.ownerKind : null;
  const workerIntent =
    raw.workerIntent === "planner"
    || raw.workerIntent === "implementation"
    || raw.workerIntent === "validation"
    || raw.workerIntent === "specialist"
    || raw.workerIntent === "subagent"
    || raw.workerIntent === "parallel_subtasks"
    || raw.workerIntent === "recovery"
      ? raw.workerIntent
      : null;
  const mode = raw.mode === "exclusive" || raw.mode === "bounded_parallel" || raw.mode === "recovery"
    ? raw.mode
    : null;
  const status =
    raw.status === "launching"
    || raw.status === "active"
    || raw.status === "completed"
    || raw.status === "failed"
    || raw.status === "launch_failed"
    || raw.status === "recovering"
    || raw.status === "blocked"
    || raw.status === "canceled"
      ? raw.status
      : null;
  const scopeRaw = asRecord(raw.scope);
  const scopeKind =
    scopeRaw?.kind === "phase"
    || scopeRaw?.kind === "step"
    || scopeRaw?.kind === "worker"
    || scopeRaw?.kind === "batch"
      ? scopeRaw.kind
      : null;
  const scopeKey = typeof scopeRaw?.key === "string" ? scopeRaw.key.trim() : "";
  if (!contractId || !runId || !ownerKind || !workerIntent || !mode || !status || !scopeKind || !scopeKey) {
    return null;
  }
  const launchState =
    raw.launchState === "awaiting_context"
    || raw.launchState === "fetching_context"
    || raw.launchState === "awaiting_worker_launch"
    || raw.launchState === "launching_worker"
    || raw.launchState === "waiting_on_worker"
    || raw.launchState === "recovering"
    || raw.launchState === "completed"
    || raw.launchState === "blocked"
      ? raw.launchState
      : null;
  const failureRaw = asRecord(raw.failure);
  const failureCategory =
    failureRaw?.category === "run_context_bug"
    || failureRaw?.category === "provider_unreachable"
    || failureRaw?.category === "permission_denied"
    || failureRaw?.category === "tool_schema_error"
    || failureRaw?.category === "native_tool_violation"
    || failureRaw?.category === "unknown"
      ? (failureRaw.category as DelegationFailureCategory)
      : "unknown";
  const recoveryOptions = Array.isArray(failureRaw?.recoveryOptions)
    ? failureRaw.recoveryOptions.filter(
        (entry): entry is DelegationRecoveryOption =>
          entry === "retry" || entry === "switch_to_fallback_model" || entry === "cancel_run",
      )
    : [];
  return {
    schemaVersion: 1,
    contractId,
    runId,
    ownerKind,
    workerIntent,
    mode,
    scope: {
      kind: scopeKind,
      key: scopeKey,
      label: typeof scopeRaw?.label === "string" && scopeRaw.label.trim().length > 0 ? scopeRaw.label.trim() : null,
    },
    phaseKey: typeof raw.phaseKey === "string" && raw.phaseKey.trim().length > 0 ? raw.phaseKey.trim() : null,
    status,
    launchState,
    activeWorkerIds: Array.isArray(raw.activeWorkerIds)
      ? [...new Set(raw.activeWorkerIds.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0))]
      : [],
    coordinatorCapabilities: Array.isArray(raw.coordinatorCapabilities)
      ? raw.coordinatorCapabilities.filter((entry): entry is CoordinatorCapability => typeof entry === "string")
      : deriveCoordinatorCapabilities({ mode, workerIntent, status, launchState }),
    launchPolicy: asRecord(raw.launchPolicy)
      ? {
          maxLaunchAttempts: Math.max(1, Number(asRecord(raw.launchPolicy)?.maxLaunchAttempts ?? 1)),
        }
      : { maxLaunchAttempts: 1 },
    failurePolicy: asRecord(raw.failurePolicy)
      ? {
          retryLimit: Math.max(0, Number(asRecord(raw.failurePolicy)?.retryLimit ?? 0)),
          escalation:
            asRecord(raw.failurePolicy)?.escalation === "intervention"
            || asRecord(raw.failurePolicy)?.escalation === "retry"
            || asRecord(raw.failurePolicy)?.escalation === "stop"
              ? (asRecord(raw.failurePolicy)?.escalation as DelegationContract["failurePolicy"]["escalation"])
              : "intervention",
        }
      : { retryLimit: 0, escalation: "intervention" },
    batchId: typeof raw.batchId === "string" && raw.batchId.trim().length > 0 ? raw.batchId.trim() : null,
    parentContractId:
      typeof raw.parentContractId === "string" && raw.parentContractId.trim().length > 0
        ? raw.parentContractId.trim()
        : null,
    failure: failureRaw
      ? {
          category: failureCategory,
          reasonCode: typeof failureRaw.reasonCode === "string" ? failureRaw.reasonCode.trim() : "delegation_failure",
          retryable: failureRaw.retryable === true,
          recoveryOptions,
          message: typeof failureRaw.message === "string" ? failureRaw.message.trim() : "",
          toolName: typeof failureRaw.toolName === "string" && failureRaw.toolName.trim().length > 0
            ? failureRaw.toolName.trim()
            : null,
          retryCount: Math.max(0, Number(failureRaw.retryCount ?? 0)),
          occurredAt: typeof failureRaw.occurredAt === "string" && failureRaw.occurredAt.trim().length > 0
            ? failureRaw.occurredAt.trim()
            : nowIso(),
        }
      : null,
    metadata: asRecord(raw.metadata) ?? null,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt.trim().length > 0 ? raw.createdAt.trim() : nowIso(),
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.trim().length > 0 ? raw.updatedAt.trim() : nowIso(),
    startedAt: typeof raw.startedAt === "string" && raw.startedAt.trim().length > 0 ? raw.startedAt.trim() : null,
    completedAt: typeof raw.completedAt === "string" && raw.completedAt.trim().length > 0 ? raw.completedAt.trim() : null,
  };
}

export function isDelegationContractTerminal(status: DelegationContractStatus): boolean {
  return status === "completed" || status === "failed" || status === "launch_failed" || status === "blocked" || status === "canceled";
}

export function extractActiveDelegationContracts(graph: OrchestratorRunGraph): DelegationContract[] {
  return graph.steps
    .map((step) => extractDelegationContract(asRecord(step.metadata)?.delegationContract))
    .filter((contract): contract is DelegationContract => Boolean(contract))
    .map((contract) => {
      const step = graph.steps.find((candidate) =>
        candidate.stepKey === contract.activeWorkerIds[0] || candidate.id === contract.activeWorkerIds[0],
      );
      if (!step) return contract;
      return deriveDelegationContractFromStep(step, contract);
    })
    .filter((contract) => !isDelegationContractTerminal(contract.status));
}

export function deriveDelegationContractFromStep(
  step: OrchestratorStep,
  contract: DelegationContract,
): DelegationContract {
  if (step.status === "running") {
    return updateDelegationContract(contract, {
      status: "active",
      launchState: "waiting_on_worker",
      startedAt: step.startedAt ?? contract.startedAt,
    });
  }
  if (step.status === "ready" || step.status === "pending") {
    return contract;
  }
  if (step.status === "succeeded" || step.status === "skipped" || step.status === "superseded") {
    return updateDelegationContract(contract, {
      status: "completed",
      launchState: "completed",
      completedAt: step.completedAt ?? contract.completedAt ?? nowIso(),
    });
  }
  if (step.status === "blocked") {
    return updateDelegationContract(contract, {
      status: "blocked",
      launchState: "blocked",
      completedAt: step.completedAt ?? contract.completedAt ?? nowIso(),
    });
  }
  if (step.status === "canceled") {
    return updateDelegationContract(contract, {
      status: "canceled",
      completedAt: step.completedAt ?? contract.completedAt ?? nowIso(),
    });
  }
  if (step.status === "failed") {
    const nextStatus = contract.mode === "recovery" ? "blocked" : "failed";
    return updateDelegationContract(contract, {
      status: nextStatus,
      completedAt: step.completedAt ?? contract.completedAt ?? nowIso(),
    });
  }
  return contract;
}

export function hasConflictingDelegationContract(args: {
  graph: OrchestratorRunGraph;
  contract: DelegationContract;
}): DelegationContract | null {
  const activeContracts = extractActiveDelegationContracts(args.graph);
  for (const existing of activeContracts) {
    if (existing.contractId === args.contract.contractId) continue;
    if (existing.scope.key !== args.contract.scope.key) continue;
    if (existing.mode === "exclusive" || args.contract.mode === "exclusive") {
      return existing;
    }
  }
  return null;
}

export function checkCoordinatorToolPermission(args: {
  toolName: string;
  contracts: DelegationContract[];
}): { allowed: true } | { allowed: false; reason: string; contract: DelegationContract; capability: CoordinatorCapability | null } {
  const normalizedToolName = normalizeCoordinatorToolName(args.toolName);
  const capability = getCoordinatorToolCapability(normalizedToolName);
  for (const contract of args.contracts) {
    if (isDelegationContractTerminal(contract.status)) continue;
    if (contract.mode === "exclusive" && contract.workerIntent === "planner") {
      const allowedToolNames =
        contract.status === "active" || contract.launchState === "waiting_on_worker"
          ? PLANNER_STARTUP_OBSERVATION_TOOL_NAMES
          : new Set([
              ...PLANNER_STARTUP_OBSERVATION_TOOL_NAMES,
              "get_project_context",
              "spawn_worker",
            ]);
      if (!allowedToolNames.has(normalizedToolName)) {
        return {
          allowed: false,
          reason:
            contract.status === "active" || contract.launchState === "waiting_on_worker"
              ? `Planner delegation is active for scope '${contract.scope.key}'. Wait for the planner instead of using '${normalizedToolName}'.`
              : `Planner delegation is launching for scope '${contract.scope.key}'. Stay inside startup-safe tools until the planner is running.`,
          contract,
          capability,
        };
      }
      continue;
    }
    if (contract.mode === "recovery" && capability === "read_repo") {
      return {
        allowed: false,
        reason:
          `Recovery delegation owns scope '${contract.scope.key}'. Launch recovery work or inspect worker output instead of resuming repo exploration directly.`,
        contract,
        capability,
      };
    }
  }
  return { allowed: true };
}

export function derivePlanningStartupStateFromContract(contract: DelegationContract | null): {
  state: "inactive" | "awaiting_project_context" | "awaiting_planner_launch" | "waiting_on_planner" | "failed";
  contract: DelegationContract | null;
} {
  if (!contract || isDelegationContractTerminal(contract.status) && contract.status !== "blocked") {
    return { state: "inactive", contract: null };
  }
  if (contract.status === "launch_failed" || contract.status === "blocked" || contract.status === "failed") {
    return { state: "failed", contract };
  }
  if (contract.status === "active" || contract.launchState === "waiting_on_worker") {
    return { state: "waiting_on_planner", contract };
  }
  if (contract.launchState === "awaiting_context" || contract.launchState === "fetching_context") {
    return { state: "awaiting_project_context", contract };
  }
  return { state: "awaiting_planner_launch", contract };
}
