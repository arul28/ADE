import fs from "node:fs";
import type { AdeDb } from "../state/kvDb";
import type {
  TerminalSessionDetail,
  TerminalRuntimeState,
  TerminalSessionStatus,
  TerminalSessionSummary,
  TerminalToolType,
  UpdateSessionMetaArgs
} from "../../../shared/types";
import { stripAnsi } from "../../utils/ansiStrip";
import { defaultResumeCommandForTool, normalizeResumeCommand } from "../../utils/terminalSessionSignals";

type SessionRow = {
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
  resumeCommand: string | null;
};

const SESSION_COLUMNS = `
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
  s.summary as summary,
  s.resume_command as resumeCommand
`;

export function createSessionService({ db }: { db: AdeDb }) {
  const runtimeStateFromStatus = (status: TerminalSessionStatus): TerminalRuntimeState => {
    if (status === "running") return "running";
    if (status === "disposed") return "killed";
    return "exited";
  };

  const normalizeToolType = (raw: unknown): TerminalToolType | null => {
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!value) return null;
    const allowed: TerminalToolType[] = [
      "shell",
      "run-shell",
      "claude",
      "codex",
      "claude-orchestrated",
      "codex-orchestrated",
      "ai-orchestrated",
      "codex-chat",
      "claude-chat",
      "ai-chat",
      "cursor",
      "aider",
      "continue",
      "other"
    ];
    return (allowed as string[]).includes(value) ? (value as TerminalToolType) : "other";
  };

  const mapRow = (row: SessionRow) => {
    const toolType = normalizeToolType(row.toolType);
    return {
      ...row,
      tracked: row.tracked === 1,
      pinned: row.pinned === 1,
      goal: row.goal ?? null,
      toolType,
      summary: row.summary ?? null,
      runtimeState: runtimeStateFromStatus(row.status),
      resumeCommand: normalizeResumeCommand(row.resumeCommand, toolType),
    };
  };

  const list =({ laneId, status, limit }: { laneId?: string; status?: TerminalSessionStatus; limit?: number } = {}) => {
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

    const rows = db.all<SessionRow>(
      `
        select ${SESSION_COLUMNS}
        from terminal_sessions s
        join lanes l on l.id = s.lane_id
        ${whereSql}
        order by s.started_at desc
        ${limitSql}
      `,
      params
    );

    return rows.map(mapRow) as TerminalSessionSummary[];
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
      const row = db.get<SessionRow>(
        `
          select ${SESSION_COLUMNS}
          from terminal_sessions s
          join lanes l on l.id = s.lane_id
          where s.id = ?
          limit 1
        `,
        [sessionId]
      );
      if (!row) return null;
      return mapRow(row) as TerminalSessionDetail;
    },

    updateMeta(args: UpdateSessionMetaArgs): TerminalSessionSummary | null {
      const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return null;
      const currentSession = this.get(sessionId);

      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (typeof args.pinned === "boolean") {
        sets.push("pinned = ?");
        params.push(args.pinned ? 1 : 0);
      }

      if (args.title !== undefined) {
        const nextTitle = typeof args.title === "string" ? args.title.trim() : "";
        if (nextTitle.length) {
          sets.push("title = ?");
          params.push(nextTitle);
        }
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

      if (args.resumeCommand !== undefined) {
        const preferredToolType = args.toolType !== undefined
          ? normalizeToolType(args.toolType)
          : currentSession?.toolType ?? null;
        const next = normalizeResumeCommand(
          args.resumeCommand,
          preferredToolType,
        );
        sets.push("resume_command = ?");
        params.push(next);
      }

      if (sets.length) {
        params.push(sessionId);
        db.run(`update terminal_sessions set ${sets.join(", ")} where id = ?`, params);
      }

      const updated = this.get(sessionId);
      if (!updated) return null;
      if (args.resumeCommand !== undefined) return updated;

      if (args.toolType !== undefined && !updated.resumeCommand) {
        const fallback = defaultResumeCommandForTool(updated.toolType);
        if (fallback) {
          db.run("update terminal_sessions set resume_command = ? where id = ? and resume_command is null", [fallback, sessionId]);
          const withResume = this.get(sessionId);
          return withResume ?? updated;
        }
      }
      return updated;
    },

    create({
      sessionId,
      laneId,
      ptyId,
      title,
      startedAt,
      transcriptPath,
      tracked,
      toolType,
      resumeCommand
    }: {
      sessionId: string;
      laneId: string;
      ptyId: string | null;
      tracked: boolean;
      title: string;
      startedAt: string;
      transcriptPath: string;
      toolType?: TerminalToolType | null;
      resumeCommand?: string | null;
    }): void {
      const normalizedToolType = normalizeToolType(toolType);
      const normalizedResumeCommand = normalizeResumeCommand(
        resumeCommand,
        normalizedToolType,
      ) ?? defaultResumeCommandForTool(normalizedToolType);
      db.run(
        `
          insert into terminal_sessions(
            id, lane_id, pty_id, tracked, title, started_at, ended_at, exit_code, transcript_path,
            head_sha_start, head_sha_end, status, last_output_preview, last_output_at, summary, tool_type, resume_command
          ) values (?, ?, ?, ?, ?, ?, null, null, ?, null, null, 'running', null, null, null, ?, ?)
        `,
        [
          sessionId,
          laneId,
          ptyId ?? null,
          tracked ? 1 : 0,
          title,
          startedAt,
          transcriptPath,
          normalizedToolType,
          normalizedResumeCommand ?? null
        ]
      );
    },

    reopen(sessionId: string): void {
      db.run(
        `
          update terminal_sessions
          set status = 'running',
              ended_at = null,
              exit_code = null
          where id = ?
        `,
        [sessionId]
      );
    },

    setHeadShaStart(sessionId: string, sha: string): void {
      db.run("update terminal_sessions set head_sha_start = ? where id = ?", [sha, sessionId]);
    },

    setHeadShaEnd(sessionId: string, sha: string): void {
      db.run("update terminal_sessions set head_sha_end = ? where id = ?", [sha, sessionId]);
    },

    setLastOutputPreview(sessionId: string, preview: string): void {
      db.run(
        "update terminal_sessions set last_output_preview = ?, last_output_at = ? where id = ?",
        [preview, new Date().toISOString(), sessionId]
      );
    },

    setSummary(sessionId: string, summary: string | null): void {
      db.run("update terminal_sessions set summary = ? where id = ?", [summary, sessionId]);
    },

    setResumeCommand(sessionId: string, resumeCommand: string | null): void {
      const currentSession = this.get(sessionId);
      const next = normalizeResumeCommand(resumeCommand, currentSession?.toolType ?? null);
      db.run("update terminal_sessions set resume_command = ? where id = ?", [next, sessionId]);
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

    async readTranscriptTail(
      transcriptPath: string,
      maxBytes: number,
      options?: { raw?: boolean; alignToLineBoundary?: boolean }
    ): Promise<string> {
      if (!transcriptPath) return "";
      let fh: fs.promises.FileHandle | null = null;
      try {
        fh = await fs.promises.open(transcriptPath, "r");
        const stat = await fh.stat();
        const size = stat.size;
        const start = Math.max(0, size - maxBytes);
        const out = Buffer.alloc(size - start);
        await fh.read(out, 0, out.length, start);
        const alignToLineBoundary = options?.alignToLineBoundary === true;
        let slice = out;
        if (alignToLineBoundary && start > 0 && out.length > 0) {
          const nextNewline = out.indexOf(0x0a);
          if (nextNewline >= 0 && nextNewline + 1 < out.length) {
            slice = out.subarray(nextNewline + 1);
          }
        }
        const text = slice.toString("utf8");
        return options?.raw ? text : stripAnsi(text);
      } catch {
        return "";
      } finally {
        await fh?.close().catch(() => {});
      }
    }
  };
}
