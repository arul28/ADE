#!/usr/bin/env node
/**
 * Reads `.ade/ade.db` for a project and writes
 * `src/renderer/browser-mock-ade-snapshot.generated.json` for the Vite-in-browser
 * mock (`window.ade` / browserMock).
 *
 * Usage:
 *   node ./scripts/export-browser-mock-ade-snapshot.mjs [PROJECT_ROOT]
 *   ADE_PROJECT_ROOT=/path/to/repo node ./scripts/export-browser-mock-ade-snapshot.mjs
 *   node ./scripts/export-browser-mock-ade-snapshot.mjs --optional
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_ROOT = path.resolve(__dirname, "../src/renderer");
const OUT_FILE = path.join(
  RENDERER_ROOT,
  "browser-mock-ade-snapshot.generated.json",
);
const REPO_ROOT_FROM_SCRIPT = path.resolve(__dirname, "../../..");

const args = process.argv.slice(2);
const optional = args.includes("--optional");
const positionalRoot = args.find((arg) => !arg.startsWith("-"));

function resolveProjectRoot() {
  if (process.env.ADE_PROJECT_ROOT) {
    return path.resolve(process.env.ADE_PROJECT_ROOT);
  }
  if (positionalRoot) {
    return path.resolve(positionalRoot);
  }
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, ".."),
    path.resolve(cwd, "../.."),
    path.resolve(cwd, "../../.."),
    REPO_ROOT_FROM_SCRIPT,
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, ".ade", "ade.db"))) {
      return candidate;
    }
  }
  return REPO_ROOT_FROM_SCRIPT;
}

const projectRoot = resolveProjectRoot();
const dbPath = path.join(projectRoot, ".ade", "ade.db");

async function removeStaleSnapshot(reason) {
  try {
    await fs.unlink(OUT_FILE);
    console.warn(`[export-browser-mock-ade] Removed stale snapshot: ${reason}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (!existsSync(dbPath)) {
  const message =
    `[export-browser-mock-ade] No database at ${dbPath}\n` +
    "Open the project in ADE (Electron) once, or set ADE_PROJECT_ROOT to a repo with .ade/ade.db";
  if (optional) {
    await removeStaleSnapshot("no .ade/ade.db found");
    console.warn(`${message}\n[export-browser-mock-ade] Continuing with built-in browser mock data.`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true, open: true });
db.exec("PRAGMA busy_timeout = 5000");

const MAX_CHAT_TRANSCRIPT_EVENTS_PER_SESSION = 5000;

function hasTable(name) {
  const row = db
    .prepare(
      "select 1 as ok from sqlite_master where type = 'table' and name = ?",
    )
    .get(name);
  return Boolean(row);
}

function safeJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function isChatToolType(toolType) {
  const normalized = String(toolType ?? "").trim().toLowerCase();
  return Boolean(
    normalized
      && (
        normalized === "codex-chat"
        || normalized === "claude-chat"
        || normalized === "opencode-chat"
        || normalized === "cursor"
        || normalized.endsWith("-chat")
      ),
  );
}

function transcriptPathCandidates(session) {
  const candidates = [];
  const rawPath = String(session.transcriptPath ?? "").trim();
  if (rawPath) {
    candidates.push(path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath));
  }
  candidates.push(
    path.join(projectRoot, ".ade", "transcripts", `${session.id}.chat.jsonl`),
    path.join(projectRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`),
  );
  return Array.from(new Set(candidates));
}

function parseChatTranscript(raw, sessionId) {
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.length) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.type === "session_init") continue;
      if (parsed?.sessionId !== sessionId || !parsed?.event || typeof parsed.event !== "object") continue;
      events.push(parsed);
    } catch {
      // Ignore malformed transcript lines, matching the runtime transcript parser.
    }
  }
  return events.length > MAX_CHAT_TRANSCRIPT_EVENTS_PER_SESSION
    ? events.slice(-MAX_CHAT_TRANSCRIPT_EVENTS_PER_SESSION)
    : events;
}

async function buildChatTranscripts(sessions) {
  const transcripts = {};
  for (const session of sessions.filter((entry) => isChatToolType(entry.toolType))) {
    for (const candidate of transcriptPathCandidates(session)) {
      try {
        const raw = await fs.readFile(candidate, "utf8");
        transcripts[session.id] = {
          path: candidate,
          events: parseChatTranscript(raw, session.id),
        };
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.warn(`[export-browser-mock-ade] Could not read transcript ${candidate}: ${error.message ?? error}`);
        }
      }
    }
  }
  return transcripts;
}

function allRows(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function getRow(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function maybeAll(table, sql, params = []) {
  return hasTable(table) ? allRows(sql, params) : [];
}

function normalizeBranchRef(ref) {
  const raw = String(ref ?? "main").trim() || "main";
  return raw.startsWith("refs/") ? raw : `refs/heads/${raw.replace(/^refs\/heads\//, "")}`;
}

function branchName(ref) {
  return String(ref ?? "").replace(/^refs\/heads\//, "");
}

function rowToPr(row) {
  return {
    id: String(row.id),
    laneId: String(row.lane_id),
    projectId: String(row.project_id),
    repoOwner: String(row.repo_owner ?? ""),
    repoName: String(row.repo_name ?? ""),
    githubPrNumber: Number(row.github_pr_number ?? 0),
    githubUrl: String(row.github_url ?? ""),
    githubNodeId: row.github_node_id ?? null,
    title: String(row.title ?? ""),
    state: row.state ?? "open",
    baseBranch: String(row.base_branch ?? "main"),
    headBranch: String(row.head_branch ?? ""),
    checksStatus: row.checks_status ?? "none",
    reviewStatus: row.review_status ?? "none",
    additions: Number(row.additions ?? 0),
    deletions: Number(row.deletions ?? 0),
    lastSyncedAt: row.last_synced_at ?? null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    creationStrategy: row.creation_strategy ?? null,
  };
}

function normalizePrSnapshot(row) {
  return {
    prId: String(row.pr_id),
    detail: safeJson(row.detail_json, null),
    status: safeJson(row.status_json, null),
    checks: safeJson(row.checks_json, []),
    reviews: safeJson(row.reviews_json, []),
    comments: safeJson(row.comments_json, []),
    files: safeJson(row.files_json, []),
    commits: safeJson(row.commits_json, []),
    updatedAt: row.updated_at ?? null,
  };
}

function buildMergeContexts(prs, lanes, projectId) {
  const contexts = Object.fromEntries(
    prs.map((pr) => [
      pr.id,
      {
        prId: pr.id,
        groupId: null,
        groupType: null,
        sourceLaneIds: [pr.laneId].filter(Boolean),
        targetLaneId: lanes.find((lane) => lane.laneType === "primary")?.id ?? null,
        integrationLaneId: null,
        members: [],
      },
    ]),
  );

  if (!hasTable("pr_groups") || !hasTable("pr_group_members")) {
    return contexts;
  }

  const rows = allRows(
    `
      select
        pg.id as group_id,
        pg.group_type as group_type,
        pg.target_branch as target_branch,
        pg.name as group_name,
        pgm.pr_id as pr_id,
        pgm.lane_id as lane_id,
        pgm.position as position,
        pgm.role as role,
        p.github_pr_number as github_pr_number,
        l.name as lane_name
      from pr_groups pg
      left join pr_group_members pgm on pgm.group_id = pg.id
      left join pull_requests p on p.id = pgm.pr_id
      left join lanes l on l.id = pgm.lane_id
      where pg.project_id = ?
      order by pg.id asc, pgm.position asc
    `,
    [projectId],
  );

  const membersByGroup = new Map();
  const groups = new Map();
  for (const row of rows) {
    const groupId = String(row.group_id);
    groups.set(groupId, row);
    if (!row.pr_id && !row.lane_id) continue;
    const bucket = membersByGroup.get(groupId) ?? [];
    bucket.push({
      prId: row.pr_id ?? null,
      laneId: row.lane_id ?? null,
      laneName: row.lane_name ?? null,
      prNumber: row.github_pr_number == null ? null : Number(row.github_pr_number),
      position: Number(row.position ?? 0),
      role: row.role ?? "source",
    });
    membersByGroup.set(groupId, bucket);
  }

  for (const [groupId, group] of groups) {
    const members = membersByGroup.get(groupId) ?? [];
    for (const member of members) {
      if (!member.prId) continue;
      contexts[member.prId] = {
        prId: member.prId,
        groupId,
        groupType: group.group_type ?? null,
        sourceLaneIds: members
          .filter((candidate) => candidate.role !== "target" && candidate.laneId)
          .map((candidate) => candidate.laneId),
        targetLaneId: lanes.find((lane) => branchName(lane.branchRef) === group.target_branch)?.id ?? null,
        integrationLaneId:
          members.find((candidate) => candidate.role === "integration")?.laneId ?? null,
        members,
      };
    }
  }
  return contexts;
}

function rowToQueueState(row) {
  return {
    queueId: String(row.id),
    groupId: String(row.group_id),
    groupName: row.group_name ?? null,
    targetBranch: row.target_branch ?? null,
    state: row.state ?? "idle",
    entries: safeJson(row.entries_json, []),
    currentPosition: Number(row.current_position ?? 0),
    activePrId: row.active_pr_id ?? null,
    activeResolverRunId: row.active_resolver_run_id ?? null,
    lastError: row.last_error ?? null,
    waitReason: row.wait_reason ?? null,
    config: {
      method: "squash",
      archiveLane: false,
      autoResolve: false,
      ciGating: true,
      resolverProvider: null,
      resolverModel: null,
      reasoningEffort: null,
      permissionMode: "guarded_edit",
      confidenceThreshold: null,
      originSurface: "manual",
      originMissionId: null,
      originRunId: null,
      originLabel: null,
      ...safeJson(row.config_json, {}),
    },
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
    updatedAt: row.updated_at ?? row.completed_at ?? row.started_at,
  };
}

function rowToIntegrationWorkflow(row) {
  return {
    proposalId: String(row.id),
    sourceLaneIds: safeJson(row.source_lane_ids_json, []),
    baseBranch: row.base_branch ?? "main",
    pairwiseResults: safeJson(row.pairwise_results_json, []),
    laneSummaries: safeJson(row.lane_summaries_json, []),
    steps: safeJson(row.steps_json, []),
    overallOutcome: row.overall_outcome ?? "clean",
    createdAt: row.created_at,
    title: row.title ?? null,
    body: row.body ?? null,
    draft: Boolean(row.draft),
    integrationLaneName: row.integration_lane_name ?? null,
    status: row.status ?? "simulated",
    integrationLaneId: row.integration_lane_id ?? null,
    linkedGroupId: row.linked_group_id ?? null,
    linkedPrId: row.linked_pr_id ?? null,
    workflowDisplayState: row.workflow_display_state ?? "active",
    cleanupState: row.cleanup_state ?? "none",
    closedAt: row.closed_at ?? null,
    mergedAt: row.merged_at ?? null,
    completedAt: row.completed_at ?? null,
    cleanupDeclinedAt: row.cleanup_declined_at ?? null,
    cleanupCompletedAt: row.cleanup_completed_at ?? null,
    resolutionState: safeJson(row.resolution_state_json, null),
    preferredIntegrationLaneId: row.preferred_integration_lane_id ?? null,
    mergeIntoHeadSha: row.merge_into_head_sha ?? null,
  };
}

function latestConflictByLane(projectId) {
  const out = new Map();
  const rows = maybeAll(
    "conflict_predictions",
    `
      select lane_a_id, status, conflicting_files_json, overlap_files_json, predicted_at
      from conflict_predictions
      where project_id = ?
      order by predicted_at desc
    `,
    [projectId],
  );
  for (const row of rows) {
    if (!row.lane_a_id || out.has(row.lane_a_id)) continue;
    out.set(row.lane_a_id, {
      status: row.status,
      conflictingFiles: safeJson(row.conflicting_files_json, []),
      overlapFiles: safeJson(row.overlap_files_json, []),
      predictedAt: row.predicted_at ?? null,
    });
  }
  return out;
}

function buildRebaseNeeds({ lanes, prs, projectId }) {
  const dismissed = new Map(
    maybeAll(
      "rebase_dismissed",
      "select lane_id, dismissed_at from rebase_dismissed where project_id = ?",
      [projectId],
    ).map((row) => [row.lane_id, row.dismissed_at]),
  );
  const deferred = new Map(
    maybeAll(
      "rebase_deferred",
      "select lane_id, deferred_until from rebase_deferred where project_id = ?",
      [projectId],
    ).map((row) => [row.lane_id, row.deferred_until]),
  );
  const conflicts = latestConflictByLane(projectId);
  const prByLane = new Map(prs.map((pr) => [pr.laneId, pr]));
  return lanes
    .filter((lane) => lane.laneType !== "primary")
    .map((lane) => {
      const state = lane.status ?? {};
      const conflict = conflicts.get(lane.id);
      const conflictFiles = Array.isArray(conflict?.conflictingFiles)
        ? conflict.conflictingFiles.map((file) => (typeof file === "string" ? file : file?.path)).filter(Boolean)
        : [];
      const behindBy = Number(state.behind ?? 0);
      const conflictPredicted = conflict?.status === "conflict" || conflictFiles.length > 0;
      if (behindBy <= 0 && !conflictPredicted && !dismissed.has(lane.id) && !deferred.has(lane.id)) {
        return null;
      }
      return {
        laneId: lane.id,
        laneName: lane.name,
        kind: "lane_base",
        baseBranch: lane.baseRef ?? "main",
        behindBy,
        conflictPredicted,
        conflictingFiles: conflictFiles,
        prId: prByLane.get(lane.id)?.id ?? null,
        groupContext: null,
        dismissedAt: dismissed.get(lane.id) ?? null,
        deferredUntil: deferred.get(lane.id) ?? null,
      };
    })
    .filter(Boolean);
}

function buildGithubSnapshot({ prs, lanes, mergeContexts, integrationWorkflows }) {
  const workflowByPr = new Map(
    integrationWorkflows.filter((workflow) => workflow.linkedPrId).map((workflow) => [workflow.linkedPrId, workflow]),
  );
  return {
    repo: prs[0] ? { owner: prs[0].repoOwner, name: prs[0].repoName } : null,
    viewerLogin: null,
    syncedAt: new Date().toISOString(),
    repoPullRequests: prs.map((pr) => {
      const ctx = mergeContexts[pr.id] ?? null;
      const workflow = workflowByPr.get(pr.id) ?? null;
      const lane = lanes.find((candidate) => candidate.id === pr.laneId);
      return {
        id: pr.id,
        scope: "repo",
        repoOwner: pr.repoOwner,
        repoName: pr.repoName,
        githubPrNumber: pr.githubPrNumber,
        githubUrl: pr.githubUrl,
        title: pr.title,
        state: pr.state,
        isDraft: pr.state === "draft",
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        author: null,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        linkedPrId: pr.id,
        linkedGroupId: workflow?.linkedGroupId ?? ctx?.groupId ?? null,
        linkedLaneId: pr.laneId,
        linkedLaneName: lane?.name ?? pr.laneId,
        adeKind: workflow ? "integration" : (ctx?.groupType ?? "single"),
        workflowDisplayState: workflow?.workflowDisplayState ?? null,
        cleanupState: workflow?.cleanupState ?? null,
      };
    }),
    externalPullRequests: [],
  };
}

function buildMissionSummaries(projectId) {
  if (!hasTable("missions")) return [];
  return allRows(
    `
      select
        m.*,
        l.name as lane_name,
        ml.name as mission_lane_name,
        rl.name as result_lane_name,
        (select count(*) from mission_artifacts ma where ma.mission_id = m.id) as artifact_count,
        (select count(*) from mission_interventions mi where mi.mission_id = m.id and mi.status = 'open') as open_interventions,
        (select count(*) from mission_steps ms where ms.mission_id = m.id) as total_steps,
        (select count(*) from mission_steps ms where ms.mission_id = m.id and ms.status = 'completed') as completed_steps
      from missions m
      left join lanes l on l.id = m.lane_id
      left join lanes ml on ml.id = m.mission_lane_id
      left join lanes rl on rl.id = m.result_lane_id
      where m.project_id = ?
        and m.archived_at is null
      order by m.updated_at desc, m.created_at desc
      limit 300
    `,
    [projectId],
  ).map((row) => ({
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    laneId: row.lane_id,
    laneName: row.lane_name,
    missionLaneId: row.mission_lane_id ?? null,
    missionLaneName: row.mission_lane_name ?? null,
    resultLaneId: row.result_lane_id ?? null,
    resultLaneName: row.result_lane_name ?? null,
    status: row.status,
    priority: row.priority,
    executionMode: row.execution_mode,
    targetMachineId: row.target_machine_id,
    outcomeSummary: row.outcome_summary,
    lastError: row.last_error,
    artifactCount: Number(row.artifact_count ?? 0),
    openInterventions: Number(row.open_interventions ?? 0),
    totalSteps: Number(row.total_steps ?? 0),
    completedSteps: Number(row.completed_steps ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

function buildMissionDashboard(missions) {
  const activeStatuses = new Set(["queued", "planning", "plan_review", "in_progress", "intervention_required"]);
  const completed = missions.filter((mission) => mission.status === "completed").length;
  const failed = missions.filter((mission) => mission.status === "failed").length;
  const finished = completed + failed;
  return {
    active: missions.filter((mission) => activeStatuses.has(mission.status)).slice(0, 50),
    recent: missions.slice(0, 12),
    weekly: {
      missions: missions.length,
      successRate: finished > 0 ? completed / finished : 0,
      avgDurationMs: 0,
      totalCostUsd: 0,
    },
  };
}

function buildMissionFullViews({ projectId, missions }) {
  if (!missions.length) return {};
  const steps = maybeAll(
    "mission_steps",
    "select * from mission_steps where project_id = ? order by mission_id asc, step_index asc",
    [projectId],
  );
  const artifacts = maybeAll(
    "mission_artifacts",
    "select * from mission_artifacts where project_id = ? order by created_at desc",
    [projectId],
  );
  const interventions = maybeAll(
    "mission_interventions",
    "select * from mission_interventions where project_id = ? order by created_at desc",
    [projectId],
  );
  const stepsByMission = Map.groupBy
    ? Map.groupBy(steps, (row) => row.mission_id)
    : groupBy(steps, (row) => row.mission_id);
  const artifactsByMission = Map.groupBy
    ? Map.groupBy(artifacts, (row) => row.mission_id)
    : groupBy(artifacts, (row) => row.mission_id);
  const interventionsByMission = Map.groupBy
    ? Map.groupBy(interventions, (row) => row.mission_id)
    : groupBy(interventions, (row) => row.mission_id);
  return Object.fromEntries(
    missions.map((mission) => [
      mission.id,
      {
        mission,
        steps: (stepsByMission.get(mission.id) ?? []).map((row) => ({
          id: row.id,
          missionId: row.mission_id,
          index: Number(row.step_index ?? 0),
          title: row.title,
          detail: row.detail,
          kind: row.kind,
          laneId: row.lane_id,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          metadata: safeJson(row.metadata_json, {}),
        })),
        artifacts: (artifactsByMission.get(mission.id) ?? []).map((row) => ({
          id: row.id,
          missionId: row.mission_id,
          artifactType: row.artifact_type,
          title: row.title,
          description: row.description,
          uri: row.uri,
          laneId: row.lane_id,
          metadata: safeJson(row.metadata_json, {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          createdBy: row.created_by,
        })),
        interventions: (interventionsByMission.get(mission.id) ?? []).map((row) => ({
          id: row.id,
          missionId: row.mission_id,
          interventionType: row.intervention_type,
          status: row.status,
          resolutionKind: row.resolution_kind,
          title: row.title,
          body: row.body,
          requestedAction: row.requested_action,
          resolutionNote: row.resolution_note,
          laneId: row.lane_id,
          metadata: safeJson(row.metadata_json, {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          resolvedAt: row.resolved_at,
        })),
        runGraph: null,
        checkpoints: [],
        dashboard: null,
      },
    ]),
  );
}

function groupBy(items, keyFn) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }
  return grouped;
}

function buildOperations(projectId) {
  return maybeAll(
    "operations",
    `
      select
        o.id as id,
        o.lane_id as laneId,
        l.name as laneName,
        o.kind as kind,
        o.started_at as startedAt,
        o.ended_at as endedAt,
        o.status as status,
        o.pre_head_sha as preHeadSha,
        o.post_head_sha as postHeadSha,
        o.metadata_json as metadataJson
      from operations o
      left join lanes l on l.id = o.lane_id
      where o.project_id = ?
      order by o.started_at desc
      limit 500
    `,
    [projectId],
  );
}

function buildSessions(projectId) {
  return maybeAll(
    "terminal_sessions",
    `
      select ts.*, l.name as lane_name
      from terminal_sessions ts
      left join lanes l on l.id = ts.lane_id
      where ts.archived_at is null
      order by coalesce(ts.last_output_at, ts.ended_at, ts.started_at) desc
      limit 200
    `,
  ).map((row) => ({
    id: row.id,
    laneId: row.lane_id,
    laneName: row.lane_name ?? row.lane_id,
    ptyId: row.pty_id ?? null,
    tracked: Boolean(row.tracked),
    pinned: Boolean(row.pinned),
    manuallyNamed: Boolean(row.manually_named),
    goal: row.goal ?? null,
    toolType: row.tool_type ?? null,
    title: row.title ?? row.goal ?? "Session",
    status: row.status ?? "disposed",
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    archivedAt: row.archived_at ?? null,
    exitCode: row.exit_code ?? null,
    transcriptPath: row.transcript_path ?? "",
    headShaStart: row.head_sha_start ?? null,
    headShaEnd: row.head_sha_end ?? null,
    lastOutputPreview: row.last_output_preview ?? null,
    summary: row.summary ?? null,
    runtimeState: row.status === "running" ? "running" : "exited",
    resumeCommand: row.resume_command ?? null,
    resumeMetadata: safeJson(row.resume_metadata_json, null),
  }));
}

function buildProcessDefinitions(projectId) {
  return maybeAll(
    "process_definitions",
    "select * from process_definitions where project_id = ? order by name asc",
    [projectId],
  ).map((row) => ({
    id: row.key ?? row.id,
    name: row.name,
    command: safeJson(row.command_json, []),
    cwd: row.cwd ?? ".",
    env: safeJson(row.env_json, {}),
    groupIds: [],
    autostart: Boolean(row.autostart),
    restart: row.restart_policy ?? "never",
    gracefulShutdownMs: Number(row.graceful_shutdown_ms ?? 7000),
    dependsOn: safeJson(row.depends_on_json, []),
    readiness: safeJson(row.readiness_json, { type: "none" }),
  }));
}

function buildProcessRuntime(projectId) {
  return maybeAll(
    "process_runtime",
    "select * from process_runtime where project_id = ? order by updated_at desc limit 500",
    [projectId],
  ).map((row) => ({
    runId: `${row.lane_id}:${row.process_key}`,
    laneId: row.lane_id,
    processId: row.process_key,
    status: row.status ?? "stopped",
    readiness: row.readiness ?? "unknown",
    pid: row.pid ?? null,
    sessionId: null,
    ptyId: null,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    exitCode: row.exit_code ?? null,
    lastExitCode: row.exit_code ?? null,
    lastEndedAt: row.ended_at ?? null,
    uptimeMs: null,
    ports: [],
    logPath: null,
    updatedAt: row.updated_at ?? row.ended_at ?? row.started_at ?? new Date().toISOString(),
  }));
}

function buildUsageSnapshot() {
  const rows = maybeAll(
    "ai_usage_log",
    "select * from ai_usage_log order by timestamp desc limit 200",
  );
  const byModel = new Map();
  for (const row of rows) {
    const key = `${row.provider ?? "unknown"}:${row.model ?? "unknown"}`;
    const item = byModel.get(key) ?? {
      provider: row.provider ?? "unknown",
      model: row.model ?? "unknown",
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
    };
    item.inputTokens += Number(row.input_tokens ?? 0);
    item.outputTokens += Number(row.output_tokens ?? 0);
    item.calls += 1;
    byModel.set(key, item);
  }
  return {
    windows: [],
    pacing: {
      status: "on-track",
      projectedWeeklyPercent: 0,
      weekElapsedPercent: 0,
      expectedPercent: 0,
      deltaPercent: 0,
      etaHours: null,
      willLastToReset: true,
      resetsInHours: 168,
    },
    costs: [...byModel.values()],
    extraUsage: [],
    lastPolledAt: new Date().toISOString(),
    errors: [],
  };
}

function getCtoState(projectId) {
  const identityRow = hasTable("cto_identity_state")
    ? getRow("select payload_json from cto_identity_state where project_id = ? order by updated_at desc limit 1", [projectId])
    : null;
  const coreRow = hasTable("cto_core_memory_state")
    ? getRow("select payload_json from cto_core_memory_state where project_id = ? order by updated_at desc limit 1", [projectId])
    : null;
  return {
    identity: safeJson(identityRow?.payload_json, null),
    coreMemory: safeJson(coreRow?.payload_json, null),
    recentSessions: [],
  };
}

function buildAutomations(projectId) {
  const runs = maybeAll(
    "automation_runs",
    "select * from automation_runs where project_id = ? order by started_at desc limit 100",
    [projectId],
  ).map((row) => ({
    id: row.id,
    automationId: row.automation_id,
    chatSessionId: row.chat_session_id,
    missionId: row.mission_id,
    triggerType: row.trigger_type,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    executionKind: row.execution_kind,
    actionsCompleted: Number(row.actions_completed ?? 0),
    actionsTotal: Number(row.actions_total ?? 0),
    errorMessage: row.error_message,
    spendUsd: row.spend_usd,
    confidence: safeJson(row.confidence_json, null),
    triggerMetadata: safeJson(row.trigger_metadata, null),
    summary: row.summary,
    billingCode: row.billing_code,
  }));
  const ingressEvents = maybeAll(
    "automation_ingress_events",
    "select * from automation_ingress_events where project_id = ? order by received_at desc limit 100",
    [projectId],
  ).map((row) => ({
    id: row.id,
    source: row.source,
    eventKey: row.event_key,
    automationIds: safeJson(row.automation_ids_json, []),
    triggerType: row.trigger_type,
    eventName: row.event_name,
    status: row.status,
    summary: row.summary,
    errorMessage: row.error_message,
    cursor: row.cursor,
    receivedAt: row.received_at,
  }));
  return { rules: [], runs, ingressEvents };
}

if (!hasTable("projects") || !hasTable("lanes")) {
  const message = "[export-browser-mock-ade] projects/lanes tables missing; is this a valid ADE database?";
  if (optional) {
    await removeStaleSnapshot("invalid ADE database");
    console.warn(`${message}\n[export-browser-mock-ade] Continuing with built-in browser mock data.`);
    db.close();
    process.exit(0);
  }
  console.error(message);
  db.close();
  process.exit(1);
}

const projectRow =
  getRow(
    `select id, display_name as displayName, root_path as rootPath, default_base_ref as defaultBaseRef,
            created_at as createdAt, last_opened_at as lastOpenedAt
     from projects
     where root_path = ?
     order by last_opened_at desc, created_at desc
     limit 1`,
    [projectRoot],
  ) ??
  getRow(
    `select id, display_name as displayName, root_path as rootPath, default_base_ref as defaultBaseRef,
            created_at as createdAt, last_opened_at as lastOpenedAt
     from projects
     order by last_opened_at desc, created_at desc
     limit 1`,
  );

if (!projectRow) {
  const message = `[export-browser-mock-ade] No project row for root_path=${projectRoot}`;
  if (optional) {
    await removeStaleSnapshot("no project row found");
    console.warn(`${message}\n[export-browser-mock-ade] Continuing with built-in browser mock data.`);
    db.close();
    process.exit(0);
  }
  console.error(message);
  db.close();
  process.exit(1);
}

const projectId = String(projectRow.id);
const hasLaneSnapshots = hasTable("lane_state_snapshots");

const laneRows = allRows(
  `select id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
          is_edit_protected, parent_lane_id, color, icon, tags_json, folder, mission_id, lane_role,
          status, created_at, archived_at
   from lanes
   where project_id = ?
     and coalesce(status, 'active') != 'archived'
     and archived_at is null
   order by
     case when lane_type = 'primary' then 0 else 1 end,
     created_at asc,
     name asc`,
  [projectId],
);

const laneStateRows = hasLaneSnapshots
  ? allRows(
      `select lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress
       from lane_state_snapshots`,
    )
  : [];
const laneStateById = new Map(laneStateRows.map((row) => [row.lane_id, row]));

const lanes = laneRows.map((row) => {
  const laneId = String(row.id);
  const snap = laneStateById.get(laneId);
  return {
    id: laneId,
    name: String(row.name),
    description: row.description,
    laneType: row.lane_type,
    baseRef: String(row.base_ref ?? projectRow.defaultBaseRef ?? "main"),
    branchRef: normalizeBranchRef(row.branch_ref),
    worktreePath: String(row.worktree_path ?? projectRoot),
    attachedRootPath: row.attached_root_path,
    isEditProtected: Boolean(row.is_edit_protected),
    parentLaneId: row.parent_lane_id,
    color: row.color,
    icon: row.icon,
    tags: safeJson(row.tags_json, []),
    folder: row.folder,
    missionId: row.mission_id,
    laneRole: row.lane_role,
    status: {
      dirty: Boolean(snap?.dirty),
      ahead: Number(snap?.ahead ?? 0),
      behind: Number(snap?.behind ?? 0),
      remoteBehind: Number(snap?.remote_behind ?? -1),
      rebaseInProgress: Boolean(snap?.rebase_in_progress),
    },
    createdAt: String(row.created_at),
    archivedAt: row.archived_at,
  };
});

const prs = maybeAll(
  "pull_requests",
  "select * from pull_requests where project_id = ? order by updated_at desc",
  [projectId],
).map(rowToPr);

const prSnapshots = maybeAll(
  "pull_request_snapshots",
  `
    select s.*
    from pull_request_snapshots s
    join pull_requests p on p.id = s.pr_id and p.project_id = ?
    order by p.updated_at desc
  `,
  [projectId],
).map(normalizePrSnapshot);

const queueStates = maybeAll(
  "queue_landing_state",
  `
    select qls.*, pg.name as group_name, pg.target_branch as target_branch
    from queue_landing_state qls
    left join pr_groups pg on pg.id = qls.group_id
    where qls.project_id = ?
    order by qls.updated_at desc, qls.started_at desc
    limit 50
  `,
  [projectId],
).map(rowToQueueState);

const integrationWorkflows = maybeAll(
  "integration_proposals",
  "select * from integration_proposals where project_id = ? order by created_at desc limit 100",
  [projectId],
).map(rowToIntegrationWorkflow);

const mergeContexts = buildMergeContexts(prs, lanes, projectId);
const rebaseNeeds = buildRebaseNeeds({ lanes, prs, projectId });
const githubSnapshot = buildGithubSnapshot({ prs, lanes, mergeContexts, integrationWorkflows });
const missions = buildMissionSummaries(projectId);
const operations = buildOperations(projectId);
const sessions = buildSessions(projectId);
const processDefinitions = buildProcessDefinitions(projectId);
const processRuntime = buildProcessRuntime(projectId);
const automations = buildAutomations(projectId);
const missionDashboard = buildMissionDashboard(missions);
const missionFullViews = buildMissionFullViews({ projectId, missions });
const usageSnapshot = buildUsageSnapshot();
const ctoState = getCtoState(projectId);

db.close();

const chatTranscripts = await buildChatTranscripts(sessions);

const snapshot = {
  version: 2,
  exportedAt: new Date().toISOString(),
  project: {
    id: String(projectRow.id),
    name: String(projectRow.displayName),
    rootPath: String(projectRow.rootPath),
    gitDefaultBranch: String(projectRow.defaultBaseRef ?? "main"),
    createdAt: projectRow.createdAt
      ? String(projectRow.createdAt)
      : new Date().toISOString(),
  },
  lanes,
  prs,
  prSnapshots,
  prMergeContexts: mergeContexts,
  queueStates,
  integrationWorkflows,
  rebaseNeeds,
  githubSnapshot,
  missions,
  missionDashboard,
  missionFullViews,
  operations,
  sessions,
  chatTranscripts,
  processDefinitions,
  processRuntime,
  usageSnapshot,
  ctoState,
  automations,
  stripInlineDemo: true,
};

await fs.writeFile(OUT_FILE, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
console.log(
  `[export-browser-mock-ade] Wrote browser snapshot for ${projectRow.displayName} → ${OUT_FILE}\n` +
    `  lanes=${lanes.length} prs=${prs.length} prSnapshots=${prSnapshots.length} operations=${operations.length} sessions=${sessions.length} chatTranscripts=${Object.keys(chatTranscripts).length} processes=${processDefinitions.length}/${processRuntime.length} missions=${missions.length}\n` +
    "Restart Vite or refresh the browser to pick up the updated data.",
);
