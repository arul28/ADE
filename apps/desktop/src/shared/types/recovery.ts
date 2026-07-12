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
