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
  /** macOS loaded the launch agent but "Allow in the Background" is off for ADE. */
  "background_item_blocked",
  /** The service is installed but its brain is not running, with no crash on record. */
  "brain_not_running",
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
    /**
     * macOS keeps ADE's launch agent loaded but will not start it, because ADE
     * is switched off under Login Items → "Allow in the Background". No repair
     * can change that; the screen sends the person to the switch and resumes
     * by itself once it is on.
     */
    | "background_blocked"
    /** Installed, not running, and no recorded crash: start it, do not call it a crash loop. */
    | "brain_not_running"
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
  check_space: "Checking free space",
  stop_service: "Stopping ADE",
  validate_database: "Checking this project's ADE data",
  resolve_migrations: "Finishing anything that was interrupted",
  restart_service: "Starting ADE again",
  verify_endpoint: "Checking that ADE answers",
  verify_project_rpc: "Opening the project",
  reconcile_chats: "Checking chats",
};

export type RecoveryState = ProjectRecoveryDiagnosis["state"];

/**
 * What the person reads for each recovery state: the one table both the main
 * process and the recovery screen use, so they can never say different
 * things. Written for someone who has never heard of ADE's internals — no
 * "service", "brain", "socket" or "endpoint". `steps` is what the person does
 * themselves, and only states with a real chore have it.
 */
export const RECOVERY_COPY: Record<RecoveryState, {
  headline: string;
  body: string;
  canAutoRepair: boolean;
  steps?: readonly string[];
}> = {
  healthy: {
    headline: "ADE is ready",
    body: "Nothing needs fixing.",
    canAutoRepair: false,
  },
  disk_full: {
    headline: "Your computer is out of space",
    body: "ADE needs a little free space to open this project. Your work is safe.",
    canAutoRepair: true,
    steps: [
      "Free up some space. Emptying the Trash is often enough.",
      "Then choose Fix it.",
    ],
  },
  insufficient_headroom: {
    headline: "Your computer is almost out of space",
    body: "ADE keeps a little space free so it never loses your work. Your work is safe.",
    canAutoRepair: true,
    steps: [
      "Free up a few GB. Emptying the Trash is often enough.",
      "Then choose Fix it.",
    ],
  },
  db_repair_needed: {
    headline: "This project needs a quick fix",
    body: "ADE was interrupted while it was saving. Fix it finishes the job. Your files and chats stay where they are.",
    canAutoRepair: true,
  },
  storage_unreadable: {
    headline: "ADE can't read this project's files",
    body: "This usually happens when the folder is in iCloud Drive, Dropbox or OneDrive, and the files aren't downloaded to this computer.",
    canAutoRepair: false,
    steps: [
      "Move the project folder to a normal folder on this computer.",
      "Then choose Try again.",
    ],
  },
  brain_not_installed: {
    headline: "ADE isn't fully set up",
    body: "A part of ADE that runs in the background is missing. Fix it sets it up again.",
    canAutoRepair: true,
  },
  brain_crash_looping: {
    headline: "ADE keeps stopping",
    body: "A part of ADE that runs in the background keeps stopping. Fix it starts it again.",
    canAutoRepair: true,
  },
  brain_not_running: {
    headline: "ADE didn't start",
    body: "A part of ADE that runs in the background is set up, but it didn't start. Fix it starts it.",
    canAutoRepair: true,
  },
  background_blocked: {
    headline: "Your Mac is blocking ADE",
    body: "ADE needs permission to run in the background, and that permission is turned off in System Settings.",
    canAutoRepair: false,
    steps: [
      "Choose Open System Settings.",
      "Under \"Allow in the Background\", turn on ADE. It can also show as \"Arul Sharma\", the name of ADE's developer.",
      "Come back here. ADE continues by itself.",
    ],
  },
  socket_stale_no_owner: {
    headline: "ADE didn't close properly last time",
    body: "Fix it cleans up and starts ADE again.",
    canAutoRepair: true,
  },
  socket_owned_by_other: {
    headline: "Another copy of ADE is open",
    body: "Only one copy of ADE can run on a computer at a time.",
    canAutoRepair: false,
    steps: [
      "Quit the other copy of ADE.",
      "Then choose Try again.",
    ],
  },
  brain_starting: {
    headline: "ADE is starting",
    body: "This can take a minute the first time, or right after an update. The project opens by itself.",
    canAutoRepair: false,
  },
  unknown_failure: {
    headline: "ADE couldn't open this project",
    body: "Fix it restarts ADE and checks this project. Your files and chats stay where they are.",
    canAutoRepair: true,
  },
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
    case "background_item_blocked": return "background_blocked";
    case "brain_not_running": return "brain_not_running";
    case "socket_stale_no_owner": return "socket_stale_no_owner";
    case "socket_owned_by_other": return "socket_owned_by_other";
    default: return "unknown_failure";
  }
}
