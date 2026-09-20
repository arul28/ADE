import type { AgentChatStopSource } from "./types";

/**
 * Terminalizing rows the event stream never closed.
 *
 * The Claude Agent SDK emits no terminal event for a subagent or a background
 * task when the parent process exits, and ADE derives the chat-actions pane
 * purely from that stream. The result the owner screenshotted: subagent rows
 * reading "running" for 17-24 hours and background commands still "running"
 * long after the process that launched them was gone.
 *
 * Nothing in the stream can fix that, because the stream ended. The truthful
 * state lives elsewhere — the chat's runtime process (dead or alive), and, for
 * a row that is really a spawned ADE chat, that chat's OWN session row. This
 * module is the pure decision half of the sweep that reads those two and says
 * what terminal event each stale row has earned. The service half owns process
 * liveness, transcript reads, and emission.
 */

/** What the spawned ADE chat behind a subagent row is actually doing. */
export type OrphanChildChatState =
  /** Its own runtime process is still alive — the row is telling the truth. */
  | "active"
  /** The chat exists and is not running: it finished its turn, or its brain died. */
  | "idle"
  /** The chat row is closed (completed/disposed, or it has an endedAt). */
  | "ended"
  /** The chat row is failed, or its last turn died on a runtime error. */
  | "failed"
  /** There is no such chat any more. */
  | "missing";

/**
 * The bits of a session row this decision reads — nothing else, so a caller
 * hands the row straight in instead of hand-copying a shape that drifts.
 */
export type OrphanChildChatRow = {
  status: "running" | "completed" | "failed" | "disposed" | "detached";
  endedAt?: string | null;
  lastTurnFailedAt?: string | null;
};

/**
 * Read a spawned subagent chat's real state.
 *
 * `ownerLive` is the caller's Windows-safe liveness verdict for that chat's own
 * runtime owner (`processRegistry.isProcessIdentityLive`), never a `process.kill`
 * probe: a "running" DB row whose brain died is `idle`, not `active`, and that
 * distinction is the whole point — it is what turns a 17-hour "running" row into
 * a finished one.
 */
export function deriveOrphanChildChatState(
  row: OrphanChildChatRow | null | undefined,
  ownerLive: boolean,
): OrphanChildChatState {
  if (!row) return "missing";
  if (row.status === "failed" || (row.lastTurnFailedAt ?? "").trim().length > 0) return "failed";
  if (row.status === "completed" || row.status === "disposed") return "ended";
  if ((row.endedAt ?? "").trim().length > 0) return "ended";
  return ownerLive ? "active" : "idle";
}

/**
 * A still-"running" subagent row. Only what the verdict reads: the caller keeps
 * ownership of ids, parent tool use and turn scoping when it emits.
 */
export type OrphanSubagentRow = {
  name: string;
  summary?: string | null;
};

export type OrphanStopAttribution = {
  stopSource: AgentChatStopSource;
  stopReason: string;
};

export type OrphanSubagentTerminal = {
  status: "completed" | "failed" | "stopped";
  summary: string;
  finalSummary: string;
  /** Omitted for `completed`: nobody stopped a task that reported a result. */
  stopSource?: AgentChatStopSource;
  stopReason?: string;
};

/** The copy a finished-but-never-closed delegate row gets. */
export const ORPHAN_SUBAGENT_REPORT_LANDED_SUMMARY = "Finished (report landed)";
export const ORPHAN_SUBAGENT_NO_REPORT_SUMMARY = "Stopped: the subagent chat went idle without a report";
export const ORPHAN_SUBAGENT_CHAT_ENDED_SUMMARY = "Stopped: the subagent chat ended";
export const ORPHAN_SUBAGENT_CHAT_MISSING_SUMMARY = "Stopped: the subagent chat is gone";
export const ORPHAN_SUBAGENT_CHAT_FAILED_SUMMARY = "Failed: the subagent chat reported a failure";
export const ORPHAN_BACKGROUND_SUMMARY = "Stopped: the process that ran this command exited";

/** A summary the agent actually wrote, as opposed to the row's own title. */
function reportedSummary(row: OrphanSubagentRow, childReport?: string | null): string | null {
  const fromChild = childReport?.trim();
  if (fromChild) return fromChild;
  const own = row.summary?.trim();
  if (own && own !== row.name.trim()) return own;
  return null;
}

