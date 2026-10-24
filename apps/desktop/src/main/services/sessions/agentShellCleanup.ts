import type { AdeDb } from "../state/kvDb";

/**
 * Deletes the dead shells App Control started, so neither the Work
 * sidebar nor the session list fills with "App Control: npm run dev…  Ended"
 * rows. The row and its transcript go: archiving only hid them, and hidden rows
 * still filled every `session.list` page (another machine reads only the newest
 * 60, so a pile of dead shells pushed real chats out of its Work list).
 *
 * App Control relaunches a chat's app in the same shell row (see
 * `markAgentRelaunched` and `hold`), so a normal edit/relaunch loop leaves one
 * row, not one per launch.
 *
 * A shell is eligible only when ALL of these hold:
 *   - App Control started it (`markAgentLaunched`), never a plain user shell;
 *   - it has ended (completed / failed / disposed — not `running`, not `detached`);
 *   - nobody typed into it (`markUserInput`) — a shell the user touched is theirs.
 *
 * When it goes:
 *   - replaced by an App Control launch in a new shell → at once;
 *   - exit 0, or stopped by ADE itself → `AGENT_SHELL_DELETE_GRACE_MS` after it ended;
 *   - any other end (a crash, a non-zero exit) → only once its chat settles, so
 *     the failure stays in view while someone may still need it. A shell with
 *     no chat (a launch from a terminal, or from an agent whose shell carries no
 *     chat id) has nothing to settle, so its failure stays until a relaunch
 *     reuses the shell.
 *
 * A shell that is archived (with its lane, or by hand) is left alone: archive
 * is reversible and the user can still restore it.
 *
 * The ledger table is machine-local (not a CRR): it records what this machine's
 * own processes started and saw typed, which no other machine can know.
 */

const AGENT_SHELL_DELETE_GRACE_MS = 10 * 60_000;
/** How often ended agent shells are checked: grace periods and settles come due on their own. */
const AGENT_SHELL_SWEEP_INTERVAL_MS = 60_000;

export type AgentShellRetireReason = "relaunch" | "stop";

/** The lane and chat (null when chatless) a relaunch must share with the shell it reuses. */
export type AgentShellRelaunchScope = { laneId: string; chatSessionId: string | null };

/**
 * An ended agent shell that is still listed and nobody typed into: the rows the
 * sweep may delete and a relaunch may reuse. `s` is `terminal_sessions`, `c` the
 * ledger.
 */
const ENDED_UNTOUCHED_AGENT_SHELL = `s.archived_at is null
            and c.user_input_at is null
            and s.status not in ('running', 'detached')`;

