import fs from "node:fs";
import type { AdeDb } from "../state/kvDb";
import type { TerminalSessionDetail, TerminalSessionStatus, TerminalSessionSummary } from "../../../shared/types";

export function createSessionService({ db }: { db: AdeDb }) {
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
      title: string;
      status: TerminalSessionStatus;
      startedAt: string;
      endedAt: string | null;
      exitCode: number | null;
      transcriptPath: string;
      headShaStart: string | null;
      headShaEnd: string | null;
      lastOutputPreview: string | null;
    }>(
      `
        select
          s.id as id,
          s.lane_id as laneId,
          l.name as laneName,
          s.pty_id as ptyId,
          s.tracked as tracked,
          s.title as title,
          s.status as status,
          s.started_at as startedAt,
          s.ended_at as endedAt,
          s.exit_code as exitCode,
          s.transcript_path as transcriptPath,
          s.head_sha_start as headShaStart,
          s.head_sha_end as headShaEnd,
          s.last_output_preview as lastOutputPreview
        from terminal_sessions s
        join lanes l on l.id = s.lane_id
        ${whereSql}
        order by s.started_at desc
        ${limitSql}
      `,
      params
    );

    return rows.map((row) => ({ ...row, tracked: row.tracked === 1 })) as TerminalSessionSummary[];
  };

  return {
    list,

    get(sessionId: string): TerminalSessionDetail | null {
      const row = db.get<TerminalSessionDetail & { laneName: string }>(
        `
          select
            s.id as id,
            s.lane_id as laneId,
            l.name as laneName,
            s.pty_id as ptyId,
            s.tracked as tracked,
            s.title as title,
            s.status as status,
            s.started_at as startedAt,
            s.ended_at as endedAt,
            s.exit_code as exitCode,
            s.transcript_path as transcriptPath,
            s.head_sha_start as headShaStart,
            s.head_sha_end as headShaEnd,
            s.last_output_preview as lastOutputPreview
          from terminal_sessions s
          join lanes l on l.id = s.lane_id
          where s.id = ?
          limit 1
        `,
        [sessionId]
      );
      return row ? ({ ...row, tracked: (row as any).tracked === 1 } as TerminalSessionDetail) : null;
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
            head_sha_start, head_sha_end, status, last_output_preview
          ) values (?, ?, ?, ?, ?, ?, null, null, ?, null, null, 'running', null)
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

    readTranscriptTail(transcriptPath: string, maxBytes: number): string {
      if (!transcriptPath) return "";
      try {
        const stat = fs.statSync(transcriptPath);
        const size = stat.size;
        const start = Math.max(0, size - maxBytes);
        const fd = fs.openSync(transcriptPath, "r");
        try {
          const buf = Buffer.alloc(size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          return buf.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return "";
      }
    }
  };
}