/**
 * What terminal event one stale subagent row has earned.
 *
 * `null` means leave it alone — the only case being a spawned chat whose own
 * runtime is still alive, which is a genuinely running delegate that happens to
 * outlive its parent.
 *
 * A row that is NOT a spawned ADE chat (`childState: null`) has no second
 * source of truth, so it takes the caller's restart/takeover attribution
 * verbatim. Never `stopSource: "user"` — nobody pressed Stop.
 */
export function decideOrphanSubagentTerminal(args: {
  row: OrphanSubagentRow;
  childState: OrphanChildChatState | null;
  /** The child chat's own last report (row summary / status note), when it has one. */
  childReport?: string | null;
  attribution: OrphanStopAttribution;
}): OrphanSubagentTerminal | null {
  const { row, childState, childReport, attribution } = args;
  if (childState === "active") return null;

  const stopped = (summary: string): OrphanSubagentTerminal => ({
    status: "stopped",
    summary,
    finalSummary: summary,
    stopSource: attribution.stopSource,
    stopReason: attribution.stopReason,
  });

  if (childState == null) {
    return stopped(reportedSummary(row) ?? `Stopped: ${attribution.stopReason}`);
  }
  if (childState === "failed") {
    const summary = reportedSummary(row, childReport) ?? ORPHAN_SUBAGENT_CHAT_FAILED_SUMMARY;
    return { status: "failed", summary, finalSummary: summary };
  }
  if (childState === "missing") return stopped(ORPHAN_SUBAGENT_CHAT_MISSING_SUMMARY);
  if (childState === "ended") {
    // An ended chat that still left a report is a finished delegate, not a
    // casualty: the report landing is what the reader cares about.
    const report = reportedSummary(row, childReport);
    return report
      ? { status: "completed", summary: report, finalSummary: report }
      : stopped(ORPHAN_SUBAGENT_CHAT_ENDED_SUMMARY);
  }
  // idle: the delegate stopped working. With a report it finished; without one
  // it was cut short, and saying "running" for another 17 hours is the bug.
  const report = reportedSummary(row, childReport);
  return report
    ? {
      status: "completed",
      summary: report,
      finalSummary: `${ORPHAN_SUBAGENT_REPORT_LANDED_SUMMARY}: ${report}`,
    }
    : stopped(ORPHAN_SUBAGENT_NO_REPORT_SUMMARY);
}

/** A still-open background command row. Only what the verdict reads. */
type OrphanBackgroundRow = {
  title: string;
  summary?: string | null;
};

export type OrphanBackgroundTerminal = {
  status: "stopped";
  summary: string;
  stopSource: AgentChatStopSource;
  stopReason: string;
};

/**
 * Background commands have no second source of truth — the shell they ran in
 * died with the runtime — so every stale row is `stopped` with the sweep's own
 * attribution. `scheduled_work_update` already carries `stopped`, so this needs
 * no new event shape; `stopSource`/`stopReason` are the additive optional
 * fields older clients ignore.
 */
export function decideOrphanBackgroundTerminal(args: {
  row: OrphanBackgroundRow;
  attribution: OrphanStopAttribution;
}): OrphanBackgroundTerminal {
  const own = args.row.summary?.trim();
  return {
    status: "stopped",
    summary: own && own !== args.row.title.trim() ? own : ORPHAN_BACKGROUND_SUMMARY,
    stopSource: args.attribution.stopSource,
    stopReason: args.attribution.stopReason,
  };
}

/**
 * The id of the ADE chat a subagent row stands for, if any.
 *
 * Spawned rows carry either a `chat:<session id>` taskId or the child session
 * id as their agentId, and `subagentSnapshotsFromEvents` keys on
 * `agentId ?? taskId` — so both shapes arrive here as one string. The caller
 * confirms the candidate is really a chat row before trusting it.
 */
export function orphanRowChildSessionCandidate(rowId: string): string | null {
  const id = rowId.trim();
  if (!id) return null;
  if (id.startsWith("chat:")) {
    const child = id.slice("chat:".length).trim();
    return child.length ? child : null;
  }
  return id;
}
