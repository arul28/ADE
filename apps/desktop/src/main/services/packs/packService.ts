import fs from "node:fs";
import path from "node:path";
import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createOperationService } from "../history/operationService";
import type { PackSummary, SessionDeltaSummary, TestRunStatus } from "../../../shared/types";

type LaneSessionRow = {
  id: string;
  lane_id: string;
  started_at: string;
  ended_at: string | null;
  head_sha_start: string | null;
  head_sha_end: string | null;
  transcript_path: string;
};

type SessionDeltaRow = {
  session_id: string;
  lane_id: string;
  started_at: string;
  ended_at: string | null;
  head_sha_start: string | null;
  head_sha_end: string | null;
  files_changed: number;
  insertions: number;
  deletions: number;
  touched_files_json: string;
  failure_lines_json: string;
  computed_at: string;
};

type ParsedNumStat = {
  insertions: number;
  deletions: number;
  files: Set<string>;
};

const USER_INTENT_START = "<!-- ADE_INTENT_START -->";
const USER_INTENT_END = "<!-- ADE_INTENT_END -->";
const USER_TODOS_START = "<!-- ADE_TODOS_START -->";
const USER_TODOS_END = "<!-- ADE_TODOS_END -->";

function safeJsonParseArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => String(entry));
  } catch {
    return [];
  }
}

function readFileIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function ensureDirFor(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function upsertPackIndex({
  db,
  projectId,
  packKey,
  laneId,
  packType,
  packPath,
  deterministicUpdatedAt,
  narrativeUpdatedAt,
  lastHeadSha,
  metadata
}: {
  db: AdeDb;
  projectId: string;
  packKey: string;
  laneId: string | null;
  packType: "project" | "lane";
  packPath: string;
  deterministicUpdatedAt: string;
  narrativeUpdatedAt?: string | null;
  lastHeadSha?: string | null;
  metadata?: Record<string, unknown>;
}) {
  db.run(
    `
      insert into packs_index(
        pack_key,
        project_id,
        lane_id,
        pack_type,
        pack_path,
        deterministic_updated_at,
        narrative_updated_at,
        last_head_sha,
        metadata_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(pack_key) do update set
        project_id = excluded.project_id,
        lane_id = excluded.lane_id,
        pack_type = excluded.pack_type,
        pack_path = excluded.pack_path,
        deterministic_updated_at = excluded.deterministic_updated_at,
        narrative_updated_at = excluded.narrative_updated_at,
        last_head_sha = excluded.last_head_sha,
        metadata_json = excluded.metadata_json
    `,
    [
      packKey,
      projectId,
      laneId,
      packType,
      packPath,
      deterministicUpdatedAt,
      narrativeUpdatedAt ?? null,
      lastHeadSha ?? null,
      JSON.stringify(metadata ?? {})
    ]
  );
}

function toPackSummaryFromRow(row: {
  pack_type: "project" | "lane";
  pack_path: string;
  deterministic_updated_at: string | null;
  narrative_updated_at: string | null;
  last_head_sha: string | null;
} | null): PackSummary {
  const packType = row?.pack_type ?? "project";
  const packPath = row?.pack_path ?? "";
  const body = packPath ? readFileIfExists(packPath) : "";
  const exists = packPath.length ? fs.existsSync(packPath) : false;

  return {
    packType,
    path: packPath,
    exists,
    deterministicUpdatedAt: row?.deterministic_updated_at ?? null,
    narrativeUpdatedAt: row?.narrative_updated_at ?? null,
    lastHeadSha: row?.last_head_sha ?? null,
    body
  };
}

function parseNumStat(stdout: string): ParsedNumStat {
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;

  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ins = parts[0] ?? "0";
    const del = parts[1] ?? "0";
    const filePath = parts.slice(2).join("\t").trim();
    if (filePath.length) files.add(filePath);

    const insNum = ins === "-" ? 0 : Number(ins);
    const delNum = del === "-" ? 0 : Number(del);
    if (Number.isFinite(insNum)) insertions += insNum;
    if (Number.isFinite(delNum)) deletions += delNum;
  }

  return { insertions, deletions, files };
}

