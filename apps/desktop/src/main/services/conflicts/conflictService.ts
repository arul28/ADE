import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  ApplyConflictProposalArgs,
  BatchOverlapEntry,
  BatchAssessmentResult,
  CommitExternalConflictResolverRunArgs,
  CommitExternalConflictResolverRunResult,
  ConflictChip,
  ConflictEventPayload,
  ConflictExternalResolverContextGap,
  ConflictExternalResolverRunStatus,
  ConflictExternalResolverRunSummary,
  ConflictFileType,
  ConflictOverlap,
  ConflictFileContextV1,
  ConflictFileContextSideV1,
  ConflictFileHunkV1,
  ConflictJobContextV1,
  ConflictRelevantFileV1,
  ConflictProposal,
  ConflictProposalPreview,
  ConflictProposalPreviewFile,
  ConflictProposalProvider,
  ConflictProposalStatus,
  ConflictPrediction,
  ConflictRiskLevel,
  ConflictStatus,
  ConflictStatusValue,
  GetLaneConflictStatusArgs,
  GitConflictState,
  LaneSummary,
  ListOverlapsArgs,
  MergeSimulationArgs,
  MergeSimulationResult,
  ListExternalConflictResolverRunsArgs,
  PrepareConflictProposalArgs,
  RequestConflictProposalArgs,
  RunExternalConflictResolverArgs,
  RiskMatrixEntry,
  RunConflictPredictionArgs,
  UndoConflictProposalArgs,
  PrepareResolverSessionArgs,
  PrepareResolverSessionResult,
  FinalizeResolverSessionArgs,
  SuggestResolverTargetArgs,
  SuggestResolverTargetResult,
  ResolverSessionScenario
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createOperationService } from "../history/operationService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createPackService } from "../packs/packService";
import { runGit, runGitMergeTree, runGitOrThrow } from "../git/git";
import { redactSecretsDeep } from "../../utils/redaction";

type PredictionStatus = "clean" | "conflict" | "unknown";

type ConflictPredictionRow = {
  id: string;
  lane_a_id: string;
  lane_b_id: string | null;
  status: PredictionStatus;
  conflicting_files_json: string | null;
  overlap_files_json: string | null;
  lane_a_sha: string | null;
  lane_b_sha: string | null;
  predicted_at: string;
  expires_at: string | null;
};

type StoredConflictFile = {
  path: string;
  conflictType: string;
  markerPreview?: string;
};

type ConflictProposalRow = {
  id: string;
  lane_id: string;
  peer_lane_id: string | null;
  prediction_id: string | null;
  source: "subscription" | "local";
  confidence: number | null;
  explanation: string | null;
  diff_patch: string;
  status: ConflictProposalStatus;
  job_id: string | null;
  artifact_id: string | null;
  applied_operation_id: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

type ExternalResolverRunRecord = {
  schema: "ade.conflictExternalRun.v1";
  runId: string;
  provider: RunExternalConflictResolverArgs["provider"];
  status: ConflictExternalResolverRunStatus;
  startedAt: string;
  completedAt: string | null;
  targetLaneId: string;
  sourceLaneIds: string[];
  cwdLaneId: string;
  integrationLaneId: string | null;
  command: string[];
  summary: string | null;
  patchPath: string | null;
  logPath: string | null;
  insufficientContext: boolean;
  contextGaps: ConflictExternalResolverContextGap[];
  warnings: string[];
  committedAt?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  error: string | null;
};

type ExternalResolverPackRef = {
  kind: "project_pack" | "lane_pack" | "conflict_pack" | "project_doc";
  laneId: string | null;
  peerLaneId: string | null;
  absPath: string;
  repoRelativePath: string;
  exists: boolean;
  required: boolean;
};

const RISK_SCORE: Record<ConflictRiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3
};

// For small workspaces we can afford the full pairwise matrix automatically.
const FULL_MATRIX_MAX_LANES = 15;
// For larger workspaces we prefilter likely-conflicting pairs using a cheap overlap heuristic.
const PREFILTER_MAX_PEERS_PER_LANE = 6;
const PREFILTER_MAX_GLOBAL_PAIRS = 800;
const PREFILTER_MAX_TOUCHED_FILES = 800;
const STALE_MS = 5 * 60_000;
const EXTERNAL_DIFF_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toIsoPlusMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function matrixEntryKey(entry: RiskMatrixEntry): string {
  return pairKey(entry.laneAId, entry.laneBId);
}

function normalizeConflictType(value: string): ConflictFileType {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("rename")) return "rename";
  if (normalized.includes("delete")) return "delete";
  if (normalized.includes("add")) return "add";
  return "content";
}

function riskFromPrediction(status: PredictionStatus, overlapCount: number, conflictCount: number): ConflictRiskLevel {
  if (status === "conflict" || conflictCount > 0) return "high";
  if (overlapCount === 0) return "none";
  if (overlapCount <= 2) return "low";
  if (overlapCount <= 6) return "medium";
  return "high";
}

function isStalePrediction(predictedAt: string | null | undefined): boolean {
  if (!predictedAt) return true;
  const ts = Date.parse(predictedAt);
  if (Number.isNaN(ts)) return true;
  return Date.now() - ts > STALE_MS;
}

function extractOverlapFiles(row: ConflictPredictionRow | undefined): string[] {
  if (!row) return [];
  const overlaps = safeJsonArray<string>(row.overlap_files_json ?? null);
  const conflicting = safeJsonArray<StoredConflictFile>(row.conflicting_files_json ?? null);
  return uniqueSorted([
    ...overlaps.map((value) => value.trim()).filter(Boolean),
    ...conflicting.map((value) => value.path?.trim() ?? "").filter(Boolean)
  ]);
}

