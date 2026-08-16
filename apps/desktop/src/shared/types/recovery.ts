export const ADE_RECOVERY_ERROR_CODES = [
  "disk_full",
  "insufficient_headroom",
  "db_integrity",
  "migration_incomplete",
  "migration_unknown_state",
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
 * The repair steps in the order `ProjectRecoveryService.repair` runs them,
 * with the wording each one shows. Shared so the recovery screen can name the
 * step that is running before it has reported, from the same list.
 */
export const REPAIR_STEPS: ReadonlyArray<{ id: RepairStepId; label: string }> = [
  { id: "check_space", label: "Checking storage space" },
  { id: "stop_service", label: "Stopping ADE's background service" },
  { id: "validate_database", label: "Checking project data" },
  { id: "resolve_migrations", label: "Finishing interrupted saves" },
  { id: "restart_service", label: "Restarting ADE's background service" },
  { id: "verify_endpoint", label: "Checking the background service" },
  { id: "verify_project_rpc", label: "Checking this project" },
  { id: "reconcile_chats", label: "Checking chats" },
];

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
      return code;
    default:
      return "unknown";
  }
}
