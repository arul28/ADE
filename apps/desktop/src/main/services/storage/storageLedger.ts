// Storage ledger: the declared policy for every persistent table and directory
// ADE writes. Each entry states what the data is, its privacy class, and how it
// is bounded (write-time cap, storage-doctor sweep, or manual only). The ledger
// is the single source of truth the Settings UI reads for its policy chips and
// that CI cross-checks against `ADE_LAYOUT_DEFINITIONS` so a new tracked layout
// directory cannot ship without a declared storage policy (see
// `storageLedger.test.ts`).

import type {
  StorageCategoryId,
  StorageLedgerEntry,
} from "../../../shared/types/storage";
import {
  AUTOMATION_SCHEDULE_OCCURRENCE_RETENTION_DAYS,
  INGRESS_EVENT_HARD_MAX_ROWS_PER_PROJECT,
  INGRESS_EVENT_RETENTION_MS,
  EVENT_LOG_RETENTION_DAYS,
  PR_SNAPSHOT_RETENTION_DAYS,
  REVIEW_ARTIFACT_RETENTION_DAYS,
} from "../state/dbMaintenanceApi";

// The DB retention/count policies below derive from the shared enforcement
// constants so the ledger, the ingress writer, and the kvDb maintenance hooks
// can never drift apart.
const INGRESS_EVENT_RETENTION_DAYS = Math.round(INGRESS_EVENT_RETENTION_MS / (24 * 60 * 60 * 1_000));

export const STORAGE_LEDGER: readonly StorageLedgerEntry[] = [
  // --- Project database tables (§1 evidence) -------------------------------
  {
    id: "db.automation_ingress_events",
    kind: "table",
    description: "Webhook history — inbound automation events. 99.99% are written and never read.",
    policyClass: "operational",
    // maxRows is the TOTAL table ceiling (hard cap across all statuses); the
    // 2,000 active-row cap is a sub-limit within it, not the table's max size.
    policy: { maxAgeDays: INGRESS_EVENT_RETENTION_DAYS, maxRows: INGRESS_EVENT_HARD_MAX_ROWS_PER_PROJECT },
    enforcement: "both",
  },
  {
    id: "db.automation_schedule_occurrences",
    kind: "table",
    description: "Machine-local cron occurrence claims used to elect one automation executor across concurrent runtimes.",
    policyClass: "operational",
    policy: { maxAgeDays: AUTOMATION_SCHEDULE_OCCURRENCE_RETENTION_DAYS },
    enforcement: "write_time",
  },
  {
    id: "db.operations_crsql",
    kind: "table",
    description: "Sync bookkeeping — cr-sqlite change-tracking clock and primary-key shadow rows.",
    policyClass: "operational",
    policy: {},
    enforcement: "doctor",
  },
  {
    id: "db.review_run_artifacts",
    kind: "table",
    description: "Review artifacts — cached code-review results, re-derivable from a fresh run.",
    policyClass: "derived",
    policy: { maxAgeDays: REVIEW_ARTIFACT_RETENTION_DAYS },
    enforcement: "both",
  },
  {
    id: "db.pull_request_snapshots",
    kind: "table",
    description: "PR cache — pull-request metadata re-fetchable from GitHub.",
    policyClass: "derived",
    policy: { maxAgeDays: PR_SNAPSHOT_RETENTION_DAYS },
    enforcement: "both",
  },
  {
    id: "db.event_logs",
    kind: "table",
    description: "Linear sync/workflow, worker cost, and pack event history.",
    policyClass: "operational",
    policy: { maxAgeDays: EVENT_LOG_RETENTION_DAYS },
    enforcement: "doctor",
  },
  {
    id: "db.core",
    kind: "table",
    description: "Core project data — chats, lanes, and other durable records. Never auto-deleted.",
    policyClass: "user_data",
    policy: {},
    enforcement: "manual",
  },
  // --- Filesystem directories / file families ------------------------------
  {
    id: "fs.transcripts",
    kind: "directory",
    description: "Chat and terminal history. Inactive files are gzip-compressed with transparent read-back.",
    policyClass: "user_data",
    policy: { compressAfterDays: 14 },
    enforcement: "doctor",
  },
  {
    id: "fs.tmp",
    kind: "directory",
    description: "Project release staging under .ade/tmp (TestFlight and release verification scratch).",
    policyClass: "derived",
    policy: { maxAgeDays: 7 },
    enforcement: "manual",
  },
  {
    id: "fs.tmp_staging",
    kind: "file_family",
    description: "System temp staging (ade-* directories) left by build and release operations.",
    policyClass: "derived",
    policy: { maxAgeDays: 7 },
    enforcement: "manual",
  },
  {
    id: "fs.recovery_backups",
    kind: "file_family",
    description: "Database recovery backups. ADE keeps the newest good copy and lists older verified copies for review.",
    policyClass: "operational",
    policy: { keepLatest: 1, maxAgeDays: 7 },
    enforcement: "manual",
  },
  {
    id: "fs.cache",
    kind: "directory",
    description: "Rebuildable caches under .ade/cache. Recreated on demand.",
    policyClass: "derived",
    policy: {},
    enforcement: "manual",
  },
  {
    id: "fs.ios_derived_data",
    kind: "directory",
    description: "iOS simulator DerivedData build cache. Recreated the next time you build.",
    policyClass: "derived",
    policy: {},
    enforcement: "manual",
  },
  {
    id: "fs.storage_doctor_journal",
    kind: "file_family",
    description: "Storage maintenance journal recording the last 30 doctor runs.",
    policyClass: "operational",
    policy: { keepLatest: 30 },
    enforcement: "doctor",
  },
  {
    id: "fs.artifacts",
    kind: "directory",
    description: "Proof, recordings, and captured artifacts. Kept until you remove them.",
    policyClass: "user_data",
    policy: {},
    enforcement: "manual",
  },
  {
    id: "fs.attachments",
    kind: "directory",
    description: "Chat attachments. Kept until you remove them.",
    policyClass: "user_data",
    policy: {},
    enforcement: "manual",
  },
  {
    id: "fs.worktrees",
    kind: "directory",
    description: "Lane worktrees. Active lanes are protected; archived and orphaned ones are removed only on request.",
    policyClass: "user_data",
    policy: {},
    enforcement: "manual",
  },
] as const;

