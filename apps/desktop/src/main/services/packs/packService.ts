import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createContextDocService } from "../context/contextDocService";
import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import { createSessionDeltaService } from "../sessions/sessionDeltaService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createOperationService } from "../history/operationService";
import { uniqueSorted } from "../shared/utils";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type {
  Checkpoint,
  ConflictLineageV1,
  ContextExportLevel,
  ContextHeaderV1,
  ConflictRiskLevel,
  ConflictStatusValue,
  GetConflictExportArgs,
  GetLaneExportArgs,
  GetProjectExportArgs,
  LaneCompletionSignal,
  LaneExportManifestV1,
  LaneSummary,
  OrchestratorLaneSummaryV1,
  ListPackEventsSinceArgs,
  PackDeltaDigestArgs,
  PackDeltaDigestV1,
  PackDependencyStateV1,
  PackEvent,
  PackEventCategory,
  PackEventEntityRef,
  PackEventImportance,
  PackExport,
  PackHeadVersion,
  PackSummary,
  PackType,
  PackVersion,
  PackVersionSummary,
  ProjectExportManifestV1,
  ProjectManifestLaneEntryV1,
  SessionDeltaSummary,
  TestRunStatus
} from "../../../shared/types";
import {
  ADE_INTENT_END,
  ADE_INTENT_START,
  ADE_NARRATIVE_END,
  ADE_NARRATIVE_START,
  ADE_TASK_SPEC_END,
  ADE_TASK_SPEC_START,
  ADE_TODOS_END,
  ADE_TODOS_START,
  CONTEXT_HEADER_SCHEMA_V1,
  CONTEXT_CONTRACT_VERSION
} from "../../../shared/contextContract";
import { stripAnsi } from "../../utils/ansiStrip";
import { inferTestOutcomeFromText } from "./transcriptInsights";
import { renderLanePackMarkdown } from "./lanePackTemplate";
import { computeSectionChanges, upsertSectionByHeading } from "./packSections";
import { buildConflictExport, buildLaneExport, buildProjectExport } from "./packExports";
import type { PackRelation } from "../../../shared/contextContract";

// ── Extracted builder modules ────────────────────────────────────────────────
import {
  safeJsonParseArray,
  readFileIfExists,
  ensureDirFor,
  ensureDir,
  safeSegment,
  parsePackMetadataJson,
  extractSection,
  statusFromCode,
  humanToolLabel,
  normalizeRiskLevel,
  asString,
  computeMergeReadiness,
  buildGraphEnvelope,
  importanceRank,
  getDefaultSectionLocators,
  upsertPackIndex,
  toPackSummaryFromRow,
  formatCommand,
  moduleFromPath
} from "./packUtils";
import {
  type ProjectPackBuilderDeps,
  buildProjectPackBody as buildProjectPackBodyImpl
} from "./projectPackBuilder";
import {
  type MissionPackBuilderDeps,
  buildMissionPackBody as buildMissionPackBodyImpl,
  buildPlanPackBody as buildPlanPackBodyImpl,
  buildFeaturePackBody as buildFeaturePackBodyImpl
} from "./missionPackBuilder";
import {
  type ConflictPackBuilderDeps,
  readConflictPredictionPack as readConflictPredictionPackImpl,
  readGitConflictState as readGitConflictStateImpl,
  deriveConflictStateForLane as deriveConflictStateForLaneImpl,
  computeLaneLineage as computeLaneLineageImpl,
  buildLaneConflictRiskSummaryLines as buildLaneConflictRiskSummaryLinesImpl,
  buildConflictPackBody as buildConflictPackBodyImpl
} from "./conflictPackBuilder";

