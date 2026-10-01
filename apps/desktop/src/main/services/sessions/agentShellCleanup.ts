import type { AdeDb } from "../state/kvDb";

/**
 * Archives the dead shells an agent started under a chat, so the Work sidebar
 * does not fill with "App Control: npm run dev…  Ended" rows.
 *
 * Archive only sets `terminal_sessions.archived_at`. The row and its transcript
 * stay, so nothing here loses output; the sidebar just stops listing the shell.
 *
 * A shell is eligible only when ALL of these hold:
 *   - an agent started it (`markAgentLaunched`), never the user;
 *   - it is attached to a chat (`chat_session_id`);
 *   - it has ended (completed / failed / disposed — not `running`, not `detached`);
 *   - nobody typed into it (`markUserInput`) — a shell the user touched is theirs.
 *
 * When it goes:
 *   - replaced by an App Control relaunch → at once;
 *   - exit 0, or stopped by ADE itself → `AGENT_SHELL_ARCHIVE_GRACE_MS` after it ended;
 *   - any other end (a crash, a non-zero exit) → only once its chat settles, so
 *     the failure stays in view while someone may still need it.
 *
 * The ledger table is machine-local (not a CRR): it records what this machine's
 * own processes started and saw typed, which no other machine can know.
 */

const AGENT_SHELL_ARCHIVE_GRACE_MS = 10 * 60_000;
/** How often ended agent shells are checked: grace periods and settles come due on their own. */
const AGENT_SHELL_SWEEP_INTERVAL_MS = 60_000;

export type AgentShellRetireReason = "relaunch" | "stop";

type CandidateRow = {
  sessionId: string;
  userInputAt: string | null;
  retiredReason: AgentShellRetireReason | null;
  status: string;
  exitCode: number | null;
  endedAt: string | null;
  parentSettledAt: string | null;
  parentArchivedAt: string | null;
};

// What a terminal emulator sends on its own, not because someone typed: replies
// to device/cursor queries, focus and mouse reports, OSC color answers.
const LEGACY_MOUSE_REPORT = /\x1b\[M[\s\S]{3}/g;
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\|O.|.)/g;

/** True when a terminal write holds something the user typed or pasted. */
export function writeCarriesTypedInput(data: string): boolean {
  return data.replace(LEGACY_MOUSE_REPORT, "").replace(ESCAPE_SEQUENCE, "").length > 0;
}

function agentShellArchiveDue(row: CandidateRow, nowMs: number): boolean {
  if (row.userInputAt) return false;
  if (row.status === "running" || row.status === "detached") return false;
  if (row.retiredReason === "relaunch") return true;
  const parentQuiet = Boolean(row.parentSettledAt || row.parentArchivedAt);
  const cleanEnd = row.retiredReason === "stop" || (row.status === "completed" && row.exitCode === 0);
  if (!cleanEnd) return parentQuiet;
  const endedMs = row.endedAt ? Date.parse(row.endedAt) : Number.NaN;
  if (!Number.isFinite(endedMs)) return parentQuiet;
  return nowMs - endedMs >= AGENT_SHELL_ARCHIVE_GRACE_MS;
}

export function createAgentShellCleanup({
  db,
  archiveSession,
}: {
  db: AdeDb;
  archiveSession: (sessionId: string) => boolean;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let reportError: (error: unknown) => void = () => {};

  const sweepQuietly = (): void => {
    try {
      cleanup.sweep();
    } catch (error) {
      reportError(error);
    }
  };

  const cleanup = {
    markAgentLaunched(sessionId: string): void {
      if (!sessionId) return;
      db.run(
        "insert or ignore into agent_shell_cleanup (session_id, launched_at) values (?, ?)",
        [sessionId, new Date().toISOString()],
      );
    },

    /** No-op for shells this ledger does not track (every user shell). */
    markUserInput(sessionId: string): void {
      if (!sessionId) return;
      db.run(
        "update agent_shell_cleanup set user_input_at = coalesce(user_input_at, ?) where session_id = ?",
        [new Date().toISOString(), sessionId],
      );
    },

    /**
     * ADE itself ended (or is about to end) the shell: App Control stopped or
     * relaunched its app. A relaunch archives it as soon as it is dead; a stop
     * counts as a clean end and waits out the grace period.
     */
    markRetiredByAde(sessionId: string, reason: AgentShellRetireReason): void {
      if (!sessionId) return;
      // A relaunch outranks an earlier stop: the stop's shell is the one being replaced.
      db.run(
        `update agent_shell_cleanup
           set retired_reason = case when retired_reason = 'relaunch' then retired_reason else ? end
         where session_id = ?`,
        [reason, sessionId],
      );
      sweepQuietly();
    },

    /** Sweep now, reporting (not throwing) a failure. For exit hooks. */
    sweepQuietly,

    /**
     * Run the sweep on a clock. Only a process that owns PTYs starts it; a
     * second start is a no-op.
     */
    start(onError: (error: unknown) => void): void {
      reportError = onError;
      if (timer) return;
      timer = setInterval(sweepQuietly, AGENT_SHELL_SWEEP_INTERVAL_MS);
      timer.unref?.();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },

    /** Archives every due shell; returns the archived session ids. */
    sweep(nowMs: number = Date.now()): string[] {
      const rows = db.all<CandidateRow>(
        `
          select
            c.session_id as sessionId,
            c.user_input_at as userInputAt,
            c.retired_reason as retiredReason,
            s.status as status,
            s.exit_code as exitCode,
            s.ended_at as endedAt,
            p.settled_at as parentSettledAt,
            p.archived_at as parentArchivedAt
          from agent_shell_cleanup c
          join terminal_sessions s on s.id = c.session_id
          left join terminal_sessions p on p.id = s.chat_session_id
          where s.archived_at is null
            and s.chat_session_id is not null
            and c.user_input_at is null
            and s.status not in ('running', 'detached')
        `,
      );
      const archived: string[] = [];
      for (const row of rows) {
        if (!agentShellArchiveDue(row, nowMs)) continue;
        if (archiveSession(row.sessionId)) archived.push(row.sessionId);
      }
      // The ledger only needs rows that may still be archived.
      db.run(
        `delete from agent_shell_cleanup
          where user_input_at is not null
             or session_id not in (select id from terminal_sessions where archived_at is null)`,
      );
      return archived;
    },
  };
  return cleanup;
}

export type AgentShellCleanup = ReturnType<typeof createAgentShellCleanup>;
