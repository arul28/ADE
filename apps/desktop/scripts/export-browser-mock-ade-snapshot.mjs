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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
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
const USAGE_SNAPSHOT_CACHE_VERSION = 2;
const USAGE_SNAPSHOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const args = process.argv.slice(2);
const optional = args.includes("--optional");
const positionalRoot = args.find((arg) => !arg.startsWith("-"));

function resolveWorktreeParentRoot(dir) {
  const sep = path.sep;
  const parts = dir.split(sep);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] === "worktrees" && i > 0 && parts[i - 1] === ".ade") {
      const root = parts.slice(0, i - 1).join(sep) || sep;
      return path.resolve(root);
    }
  }
  return null;
}

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
  const worktreeParent = resolveWorktreeParentRoot(cwd) ?? resolveWorktreeParentRoot(REPO_ROOT_FROM_SCRIPT);
  if (worktreeParent) candidates.push(worktreeParent);
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

function normalizeRelExport(rel) {
  let s = String(rel ?? "").trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (s === "." || s === "/") return "";
  return s.replace(/\/+$/, "");
}

function languageIdFromPathExport(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".json") return "json";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".md") return "markdown";
  if (ext === ".py") return "python";
  if (ext === ".rs") return "rust";
  if (ext === ".go") return "go";
  if (ext === ".java") return "java";
  if (ext === ".c" || ext === ".h" || ext === ".cpp" || ext === ".hpp") return "cpp";
  if (ext === ".sh") return "shell";
  if (ext === ".css") return "css";
  if (ext === ".html") return "html";
  if (ext === ".swift") return "swift";
  return "plaintext";
}

function hasNullByteBuffer(buf) {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Walk each lane worktree on disk (export-time only) and embed shallow listTree-compatible rows
 * plus optional text file payloads for the Vite browser mock.
 */
function buildFilesBrowserSnapshot(lanes) {
  const MAX_DIRS = 220;
  const MAX_CONTENT_FILES = 48;
  const MAX_CONTENT_BYTES = 120_000;
  const trees = {};
  const contents = {};
  let dirsVisited = 0;
  let contentFiles = 0;
  let contentBytes = 0;

  const shouldCaptureContent = (relPath, size) => {
    if (size > 100_000) return false;
    return /\.(md|txt|json|ya?ml|ts|tsx|mjs|cjs|css|html|swift)$/i.test(relPath);
  };

  for (const lane of lanes) {
    const wsId = String(lane.id);
    const absRoot = path.resolve(String(lane.worktreePath ?? ""));
    const treeForWs = {};
    const contentsForWs = {};

    if (!existsSync(absRoot)) {
      trees[wsId] = treeForWs;
      contents[wsId] = contentsForWs;
      continue;
    }
    let rootStat;
    try {
      rootStat = statSync(absRoot);
    } catch {
      trees[wsId] = treeForWs;
      contents[wsId] = contentsForWs;
      continue;
    }
    if (!rootStat.isDirectory()) {
      trees[wsId] = treeForWs;
      contents[wsId] = contentsForWs;
      continue;
    }

    const queue = [];
    const seenDirs = new Set();
    const enqueue = (relKey) => {
      const key = normalizeRelExport(relKey);
      if (seenDirs.has(key)) return;
      seenDirs.add(key);
      queue.push(key);
    };
    enqueue("");

    while (queue.length && dirsVisited < MAX_DIRS) {
      const relParent = queue.shift();
      dirsVisited += 1;
      const absDir = relParent ? path.join(absRoot, relParent) : absRoot;
      let entries;
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch {
        treeForWs[relParent] = [];
        continue;
      }
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      const nodes = [];
      for (const ent of entries) {
        const name = ent.name;
        if (name === ".git") continue;
        if (!relParent && (name === "node_modules" || name === ".ade")) continue;

        const rel = relParent ? `${relParent}/${name}` : name;
        const normalizedRel = normalizeRelExport(rel);

        if (ent.isDirectory()) {
          nodes.push({
            name,
            path: normalizedRel,
            type: "directory",
            changeStatus: null,
          });
          enqueue(normalizedRel);
        } else {
          nodes.push({
            name,
            path: normalizedRel,
            type: "file",
            changeStatus: null,
          });
          let st;
          try {
            st = statSync(path.join(absRoot, normalizedRel));
          } catch {
            continue;
          }
          if (
            contentFiles < MAX_CONTENT_FILES
            && contentBytes < MAX_CONTENT_BYTES
            && shouldCaptureContent(normalizedRel, st.size)
            && st.size > 0
          ) {
            try {
              const buf = readFileSync(path.join(absRoot, normalizedRel));
              if (hasNullByteBuffer(buf)) continue;
              const text = buf.toString("utf8");
              if (text.length > 100_000) continue;
              contentsForWs[normalizedRel] = {
                content: text,
                encoding: "utf-8",
                size: st.size,
                languageId: languageIdFromPathExport(normalizedRel),
                isBinary: false,
              };
              contentFiles += 1;
              contentBytes += text.length;
            } catch {
              // ignore unreadable files
            }
          }
        }
      }
      treeForWs[relParent] = nodes;
    }

    trees[wsId] = treeForWs;
    contents[wsId] = contentsForWs;
  }

  return { filesTreeByWorkspace: trees, filesContentsByWorkspace: contents };
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
    // ADE-135: the rollup's explanation and the required contexts that never
    // reported travel with the status, so an exported "not_run" can be
    // rendered with its reason instead of a bare muted badge.
    checksReason: row.checks_reason ?? null,
    checksMissingRequired: (() => {
      const parsed = safeJson(row.checks_missing_required, []);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    })(),
    reviewStatus: row.review_status ?? "none",
    additions: Number(row.additions ?? 0),
    deletions: Number(row.deletions ?? 0),
    lastSyncedAt: row.last_synced_at ?? null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    creationStrategy: row.creation_strategy ?? null,
  };
}