function replaceNarrativeSection(existing: string, narrative: string): { updated: string; insertedMarkers: boolean } {
  const cleanNarrative = narrative.trim().length ? narrative.trim() : "Narrative generation returned empty content.";
  const next = upsertSectionByHeading({
    content: existing,
    heading: "## Narrative",
    startMarker: ADE_NARRATIVE_START,
    endMarker: ADE_NARRATIVE_END,
    body: cleanNarrative
  });
  return { updated: next.content, insertedMarkers: next.insertedMarkers };
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
  aiIntegrationService,
  operationService,
  onEvent
}: {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  projectId: string;
  packsDir: string;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
  operationService: ReturnType<typeof createOperationService>;
  onEvent?: (event: PackEvent) => void;
}) {
  const projectPackPath = path.join(packsDir, "project_pack.md");

  const getLanePackPath = (laneId: string) => path.join(packsDir, "lanes", laneId, "lane_pack.md");
  const getFeaturePackPath = (featureKey: string) => path.join(packsDir, "features", safeSegment(featureKey), "feature_pack.md");
  const getPlanPackPath = (laneId: string) => path.join(packsDir, "plans", laneId, "plan_pack.md");
  const getMissionPackPath = (missionId: string) => path.join(packsDir, "missions", missionId, "mission_pack.md");
  const getConflictPackPath = (laneId: string, peer: string) =>
    path.join(packsDir, "conflicts", "v2", `${laneId}__${safeSegment(peer)}.md`);
  const conflictsRootDir = path.join(packsDir, "conflicts");
  const conflictPredictionsDir = path.join(conflictsRootDir, "predictions");
  const getConflictPredictionPath = (laneId: string) => path.join(conflictPredictionsDir, `${laneId}.json`);

  const versionsDir = path.join(packsDir, "versions");
  const historyDir = path.join(path.dirname(packsDir), "history");
  const checkpointsDir = path.join(historyDir, "checkpoints");
  const eventsDir = path.join(historyDir, "events");

  const nowIso = () => new Date().toISOString();

  const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

  const inferPackTypeFromKey = (packKey: string): PackType => {
    if (packKey === "project") return "project";
    if (packKey.startsWith("lane:")) return "lane";
    if (packKey.startsWith("feature:")) return "feature";
    if (packKey.startsWith("conflict:")) return "conflict";
    if (packKey.startsWith("plan:")) return "plan";
    if (packKey.startsWith("mission:")) return "mission";
    return "project";
  };

  // ── Deps for extracted builders ─────────────────────────────────────────────

  const projectPackBuilderDeps: ProjectPackBuilderDeps = {
    db,
    logger,
    projectRoot,
    projectId,
    packsDir,
    laneService,
    projectConfigService,
    aiIntegrationService
  };
  const contextDocService = createContextDocService({
    ...projectPackBuilderDeps,
    packsDir,
  });

  const conflictPackBuilderDeps: ConflictPackBuilderDeps = {
    projectRoot,
    laneService,
    getConflictPredictionPath,
    getLanePackPath
  };

  const readConflictPredictionPack = (laneId: string) => readConflictPredictionPackImpl(conflictPackBuilderDeps, laneId);
  const readGitConflictState = (laneId: string) => readGitConflictStateImpl(conflictPackBuilderDeps, laneId);
  const deriveConflictStateForLane = (laneId: string) => deriveConflictStateForLaneImpl(conflictPackBuilderDeps, laneId);
  const computeLaneLineage = (args: { laneId: string; lanesById: Map<string, LaneSummary> }) => computeLaneLineageImpl(args);
  const buildLaneConflictRiskSummaryLines = (laneId: string) => buildLaneConflictRiskSummaryLinesImpl(conflictPackBuilderDeps, laneId);

  const readContextDocMeta = () => contextDocService.getDocMeta();

  const buildProjectPackBody = (args: { reason: string; deterministicUpdatedAt: string; sourceLaneId?: string }) =>
    buildProjectPackBodyImpl(projectPackBuilderDeps, args);

  // Mission builder deps are defined lazily (below) because they reference closures
  // (getHeadSha, getPackIndexRow) that are defined later in this function.
  // See `missionPackBuilderDeps` and its wrappers below the core infrastructure section.

  const findBaselineVersionAtOrBefore = (args: { packKey: string; sinceIso: string }): { id: string; versionNumber: number; createdAt: string } | null => {
    const row = db.get<{ id: string; version_number: number; created_at: string }>(
      `
        select id, version_number, created_at
        from pack_versions
        where project_id = ?
          and pack_key = ?
          and created_at <= ?
        order by created_at desc
        limit 1
      `,
      [projectId, args.packKey, args.sinceIso]
    );
    if (!row?.id) return null;
    return { id: row.id, versionNumber: Number(row.version_number ?? 0), createdAt: row.created_at };
  };

  const classifyPackEvent = (args: {
    packKey: string;
    eventType: string;
    createdAt: string;
    payload: Record<string, unknown>;
  }): {
    importance: PackEventImportance;
    importanceScore: number;
    category: PackEventCategory;
    entityIds: string[];
    entityRefs: PackEventEntityRef[];
    actionType: string;
    rationale: string | null;
  } => {
    const eventType = args.eventType;
    const payload = args.payload ?? {};

    const entityIdsSet = new Set<string>();
    const entityRefs: PackEventEntityRef[] = [];

    const addEntity = (kind: string, idRaw: unknown) => {
      const id = typeof idRaw === "string" ? idRaw.trim() : "";
      if (!id) return;
      entityIdsSet.add(id);
      entityRefs.push({ kind, id });
    };

    if (args.packKey.startsWith("lane:")) addEntity("lane", args.packKey.slice("lane:".length));
    if (args.packKey.startsWith("conflict:")) {
      const parts = args.packKey.split(":");
      if (parts.length >= 2) addEntity("lane", parts[1]);
      if (parts.length >= 3) addEntity("peer", parts.slice(2).join(":"));
    }

    addEntity("lane", payload.laneId);
    addEntity("lane", payload.peerLaneId);
    addEntity("session", payload.sessionId);
    addEntity("checkpoint", payload.checkpointId);
    addEntity("version", payload.versionId);
    addEntity("operation", payload.operationId);
    addEntity("job", payload.jobId);
    addEntity("artifact", payload.artifactId);
    addEntity("proposal", payload.proposalId);

    const category: PackEventCategory = (() => {
      if (eventType.startsWith("narrative_")) return "narrative";
      if (eventType === "checkpoint") return "session";
      if (eventType.includes("conflict")) return "conflict";
      if (eventType.includes("branch")) return "branch";
      return "pack";
    })();

    const importance: PackEventImportance = (() => {
      if (eventType === "narrative_update") return "high";
      if (eventType === "narrative_failed") return "high";
      if (eventType === "checkpoint") return "medium";
      if (eventType === "refresh_triggered") return "medium";
      if (eventType === "narrative_requested") return "medium";
      return "low";
    })();

    const importanceScore = importance === "high" ? 0.9 : importance === "medium" ? 0.6 : 0.25;

    const rationale = (() => {
      const trigger = typeof payload.trigger === "string" ? payload.trigger.trim() : "";
      if (trigger) return trigger;
      const source = typeof payload.source === "string" ? payload.source.trim() : "";
      if (source) return source;
      return null;
    })();

    return {
      importance,
      importanceScore,
      category,
      entityIds: Array.from(entityIdsSet),
      entityRefs,
      actionType: eventType,
      rationale
    };
  };

  const ensureEventMeta = (event: PackEvent): PackEvent => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const hasMeta =
      payload.importance != null ||
      payload.importanceScore != null ||
      payload.category != null ||
      payload.entityIds != null ||
      payload.entityRefs != null ||
      payload.actionType != null ||
      payload.rationale != null;
    if (hasMeta) return event;

    const meta = classifyPackEvent({
      packKey: event.packKey,
      eventType: event.eventType,
      createdAt: event.createdAt,
      payload
    });

    return {
      ...event,
      payload: {
        ...payload,
        importance: meta.importance,
        importanceScore: meta.importanceScore,
        category: meta.category,
        entityIds: meta.entityIds,
        entityRefs: meta.entityRefs,
        actionType: meta.actionType,
        rationale: meta.rationale
      }
    };
  };

  const upsertEventMetaForInsert = (args: {
    packKey: string;
    eventType: string;
    createdAt: string;
    payload: Record<string, unknown>;
  }): Record<string, unknown> => {
    const payload = args.payload ?? {};
    const out: Record<string, unknown> = { ...payload };
    const meta = classifyPackEvent(args);

    if (out.importance == null) out.importance = meta.importance;
    if (out.importanceScore == null) out.importanceScore = meta.importanceScore;
    if (out.category == null) out.category = meta.category;
    if (out.entityIds == null) out.entityIds = meta.entityIds;
    if (out.entityRefs == null) out.entityRefs = meta.entityRefs;
    if (out.actionType == null) out.actionType = meta.actionType;
    if (out.rationale == null) out.rationale = meta.rationale;

    return out;
  };

  const readGatewayMeta = (): { apiBaseUrl: string | null; remoteProjectId: string | null } => {
    return { apiBaseUrl: null, remoteProjectId: null };
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

      // Conflict prediction summaries (v1) live under `conflicts/predictions/*.json`.
      const predictionsDir = path.join(conflictsDir, "predictions");
      if (fs.existsSync(predictionsDir)) {
        for (const entry of fs.readdirSync(predictionsDir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith(".json")) continue;
          const laneId = entry.name.slice(0, -".json".length);
          const lane = laneById.get(laneId);
          const absPath = path.join(predictionsDir, entry.name);
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

  const createPackEvent = (args: { packKey: string; eventType: string; payload?: Record<string, unknown> }): PackEvent => {
    const eventId = randomUUID();
    const createdAt = nowIso();
    const payload = upsertEventMetaForInsert({
      packKey: args.packKey,
      eventType: args.eventType,
      createdAt,
      payload: args.payload ?? {}
    });

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

    const event: PackEvent = ensureEventMeta({ id: eventId, packKey: args.packKey, eventType: args.eventType, payload, createdAt });

    try {
      const monthKey = createdAt.slice(0, 7); // YYYY-MM
      const monthDir = path.join(eventsDir, monthKey);
      ensureDir(monthDir);
      fs.writeFileSync(
        path.join(monthDir, `${eventId}.json`),
        JSON.stringify(event, null, 2),
        "utf8"
      );
    } catch {
      // ignore event file write failures
    }

    try {
      onEvent?.(event);
    } catch {
      // ignore broadcast failures
    }

    return event;
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

  const persistPackRefresh = (args: {
    packKey: string;
    packType: PackType;
    packPath: string;
    laneId: string | null;
    body: string;
    deterministicUpdatedAt: string;
    narrativeUpdatedAt?: string | null;
    lastHeadSha?: string | null;
    metadata?: Record<string, unknown>;
    eventType?: string;
    eventPayload?: Record<string, unknown>;
  }): PackSummary => {
    ensureDirFor(args.packPath);
    fs.writeFileSync(args.packPath, args.body, "utf8");

    createPackEvent({
      packKey: args.packKey,
      eventType: args.eventType ?? "refresh_triggered",
      payload: args.eventPayload ?? {}
    });

    const version = createPackVersion({ packKey: args.packKey, packType: args.packType, body: args.body });
    const metadata = {
      ...(args.metadata ?? {}),
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      contentHash: version.contentHash
    };

    upsertPackIndex({
      db,
      projectId,
      packKey: args.packKey,
      laneId: args.laneId,
      packType: args.packType,
      packPath: args.packPath,
      deterministicUpdatedAt: args.deterministicUpdatedAt,
      narrativeUpdatedAt: args.narrativeUpdatedAt ?? null,
      lastHeadSha: args.lastHeadSha ?? null,
      metadata
    });

    maybeCleanupPacks();

    return {
      packKey: args.packKey,
      packType: args.packType,
      path: args.packPath,
      exists: true,
      deterministicUpdatedAt: args.deterministicUpdatedAt,
      narrativeUpdatedAt: args.narrativeUpdatedAt ?? null,
      lastHeadSha: args.lastHeadSha ?? null,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      contentHash: version.contentHash,
      metadata,
      body: args.body
    };
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
            packEventIds: [event.id],
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
        JSON.stringify([event.id]),
        createdAt
      ]
    );

    return {
      id: checkpointId,
      laneId: args.laneId,
      sessionId: args.sessionId,
      sha: args.sha,
      diffStat,
      packEventIds: [event.id],
      createdAt
    };
  };

  const getHeadSha = async (worktreePath: string): Promise<string | null> => {
    const res = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 });
    if (res.exitCode !== 0) return null;
    const sha = res.stdout.trim();
    return sha.length ? sha : null;
  };
  const sessionDeltaService = createSessionDeltaService({ db, projectId, laneService, sessionService });

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
    const primaryLane = lanes.find((candidate) => candidate.laneType === "primary") ?? null;
    const parentLane = lane.parentLaneId ? lanes.find((candidate) => candidate.id === lane.parentLaneId) ?? null : null;

    const existingBody = readFileIfExists(getLanePackPath(laneId));
    const userIntent = extractSection(existingBody, ADE_INTENT_START, ADE_INTENT_END, "Intent not set — click to add.");
    const userTodos = extractSection(existingBody, ADE_TODOS_START, ADE_TODOS_END, "");

    const taskSpecFallback = [
      "Problem Statement:",
      "- (what are we solving, and for whom?)",
      "",
      "Scope:",
      "- (what is included?)",
      "",
      "Non-goals:",
      "- (what is explicitly out of scope?)",
      "",
      "Acceptance Criteria:",
      "- [ ] (add checkable acceptance criteria)",
      "",
      "Constraints / Conventions:",
      "- (languages, frameworks, patterns, performance, security, etc.)",
      "",
      "Dependencies:",
      `- Parent lane: ${parentLane ? parentLane.name : "(none)"}`,
      "- Required merges: (list lanes/PRs that must land first)"
    ].join("\n");
    const taskSpec = extractSection(existingBody, ADE_TASK_SPEC_START, ADE_TASK_SPEC_END, taskSpecFallback);

    const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
    const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
    const headSha = await getHeadSha(worktreePath);

    const isoTime = (value: string | null | undefined) => {
      const raw = typeof value === "string" ? value : "";
      return raw.length >= 16 ? raw.slice(11, 16) : raw;
    };

    const recentSessions = db.all<{
      id: string;
      title: string;
      goal: string | null;
      toolType: string | null;
      summary: string | null;
      lastOutputPreview: string | null;
      transcriptPath: string | null;
      resumeCommand: string | null;
      status: string;
      tracked: number;
      startedAt: string;
      endedAt: string | null;
      exitCode: number | null;
      filesChanged: number | null;
      insertions: number | null;
      deletions: number | null;
      touchedFilesJson: string | null;
      failureLinesJson: string | null;
    }>(
      `
        select
          s.id as id,
          s.title as title,
          s.goal as goal,
          s.tool_type as toolType,
          s.summary as summary,
          s.last_output_preview as lastOutputPreview,
          s.transcript_path as transcriptPath,
          s.resume_command as resumeCommand,
          s.status as status,
          s.tracked as tracked,
          s.started_at as startedAt,
          s.ended_at as endedAt,
          s.exit_code as exitCode,
          d.files_changed as filesChanged,
          d.insertions as insertions,
          d.deletions as deletions,
          d.touched_files_json as touchedFilesJson,
          d.failure_lines_json as failureLinesJson
        from terminal_sessions s
        left join session_deltas d on d.session_id = s.id
        where s.lane_id = ?
        order by s.started_at desc
        limit 30
      `,
      [laneId]
    );

    const sessionsTotal = Number(
      db.get<{ count: number }>("select count(1) as count from terminal_sessions where lane_id = ?", [laneId])?.count ?? 0
    );
    const sessionsRunning = Number(
      db.get<{ count: number }>(
        "select count(1) as count from terminal_sessions where lane_id = ? and status = 'running' and pty_id is not null",
        [laneId]
      )?.count ?? 0
    );

    const transcriptTailCache = new Map<string, string>();
    const getTranscriptTail = (transcriptPath: string | null): string => {
      const key = String(transcriptPath ?? "").trim();
      if (!key) return "";
      const cached = transcriptTailCache.get(key);
      if (cached != null) return cached;
      const tail = sessionService.readTranscriptTail(key, 140_000);
      transcriptTailCache.set(key, tail);
      return tail;
    };

    const latestTest = db.get<{
      run_id: string;
      suite_id: string;
      suite_name: string | null;
      command_json: string | null;
      status: TestRunStatus;
      duration_ms: number | null;
      ended_at: string | null;
    }>(
      `
        select
          r.id as run_id,
          r.suite_key as suite_id,
          s.name as suite_name,
          s.command_json as command_json,
          r.status as status,
          r.duration_ms as duration_ms,
          r.ended_at as ended_at
        from test_runs r
        left join test_suites s on s.project_id = r.project_id and s.id = r.suite_key
        where r.project_id = ?
          and r.lane_id = ?
        order by started_at desc
        limit 1
      `,
      [projectId, laneId]
    );

    const validationLines: string[] = [];
    if (latestTest) {
      const suiteLabel = (latestTest.suite_name ?? latestTest.suite_id).trim();
      validationLines.push(
        `Tests: ${statusFromCode(latestTest.status)} (suite=${suiteLabel}, duration=${latestTest.duration_ms ?? 0}ms)`
      );
      if (latestTest.command_json) {
        try {
          const command = JSON.parse(latestTest.command_json) as unknown;
          validationLines.push(`Tests command: ${formatCommand(command)}`);
        } catch {
          // ignore
        }
      }
    } else {
      const latestEnded = recentSessions.find((s) => Boolean(s.endedAt));
      const transcriptTail = latestEnded ? getTranscriptTail(latestEnded.transcriptPath) : "";
      const inferred = inferTestOutcomeFromText(transcriptTail);
      if (inferred) {
        validationLines.push(`Tests: ${inferred.status === "pass" ? "PASS" : "FAIL"} (inferred from terminal output)`);
      } else {
        validationLines.push("Tests: NOT RUN");
      }
    }

    const lintSession = recentSessions.find((s) => {
      const haystack = `${s.summary ?? ""} ${(s.goal ?? "")} ${s.title}`.toLowerCase();
      return haystack.includes("lint");
    });
    if (lintSession && lintSession.endedAt) {
      const lintStatus =
        lintSession.exitCode == null ? "ENDED" : lintSession.exitCode === 0 ? "PASS" : `FAIL (exit ${lintSession.exitCode})`;
      validationLines.push(`Lint: ${lintStatus}`);
    } else {
      validationLines.push("Lint: NOT RUN");
    }

    type FileDelta = { insertions: number | null; deletions: number | null };
    const deltas = new Map<string, FileDelta>();

    const addDelta = (filePath: string, insRaw: string, delRaw: string) => {
      const file = filePath.trim();
      if (!file) return;
      const ins = insRaw === "-" ? null : Number(insRaw);
      const del = delRaw === "-" ? null : Number(delRaw);
      const prev = deltas.get(file);

      const next: FileDelta = {
        insertions: Number.isFinite(ins as number) ? (ins as number) : ins,
        deletions: Number.isFinite(del as number) ? (del as number) : del
      };

      if (!prev) {
        deltas.set(file, next);
        return;
      }

      // Sum numeric changes; if either side is binary/unknown (null), preserve null.
      deltas.set(file, {
        insertions: prev.insertions == null || next.insertions == null ? null : prev.insertions + next.insertions,
        deletions: prev.deletions == null || next.deletions == null ? null : prev.deletions + next.deletions
      });
    };

    const addNumstat = (stdout: string) => {
      for (const line of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const insRaw = parts[0] ?? "0";
        const delRaw = parts[1] ?? "0";
        const filePath = parts.slice(2).join("\t").trim();
        addDelta(filePath, insRaw, delRaw);
      }
    };

    const mergeBaseSha = await (async (): Promise<string | null> => {
      const headRef = headSha ?? "HEAD";
      const baseRef = lane.baseRef?.trim() || "HEAD";
      const res = await runGit(["merge-base", headRef, baseRef], { cwd: projectRoot, timeoutMs: 12_000 });
      if (res.exitCode !== 0) return null;
      const sha = res.stdout.trim();
      return sha.length ? sha : null;
    })();

    if (mergeBaseSha && (headSha ?? "HEAD") !== mergeBaseSha) {
      const diff = await runGit(["diff", "--numstat", `${mergeBaseSha}..${headSha ?? "HEAD"}`], { cwd: projectRoot, timeoutMs: 20_000 });
      if (diff.exitCode === 0) addNumstat(diff.stdout);
    }

    // Add unstaged + staged separately to avoid double-counting (git diff HEAD includes both).
    const unstaged = await runGit(["diff", "--numstat"], { cwd: worktreePath, timeoutMs: 20_000 });
    if (unstaged.exitCode === 0) addNumstat(unstaged.stdout);
    const staged = await runGit(["diff", "--numstat", "--cached"], { cwd: worktreePath, timeoutMs: 20_000 });
    if (staged.exitCode === 0) addNumstat(staged.stdout);

    const statusRes = await runGit(["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs: 8_000 });
    if (statusRes.exitCode === 0) {
      const statusLines = statusRes.stdout.split("\n").map(l => l.trimEnd()).filter(Boolean);
      const newUntrackedPaths: string[] = [];

      for (const line of statusLines) {
        const statusCode = line.slice(0, 2);
        const raw = line.slice(2).trim();
        const arrow = raw.indexOf("->");
        const rel = arrow >= 0 ? raw.slice(arrow + 2).trim() : raw;
        if (!rel) continue;

        if (!deltas.has(rel)) {
          if (statusCode === "??") {
            newUntrackedPaths.push(rel);
          } else {
            deltas.set(rel, { insertions: 0, deletions: 0 });
          }
        }
      }

      // Count lines for untracked new files so they don't report 0/0
      for (const rel of newUntrackedPaths) {
        try {
          const fullPath = path.join(worktreePath, rel);
          const content = await fs.promises.readFile(fullPath, "utf-8");
          const lineCount = content.split("\n").length;
          deltas.set(rel, { insertions: lineCount, deletions: 0 });
        } catch {
          deltas.set(rel, { insertions: 0, deletions: 0 });
        }
      }
    }

    if (!deltas.size && latestDelta?.touchedFiles?.length) {
      for (const rel of latestDelta.touchedFiles.slice(0, 120)) {
        if (!deltas.has(rel)) deltas.set(rel, { insertions: 0, deletions: 0 });
      }
    }

    const whatChangedLines = (() => {
      const files = [...deltas.keys()];
      if (!files.length) return [];
      const byModule = new Map<string, string[]>();
      for (const file of files) {
        const module = moduleFromPath(file);
        const list = byModule.get(module) ?? [];
        list.push(file);
        byModule.set(module, list);
      }
      const entries = [...byModule.entries()]
        .map(([module, files]) => ({ module, files: files.sort(), count: files.length }))
        .sort((a, b) => b.count - a.count || a.module.localeCompare(b.module));
      return entries.slice(0, 12).map((entry) => {
        const examples = entry.files.slice(0, 3).join(", ");
        const suffix = entry.files.length > 3 ? `, +${entry.files.length - 3} more` : "";
        return `${entry.module}: ${entry.count} files (${examples}${suffix})`;
      });
    })();

    const inferredWhyLines = await (async (): Promise<string[]> => {
      if (!mergeBaseSha) return [];
      const res = await runGit(["log", "--oneline", `${mergeBaseSha}..${headSha ?? "HEAD"}`, "-n", "15"], {
        cwd: projectRoot,
        timeoutMs: 12_000
      });
      if (res.exitCode !== 0) return [];
      return res.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    })();

    const keyFiles = (() => {
      const scored = [...deltas.entries()].map(([file, delta]) => {
        const magnitude =
          delta.insertions == null || delta.deletions == null ? Number.MAX_SAFE_INTEGER : delta.insertions + delta.deletions;
        return { file, insertions: delta.insertions, deletions: delta.deletions, magnitude };
      });
      return scored
        .sort((a, b) => b.magnitude - a.magnitude || a.file.localeCompare(b.file))
        .slice(0, 25)
        .map(({ magnitude: _magnitude, ...rest }) => rest);
    })();

    const errors = (() => {
      const raw = latestDelta?.failureLines ?? [];
      const out: string[] = [];
      const seen = new Set<string>();
      for (const entry of raw) {
        const clean = stripAnsi(entry).trim().replace(/\s+/g, " ");
        if (!clean) continue;
        // Filter to the current detection heuristic so stale session_deltas rows don't spam packs.
        if (!/\b(error|failed|exception|fatal|traceback)\b/i.test(clean)) continue;
        const clipped = clean.length > 220 ? `${clean.slice(0, 219)}…` : clean;
        if (seen.has(clipped)) continue;
        seen.add(clipped);
        out.push(clipped);
      }
      return out;
    })();

    const sessionsDetailed = recentSessions.slice(0, 30).map((session) => {
      const tool = humanToolLabel(session.toolType);
      const goal = (session.goal ?? "").trim() || session.title;
      const result =
        session.endedAt == null
          ? "running"
          : session.exitCode == null
            ? "ended"
            : session.exitCode === 0
              ? "ok"
              : `exit ${session.exitCode}`;
      const delta =
        session.filesChanged != null ? `+${session.insertions ?? 0}/-${session.deletions ?? 0}` : "";
      const prompt = (session.resumeCommand ?? "").trim();
      const touchedFiles = safeJsonParseArray(session.touchedFilesJson);
      const failureLines = safeJsonParseArray(session.failureLinesJson);
      const commands: string[] = [];
      if (session.title && session.title !== goal) {
        commands.push(session.title);
      }
      return {
        when: isoTime(session.startedAt),
        tool,
        goal,
        result,
        delta,
        prompt,
        commands,
        filesTouched: touchedFiles.slice(0, 20),
        errors: failureLines.slice(0, 10)
      };
    });

    const nextSteps = (() => {
      const items: string[] = [];
      const intentSet = userIntent.trim().length && userIntent.trim() !== "Intent not set — click to add.";
      if (!intentSet) items.push("Set lane intent (Why section).");
      if (lane.status.dirty) items.push("Working tree is dirty; consider committing or stashing before switching lanes.");
      if (lane.status.behind > 0) items.push(`Lane is behind base by ${lane.status.behind} commits; consider syncing/rebasing.`);
      if (errors.length) items.push("Errors detected in the latest session output; review Errors & Issues.");
      if (latestTest && latestTest.status === "failed") items.push("Latest test run failed; fix failures before merging.");
      if (sessionsRunning > 0) items.push(`${sessionsRunning} terminal session(s) currently running.`);

      const latestFailedSession = recentSessions.find((s) => s.endedAt && (s.exitCode ?? 0) !== 0);
      if (latestFailedSession?.summary) items.push(`Recent failure: ${latestFailedSession.summary}`);

      return items;
    })();

    const requiredMerges = parentLane ? [parentLane.id] : [];
    const conflictState = deriveConflictStateForLane(laneId);
    const dependencyState: PackDependencyStateV1 = {
      requiredMerges,
      blockedByLanes: requiredMerges,
      mergeReadiness: computeMergeReadiness({
        requiredMerges,
        behindCount: lane.status.behind,
        conflictStatus: (conflictState?.status ?? null) as ConflictStatusValue | null
      })
    };

    const graph = buildGraphEnvelope(
      [
        {
          relationType: "depends_on",
          targetPackKey: "project",
          targetPackType: "project",
          rationale: "Lane context depends on project baseline."
        },
        ...(parentLane
          ? ([
              {
                relationType: "blocked_by",
                targetPackKey: `lane:${parentLane.id}`,
                targetPackType: "lane",
                targetLaneId: parentLane.id,
                targetBranch: parentLane.branchRef,
                rationale: "Lane is stacked on parent lane."
              },
              {
                relationType: "merges_into",
                targetPackKey: `lane:${parentLane.id}`,
                targetPackType: "lane",
                targetLaneId: parentLane.id,
                targetBranch: parentLane.branchRef,
                rationale: "Stacked lane merges into parent lane first."
              }
            ] satisfies PackRelation[])
          : [])
      ] satisfies PackRelation[]
    );

    const body = renderLanePackMarkdown({
      packKey: `lane:${laneId}`,
      projectId,
      laneId,
      laneName: lane.name,
      branchRef: lane.branchRef,
      baseRef: lane.baseRef,
      headSha,
      dirty: lane.status.dirty,
      ahead: lane.status.ahead,
      behind: lane.status.behind,
      parentName: parentLane?.name ?? (primaryLane && lane.laneType !== "primary" ? `${primaryLane.name} (primary)` : null),
      deterministicUpdatedAt,
      trigger: reason,
      providerMode,
      graph,
      dependencyState,
      conflictState,
      whatChangedLines,
      inferredWhyLines,
      userIntentMarkers: { start: ADE_INTENT_START, end: ADE_INTENT_END },
      userIntent,
      taskSpecMarkers: { start: ADE_TASK_SPEC_START, end: ADE_TASK_SPEC_END },
      taskSpec,
      validationLines,
      keyFiles,
      errors,
      sessionsDetailed,
      sessionsTotal: Number.isFinite(sessionsTotal) ? sessionsTotal : 0,
      sessionsRunning: Number.isFinite(sessionsRunning) ? sessionsRunning : 0,
      nextSteps,
      userTodosMarkers: { start: ADE_TODOS_START, end: ADE_TODOS_END },
      userTodos,
      laneDescription: lane.description ?? ""
    });

    return { body, lastHeadSha: headSha };
  };

  const getPackIndexRow = (packKey: string): {
    pack_type: PackType;
    lane_id: string | null;
    pack_path: string;
    deterministic_updated_at: string | null;
    narrative_updated_at: string | null;
    last_head_sha: string | null;
    metadata_json: string | null;
  } | null => {
    return db.get<{
      pack_type: PackType;
      lane_id: string | null;
      pack_path: string;
      deterministic_updated_at: string | null;
      narrative_updated_at: string | null;
      last_head_sha: string | null;
      metadata_json: string | null;
    }>(
      `
        select
          pack_type,
          lane_id,
          pack_path,
          deterministic_updated_at,
          narrative_updated_at,
          last_head_sha,
          metadata_json
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
      last_head_sha: null,
      metadata_json: null
    };
    const version = readCurrentPackVersion(packKey);
    return toPackSummaryFromRow({ packKey, row: effectiveRow, version });
  };

  const buildLiveLanePackSummary = async (args: {
    laneId: string;
 	    reason: string;
  }): Promise<PackSummary> => {
    const storedPack = getPackSummaryForKey(`lane:${args.laneId}`, {
      packType: "lane",
      packPath: getLanePackPath(args.laneId)
    });
    const deterministicUpdatedAt = nowIso();
    const latestDelta = sessionDeltaService.listRecentLaneSessionDeltas(args.laneId, 1)[0] ?? null;
    const { body, lastHeadSha } = await buildLanePackBody({
      laneId: args.laneId,
      reason: args.reason,
      latestDelta,
      deterministicUpdatedAt
    });
    return buildLivePackSummary({
      storedPack,
      body,
      deterministicUpdatedAt,
      lastHeadSha
    });
  };

  const buildLiveProjectPackSummary = async (args: {
    reason: string;
    sourceLaneId?: string;
  }): Promise<PackSummary> => {
    const storedPack = getPackSummaryForKey("project", {
      packType: "project",
      packPath: projectPackPath
    });
    const deterministicUpdatedAt = nowIso();
    const body = await buildProjectPackBody({
      reason: args.reason,
      deterministicUpdatedAt,
      sourceLaneId: args.sourceLaneId
    });
    return buildLivePackSummary({
      storedPack,
      body,
      deterministicUpdatedAt
    });
  };

  const buildLiveConflictPackSummary = async (args: {
    laneId: string;
    peerLaneId: string | null;
    reason: string;
  }): Promise<PackSummary> => {
    const lane = laneService.getLaneBaseAndBranch(args.laneId);
    const peerKey = args.peerLaneId ?? lane.baseRef;
    const storedPack = getPackSummaryForKey(`conflict:${args.laneId}:${peerKey}`, {
      packType: "conflict",
      packPath: getConflictPackPath(args.laneId, peerKey)
    });
    const deterministicUpdatedAt = nowIso();
    const { body, lastHeadSha } = await buildConflictPackBody({
      laneId: args.laneId,
      peerLaneId: args.peerLaneId,
      reason: args.reason,
      deterministicUpdatedAt
    });
    return buildLivePackSummary({
      storedPack,
      body,
      deterministicUpdatedAt,
      lastHeadSha
    });
  };

  const buildLivePlanPackSummary = async (args: {
    laneId: string;
    reason: string;
  }): Promise<PackSummary> => {
    const storedPack = getPackSummaryForKey(`plan:${args.laneId}`, {
      packType: "plan",
      packPath: getPlanPackPath(args.laneId)
    });
    const deterministicUpdatedAt = nowIso();
    const { body, headSha } = await buildPlanPackBody({
      laneId: args.laneId,
      reason: args.reason,
      deterministicUpdatedAt
    });
    return buildLivePackSummary({
      storedPack,
      body,
      deterministicUpdatedAt,
      lastHeadSha: headSha
    });
  };

  const buildLiveFeaturePackSummary = async (args: {
    featureKey: string;
    reason: string;
  }): Promise<PackSummary> => {
    const storedPack = getPackSummaryForKey(`feature:${args.featureKey}`, {
      packType: "feature",
      packPath: getFeaturePackPath(args.featureKey)
    });
    const deterministicUpdatedAt = nowIso();
    const { body } = await buildFeaturePackBody({
      featureKey: args.featureKey,
      reason: args.reason,
      deterministicUpdatedAt
    });
    return buildLivePackSummary({
      storedPack,
      body,
      deterministicUpdatedAt
    });
  };

  const buildLiveMissionPackSummary = async (args: {
    missionId: string;
    reason: string;
  }): Promise<PackSummary> => {
    const storedPack = getPackSummaryForKey(`mission:${args.missionId}`, {
      packType: "mission",
      packPath: getMissionPackPath(args.missionId)
    });
    const deterministicUpdatedAt = nowIso();
    const { body } = await buildMissionPackBody({
      missionId: args.missionId,
      reason: args.reason,
      deterministicUpdatedAt,
      runId: null
    });
    return buildLivePackSummary({
      storedPack,
      body,
      deterministicUpdatedAt
    });
  };

  // ── Mission/Plan/Feature builder wrappers ────────────────────────────────────

  const missionPackBuilderDeps: MissionPackBuilderDeps = {
    db,
    logger,
    projectRoot,
    projectId,
    packsDir,
    laneService,
    projectConfigService,
    getLanePackBody: async (laneId: string) => {
      const pack = await buildLiveLanePackSummary({
        laneId,
        reason: "context_export_dependency"
      });
      return pack.body;
    },
    readConflictPredictionPack,
    getHeadSha,
    getPackIndexRow
  };

  const buildFeaturePackBody = (args: { featureKey: string; reason: string; deterministicUpdatedAt: string }) =>
    buildFeaturePackBodyImpl(missionPackBuilderDeps, args);
  const buildPlanPackBody = (args: { laneId: string; reason: string; deterministicUpdatedAt: string }) =>
    buildPlanPackBodyImpl(missionPackBuilderDeps, args);
  const buildMissionPackBody = (args: { missionId: string; reason: string; deterministicUpdatedAt: string; runId?: string | null }) =>
    buildMissionPackBodyImpl(missionPackBuilderDeps, args);
  const buildConflictPackBody = (args: { laneId: string; peerLaneId: string | null; reason: string; deterministicUpdatedAt: string }) =>
    buildConflictPackBodyImpl(conflictPackBuilderDeps, args);

  const buildLivePackSummary = (args: {
    storedPack: PackSummary;
    body: string;
    deterministicUpdatedAt: string | null;
    narrativeUpdatedAt?: string | null;
    lastHeadSha?: string | null;
    metadata?: Record<string, unknown> | null;
  }): PackSummary => {
    const contentHash = sha256(args.body);
    const reuseStoredVersion =
      typeof args.storedPack.contentHash === "string" &&
      args.storedPack.contentHash === contentHash &&
      typeof args.storedPack.versionId === "string" &&
      args.storedPack.versionId.trim().length > 0;
    const versionId = reuseStoredVersion
      ? args.storedPack.versionId ?? null
      : `live:${args.storedPack.packKey}:${contentHash.slice(0, 16)}`;
    const versionNumber = reuseStoredVersion ? args.storedPack.versionNumber ?? null : null;

    return {
      ...args.storedPack,
      exists: args.body.trim().length > 0 || args.storedPack.exists,
      deterministicUpdatedAt: args.deterministicUpdatedAt,
      narrativeUpdatedAt: args.narrativeUpdatedAt ?? args.storedPack.narrativeUpdatedAt ?? null,
      lastHeadSha: args.lastHeadSha ?? args.storedPack.lastHeadSha ?? null,
      versionId,
      versionNumber,
      contentHash,
      metadata: args.metadata ?? args.storedPack.metadata ?? null,
      body: args.body
    };
  };

  const buildBasicExport = (args: {
    packKey: string;
    packType: "feature" | "plan" | "mission";
    level: ContextExportLevel;
    pack: PackSummary;
  }): PackExport => {
    const header = {
      schema: CONTEXT_HEADER_SCHEMA_V1,
      contractVersion: CONTEXT_CONTRACT_VERSION,
      projectId,
      packKey: args.packKey,
      packType: args.packType,
      exportLevel: args.level,
      deterministicUpdatedAt: args.pack.deterministicUpdatedAt ?? null,
      narrativeUpdatedAt: args.pack.narrativeUpdatedAt ?? null,
      versionId: args.pack.versionId ?? null,
      versionNumber: args.pack.versionNumber ?? null,
      contentHash: args.pack.contentHash ?? null
    } satisfies ContextHeaderV1;
    const content = args.pack.body;
    const approxTokens = Math.ceil(content.length / 4);
    const maxTokens = args.level === "lite" ? 30_000 : args.level === "standard" ? 60_000 : 120_000;
    const truncated = approxTokens > maxTokens;
    const finalContent = truncated ? content.slice(0, maxTokens * 4) : content;
    return {
      packKey: args.packKey,
      packType: args.packType,
      level: args.level,
      header,
      content: finalContent,
      approxTokens: Math.ceil(finalContent.length / 4),
      maxTokens,
      truncated,
      warnings: truncated ? [`${args.packType[0]!.toUpperCase()}${args.packType.slice(1)} pack content was truncated to fit token budget.`] : []
    };
  };

  return {
    getProjectPack(): PackSummary {
      const row = db.get<{
        pack_type: PackType;
        pack_path: string;
        deterministic_updated_at: string | null;
        narrative_updated_at: string | null;
        last_head_sha: string | null;
        metadata_json: string | null;
      }>(
        `
          select
            pack_type,
            pack_path,
            deterministic_updated_at,
            narrative_updated_at,
            last_head_sha,
            metadata_json
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
        metadata: null,
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
        metadata_json: string | null;
      }>(
        `
          select
            pack_type,
            pack_path,
            deterministic_updated_at,
            narrative_updated_at,
            last_head_sha,
            metadata_json
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
        metadata: null,
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

    getMissionPack(missionId: string): PackSummary {
      const id = missionId.trim();
      if (!id) throw new Error("missionId is required");
      const packKey = `mission:${id}`;
      return getPackSummaryForKey(packKey, { packType: "mission", packPath: getMissionPackPath(id) });
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
          ? await sessionDeltaService.computeSessionDelta(args.sessionId)
          : sessionDeltaService.listRecentLaneSessionDeltas(args.laneId, 1)[0] ?? null;
        const deterministicUpdatedAt = nowIso();
        const { body, lastHeadSha } = await buildLanePackBody({
          laneId: args.laneId,
          reason: args.reason,
          latestDelta,
          deterministicUpdatedAt
        });

        const packKey = `lane:${args.laneId}`;
        const packPath = getLanePackPath(args.laneId);
        const summary = persistPackRefresh({
          packKey,
          packType: "lane",
          packPath,
          laneId: args.laneId,
          body,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha,
          metadata: {
            reason: args.reason,
            sessionId: args.sessionId ?? null,
            latestDeltaSessionId: latestDelta?.sessionId ?? null,
            operationId: op.operationId
          },
          eventType: "refresh_triggered",
          eventPayload: {
            operationId: op.operationId,
            trigger: args.reason,
            laneId: args.laneId,
            sessionId: args.sessionId ?? null
          }
        });

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

        operationService.finish({
          operationId: op.operationId,
          status: "succeeded",
          postHeadSha: lastHeadSha,
          metadataPatch: {
            packPath,
            deterministicUpdatedAt,
            latestDeltaSessionId: latestDelta?.sessionId ?? null,
            versionId: summary.versionId ?? null,
            versionNumber: summary.versionNumber ?? null
          }
        });
        return summary;
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
        const summary = persistPackRefresh({
          packKey,
          packType: "project",
          packPath: projectPackPath,
          laneId: null,
          body,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha: null,
          metadata: {
            ...readContextDocMeta(),
            reason: args.reason,
            sourceLaneId: args.laneId ?? null,
            operationId: op.operationId
          },
          eventType: "refresh_triggered",
          eventPayload: {
            operationId: op.operationId,
            trigger: args.reason,
            laneId: args.laneId ?? null
          }
        });

        operationService.finish({
          operationId: op.operationId,
          status: "succeeded",
          metadataPatch: {
            packPath: projectPackPath,
            deterministicUpdatedAt,
            versionId: summary.versionId ?? null,
            versionNumber: summary.versionNumber ?? null
          }
        });
        return summary;
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

    async refreshMissionPack(args: { missionId: string; reason: string; runId?: string | null }): Promise<PackSummary> {
      const missionId = args.missionId.trim();
      if (!missionId) throw new Error("missionId is required");
      const packKey = `mission:${missionId}`;
      const deterministicUpdatedAt = nowIso();
      const built = await buildMissionPackBody({
        missionId,
        reason: args.reason,
        deterministicUpdatedAt,
        runId: args.runId ?? null
      });
      const packPath = getMissionPackPath(missionId);
      return persistPackRefresh({
        packKey,
        packType: "mission",
        packPath,
        laneId: built.laneId,
        body: built.body,
        deterministicUpdatedAt,
        narrativeUpdatedAt: null,
        lastHeadSha: null,
        metadata: {
          reason: args.reason,
          missionId,
          runId: args.runId ?? null
        },
        eventType: "refresh_triggered",
        eventPayload: {
          trigger: args.reason,
          missionId,
          runId: args.runId ?? null
        }
      });
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
      const packType = getPackIndexRow(row.pack_key)?.pack_type ?? inferPackTypeFromKey(row.pack_key);
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

    listEventsSince(args: ListPackEventsSinceArgs): PackEvent[] {
      const packKey = args.packKey.trim();
      if (!packKey) throw new Error("packKey is required");
      const sinceIso = args.sinceIso.trim();
      if (!sinceIso) throw new Error("sinceIso is required");
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 200;

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
            and created_at > ?
          order by created_at asc
          limit ?
        `,
        [projectId, packKey, sinceIso, limit]
      );

      return rows.map((row) =>
        ensureEventMeta({
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
        })
      );
    },

    getHeadVersion(args: { packKey: string }): PackHeadVersion {
      const packKey = args.packKey.trim();
      if (!packKey) throw new Error("packKey is required");
      const packType = getPackIndexRow(packKey)?.pack_type ?? inferPackTypeFromKey(packKey);
      const row = db.get<{
        id: string;
        version_number: number;
        content_hash: string;
        updated_at: string;
      }>(
        `
          select v.id as id,
                 v.version_number as version_number,
                 v.content_hash as content_hash,
                 h.updated_at as updated_at
          from pack_heads h
          join pack_versions v on v.id = h.current_version_id and v.project_id = h.project_id
          where h.project_id = ?
            and h.pack_key = ?
          limit 1
        `,
        [projectId, packKey]
      );

      return {
        packKey,
        packType,
        versionId: row?.id ?? null,
        versionNumber: row ? Number(row.version_number ?? 0) : null,
        contentHash: row?.content_hash != null ? String(row.content_hash) : null,
        updatedAt: row?.updated_at ?? null
      };
    },

    async getDeltaDigest(args: PackDeltaDigestArgs): Promise<PackDeltaDigestV1> {
      const packKey = (args.packKey ?? "").trim();
      if (!packKey) throw new Error("packKey is required");

      const minimum = args.minimumImportance ?? "medium";
      const limit = typeof args.limit === "number" ? Math.max(10, Math.min(500, Math.floor(args.limit))) : 200;

      const sinceVersionId = typeof args.sinceVersionId === "string" ? args.sinceVersionId.trim() : "";
      const sinceTimestamp = typeof args.sinceTimestamp === "string" ? args.sinceTimestamp.trim() : "";
      if (!sinceVersionId && !sinceTimestamp) {
        throw new Error("sinceVersionId or sinceTimestamp is required");
      }

      let baselineVersion: PackVersion | null = null;
      let baselineCreatedAt: string | null = null;
      let baselineVersionId: string | null = null;
      let baselineVersionNumber: number | null = null;
      let sinceIso = sinceTimestamp;

      if (sinceVersionId) {
        const v = this.getVersion(sinceVersionId);
        baselineVersion = v;
        baselineCreatedAt = v.createdAt;
        baselineVersionId = v.id;
        baselineVersionNumber = v.versionNumber;
        sinceIso = v.createdAt;
      } else {
        const parsed = Date.parse(sinceTimestamp);
        if (!Number.isFinite(parsed)) throw new Error("Invalid sinceTimestamp");
        const baseline = findBaselineVersionAtOrBefore({ packKey, sinceIso: sinceTimestamp });
        if (baseline?.id) {
          const v = this.getVersion(baseline.id);
          baselineVersion = v;
          baselineCreatedAt = v.createdAt;
          baselineVersionId = v.id;
          baselineVersionNumber = v.versionNumber;
          sinceIso = v.createdAt;
        }
      }

      const newVersion = this.getHeadVersion({ packKey });
      const packType: PackType = newVersion.packType;
      const afterBody = newVersion.versionId ? this.getVersion(newVersion.versionId).body : "";
      const beforeBody = baselineVersion?.body ?? null;

      const changedSections = computeSectionChanges({
        before: beforeBody,
        after: afterBody,
        locators: getDefaultSectionLocators(packType)
      });

      const eventsRaw = this.listEventsSince({ packKey, sinceIso, limit });
      const highImpactEvents = eventsRaw.filter((event) => {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        return importanceRank(payload.importance) >= importanceRank(minimum);
      });

      const conflictState = (() => {
        if (!packKey.startsWith("lane:")) return null;
        const laneId = packKey.slice("lane:".length);
        return deriveConflictStateForLane(laneId);
      })();

      const blockers: Array<{ kind: string; summary: string; entityIds?: string[] }> = [];
      if (packKey.startsWith("lane:")) {
        const laneId = packKey.slice("lane:".length);
        const row = db.get<{ parent_lane_id: string | null }>(
          "select parent_lane_id from lanes where id = ? and project_id = ? limit 1",
          [laneId, projectId]
        );
        const parentLaneId = row?.parent_lane_id ?? null;
        if (parentLaneId) {
          blockers.push({
            kind: "merge",
            summary: `Blocked by parent lane ${parentLaneId} (stacked lane).`,
            entityIds: [laneId, parentLaneId]
          });
        }
      }
      if (conflictState?.status === "conflict-active" || conflictState?.status === "conflict-predicted") {
        blockers.push({
          kind: "conflict",
          summary: `Conflicts: ${conflictState.status} (peerConflicts=${conflictState.peerConflictCount ?? 0}).`,
          entityIds: []
        });
      }
      if (conflictState?.truncated) {
        blockers.push({
          kind: "conflict",
          summary: `Conflict coverage is partial (strategy=${conflictState.strategy ?? "partial"}; pairs=${conflictState.pairwisePairsComputed ?? 0}/${conflictState.pairwisePairsTotal ?? 0}).`,
          entityIds: []
        });
      }

      const decisionReasons: string[] = [];
      let recommendedExportLevel: ContextExportLevel = "lite";
      if (changedSections.some((c) => c.sectionId === "narrative")) {
        recommendedExportLevel = "deep";
        decisionReasons.push("Narrative changed; deep export includes narrative content.");
      } else if (blockers.length || (conflictState?.status && conflictState.status !== "merge-ready")) {
        recommendedExportLevel = "standard";
        decisionReasons.push("Blockers/conflicts present; standard export recommended.");
      } else if (changedSections.length) {
        recommendedExportLevel = "standard";
        decisionReasons.push("Multiple sections changed; standard export recommended.");
      } else {
        decisionReasons.push("No material section changes detected; lite is sufficient.");
      }

      const handoffSummary = (() => {
        const parts: string[] = [];
        const baseLabel =
          baselineVersionNumber != null && newVersion.versionNumber != null
            ? `v${baselineVersionNumber} -> v${newVersion.versionNumber}`
            : `since ${sinceIso}`;
        parts.push(`${packKey} delta (${baseLabel}).`);
        if (changedSections.length) parts.push(`Changed: ${changedSections.map((c) => c.sectionId).join(", ")}.`);
        if (blockers.length) parts.push(`Blockers: ${blockers.map((b) => b.summary).join(" ")}`);
        if (highImpactEvents.length) {
          const top = highImpactEvents
            .slice(-6)
            .map((e) => `${e.eventType}${(e.payload as any)?.rationale ? ` (${String((e.payload as any).rationale)})` : ""}`);
          parts.push(`Events: ${top.join("; ")}.`);
        }
        if (conflictState?.lastPredictedAt) parts.push(`Conflicts last predicted at: ${conflictState.lastPredictedAt}.`);
        return parts.join(" ");
      })();

      const omittedSections: string[] = [];
      if (eventsRaw.length >= limit) {
        omittedSections.push("events:limit_cap");
      }
      if (conflictState?.truncated) {
        omittedSections.push("conflicts:partial_coverage");
      }
      const clipReason = omittedSections.length > 0 ? "budget_clipped" : null;

      return {
        packKey,
        packType,
        since: {
          sinceVersionId: sinceVersionId || null,
          sinceTimestamp: sinceTimestamp || sinceIso,
          baselineVersionId,
          baselineVersionNumber,
          baselineCreatedAt
        },
        newVersion,
        changedSections,
        highImpactEvents,
        blockers,
        conflicts: conflictState,
        decisionState: {
          recommendedExportLevel,
          reasons: decisionReasons
        },
        handoffSummary,
        clipReason,
        omittedSections: omittedSections.length ? omittedSections : null
      };
    },

    async getLaneExport(args: GetLaneExportArgs): Promise<PackExport> {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }

      const lanes = await laneService.list({ includeArchived: true });
      const lane = lanes.find((entry) => entry.id === laneId);
      if (!lane) throw new Error(`Lane not found: ${laneId}`);

      const pack = await buildLiveLanePackSummary({
        laneId,
        reason: "context_export"
      });

      const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
      const { apiBaseUrl, remoteProjectId } = readGatewayMeta();
      const docsMeta = readContextDocMeta();
      const conflictRiskSummaryLines = buildLaneConflictRiskSummaryLines(laneId);

      const conflictState = deriveConflictStateForLane(laneId);
      const lanesById = new Map(lanes.map((l) => [l.id, l] as const));
      const lineage = computeLaneLineage({ laneId, lanesById });

      const requiredMerges = lane.parentLaneId ? [lane.parentLaneId] : [];
      const dependencyState: PackDependencyStateV1 = {
        requiredMerges,
        blockedByLanes: requiredMerges,
        mergeReadiness: computeMergeReadiness({
          requiredMerges,
          behindCount: lane.status.behind,
          conflictStatus: (conflictState?.status ?? null) as ConflictStatusValue | null
        })
      };

      const predictionPack = readConflictPredictionPack(laneId);
      const lastConflictRefreshAt =
        asString(predictionPack?.lastRecomputedAt).trim() || asString(predictionPack?.generatedAt).trim() || null;
      const lastConflictRefreshAgeMs = (() => {
        if (!lastConflictRefreshAt) return null;
        const ts = Date.parse(lastConflictRefreshAt);
        if (!Number.isFinite(ts)) return null;
        return Math.max(0, Date.now() - ts);
      })();
      const ttlMs = Number((predictionPack as any)?.stalePolicy?.ttlMs ?? NaN);
      const staleTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 5 * 60_000;
      const predictionStale = lastConflictRefreshAgeMs != null ? lastConflictRefreshAgeMs > staleTtlMs : null;
      const staleReason =
        predictionStale && lastConflictRefreshAgeMs != null
          ? `lastConflictRefreshAgeMs=${lastConflictRefreshAgeMs} ttlMs=${staleTtlMs}`
          : null;

      const activeConflictPackKeys = (() => {
        const out: string[] = [];
        if (predictionPack?.status) out.push(`conflict:${laneId}:${lane.baseRef}`);
        const overlaps = Array.isArray(predictionPack?.overlaps) ? predictionPack!.overlaps! : [];
        const score = (v: ConflictRiskLevel) => (v === "high" ? 3 : v === "medium" ? 2 : v === "low" ? 1 : 0);
        const peers = overlaps
          .filter((ov) => ov && ov.peerId != null)
          .map((ov) => ({
            peerId: asString(ov.peerId).trim(),
            riskLevel: normalizeRiskLevel(asString(ov.riskLevel)) ?? "none",
            fileCount: Array.isArray(ov.files) ? ov.files.length : 0
          }))
          .filter((ov) => ov.peerId.length)
          .sort((a, b) => score(b.riskLevel) - score(a.riskLevel) || b.fileCount - a.fileCount || a.peerId.localeCompare(b.peerId))
          .slice(0, 6);
        for (const peer of peers) out.push(`conflict:${laneId}:${peer.peerId}`);
        return uniqueSorted(out);
      })();

      // --- Orchestrator summary ---
      const orchestratorSummary: OrchestratorLaneSummaryV1 = (() => {
        // Completion signal
        let completionSignal: LaneCompletionSignal = "in-progress";
        if (lane.status.ahead === 0) {
          completionSignal = "not-started";
        } else if (conflictState?.status === "conflict-active") {
          completionSignal = "blocked";
        } else if (
          lane.status.ahead > 0 &&
          !lane.status.dirty &&
          conflictState?.status === "merge-ready"
        ) {
          completionSignal = "review-ready";
        }

        // Touched files — extract from Key Files table in pack body
        const touchedFiles: string[] = [];
        const keyFilesRe = /\|\s*`([^`]+)`/g;
        let kfMatch: RegExpExecArray | null;
        const bodyText = pack.body ?? "";
        const keyFilesStart = bodyText.indexOf("## Key Files");
        if (keyFilesStart !== -1) {
          const keyFilesSection = bodyText.slice(keyFilesStart, bodyText.indexOf("\n## ", keyFilesStart + 1) >>> 0 || bodyText.length);
          while ((kfMatch = keyFilesRe.exec(keyFilesSection)) !== null) {
            const fp = kfMatch[1].trim();
            if (fp.length > 0 && !touchedFiles.includes(fp)) touchedFiles.push(fp);
          }
        }

        // Peer overlaps from prediction pack
        const peerOverlaps = (Array.isArray(predictionPack?.overlaps) ? predictionPack!.overlaps : [])
          .filter((ov: any) => ov && ov.peerId)
          .slice(0, 10)
          .map((ov: any) => ({
            peerId: String(ov.peerId ?? "").trim(),
            files: Array.isArray(ov.files) ? ov.files.map(String).slice(0, 20) : [],
            risk: (normalizeRiskLevel(String(ov.riskLevel ?? "")) ?? "none") as ConflictRiskLevel
          }))
          .filter((ov: { peerId: string }) => ov.peerId.length > 0);

        // Blockers
        const blockers: string[] = [];
        if (lane.status.dirty) blockers.push("dirty working tree");
        if (conflictState?.status === "conflict-active") blockers.push("active merge conflict");
        if (conflictState?.status === "conflict-predicted") blockers.push("predicted conflicts with peer lanes");
        if (lane.status.behind > 0) blockers.push(`behind base by ${lane.status.behind} commits`);

        return {
          laneId,
          completionSignal,
          touchedFiles: touchedFiles.slice(0, 50),
          peerOverlaps,
          suggestedMergeOrder: null,
          blockers
        };
      })();

      const manifest: LaneExportManifestV1 = {
        schema: "ade.manifest.lane.v1",
        projectId,
        laneId,
        laneName: lane.name,
        laneType: lane.laneType,
        worktreePath: lane.worktreePath,
        branchRef: lane.branchRef,
        baseRef: lane.baseRef,
        contextFingerprint: docsMeta.contextFingerprint,
        contextVersion: docsMeta.contextVersion,
        lastDocsRefreshAt: docsMeta.lastDocsRefreshAt,
        ...(docsMeta.docsStaleReason ? { docsStaleReason: docsMeta.docsStaleReason } : {}),
        lineage,
        mergeConstraints: {
          requiredMerges,
          blockedByLanes: requiredMerges,
          mergeReadiness: dependencyState.mergeReadiness ?? "unknown"
        },
        branchState: {
          baseRef: lane.baseRef,
          headRef: lane.branchRef,
          headSha: pack.lastHeadSha ?? null,
          lastPackRefreshAt: pack.deterministicUpdatedAt ?? null,
          isEditProtected: lane.isEditProtected,
          packStale: false
        },
        conflicts: {
          activeConflictPackKeys,
          unresolvedPairCount: conflictState?.unresolvedPairCount ?? 0,
          lastConflictRefreshAt,
          lastConflictRefreshAgeMs,
          ...(predictionPack?.truncated != null ? { truncated: Boolean(predictionPack.truncated) } : {}),
          ...(asString(predictionPack?.strategy).trim() ? { strategy: asString(predictionPack?.strategy).trim() } : {}),
          ...(Number.isFinite(Number(predictionPack?.pairwisePairsComputed)) ? { pairwisePairsComputed: Number(predictionPack?.pairwisePairsComputed) } : {}),
          ...(Number.isFinite(Number(predictionPack?.pairwisePairsTotal)) ? { pairwisePairsTotal: Number(predictionPack?.pairwisePairsTotal) } : {}),
          predictionStale,
          predictionStalenessMs: lastConflictRefreshAgeMs,
          stalePolicy: { ttlMs: staleTtlMs },
          ...(staleReason ? { staleReason } : {}),
          unresolvedResolutionState: null
        },
        orchestratorSummary
      };

      const graph = buildGraphEnvelope(
        [
          {
            relationType: "depends_on",
            targetPackKey: "project",
            targetPackType: "project",
            rationale: "Lane export depends on project context."
          },
          ...(lane.parentLaneId
            ? ([
                {
                  relationType: "blocked_by",
                  targetPackKey: `lane:${lane.parentLaneId}`,
                  targetPackType: "lane",
                  targetLaneId: lane.parentLaneId,
                  rationale: "Stacked lane depends on parent lane landing first."
                },
                {
                  relationType: "merges_into",
                  targetPackKey: `lane:${lane.parentLaneId}`,
                  targetPackType: "lane",
                  targetLaneId: lane.parentLaneId,
                  rationale: "Stacked lane merges into parent lane first."
                }
              ] satisfies PackRelation[])
            : ([
                {
                  relationType: "merges_into",
                  targetPackKey: `lane:${lineage.baseLaneId ?? laneId}`,
                  targetPackType: "lane",
                  targetLaneId: lineage.baseLaneId ?? laneId,
                  rationale: "Lane merges into base lane."
                }
              ] satisfies PackRelation[]))
        ] satisfies PackRelation[]
      );

      return buildLaneExport({
        level,
        projectId,
        laneId,
        laneName: lane.name,
        branchRef: lane.branchRef,
        baseRef: lane.baseRef,
        headSha: pack.lastHeadSha ?? null,
        pack,
        providerMode,
        apiBaseUrl,
        remoteProjectId,
        graph,
        manifest,
        dependencyState,
        conflictState,
        markers: {
          taskSpecStart: ADE_TASK_SPEC_START,
          taskSpecEnd: ADE_TASK_SPEC_END,
          intentStart: ADE_INTENT_START,
          intentEnd: ADE_INTENT_END,
          todosStart: ADE_TODOS_START,
          todosEnd: ADE_TODOS_END,
          narrativeStart: ADE_NARRATIVE_START,
          narrativeEnd: ADE_NARRATIVE_END
        },
        conflictRiskSummaryLines
      });
    },

    async getProjectExport(args: GetProjectExportArgs): Promise<PackExport> {
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }
      const pack = await buildLiveProjectPackSummary({
        reason: "context_export"
      });
      const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
      const { apiBaseUrl, remoteProjectId } = readGatewayMeta();
      const docsMeta = readContextDocMeta();

      const lanes = await laneService.list({ includeArchived: false });
      const lanesById = new Map(lanes.map((lane) => [lane.id, lane] as const));
      const lanesTotal = lanes.length;
      const maxIncluded = level === "lite" ? 10 : level === "standard" ? 25 : 80;
      const included = [...lanes]
        .filter((lane) => !lane.archivedAt)
        .sort((a, b) => a.stackDepth - b.stackDepth || a.name.localeCompare(b.name))
        .slice(0, maxIncluded);

      const laneEntries: ProjectManifestLaneEntryV1[] = included.map((lane) => {
        const lineage = computeLaneLineage({ laneId: lane.id, lanesById });
        const requiredMerges = lane.parentLaneId ? [lane.parentLaneId] : [];
        const conflictState = deriveConflictStateForLane(lane.id);
        const mergeReadiness = computeMergeReadiness({
          requiredMerges,
          behindCount: lane.status.behind,
          conflictStatus: (conflictState?.status ?? null) as ConflictStatusValue | null
        });

        return {
          laneId: lane.id,
          laneName: lane.name,
          laneType: lane.laneType,
          branchRef: lane.branchRef,
          baseRef: lane.baseRef,
          worktreePath: lane.worktreePath,
          isEditProtected: Boolean(lane.isEditProtected),
          status: lane.status,
          lineage,
          mergeConstraints: {
            requiredMerges,
            blockedByLanes: requiredMerges,
            mergeReadiness
          },
          branchState: {
            baseRef: lane.baseRef,
            headRef: lane.branchRef,
            headSha: null,
            lastPackRefreshAt: null,
            isEditProtected: lane.isEditProtected,
            packStale: false
          },
          conflictState
        };
      });

      const manifest: ProjectExportManifestV1 = {
        schema: "ade.manifest.project.v1",
        projectId,
        generatedAt: new Date().toISOString(),
        contextFingerprint: docsMeta.contextFingerprint,
        contextVersion: docsMeta.contextVersion,
        lastDocsRefreshAt: docsMeta.lastDocsRefreshAt,
        ...(docsMeta.docsStaleReason ? { docsStaleReason: docsMeta.docsStaleReason } : {}),
        lanesTotal,
        lanesIncluded: included.length,
        lanesOmitted: Math.max(0, lanesTotal - included.length),
        lanes: laneEntries
      };

      const graph = buildGraphEnvelope(
        laneEntries.map((lane) => ({
          relationType: "parent_of",
          targetPackKey: `lane:${lane.laneId}`,
          targetPackType: "lane",
          targetLaneId: lane.laneId,
          targetBranch: lane.branchRef,
          rationale: "Project contains lane context."
        })) satisfies PackRelation[]
      );

      return buildProjectExport({ level, projectId, pack, providerMode, apiBaseUrl, remoteProjectId, graph, manifest });
    },

    async getConflictExport(args: GetConflictExportArgs): Promise<PackExport> {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const peerLaneId = args.peerLaneId?.trim() || null;
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }

      const lane = laneService.getLaneBaseAndBranch(laneId);
      const peerKey = peerLaneId ?? lane.baseRef;
      const packKey = `conflict:${laneId}:${peerKey}`;
      const peerLabel = peerLaneId ? `lane:${peerLaneId}` : `base:${lane.baseRef}`;

      const pack = await buildLiveConflictPackSummary({
        laneId,
        peerLaneId,
        reason: "context_export"
      });
      const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
      const { apiBaseUrl, remoteProjectId } = readGatewayMeta();

      const predictionPack = readConflictPredictionPack(laneId);
      const matrix = Array.isArray(predictionPack?.matrix) ? predictionPack!.matrix! : [];
      const entry =
        peerLaneId == null
          ? (matrix.find((m) => asString(m.laneAId).trim() === laneId && asString(m.laneBId).trim() === laneId) ?? null)
          : (matrix.find((m) => {
              const a = asString(m.laneAId).trim();
              const b = asString(m.laneBId).trim();
              return (a === laneId && b === peerLaneId) || (a === peerLaneId && b === laneId);
            }) ?? null);

      const ttlMs = Number((predictionPack as any)?.stalePolicy?.ttlMs ?? NaN);
      const staleTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 5 * 60_000;
      const nowMs = Date.now();
      const predictionAt =
        asString((entry as any)?.computedAt).trim() ||
        asString((predictionPack as any)?.predictionAt).trim() ||
        asString((predictionPack as any)?.status?.lastPredictedAt).trim() ||
        null;
      const predictionAgeMs = (() => {
        if (!predictionAt) return null;
        const ts = Date.parse(predictionAt);
        if (!Number.isFinite(ts)) return null;
        return Math.max(0, nowMs - ts);
      })();
      const predictionStale = predictionAgeMs != null ? predictionAgeMs > staleTtlMs : null;
      const staleReason = predictionStale && predictionAgeMs != null ? `predictionAgeMs=${predictionAgeMs} ttlMs=${staleTtlMs}` : null;

      const openConflictSummaries = (() => {
        const raw = Array.isArray(predictionPack?.openConflictSummaries) ? predictionPack!.openConflictSummaries! : null;
        if (raw) {
          return raw
            .map((s) => {
              const riskLevel = normalizeRiskLevel(asString(s.riskLevel)) ?? "none";
              const lastSeenAt = asString(s.lastSeenAt).trim() || null;
              const lastSeenAgeMs = (() => {
                if (!lastSeenAt) return null;
                const ts = Date.parse(lastSeenAt);
                if (!Number.isFinite(ts)) return null;
                return Math.max(0, nowMs - ts);
              })();
              return {
                peerId: s.peerId ?? null,
                peerLabel: asString(s.peerLabel).trim() || "unknown",
                riskLevel,
                fileCount: Number.isFinite(Number(s.fileCount)) ? Number(s.fileCount) : 0,
                lastSeenAt,
                lastSeenAgeMs,
                riskSignals: Array.isArray(s.riskSignals) ? (s.riskSignals as string[]).map((v) => String(v)) : []
              };
            })
            .slice(0, 12);
        }

        const overlaps = Array.isArray(predictionPack?.overlaps) ? predictionPack!.overlaps! : [];
        const summaries: ConflictLineageV1["openConflictSummaries"] = [];
        for (const ov of overlaps) {
          const peerId = (ov.peerId ?? null) as string | null;
          const peerLabel = peerId ? `lane:${peerId}` : `base:${lane.baseRef}`;
          const riskLevel = normalizeRiskLevel(asString(ov.riskLevel)) ?? "none";
          const fileCount = Array.isArray(ov.files) ? ov.files.length : 0;
          const signals: string[] = [];
          if (riskLevel === "high") signals.push("high_risk");
          if (fileCount > 0) signals.push("overlap_files");
          if (predictionPack?.truncated) signals.push("partial_coverage");
          summaries.push({
            peerId,
            peerLabel,
            riskLevel,
            fileCount,
            lastSeenAt: null,
            lastSeenAgeMs: null,
            riskSignals: signals
          });
        }
        return summaries.slice(0, 12);
      })();

      const lineage: ConflictLineageV1 = {
        schema: "ade.conflictLineage.v1",
        laneId,
        peerKey,
        predictionAt,
        predictionAgeMs,
        predictionStale,
        ...(staleReason ? { staleReason } : {}),
        lastRecomputedAt:
          asString((predictionPack as any)?.lastRecomputedAt).trim() || asString((predictionPack as any)?.generatedAt).trim() || null,
        truncated: predictionPack?.truncated != null ? Boolean(predictionPack.truncated) : null,
        strategy: asString(predictionPack?.strategy).trim() || null,
        pairwisePairsComputed: Number.isFinite(Number(predictionPack?.pairwisePairsComputed)) ? Number(predictionPack?.pairwisePairsComputed) : null,
        pairwisePairsTotal: Number.isFinite(Number(predictionPack?.pairwisePairsTotal)) ? Number(predictionPack?.pairwisePairsTotal) : null,
        stalePolicy: { ttlMs: staleTtlMs },
        openConflictSummaries,
        unresolvedResolutionState: await readGitConflictState(laneId).catch(() => null)
      };

      const graph = buildGraphEnvelope(
        [
          {
            relationType: "depends_on",
            targetPackKey: `lane:${laneId}`,
            targetPackType: "lane",
            targetLaneId: laneId,
            targetBranch: lane.branchRef,
            targetHeadCommit: pack.lastHeadSha ?? null,
            rationale: "Conflict export depends on lane pack."
          },
          ...(peerLaneId
            ? ([
                {
                  relationType: "depends_on",
                  targetPackKey: `lane:${peerLaneId}`,
                  targetPackType: "lane",
                  targetLaneId: peerLaneId,
                  rationale: "Conflict export depends on peer lane pack."
                }
              ] satisfies PackRelation[])
            : ([
                {
                  relationType: "shares_base",
                  targetPackKey: "project",
                  targetPackType: "project",
                  rationale: "Base conflicts are computed against project base ref."
                }
              ] satisfies PackRelation[]))
        ] satisfies PackRelation[]
      );

      return buildConflictExport({
        level,
        projectId,
        packKey,
        laneId,
        peerLabel,
        pack,
        providerMode,
        apiBaseUrl,
        remoteProjectId,
        graph,
        lineage
      });
    },

    async getFeatureExport(args: { featureKey: string; level: ContextExportLevel }): Promise<PackExport> {
      const featureKey = args.featureKey.trim();
      if (!featureKey) throw new Error("featureKey is required");
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }
      const packKey = `feature:${featureKey}`;
      const pack = await buildLiveFeaturePackSummary({
        featureKey,
        reason: "context_export"
      });
      return buildBasicExport({ packKey, packType: "feature", level, pack });
    },

    async getPlanExport(args: { laneId: string; level: ContextExportLevel }): Promise<PackExport> {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }
      const packKey = `plan:${laneId}`;
      const pack = await buildLivePlanPackSummary({
        laneId,
        reason: "context_export"
      });
      return buildBasicExport({ packKey, packType: "plan", level, pack });
    },

    async getMissionExport(args: { missionId: string; level: ContextExportLevel }): Promise<PackExport> {
      const missionId = args.missionId.trim();
      if (!missionId) throw new Error("missionId is required");
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }
      const packKey = `mission:${missionId}`;
      const pack = await buildLiveMissionPackSummary({
        missionId,
        reason: "context_export"
      });
      return buildBasicExport({ packKey, packType: "mission", level, pack });
    },
  };
}
