export const ADE_RECOVERY_ERROR_CODES = [
  "disk_full",
  "insufficient_headroom",
  "db_integrity",
  "migration_incomplete",
  "migration_unknown_state",
  /** The data files exist but the filesystem refuses to read them. */
  "storage_read_failed",
  "brain_not_installed",
  "brain_crash_looping",
  "socket_stale_no_owner",
  "socket_owned_by_other",
  "provider_thread_missing",
  "provider_resume_failed",
  "optional_mcp_failed",
  "continuity_reconstruction_required",
  "unknown",
] as const;

export type AdeRecoveryErrorCode = typeof ADE_RECOVERY_ERROR_CODES[number];

export function toAdeRecoveryErrorCode(value: unknown): AdeRecoveryErrorCode | null {
  return typeof value === "string"
    && (ADE_RECOVERY_ERROR_CODES as readonly string[]).includes(value)
    ? value as AdeRecoveryErrorCode
    : null;
}

export type AdeLastFailureReport = {
  version: 1;
  code: AdeRecoveryErrorCode;
  message: string;
  detail?: string;
  at: string;
  projectRoot?: string;
  component: "brain_startup" | "project_db_open" | "sync_host" | "desktop_repair";
  count: number;
  firstAt: string;
};

export type ProjectRecoveryDiagnosis = {
  state:
    | "healthy"
    | "disk_full"
    | "insufficient_headroom"
    | "db_repair_needed"
    /**
     * The data files can't be read at all — typically a project or `~/.ade`
     * parked in a cloud folder whose contents were evicted. Repair is not
     * offered: rewriting files ADE cannot read would risk the user's data, and
     * the fix is to move the folder.
     */
    | "storage_unreadable"
    | "brain_crash_looping"
    | "brain_not_installed"
    | "socket_stale_no_owner"
    | "socket_owned_by_other"
    /**
     * The background service is registered and its brain is alive but has not
     * bound the socket yet. Nothing to repair — the desktop keeps checking and
     * opens the project as soon as it answers.
     */
    | "brain_starting"
    | "unknown_failure";
  code: AdeRecoveryErrorCode;
  headline: string;
  body: string;
  canAutoRepair: boolean;
  requiresFreeSpaceBytes?: number;
  freeBytes?: number;
  lastFailure?: AdeLastFailureReport;
  technicalDetail: string;
};

export type RepairStepId =
  | "check_space"
  | "stop_service"
  | "validate_database"
  | "resolve_migrations"
  | "restart_service"
  | "verify_endpoint"
  | "verify_project_rpc"
  | "reconcile_chats";

/**
 * The wording each repair step shows. A `Record` keyed by the id union rather
 * than a list of pairs: a step added to {@link RepairStepId} without a label
 * has to fail here, at the definition, instead of surfacing as an unlabeled
 * row on the recovery screen.
 */
export const REPAIR_STEP_LABELS: Record<RepairStepId, string> = {
  check_space: "Checking storage space",
  stop_service: "Stopping ADE's background service",
  validate_database: "Checking project data",
  resolve_migrations: "Finishing interrupted saves",
  restart_service: "Restarting ADE's background service",
  verify_endpoint: "Checking the background service",
  verify_project_rpc: "Checking this project",
  reconcile_chats: "Checking chats",
};

/** The order `ProjectRecoveryService.repair` runs the steps in. */
export const REPAIR_STEP_ORDER: readonly RepairStepId[] = [
  "check_space",
  "stop_service",
  "validate_database",
  "resolve_migrations",
  "restart_service",
  "verify_endpoint",
  "verify_project_rpc",
  "reconcile_chats",
];

/**
 * The repair steps in the order they run, with their wording. Shared so the
 * recovery screen can name the step that is running before it has reported,
 * from the same list.
 */
export const REPAIR_STEPS: ReadonlyArray<{ id: RepairStepId; label: string }> =
  REPAIR_STEP_ORDER.map((id) => ({ id, label: REPAIR_STEP_LABELS[id] }));

export type RepairStepResult = {
  id: RepairStepId;
  label: string;
  status: "ok" | "failed" | "skipped";
  detail?: string;
};

export type ProjectRepairReport = {
  ok: boolean;
  steps: RepairStepResult[];
  dbHealthy: boolean | null;
  chatsTotal: number | null;
  chatsNeedingAttention: number | null;
  filesRemoved: 0;
  failureCode?: AdeRecoveryErrorCode;
  nextAction?: string;
};

export function mapKvDbOpenErrorCode(code: string): AdeRecoveryErrorCode {
  switch (code) {
    case "disk_full":
    case "insufficient_headroom":
    case "db_integrity":
    case "migration_incomplete":
    case "migration_unknown_state":
    case "storage_read_failed":
      return code;
    default:
      return "unknown";
  }
}

/**
 * The single mapping from a stored failure code to the recovery state it
 * describes. Both the main process (when it falls back to the last recorded
 * failure) and the recovery screen (when a live diagnosis is unavailable) read
 * it from here, so the screen can never offer a different verdict — or a
 * different repair offer — than the service would have given.
 */
export function stateForCode(code: AdeRecoveryErrorCode): ProjectRecoveryDiagnosis["state"] {
  switch (code) {
    case "disk_full": return "disk_full";
    case "insufficient_headroom": return "insufficient_headroom";
    case "db_integrity":
    case "migration_incomplete":
    case "migration_unknown_state": return "db_repair_needed";
    case "storage_read_failed": return "storage_unreadable";
    case "brain_crash_looping": return "brain_crash_looping";
    case "brain_not_installed": return "brain_not_installed";
    case "socket_stale_no_owner": return "socket_stale_no_owner";
    case "socket_owned_by_other": return "socket_owned_by_other";
    default: return "unknown_failure";
  }
}
