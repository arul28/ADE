import type { createLaneService } from "../lanes/laneService";
import {
  type LaneSessionRow,
  type SessionDeltaRow,
  parseChatTranscriptDelta,
  parseNumStat,
  parsePorcelainPaths,
  rowToSessionDelta,
} from "../shared/packLegacyUtils";
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

  type BackfillSessionRow = LaneSessionRow & { status: string | null };

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

    const startSha = session.head_sha_start?.trim() ?? "";
    const endSha = session.head_sha_end?.trim() ?? "";
    if (session.ended_at && !endSha) return null;

    const lane = laneService.getLaneBaseAndBranch(session.lane_id);
    const hasCompletedRange = Boolean(startSha && endSha);
    const completedWithoutCommitDelta = Boolean(session.ended_at && hasCompletedRange && startSha === endSha);
    const useCommitRange = hasCompletedRange && startSha !== endSha;
    const diffArgs = completedWithoutCommitDelta ? null : useCommitRange ? [startSha, endSha] : [startSha || "HEAD"];

    const numStatRes = diffArgs
      ? await runGit(["diff", "--numstat", ...diffArgs], { cwd: lane.worktreePath, timeoutMs: 20_000 })
      : { stdout: "", exitCode: 0 };
    const nameRes = diffArgs
      ? await runGit(["diff", "--name-only", ...diffArgs], { cwd: lane.worktreePath, timeoutMs: 20_000 })
      : { stdout: "", exitCode: 0 };

    const parsedStat = parseNumStat(numStatRes.stdout);
    const touched = new Set<string>([...parsedStat.files]);

    if (nameRes.exitCode === 0) {
      for (const line of nameRes.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
        touched.add(line);
      }
    }

    if (!useCommitRange && !completedWithoutCommitDelta) {
      const statusRes = await runGit(["status", "--porcelain=v1"], { cwd: lane.worktreePath, timeoutMs: 8_000 });
      if (statusRes.exitCode === 0) {
        for (const rel of parsePorcelainPaths(statusRes.stdout)) {
          touched.add(rel);
        }
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

  const backfillMissingSessionDeltas = async (options: {
    limit?: number;
    since?: string | null;
  } = {}): Promise<{
    scanned: number;
    computed: number;
    skipped: number;
    failed: number;
  }> => {
    const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 500)));
    const where = [
      "s.tracked = 1",
      "s.ended_at is not null",
      "s.head_sha_end is not null",
      "s.head_sha_end != ''",
      "d.session_id is null",
    ];
    const params: Array<string | number> = [];
    if (options.since?.trim()) {
      where.push("s.started_at >= ?");
      params.push(options.since.trim());
    }
    params.push(limit);
    const rows = db.all<BackfillSessionRow>(
      `
        select
          s.id,
          s.lane_id,
          s.tracked,
          s.started_at,
          s.ended_at,
          s.head_sha_start,
          s.head_sha_end,
          s.transcript_path,
          s.status
        from terminal_sessions s
        left join session_deltas d on d.session_id = s.id
        join lanes l on l.id = s.lane_id
        where ${where.join(" and ")}
          and l.project_id = ?
        order by s.started_at desc
        limit ?
      `,
      [...params.slice(0, -1), projectId, params[params.length - 1]],
    );

    let computed = 0;
    let skipped = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const delta = await computeSessionDelta(row.id);
        if (delta) computed += 1;
        else skipped += 1;
      } catch {
        failed += 1;
      }
    }
    return {
      scanned: rows.length,
      computed,
      skipped,
      failed,
    };
  };

  return {
    getSessionDelta,
    computeSessionDelta,
    backfillMissingSessionDeltas,
    listRecentLaneSessionDeltas,
  };
}

export type SessionDeltaService = ReturnType<typeof createSessionDeltaService>;