function normalizeEscapedMarkdownNewlines(text) {
  if (typeof text !== "string" || !text.includes("\\")) return text;
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t");
}

function normalizePrSnapshot(row) {
  const detail = safeJson(row.detail_json, null);
  const normalizedDetail =
    detail && typeof detail.body === "string"
      ? { ...detail, body: normalizeEscapedMarkdownNewlines(detail.body) }
      : detail;
  return {
    prId: String(row.pr_id),
    detail: normalizedDetail,
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

function isBotAuthor(author) {
  if (!author || typeof author !== "string") return false;
  const normalized = author.toLowerCase();
  return (
    normalized.endsWith("[bot]") ||
    normalized.endsWith("-bot") ||
    normalized === "dependabot" ||
    normalized.includes("dependabot")
  );
}

function buildGithubSnapshot({
  prs,
  lanes,
  mergeContexts,
  integrationWorkflows,
  prSnapshots = [],
}) {
  const workflowByPr = new Map(
    integrationWorkflows.filter((workflow) => workflow.linkedPrId).map((workflow) => [workflow.linkedPrId, workflow]),
  );
  const snapshotByPrId = new Map(
    prSnapshots.map((snapshot) => [String(snapshot.prId), snapshot]),
  );
  return {
    repo: prs[0] ? { owner: prs[0].repoOwner, name: prs[0].repoName } : null,
    viewerLogin: null,
    syncedAt: new Date().toISOString(),
    repoPullRequests: prs.map((pr) => {
      const ctx = mergeContexts[pr.id] ?? null;
      const workflow = workflowByPr.get(pr.id) ?? null;
      const lane = lanes.find((candidate) => candidate.id === pr.laneId);
      const snapshot = snapshotByPrId.get(pr.id) ?? null;
      const detail = snapshot?.detail ?? null;
      const author =
        typeof detail?.author?.login === "string" ? detail.author.login : null;
      const labels = Array.isArray(detail?.labels) ? detail.labels : [];
      const comments = Array.isArray(snapshot?.comments) ? snapshot.comments : [];
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
        author,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        linkedPrId: pr.id,
        linkedGroupId: workflow?.linkedGroupId ?? ctx?.groupId ?? null,
        linkedLaneId: pr.laneId,
        linkedLaneName: lane?.name ?? pr.laneId,
        adeKind: workflow ? "integration" : (ctx?.groupType ?? "single"),
        workflowDisplayState: workflow?.workflowDisplayState ?? null,
        cleanupState: workflow?.cleanupState ?? null,
        labels,
        isBot: isBotAuthor(author),
        commentCount: comments.length,
      };
    }),
    externalPullRequests: [],
  };
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
      inner join lanes l on l.id = ts.lane_id
      where ts.archived_at is null
        and l.project_id = ?
      order by coalesce(ts.last_output_at, ts.ended_at, ts.started_at) desc
      limit 200
    `,
    [projectId],
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


function emptyUsageSnapshot() {
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
    costs: [],
    adeCosts: [],
    extraUsage: [],
    lastPolledAt: new Date().toISOString(),
    errors: [],
  };
}

function buildUsageSnapshot() {
  const cachePath = path.join(os.homedir(), ".ade", "cache", "usage-snapshot.json");
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    if (parsed?.version === USAGE_SNAPSHOT_CACHE_VERSION && parsed?.snapshot && Array.isArray(parsed.snapshot.costs)) {
      const lastPolledAt = Date.parse(parsed.snapshot.lastPolledAt ?? "");
      if (!Number.isFinite(lastPolledAt) || Date.now() - lastPolledAt > USAGE_SNAPSHOT_CACHE_TTL_MS) {
        return emptyUsageSnapshot();
      }
      return parsed.snapshot;
    }
  } catch {
    // The native app will fill this cache after the first local scan.
  }
  return emptyUsageSnapshot();
}

function usageRangeForPreset(preset) {
  const now = new Date();
  const until = now.toISOString();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (preset === "today") return { preset, since: startOfToday.toISOString(), until };
  if (preset === "7d") {
    const since = new Date(startOfToday);
    since.setDate(since.getDate() - 6);
    return { preset, since: since.toISOString(), until };
  }
  if (preset === "30d") {
    const since = new Date(startOfToday);
    since.setDate(since.getDate() - 29);
    return { preset, since: since.toISOString(), until };
  }
  return { preset: "all", since: null, until };
}

function nonNegativeInt(value) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : 0;
}

function roundUsd(value) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.round(Math.max(0, numberValue) * 100) / 100 : 0;
}

function makeBrowserDailySkeleton(range) {
  const until = new Date(range.until);
  const untilMs = Number.isFinite(until.getTime()) ? until.getTime() : Date.now();
  const maxDays = range.preset === "today" ? 1 : range.preset === "7d" ? 7 : range.preset === "all" ? 90 : 30;
  const startMs = range.since
    ? Math.max(Date.parse(range.since), untilMs - (maxDays - 1) * 86_400_000)
    : untilMs - (maxDays - 1) * 86_400_000;
  const start = new Date(startMs);
  start.setHours(0, 0, 0, 0);

  const points = [];
  for (let index = 0; index < maxDays; index += 1) {
    const date = new Date(start.getTime() + index * 86_400_000);
    if (date.getTime() > untilMs + 86_400_000) break;
    points.push({
      date: date.toISOString().slice(0, 10),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      commits: 0,
      prs: 0,
      insertions: 0,
      deletions: 0,
      filesChanged: 0,
      sessions: 0,
    });
  }
  return points;
}

function getCtoState(projectId) {
  const identityRow = hasTable("cto_identity_state")
    ? getRow("select payload_json from cto_identity_state where project_id = ? order by updated_at desc limit 1", [projectId])
    : null;
  return {
    identity: safeJson(identityRow?.payload_json, null),
    recentSessions: [],
  };
}

function runGhJson(args) {
  return execFileSync("gh", args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function inUsageRange(iso, range) {
  const timestamp = Date.parse(iso ?? "");
  if (!Number.isFinite(timestamp)) return false;
  if (range.since && timestamp < Date.parse(range.since)) return false;
  return timestamp <= Date.parse(range.until);
}

function commitRangeArgs(range) {
  const args = [];
  if (range.since) args.push("-F", `since=${range.since}`);
  args.push("-F", `until=${range.until}`);
  return args;
}

function pullRequestGraphqlQuery() {
  return [
    "query($owner: String!, $name: String!, $endCursor: String) {",
    "  repository(owner: $owner, name: $name) {",
    "    pullRequests(first: 100, after: $endCursor, orderBy: { field: CREATED_AT, direction: DESC }) {",
    "      pageInfo { hasNextPage endCursor }",
    "      nodes {",
    "        number state createdAt closedAt mergedAt additions deletions changedFiles",
    "        author { login }",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");
}

function parsePullRequestRows(raw, viewer) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => safeJson(line, null))
    .filter((row) => row && typeof row === "object")
    .filter((row) => row.author?.login === viewer);
}

function addStatsDaily(points, dateIso, patch) {
  const date = Number.isFinite(Date.parse(dateIso ?? "")) ? new Date(Date.parse(dateIso)).toISOString().slice(0, 10) : null;
  if (!date) return;
  const point = points.find((candidate) => candidate.date === date);
  if (!point) return;
  point.commits += nonNegativeInt(patch.commits);
  point.prs += nonNegativeInt(patch.prs);
  point.insertions += nonNegativeInt(patch.insertions);
  point.deletions += nonNegativeInt(patch.deletions);
  point.filesChanged += nonNegativeInt(patch.filesChanged);
}

function buildGithubStatsForBrowser(range) {
  try {
    const repoInfo = JSON.parse(runGhJson(["repo", "view", "--json", "owner,name"]));
    const owner = typeof repoInfo.owner === "string" ? repoInfo.owner : repoInfo.owner?.login;
    const repo = owner && repoInfo.name ? `${owner}/${repoInfo.name}` : null;
    if (!repo) throw new Error("Unable to resolve GitHub repo.");
    const viewer = JSON.parse(runGhJson(["api", "user", "--cache", "10m"])).login;
    if (typeof viewer !== "string" || !viewer) throw new Error("Unable to resolve GitHub user.");

    const prRows = parsePullRequestRows(runGhJson([
      "api",
      "graphql",
      "--paginate",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${repoInfo.name}`,
      "-f",
      `query=${pullRequestGraphqlQuery()}`,
      "--jq",
      ".data.repository.pullRequests.nodes[] | @json",
    ]), viewer);
    const mergedPrs = prRows.filter((pr) => inUsageRange(pr.mergedAt, range));
    const closedPrs = prRows.filter((pr) => inUsageRange(pr.closedAt, range));
    const commitRows = runGhJson([
      "api",
      `repos/${repo}/commits`,
      "--method",
      "GET",
      "--cache",
      "10m",
      "-F",
      `author=${viewer}`,
      ...commitRangeArgs(range),
      "--paginate",
      "--jq",
      ".[] | [.sha, .commit.author.date] | @tsv",
    ])
      .split(/\r?\n/)
      .map((line) => line.trim().split("\t")[1])
      .filter(Boolean);
    const createdPrs = prRows.filter((pr) => inUsageRange(pr.createdAt, range));
    const commits = commitRows.filter((date) => inUsageRange(date, range));
    const daily = makeBrowserDailySkeleton(range);
    for (const date of commits) addStatsDaily(daily, date, { commits: 1 });
    for (const pr of createdPrs) {
      addStatsDaily(daily, pr.createdAt, {
        prs: 1,
      });
    }
    for (const pr of mergedPrs) {
      addStatsDaily(daily, pr.mergedAt, {
        insertions: pr.additions,
        deletions: pr.deletions,
        filesChanged: pr.changedFiles,
      });
    }
    return {
      repo,
      available: true,
      lastFetchedAt: new Date().toISOString(),
      error: null,
      commitsCreated: commits.length,
      prsTracked: createdPrs.length,
      prsOpen: createdPrs.filter((pr) => String(pr.state ?? "").toUpperCase() === "OPEN").length,
      prsMerged: mergedPrs.length,
      prsClosed: closedPrs.filter((pr) => String(pr.state ?? "").toUpperCase() === "CLOSED").length,
      prAdditions: mergedPrs.reduce((sum, pr) => sum + nonNegativeInt(pr.additions), 0),
      prDeletions: mergedPrs.reduce((sum, pr) => sum + nonNegativeInt(pr.deletions), 0),
      filesChanged: mergedPrs.reduce((sum, pr) => sum + nonNegativeInt(pr.changedFiles), 0),
      daily,
    };
  } catch (error) {
    return {
      repo: null,
      available: false,
      lastFetchedAt: null,
      error: error instanceof Error ? error.message : String(error),
      commitsCreated: 0,
      prsTracked: 0,
      prsOpen: 0,
      prsMerged: 0,
      prsClosed: 0,
      prAdditions: 0,
      prDeletions: 0,
      filesChanged: 0,
      daily: makeBrowserDailySkeleton(range),
    };
  }
}