type CandidateRow = {
  sessionId: string;
  transcriptPath: string | null;
  /** The shell's owner chat id. Still set after that chat is deleted. */
  chatSessionId: string | null;
  /**
   * The owner row's id, null when the chat it names no longer exists.
   * `chat_session_id` carries no foreign key, so deleting a chat leaves this
   * id dangling rather than clearing it.
   */
  parentId: string | null;
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

function agentShellDeleteDue(row: CandidateRow, nowMs: number): boolean {
  if (row.userInputAt) return false;
  if (row.status === "running" || row.status === "detached") return false;
  if (row.retiredReason === "relaunch") return true;
  // A missing owner counts as quiet, and it is the shape deletion actually
  // leaves: `terminal_sessions.chat_session_id` has no foreign key, so the id
  // stays and the parent row disappears. Nothing will ever settle that shell
  // again, and a dead App Control shell whose chat was deleted is exactly the
  // row this sweeper exists to remove.
  const parentQuiet = Boolean(row.chatSessionId)
    && (!row.parentId || Boolean(row.parentSettledAt || row.parentArchivedAt));
  const cleanEnd = row.retiredReason === "stop" || (row.status === "completed" && row.exitCode === 0);
  if (!cleanEnd) return parentQuiet;
  const endedMs = row.endedAt ? Date.parse(row.endedAt) : Number.NaN;
  if (!Number.isFinite(endedMs)) return parentQuiet;
  return nowMs - endedMs >= AGENT_SHELL_DELETE_GRACE_MS;
}

export function createAgentShellCleanup({
  db,
  deleteSession,
}: {
  db: AdeDb;
  /** Removes the row; false when there was no row. */
  deleteSession: (sessionId: string) => boolean;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let reportError: (error: unknown) => void = () => {};
  // The transcript files belong to the process that writes them (`start`).
  let removeTranscript: (transcriptPath: string, sessionId: string) => void = () => {};
  /**
   * Shells a relaunch is about to run again. A sweep must not delete one
   * between the relaunch's check and its new process taking the row.
   */
  const held = new Map<string, number>();

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
      // A new row: any ledger entry under the same id (a row recreated under a
      // requested id) describes an earlier shell and is reset.
      db.run(
        `insert into agent_shell_cleanup (session_id, launched_at) values (?, ?)
           on conflict(session_id) do update
             set launched_at = excluded.launched_at, user_input_at = null, retired_reason = null`,
        [sessionId, new Date().toISOString()],
      );
    },

    /**
     * App Control is running a new process in this ended shell: it is tracked
     * again and its earlier retirement no longer applies. Who typed into it is
     * kept, so a shell the user claimed stays theirs.
     */
    markAgentRelaunched(sessionId: string): void {
      if (!sessionId) return;
      db.run(
        `insert into agent_shell_cleanup (session_id, launched_at) values (?, ?)
           on conflict(session_id) do update set launched_at = excluded.launched_at, retired_reason = null`,
        [sessionId, new Date().toISOString()],
      );
    },

    /**
     * Whether App Control may run its next launch in this shell: an ended agent
     * shell of the same lane and chat (or, both chatless, of no chat) that
     * nobody typed into, still listed.
     */
    canRelaunchIn(sessionId: string, scope: AgentShellRelaunchScope): boolean {
      if (!sessionId || !scope.laneId) return false;
      const row = db.get<{ present: number }>(
        `
          select 1 as present
          from agent_shell_cleanup c
          join terminal_sessions s on s.id = c.session_id
          where c.session_id = ?
            and s.lane_id = ?
            and s.chat_session_id is ?
            and s.tracked = 1
            and ${ENDED_UNTOUCHED_AGENT_SHELL}
          limit 1
        `,
        [sessionId, scope.laneId, scope.chatSessionId || null],
      );
      return Boolean(row);
    },

    /** Keep a sweep off this shell until the returned release runs. */
    hold(sessionId: string): () => void {
      if (!sessionId) return () => {};
      held.set(sessionId, (held.get(sessionId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (held.get(sessionId) ?? 1) - 1;
        if (count > 0) held.set(sessionId, count);
        else held.delete(sessionId);
      };
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
     * ADE itself ended (or is about to end) the shell: App Control stopped its
     * app, or replaced it with a launch in a new shell. A replaced shell is
     * deleted as soon as it is dead; a stop counts as a clean end and waits out
     * the grace period.
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
     * Run the sweep on a clock. Only a process that owns PTYs starts it, and it
     * removes a deleted shell's transcript files. A second start is a no-op.
     */
    start(options: {
      onError: (error: unknown) => void;
      removeTranscript?: (transcriptPath: string, sessionId: string) => void;
    }): void {
      reportError = options.onError;
      if (options.removeTranscript) removeTranscript = options.removeTranscript;
      if (timer) return;
      timer = setInterval(sweepQuietly, AGENT_SHELL_SWEEP_INTERVAL_MS);
      timer.unref?.();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },

    /** Deletes every due shell; returns the deleted session ids. */
    sweep(nowMs: number = Date.now()): string[] {
      const rows = db.all<CandidateRow>(
        `
          select
            c.session_id as sessionId,
            s.transcript_path as transcriptPath,
            s.chat_session_id as chatSessionId,
            p.id as parentId,
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
          where ${ENDED_UNTOUCHED_AGENT_SHELL}
        `,
      );
      const deleted: string[] = [];
      for (const row of rows) {
        if (held.has(row.sessionId)) continue;
        if (!agentShellDeleteDue(row, nowMs)) continue;
        if (!deleteSession(row.sessionId)) continue;
        deleted.push(row.sessionId);
        // A dead shell's log is noise once its row is gone; leaving it would
        // only move the pile from the session list onto the disk.
        const transcriptPath = row.transcriptPath?.trim();
        if (transcriptPath) removeTranscript(transcriptPath, row.sessionId);
      }
      // The ledger only needs rows that may still be deleted.
      db.run(
        `delete from agent_shell_cleanup
          where user_input_at is not null
             or session_id not in (select id from terminal_sessions where archived_at is null)`,
      );
      return deleted;
    },
  };
  return cleanup;
}

export type AgentShellCleanup = ReturnType<typeof createAgentShellCleanup>;
