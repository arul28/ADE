import fs from "node:fs";
import type { AdeDb } from "../state/kvDb";
import type {
  TerminalSessionDetail,
  TerminalSessionStatus,
  TerminalSessionSummary,
  TerminalToolType,
  UpdateSessionMetaArgs
} from "../../../shared/types";
import { stripAnsi } from "../../utils/ansiStrip";

export function createSessionService({ db }: { db: AdeDb }) {
  const normalizeToolType = (raw: unknown): TerminalToolType | null => {
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!value) return null;
    const allowed: TerminalToolType[] = ["shell", "claude", "codex", "cursor", "aider", "continue", "other"];
    return (allowed as string[]).includes(value) ? (value as TerminalToolType) : "other";
  };

  const list = ({ laneId, status, limit }: { laneId?: string; status?: TerminalSessionStatus; limit?: number } = {}) => {
    const where: string[] = [];
    const params: (string | number | null)[] = [];

    if (laneId) {
      where.push("s.lane_id = ?");
      params.push(laneId);
    }
    if (status) {
      where.push("s.status = ?");
      params.push(status);
    }

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const limitSql = typeof limit === "number" ? "limit ?" : "limit 200";
    if (typeof limit === "number") params.push(limit);

    const rows = db.all<{
      id: string;
      laneId: string;
      laneName: string;
      ptyId: string | null;
      tracked: number;
      pinned: number;
      goal: string | null;
      toolType: string | null;
      title: string;
      status: TerminalSessionStatus;
      startedAt: string;
      endedAt: string | null;
      exitCode: number | null;
      transcriptPath: string;
      headShaStart: string | null;
      headShaEnd: string | null;
      lastOutputPreview: string | null;
      summary: string | null;
    }>(
      `
        select
          s.id as id,
          s.lane_id as laneId,
          l.name as laneName,
          s.pty_id as ptyId,
          s.tracked as tracked,
          s.pinned as pinned,
          s.goal as goal,
          s.tool_type as toolType,
          s.title as title,
          s.status as status,
          s.started_at as startedAt,
          s.ended_at as endedAt,
          s.exit_code as exitCode,
          s.transcript_path as transcriptPath,
          s.head_sha_start as headShaStart,
          s.head_sha_end as headShaEnd,
          s.last_output_preview as lastOutputPreview,
          s.summary as summary
        from terminal_sessions s
        join lanes l on l.id = s.lane_id
        ${whereSql}
        order by s.started_at desc
        ${limitSql}
      `,
      params
    );

    return rows.map((row) => ({
      ...row,
      tracked: row.tracked === 1,
      pinned: row.pinned === 1,
      goal: row.goal ?? null,
      toolType: normalizeToolType(row.toolType),
      summary: row.summary ?? null
    })) as TerminalSessionSummary[];
  };

  return {
    list,

    reconcileStaleRunningSessions({
      endedAt,
      status
    }: {
      endedAt?: string;
      status?: TerminalSessionStatus;
    } = {}): number {
      const row = db.get<{ count: number }>("select count(1) as count from terminal_sessions where status = 'running'");
      const count = Number(row?.count ?? 0);
      if (!Number.isFinite(count) || count <= 0) return 0;

      const finalEndedAt = endedAt ?? new Date().toISOString();
      const finalStatus = status ?? "disposed";
      db.run("update terminal_sessions set ended_at = ?, exit_code = ?, status = ?, pty_id = null where status = 'running'", [
        finalEndedAt,
        null,
        finalStatus
      ]);
      return count;
    },

    get(sessionId: string): TerminalSessionDetail | null {
      const row = db.get<TerminalSessionDetail & { laneName: string }>(
        `
          select
            s.id as id,
            s.lane_id as laneId,
            l.name as laneName,
            s.pty_id as ptyId,
            s.tracked as tracked,
            s.pinned as pinned,
            s.goal as goal,
            s.tool_type as toolType,
            s.title as title,
            s.status as status,
            s.started_at as startedAt,
            s.ended_at as endedAt,
            s.exit_code as exitCode,
            s.transcript_path as transcriptPath,
            s.head_sha_start as headShaStart,
            s.head_sha_end as headShaEnd,
            s.last_output_preview as lastOutputPreview,
            s.summary as summary
          from terminal_sessions s
          join lanes l on l.id = s.lane_id
          where s.id = ?
          limit 1
        `,
        [sessionId]
      );
      return row
        ? ({
            ...row,
            tracked: (row as any).tracked === 1,
            pinned: (row as any).pinned === 1,
            goal: (row as any).goal ?? null,
            toolType: normalizeToolType((row as any).toolType)
          } as TerminalSessionDetail)
        : null;
    },

    updateMeta(args: UpdateSessionMetaArgs): TerminalSessionSummary | null {
      const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return null;

      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (typeof args.pinned === "boolean") {
        sets.push("pinned = ?");
        params.push(args.pinned ? 1 : 0);
      }

      if (args.goal !== undefined) {
        sets.push("goal = ?");
        params.push(args.goal == null ? null : String(args.goal));
      }

      if (args.toolType !== undefined) {
        const normalized = normalizeToolType(args.toolType);
        sets.push("tool_type = ?");
        params.push(normalized);
      }

      if (sets.length) {
        params.push(sessionId);
        db.run(`update terminal_sessions set ${sets.join(", ")} where id = ?`, params);
      }

      return this.get(sessionId);
    },

    create({
      sessionId,
      laneId,
      ptyId,
      title,
      startedAt,
      transcriptPath,
      tracked,
    }: {
      sessionId: string;
      laneId: string;
      ptyId: string;
      tracked: boolean;
      title: string;
      startedAt: string;
      transcriptPath: string;
    }): void {
      db.run(
        `
          insert into terminal_sessions(
            id, lane_id, pty_id, tracked, title, started_at, ended_at, exit_code, transcript_path,
            head_sha_start, head_sha_end, status, last_output_preview, summary
          ) values (?, ?, ?, ?, ?, ?, null, null, ?, null, null, 'running', null, null)
        `,
        [sessionId, laneId, ptyId, tracked ? 1 : 0, title, startedAt, transcriptPath]
      );
    },

    setHeadShaStart(sessionId: string, sha: string): void {
      db.run("update terminal_sessions set head_sha_start = ? where id = ?", [sha, sessionId]);
    },

    setHeadShaEnd(sessionId: string, sha: string): void {
      db.run("update terminal_sessions set head_sha_end = ? where id = ?", [sha, sessionId]);
    },

    setLastOutputPreview(sessionId: string, preview: string): void {
      db.run("update terminal_sessions set last_output_preview = ? where id = ?", [preview, sessionId]);
    },

    setSummary(sessionId: string, summary: string | null): void {
      db.run("update terminal_sessions set summary = ? where id = ?", [summary, sessionId]);
    },

    end({
      sessionId,
      endedAt,
      exitCode,
      status
    }: {
      sessionId: string;
      endedAt: string;
      exitCode: number | null;
      status: TerminalSessionStatus;
    }): void {
      db.run("update terminal_sessions set ended_at = ?, exit_code = ?, status = ?, pty_id = null where id = ?", [
        endedAt,
        exitCode,
        status,
        sessionId
      ]);
    },

    readTranscriptTail(
      transcriptPath: string,
      maxBytes: number,
      options?: { raw?: boolean; alignToLineBoundary?: boolean }
    ): string {
      if (!transcriptPath) return "";
      try {
        const stat = fs.statSync(transcriptPath);
        const size = stat.size;
        const start = Math.max(0, size - maxBytes);
        const fd = fs.openSync(transcriptPath, "r");
        try {
          const out = Buffer.alloc(size - start);
          fs.readSync(fd, out, 0, out.length, start);
          const alignToLineBoundary = options?.alignToLineBoundary === true;
          let slice = out;
          if (alignToLineBoundary && start > 0 && out.length > 0) {
            // When reading a byte tail, we can start in the middle of a control sequence
            // or UTF-8 character. Aligning to the next newline avoids replay corruption.
            const nextNewline = out.indexOf(0x0a);
            if (nextNewline >= 0 && nextNewline + 1 < out.length) {
              slice = out.subarray(nextNewline + 1);
            }
          }
          const text = slice.toString("utf8");
          return options?.raw ? text : stripAnsi(text);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return "";
      }
    }
  };
}