function buildUsageStatsFromSnapshot(usageSnapshot, preset) {
  const providerMap = new Map();
  const modelMap = new Map();
  const dailyTokens = new Map();
  const costs = Array.isArray(usageSnapshot?.costs) ? usageSnapshot.costs : [];
  for (const cost of costs) {
    if (!cost || typeof cost.provider !== "string") continue;
    const breakdown = cost.tokenBreakdownByPreset?.[preset] ?? cost.tokenBreakdown;
    if (!breakdown || typeof breakdown !== "object") continue;
    const rangeCost = Number(cost.costUsdByPreset?.[preset] ?? (preset === "today" ? cost.todayCostUsd : cost.last30dCostUsd) ?? 0);
    const providerTotal = Object.values(breakdown).reduce((sum, entry) => (
      sum + nonNegativeInt(entry?.input) + nonNegativeInt(entry?.output) + nonNegativeInt(entry?.cached) + nonNegativeInt(entry?.cacheWrite)
    ), 0);
    const provider = providerMap.get(cost.provider) ?? {
      provider: cost.provider,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      rangeCostUsd: 0,
      todayCostUsd: Number(cost.todayCostUsd ?? 0),
      last30dCostUsd: Number(cost.last30dCostUsd ?? 0),
    };
    provider.rangeCostUsd += Number.isFinite(rangeCost) ? rangeCost : 0;
    for (const [model, entry] of Object.entries(breakdown)) {
      const input = nonNegativeInt(entry?.input);
      const output = nonNegativeInt(entry?.output);
      const cached = nonNegativeInt(entry?.cached) + nonNegativeInt(entry?.cacheWrite);
      const total = input + output + cached;
      const share = providerTotal > 0 ? total / providerTotal : 0;
      const modelCost = Number(entry?.costUsd ?? rangeCost * share) || 0;
      provider.inputTokens += input;
      provider.outputTokens += output;
      provider.cachedTokens += cached;
      provider.totalTokens += total;
      const modelKey = `${cost.provider}\u0000${model}`;
      const modelSummary = modelMap.get(modelKey) ?? {
        provider: cost.provider,
        model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      };
      modelSummary.inputTokens += input;
      modelSummary.outputTokens += output;
      modelSummary.cachedTokens += cached;
      modelSummary.totalTokens += total;
      modelSummary.costUsd += modelCost;
      modelMap.set(modelKey, modelSummary);
    }
    providerMap.set(cost.provider, provider);

    const daily = cost.dailyTokensByPreset?.[preset] ?? {};
    for (const [date, value] of Object.entries(daily)) {
      dailyTokens.set(date, (dailyTokens.get(date) ?? 0) + nonNegativeInt(value));
    }
  }
  const providers = Array.from(providerMap.values())
    .map((provider) => ({ ...provider, rangeCostUsd: roundUsd(provider.rangeCostUsd) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.rangeCostUsd - a.rangeCostUsd);
  const models = Array.from(modelMap.values())
    .map((model) => ({ ...model, costUsd: roundUsd(model.costUsd) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd);
  return {
    providers,
    models,
    inputTokens: providers.reduce((sum, provider) => sum + provider.inputTokens, 0),
    outputTokens: providers.reduce((sum, provider) => sum + provider.outputTokens, 0),
    cachedTokens: providers.reduce((sum, provider) => sum + provider.cachedTokens, 0),
    costRangeUsd: roundUsd(providers.reduce((sum, provider) => sum + provider.rangeCostUsd, 0)),
    cost30dUsd: roundUsd(providers.reduce((sum, provider) => sum + provider.last30dCostUsd, 0)),
    costTodayUsd: roundUsd(providers.reduce((sum, provider) => sum + provider.todayCostUsd, 0)),
    dailyTokens,
  };
}

function mergeUsageTokensIntoDaily(points, dailyTokens) {
  for (const point of points) {
    const tokens = nonNegativeInt(dailyTokens.get(point.date));
    point.inputTokens += tokens;
    point.totalTokens += tokens;
  }
}

function buildStatsDashboardStats(preset, usageSnapshot) {
  const range = usageRangeForPreset(preset);
  const github = buildGithubStatsForBrowser(range);
  const usage = buildUsageStatsFromSnapshot(usageSnapshot, preset);
  mergeUsageTokensIntoDaily(github.daily, usage.dailyTokens);
  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cachedTokens;
  return {
    generatedAt: new Date().toISOString(),
    range,
    summary: {
      totalTokens,
      tokenTotalSource: "provider_logs",
      observedProviderTokens: totalTokens,
      observedProviderInputTokens: usage.inputTokens,
      observedProviderOutputTokens: usage.outputTokens,
      observedProviderCachedTokens: usage.cachedTokens,
      observedProviderCostRangeUsd: usage.costRangeUsd,
      observedProviderCost30dUsd: usage.cost30dUsd,
      observedProviderCostTodayUsd: usage.costTodayUsd,
      adeRuntimeTokens: 0,
      adeRuntimeInputTokens: 0,
      adeRuntimeOutputTokens: 0,
      adeRuntimeCachedTokens: 0,
      adeRuntimeCostRangeUsd: 0,
      adeRuntimeCost30dUsd: 0,
      adeRuntimeCostTodayUsd: 0,
      adeTotalTokens: 0,
      adeTotalCostRangeUsd: 0,
      trackedAdeTokens: 0,
      trackedAdeInputTokens: 0,
      trackedAdeOutputTokens: 0,
      trackedAdeCalls: 0,
      trackedAdeDurationMs: 0,
      workerTokens: 0,
      workerCostUsd: 0,
      chatSessions: 0,
      terminalSessions: 0,
      activeLanes: 0,
      lanesCreated: 0,
      lanesArchived: 0,
      lanesDeleted: 0,
      commitsCreated: github.commitsCreated,
      pushOperations: 0,
      prLandings: github.prsMerged,
      prsTracked: github.prsTracked,
      prsOpen: github.prsOpen,
      prsMerged: github.prsMerged,
      prsClosed: github.prsClosed,
      prAdditions: github.prAdditions,
      prDeletions: github.prDeletions,
      filesChanged: github.filesChanged,
      insertions: github.prAdditions,
      deletions: github.prDeletions,
      artifactsCaptured: 0,
      automationRuns: 0,
      workerRuns: 0,
    },
    providers: usage.providers,
    models: usage.models,
    adeProviders: [],
    adeModels: [],
    agentProviders: [],
    agentModels: [],
    features: [],
    lanes: [],
    activities: [],
    daily: github.daily,
    github: {
      repo: github.repo,
      available: github.available,
      lastFetchedAt: github.lastFetchedAt,
      error: github.error,
    },
    sourceNotes: [],
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
          is_edit_protected, parent_lane_id, color, icon, tags_json, folder,
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

const integrationWorkflows = maybeAll(
  "integration_proposals",
  "select * from integration_proposals where project_id = ? order by created_at desc limit 100",
  [projectId],
).map(rowToIntegrationWorkflow);

const mergeContexts = buildMergeContexts(prs, lanes, projectId);
const rebaseNeeds = buildRebaseNeeds({ lanes, prs, projectId });
const githubSnapshot = buildGithubSnapshot({
  prs,
  lanes,
  mergeContexts,
  integrationWorkflows,
  prSnapshots,
});
const operations = buildOperations(projectId);
const sessions = buildSessions(projectId);

const automations = buildAutomations(projectId);
const usageSnapshot = buildUsageSnapshot();
const adeUsageStatsByPreset = Object.fromEntries(
  ["today", "7d", "30d", "all"].map((preset) => [preset, buildStatsDashboardStats(preset, usageSnapshot)]),
);
const ctoState = getCtoState(projectId);

db.close();

const chatTranscripts = await buildChatTranscripts(sessions);

const { filesTreeByWorkspace, filesContentsByWorkspace } = buildFilesBrowserSnapshot(lanes);
const filesTreeWorkspaceCount = Object.keys(filesTreeByWorkspace).length;
const filesTreeDirKeys = Object.values(filesTreeByWorkspace).reduce(
  (acc, m) => acc + Object.keys(m).length,
  0,
);
const filesContentEntryCount = Object.values(filesContentsByWorkspace).reduce(
  (acc, m) => acc + Object.keys(m).length,
  0,
);

const snapshot = {
  version: 2,
  statsDashboardVersion: 1,
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
  integrationWorkflows,
  rebaseNeeds,
  githubSnapshot,
  operations,
  sessions,
  chatTranscripts,
  usageSnapshot,
  adeUsageStatsByPreset,
  ctoState,
  automations,
  filesTreeByWorkspace,
  filesContentsByWorkspace,
  stripInlineDemo: true,
};

await fs.writeFile(OUT_FILE, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
console.log(
  `[export-browser-mock-ade] Wrote browser snapshot for ${projectRow.displayName} → ${OUT_FILE}\n` +
    `  lanes=${lanes.length} prs=${prs.length} prSnapshots=${prSnapshots.length} operations=${operations.length} sessions=${sessions.length} chatTranscripts=${Object.keys(chatTranscripts).length}\n` +
    `  filesWorkspaces=${lanes.length} filesTreeWorkspaces=${filesTreeWorkspaceCount} filesTreeDirs=${filesTreeDirKeys} filesWithEmbeddedText=${filesContentEntryCount}\n` +
    "Restart Vite or refresh the browser to pick up the updated data.",
);
