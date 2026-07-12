export type AdeRecoveryErrorCode =
  | "disk_full"
  | "insufficient_headroom"
  | "db_integrity"
  | "migration_incomplete"
  | "migration_unknown_state"
  | "brain_not_installed"
  | "brain_crash_looping"
  | "socket_stale_no_owner"
  | "socket_owned_by_other"
  | "provider_thread_missing"
  | "provider_resume_failed"
  | "optional_mcp_failed"
  | "continuity_reconstruction_required"
  | "unknown";

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