const _byId = new Map(STORAGE_LEDGER.map((entry) => [entry.id, entry]));

export function getLedgerEntry(id: string): StorageLedgerEntry | undefined {
  return _byId.get(id);
}

/**
 * Maps every `ADE_LAYOUT_DEFINITIONS` directory entry to a ledger id, or `null`
 * when the directory is intentionally not storage-managed (user-authored config
 * or credentials the doctor must never touch). The coverage test asserts that
 * every layout directory appears here, so adding a new tracked directory
 * without declaring its storage policy fails CI.
 */
export const LEDGER_LAYOUT_COVERAGE: Readonly<Record<string, string | null>> = {
  // Storage-managed directories.
  transcripts: "fs.transcripts",
  cache: "fs.cache",
  worktrees: "fs.worktrees",
  artifacts: "fs.artifacts",
  // Intentionally unmanaged: git-tracked, user-authored shared assets. These are
  // small config/source directories the storage doctor deliberately never sweeps.
  cto: null,
  templates: null,
  skills: null,
  workflows: null,
  "workflows/linear": null,
  "project-icons": null,
  // Intentionally unmanaged: agent-runtime scratch owned by the runtimes that
  // write them. Small and short-lived; not doctor-managed in this release.
  agents: null,
  context: null,
  history: null,
  reflections: null,
  // Intentionally unmanaged: credentials. Never auto-managed by storage tooling.
  secrets: null,
};

/**
 * Human-readable policy chips per storage category, derived from the ledger so a
 * policy change (e.g. compress-after days) updates the Settings copy in lockstep.
 * Copy rules: sentence-case, verbs first, no internal jargon.
 */
export function deriveCategoryPolicyChips(): Partial<Record<StorageCategoryId, string>> {
  const chips: Partial<Record<StorageCategoryId, string>> = {};

  const transcripts = _byId.get("fs.transcripts");
  if (transcripts?.policy.compressAfterDays != null) {
    chips.chats_history = `Compressed after ${transcripts.policy.compressAfterDays} days`;
  }

  const tmp = _byId.get("fs.tmp");
  if (tmp?.policy.maxAgeDays != null) {
    chips.build_release = `Review after ${tmp.policy.maxAgeDays} days`;
  }

  chips.caches = "Rebuilt when needed";

  const backups = _byId.get("fs.recovery_backups");
  if (backups?.policy.keepLatest != null) {
    chips.recovery_backups = backups.policy.keepLatest === 1
      ? "Keeps the latest backup"
      : `Keeps the newest ${backups.policy.keepLatest}`;
  }

  chips.lanes_worktrees = "Kept until you remove them";
  chips.proof_attachments = "Kept until you remove them";
  chips.database = "Cleaned during maintenance";

  return chips;
}
