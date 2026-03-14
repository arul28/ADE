import type { createLaneService } from "../lanes/laneService";
import {
  type LaneSessionRow,
  type SessionDeltaRow,
  parseChatTranscriptDelta,
  parseNumStat,
  parsePorcelainPaths,
  rowToSessionDelta,
} from "../packs/packUtils";
import type { createSessionService } from "./sessionService";
import { runGit } from "../git/git";
import type { AdeDb } from "../state/kvDb";
import { stripAnsi } from "../../utils/ansiStrip";
import type { SessionDeltaSummary } from "../../../shared/types";

export function createSessionDeltaService(args: {
  db: AdeDb;
  projectId: string;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
}) {
  const { db, projectId, laneService, sessionService } = args;

  const getSessionRow = (sessionId: string): LaneSessionRow | null =>
    db.get<LaneSessionRow>(
      `
        select
          id,
          lane_id,
          tracked,
          started_at,
          ended_at,
          head_sha_start,
          head_sha_end,
          transcript_path
        from terminal_sessions
        where id = ?
        limit 1
      `,
      [sessionId]
    );

  const getSessionDeltaRow = (sessionId: string): SessionDeltaRow | null =>
    db.get<SessionDeltaRow>(
      `
        select
          session_id,
          lane_id,
          started_at,
          ended_at,
          head_sha_start,
          head_sha_end,
          files_changed,
          insertions,
          deletions,
          touched_files_json,
          failure_lines_json,
          computed_at
        from session_deltas
        where session_id = ?
        limit 1
      `,
      [sessionId]
    );

  const listRecentLaneSessionDeltas = (laneId: string, limit: number): SessionDeltaSummary[] => {
    const rows = db.all<SessionDeltaRow>(
      `
        select
          d.session_id,
          d.lane_id,
          d.started_at,
          d.ended_at,
          d.head_sha_start,
          d.head_sha_end,
          d.files_changed,
          d.insertions,
          d.deletions,
          d.touched_files_json,
          d.failure_lines_json,
          d.computed_at
        from session_deltas d
        where d.lane_id = ?
        order by d.started_at desc
        limit ?
      `,
      [laneId, limit]
    );
    return rows.map(rowToSessionDelta);
  };

  const getSessionDelta = (sessionId: string): SessionDeltaSummary | null => {
    const row = getSessionDeltaRow(sessionId);
    return row ? rowToSessionDelta(row) : null;
  };

  const computeSessionDelta = async (sessionId: string): Promise<SessionDeltaSummary | null> => {
    const session = getSessionRow(sessionId);
    if (!session || session.tracked !== 1) return null;

    const lane = laneService.getLaneBaseAndBranch(session.lane_id);
    const diffRef = session.head_sha_start?.trim() || "HEAD";

    const numStatRes = await runGit(["diff", "--numstat", diffRef], { cwd: lane.worktreePath, timeoutMs: 20_000 });
    const nameRes = await runGit(["diff", "--name-only", diffRef], { cwd: lane.worktreePath, timeoutMs: 20_000 });
    const statusRes = await runGit(["status", "--porcelain=v1"], { cwd: lane.worktreePath, timeoutMs: 8_000 });

    const parsedStat = parseNumStat(numStatRes.stdout);
    const touched = new Set<string>([...parsedStat.files]);

    if (nameRes.exitCode === 0) {
      for (const line of nameRes.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
        touched.add(line);
      }
    }

    if (statusRes.exitCode === 0) {
      for (const rel of parsePorcelainPaths(statusRes.stdout)) {
        touched.add(rel);
      }
    }

    const isChatTranscript = session.transcript_path.endsWith(".chat.jsonl");
    const transcript = await sessionService.readTranscriptTail(
      session.transcript_path,
      220_000,
      isChatTranscript ? { raw: true, alignToLineBoundary: true } : undefined
    );
    const failureLines = (() => {
      const out: string[] = [];
      const seen = new Set<string>();
      const push = (value: string | null | undefined) => {
        const normalized = stripAnsi(String(value ?? "")).replace(/\s+/g, " ").trim();
        if (!normalized.length || seen.has(normalized)) return;
        seen.add(normalized);
        out.push(normalized);
      };

      for (const rawLine of transcript.split("\n")) {
        const line = stripAnsi(rawLine).trim();
        if (!line) continue;
        if (!/\b(error|failed|exception|fatal|traceback)\b/i.test(line)) continue;
        push(line);
      }

      if (isChatTranscript) {
        const chatDelta = parseChatTranscriptDelta(transcript);
        for (const touchedPath of chatDelta.touchedFiles) {
          touched.add(touchedPath);
        }
        for (const line of chatDelta.failureLines) {
          push(line);
        }
      }

      return out.slice(-8);
    })();

    const touchedFiles = [...touched].sort();
    const computedAt = new Date().toISOString();

    db.run(
      `
        insert into session_deltas(
          session_id,
          project_id,
          lane_id,
          started_at,
          ended_at,
          head_sha_start,
          head_sha_end,
          files_changed,
          insertions,
          deletions,
          touched_files_json,
          failure_lines_json,
          computed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(session_id) do update set
          project_id = excluded.project_id,
          lane_id = excluded.lane_id,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          head_sha_start = excluded.head_sha_start,
          head_sha_end = excluded.head_sha_end,
          files_changed = excluded.files_changed,
          insertions = excluded.insertions,
          deletions = excluded.deletions,
          touched_files_json = excluded.touched_files_json,
          failure_lines_json = excluded.failure_lines_json,
          computed_at = excluded.computed_at
      `,
      [
        session.id,
        projectId,
        session.lane_id,
        session.started_at,
        session.ended_at,
        session.head_sha_start,
        session.head_sha_end,
        touchedFiles.length,
        parsedStat.insertions,
        parsedStat.deletions,
        JSON.stringify(touchedFiles),
        JSON.stringify(failureLines),
        computedAt,
      ]
    );

    return {
      sessionId: session.id,
      laneId: session.lane_id,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      headShaStart: session.head_sha_start,
      headShaEnd: session.head_sha_end,
      filesChanged: touchedFiles.length,
      insertions: parsedStat.insertions,
      deletions: parsedStat.deletions,
      touchedFiles,
      failureLines,
      computedAt,
    };
  };

  return {
    getSessionDelta,
    computeSessionDelta,
    listRecentLaneSessionDeltas,
  };
}

export type SessionDeltaService = ReturnType<typeof createSessionDeltaService>;
