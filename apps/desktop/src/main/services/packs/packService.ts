import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runGit, runGitMergeTree, runGitOrThrow } from "../git/git";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createOperationService } from "../history/operationService";
import type { Checkpoint, PackEvent, PackSummary, PackType, PackVersion, PackVersionSummary, SessionDeltaSummary, TestRunStatus } from "../../../shared/types";

type LaneSessionRow = {
  id: string;
  lane_id: string;
  tracked: number;
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
  packType: PackType;
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

function toPackSummaryFromRow(args: {
  packKey: string;
  row: {
    pack_type: PackType;
    pack_path: string;
    deterministic_updated_at: string | null;
    narrative_updated_at: string | null;
    last_head_sha: string | null;
  } | null;
  version: { versionId: string; versionNumber: number; contentHash: string } | null;
}): PackSummary {
  const packType = args.row?.pack_type ?? "project";
  const packPath = args.row?.pack_path ?? "";
  const body = packPath ? readFileIfExists(packPath) : "";
  const exists = packPath.length ? fs.existsSync(packPath) : false;

  return {
    packKey: args.packKey,
    packType,
    path: packPath,
    exists,
    deterministicUpdatedAt: args.row?.deterministic_updated_at ?? null,
    narrativeUpdatedAt: args.row?.narrative_updated_at ?? null,
    lastHeadSha: args.row?.last_head_sha ?? null,
    versionId: args.version?.versionId ?? null,
    versionNumber: args.version?.versionNumber ?? null,
    contentHash: args.version?.contentHash ?? null,
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

function replaceNarrativeSection(existing: string, narrative: string): string {
  const cleanNarrative = narrative.trim().length ? narrative.trim() : "Narrative generation returned empty content.";
  const marker = "\n## Narrative\n";
  const idx = existing.indexOf(marker);
  if (idx < 0) {
    const trimmed = existing.trimEnd();
    return `${trimmed}\n\n## Narrative\n${cleanNarrative}\n`;
  }
  const before = existing.slice(0, idx + marker.length);
  return `${before}${cleanNarrative}\n`;
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

function parseDiffNameOnly(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
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
  const getFeaturePackPath = (featureKey: string) => path.join(packsDir, "features", safeSegment(featureKey), "feature_pack.md");
  const getPlanPackPath = (laneId: string) => path.join(packsDir, "plans", laneId, "plan_pack.md");
  const getConflictPackPath = (laneId: string, peer: string) =>
    path.join(packsDir, "conflicts", "v2", `${laneId}__${safeSegment(peer)}.md`);

  const versionsDir = path.join(packsDir, "versions");
  const historyDir = path.join(path.dirname(packsDir), "history");
  const checkpointsDir = path.join(historyDir, "checkpoints");
  const eventsDir = path.join(historyDir, "events");

  const nowIso = () => new Date().toISOString();

  const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

  const ensureDir = (dirPath: string) => {
    fs.mkdirSync(dirPath, { recursive: true });
  };

  const safeSegment = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return "untitled";
    return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  };

  const PACK_RETENTION_KEEP_DAYS = 14;
  const PACK_RETENTION_MAX_ARCHIVED_LANES = 25;
  const PACK_RETENTION_CLEANUP_INTERVAL_MS = 60 * 60_000;
  let lastCleanupAt = 0;

  const cleanupPacks = async (): Promise<void> => {
    const lanes = await laneService.list({ includeArchived: true });
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));

    const now = Date.now();
    const keepBeforeMs = now - PACK_RETENTION_KEEP_DAYS * 24 * 60 * 60_000;

    const lanesDir = path.join(packsDir, "lanes");
    const conflictsDir = path.join(packsDir, "conflicts");

    const archivedDirs: Array<{ laneId: string; archivedAtMs: number }> = [];

    if (fs.existsSync(lanesDir)) {
      for (const entry of fs.readdirSync(lanesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const laneId = entry.name;
        const lane = laneById.get(laneId);
        const absDir = path.join(lanesDir, laneId);

        if (!lane) {
          fs.rmSync(absDir, { recursive: true, force: true });
          continue;
        }

        if (!lane.archivedAt) continue;
        const ts = Date.parse(lane.archivedAt);
        const archivedAtMs = Number.isFinite(ts) ? ts : now;
        archivedDirs.push({ laneId, archivedAtMs });
      }
    }

    archivedDirs.sort((a, b) => b.archivedAtMs - a.archivedAtMs);
    const keepByCount = new Set(archivedDirs.slice(0, PACK_RETENTION_MAX_ARCHIVED_LANES).map((entry) => entry.laneId));

    for (const { laneId, archivedAtMs } of archivedDirs) {
      if (keepByCount.has(laneId) && archivedAtMs >= keepBeforeMs) continue;
      const absDir = path.join(lanesDir, laneId);
      fs.rmSync(absDir, { recursive: true, force: true });
    }

    if (fs.existsSync(conflictsDir)) {
      for (const entry of fs.readdirSync(conflictsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".json")) continue;
        const laneId = entry.name.slice(0, -".json".length);
        const lane = laneById.get(laneId);
        if (!lane) {
          fs.rmSync(path.join(conflictsDir, entry.name), { force: true });
          continue;
        }
        if (!lane.archivedAt) continue;
        const ts = Date.parse(lane.archivedAt);
        const archivedAtMs = Number.isFinite(ts) ? ts : now;
        if (!keepByCount.has(laneId) || archivedAtMs < keepBeforeMs) {
          fs.rmSync(path.join(conflictsDir, entry.name), { force: true });
        }
      }

      // V2 conflict packs are stored as markdown files under `conflicts/v2/`.
      const v2Dir = path.join(conflictsDir, "v2");
      if (fs.existsSync(v2Dir)) {
        for (const entry of fs.readdirSync(v2Dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith(".md")) continue;
          const file = entry.name;
          const laneId = file.split("__")[0]?.trim() ?? "";
          if (!laneId) continue;

          const lane = laneById.get(laneId);
          const absPath = path.join(v2Dir, file);
          if (!lane) {
            fs.rmSync(absPath, { force: true });
            continue;
          }
          if (!lane.archivedAt) continue;
          const ts = Date.parse(lane.archivedAt);
          const archivedAtMs = Number.isFinite(ts) ? ts : now;
          if (!keepByCount.has(laneId) || archivedAtMs < keepBeforeMs) {
            fs.rmSync(absPath, { force: true });
          }
        }
      }
    }
  };

  const maybeCleanupPacks = () => {
    const now = Date.now();
    if (now - lastCleanupAt < PACK_RETENTION_CLEANUP_INTERVAL_MS) return;
    lastCleanupAt = now;
    void cleanupPacks().catch((error: unknown) => {
      logger.warn("packs.cleanup_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  };

  const readCurrentPackVersion = (packKey: string): { versionId: string; versionNumber: number; contentHash: string; renderedPath: string } | null => {
    const row = db.get<{ id: string; version_number: number; content_hash: string; rendered_path: string }>(
      `
        select v.id as id, v.version_number as version_number, v.content_hash as content_hash, v.rendered_path as rendered_path
        from pack_heads h
        join pack_versions v on v.id = h.current_version_id and v.project_id = h.project_id
        where h.project_id = ?
          and h.pack_key = ?
        limit 1
      `,
      [projectId, packKey]
    );
    if (!row?.id) return null;
    return {
      versionId: row.id,
      versionNumber: Number(row.version_number ?? 0),
      contentHash: String(row.content_hash ?? ""),
      renderedPath: String(row.rendered_path ?? "")
    };
  };

  const createPackEvent = (args: { packKey: string; eventType: string; payload?: Record<string, unknown> }): { eventId: string; createdAt: string } => {
    const eventId = randomUUID();
    const createdAt = nowIso();
    const payload = args.payload ?? {};

    db.run(
      `
        insert into pack_events(
          id,
          project_id,
          pack_key,
          event_type,
          payload_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?)
      `,
      [eventId, projectId, args.packKey, args.eventType, JSON.stringify(payload), createdAt]
    );

    try {
      const monthKey = createdAt.slice(0, 7); // YYYY-MM
      const monthDir = path.join(eventsDir, monthKey);
      ensureDir(monthDir);
      fs.writeFileSync(
        path.join(monthDir, `${eventId}.json`),
        JSON.stringify({ id: eventId, packKey: args.packKey, eventType: args.eventType, payload, createdAt }, null, 2),
        "utf8"
      );
    } catch {
      // ignore event file write failures
    }

    return { eventId, createdAt };
  };

  const createPackVersion = (args: { packKey: string; packType: PackType; body: string }): { versionId: string; versionNumber: number; contentHash: string } => {
    const bodyHash = sha256(args.body);
    const existing = readCurrentPackVersion(args.packKey);
    if (existing && existing.contentHash === bodyHash) {
      return {
        versionId: existing.versionId,
        versionNumber: existing.versionNumber,
        contentHash: existing.contentHash
      };
    }

    const versionId = randomUUID();
    const createdAt = nowIso();
    const maxRow = db.get<{ max_version: number | null }>(
      "select max(version_number) as max_version from pack_versions where project_id = ? and pack_key = ?",
      [projectId, args.packKey]
    );
    const versionNumber = Number(maxRow?.max_version ?? 0) + 1;
    const renderedPath = path.join(versionsDir, `${versionId}.md`);

    ensureDir(versionsDir);
    fs.writeFileSync(renderedPath, args.body, "utf8");

    db.run(
      `
        insert into pack_versions(
          id,
          project_id,
          pack_key,
          version_number,
          content_hash,
          rendered_path,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      [versionId, projectId, args.packKey, versionNumber, bodyHash, renderedPath, createdAt]
    );

    db.run(
      `
        insert into pack_heads(project_id, pack_key, current_version_id, updated_at)
        values (?, ?, ?, ?)
        on conflict(project_id, pack_key) do update set
          current_version_id = excluded.current_version_id,
          updated_at = excluded.updated_at
      `,
      [projectId, args.packKey, versionId, createdAt]
    );

    createPackEvent({
      packKey: args.packKey,
      eventType: "version_created",
      payload: {
        packKey: args.packKey,
        packType: args.packType,
        versionId,
        versionNumber,
        contentHash: bodyHash
      }
    });

    return { versionId, versionNumber, contentHash: bodyHash };
  };

  const recordCheckpointFromDelta = (args: {
    laneId: string;
    sessionId: string;
    sha: string;
    delta: SessionDeltaSummary;
  }): Checkpoint | null => {
    const existing = db.get<{ id: string }>(
      "select id from checkpoints where project_id = ? and session_id = ? limit 1",
      [projectId, args.sessionId]
    );
    if (existing?.id) return null;

    const checkpointId = randomUUID();
    const createdAt = nowIso();
    const diffStat = {
      insertions: args.delta.insertions,
      deletions: args.delta.deletions,
      filesChanged: args.delta.filesChanged,
      files: args.delta.touchedFiles
    };

    const event = createPackEvent({
      packKey: `lane:${args.laneId}`,
      eventType: "checkpoint",
      payload: {
        checkpointId,
        laneId: args.laneId,
        sessionId: args.sessionId,
        sha: args.sha,
        diffStat
      }
    });

    try {
      ensureDir(checkpointsDir);
      fs.writeFileSync(
        path.join(checkpointsDir, `${checkpointId}.json`),
        JSON.stringify(
          {
            id: checkpointId,
            laneId: args.laneId,
            sessionId: args.sessionId,
            sha: args.sha,
            diffStat,
            packEventIds: [event.eventId],
            createdAt
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {
      // ignore checkpoint file write failures
    }

    db.run(
      `
        insert into checkpoints(
          id,
          project_id,
          lane_id,
          session_id,
          sha,
          diff_stat_json,
          pack_event_ids_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        checkpointId,
        projectId,
        args.laneId,
        args.sessionId,
        args.sha,
        JSON.stringify(diffStat),
        JSON.stringify([event.eventId]),
        createdAt
      ]
    );

    return {
      id: checkpointId,
      laneId: args.laneId,
      sessionId: args.sessionId,
      sha: args.sha,
      diffStat,
      packEventIds: [event.eventId],
      createdAt
    };
  };

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
    const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
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
    lines.push(`- Provider mode: ${providerMode}`);
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
    lines.push("## Narrative");
    if (providerMode === "guest") {
      lines.push("Template narrative mode active (Guest Mode). Deterministic sections are fully local.");
    } else {
      lines.push("Narrative sections are generated by the active AI provider (Hosted/BYOK) and merged into this pack.");
    }
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
    if ((config.providerMode ?? "guest") === "guest") {
      lines.push("- Guest Mode active: narrative sections use local templates only.");
    } else {
      lines.push("- Narrative sections are AI-assisted when Hosted or BYOK is configured and available.");
    }
    lines.push("");

    return `${lines.join("\n")}\n`;
  };

  const getPackIndexRow = (packKey: string): {
    pack_type: PackType;
    lane_id: string | null;
    pack_path: string;
    deterministic_updated_at: string | null;
    narrative_updated_at: string | null;
    last_head_sha: string | null;
  } | null => {
    return db.get<{
      pack_type: PackType;
      lane_id: string | null;
      pack_path: string;
      deterministic_updated_at: string | null;
      narrative_updated_at: string | null;
      last_head_sha: string | null;
    }>(
      `
        select
          pack_type,
          lane_id,
          pack_path,
          deterministic_updated_at,
          narrative_updated_at,
          last_head_sha
        from packs_index
        where pack_key = ?
          and project_id = ?
        limit 1
      `,
      [packKey, projectId]
    );
  };

  const getPackSummaryForKey = (packKey: string, fallback: { packType: PackType; packPath: string }): PackSummary => {
    const row = getPackIndexRow(packKey);
    const effectiveRow = row ?? {
      pack_type: fallback.packType,
      lane_id: null,
      pack_path: fallback.packPath,
      deterministic_updated_at: null,
      narrative_updated_at: null,
      last_head_sha: null
    };
    const version = readCurrentPackVersion(packKey);
    return toPackSummaryFromRow({ packKey, row: effectiveRow, version });
  };

  const readLanePackExcerpt = (laneId: string): string | null => {
    const filePath = getLanePackPath(laneId);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const MAX = 12_000;
      return trimmed.length > MAX ? `${trimmed.slice(0, MAX)}\n\n…(truncated)…\n` : trimmed;
    } catch {
      return null;
    }
  };

  const buildFeaturePackBody = async (args: {
    featureKey: string;
    reason: string;
    deterministicUpdatedAt: string;
  }): Promise<{ body: string; laneIds: string[] }> => {
    const lanes = await laneService.list({ includeArchived: false });
    const matching = lanes.filter((lane) => lane.tags.includes(args.featureKey));
    const lines: string[] = [];
    lines.push(`# Feature Pack: ${args.featureKey}`);
    lines.push("");
    lines.push(`- Deterministic updated: ${args.deterministicUpdatedAt}`);
    lines.push(`- Trigger: ${args.reason}`);
    lines.push(`- Lanes: ${matching.length}`);
    lines.push("");

    if (matching.length === 0) {
      lines.push("No lanes are tagged with this feature key yet.");
      lines.push("");
      lines.push("## How To Use");
      lines.push(`- Add the tag '${args.featureKey}' to one or more lanes (Workspace Graph → right click lane → Customize).`);
      lines.push("");
      return { body: `${lines.join("\n")}\n`, laneIds: [] };
    }

    lines.push("## Lanes");
    for (const lane of matching.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- ${lane.name} (${lane.branchRef}): dirty=${lane.status.dirty} ahead=${lane.status.ahead} behind=${lane.status.behind}`);
    }
    lines.push("");

    for (const lane of matching.sort((a, b) => a.stackDepth - b.stackDepth || a.name.localeCompare(b.name))) {
      const lanePackBody = readFileIfExists(getLanePackPath(lane.id));
      const intent = extractSection(lanePackBody, USER_INTENT_START, USER_INTENT_END, "");
      const todos = extractSection(lanePackBody, USER_TODOS_START, USER_TODOS_END, "");

      lines.push(`## Lane: ${lane.name}`);
      lines.push(`- Lane ID: ${lane.id}`);
      lines.push(`- Branch: ${lane.branchRef}`);
      lines.push(`- Base: ${lane.baseRef}`);
      lines.push(`- Status: ${lane.status.dirty ? "dirty" : "clean"}; ahead ${lane.status.ahead}; behind ${lane.status.behind}`);
      lines.push("");
      if (intent.trim().length) {
        lines.push("### Intent");
        lines.push(intent.trim());
        lines.push("");
      }
      if (todos.trim().length) {
        lines.push("### Todos");
        lines.push(todos.trim());
        lines.push("");
      }
    }

    lines.push("## Narrative");
    lines.push("This feature pack is primarily deterministic aggregation. Use lane packs for detailed session context.");
    lines.push("");

    return { body: `${lines.join("\n")}\n`, laneIds: matching.map((lane) => lane.id) };
  };

  const buildConflictPackBody = async (args: {
    laneId: string;
    peerLaneId: string | null;
    reason: string;
    deterministicUpdatedAt: string;
  }): Promise<{ body: string; lastHeadSha: string | null }> => {
    const laneA = laneService.getLaneBaseAndBranch(args.laneId);
    const laneAHead = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: laneA.worktreePath, timeoutMs: 10_000 })).trim();
    const peerLabel = args.peerLaneId ? `lane:${args.peerLaneId}` : `base:${laneA.baseRef}`;

    const laneBHead = args.peerLaneId
      ? (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: laneService.getLaneBaseAndBranch(args.peerLaneId).worktreePath, timeoutMs: 10_000 })).trim()
      : (await runGitOrThrow(["rev-parse", laneA.baseRef], { cwd: projectRoot, timeoutMs: 10_000 })).trim();

    const mergeBase = (await runGitOrThrow(["merge-base", laneAHead, laneBHead], { cwd: projectRoot, timeoutMs: 12_000 })).trim();
    const merge = await runGitMergeTree({
      cwd: projectRoot,
      mergeBase,
      branchA: laneAHead,
      branchB: laneBHead,
      timeoutMs: 60_000
    });

    const touchedA = await runGit(["diff", "--name-only", `${mergeBase}..${laneAHead}`], { cwd: projectRoot, timeoutMs: 20_000 });
    const touchedB = await runGit(["diff", "--name-only", `${mergeBase}..${laneBHead}`], { cwd: projectRoot, timeoutMs: 20_000 });
    const aFiles = new Set(parseDiffNameOnly(touchedA.stdout));
    const bFiles = new Set(parseDiffNameOnly(touchedB.stdout));
    const overlap = uniqueSorted(Array.from(aFiles).filter((file) => bFiles.has(file)));

    const lines: string[] = [];
    lines.push(`# Conflict Pack`);
    lines.push("");
    lines.push(`- Deterministic updated: ${args.deterministicUpdatedAt}`);
    lines.push(`- Trigger: ${args.reason}`);
    lines.push(`- Lane: ${args.laneId}`);
    lines.push(`- Peer: ${peerLabel}`);
    lines.push(`- Merge base: ${mergeBase}`);
    lines.push(`- Lane HEAD: ${laneAHead}`);
    lines.push(`- Peer HEAD: ${laneBHead}`);
    lines.push("");

    lines.push("## Overlapping Files");
    if (overlap.length) {
      for (const file of overlap.slice(0, 120)) {
        lines.push(`- ${file}`);
      }
      if (overlap.length > 120) lines.push(`- … (${overlap.length - 120} more)`);
    } else {
      lines.push("- none");
    }
    lines.push("");

    lines.push("## Conflicts (merge-tree)");
    if (merge.conflicts.length) {
      for (const conflict of merge.conflicts.slice(0, 30)) {
        lines.push(`### ${conflict.path} (${conflict.conflictType})`);
        if (conflict.markerPreview.trim().length) {
          lines.push("```");
          lines.push(conflict.markerPreview.trim());
          lines.push("```");
        }
        lines.push("");
      }
      if (merge.conflicts.length > 30) {
        lines.push(`(truncated) ${merge.conflicts.length} conflicts total.`);
        lines.push("");
      }
    } else {
      lines.push("- no merge-tree conflicts reported");
      lines.push("");
    }

    const lanePackBody = readLanePackExcerpt(args.laneId);
    if (lanePackBody) {
      lines.push("## Lane Pack (Excerpt)");
      lines.push("```");
      lines.push(lanePackBody.trim());
      lines.push("```");
      lines.push("");
    }

    if (args.peerLaneId) {
      const peerPackBody = readLanePackExcerpt(args.peerLaneId);
      if (peerPackBody) {
        lines.push("## Peer Lane Pack (Excerpt)");
        lines.push("```");
        lines.push(peerPackBody.trim());
        lines.push("```");
        lines.push("");
      }
    }

    lines.push("## Narrative");
    lines.push("Conflict packs are data-heavy: overlap lists, merge-tree conflicts, and lane context excerpts.");
    lines.push("");

    return { body: `${lines.join("\n")}\n`, lastHeadSha: laneAHead };
  };

  return {
    getProjectPack(): PackSummary {
      const row = db.get<{
        pack_type: PackType;
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

      const version = readCurrentPackVersion("project");
      if (row) return toPackSummaryFromRow({ packKey: "project", row, version });

      const body = readFileIfExists(projectPackPath);
      const exists = fs.existsSync(projectPackPath);
      return {
        packKey: "project",
        packType: "project",
        path: projectPackPath,
        exists,
        deterministicUpdatedAt: null,
        narrativeUpdatedAt: null,
        lastHeadSha: null,
        versionId: version?.versionId ?? null,
        versionNumber: version?.versionNumber ?? null,
        contentHash: version?.contentHash ?? null,
        body
      };
    },

    getLanePack(laneId: string): PackSummary {
      const row = db.get<{
        pack_type: PackType;
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

      const packKey = `lane:${laneId}`;
      const version = readCurrentPackVersion(packKey);
      if (row) return toPackSummaryFromRow({ packKey, row, version });

      const lanePackPath = getLanePackPath(laneId);
      const body = readFileIfExists(lanePackPath);
      const exists = fs.existsSync(lanePackPath);
      return {
        packKey,
        packType: "lane",
        path: lanePackPath,
        exists,
        deterministicUpdatedAt: null,
        narrativeUpdatedAt: null,
        lastHeadSha: null,
        versionId: version?.versionId ?? null,
        versionNumber: version?.versionNumber ?? null,
        contentHash: version?.contentHash ?? null,
        body
      };
    },

    getFeaturePack(featureKey: string): PackSummary {
      const key = featureKey.trim();
      if (!key) throw new Error("featureKey is required");
      const packKey = `feature:${key}`;
      return getPackSummaryForKey(packKey, { packType: "feature", packPath: getFeaturePackPath(key) });
    },

    getConflictPack(args: { laneId: string; peerLaneId?: string | null }): PackSummary {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const peer = args.peerLaneId?.trim() || null;
      const lane = laneService.getLaneBaseAndBranch(laneId);
      const peerKey = peer ?? lane.baseRef;
      const packKey = `conflict:${laneId}:${peerKey}`;
      return getPackSummaryForKey(packKey, { packType: "conflict", packPath: getConflictPackPath(laneId, peerKey) });
    },

    getPlanPack(laneId: string): PackSummary {
      const id = laneId.trim();
      if (!id) throw new Error("laneId is required");
      const packKey = `plan:${id}`;
      return getPackSummaryForKey(packKey, { packType: "plan", packPath: getPlanPackPath(id) });
    },

    getSessionDelta(sessionId: string): SessionDeltaSummary | null {
      const row = getSessionDeltaRow(sessionId);
      if (!row) return null;
      return rowToSessionDelta(row);
    },

    async computeSessionDelta(sessionId: string): Promise<SessionDeltaSummary | null> {
      const session = getSessionRow(sessionId);
      if (!session) return null;
      if (session.tracked !== 1) return null;

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
        const latestDelta = args.sessionId
          ? await this.computeSessionDelta(args.sessionId)
          : listRecentLaneSessionDeltas(args.laneId, 1)[0] ?? null;
        const deterministicUpdatedAt = nowIso();
        const { body, lastHeadSha } = await buildLanePackBody({
          laneId: args.laneId,
          reason: args.reason,
          latestDelta,
          deterministicUpdatedAt
        });

        const packKey = `lane:${args.laneId}`;
        const packPath = getLanePackPath(args.laneId);
        ensureDirFor(packPath);
        fs.writeFileSync(packPath, body, "utf8");

        createPackEvent({
          packKey,
          eventType: "refresh_triggered",
          payload: {
            trigger: args.reason,
            laneId: args.laneId,
            sessionId: args.sessionId ?? null
          }
        });

        const version = createPackVersion({ packKey, packType: "lane", body });

        if (args.sessionId && latestDelta) {
          const checkpointSha =
            lastHeadSha ??
            latestDelta.headShaEnd ??
            latestDelta.headShaStart ??
            null;
          if (checkpointSha) {
            recordCheckpointFromDelta({
              laneId: args.laneId,
              sessionId: args.sessionId,
              sha: checkpointSha,
              delta: latestDelta
            });
          }
        }

        upsertPackIndex({
          db,
          projectId,
          packKey,
          laneId: args.laneId,
          packType: "lane",
          packPath,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha,
          metadata: {
            reason: args.reason,
            sessionId: args.sessionId ?? null,
            latestDeltaSessionId: latestDelta?.sessionId ?? null,
            versionId: version.versionId,
            versionNumber: version.versionNumber,
            contentHash: version.contentHash
          }
        });

        operationService.finish({
          operationId: op.operationId,
          status: "succeeded",
          postHeadSha: lastHeadSha,
          metadataPatch: {
            packPath,
            deterministicUpdatedAt,
            latestDeltaSessionId: latestDelta?.sessionId ?? null,
            versionId: version.versionId,
            versionNumber: version.versionNumber
          }
        });

        maybeCleanupPacks();

        return {
          packKey,
          packType: "lane",
          path: packPath,
          exists: true,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha,
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash,
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
        const deterministicUpdatedAt = nowIso();
        const body = await buildProjectPackBody({
          reason: args.reason,
          deterministicUpdatedAt,
          sourceLaneId: args.laneId
        });

        const packKey = "project";
        ensureDirFor(projectPackPath);
        fs.writeFileSync(projectPackPath, body, "utf8");

        createPackEvent({
          packKey,
          eventType: "refresh_triggered",
          payload: {
            trigger: args.reason,
            laneId: args.laneId ?? null
          }
        });

        const version = createPackVersion({ packKey, packType: "project", body });

        upsertPackIndex({
          db,
          projectId,
          packKey,
          laneId: null,
          packType: "project",
          packPath: projectPackPath,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha: null,
          metadata: {
            reason: args.reason,
            sourceLaneId: args.laneId ?? null,
            versionId: version.versionId,
            versionNumber: version.versionNumber,
            contentHash: version.contentHash
          }
        });

        operationService.finish({
          operationId: op.operationId,
          status: "succeeded",
          metadataPatch: {
            packPath: projectPackPath,
            deterministicUpdatedAt,
            versionId: version.versionId,
            versionNumber: version.versionNumber
          }
        });

        maybeCleanupPacks();

        return {
          packKey,
          packType: "project",
          path: projectPackPath,
          exists: true,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha: null,
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash,
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

    async refreshFeaturePack(args: { featureKey: string; reason: string }): Promise<PackSummary> {
      const key = args.featureKey.trim();
      if (!key) throw new Error("featureKey is required");
      const packKey = `feature:${key}`;
      const deterministicUpdatedAt = nowIso();
      const built = await buildFeaturePackBody({
        featureKey: key,
        reason: args.reason,
        deterministicUpdatedAt
      });

      const packPath = getFeaturePackPath(key);
      ensureDirFor(packPath);
      fs.writeFileSync(packPath, built.body, "utf8");

      createPackEvent({
        packKey,
        eventType: "refresh_triggered",
        payload: { trigger: args.reason, featureKey: key, laneIds: built.laneIds }
      });

      const version = createPackVersion({ packKey, packType: "feature", body: built.body });

      upsertPackIndex({
        db,
        projectId,
        packKey,
        laneId: null,
        packType: "feature",
        packPath,
        deterministicUpdatedAt,
        narrativeUpdatedAt: null,
        lastHeadSha: null,
        metadata: {
          reason: args.reason,
          featureKey: key,
          laneIds: built.laneIds,
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash
        }
      });

      return {
        packKey,
        packType: "feature",
        path: packPath,
        exists: true,
        deterministicUpdatedAt,
        narrativeUpdatedAt: null,
        lastHeadSha: null,
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        contentHash: version.contentHash,
        body: built.body
      };
    },

    async refreshConflictPack(args: { laneId: string; peerLaneId?: string | null; reason: string }): Promise<PackSummary> {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const peer = args.peerLaneId?.trim() || null;
      const lane = laneService.getLaneBaseAndBranch(laneId);
      const peerKey = peer ?? lane.baseRef;
      const packKey = `conflict:${laneId}:${peerKey}`;

      const deterministicUpdatedAt = nowIso();
      const built = await buildConflictPackBody({
        laneId,
        peerLaneId: peer,
        reason: args.reason,
        deterministicUpdatedAt
      });

      const packPath = getConflictPackPath(laneId, peerKey);
      ensureDirFor(packPath);
      fs.writeFileSync(packPath, built.body, "utf8");

      createPackEvent({
        packKey,
        eventType: "refresh_triggered",
        payload: { trigger: args.reason, laneId, peerLaneId: peer, peerKey }
      });

      const version = createPackVersion({ packKey, packType: "conflict", body: built.body });

      upsertPackIndex({
        db,
        projectId,
        packKey,
        laneId,
        packType: "conflict",
        packPath,
        deterministicUpdatedAt,
        narrativeUpdatedAt: null,
        lastHeadSha: built.lastHeadSha,
        metadata: {
          reason: args.reason,
          laneId,
          peerLaneId: peer,
          peerKey,
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash
        }
      });

      return {
        packKey,
        packType: "conflict",
        path: packPath,
        exists: true,
        deterministicUpdatedAt,
        narrativeUpdatedAt: null,
        lastHeadSha: built.lastHeadSha,
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        contentHash: version.contentHash,
        body: built.body
      };
    },

    async savePlanPack(args: { laneId: string; body: string; reason: string }): Promise<PackSummary> {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const packKey = `plan:${laneId}`;
      const packPath = getPlanPackPath(laneId);
      const deterministicUpdatedAt = nowIso();

      const lane = laneService.getLaneBaseAndBranch(laneId);
      const headSha = await getHeadSha(lane.worktreePath);

      const body = args.body ?? "";
      ensureDirFor(packPath);
      fs.writeFileSync(packPath, body, "utf8");

      createPackEvent({
        packKey,
        eventType: "plan_saved",
        payload: { trigger: args.reason, laneId }
      });

      const version = createPackVersion({ packKey, packType: "plan", body });

      upsertPackIndex({
        db,
        projectId,
        packKey,
        laneId,
        packType: "plan",
        packPath,
        deterministicUpdatedAt,
        narrativeUpdatedAt: deterministicUpdatedAt,
        lastHeadSha: headSha,
        metadata: {
          reason: args.reason,
          laneId,
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash
        }
      });

      return {
        packKey,
        packType: "plan",
        path: packPath,
        exists: true,
        deterministicUpdatedAt,
        narrativeUpdatedAt: deterministicUpdatedAt,
        lastHeadSha: headSha,
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        contentHash: version.contentHash,
        body
      };
    },

    updateNarrative(args: { packKey: string; narrative: string; source?: string }): PackSummary {
      const packKey = args.packKey.trim();
      if (!packKey) throw new Error("packKey is required");
      const row = getPackIndexRow(packKey);
      if (!row?.pack_path) throw new Error(`Pack not found: ${packKey}`);

      const existing = readFileIfExists(row.pack_path);
      const updatedBody = replaceNarrativeSection(existing, args.narrative);
      ensureDirFor(row.pack_path);
      fs.writeFileSync(row.pack_path, updatedBody, "utf8");

      const now = nowIso();
      createPackEvent({
        packKey,
        eventType: "narrative_update",
        payload: {
          source: args.source ?? "user"
        }
      });

      const version = createPackVersion({ packKey, packType: row.pack_type, body: updatedBody });

      upsertPackIndex({
        db,
        projectId,
        packKey,
        laneId: row.lane_id ?? null,
        packType: row.pack_type,
        packPath: row.pack_path,
        deterministicUpdatedAt: row.deterministic_updated_at ?? now,
        narrativeUpdatedAt: now,
        lastHeadSha: row.last_head_sha ?? null,
        metadata: {
          source: args.source ?? "user",
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash
        }
      });

      return toPackSummaryFromRow({
        packKey,
        row: {
          ...row,
          narrative_updated_at: now
        },
        version: {
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash
        }
      });
    },

    listVersions(args: { packKey: string; limit?: number }): PackVersionSummary[] {
      const packKey = args.packKey.trim();
      if (!packKey) throw new Error("packKey is required");
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 50;
      const packType = getPackIndexRow(packKey)?.pack_type ?? (packKey.startsWith("lane:") ? "lane" : "project");
      const rows = db.all<{
        id: string;
        version_number: number;
        content_hash: string;
        created_at: string;
      }>(
        `
          select id, version_number, content_hash, created_at
          from pack_versions
          where project_id = ?
            and pack_key = ?
          order by version_number desc
          limit ?
        `,
        [projectId, packKey, limit]
      );
      return rows.map((row) => ({
        id: row.id,
        packKey,
        packType,
        versionNumber: Number(row.version_number ?? 0),
        contentHash: String(row.content_hash ?? ""),
        createdAt: row.created_at
      }));
    },

    getVersion(versionId: string): PackVersion {
      const id = versionId.trim();
      if (!id) throw new Error("versionId is required");
      const row = db.get<{
        id: string;
        pack_key: string;
        version_number: number;
        content_hash: string;
        rendered_path: string;
        created_at: string;
      }>(
        `
          select id, pack_key, version_number, content_hash, rendered_path, created_at
          from pack_versions
          where project_id = ?
            and id = ?
          limit 1
        `,
        [projectId, id]
      );
      if (!row) throw new Error(`Pack version not found: ${id}`);
      const packType = getPackIndexRow(row.pack_key)?.pack_type ?? (row.pack_key.startsWith("lane:") ? "lane" : "project");
      return {
        id: row.id,
        packKey: row.pack_key,
        packType,
        versionNumber: Number(row.version_number ?? 0),
        contentHash: String(row.content_hash ?? ""),
        renderedPath: row.rendered_path,
        body: readFileIfExists(row.rendered_path),
        createdAt: row.created_at
      };
    },

    async diffVersions(args: { fromId: string; toId: string }): Promise<string> {
      const from = this.getVersion(args.fromId);
      const to = this.getVersion(args.toId);
      const res = await runGit(["diff", "--no-index", "--", from.renderedPath, to.renderedPath], {
        cwd: projectRoot,
        timeoutMs: 20_000
      });
      if (res.exitCode === 0 || res.exitCode === 1) {
        return res.stdout;
      }
      throw new Error(res.stderr.trim() || "Failed to diff pack versions");
    },

    listEvents(args: { packKey: string; limit?: number }): PackEvent[] {
      const packKey = args.packKey.trim();
      if (!packKey) throw new Error("packKey is required");
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 50;
      const rows = db.all<{
        id: string;
        pack_key: string;
        event_type: string;
        payload_json: string | null;
        created_at: string;
      }>(
        `
          select id, pack_key, event_type, payload_json, created_at
          from pack_events
          where project_id = ?
            and pack_key = ?
          order by created_at desc
          limit ?
        `,
        [projectId, packKey, limit]
      );
      return rows.map((row) => ({
        id: row.id,
        packKey: row.pack_key,
        eventType: row.event_type,
        payload: (() => {
          try {
            return row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : {};
          } catch {
            return {};
          }
        })(),
        createdAt: row.created_at
      }));
    },

    listCheckpoints(args: { laneId?: string; limit?: number } = {}): Checkpoint[] {
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 100;
      const where = ["project_id = ?"];
      const params: Array<string | number> = [projectId];
      if (args.laneId) {
        where.push("lane_id = ?");
        params.push(args.laneId);
      }
      params.push(limit);
      const rows = db.all<{
        id: string;
        lane_id: string;
        session_id: string | null;
        sha: string;
        diff_stat_json: string | null;
        pack_event_ids_json: string | null;
        created_at: string;
      }>(
        `
          select id, lane_id, session_id, sha, diff_stat_json, pack_event_ids_json, created_at
          from checkpoints
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        params
      );
      return rows.map((row) => ({
        id: row.id,
        laneId: row.lane_id,
        sessionId: row.session_id,
        sha: row.sha,
        diffStat: (() => {
          try {
            return row.diff_stat_json
              ? (JSON.parse(row.diff_stat_json) as Checkpoint["diffStat"])
              : { insertions: 0, deletions: 0, filesChanged: 0, files: [] };
          } catch {
            return { insertions: 0, deletions: 0, filesChanged: 0, files: [] };
          }
        })(),
        packEventIds: (() => {
          try {
            return row.pack_event_ids_json ? (JSON.parse(row.pack_event_ids_json) as string[]) : [];
          } catch {
            return [];
          }
        })(),
        createdAt: row.created_at
      }));
    },

    applyHostedNarrative(args: {
      laneId: string;
      narrative: string;
      metadata?: Record<string, unknown>;
    }): PackSummary {
      const packKey = `lane:${args.laneId}`;
      const lanePackPath = getLanePackPath(args.laneId);
      const existing = readFileIfExists(lanePackPath);
      if (!existing.trim().length) {
        throw new Error(`Lane pack not found for lane ${args.laneId}`);
      }

      const updatedBody = replaceNarrativeSection(existing, args.narrative);
      ensureDirFor(lanePackPath);
      fs.writeFileSync(lanePackPath, updatedBody, "utf8");

      const now = nowIso();
      const existingRow = db.get<{
        deterministic_updated_at: string | null;
        last_head_sha: string | null;
      }>(
        `
          select deterministic_updated_at, last_head_sha
          from packs_index
          where pack_key = ?
            and project_id = ?
          limit 1
        `,
        [packKey, projectId]
      );

      createPackEvent({
        packKey,
        eventType: "narrative_update",
        payload: {
          laneId: args.laneId,
          source: "hosted",
          ...(args.metadata ?? {})
        }
      });

      const version = createPackVersion({ packKey, packType: "lane", body: updatedBody });

      upsertPackIndex({
        db,
        projectId,
        packKey,
        laneId: args.laneId,
        packType: "lane",
        packPath: lanePackPath,
        deterministicUpdatedAt: existingRow?.deterministic_updated_at ?? now,
        narrativeUpdatedAt: now,
        lastHeadSha: existingRow?.last_head_sha ?? null,
        metadata: {
          source: "hosted",
          ...(args.metadata ?? {}),
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash
        }
      });

      maybeCleanupPacks();

      return {
        packKey,
        packType: "lane",
        path: lanePackPath,
        exists: true,
        deterministicUpdatedAt: existingRow?.deterministic_updated_at ?? now,
        narrativeUpdatedAt: now,
        lastHeadSha: existingRow?.last_head_sha ?? null,
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        contentHash: version.contentHash,
        body: updatedBody
      };
    }
  };
}
