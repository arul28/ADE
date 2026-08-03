import type { EventBus } from "./eventBus";

export type InvalidationDomain = "lanes" | "sessions" | "chats" | "prs" | "files" | "github" | "rebase";

export const ALL_INVALIDATION_DOMAINS: readonly InvalidationDomain[] = [
  "lanes",
  "sessions",
  "chats",
  "prs",
  "files",
  "github",
  "rebase",
];

export type InvalidationEvent = {
  tables: string[];
  domains: InvalidationDomain[];
  at: string;
};

export type InvalidationEvents = {
  invalidation: InvalidationEvent;
};

export function createInvalidationScheduler(
  onTablesChanged: (listener: (tables: Set<string>) => void) => () => void,
  bus: EventBus<InvalidationEvents>,
  debounceMs = 250
): () => void {
  let pendingTables = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    timer = null;
    const tables = Array.from(pendingTables);
    pendingTables = new Set();
    const domains = Array.from(new Set(tables.flatMap(tableDomains)));
    if (domains.length === 0) return;
    bus.emit("invalidation", {
      tables,
      domains,
      at: new Date().toISOString(),
    });
  }

  const unsubscribe = onTablesChanged((tables) => {
    for (const table of tables) pendingTables.add(table);
    // Bound invalidation latency from the first pending table. Resetting this
    // timer on every live write lets a busy chat or terminal postpone every
    // lane/session/PR refresh forever. One timer still coalesces bursts while
    // guaranteeing a drain at most once per debounce window.
    if (!timer) timer = setTimeout(flush, debounceMs);
  });

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}

/**
 * Exact table name → the surfaces that render that table's rows.
 *
 * Deliberately exhaustive rather than pattern-matched. Substring rules read as
 * a reasonable shorthand and are wrong in both directions: "worktree" caught
 * `lane_worktree_locks`, "file" caught `lane_branch_profiles`, and "queue"
 * caught `linear_dispatch_queue`, so a lock heartbeat or a Linear enqueue wiped
 * the Files read cache and reloaded the whole GitHub snapshot every few
 * seconds. Every domain here costs a refetch on a metered relay link, so
 * membership has to be a decision, not a coincidence of spelling.
 *
 * A table missing from this map is NOT silent — see `SILENT_TABLES` and the
 * fallback in `tableDomains`. Getting an entry wrong costs a refetch; leaving a
 * rendered table out of a purely exact map costs a surface that never refreshes
 * at all until some unrelated poll rescues it, which is far worse and invisible
 * in review. Add rendered tables here anyway: the fallback is a floor, not a
 * substitute.
 */
const TABLE_DOMAINS: Readonly<Record<string, readonly InvalidationDomain[]>> = {
  // Coarse names the host sends for a full refresh (reconnect hello, or a batch
  // it could not describe precisely). They are not real tables.
  lanes: ["lanes"],
  sessions: ["sessions"],
  agent_chats: ["chats"],
  pull_requests: ["prs"],
  files: ["files"],
  github: ["github"],
  rebase: ["rebase"],

  // ── Lanes ────────────────────────────────────────────────────────────────
  lane_branch_profiles: ["lanes"],
  lane_linear_issues: ["lanes"],
  lane_linear_issue_links: ["lanes"],
  lane_state_snapshots: ["lanes"],
  lane_detail_snapshots: ["lanes"],
  lane_list_snapshots: ["lanes"],
  local_lane_storage_state: ["lanes"],
  // `lane_worktree_locks` is deliberately absent. It is a heartbeat-refreshed
  // ownership lock, not lane state anything renders, and it was the loudest
  // false positive of the old substring rule.

  // ── Sessions / chats ─────────────────────────────────────────────────────
  // Chat sessions and terminal sessions share one table, so a write there is
  // news for both surfaces.
  terminal_sessions: ["sessions", "chats"],
  session_deltas: ["sessions"],
  session_linear_issues: ["sessions"],
  claude_sessions: ["sessions"],
  runtime_processes: ["sessions"],
  __ade_runtime_processes_v2: ["sessions"],
  attempt_transcripts: ["chats"],

  // ── PRs ──────────────────────────────────────────────────────────────────
  pull_request_snapshots: ["prs"],
  pull_request_ai_summaries: ["prs"],
  github_pr_projections: ["prs"],
  github_pr_stacks: ["prs"],
  github_pr_stack_entries: ["prs"],
  github_webhook_deliveries: ["prs"],
  pr_groups: ["prs"],
  pr_group_members: ["prs"],
  pr_auto_link_ignores: ["prs"],
  integration_proposals: ["prs"],

  // ── Files ────────────────────────────────────────────────────────────────
  files_workspaces: ["files"],
  file_content_snapshots: ["files"],
  file_diff_snapshots: ["files"],
  file_directory_snapshots: ["files"],
  file_history_snapshots: ["files"],

  // ── Rebase / conflicts ───────────────────────────────────────────────────
  rebase_deferred: ["rebase"],
  rebase_dismissed: ["rebase"],
  conflict_predictions: ["rebase"],
  conflict_proposals: ["rebase"],
};

/**
 * Tables that are deliberately silent — a write here refreshes nothing.
 *
 * These are the false positives the exact map was written to kill, named so
 * that "not in TABLE_DOMAINS" can mean "nobody has classified this yet" rather
 * than doing double duty as "known to be noise". Each one is high-frequency and
 * renders nowhere on web: ownership-lock heartbeats, CTO/worker bookkeeping,
 * Linear and automation queues, local-only housekeeping, and usage ledgers.
 */
const SILENT_TABLES: ReadonlySet<string> = new Set([
  "lane_worktree_locks",
  "local_crr_change_suppressions",
  "local_storage_lifecycle_runs",
  "local_worktree_residual_cleanups",
  "ai_usage_log",
  "usage_events",
  "budget_usage_records",
  "devices",
  "kv",
  "operations",
  "sync_cluster_state",
  "checkpoints",
  "agent_identities",
  "cto_flow_policies",
  "cto_flow_policy_revisions",
  "cto_identity_state",
  "cto_session_logs",
  // The `worker_agent*` family is covered by the prefix rule in `tableDomains`.
]);

/**
 * What an unclassified table refreshes.
 *
 * Every table with a primary key is CRR-replicated, so the set of names that
 * can arrive is the whole schema and it grows without anyone touching this
 * file. A purely exact map turns each such addition into a silent staleness bug
 * on web only — the surface simply stops updating until an unrelated poll
 * happens by. These three domains are the ones a stale read is most visible in,
 * and they are cheap relative to a `files`/`github` snapshot refetch.
 */
const UNCLASSIFIED_TABLE_DOMAINS: readonly InvalidationDomain[] = ["lanes", "sessions", "chats"];

function tableDomains(table: string): readonly InvalidationDomain[] {
  const normalized = table.toLowerCase();
  const known = TABLE_DOMAINS[normalized];
  if (known) return known;
  if (SILENT_TABLES.has(normalized)) return [];
  // Prefixed families the schema keeps growing, whose members are as noisy as
  // the individually-named ones above and render nothing on web.
  if (normalized.startsWith("automation_")) return [];
  if (normalized.startsWith("linear_")) return [];
  if (normalized.startsWith("worker_agent")) return [];
  if (normalized.startsWith("review_")) return [];
  if (normalized.startsWith("pack")) return [];
  return UNCLASSIFIED_TABLE_DOMAINS;
}