function parsePorcelainPaths(stdout: string): string[] {
  const out = new Set<string>();
  const lines = stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("??")) {
      const rel = line.slice(2).trim();
      if (rel.length) out.add(rel);
      continue;
    }

    const raw = line.slice(2).trim();
    const arrow = raw.indexOf("->");
    if (arrow >= 0) {
      const rel = raw.slice(arrow + 2).trim();
      if (rel.length) out.add(rel);
      continue;
    }
    if (raw.length) out.add(raw);
  }
  return [...out];
}

function extractSection(existing: string, start: string, end: string, fallback: string): string {
  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return fallback;
  const body = existing.slice(startIdx + start.length, endIdx).trim();
  return body.length ? body : fallback;
}

function statusFromCode(status: TestRunStatus): string {
  if (status === "passed") return "PASS";
  if (status === "failed") return "FAIL";
  if (status === "running") return "RUNNING";
  if (status === "canceled") return "CANCELED";
  return "TIMED_OUT";
}

function moduleFromPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const first = normalized.split("/")[0] ?? normalized;
  return first || ".";
}

export function createPackService({
  db,
  logger,
  projectRoot,
  projectId,
  packsDir,
  laneService,
  sessionService,
  projectConfigService,
  operationService
}: {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  projectId: string;
  packsDir: string;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  operationService: ReturnType<typeof createOperationService>;
}) {
  const projectPackPath = path.join(packsDir, "project_pack.md");

  const getLanePackPath = (laneId: string) => path.join(packsDir, "lanes", laneId, "lane_pack.md");

  const getSessionRow = (sessionId: string): LaneSessionRow | null =>
    db.get<LaneSessionRow>(
      `
        select
          id,
          lane_id,
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

  const rowToSessionDelta = (row: SessionDeltaRow): SessionDeltaSummary => ({
    sessionId: row.session_id,
    laneId: row.lane_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    headShaStart: row.head_sha_start,
    headShaEnd: row.head_sha_end,
    filesChanged: Number(row.files_changed ?? 0),
    insertions: Number(row.insertions ?? 0),
    deletions: Number(row.deletions ?? 0),
    touchedFiles: safeJsonParseArray(row.touched_files_json),
    failureLines: safeJsonParseArray(row.failure_lines_json),
    computedAt: row.computed_at ?? null
  });

  const getHeadSha = async (worktreePath: string): Promise<string | null> => {
    const res = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 });
    if (res.exitCode !== 0) return null;
    const sha = res.stdout.trim();
    return sha.length ? sha : null;
  };

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

  const buildLanePackBody = async ({
    laneId,
    reason,
    latestDelta,
    deterministicUpdatedAt
  }: {
    laneId: string;
    reason: string;
    latestDelta: SessionDeltaSummary | null;
    deterministicUpdatedAt: string;
  }): Promise<{ body: string; lastHeadSha: string | null }> => {
    const lanes = await laneService.list({ includeArchived: true });
    const lane = lanes.find((candidate) => candidate.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);

    const existingBody = readFileIfExists(getLanePackPath(laneId));
    const userIntent = extractSection(existingBody, USER_INTENT_START, USER_INTENT_END, "Describe lane intent and acceptance criteria here.");
    const userTodos = extractSection(existingBody, USER_TODOS_START, USER_TODOS_END, "- [ ] Add actionable todos for this lane\n- [ ] Note open risks before PR");

    const recentDeltas = listRecentLaneSessionDeltas(laneId, 4);
    const latestTouchedFiles = latestDelta?.touchedFiles ?? [];
    const touchedModules = [...new Set(latestTouchedFiles.map(moduleFromPath))].slice(0, 10);

    const testRows = db.all<{
      id: string;
      suite_key: string;
      status: TestRunStatus;
      duration_ms: number | null;
      ended_at: string | null;
    }>(
      `
        select id, suite_key, status, duration_ms, ended_at
        from test_runs
        where project_id = ?
        order by started_at desc
        limit 5
      `,
      [projectId]
    );

    const runtimeRows = db.all<{ process_key: string; status: string; readiness: string }>(
      `
        select process_key, status, readiness
        from process_runtime
        where project_id = ?
      `,
      [projectId]
    );

    const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
    const headSha = await getHeadSha(worktreePath);

    const lines: string[] = [];
    lines.push(`# Lane Pack: ${lane.name}`);
    lines.push("");
    lines.push(`- Deterministic updated: ${deterministicUpdatedAt}`);
    lines.push(`- Trigger: ${reason}`);
    lines.push(`- Lane ID: ${lane.id}`);
    lines.push(`- Branch: ${lane.branchRef}`);
    lines.push(`- Base: ${lane.baseRef}`);
    lines.push(`- HEAD: ${headSha ?? "unknown"}`);
    lines.push(`- Status: ${lane.status.dirty ? "dirty" : "clean"}; ahead ${lane.status.ahead}; behind ${lane.status.behind}`);
    lines.push("");
    lines.push("## Intent");
    lines.push(USER_INTENT_START);
    lines.push(userIntent);
    lines.push(USER_INTENT_END);
    lines.push("");

    lines.push("## Latest Session Delta");
    if (latestDelta) {
      lines.push(`- Session: ${latestDelta.sessionId}`);
      lines.push(`- Time: ${latestDelta.startedAt} -> ${latestDelta.endedAt ?? "running"}`);
      lines.push(`- SHAs: ${latestDelta.headShaStart ?? "?"} -> ${latestDelta.headShaEnd ?? "?"}`);
      lines.push(`- Files changed: ${latestDelta.filesChanged}`);
      lines.push(`- Line delta: +${latestDelta.insertions} / -${latestDelta.deletions}`);
      if (latestDelta.failureLines.length) {
        lines.push("- Potential failures:");
        for (const failure of latestDelta.failureLines.slice(0, 6)) {
          lines.push(`  - ${failure}`);
        }
      }
      if (latestDelta.touchedFiles.length) {
        lines.push("- Touched files:");
        for (const touched of latestDelta.touchedFiles.slice(0, 20)) {
          lines.push(`  - ${touched}`);
        }
      }
    } else {
      lines.push("- No completed session delta captured yet.");
    }
    lines.push("");

    lines.push("## Touched Modules");
    if (touchedModules.length) {
      for (const moduleName of touchedModules) {
        lines.push(`- ${moduleName}`);
      }
    } else {
      lines.push("- none yet");
    }
    lines.push("");

    lines.push("## Recent Session Deltas");
    if (recentDeltas.length) {
      for (const delta of recentDeltas) {
        lines.push(`- ${delta.sessionId}: ${delta.filesChanged} files, +${delta.insertions}/-${delta.deletions}, ended ${delta.endedAt ?? "running"}`);
      }
    } else {
      lines.push("- none");
    }
    lines.push("");

    lines.push("## Latest Tests");
    if (testRows.length) {
      for (const row of testRows) {
        lines.push(`- ${row.suite_key}: ${statusFromCode(row.status)} (${row.duration_ms ?? 0}ms) at ${row.ended_at ?? "running"}`);
      }
    } else {
      lines.push("- no test runs captured");
    }
    lines.push("");

    lines.push("## Process State Pointers");
    if (runtimeRows.length) {
      for (const row of runtimeRows) {
        lines.push(`- ${row.process_key}: ${row.status} (${row.readiness})`);
      }
    } else {
      lines.push("- no managed process runtime state");
    }
    lines.push("");

    lines.push("## Decisions And Todos");
    lines.push(USER_TODOS_START);
    lines.push(userTodos);
    lines.push(USER_TODOS_END);
    lines.push("");

    return { body: `${lines.join("\n")}\n`, lastHeadSha: headSha };
  };

  const buildProjectPackBody = async ({
    reason,
    deterministicUpdatedAt,
    sourceLaneId
  }: {
    reason: string;
    deterministicUpdatedAt: string;
    sourceLaneId?: string;
  }): Promise<string> => {
    const config = projectConfigService.get().effective;
    const lanes = await laneService.list({ includeArchived: false });

    const topLevelEntries = fs
      .readdirSync(projectRoot, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .slice(0, 32)
      .map((entry) => `${entry.isDirectory() ? "dir" : "file"}: ${entry.name}`);

    const lines: string[] = [];
    lines.push("# Project Pack");
    lines.push("");
    lines.push(`- Deterministic updated: ${deterministicUpdatedAt}`);
    lines.push(`- Trigger: ${reason}`);
    if (sourceLaneId) lines.push(`- Source lane: ${sourceLaneId}`);
    lines.push(`- Project root: ${projectRoot}`);
    lines.push(`- Active lanes: ${lanes.length}`);
    lines.push("");

    lines.push("## Repo Map (Top Level)");
    if (topLevelEntries.length) {
      for (const entry of topLevelEntries) {
        lines.push(`- ${entry}`);
      }
    } else {
      lines.push("- no readable entries");
    }
    lines.push("");

    lines.push("## How To Run (Processes)");
    if (config.processes.length) {
      for (const proc of config.processes) {
        lines.push(`- ${proc.id} (${proc.name}): ${JSON.stringify(proc.command)} (cwd=${proc.cwd})`);
      }
    } else {
      lines.push("- no managed process definitions");
    }
    lines.push("");

    lines.push("## How To Test (Test Suites)");
    if (config.testSuites.length) {
      for (const suite of config.testSuites) {
        lines.push(`- ${suite.id} (${suite.name}): ${JSON.stringify(suite.command)} (cwd=${suite.cwd})`);
      }
    } else {
      lines.push("- no test suites configured");
    }
    lines.push("");

    lines.push("## Stack Buttons");
    if (config.stackButtons.length) {
      for (const stack of config.stackButtons) {
        lines.push(`- ${stack.id} (${stack.name}): ${stack.processIds.join(", ")}`);
      }
    } else {
      lines.push("- no stack buttons configured");
    }
    lines.push("");

    lines.push("## Lane Snapshot");
    if (lanes.length) {
      for (const lane of lanes) {
        lines.push(`- ${lane.name} (${lane.branchRef}): dirty=${lane.status.dirty} ahead=${lane.status.ahead} behind=${lane.status.behind}`);
      }
    } else {
      lines.push("- no active lanes");
    }
    lines.push("");

    lines.push("## Conventions And Constraints");
    lines.push("- Deterministic sections are rebuilt by ADE on session end and commit operations.");
    lines.push("- Narrative fields remain local placeholders until hosted integration is enabled.");
    lines.push("");

    return `${lines.join("\n")}\n`;
  };

  return {
    getProjectPack(): PackSummary {
      const row = db.get<{
        pack_type: "project" | "lane";
        pack_path: string;
        deterministic_updated_at: string | null;
        narrative_updated_at: string | null;
        last_head_sha: string | null;
      }>(
        `
          select
            pack_type,
            pack_path,
            deterministic_updated_at,
            narrative_updated_at,
            last_head_sha
          from packs_index
          where pack_key = 'project'
            and project_id = ?
          limit 1
        `,
        [projectId]
      );

      if (row) return toPackSummaryFromRow(row);

      const body = readFileIfExists(projectPackPath);
      const exists = fs.existsSync(projectPackPath);
      return {
        packType: "project",
        path: projectPackPath,
        exists,
        deterministicUpdatedAt: null,
        narrativeUpdatedAt: null,
        lastHeadSha: null,
        body
      };
    },

    getLanePack(laneId: string): PackSummary {
      const row = db.get<{
        pack_type: "project" | "lane";
        pack_path: string;
        deterministic_updated_at: string | null;
        narrative_updated_at: string | null;
        last_head_sha: string | null;
      }>(
        `
          select
            pack_type,
            pack_path,
            deterministic_updated_at,
            narrative_updated_at,
            last_head_sha
          from packs_index
          where pack_key = ?
            and project_id = ?
          limit 1
        `,
        [`lane:${laneId}`, projectId]
      );

      if (row) return toPackSummaryFromRow(row);

      const lanePackPath = getLanePackPath(laneId);
      const body = readFileIfExists(lanePackPath);
      const exists = fs.existsSync(lanePackPath);
      return {
        packType: "lane",
        path: lanePackPath,
        exists,
        deterministicUpdatedAt: null,
        narrativeUpdatedAt: null,
        lastHeadSha: null,
        body
      };
    },

    getSessionDelta(sessionId: string): SessionDeltaSummary | null {
      const row = getSessionDeltaRow(sessionId);
      if (!row) return null;
      return rowToSessionDelta(row);
    },

    async computeSessionDelta(sessionId: string): Promise<SessionDeltaSummary | null> {
      const session = getSessionRow(sessionId);
      if (!session) return null;

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

      const transcript = sessionService.readTranscriptTail(session.transcript_path, 220_000);
      const failureLines = transcript
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => /(error|failed|exception|fatal|traceback)/i.test(line))
        .slice(-8);

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
          computedAt
        ]
      );

      logger.info("packs.session_delta_updated", {
        sessionId,
        laneId: session.lane_id,
        filesChanged: touchedFiles.length,
        insertions: parsedStat.insertions,
        deletions: parsedStat.deletions
      });

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
        computedAt
      };
    },

    async refreshLanePack(args: { laneId: string; reason: string; sessionId?: string }): Promise<PackSummary> {
      const op = operationService.start({
        laneId: args.laneId,
        kind: "pack_update_lane",
        metadata: {
          reason: args.reason,
          sessionId: args.sessionId ?? null
        }
      });

      try {
        const latestDelta = args.sessionId ? await this.computeSessionDelta(args.sessionId) : listRecentLaneSessionDeltas(args.laneId, 1)[0] ?? null;
        const deterministicUpdatedAt = new Date().toISOString();
        const { body, lastHeadSha } = await buildLanePackBody({
          laneId: args.laneId,
          reason: args.reason,
          latestDelta,
          deterministicUpdatedAt
        });

        const packPath = getLanePackPath(args.laneId);
        ensureDirFor(packPath);
        fs.writeFileSync(packPath, body, "utf8");

        upsertPackIndex({
          db,
          projectId,
          packKey: `lane:${args.laneId}`,
          laneId: args.laneId,
          packType: "lane",
          packPath,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha,
          metadata: {
            reason: args.reason,
            sessionId: args.sessionId ?? null,
            latestDeltaSessionId: latestDelta?.sessionId ?? null
          }
        });

        operationService.finish({
          operationId: op.operationId,
          status: "succeeded",
          postHeadSha: lastHeadSha,
          metadataPatch: {
            packPath,
            deterministicUpdatedAt,
            latestDeltaSessionId: latestDelta?.sessionId ?? null
          }
        });

        return {
          packType: "lane",
          path: packPath,
          exists: true,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha,
          body
        };
      } catch (error) {
        operationService.finish({
          operationId: op.operationId,
          status: "failed",
          metadataPatch: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    },

    async refreshProjectPack(args: { reason: string; laneId?: string }): Promise<PackSummary> {
      const op = operationService.start({
        laneId: args.laneId ?? null,
        kind: "pack_update_project",
        metadata: {
          reason: args.reason,
          sourceLaneId: args.laneId ?? null
        }
      });

      try {
        const deterministicUpdatedAt = new Date().toISOString();
        const body = await buildProjectPackBody({
          reason: args.reason,
          deterministicUpdatedAt,
          sourceLaneId: args.laneId
        });

        ensureDirFor(projectPackPath);
        fs.writeFileSync(projectPackPath, body, "utf8");

        upsertPackIndex({
          db,
          projectId,
          packKey: "project",
          laneId: null,
          packType: "project",
          packPath: projectPackPath,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha: null,
          metadata: {
            reason: args.reason,
            sourceLaneId: args.laneId ?? null
          }
        });

        operationService.finish({
          operationId: op.operationId,
          status: "succeeded",
          metadataPatch: {
            packPath: projectPackPath,
            deterministicUpdatedAt
          }
        });

        return {
          packType: "project",
          path: projectPackPath,
          exists: true,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha: null,
          body
        };
      } catch (error) {
        operationService.finish({
          operationId: op.operationId,
          status: "failed",
          metadataPatch: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    }
  };
}