function parseDiffNameOnly(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readHeadSha(cwd: string, ref = "HEAD"): Promise<string> {
  return (await runGitOrThrow(["rev-parse", ref], { cwd, timeoutMs: 10_000 })).trim();
}

async function readMergeBase(cwd: string, refA: string, refB: string): Promise<string> {
  return (await runGitOrThrow(["merge-base", refA, refB], { cwd, timeoutMs: 10_000 })).trim();
}

async function readTouchedFiles(cwd: string, mergeBase: string, headSha: string): Promise<Set<string>> {
  const res = await runGit(["diff", "--name-only", `${mergeBase}..${headSha}`], { cwd, timeoutMs: 15_000 });
  if (res.exitCode !== 0) return new Set<string>();
  return new Set(parseDiffNameOnly(res.stdout));
}

async function readDiffNumstat(cwd: string, mergeBase: string, headSha: string): Promise<{
  files: Set<string>;
  insertions: number;
  deletions: number;
}> {
  const res = await runGit(["diff", "--numstat", `${mergeBase}..${headSha}`], {
    cwd,
    timeoutMs: 15_000
  });
  if (res.exitCode !== 0) {
    return {
      files: new Set<string>(),
      insertions: 0,
      deletions: 0
    };
  }

  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [insRaw, delRaw, file] = line.split(/\t/);
    if (!file) continue;
    files.add(file);
    const ins = Number(insRaw);
    const del = Number(delRaw);
    if (Number.isFinite(ins)) insertions += ins;
    if (Number.isFinite(del)) deletions += del;
  }
  return { files, insertions, deletions };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function safeSegment(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "untitled";
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function latestPerPair(rows: ConflictPredictionRow[]): Map<string, ConflictPredictionRow> {
  const out = new Map<string, ConflictPredictionRow>();
  for (const row of rows) {
    const key =
      row.lane_b_id == null
        ? `base:${row.lane_a_id}`
        : `pair:${pairKey(row.lane_a_id, row.lane_b_id)}`;
    if (!out.has(key)) {
      out.set(key, row);
      continue;
    }
    const current = out.get(key)!;
    if (row.predicted_at > current.predicted_at) {
      out.set(key, row);
    }
  }
  return out;
}

function computeStatusValue(args: {
  hasActiveConflict: boolean;
  hasBasePrediction: boolean;
  hasPredictedConflict: boolean;
  behindCount: number;
}): ConflictStatusValue {
  if (args.hasActiveConflict) return "conflict-active";
  if (!args.hasBasePrediction) return "unknown";
  if (args.hasPredictedConflict) return "conflict-predicted";
  if (args.behindCount > 0) return "behind-base";
  return "merge-ready";
}

function laneById(lanes: LaneSummary[]): Map<string, LaneSummary> {
  return new Map(lanes.map((lane) => [lane.id, lane]));
}

function buildConflictFiles(conflicting: StoredConflictFile[], overlapFiles: string[]): Array<{
  path: string;
  conflictType: ConflictFileType;
  markerPreview: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ path: string; conflictType: ConflictFileType; markerPreview: string }> = [];

  for (const file of conflicting) {
    const clean = file.path?.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push({
      path: clean,
      conflictType: normalizeConflictType(file.conflictType ?? "content"),
      markerPreview: file.markerPreview ?? ""
    });
  }

  for (const path of overlapFiles) {
    const clean = path.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push({
      path: clean,
      conflictType: "content",
      markerPreview: ""
    });
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function dedupeChips(chips: ConflictChip[]): ConflictChip[] {
  const map = new Map<string, ConflictChip>();
  for (const chip of chips) {
    const key = `${chip.laneId}:${chip.peerId ?? "base"}:${chip.kind}`;
    const existing = map.get(key);
    if (!existing || chip.overlapCount > existing.overlapCount) {
      map.set(key, chip);
    }
  }
  return Array.from(map.values());
}

function rowToProposal(row: ConflictProposalRow): ConflictProposal {
  return {
    id: row.id,
    laneId: row.lane_id,
    peerLaneId: row.peer_lane_id,
    predictionId: row.prediction_id,
    source: row.source,
    confidence: row.confidence,
    explanation: row.explanation ?? "",
    diffPatch: row.diff_patch,
    status: row.status,
    jobId: row.job_id,
    artifactId: row.artifact_id,
    appliedOperationId: row.applied_operation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function safeParseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writePatchFile(content: string): string {
  const filePath = path.join(os.tmpdir(), `ade-proposal-${randomUUID()}.patch`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function extractPathsFromUnifiedDiff(diffPatch: string): string[] {
  const paths = new Set<string>();
  for (const line of diffPatch.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      const p = line.slice("+++ b/".length).trim();
      if (p && p !== "/dev/null") paths.add(p);
    }
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const p = match?.[2]?.trim();
      if (p && p !== "/dev/null") paths.add(p);
    }
  }
  return Array.from(paths).sort((a, b) => a.localeCompare(b));
}

function extractCommitPathsFromUnifiedDiff(diffPatch: string): string[] {
  const paths = new Set<string>();
  for (const line of diffPatch.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      const p = line.slice("+++ b/".length).trim();
      if (p && p !== "/dev/null") paths.add(p);
      continue;
    }
    if (line.startsWith("--- a/")) {
      const p = line.slice("--- a/".length).trim();
      if (p && p !== "/dev/null") paths.add(p);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const left = match?.[1]?.trim();
      const right = match?.[2]?.trim();
      if (left && left !== "/dev/null") paths.add(left);
      if (right && right !== "/dev/null") paths.add(right);
    }
  }
  return Array.from(paths).sort((a, b) => a.localeCompare(b));
}

function extractDiffPatchFromText(text: string): string {
  const fence = text.match(/```diff\s*\n([\s\S]*?)\n```/i);
  if (fence?.[1]) {
    const raw = fence[1].trim();
    return raw.length ? `${raw}\n` : "";
  }
  return "";
}

function stripDiffFence(text: string): string {
  return text.replace(/```diff\s*\n[\s\S]*?\n```/gi, "").trim();
}

function extractFirstJsonObject(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith("{") && raw.endsWith("}")) return raw;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = raw.slice(first, last + 1).trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  }
  return null;
}

function parseStructuredObject(text: string): Record<string, unknown> | null {
  const candidate = extractFirstJsonObject(text);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeConfidence(value: unknown): number | null {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

function parseHunksFromDiff(diffText: string, kind: ConflictFileHunkV1["kind"]): ConflictFileHunkV1[] {
  const hunks: ConflictFileHunkV1[] = [];
  for (const line of diffText.split(/\r?\n/)) {
    const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!m) continue;
    hunks.push({
      kind,
      header: line.trim(),
      baseStart: Number(m[1] ?? 0) || 0,
      baseCount: Number(m[2] ?? 1) || 1,
      otherStart: Number(m[3] ?? 0) || 0,
      otherCount: Number(m[4] ?? 1) || 1
    });
  }
  return hunks;
}

function makeContextSide(args: {
  side: ConflictFileContextSideV1["side"];
  ref: string | null;
  blobSha: string | null;
  excerpt: string;
  fallbackReason?: string | null;
  truncated?: boolean;
}): ConflictFileContextSideV1 {
  const trimmed = args.excerpt.trim();
  return {
    side: args.side,
    ref: args.ref,
    blobSha: args.blobSha,
    excerpt: trimmed,
    excerptFormat: trimmed.length ? "diff_hunks" : "unavailable",
    truncated: Boolean(args.truncated),
    ...(args.fallbackReason ? { omittedReasonTags: [args.fallbackReason] } : {})
  };
}

function deletePatchFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export function createConflictService({
  db,
  logger,
  projectId,
  projectRoot,
  laneService,
  projectConfigService,
  aiIntegrationService,
  packService,
  operationService,
  conflictPacksDir,
  onEvent
}: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  projectRoot: string;
  laneService: ReturnType<typeof createLaneService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
  packService?: ReturnType<typeof createPackService>;
  operationService?: ReturnType<typeof createOperationService>;
  conflictPacksDir?: string;
  onEvent?: (event: ConflictEventPayload) => void;
}) {
  const pairLocks = new Map<string, Promise<void>>();
  const pairQueued = new Set<string>();

  const runSerializedPairTask = async (pairId: string, task: () => Promise<void>): Promise<void> => {
    const active = pairLocks.get(pairId);
    if (active) {
      pairQueued.add(pairId);
      await active;
      if (!pairQueued.has(pairId)) return;
      pairQueued.delete(pairId);
    }

    const running = (async () => {
      await task();
    })().finally(() => {
      const current = pairLocks.get(pairId);
      if (current === running) {
        pairLocks.delete(pairId);
      }
    });

    pairLocks.set(pairId, running);
    await running;

    if (pairQueued.has(pairId)) {
      pairQueued.delete(pairId);
      await runSerializedPairTask(pairId, task);
    }
  };

  const listActiveLanes = async (): Promise<LaneSummary[]> => {
    const lanes = await laneService.list({ includeArchived: false });
    return lanes.filter((lane) => !lane.archivedAt);
  };

  const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

  const preparedContexts = new Map<
    string,
    {
      preparedAt: string;
      laneId: string;
      peerLaneId: string | null;
      provider: ConflictProposalProvider;
      conflictContext: Record<string, unknown>;
    }
  >();
  const PREPARED_TTL_MS = 20 * 60_000;

  const cleanupPreparedContexts = () => {
    const cutoff = Date.now() - PREPARED_TTL_MS;
    for (const [digest, entry] of preparedContexts.entries()) {
      const ts = Date.parse(entry.preparedAt);
      const ms = Number.isFinite(ts) ? ts : Date.now();
      if (ms < cutoff) preparedContexts.delete(digest);
    }
  };

  const packsRootDir = conflictPacksDir ? path.dirname(conflictPacksDir) : null;
  const resolvedPacksRootDir = packsRootDir ?? path.join(projectRoot, ".ade", "packs");
  const projectPackPath = path.join(resolvedPacksRootDir, "project_pack.md");
  const lanePackPath = (laneId: string) => path.join(resolvedPacksRootDir, "lanes", laneId, "lane_pack.md");
  const conflictPackPath = (laneId: string, peerKey: string) =>
    path.join(resolvedPacksRootDir, "conflicts", "v2", `${laneId}__${safeSegment(peerKey)}.md`);
  const contextDocPaths = [
    path.join(projectRoot, ".ade/context/PRD.ade.md"),
    path.join(projectRoot, ".ade/context/ARCHITECTURE.ade.md"),
    path.join(projectRoot, "docs/PRD.md")
  ];
  const toRepoRelativePath = (absPath: string): string => {
    const rel = path.relative(projectRoot, absPath).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return absPath.replace(/\\/g, "/");
    return rel;
  };

  const readLanePackBody = (laneId: string): string | null => {
    const filePath = lanePackPath(laneId);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed) return null;
      return trimmed.length > 12_000 ? `${trimmed.slice(0, 12_000)}\n\n…(truncated)…\n` : trimmed;
    } catch {
      return null;
    }
  };

  const safeReadText = (absPath: string, maxBytes: number): string => {
    try {
      const fd = fs.openSync(absPath, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const read = fs.readSync(fd, buf, 0, maxBytes, 0);
        return buf.slice(0, Math.max(0, read)).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "";
    }
  };

  const externalRunsRootDir = path.join(resolvedPacksRootDir, "external-resolver-runs");

  const buildExternalResolverPackRefs = (args: {
    targetLaneId: string;
    sourceLaneIds: string[];
    cwdLaneId: string;
    integrationLaneId: string | null;
    contexts: Array<{ laneId: string; peerLaneId: string | null }>;
  }): ExternalResolverPackRef[] => {
    const refs = new Map<string, ExternalResolverPackRef>();
    const addRef = (ref: Omit<ExternalResolverPackRef, "exists" | "repoRelativePath">) => {
      const key = `${ref.kind}:${ref.absPath}`;
      if (refs.has(key)) return;
      const absPath = path.resolve(ref.absPath);
      refs.set(key, {
        ...ref,
        absPath,
        repoRelativePath: toRepoRelativePath(absPath),
        exists: fs.existsSync(absPath)
      });
    };

    addRef({
      kind: "project_pack",
      laneId: null,
      peerLaneId: null,
      absPath: projectPackPath,
      required: true
    });

    const relevantLaneIds = uniqueSorted([
      args.targetLaneId,
      args.cwdLaneId,
      ...(args.integrationLaneId ? [args.integrationLaneId] : []),
      ...args.sourceLaneIds
    ]);
    for (const laneId of relevantLaneIds) {
      addRef({
        kind: "lane_pack",
        laneId,
        peerLaneId: null,
        absPath: lanePackPath(laneId),
        required: true
      });
    }

    for (const ctx of args.contexts) {
      const peerKey = (ctx.peerLaneId?.trim() || laneService.getLaneBaseAndBranch(ctx.laneId).baseRef || "").trim();
      if (!peerKey) continue;
      addRef({
        kind: "conflict_pack",
        laneId: ctx.laneId,
        peerLaneId: ctx.peerLaneId ?? null,
        absPath: conflictPackPath(ctx.laneId, peerKey),
        required: true
      });
    }

    for (const absPath of contextDocPaths) {
      addRef({
        kind: "project_doc",
        laneId: null,
        peerLaneId: null,
        absPath,
        required: false
      });
    }

    return [...refs.values()].sort((a, b) => {
      const rank = (value: ExternalResolverPackRef["kind"]): number => {
        if (value === "project_pack") return 1;
        if (value === "project_doc") return 2;
        if (value === "lane_pack") return 3;
        return 4;
      };
      const rankDelta = rank(a.kind) - rank(b.kind);
      if (rankDelta !== 0) return rankDelta;
      const laneDelta = (a.laneId ?? "").localeCompare(b.laneId ?? "");
      if (laneDelta !== 0) return laneDelta;
      const peerDelta = (a.peerLaneId ?? "").localeCompare(b.peerLaneId ?? "");
      if (peerDelta !== 0) return peerDelta;
      return a.absPath.localeCompare(b.absPath);
    });
  };

  const ensureExternalRunsDir = () => {
    fs.mkdirSync(externalRunsRootDir, { recursive: true });
  };

  const resolveExternalResolverCommand = (provider: RunExternalConflictResolverArgs["provider"]): string[] => {
    const snapshot = projectConfigService.get();
    const providers = isRecord(snapshot.local.providers)
      ? snapshot.local.providers
      : isRecord(snapshot.effective.providers)
        ? snapshot.effective.providers
        : {};
    const contextTools = isRecord((providers as Record<string, unknown>).contextTools)
      ? ((providers as Record<string, unknown>).contextTools as Record<string, unknown>)
      : {};
    const conflictResolvers = isRecord(contextTools.conflictResolvers)
      ? (contextTools.conflictResolvers as Record<string, unknown>)
      : {};
    const providerEntry = isRecord(conflictResolvers[provider]) ? (conflictResolvers[provider] as Record<string, unknown>) : {};
    return Array.isArray(providerEntry.command) ? providerEntry.command.map((entry) => String(entry)) : [];
  };

  const toRunSummary = (run: ExternalResolverRunRecord): ConflictExternalResolverRunSummary => ({
    runId: run.runId,
    provider: run.provider,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    targetLaneId: run.targetLaneId,
    sourceLaneIds: run.sourceLaneIds,
    cwdLaneId: run.cwdLaneId,
    integrationLaneId: run.integrationLaneId,
    summary: run.summary,
    patchPath: run.patchPath,
    logPath: run.logPath,
    insufficientContext: run.insufficientContext,
    contextGaps: run.contextGaps,
    warnings: run.warnings,
    committedAt: run.committedAt ?? null,
    commitSha: run.commitSha ?? null,
    commitMessage: run.commitMessage ?? null,
    error: run.error
  });

  const writeExternalRunRecord = (run: ExternalResolverRunRecord): void => {
    ensureExternalRunsDir();
    const runDir = path.join(externalRunsRootDir, run.runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  };

  const readExternalRunRecord = (runId: string): ExternalResolverRunRecord | null => {
    const filePath = path.join(externalRunsRootDir, runId, "run.json");
    if (!fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ExternalResolverRunRecord;
      if (!parsed || parsed.schema !== "ade.conflictExternalRun.v1") return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const listExternalRunRecords = (): ExternalResolverRunRecord[] => {
    if (!fs.existsSync(externalRunsRootDir)) return [];
    const out: ExternalResolverRunRecord[] = [];
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(externalRunsRootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const run = readExternalRunRecord(entry.name);
      if (run) out.push(run);
    }
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return out;
  };

  const extractResolverSummary = (output: string): string | null => {
    const normalized = output.replace(/\r\n/g, "\n");
    const markers = [
      /done\.?[\s\S]*?here'?s what (?:i|we) (?:changed|did)[:\s]*([\s\S]+)/i,
      /summary\s*:\s*([\s\S]+)/i
    ];
    for (const marker of markers) {
      const m = normalized.match(marker);
      if (!m?.[1]) continue;
      const clean = m[1].split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6).join(" ");
      if (clean) return clean.length > 420 ? `${clean.slice(0, 419)}…` : clean;
    }
    const tail = normalized.split("\n").slice(-10).map((line) => line.trim()).filter(Boolean).join(" ");
    if (!tail) return null;
    return tail.length > 420 ? `${tail.slice(0, 419)}…` : tail;
  };

  const ensureRelativeRepoPath = (relPath: string): string => {
    const normalized = relPath.trim().replace(/\\/g, "/");
    if (!normalized.length) throw new Error("File path is required");
    if (normalized.includes("\0")) throw new Error("Invalid file path");
    if (path.isAbsolute(normalized)) throw new Error("Path must be repo-relative");
    if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
      throw new Error("Path escapes lane root");
    }
    return normalized;
  };

  const readGitConflictState = async (laneId: string): Promise<GitConflictState & { mergeHeadSha: string | null }> => {
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const gitDirRes = await runGit(["rev-parse", "--absolute-git-dir"], { cwd: lane.worktreePath, timeoutMs: 10_000 });
    const gitDir = gitDirRes.exitCode === 0 ? gitDirRes.stdout.trim() : "";
    const hasRebase =
      gitDir.length > 0 &&
      (fs.existsSync(path.join(gitDir, "rebase-apply")) || fs.existsSync(path.join(gitDir, "rebase-merge")));
    const hasMerge = gitDir.length > 0 && fs.existsSync(path.join(gitDir, "MERGE_HEAD"));
    const kind: GitConflictState["kind"] = hasRebase ? "rebase" : hasMerge ? "merge" : null;

    const unmergedRes = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: lane.worktreePath, timeoutMs: 10_000 });
    const conflictedFiles = unmergedRes.exitCode === 0 ? parseDiffNameOnly(unmergedRes.stdout).sort((a, b) => a.localeCompare(b)) : [];

    let mergeHeadSha: string | null = null;
    if (kind === "merge" && gitDir.length) {
      try {
        const raw = fs.readFileSync(path.join(gitDir, "MERGE_HEAD"), "utf8").trim();
        if (raw) mergeHeadSha = raw;
      } catch {
        // ignore
      }
    }

    const inProgress = kind != null;
    return {
      laneId,
      kind,
      inProgress,
      conflictedFiles,
      canContinue: inProgress && conflictedFiles.length === 0,
      canAbort: inProgress,
      mergeHeadSha
    };
  };

  const extractMarkerPreview = (laneId: string, relPath: string, warnings: string[]): string | null => {
    const filePath = ensureRelativeRepoPath(relPath);
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const abs = path.join(lane.worktreePath, filePath);
    const raw = safeReadText(abs, 48_000);
    if (!raw) return null;
    if (raw.includes("\u0000")) return null;

    const idx = raw.indexOf("<<<<<<<");
    if (idx < 0) {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const excerpt = trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}\n...(truncated)...\n` : trimmed;
      if (trimmed.length > 2000) warnings.push(`Marker preview truncated for ${filePath}.`);
      return excerpt;
    }

    const start = Math.max(0, idx - 1600);
    const end = Math.min(raw.length, idx + 3200);
    const excerpt = raw.slice(start, end).trim();
    if (start > 0 || end < raw.length) warnings.push(`Marker preview excerpted for ${filePath}.`);
    return excerpt;
  };

  const getLatestRows = (): Map<string, ConflictPredictionRow> => {
    const rows = db.all<ConflictPredictionRow>(
      `
        select
          id,
          lane_a_id,
          lane_b_id,
          status,
          conflicting_files_json,
          overlap_files_json,
          lane_a_sha,
          lane_b_sha,
          predicted_at,
          expires_at
        from conflict_predictions
        where project_id = ?
        order by predicted_at desc
      `,
      [projectId]
    );
    return latestPerPair(rows);
  };

  const getLatestBaseRow = (laneId: string): ConflictPredictionRow | null => {
    return db.get<ConflictPredictionRow>(
      `
        select
          id,
          lane_a_id,
          lane_b_id,
          status,
          conflicting_files_json,
          overlap_files_json,
          lane_a_sha,
          lane_b_sha,
          predicted_at,
          expires_at
        from conflict_predictions
        where project_id = ?
          and lane_a_id = ?
          and lane_b_id is null
        order by predicted_at desc
        limit 1
      `,
      [projectId, laneId]
    );
  };

  const getLatestPairRowsForLane = (laneId: string): ConflictPredictionRow[] => {
    return db.all<ConflictPredictionRow>(
      `
        select
          id,
          lane_a_id,
          lane_b_id,
          status,
          conflicting_files_json,
          overlap_files_json,
          lane_a_sha,
          lane_b_sha,
          predicted_at,
          expires_at
        from conflict_predictions
        where project_id = ?
          and lane_b_id is not null
          and (lane_a_id = ? or lane_b_id = ?)
        order by predicted_at desc
      `,
      [projectId, laneId, laneId]
    );
  };

  const upsertPrediction = (args: {
    laneAId: string;
    laneBId: string | null;
    status: PredictionStatus;
    conflictingFiles: StoredConflictFile[];
    overlapFiles: string[];
    laneASha: string;
    laneBSha: string | null;
  }): ConflictPrediction => {
    const id = randomUUID();
    const predictedAt = new Date().toISOString();
    const expiresAt = toIsoPlusMinutes(30);
    const conflictingFiles = args.conflictingFiles.map((file) => ({
      path: file.path,
      conflictType: file.conflictType
    }));
    const overlapFiles = uniqueSorted(args.overlapFiles);

    db.run(
      `
        insert into conflict_predictions(
          id,
          project_id,
          lane_a_id,
          lane_b_id,
          status,
          conflicting_files_json,
          overlap_files_json,
          lane_a_sha,
          lane_b_sha,
          predicted_at,
          expires_at
        ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        projectId,
        args.laneAId,
        args.laneBId,
        args.status,
        JSON.stringify(conflictingFiles),
        JSON.stringify(overlapFiles),
        args.laneASha,
        args.laneBSha,
        predictedAt,
        expiresAt
      ]
    );

    if (args.laneBId == null) {
      db.run(
        `
          delete from conflict_predictions
          where project_id = ?
            and lane_a_id = ?
            and lane_b_id is null
            and id != ?
        `,
        [projectId, args.laneAId, id]
      );
    } else {
      db.run(
        `
          delete from conflict_predictions
          where project_id = ?
            and lane_a_id = ?
            and lane_b_id = ?
            and id != ?
        `,
        [projectId, args.laneAId, args.laneBId, id]
      );
    }

    return {
      id,
      laneAId: args.laneAId,
      laneBId: args.laneBId,
      status: args.status,
      conflictingFiles,
      overlapFiles,
      laneASha: args.laneASha,
      laneBSha: args.laneBSha,
      predictedAt
    };
  };

  const hasActiveConflict = async (lane: LaneSummary): Promise<boolean> => {
    const res = await runGit(["ls-files", "-u"], { cwd: lane.worktreePath, timeoutMs: 8_000 });
    if (res.exitCode !== 0) return false;
    return res.stdout.trim().length > 0;
  };

  const predictLaneVsBase = async (lane: LaneSummary): Promise<ConflictPrediction> => {
    const laneHead = await readHeadSha(lane.worktreePath, "HEAD");
    const baseHead = await readHeadSha(projectRoot, lane.baseRef);
    const mergeBase = await readMergeBase(projectRoot, baseHead, laneHead);
    const merge = await runGitMergeTree({
      cwd: projectRoot,
      mergeBase,
      branchA: baseHead,
      branchB: laneHead,
      timeoutMs: 60_000
    });

    const [baseTouched, laneTouched] = await Promise.all([
      readTouchedFiles(projectRoot, mergeBase, baseHead),
      readTouchedFiles(projectRoot, mergeBase, laneHead)
    ]);
    const overlap = uniqueSorted(Array.from(laneTouched).filter((file) => baseTouched.has(file)));
    const conflicts = merge.conflicts.map((conflict) => ({
      path: conflict.path,
      conflictType: conflict.conflictType,
      markerPreview: conflict.markerPreview
    }));
    const status: PredictionStatus =
      conflicts.length > 0 ? "conflict" : merge.exitCode === 0 ? "clean" : "unknown";

    return upsertPrediction({
      laneAId: lane.id,
      laneBId: null,
      status,
      conflictingFiles: conflicts,
      overlapFiles: overlap,
      laneASha: laneHead,
      laneBSha: baseHead
    });
  };

  const predictPairwise = async (laneA: LaneSummary, laneB: LaneSummary): Promise<ConflictPrediction> => {
    const laneAHead = await readHeadSha(laneA.worktreePath, "HEAD");
    const laneBHead = await readHeadSha(laneB.worktreePath, "HEAD");
    const mergeBase = await readMergeBase(projectRoot, laneAHead, laneBHead);
    const merge = await runGitMergeTree({
      cwd: projectRoot,
      mergeBase,
      branchA: laneAHead,
      branchB: laneBHead,
      timeoutMs: 60_000
    });

    const [aTouched, bTouched] = await Promise.all([
      readTouchedFiles(projectRoot, mergeBase, laneAHead),
      readTouchedFiles(projectRoot, mergeBase, laneBHead)
    ]);
    const overlap = uniqueSorted(Array.from(aTouched).filter((file) => bTouched.has(file)));
    const conflicts = merge.conflicts.map((conflict) => ({
      path: conflict.path,
      conflictType: conflict.conflictType,
      markerPreview: conflict.markerPreview
    }));
    const status: PredictionStatus =
      conflicts.length > 0 ? "conflict" : merge.exitCode === 0 ? "clean" : "unknown";

    const [leftLane, rightLane, leftSha, rightSha] =
      laneA.id < laneB.id
        ? [laneA, laneB, laneAHead, laneBHead]
        : [laneB, laneA, laneBHead, laneAHead];

    return upsertPrediction({
      laneAId: leftLane.id,
      laneBId: rightLane.id,
      status,
      conflictingFiles: conflicts,
      overlapFiles: overlap,
      laneASha: leftSha,
      laneBSha: rightSha
    });
  };

  const getLaneStatusInternal = async (lane: LaneSummary): Promise<ConflictStatus> => {
    const baseRow = getLatestBaseRow(lane.id);
    const pairRows = latestPerPair(getLatestPairRowsForLane(lane.id));

    const overlapSet = new Set<string>();
    let peerConflictCount = 0;

    const foldRow = (row: ConflictPredictionRow) => {
      const conflicting = safeJsonArray<StoredConflictFile>(row.conflicting_files_json);
      const overlapFiles = safeJsonArray<string>(row.overlap_files_json);
      for (const path of overlapFiles) {
        const clean = path.trim();
        if (clean) overlapSet.add(clean);
      }
      for (const file of conflicting) {
        const clean = file.path?.trim();
        if (clean) overlapSet.add(clean);
      }
      if (row.status === "conflict" && row.lane_b_id) {
        peerConflictCount += 1;
      }
    };

    if (baseRow) foldRow(baseRow);
    for (const [key, row] of pairRows) {
      if (!key.startsWith("pair:")) continue;
      foldRow(row);
    }

    const hasPredictedConflict =
      (baseRow?.status === "conflict") ||
      Array.from(pairRows.values()).some((row) => row.lane_b_id != null && row.status === "conflict");
    const activeConflict = await hasActiveConflict(lane);
    const status = computeStatusValue({
      hasActiveConflict: activeConflict,
      hasBasePrediction: Boolean(baseRow),
      hasPredictedConflict,
      behindCount: lane.status.behind
    });

    const lastPredictedAt = [
      baseRow?.predicted_at ?? null,
      ...Array.from(pairRows.values()).map((row) => row.predicted_at)
    ]
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => b.localeCompare(a))[0] ?? null;

    return {
      laneId: lane.id,
      status,
      overlappingFileCount: overlapSet.size,
      peerConflictCount,
      lastPredictedAt
    };
  };

  const getRiskMatrixAndOverlaps = async (lanes: LaneSummary[]): Promise<{
    matrix: RiskMatrixEntry[];
    overlaps: BatchOverlapEntry[];
  }> => {
    const latest = getLatestRows();
    const matrix: RiskMatrixEntry[] = [];
    const overlapEntries: BatchOverlapEntry[] = [];

    for (const lane of lanes) {
      const row = latest.get(`base:${lane.id}`);
      const overlapFiles = extractOverlapFiles(row);
      const conflicting = safeJsonArray<StoredConflictFile>(row?.conflicting_files_json ?? null);
      matrix.push({
        laneAId: lane.id,
        laneBId: lane.id,
        riskLevel: riskFromPrediction(row?.status ?? "unknown", overlapFiles.length, conflicting.length),
        overlapCount: overlapFiles.length,
        hasConflict: (row?.status ?? "unknown") === "conflict" || conflicting.length > 0,
        computedAt: row?.predicted_at ?? null,
        stale: isStalePrediction(row?.predicted_at)
      });
      overlapEntries.push({
        laneAId: lane.id,
        laneBId: lane.id,
        files: overlapFiles
      });
    }

    for (let i = 0; i < lanes.length; i++) {
      for (let j = i + 1; j < lanes.length; j++) {
        const laneA = lanes[i]!;
        const laneB = lanes[j]!;
        const key = `pair:${pairKey(laneA.id, laneB.id)}`;
        const row = latest.get(key);
        const overlapFiles = extractOverlapFiles(row);
        const conflicting = safeJsonArray<StoredConflictFile>(row?.conflicting_files_json ?? null);
        matrix.push({
          laneAId: laneA.id,
          laneBId: laneB.id,
          riskLevel: riskFromPrediction(row?.status ?? "unknown", overlapFiles.length, conflicting.length),
          overlapCount: overlapFiles.length,
          hasConflict: (row?.status ?? "unknown") === "conflict" || conflicting.length > 0,
          computedAt: row?.predicted_at ?? null,
          stale: isStalePrediction(row?.predicted_at)
        });
        overlapEntries.push({
          laneAId: laneA.id,
          laneBId: laneB.id,
          files: overlapFiles
        });
      }
    }

    return {
      matrix,
      overlaps: overlapEntries
    };
  };

  const buildBatchAssessment = async (options: {
    progress?: { completedPairs: number; totalPairs: number };
    truncated?: boolean;
    comparedLaneIds?: string[];
    maxAutoLanes?: number;
    totalLanes?: number;
    strategy?: string;
    pairwisePairsComputed?: number;
    pairwisePairsTotal?: number;
  } = {}): Promise<BatchAssessmentResult> => {
    const lanes = await listActiveLanes();
    const statuses = await Promise.all(lanes.map((lane) => getLaneStatusInternal(lane)));
    const { matrix, overlaps } = await getRiskMatrixAndOverlaps(lanes);
    return {
      lanes: statuses,
      matrix,
      overlaps,
      computedAt: new Date().toISOString(),
      progress: options.progress,
      truncated: options.truncated,
      comparedLaneIds: options.comparedLaneIds,
      maxAutoLanes: options.maxAutoLanes,
      totalLanes: options.totalLanes,
      strategy: options.strategy,
      pairwisePairsComputed: options.pairwisePairsComputed,
      pairwisePairsTotal: options.pairwisePairsTotal
    };
  };

  const buildChips = (prev: RiskMatrixEntry[], next: RiskMatrixEntry[]): ConflictChip[] => {
    const prevMap = new Map(prev.map((entry) => [matrixEntryKey(entry), entry]));
    const chips: ConflictChip[] = [];

    for (const entry of next) {
      if (entry.laneAId === entry.laneBId) continue;
      const key = matrixEntryKey(entry);
      const previous = prevMap.get(key);

      const isNewOverlap = entry.overlapCount > 0 && (previous == null || previous.overlapCount === 0);
      if (isNewOverlap) {
        chips.push(
          { laneId: entry.laneAId, peerId: entry.laneBId, kind: "new-overlap", overlapCount: entry.overlapCount },
          { laneId: entry.laneBId, peerId: entry.laneAId, kind: "new-overlap", overlapCount: entry.overlapCount }
        );
      }

      const becameHighRisk =
        entry.riskLevel === "high" && (previous == null || RISK_SCORE[previous.riskLevel] < RISK_SCORE.high);
      if (becameHighRisk) {
        chips.push(
          { laneId: entry.laneAId, peerId: entry.laneBId, kind: "high-risk", overlapCount: entry.overlapCount },
          { laneId: entry.laneBId, peerId: entry.laneAId, kind: "high-risk", overlapCount: entry.overlapCount }
        );
      }
    }

    return dedupeChips(chips);
  };

  const writeConflictPacks = async (assessment: BatchAssessmentResult): Promise<void> => {
    if (!conflictPacksDir) return;
    const predictionsDir = path.join(conflictPacksDir, "predictions");
    fs.mkdirSync(predictionsDir, { recursive: true });

    for (const status of assessment.lanes) {
      try {
        const overlaps = await listOverlaps({ laneId: status.laneId });
        const laneMatrix = assessment.matrix.filter(
          (entry) => entry.laneAId === status.laneId || entry.laneBId === status.laneId
        );
        const matrixRowFor = (peerId: string | null) => {
          if (!peerId) {
            return laneMatrix.find((m) => m.laneAId === status.laneId && m.laneBId === status.laneId) ?? null;
          }
          return (
            laneMatrix.find((m) => (m.laneAId === status.laneId && m.laneBId === peerId) || (m.laneAId === peerId && m.laneBId === status.laneId)) ??
            null
          );
        };

        const openConflictSummaries = overlaps
          .filter((ov) => ov && (ov.files?.length ?? 0) > 0)
          .map((ov) => {
            const row = matrixRowFor(ov.peerId ?? null);
            const riskSignals: string[] = [];
            if (row?.stale) riskSignals.push("stale_prediction");
            if (row?.hasConflict) riskSignals.push("predicted_conflict");
            if ((ov.files?.length ?? 0) > 0) riskSignals.push("overlap_files");
            if (assessment.truncated) riskSignals.push("partial_coverage");
            return {
              peerId: ov.peerId ?? null,
              peerLabel: ov.peerName,
              riskLevel: ov.riskLevel,
              fileCount: ov.files.length,
              lastSeenAt: row?.computedAt ?? status.lastPredictedAt ?? null,
              riskSignals
            };
          })
          .sort((a, b) => b.fileCount - a.fileCount || a.peerLabel.localeCompare(b.peerLabel))
          .slice(0, 12);

        const payload = {
          schema: "ade.conflicts.predictionPack.v2",
          laneId: status.laneId,
          status,
          overlaps,
          matrix: laneMatrix,
          generatedAt: assessment.computedAt,
          predictionAt: status.lastPredictedAt ?? null,
          lastRecomputedAt: assessment.computedAt,
          stalePolicy: { ttlMs: STALE_MS },
          openConflictSummaries,
          truncated: Boolean(assessment.truncated),
          strategy: assessment.strategy,
          pairwisePairsComputed: assessment.pairwisePairsComputed,
          pairwisePairsTotal: assessment.pairwisePairsTotal
        };
        const outPath = path.join(predictionsDir, `${status.laneId}.json`);
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
      } catch (error) {
        logger.warn("conflicts.pack_write_failed", {
          laneId: status.laneId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const getLaneStatus = async (args: GetLaneConflictStatusArgs): Promise<ConflictStatus> => {
    const lane = (await listActiveLanes()).find((entry) => entry.id === args.laneId);
    if (!lane) {
      throw new Error(`Lane not found: ${args.laneId}`);
    }
    return await getLaneStatusInternal(lane);
  };

  const listOverlaps = async (args: ListOverlapsArgs): Promise<ConflictOverlap[]> => {
    const lanes = await listActiveLanes();
    const lane = lanes.find((entry) => entry.id === args.laneId);
    if (!lane) throw new Error(`Lane not found: ${args.laneId}`);
    const laneMap = laneById(lanes);

    const overlaps: ConflictOverlap[] = [];
    const baseRow = getLatestBaseRow(args.laneId);
    if (baseRow) {
      const conflicting = safeJsonArray<StoredConflictFile>(baseRow.conflicting_files_json);
      const overlapFiles = safeJsonArray<string>(baseRow.overlap_files_json);
      const files = buildConflictFiles(conflicting, overlapFiles).map((file) => ({
        path: file.path,
        conflictType: file.conflictType
      }));
      overlaps.push({
        peerId: null,
        peerName: `base (${lane.baseRef})`,
        files,
        riskLevel: riskFromPrediction(baseRow.status, overlapFiles.length, conflicting.length)
      });
    }

    const latest = latestPerPair(getLatestPairRowsForLane(args.laneId));
    for (const [key, row] of latest) {
      if (!key.startsWith("pair:") || row.lane_b_id == null) continue;
      const peerId = row.lane_a_id === args.laneId ? row.lane_b_id : row.lane_a_id;
      const peerLane = laneMap.get(peerId);
      const conflicting = safeJsonArray<StoredConflictFile>(row.conflicting_files_json);
      const overlapFiles = safeJsonArray<string>(row.overlap_files_json);
      const files = buildConflictFiles(conflicting, overlapFiles).map((file) => ({
        path: file.path,
        conflictType: file.conflictType
      }));
      overlaps.push({
        peerId,
        peerName: peerLane?.name ?? "Unknown lane",
        files,
        riskLevel: riskFromPrediction(row.status, overlapFiles.length, conflicting.length)
      });
    }

    overlaps.sort((a, b) => {
      const riskDelta = RISK_SCORE[b.riskLevel] - RISK_SCORE[a.riskLevel];
      if (riskDelta !== 0) return riskDelta;
      return a.peerName.localeCompare(b.peerName);
    });
    return overlaps;
  };

  const getRiskMatrix = async (): Promise<RiskMatrixEntry[]> => {
    const lanes = await listActiveLanes();
    return (await getRiskMatrixAndOverlaps(lanes)).matrix;
  };

  const simulateMerge = async (args: MergeSimulationArgs): Promise<MergeSimulationResult> => {
      const lanes = await listActiveLanes();
      const laneA = lanes.find((entry) => entry.id === args.laneAId);
      if (!laneA) {
        return {
          outcome: "error",
          mergedFiles: [],
          conflictingFiles: [],
          diffStat: { insertions: 0, deletions: 0, filesChanged: 0 },
          error: `Lane not found: ${args.laneAId}`
        };
      }

      try {
        const laneAHead = await readHeadSha(laneA.worktreePath, "HEAD");

        let laneBHead: string;
        if (args.laneBId) {
          const laneB = lanes.find((entry) => entry.id === args.laneBId);
          if (!laneB) {
            return {
              outcome: "error",
              mergedFiles: [],
              conflictingFiles: [],
              diffStat: { insertions: 0, deletions: 0, filesChanged: 0 },
              error: `Lane not found: ${args.laneBId}`
            };
          }
          laneBHead = await readHeadSha(laneB.worktreePath, "HEAD");
        } else {
          laneBHead = await readHeadSha(projectRoot, laneA.baseRef);
        }

        const mergeBase = await readMergeBase(projectRoot, laneAHead, laneBHead);
        const merge = await runGitMergeTree({
          cwd: projectRoot,
          mergeBase,
          branchA: laneAHead,
          branchB: laneBHead,
          timeoutMs: 60_000
        });

        const [statA, statB, touchedA, touchedB] = await Promise.all([
          readDiffNumstat(projectRoot, mergeBase, laneAHead),
          readDiffNumstat(projectRoot, mergeBase, laneBHead),
          readTouchedFiles(projectRoot, mergeBase, laneAHead),
          readTouchedFiles(projectRoot, mergeBase, laneBHead)
        ]);

        const mergedFiles = uniqueSorted(new Set([...touchedA, ...touchedB]));
        const overlapFiles = uniqueSorted(Array.from(touchedA).filter((file) => touchedB.has(file)));
        const conflictFiles = buildConflictFiles(
          merge.conflicts.map((entry) => ({
            path: entry.path,
            conflictType: entry.conflictType,
            markerPreview: entry.markerPreview
          })),
          merge.exitCode === 0 ? [] : overlapFiles
        );

        return {
          outcome: conflictFiles.length > 0 ? "conflict" : merge.exitCode === 0 ? "clean" : "error",
          mergedFiles,
          conflictingFiles: conflictFiles.map((file) => ({
            path: file.path,
            conflictMarkers: file.markerPreview
          })),
          diffStat: {
            insertions: statA.insertions + statB.insertions,
            deletions: statA.deletions + statB.deletions,
            filesChanged: new Set([...statA.files, ...statB.files]).size
          },
          error: merge.exitCode === 0 ? undefined : merge.stderr.trim() || undefined
        };
      } catch (error) {
        return {
          outcome: "error",
          mergedFiles: [],
          conflictingFiles: [],
          diffStat: { insertions: 0, deletions: 0, filesChanged: 0 },
          error: error instanceof Error ? error.message : String(error)
        };
      }
    };

  const pruneTouchedFilesForHeuristic = (files: Set<string>): Set<string> => {
    if (files.size <= PREFILTER_MAX_TOUCHED_FILES) return files;
    const sorted = Array.from(files).sort((a, b) => a.localeCompare(b));
    return new Set(sorted.slice(0, PREFILTER_MAX_TOUCHED_FILES));
  };

  const readTouchedFilesSinceBase = async (lane: LaneSummary): Promise<Set<string>> => {
    try {
      const laneHead = await readHeadSha(lane.worktreePath, "HEAD");
      const baseHead = await readHeadSha(projectRoot, lane.baseRef);
      const mergeBase = await readMergeBase(projectRoot, baseHead, laneHead);
      const touched = await readTouchedFiles(projectRoot, mergeBase, laneHead);
      return pruneTouchedFilesForHeuristic(touched);
    } catch {
      return new Set<string>();
    }
  };

  const intersectionCount = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let count = 0;
    for (const file of small) {
      if (big.has(file)) count += 1;
    }
    return count;
  };

  const buildPrefilterPairs = async (
    comparisonLanes: LaneSummary[]
  ): Promise<Array<{ laneA: LaneSummary; laneB: LaneSummary; overlapCount: number }>> => {
    const touchedById = new Map<string, Set<string>>();
    for (const lane of comparisonLanes) {
      touchedById.set(lane.id, await readTouchedFilesSinceBase(lane));
    }

    const overlapsByLane = new Map<string, Array<{ peerId: string; overlapCount: number }>>();
    const overlapByPair = new Map<string, number>();

    for (let i = 0; i < comparisonLanes.length; i++) {
      for (let j = i + 1; j < comparisonLanes.length; j++) {
        const laneA = comparisonLanes[i]!;
        const laneB = comparisonLanes[j]!;
        const count = intersectionCount(touchedById.get(laneA.id) ?? new Set(), touchedById.get(laneB.id) ?? new Set());
        if (count <= 0) continue;
        const key = pairKey(laneA.id, laneB.id);
        overlapByPair.set(key, count);

        const left = overlapsByLane.get(laneA.id) ?? [];
        left.push({ peerId: laneB.id, overlapCount: count });
        overlapsByLane.set(laneA.id, left);

        const right = overlapsByLane.get(laneB.id) ?? [];
        right.push({ peerId: laneA.id, overlapCount: count });
        overlapsByLane.set(laneB.id, right);
      }
    }

    const candidateKeys = new Set<string>();
    for (const lane of comparisonLanes) {
      const peers = overlapsByLane.get(lane.id) ?? [];
      peers.sort((a, b) => b.overlapCount - a.overlapCount || a.peerId.localeCompare(b.peerId));
      for (const peer of peers.slice(0, PREFILTER_MAX_PEERS_PER_LANE)) {
        candidateKeys.add(pairKey(lane.id, peer.peerId));
      }
    }

    let keys = Array.from(candidateKeys);
    if (keys.length > PREFILTER_MAX_GLOBAL_PAIRS) {
      keys.sort((a, b) => (overlapByPair.get(b) ?? 0) - (overlapByPair.get(a) ?? 0) || a.localeCompare(b));
      keys = keys.slice(0, PREFILTER_MAX_GLOBAL_PAIRS);
    }

    const laneMap = laneById(comparisonLanes);
    const out: Array<{ laneA: LaneSummary; laneB: LaneSummary; overlapCount: number }> = [];
    for (const key of keys) {
      const [aId, bId] = key.split("::");
      if (!aId || !bId) continue;
      const laneA = laneMap.get(aId);
      const laneB = laneMap.get(bId);
      if (!laneA || !laneB) continue;
      out.push({ laneA, laneB, overlapCount: overlapByPair.get(key) ?? 0 });
    }

    out.sort((a, b) => b.overlapCount - a.overlapCount || a.laneA.id.localeCompare(b.laneA.id) || a.laneB.id.localeCompare(b.laneB.id));
    return out;
  };

  const runPrediction = async (args: RunConflictPredictionArgs = {}): Promise<BatchAssessmentResult> => {
      const lanes = await listActiveLanes();
      if (lanes.length === 0) {
        return {
          lanes: [],
          matrix: [],
          overlaps: [],
          computedAt: new Date().toISOString(),
          progress: { completedPairs: 0, totalPairs: 0 }
        };
      }

      const before = await buildBatchAssessment();
      const targetLane = args.laneId ? lanes.find((lane) => lane.id === args.laneId) : null;
      if (args.laneId && !targetLane) {
        throw new Error(`Lane not found: ${args.laneId}`);
      }

      const requestedLaneIds = uniqueSorted(
        (args.laneIds ?? [])
          .map((laneId) => laneId.trim())
          .filter(Boolean)
      );

      let comparisonLanes: LaneSummary[] = [];
      let basePredictionLanes: LaneSummary[] = [];
      let strategy = "full";
      let truncated = false;
      let pairwisePairsTotal = 0;
      let pairwisePairsComputed = 0;
      let pairwiseComparisons: Array<{ laneA: LaneSummary; laneB: LaneSummary }> = [];

      if (targetLane) {
        comparisonLanes = lanes;
        basePredictionLanes = [targetLane];
        strategy = "full-target";
        pairwisePairsTotal = Math.max(0, lanes.length - 1);
        pairwiseComparisons = lanes
          .filter((lane) => lane.id !== targetLane.id)
          .map((peer) => ({ laneA: targetLane, laneB: peer }));
      } else {
        if (requestedLaneIds.length > 0) {
          const requestedSet = new Set(requestedLaneIds);
          const selected = lanes.filter((lane) => requestedSet.has(lane.id));
          if (selected.length === 0) {
            throw new Error("No valid lanes selected for conflict prediction");
          }
          comparisonLanes = selected;
        } else {
          comparisonLanes = lanes;
        }
        basePredictionLanes = comparisonLanes;
        pairwisePairsTotal = Math.max(0, (comparisonLanes.length * (comparisonLanes.length - 1)) / 2);

        if (comparisonLanes.length <= FULL_MATRIX_MAX_LANES) {
          strategy = "full";
          for (let i = 0; i < comparisonLanes.length; i++) {
            for (let j = i + 1; j < comparisonLanes.length; j++) {
              const laneA = comparisonLanes[i]!;
              const laneB = comparisonLanes[j]!;
              pairwiseComparisons.push({ laneA, laneB });
            }
          }
        } else {
          strategy = "prefilter-overlap";
          const pairs = await buildPrefilterPairs(comparisonLanes);
          pairwiseComparisons = pairs.map((pair) => ({ laneA: pair.laneA, laneB: pair.laneB }));
          truncated = pairwiseComparisons.length < pairwisePairsTotal;
        }
      }

      pairwisePairsComputed = pairwiseComparisons.length;
      const totalPairs = pairwiseComparisons.length;
      let completedPairs = 0;

      const emitProgress = (pair?: { laneAId: string; laneBId: string }) => {
        if (!onEvent) return;
        onEvent({
          type: "prediction-progress",
          computedAt: new Date().toISOString(),
          laneIds: comparisonLanes.map((lane) => lane.id),
          completedPairs,
          totalPairs,
          pair
        });
      };

      for (const lane of basePredictionLanes) {
        try {
          await runSerializedPairTask(`base:${lane.id}`, async () => {
            await predictLaneVsBase(lane);
          });
        } catch (error) {
          logger.warn("conflicts.predict_lane_base_failed", {
            laneId: lane.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      for (const pair of pairwiseComparisons) {
        try {
          const pairId = `pair:${pairKey(pair.laneA.id, pair.laneB.id)}`;
          await runSerializedPairTask(pairId, async () => {
            await predictPairwise(pair.laneA, pair.laneB);
          });
        } catch (error) {
          logger.warn("conflicts.predict_pair_failed", {
            laneId: pair.laneA.id,
            peerId: pair.laneB.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        completedPairs += 1;
        emitProgress({ laneAId: pair.laneA.id, laneBId: pair.laneB.id });
      }

      const after = await buildBatchAssessment({
        progress: { completedPairs, totalPairs },
        truncated,
        comparedLaneIds: comparisonLanes.map((lane) => lane.id),
        totalLanes: lanes.length,
        strategy,
        pairwisePairsComputed,
        pairwisePairsTotal
      });
      await writeConflictPacks(after);
      const chips = buildChips(before.matrix, after.matrix);
      if (onEvent) {
        const relatedPeerIds = chips
          .map((chip) => chip.peerId)
          .filter((peerId): peerId is string => Boolean(peerId));
        const laneIds = targetLane
          ? uniqueSorted([targetLane.id, ...relatedPeerIds])
          : comparisonLanes.map((lane) => lane.id);
        onEvent({
          type: "prediction-complete",
          computedAt: after.computedAt,
          laneIds,
          chips,
          completedPairs,
          totalPairs
        });
      }
      return after;
    };

  const getBatchAssessment = async (): Promise<BatchAssessmentResult> => {
      const hasAny = db.get<{ id: string }>(
        "select id from conflict_predictions where project_id = ? limit 1",
        [projectId]
      );
      if (!hasAny) {
        return await runPrediction({});
      }
      const lanes = await listActiveLanes();
      const comparedLaneIds = lanes.map((lane) => lane.id);

      const readAssessmentMeta = (): {
        truncated?: boolean;
        strategy?: string;
        pairwisePairsComputed?: number;
        pairwisePairsTotal?: number;
      } => {
        if (!conflictPacksDir) return {};
        const predictionsDir = path.join(conflictPacksDir, "predictions");
        if (!fs.existsSync(predictionsDir)) return {};
        try {
          const entries = fs
            .readdirSync(predictionsDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
          if (!entries.length) return {};

          let bestName = entries[0]!.name;
          let bestMtime = fs.statSync(path.join(predictionsDir, bestName)).mtimeMs;
          for (const entry of entries.slice(1)) {
            const ms = fs.statSync(path.join(predictionsDir, entry.name)).mtimeMs;
            if (ms > bestMtime) {
              bestMtime = ms;
              bestName = entry.name;
            }
          }

          const raw = fs.readFileSync(path.join(predictionsDir, bestName), "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
          const record = parsed as Record<string, unknown>;

          return {
            truncated: typeof record.truncated === "boolean" ? record.truncated : undefined,
            strategy: typeof record.strategy === "string" ? record.strategy : undefined,
            pairwisePairsComputed: typeof record.pairwisePairsComputed === "number" ? record.pairwisePairsComputed : undefined,
            pairwisePairsTotal: typeof record.pairwisePairsTotal === "number" ? record.pairwisePairsTotal : undefined
          };
        } catch {
          return {};
        }
      };

      const meta = readAssessmentMeta();
      const computed = Number(meta.pairwisePairsComputed ?? NaN);
      const total =
        Number(meta.pairwisePairsTotal ?? NaN) ||
        Math.max(0, (comparedLaneIds.length * (comparedLaneIds.length - 1)) / 2);
      const truncated =
        typeof meta.truncated === "boolean"
          ? meta.truncated
          : Number.isFinite(computed) && Number.isFinite(total) && total > 0
            ? computed < total
            : false;

      return await buildBatchAssessment({
        truncated,
        comparedLaneIds,
        totalLanes: lanes.length,
        strategy: meta.strategy,
        pairwisePairsComputed: Number.isFinite(computed) ? computed : undefined,
        pairwisePairsTotal: Number.isFinite(total) ? total : undefined
      });
    };

  const getProposalRow = (proposalId: string): ConflictProposalRow | null => {
    return db.get<ConflictProposalRow>(
      `
        select
          id,
          lane_id,
          peer_lane_id,
          prediction_id,
          source,
          confidence,
          explanation,
          diff_patch,
          status,
          job_id,
          artifact_id,
          applied_operation_id,
          created_at,
          updated_at
        from conflict_proposals
        where id = ?
          and project_id = ?
        limit 1
      `,
      [proposalId, projectId]
    );
  };

  const listProposals = async (args: { laneId: string }): Promise<ConflictProposal[]> => {
    const rows = db.all<ConflictProposalRow>(
      `
        select
          id,
          lane_id,
          peer_lane_id,
          prediction_id,
          source,
          confidence,
          explanation,
          diff_patch,
          status,
          job_id,
          artifact_id,
          applied_operation_id,
          created_at,
          updated_at
        from conflict_proposals
        where project_id = ?
          and lane_id = ?
        order by created_at desc
      `,
      [projectId, args.laneId]
    );
    return rows.map(rowToProposal);
  };

  const getLatestPredictionId = (laneId: string, peerLaneId: string | null): string | null => {
    if (!peerLaneId) {
      const row = db.get<{ id: string }>(
        `
          select id
          from conflict_predictions
          where project_id = ?
            and lane_a_id = ?
            and lane_b_id is null
          order by predicted_at desc
          limit 1
        `,
        [projectId, laneId]
      );
      return row?.id ?? null;
    }

    const [laneAId, laneBId] = laneId < peerLaneId ? [laneId, peerLaneId] : [peerLaneId, laneId];
    const row = db.get<{ id: string }>(
      `
        select id
        from conflict_predictions
        where project_id = ?
          and lane_a_id = ?
          and lane_b_id = ?
        order by predicted_at desc
        limit 1
      `,
      [projectId, laneAId, laneBId]
    );
    return row?.id ?? null;
  };

  const findExistingProposalIdForDigest = (args: { laneId: string; peerLaneId: string | null; contextDigest: string }): string | null => {
    const rows = db.all<{ id: string; peer_lane_id: string | null; metadata_json: string | null }>(
      `
        select id, peer_lane_id, metadata_json
        from conflict_proposals
        where project_id = ?
          and lane_id = ?
        order by created_at desc
        limit 50
      `,
      [projectId, args.laneId]
    );
    for (const row of rows) {
      const peer = row.peer_lane_id ?? null;
      if (peer !== args.peerLaneId) continue;
      const meta = safeParseMetadata(row.metadata_json);
      if (typeof meta.contextDigest === "string" && meta.contextDigest === args.contextDigest) {
        return row.id;
      }
    }
    return null;
  };

  const readConflictResolutionConfig = () => {
    const config = projectConfigService.get().effective.ai?.conflictResolution ?? {};
    const thresholdRaw = Number(config.autoApplyThreshold ?? NaN);
    const threshold = Number.isFinite(thresholdRaw) ? Math.max(0, Math.min(1, thresholdRaw)) : 0.85;
    return {
      changeTarget: config.changeTarget ?? "ai_decides",
      postResolution: config.postResolution ?? "staged",
      prBehavior: config.prBehavior ?? "do_nothing",
      autonomy: config.autonomy ?? "propose_only",
      autoApplyThreshold: threshold
    } as const;
  };

  const mapPostResolutionToApplyMode = (
    postResolution: ReturnType<typeof readConflictResolutionConfig>["postResolution"]
  ): ApplyConflictProposalArgs["applyMode"] => {
    if (postResolution === "unstaged") return "unstaged";
    if (postResolution === "commit") return "commit";
    return "staged";
  };

  const prepareProposal = async (args: PrepareConflictProposalArgs): Promise<ConflictProposalPreview> => {
    cleanupPreparedContexts();

    const laneId = args.laneId.trim();
    if (!laneId) throw new Error("laneId is required");
    const peerLaneId = args.peerLaneId?.trim() || null;

    const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
    const aiMode = aiIntegrationService?.getMode() ?? "guest";
    const subscriptionAvailable = providerMode !== "guest" && aiMode === "subscription" && Boolean(aiIntegrationService);
    const provider: ConflictProposalProvider = "subscription";

    const lanes = await listActiveLanes();
    const lane = lanes.find((entry) => entry.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);

    // CONF-022: stack-aware conflict resolution. If a lane is stacked, resolve parent conflicts first.
    if (lane.parentLaneId) {
      const parentStatus = await getLaneStatus({ laneId: lane.parentLaneId }).catch(() => null);
      if (parentStatus && parentStatus.status !== "merge-ready") {
        throw new Error(`Stack-aware resolution: resolve parent lane conflicts first (parent status: ${parentStatus.status}).`);
      }
    }

    const warnings: string[] = [];
    if (!subscriptionAvailable) {
      warnings.push("Subscription AI is unavailable; proposal preview is prepared for manual/external resolution.");
    }
    const MAX_FILES = 6;
    const MAX_DIFF_CHARS = 6_000;
    const MAX_FILE_CONTEXT_CHARS = 8_000;
    const LANE_EXPORT_LEVEL = "lite";
    const CONFLICT_EXPORT_LEVEL = "standard";

    const truncate = (label: string, text: string, maxChars: number): string => {
      const clean = text ?? "";
      if (clean.length <= maxChars) return clean;
      warnings.push(`${label} truncated to ${maxChars} characters.`);
      return `${clean.slice(0, maxChars)}\n...(truncated)...\n`;
    };

    const preparedAt = new Date().toISOString();

    if (packService) {
      await packService.refreshLanePack({ laneId, reason: "conflict_proposal_prepare" });
      if (peerLaneId) {
        await packService.refreshLanePack({ laneId: peerLaneId, reason: "conflict_proposal_prepare" });
      }
      await packService.refreshConflictPack({ laneId, peerLaneId, reason: "conflict_proposal_prepare" });
    }

    const conflictState = await readGitConflictState(laneId);
    const activeConflict: GitConflictState = {
      laneId,
      kind: conflictState.kind,
      inProgress: conflictState.inProgress,
      conflictedFiles: conflictState.conflictedFiles,
      canContinue: conflictState.canContinue,
      canAbort: conflictState.canAbort
    };

    const overlaps = await listOverlaps({ laneId });
    const status = await getLaneStatus({ laneId });
    const overlapEntry = overlaps.find((entry) => entry.peerId === peerLaneId) ?? null;
    const overlapPaths = (overlapEntry?.files ?? []).map((file) => file.path).filter(Boolean);

    const includeFromConflicts = activeConflict.inProgress && activeConflict.conflictedFiles.length > 0;
    const includeReason: ConflictProposalPreviewFile["includeReason"] = includeFromConflicts ? "conflicted" : "overlap";
    const selectedSourcePaths = uniqueSorted(includeFromConflicts ? activeConflict.conflictedFiles : overlapPaths);
    const selectedPaths = selectedSourcePaths.slice(0, MAX_FILES);
    if (selectedSourcePaths.length > MAX_FILES) {
      warnings.push(
        `Conflict context omitted ${selectedSourcePaths.length - MAX_FILES} files (omitted:path_count_limit).`
      );
    }
    if (selectedPaths.length === 0) {
      warnings.push("No conflicted/overlap files found; proposal context will be minimal.");
    }

    let laneExportLite: string | null = null;
    let peerLaneExportLite: string | null = null;
    let conflictExportStandard: string | null = null;
    if (packService) {
      try {
        laneExportLite = (await packService.getLaneExport({ laneId, level: LANE_EXPORT_LEVEL })).content;
      } catch (error) {
        warnings.push(`Lane export unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (peerLaneId) {
        try {
          peerLaneExportLite = (await packService.getLaneExport({ laneId: peerLaneId, level: LANE_EXPORT_LEVEL })).content;
        } catch (error) {
          warnings.push(`Peer lane export unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        conflictExportStandard = (await packService.getConflictExport({ laneId, peerLaneId, level: CONFLICT_EXPORT_LEVEL })).content;
      } catch (error) {
        warnings.push(`Conflict export unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      warnings.push("Pack service unavailable; conflict exports omitted from AI context.");
    }

    const files: ConflictProposalPreviewFile[] = [];
    const relevantFilesForConflict: ConflictRelevantFileV1[] = [];
    const fileContexts: ConflictFileContextV1[] = [];
    const laneGit = laneService.getLaneBaseAndBranch(laneId);
    const laneHeadSha = await readHeadSha(laneGit.worktreePath, laneGit.branchRef || "HEAD")
      .catch(async () => await readHeadSha(laneGit.worktreePath).catch(() => ""));
    const mergeHeadSha = (conflictState.mergeHeadSha ?? "").trim();

    const diffMode = await (async (): Promise<
      | { kind: "merge-head"; base: string; laneHeadSha: string; peerHeadSha: string }
      | { kind: "peer-lane"; base: string; laneHeadSha: string; peerHeadSha: string }
      | { kind: "base-ref"; baseRef: string; laneHeadSha: string }
      | { kind: "none" }
    > => {
      if (!laneHeadSha) return { kind: "none" };

      if (activeConflict.kind === "merge" && mergeHeadSha.length) {
        const base = await readMergeBase(laneGit.worktreePath, laneHeadSha, mergeHeadSha).catch(() => "");
        if (base.trim().length) return { kind: "merge-head", base: base.trim(), laneHeadSha, peerHeadSha: mergeHeadSha };
      }

      if (peerLaneId) {
        const peerGit = laneService.getLaneBaseAndBranch(peerLaneId);
        const peerHeadSha = await readHeadSha(peerGit.worktreePath, peerGit.branchRef || "HEAD")
          .catch(async () => await readHeadSha(peerGit.worktreePath).catch(() => ""));
        if (peerHeadSha) {
          const base = await readMergeBase(laneGit.worktreePath, laneHeadSha, peerHeadSha).catch(() => "");
          if (base.trim().length) return { kind: "peer-lane", base: base.trim(), laneHeadSha, peerHeadSha };
        }
      }

      const parentLane = lane.parentLaneId ? lanes.find((entry) => entry.id === lane.parentLaneId) ?? null : null;
      const baseRef = parentLane?.branchRef ?? lane.baseRef;
      return { kind: "base-ref", baseRef, laneHeadSha };
    })();

    for (const rawPath of selectedPaths) {
      const filePath = rawPath.trim();
      if (!filePath) continue;
      try {
        ensureRelativeRepoPath(filePath);
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
        continue;
      }

      const markerPreview = activeConflict.inProgress ? extractMarkerPreview(laneId, filePath, warnings) : null;

      const laneDiff = await (async () => {
        if (diffMode.kind === "merge-head" || diffMode.kind === "peer-lane") {
          const res = await runGit(["diff", "--unified=3", `${diffMode.base}..${diffMode.laneHeadSha}`, "--", filePath], {
            cwd: laneGit.worktreePath,
            timeoutMs: 25_000
          });
          return res.exitCode === 0 ? truncate(`Lane diff (${filePath})`, res.stdout, MAX_DIFF_CHARS) : "";
        }
        if (diffMode.kind === "base-ref") {
          const res = await runGit(["diff", "--unified=3", `${diffMode.baseRef}..${diffMode.laneHeadSha}`, "--", filePath], {
            cwd: laneGit.worktreePath,
            timeoutMs: 25_000
          });
          return res.exitCode === 0 ? truncate(`Lane diff (${filePath})`, res.stdout, MAX_DIFF_CHARS) : "";
        }
        return "";
      })();

      const peerDiff = await (async () => {
        if (diffMode.kind === "merge-head" || diffMode.kind === "peer-lane") {
          const res = await runGit(["diff", "--unified=3", `${diffMode.base}..${diffMode.peerHeadSha}`, "--", filePath], {
            cwd: laneGit.worktreePath,
            timeoutMs: 25_000
          });
          return res.exitCode === 0 ? truncate(`Peer diff (${filePath})`, res.stdout, MAX_DIFF_CHARS) : "";
        }
        return null;
      })();

      files.push({
        path: filePath,
        includeReason,
        markerPreview: markerPreview ?? null,
        laneDiff,
        peerDiff: peerDiff ?? null
      });

      relevantFilesForConflict.push({
        path: filePath,
        includeReason,
        selectedBecause: includeFromConflicts ? "active_conflict_file" : "overlap_prediction_file"
      });

      const baseRefForContext =
        diffMode.kind === "merge-head" || diffMode.kind === "peer-lane"
          ? diffMode.base
          : diffMode.kind === "base-ref"
            ? diffMode.baseRef
            : null;
      const leftRefForContext = diffMode.kind === "none" ? null : diffMode.laneHeadSha;
      const rightRefForContext =
        diffMode.kind === "merge-head" || diffMode.kind === "peer-lane" ? diffMode.peerHeadSha : null;

      const laneDiffClipped = truncate(`Lane file context (${filePath})`, laneDiff, MAX_FILE_CONTEXT_CHARS);
      const peerDiffClipped = peerDiff ? truncate(`Peer file context (${filePath})`, peerDiff, MAX_FILE_CONTEXT_CHARS) : "";
      const markerPreviewClipped = markerPreview ? truncate(`Marker preview (${filePath})`, markerPreview, 2400) : "";

      const hunkSummaries: ConflictFileHunkV1[] = [
        ...parseHunksFromDiff(laneDiffClipped, "base_left"),
        ...parseHunksFromDiff(peerDiffClipped, "base_right")
      ];

      const omittedReasonTags: string[] = [];
      if (!laneDiffClipped.trim() && !peerDiffClipped.trim() && !markerPreviewClipped.trim()) {
        omittedReasonTags.push("omitted:no_text_context");
      }
      if (laneDiff.length > MAX_FILE_CONTEXT_CHARS || (peerDiff ?? "").length > MAX_FILE_CONTEXT_CHARS) {
        omittedReasonTags.push("omitted:byte_cap");
      }

      fileContexts.push({
        path: filePath,
        selectedBecause: includeFromConflicts ? "active_conflict_file" : "overlap_prediction_file",
        hunks: hunkSummaries,
        base: makeContextSide({
          side: "base",
          ref: baseRefForContext,
          blobSha: null,
          excerpt: "",
          fallbackReason: "omitted:base_snapshot_not_loaded"
        }),
        left: makeContextSide({
          side: "left",
          ref: leftRefForContext,
          blobSha: null,
          excerpt: laneDiffClipped
        }),
        right: makeContextSide({
          side: "right",
          ref: rightRefForContext,
          blobSha: null,
          excerpt: peerDiffClipped
        }),
        markerPreview: markerPreviewClipped || null,
        ...(omittedReasonTags.length ? { omittedReasonTags } : {})
      });
    }

    const overlapSummary = overlapEntry
      ? {
          peerId: overlapEntry.peerId,
          peerName: overlapEntry.peerName,
          riskLevel: overlapEntry.riskLevel,
          fileCount: overlapEntry.files.length,
          files: overlapEntry.files.slice(0, 40)
        }
      : null;

    const extractNumericFromConflictExport = (key: string): number | null => {
      if (!conflictExportStandard) return null;
      const match = conflictExportStandard.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
      if (!match) return null;
      const value = Number(match[1] ?? NaN);
      return Number.isFinite(value) ? value : null;
    };

    const pairwisePairsComputed = extractNumericFromConflictExport("pairwisePairsComputed");
    const pairwisePairsTotal = extractNumericFromConflictExport("pairwisePairsTotal");
    const stalePolicyTtlFromExport = extractNumericFromConflictExport("ttlMs");
    const stalePolicyTtlMs = stalePolicyTtlFromExport != null ? stalePolicyTtlFromExport : STALE_MS;
    const predictionAgeMs = status.lastPredictedAt
      ? Math.max(0, Date.now() - Date.parse(status.lastPredictedAt))
      : null;
    const predictionStalenessMs = predictionAgeMs;
    const highPatchRisk =
      activeConflict.inProgress ||
      status.status === "conflict-active" ||
      status.status === "conflict-predicted" ||
      overlapEntry?.riskLevel === "high";
    const insufficientReasons: string[] = [];
    if (selectedPaths.length === 0) insufficientReasons.push("missing:relevant_files");
    if (relevantFilesForConflict.length > 0 && fileContexts.length === 0) {
      insufficientReasons.push("missing:file_contexts");
    }
    if (highPatchRisk && fileContexts.some((ctx) => (ctx.omittedReasonTags ?? []).includes("omitted:no_text_context"))) {
      insufficientReasons.push("missing:file_text_excerpt");
    }
    const insufficientContext = highPatchRisk && insufficientReasons.length > 0;

    const conflictJobContext: ConflictJobContextV1 = {
      schema: "ade.conflictJobContext.v1",
      relevantFilesForConflict,
      fileContexts,
      stalePolicy: { ttlMs: stalePolicyTtlMs },
      predictionAgeMs,
      predictionStalenessMs,
      pairwisePairsComputed,
      pairwisePairsTotal,
      insufficientContext,
      insufficientReasons
    };

    const conflictContext: Record<string, unknown> = {
      laneId,
      peerLaneId,
      preparedAt,
      provider,
      status,
      overlapSummary,
      activeConflict,
      ...(mergeHeadSha.length ? { mergeHeadSha } : {}),
      laneExportLite,
      peerLaneExportLite,
      conflictExportStandard,
      files,
      relevantFilesForConflict,
      fileContexts,
      predictionAgeMs,
      predictionStalenessMs,
      stalePolicy: { ttlMs: stalePolicyTtlMs },
      pairwisePairsComputed,
      pairwisePairsTotal,
      insufficientContext,
      insufficientReasons,
      conflictContext: conflictJobContext,
      limits: {
        maxFiles: MAX_FILES,
        maxDiffChars: MAX_DIFF_CHARS,
        maxFileContextChars: MAX_FILE_CONTEXT_CHARS,
        laneExportLevel: LANE_EXPORT_LEVEL,
        conflictExportLevel: CONFLICT_EXPORT_LEVEL
      }
    };

    const redactedContext = redactSecretsDeep(conflictContext) as Record<string, unknown>;
    const contextDigest = sha256(JSON.stringify(redactedContext));
    preparedContexts.set(contextDigest, {
      preparedAt,
      laneId,
      peerLaneId,
      provider,
      conflictContext: redactedContext
    });

    const existingProposalId = findExistingProposalIdForDigest({ laneId, peerLaneId, contextDigest });
    const approxChars = JSON.stringify(redactedContext).length;

    logger.info("conflicts.proposal_prepared", {
      laneId,
      peerLaneId,
      provider,
      fileCount: files.length,
      approxChars,
      activeKind: activeConflict.kind,
      activeInProgress: activeConflict.inProgress
    });

    const redactedLaneExportLite =
      typeof (redactedContext as any).laneExportLite === "string" ? ((redactedContext as any).laneExportLite as string) : null;
    const redactedPeerLaneExportLite =
      typeof (redactedContext as any).peerLaneExportLite === "string" ? ((redactedContext as any).peerLaneExportLite as string) : null;
    const redactedConflictExportStandard =
      typeof (redactedContext as any).conflictExportStandard === "string"
        ? ((redactedContext as any).conflictExportStandard as string)
        : null;

    return {
      laneId,
      peerLaneId,
      provider,
      preparedAt,
      contextDigest,
      activeConflict,
      laneExportLite: redactedLaneExportLite,
      peerLaneExportLite: redactedPeerLaneExportLite,
      conflictExportStandard: redactedConflictExportStandard,
      files,
      stats: {
        approxChars,
        laneExportChars: redactedLaneExportLite?.length ?? 0,
        peerLaneExportChars: redactedPeerLaneExportLite?.length ?? 0,
        conflictExportChars: redactedConflictExportStandard?.length ?? 0,
        fileCount: files.length
      },
      warnings,
      existingProposalId
    };
  };

  const requestProposal = async (args: RequestConflictProposalArgs): Promise<ConflictProposal> => {
    cleanupPreparedContexts();

    const laneId = args.laneId.trim();
    if (!laneId) throw new Error("laneId is required");
    const peerLaneId = args.peerLaneId?.trim() || null;
    const contextDigest = args.contextDigest.trim();
    if (!contextDigest) throw new Error("contextDigest is required (prepare context first).");

    const prepared = preparedContexts.get(contextDigest);
    if (!prepared) {
      throw new Error("Conflict context is missing or expired. Prepare a fresh preview before requesting AI.");
    }
    if (prepared.laneId !== laneId || prepared.peerLaneId !== peerLaneId) {
      throw new Error("Prepared conflict context does not match the requested lane/peer.");
    }

    const lanes = await listActiveLanes();
    const lane = lanes.find((entry) => entry.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);

    // Stack-aware check again: lane stacks can change between preview and request.
    if (lane.parentLaneId) {
      const parentStatus = await getLaneStatus({ laneId: lane.parentLaneId }).catch(() => null);
      if (parentStatus && parentStatus.status !== "merge-ready") {
        throw new Error(`Stack-aware resolution: resolve parent lane conflicts first (parent status: ${parentStatus.status}).`);
      }
    }

    const existingId = findExistingProposalIdForDigest({ laneId, peerLaneId, contextDigest });
    if (existingId) {
      const row = getProposalRow(existingId);
      if (!row) throw new Error("Failed to load existing proposal");
      return rowToProposal(row);
    }

    const preparedConflictContext =
      isRecord(prepared.conflictContext.conflictContext) && prepared.conflictContext.conflictContext.schema === "ade.conflictJobContext.v1"
        ? (prepared.conflictContext.conflictContext as ConflictJobContextV1)
        : null;
    const insufficientContext = Boolean(preparedConflictContext?.insufficientContext);
    const insufficientReasons = Array.isArray(preparedConflictContext?.insufficientReasons)
      ? preparedConflictContext!.insufficientReasons!.map((value) => String(value))
      : [];
    if (insufficientContext) {
      const createdAt = new Date().toISOString();
      const proposalId = randomUUID();
      const predictionId = getLatestPredictionId(laneId, peerLaneId);
      const explanation = [
        "Insufficient context to generate a safe conflict patch.",
        "",
        "Missing data:",
        ...insufficientReasons.map((reason) => `- ${reason}`)
      ].join("\n");

      db.run(
        `
          insert into conflict_proposals(
            id,
            project_id,
            lane_id,
            peer_lane_id,
            prediction_id,
            source,
            confidence,
            explanation,
            diff_patch,
            status,
            job_id,
            artifact_id,
            applied_operation_id,
            metadata_json,
            created_at,
            updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, null, ?, ?, ?)
        `,
        [
          proposalId,
          projectId,
          laneId,
          peerLaneId,
          predictionId,
          "local",
          null,
          explanation,
          "",
          null,
          null,
          JSON.stringify({
            provider: "local",
            contextDigest,
            preparedAt: prepared.preparedAt,
            insufficientContext: true,
            insufficientReasons
          }),
          createdAt,
          createdAt
        ]
      );

      logger.warn("conflicts.proposal_insufficient_context", {
        laneId,
        peerLaneId,
        reasons: insufficientReasons
      });

      const row = getProposalRow(proposalId);
      if (!row) throw new Error("Failed to persist insufficient-context proposal");
      return rowToProposal(row);
    }

    const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
    const aiMode = aiIntegrationService?.getMode() ?? "guest";
    const subscriptionReady = providerMode !== "guest" && aiMode === "subscription" && Boolean(aiIntegrationService);
    if (!subscriptionReady || !aiIntegrationService) {
      throw new Error("AI conflict resolution requires a subscription provider (Claude and/or Codex CLI).");
    }

    const provider: ConflictProposalProvider = "subscription";
    if (provider !== prepared.provider) {
      throw new Error("Provider mode changed since preview. Prepare a fresh preview before requesting AI.");
    }

    const laneGit = laneService.getLaneBaseAndBranch(laneId);
    const outputSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        explanation: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        diffPatch: { type: "string" }
      },
      required: ["explanation", "confidence", "diffPatch"]
    };
    const prompt = [
      "You are ADE's conflict resolution assistant.",
      "Produce a safe proposal using only provided context. Do not invent files or hunks.",
      "",
      "Return JSON with keys: explanation, confidence (0..1), diffPatch (unified diff).",
      "If context is insufficient for a safe patch, set diffPatch to an empty string and explain why.",
      "",
      "Conflict Context JSON:",
      JSON.stringify(prepared.conflictContext, null, 2)
    ].join("\n");

    const aiResult = await aiIntegrationService.requestConflictProposal({
      laneId,
      cwd: laneGit.worktreePath,
      prompt,
      jsonSchema: outputSchema
    });
    const structured =
      (isRecord(aiResult.structuredOutput) ? aiResult.structuredOutput : null) ??
      parseStructuredObject(aiResult.text) ??
      {};
    const diffPatchFromStructured = asString(structured.diffPatch).trim();
    const explanationFromStructured = asString(structured.explanation).trim();
    const result = {
      diffPatch: diffPatchFromStructured.length ? `${diffPatchFromStructured}\n` : extractDiffPatchFromText(aiResult.text),
      explanation: explanationFromStructured.length ? explanationFromStructured : stripDiffFence(aiResult.text),
      rawContent: aiResult.text,
      confidence: normalizeConfidence(structured.confidence),
      model: aiResult.model,
      provider: aiResult.provider,
      sessionId: aiResult.sessionId
    };

    const createdAt = new Date().toISOString();
    const proposalId = randomUUID();
    const predictionId = getLatestPredictionId(laneId, peerLaneId);
    const resolutionConfig = readConflictResolutionConfig();

    db.run(
      `
        insert into conflict_proposals(
          id,
          project_id,
          lane_id,
          peer_lane_id,
          prediction_id,
          source,
          confidence,
          explanation,
          diff_patch,
          status,
          job_id,
          artifact_id,
          applied_operation_id,
          metadata_json,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, null, ?, ?, ?)
      `,
      [
        proposalId,
        projectId,
        laneId,
        peerLaneId,
        predictionId,
        "local",
        result.confidence,
        result.explanation,
        result.diffPatch,
        null,
        null,
        JSON.stringify({
          provider,
          model: result.model,
          providerName: result.provider,
          sessionId: result.sessionId,
          rawContent: result.rawContent,
          contextDigest,
          preparedAt: prepared.preparedAt,
          resolutionConfig
        }),
        createdAt,
        createdAt
      ]
    );

    const row = getProposalRow(proposalId);
    if (!row) throw new Error("Failed to persist conflict proposal");

    if (
      resolutionConfig.autonomy === "auto_apply" &&
      typeof result.confidence === "number" &&
      result.confidence >= resolutionConfig.autoApplyThreshold &&
      result.diffPatch.trim().length > 0
    ) {
      try {
        const applyMode = mapPostResolutionToApplyMode(resolutionConfig.postResolution) ?? "staged";
        const generatedCommitMessage =
          applyMode === "commit"
            ? `Resolve conflicts in ${lane.name} (${new Date().toISOString().slice(0, 10)})`
            : undefined;
        return await applyProposal({
          laneId,
          proposalId,
          applyMode,
          ...(generatedCommitMessage ? { commitMessage: generatedCommitMessage } : {})
        });
      } catch (error) {
        logger.warn("conflicts.proposal_auto_apply_failed", {
          laneId,
          peerLaneId,
          proposalId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return rowToProposal(row);
  };

  const ensureIntegrationLane = async (args: {
    targetLaneId: string;
    integrationLaneName?: string;
  }): Promise<LaneSummary> => {
    const name = (args.integrationLaneName ?? "Integration lane").trim() || "Integration lane";
    const lanes = await laneService.list({ includeArchived: false });
    const existing = lanes.find((lane) => !lane.archivedAt && lane.name === name);
    if (existing) return existing;
    return await laneService.create({
      name,
      description: `Auto-created integration lane for conflict resolution into ${args.targetLaneId}.`,
      parentLaneId: args.targetLaneId
    });
  };

  type PromptBuilderArgs = {
    targetLaneId: string;
    sourceLaneIds: string[];
    contexts: Array<{
      laneId: string;
      peerLaneId: string | null;
      preview: ConflictProposalPreview;
      conflictContext: Record<string, unknown> | null;
    }>;
    packRefs: ExternalResolverPackRef[];
    cwdLaneId: string;
    integrationLaneId: string | null;
    scenario?: ResolverSessionScenario;
  };

  const buildPackRefsBlock = (packRefs: ExternalResolverPackRef[]): string[] => {
    const lines: string[] = [];
    lines.push("## ADE Pack References");
    for (const ref of packRefs) {
      const tags: string[] = [ref.required ? "required" : "optional", ref.exists ? "present" : "missing"];
      const laneInfo = ref.laneId ? ` lane=${ref.laneId}` : "";
      const peerInfo = ref.peerLaneId ? ` peer=${ref.peerLaneId}` : "";
      lines.push(`- ${ref.kind}${laneInfo}${peerInfo} [${tags.join(", ")}]`);
      lines.push(`  - path: ${ref.absPath}`);
      lines.push(`  - repo: ${ref.repoRelativePath}`);
    }
    lines.push("");
    return lines;
  };

  const buildGuardrailsBlock = (): string[] => {
    const lines: string[] = [];
    lines.push("## Guardrails (Non-Negotiable)");
    lines.push("- Do not modify non-relevant files.");
    lines.push("- Do not run: git add, git commit, git push, git rebase, git merge, git cherry-pick, git reset.");
    lines.push("- Keep conflict-resolution work sequential; do not spawn parallel editing agents.");
    lines.push("- Respect staleness markers and insufficient-context signals.");
    lines.push("- If context is insufficient, do not fabricate changes.");
    lines.push("- If blocked, print `INSUFFICIENT_CONTEXT` followed by a concrete gap list.");
    lines.push("");
    return lines;
  };

  const buildPairContextBlock = (contexts: PromptBuilderArgs["contexts"]): string[] => {
    const lines: string[] = [];
    lines.push("## Pair Context (Structured)");
    for (const ctx of contexts) {
      lines.push(`### Pair ${ctx.laneId} -> ${ctx.peerLaneId ?? "base"}`);
      lines.push(`- Prepared at: ${ctx.preview.preparedAt}`);
      lines.push(`- Context digest: ${ctx.preview.contextDigest}`);
      lines.push(`- Existing proposal: ${ctx.preview.existingProposalId ?? "none"}`);
      lines.push(`- Preview warnings: ${ctx.preview.warnings.join(" | ") || "none"}`);
      lines.push(`- Relevant files count: ${ctx.preview.files.length}`);
      lines.push("```json");
      lines.push(
        JSON.stringify(
          {
            laneId: ctx.laneId,
            peerLaneId: ctx.peerLaneId,
            stats: ctx.preview.stats,
            files: ctx.preview.files.map((file) => ({
              path: file.path,
              includeReason: file.includeReason
            })),
            conflictContext: ctx.conflictContext ?? null
          },
          null,
          2
        )
      );
      lines.push("```");
      lines.push("");
    }
    return lines;
  };

  const buildOutputContractBlock = (): string[] => {
    const lines: string[] = [];
    lines.push("## Output Contract");
    lines.push("Done. Here's what changed:");
    lines.push("- file: <repo-path>");
    lines.push("- rationale: <one sentence>");
    lines.push("- unresolved: <none|short note>");
    lines.push("");
    lines.push("If blocked:");
    lines.push("INSUFFICIENT_CONTEXT");
    lines.push("- gap: <missing artifact, file, or decision>");
    lines.push("- requested_action: <what user should provide>");
    lines.push("");
    return lines;
  };

  const buildSingleMergePrompt = (args: PromptBuilderArgs): string => {
    const lines: string[] = [];
    lines.push("# ADE External Conflict Resolver");
    lines.push("");
    lines.push("## Objective");
    lines.push("- Resolve merge conflicts using ADE context packs first, then code/docs as needed.");
    lines.push("- Apply edits in the execution lane worktree only.");
    lines.push("- Do not commit, push, or stage changes.");
    lines.push("");
    lines.push("## Run Metadata");
    lines.push(`- Scenario: single-merge`);
    lines.push(`- Target lane: ${args.targetLaneId}`);
    lines.push(`- Source lanes: ${args.sourceLaneIds.join(", ")}`);
    lines.push(`- Execution lane (cwd): ${args.cwdLaneId}`);
    lines.push(`- Integration lane: ${args.integrationLaneId ?? "(not used)"}`);
    lines.push("");
    lines.push("## Required Read Order");
    lines.push("1) Read all required ADE pack files listed below.");
    lines.push("2) Read optional ADE docs if present.");
    lines.push("3) Read additional repository files only when needed to resolve conflicts safely.");
    lines.push("");
    lines.push(...buildPackRefsBlock(args.packRefs));
    lines.push(...buildGuardrailsBlock());
    lines.push("## Strategy");
    lines.push("- Merge the single source lane into the target lane.");
    lines.push("- Resolve each conflicting file using pack context to determine correct resolution.");
    lines.push("- Verify that no unrelated files are modified.");
    lines.push("");
    lines.push(...buildPairContextBlock(args.contexts));
    lines.push(...buildOutputContractBlock());
    return `${lines.join("\n").trim()}\n`;
  };

  const buildSequentialMergePrompt = (args: PromptBuilderArgs): string => {
    const lines: string[] = [];
    lines.push("# ADE External Conflict Resolver");
    lines.push("");
    lines.push("## Objective");
    lines.push("- Resolve merge conflicts across multiple source lanes sequentially.");
    lines.push("- Apply edits in the execution lane worktree only.");
    lines.push("- Do not commit, push, or stage changes.");
    lines.push("");
    lines.push("## Run Metadata");
    lines.push(`- Scenario: sequential-merge`);
    lines.push(`- Target lane: ${args.targetLaneId}`);
    lines.push(`- Source lanes: ${args.sourceLaneIds.join(", ")}`);
    lines.push(`- Execution lane (cwd): ${args.cwdLaneId}`);
    lines.push(`- Integration lane: ${args.integrationLaneId ?? "(not used)"}`);
    lines.push("");
    lines.push("## Required Read Order");
    lines.push("1) Read all required ADE pack files listed below.");
    lines.push("2) Read optional ADE docs if present.");
    lines.push("3) Read additional repository files only when needed to resolve conflicts safely.");
    lines.push("");
    lines.push(...buildPackRefsBlock(args.packRefs));
    lines.push(...buildGuardrailsBlock());
    lines.push("## Strategy");
    lines.push("- Process source lanes in order: " + args.sourceLaneIds.join(" -> ") + ".");
    lines.push("- For each source lane, resolve conflicts against the current worktree state.");
    lines.push("- After resolving each source, verify the worktree is clean before proceeding to the next.");
    lines.push("- Accumulate changes; do not revert between sources.");
    lines.push("");
    lines.push(...buildPairContextBlock(args.contexts));
    lines.push(...buildOutputContractBlock());
    return `${lines.join("\n").trim()}\n`;
  };

  const buildIntegrationMergePrompt = (args: PromptBuilderArgs): string => {
    const lines: string[] = [];
    lines.push("# ADE External Conflict Resolver");
    lines.push("");
    lines.push("## Objective");
    lines.push("- Resolve merge conflicts by integrating multiple source lanes into a dedicated integration lane.");
    lines.push("- Apply edits in the integration lane worktree only.");
    lines.push("- Do not commit, push, or stage changes.");
    lines.push("");
    lines.push("## Run Metadata");
    lines.push(`- Scenario: integration-merge`);
    lines.push(`- Target lane: ${args.targetLaneId}`);
    lines.push(`- Source lanes: ${args.sourceLaneIds.join(", ")}`);
    lines.push(`- Execution lane (cwd): ${args.cwdLaneId}`);
    lines.push(`- Integration lane: ${args.integrationLaneId ?? "(not used)"}`);
    lines.push("");
    lines.push("## Required Read Order");
    lines.push("1) Read all required ADE pack files listed below.");
    lines.push("2) Read optional ADE docs if present.");
    lines.push("3) Read additional repository files only when needed to resolve conflicts safely.");
    lines.push("");
    lines.push(...buildPackRefsBlock(args.packRefs));
    lines.push(...buildGuardrailsBlock());
    lines.push("## Strategy");
    lines.push("- The integration lane aggregates changes from all source lanes.");
    lines.push("- Resolve all conflicts holistically, considering interactions between source lanes.");
    lines.push("- Ensure the integration lane cleanly merges all source contributions.");
    lines.push("- Pay special attention to files modified by multiple source lanes.");
    lines.push("");
    lines.push(...buildPairContextBlock(args.contexts));
    lines.push(...buildOutputContractBlock());
    return `${lines.join("\n").trim()}\n`;
  };

  const buildExternalResolverPrompt = (args: PromptBuilderArgs): string => {
    const scenario: ResolverSessionScenario = args.scenario
      ?? (args.sourceLaneIds.length === 1
        ? "single-merge"
        : args.integrationLaneId
          ? "integration-merge"
          : "sequential-merge");

    switch (scenario) {
      case "single-merge":
        return buildSingleMergePrompt(args);
      case "sequential-merge":
        return buildSequentialMergePrompt(args);
      case "integration-merge":
        return buildIntegrationMergePrompt(args);
      default:
        return buildSingleMergePrompt(args);
    }
  };

  const runExternalResolver = async (args: RunExternalConflictResolverArgs): Promise<ConflictExternalResolverRunSummary> => {
    const targetLaneId = args.targetLaneId.trim();
    const sourceLaneIds = uniqueSorted((args.sourceLaneIds ?? []).map((value) => value.trim()).filter(Boolean));
    if (!targetLaneId) throw new Error("targetLaneId is required");
    if (!sourceLaneIds.length) throw new Error("sourceLaneIds is required");

    const lanes = await listActiveLanes();
    const laneByIdMap = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const targetLane = laneByIdMap.get(targetLaneId);
    if (!targetLane) throw new Error(`Target lane not found: ${targetLaneId}`);

    const integrationLane = sourceLaneIds.length > 1
      ? await ensureIntegrationLane({ targetLaneId, integrationLaneName: args.integrationLaneName })
      : null;
    const cwdLaneId = sourceLaneIds.length === 1 ? sourceLaneIds[0]! : integrationLane!.id;
    const cwdLane = laneByIdMap.get(cwdLaneId) ?? (integrationLane && integrationLane.id === cwdLaneId ? integrationLane : null);
    if (!cwdLane) throw new Error(`Execution lane not found: ${cwdLaneId}`);

    const contexts: Array<{
      laneId: string;
      peerLaneId: string | null;
      preview: ConflictProposalPreview;
      conflictContext: Record<string, unknown> | null;
    }> = [];
    const contextGaps: ConflictExternalResolverContextGap[] = [];
    for (const sourceLaneId of sourceLaneIds) {
      const preview = await prepareProposal({ laneId: sourceLaneId, peerLaneId: targetLaneId });
      const prepared = preparedContexts.get(preview.contextDigest);
      const conflictContext = prepared?.conflictContext ?? null;
      const cc =
        isRecord(conflictContext) && isRecord(conflictContext.conflictContext)
          ? conflictContext.conflictContext
          : conflictContext;
      const insufficient = isRecord(cc) && Boolean(cc.insufficientContext);
      if (insufficient) {
        const reasons = Array.isArray(cc.insufficientReasons) ? cc.insufficientReasons.map((value) => String(value)) : [];
        if (!reasons.length) {
          contextGaps.push({
            code: "insufficient_context",
            message: `${sourceLaneId} -> ${targetLaneId}: insufficient_context_flagged`
          });
        } else {
          for (const reason of reasons) {
            contextGaps.push({
              code: "insufficient_context",
              message: `${sourceLaneId} -> ${targetLaneId}: ${reason}`
            });
          }
        }
      }
      contexts.push({
        laneId: sourceLaneId,
        peerLaneId: targetLaneId,
        preview,
        conflictContext: prepared?.conflictContext ?? null
      });
    }
    const packRefs = buildExternalResolverPackRefs({
      targetLaneId,
      sourceLaneIds,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      contexts: contexts.map((entry) => ({ laneId: entry.laneId, peerLaneId: entry.peerLaneId }))
    });
    const missingRequiredPacks = packRefs
      .filter((entry) => entry.required && !entry.exists)
      .map((entry) => entry.repoRelativePath);

    const runId = randomUUID();
    const runDir = path.join(externalRunsRootDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const startedAt = new Date().toISOString();

    if (contextGaps.length > 0) {
      const blocked: ExternalResolverRunRecord = {
        schema: "ade.conflictExternalRun.v1",
        runId,
        provider: args.provider,
        status: "blocked",
        startedAt,
        completedAt: new Date().toISOString(),
        targetLaneId,
        sourceLaneIds,
        cwdLaneId,
        integrationLaneId: integrationLane?.id ?? null,
        command: [],
        summary: "Insufficient context blocked external resolver execution.",
        patchPath: null,
        logPath: null,
        insufficientContext: true,
        contextGaps,
        warnings: [
          "insufficient_context_blocked",
          ...missingRequiredPacks.map((relPath) => `missing_pack:${relPath}`)
        ],
        committedAt: null,
        commitSha: null,
        commitMessage: null,
        error: null
      };
      writeExternalRunRecord(blocked);
      return toRunSummary(blocked);
    }

    const prompt = buildExternalResolverPrompt({
      targetLaneId,
      sourceLaneIds,
      contexts,
      packRefs,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null
    });
    const promptPath = path.join(runDir, "prompt.md");
    fs.writeFileSync(promptPath, prompt, "utf8");

    const commandTemplate = resolveExternalResolverCommand(args.provider);
    if (!commandTemplate.length) {
      const missing: ExternalResolverRunRecord = {
        schema: "ade.conflictExternalRun.v1",
        runId,
        provider: args.provider,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        targetLaneId,
        sourceLaneIds,
        cwdLaneId,
        integrationLaneId: integrationLane?.id ?? null,
        command: [],
        summary: null,
        patchPath: null,
        logPath: null,
        insufficientContext: false,
        contextGaps: [],
        warnings: [
          "resolver_command_missing_in_config",
          ...missingRequiredPacks.map((relPath) => `missing_pack:${relPath}`)
        ],
        committedAt: null,
        commitSha: null,
        commitMessage: null,
        error: "No external resolver command configured for provider."
      };
      writeExternalRunRecord(missing);
      return toRunSummary(missing);
    }

    const renderedCommand = commandTemplate.map((token) =>
      token
        .replace(/\{\{promptFile\}\}/g, promptPath)
        .replace(/\{\{projectRoot\}\}/g, projectRoot)
        .replace(/\{\{targetLaneId\}\}/g, targetLaneId)
        .replace(/\{\{sourceLaneIds\}\}/g, sourceLaneIds.join(","))
        .replace(/\{\{runDir\}\}/g, runDir)
    );

    const bin = renderedCommand[0];
    if (!bin) {
      throw new Error("Invalid external resolver command template");
    }

    const proc = spawnSync(bin, renderedCommand.slice(1), {
      cwd: cwdLane.worktreePath,
      encoding: "utf8",
      timeout: 8 * 60_000,
      maxBuffer: 8 * 1024 * 1024
    });

    const stdout = proc.stdout ?? "";
    const stderr = proc.stderr ?? "";
    const outputLogPath = path.join(runDir, "output.log");
    fs.writeFileSync(outputLogPath, `${stdout}\n\n--- STDERR ---\n${stderr}\n`, "utf8");

    const diffResult = await runGit(["diff", "--binary"], {
      cwd: cwdLane.worktreePath,
      timeoutMs: 45_000,
      maxOutputBytes: EXTERNAL_DIFF_MAX_OUTPUT_BYTES
    });
    const patchPath = path.join(runDir, "changes.patch");
    let finalPatchPath: string | null = null;
    if (diffResult.exitCode === 0 && diffResult.stdout.trim().length > 0) {
      fs.writeFileSync(patchPath, diffResult.stdout, "utf8");
      finalPatchPath = patchPath;
    }

    const status: ConflictExternalResolverRunStatus = proc.status === 0 ? "completed" : "failed";
    const runRecord: ExternalResolverRunRecord = {
      schema: "ade.conflictExternalRun.v1",
      runId,
      provider: args.provider,
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      targetLaneId,
      sourceLaneIds,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      command: renderedCommand,
      summary: extractResolverSummary(stdout),
      patchPath: finalPatchPath,
      logPath: outputLogPath,
      insufficientContext: false,
      contextGaps: [],
      warnings: [
        ...(proc.signal ? [`process_signal:${proc.signal}`] : []),
        ...(diffResult.stdoutTruncated ? ["git_diff_stdout_truncated"] : []),
        ...(diffResult.stderrTruncated ? ["git_diff_stderr_truncated"] : []),
        ...missingRequiredPacks.map((relPath) => `missing_pack:${relPath}`)
      ],
      committedAt: null,
      commitSha: null,
      commitMessage: null,
      error: proc.status === 0 ? null : (stderr.trim() || `Exit code ${proc.status ?? -1}`)
    };
    writeExternalRunRecord(runRecord);
    return toRunSummary(runRecord);
  };

  const listExternalResolverRuns = (args: ListExternalConflictResolverRunsArgs = {}): ConflictExternalResolverRunSummary[] => {
    const laneId = typeof args.laneId === "string" ? args.laneId.trim() : "";
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Number(args.limit)) : 20;
    const records = listExternalRunRecords().filter((run) =>
      laneId
        ? run.targetLaneId === laneId || run.cwdLaneId === laneId || run.sourceLaneIds.includes(laneId)
        : true
    );
    return records.slice(0, limit).map(toRunSummary);
  };

  const commitExternalResolverRun = async (
    args: CommitExternalConflictResolverRunArgs
  ): Promise<CommitExternalConflictResolverRunResult> => {
    const runId = args.runId.trim();
    if (!runId) throw new Error("runId is required");
    const run = readExternalRunRecord(runId);
    if (!run) throw new Error(`External resolver run not found: ${runId}`);
    if (run.status !== "completed") throw new Error("Only completed resolver runs can be committed.");
    if (!run.patchPath || !fs.existsSync(run.patchPath)) {
      throw new Error("Resolver run has no patch artifact to commit.");
    }
    if (run.commitSha && run.committedAt) {
      throw new Error(`Resolver run already committed at ${run.committedAt}.`);
    }

    const laneId = run.cwdLaneId;
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const patchBody = fs.readFileSync(run.patchPath, "utf8");
    const touchedPaths = extractCommitPathsFromUnifiedDiff(patchBody);
    if (!touchedPaths.length) throw new Error("Resolver patch has no changed paths.");
    const normalizedPaths = touchedPaths.map((entry) => ensureRelativeRepoPath(entry));
    const commitMessage = args.message?.trim() || `Resolve conflicts via ADE ${run.provider} external resolver`;

    await runGitOrThrow(["add", "--", ...normalizedPaths], { cwd: lane.worktreePath, timeoutMs: 60_000 });
    const commitRes = await runGit(
      ["commit", "-m", commitMessage, "--", ...normalizedPaths],
      { cwd: lane.worktreePath, timeoutMs: 90_000 }
    );
    if (commitRes.exitCode !== 0) {
      const reason = commitRes.stderr.trim() || commitRes.stdout.trim() || "Failed to create commit.";
      throw new Error(reason);
    }

    const commitSha = await readHeadSha(lane.worktreePath);
    const committedAt = new Date().toISOString();
    writeExternalRunRecord({
      ...run,
      committedAt,
      commitSha,
      commitMessage
    });

    return {
      runId,
      laneId,
      commitSha,
      message: commitMessage,
      committedPaths: normalizedPaths
    };
  };

  const applyProposal = async (args: ApplyConflictProposalArgs): Promise<ConflictProposal> => {
    const row = getProposalRow(args.proposalId);
    if (!row || row.lane_id !== args.laneId) {
      throw new Error(`Proposal not found: ${args.proposalId}`);
    }
    if (!row.diff_patch.trim()) {
      throw new Error("Proposal does not include a diff patch");
    }

    const resolutionConfig = readConflictResolutionConfig();
    const applyMode = args.applyMode ?? mapPostResolutionToApplyMode(resolutionConfig.postResolution) ?? "staged";
    const commitMessage =
      args.commitMessage?.trim() ??
      (applyMode === "commit"
        ? `Resolve conflicts via ADE (${new Date().toISOString().slice(0, 10)})`
        : "");
    if (applyMode === "commit" && !commitMessage) {
      throw new Error("commitMessage is required when applyMode='commit'");
    }

    const lane = laneService.getLaneBaseAndBranch(args.laneId);
    const preHeadSha = await readHeadSha(lane.worktreePath);
    const operation = operationService?.start({
      laneId: args.laneId,
      kind: "conflict_proposal_apply",
      preHeadSha,
      metadata: {
        proposalId: args.proposalId,
        applyMode
      }
    });

    const patchFile = writePatchFile(row.diff_patch);
    try {
      const applyResult = await runGit(
        ["apply", "--3way", "--whitespace=nowarn", patchFile],
        { cwd: lane.worktreePath, timeoutMs: 60_000 }
      );
      if (applyResult.exitCode !== 0) {
        throw new Error(applyResult.stderr.trim() || "Failed to apply conflict proposal patch");
      }

      const touchedFiles = extractPathsFromUnifiedDiff(row.diff_patch);
      if (applyMode === "staged" || applyMode === "commit") {
        if (touchedFiles.length) {
          await runGitOrThrow(["add", "--", ...touchedFiles], { cwd: lane.worktreePath, timeoutMs: 60_000 });
        } else {
          // Fall back to staging all changes; diff parsing missed something.
          await runGitOrThrow(["add", "-A"], { cwd: lane.worktreePath, timeoutMs: 60_000 });
        }
      }

      let appliedCommitSha: string | null = null;
      if (applyMode === "commit") {
        await runGitOrThrow(["commit", "-m", commitMessage], { cwd: lane.worktreePath, timeoutMs: 60_000 });
        appliedCommitSha = await readHeadSha(lane.worktreePath);
      }

      const postHeadSha = await readHeadSha(lane.worktreePath);
      if (operationService && operation) {
        operationService.finish({
          operationId: operation.operationId,
          status: "succeeded",
          postHeadSha,
          metadataPatch: {
            proposalId: args.proposalId,
            ...(appliedCommitSha ? { appliedCommitSha } : {})
          }
        });
      }

      const now = new Date().toISOString();
      const nextMetadata = {
        ...safeParseMetadata(row.metadata_json),
        applyMode,
        ...(commitMessage ? { commitMessage } : {}),
        ...(appliedCommitSha ? { appliedCommitSha } : {})
      };
      db.run(
        `
          update conflict_proposals
          set status = 'applied',
              applied_operation_id = ?,
              metadata_json = ?,
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [operation?.operationId ?? null, JSON.stringify(nextMetadata), now, args.proposalId, projectId]
      );
    } catch (error) {
      const postHeadSha = await readHeadSha(lane.worktreePath);
      if (operationService && operation) {
        operationService.finish({
          operationId: operation.operationId,
          status: "failed",
          postHeadSha,
          metadataPatch: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
      throw error;
    } finally {
      deletePatchFile(patchFile);
    }

    const updated = getProposalRow(args.proposalId);
    if (!updated) {
      throw new Error(`Proposal not found after apply: ${args.proposalId}`);
    }
    return rowToProposal(updated);
  };

  const undoProposal = async (args: UndoConflictProposalArgs): Promise<ConflictProposal> => {
    const row = getProposalRow(args.proposalId);
    if (!row || row.lane_id !== args.laneId) {
      throw new Error(`Proposal not found: ${args.proposalId}`);
    }
    if (row.status !== "applied") {
      throw new Error("Only applied proposals can be undone");
    }

    const lane = laneService.getLaneBaseAndBranch(args.laneId);
    const preHeadSha = await readHeadSha(lane.worktreePath);
    const operation = operationService?.start({
      laneId: args.laneId,
      kind: "conflict_proposal_undo",
      preHeadSha,
      metadata: {
        proposalId: args.proposalId
      }
    });

    try {
      const metadata = safeParseMetadata(row.metadata_json);
      const applyMode = typeof metadata.applyMode === "string" ? metadata.applyMode : "unstaged";
      const appliedCommitSha = typeof metadata.appliedCommitSha === "string" ? metadata.appliedCommitSha : "";

      if (applyMode === "commit" && appliedCommitSha.trim()) {
        await runGitOrThrow(["revert", "--no-edit", appliedCommitSha.trim()], { cwd: lane.worktreePath, timeoutMs: 90_000 });
      } else {
        const patchFile = writePatchFile(row.diff_patch);
        try {
          const undoResult = await runGit(
            ["apply", "-R", "--3way", "--whitespace=nowarn", patchFile],
            { cwd: lane.worktreePath, timeoutMs: 60_000 }
          );
          if (undoResult.exitCode !== 0) {
            throw new Error(undoResult.stderr.trim() || "Failed to undo applied proposal patch");
          }
        } finally {
          deletePatchFile(patchFile);
        }
      }

      const postHeadSha = await readHeadSha(lane.worktreePath);
      if (operationService && operation) {
        operationService.finish({
          operationId: operation.operationId,
          status: "succeeded",
          postHeadSha,
          metadataPatch: {
            proposalId: args.proposalId
          }
        });
      }

      const now = new Date().toISOString();
      db.run(
        `
          update conflict_proposals
          set status = 'pending',
              applied_operation_id = null,
              metadata_json = ?,
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [JSON.stringify({ ...safeParseMetadata(row.metadata_json), applyMode: "unstaged", appliedCommitSha: null }), now, args.proposalId, projectId]
      );
    } catch (error) {
      const postHeadSha = await readHeadSha(lane.worktreePath);
      if (operationService && operation) {
        operationService.finish({
          operationId: operation.operationId,
          status: "failed",
          postHeadSha,
          metadataPatch: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
      throw error;
    } finally {
    }

    const updated = getProposalRow(args.proposalId);
    if (!updated) {
      throw new Error(`Proposal not found after undo: ${args.proposalId}`);
    }
    return rowToProposal(updated);
  };

  const prepareResolverSession = async (args: PrepareResolverSessionArgs): Promise<PrepareResolverSessionResult> => {
    const targetLaneId = args.targetLaneId.trim();
    const sourceLaneIds = uniqueSorted((args.sourceLaneIds ?? []).map((value) => value.trim()).filter(Boolean));
    if (!targetLaneId) throw new Error("targetLaneId is required");
    if (!sourceLaneIds.length) throw new Error("sourceLaneIds is required");

    const lanes = await listActiveLanes();
    const laneByIdMap = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const targetLane = laneByIdMap.get(targetLaneId);
    if (!targetLane) throw new Error(`Target lane not found: ${targetLaneId}`);

    const scenario: ResolverSessionScenario = args.scenario
      ?? (sourceLaneIds.length === 1
        ? "single-merge"
        : args.integrationLaneName
          ? "integration-merge"
          : "sequential-merge");

    const integrationLane = scenario === "integration-merge"
      ? await ensureIntegrationLane({ targetLaneId, integrationLaneName: args.integrationLaneName })
      : null;
    const cwdLaneId = sourceLaneIds.length === 1 ? sourceLaneIds[0]! : (integrationLane?.id ?? sourceLaneIds[0]!);
    const cwdLane = laneByIdMap.get(cwdLaneId) ?? (integrationLane && integrationLane.id === cwdLaneId ? integrationLane : null);
    if (!cwdLane) throw new Error(`Execution lane not found: ${cwdLaneId}`);

    const contexts: Array<{
      laneId: string;
      peerLaneId: string | null;
      preview: ConflictProposalPreview;
      conflictContext: Record<string, unknown> | null;
    }> = [];
    const contextGaps: ConflictExternalResolverContextGap[] = [];
    for (const sourceLaneId of sourceLaneIds) {
      const preview = await prepareProposal({ laneId: sourceLaneId, peerLaneId: targetLaneId });
      const prepared = preparedContexts.get(preview.contextDigest);
      const conflictContext = prepared?.conflictContext ?? null;
      const cc =
        isRecord(conflictContext) && isRecord(conflictContext.conflictContext)
          ? conflictContext.conflictContext
          : conflictContext;
      const insufficient = isRecord(cc) && Boolean(cc.insufficientContext);
      if (insufficient) {
        const reasons = Array.isArray(cc.insufficientReasons) ? cc.insufficientReasons.map((value) => String(value)) : [];
        if (!reasons.length) {
          contextGaps.push({
            code: "insufficient_context",
            message: `${sourceLaneId} -> ${targetLaneId}: insufficient_context_flagged`
          });
        } else {
          for (const reason of reasons) {
            contextGaps.push({
              code: "insufficient_context",
              message: `${sourceLaneId} -> ${targetLaneId}: ${reason}`
            });
          }
        }
      }
      contexts.push({
        laneId: sourceLaneId,
        peerLaneId: targetLaneId,
        preview,
        conflictContext: prepared?.conflictContext ?? null
      });
    }

    const packRefs = buildExternalResolverPackRefs({
      targetLaneId,
      sourceLaneIds,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      contexts: contexts.map((entry) => ({ laneId: entry.laneId, peerLaneId: entry.peerLaneId }))
    });
    const missingRequiredPacks = packRefs
      .filter((entry) => entry.required && !entry.exists)
      .map((entry) => entry.repoRelativePath);

    const warnings: string[] = [
      ...missingRequiredPacks.map((relPath) => `missing_pack:${relPath}`)
    ];
    const status: PrepareResolverSessionResult["status"] = contextGaps.length > 0 ? "blocked" : "ready";

    const runId = randomUUID();
    const runDir = path.join(externalRunsRootDir, runId);
    fs.mkdirSync(runDir, { recursive: true });

    const prompt = buildExternalResolverPrompt({
      targetLaneId,
      sourceLaneIds,
      contexts,
      packRefs,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      scenario
    });
    const promptPath = path.join(runDir, "prompt.md");
    fs.writeFileSync(promptPath, prompt, "utf8");

    const startedAt = new Date().toISOString();
    const runRecord: ExternalResolverRunRecord = {
      schema: "ade.conflictExternalRun.v1",
      runId,
      provider: args.provider,
      status: status === "blocked" ? "blocked" : "running",
      startedAt,
      completedAt: status === "blocked" ? startedAt : null,
      targetLaneId,
      sourceLaneIds,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      command: [],
      summary: status === "blocked" ? "Insufficient context blocked external resolver execution." : null,
      patchPath: null,
      logPath: null,
      insufficientContext: contextGaps.length > 0,
      contextGaps,
      warnings,
      committedAt: null,
      commitSha: null,
      commitMessage: null,
      error: null
    };
    writeExternalRunRecord(runRecord);

    return {
      runId,
      promptFilePath: promptPath,
      cwdWorktreePath: cwdLane.worktreePath,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      warnings,
      contextGaps,
      status
    };
  };

  const finalizeResolverSession = async (args: FinalizeResolverSessionArgs): Promise<ConflictExternalResolverRunSummary> => {
    const runId = args.runId.trim();
    if (!runId) throw new Error("runId is required");
    const run = readExternalRunRecord(runId);
    if (!run) throw new Error(`External resolver run not found: ${runId}`);

    const cwdLane = laneService.getLaneBaseAndBranch(run.cwdLaneId);
    const diffResult = await runGit(["diff", "--binary"], {
      cwd: cwdLane.worktreePath,
      timeoutMs: 45_000,
      maxOutputBytes: EXTERNAL_DIFF_MAX_OUTPUT_BYTES
    });

    const runDir = path.join(externalRunsRootDir, runId);
    const patchPath = path.join(runDir, "changes.patch");
    let finalPatchPath: string | null = null;
    if (diffResult.exitCode === 0 && diffResult.stdout.trim().length > 0) {
      fs.writeFileSync(patchPath, diffResult.stdout, "utf8");
      finalPatchPath = patchPath;
    }

    const completedAt = new Date().toISOString();
    const status: ConflictExternalResolverRunStatus = args.exitCode === 0 ? "completed" : "failed";
    const updatedRecord: ExternalResolverRunRecord = {
      ...run,
      status,
      completedAt,
      patchPath: finalPatchPath,
      warnings: [
        ...(run.warnings ?? []),
        ...(diffResult.stdoutTruncated ? ["git_diff_stdout_truncated"] : []),
        ...(diffResult.stderrTruncated ? ["git_diff_stderr_truncated"] : [])
      ],
      error: args.exitCode === 0 ? null : `Exit code ${args.exitCode}`
    };
    writeExternalRunRecord(updatedRecord);

    return toRunSummary(updatedRecord);
  };

  const suggestResolverTarget = async (args: SuggestResolverTargetArgs): Promise<SuggestResolverTargetResult> => {
    const sourceLaneId = args.sourceLaneId.trim();
    const targetLaneId = args.targetLaneId.trim();
    if (!sourceLaneId || !targetLaneId) throw new Error("sourceLaneId and targetLaneId are required");

    const sourcePack = packService?.getLanePack(sourceLaneId);
    const targetPack = packService?.getLanePack(targetLaneId);

    const overlaps = await listOverlaps({ laneId: sourceLaneId });
    const targetOverlap = overlaps.find((entry) => entry.peerId === targetLaneId);
    const overlapCount = targetOverlap?.files.length ?? 0;

    // Heuristic based on overlap count and pack availability.
    if (overlapCount > 5) {
      return {
        suggestion: "target",
        reason: `High overlap count (${overlapCount}) suggests resolving in target to minimize coordination.`
      };
    }
    return {
      suggestion: "source",
      reason: `Low overlap count (${overlapCount}) suggests resolving in source for simpler integration.`
    };
  };

  return {
    getLaneStatus,
    listOverlaps,
    getRiskMatrix,
    simulateMerge,
    runPrediction,
    getBatchAssessment,
    listProposals,
    prepareProposal,
    requestProposal,
    runExternalResolver,
    listExternalResolverRuns,
    commitExternalResolverRun,
    applyProposal,
    undoProposal,
    prepareResolverSession,
    finalizeResolverSession,
    suggestResolverTarget
  };
}
