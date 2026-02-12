import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  ApplyConflictProposalArgs,
  BatchOverlapEntry,
  BatchAssessmentResult,
  ConflictChip,
  ConflictEventPayload,
  ConflictFileType,
  ConflictOverlap,
  ConflictProposal,
  ConflictProposalStatus,
  ConflictPrediction,
  ConflictRiskLevel,
  ConflictStatus,
  ConflictStatusValue,
  GetLaneConflictStatusArgs,
  LaneSummary,
  ListOverlapsArgs,
  MergeSimulationArgs,
  MergeSimulationResult,
  RequestConflictProposalArgs,
  RiskMatrixEntry,
  RunConflictPredictionArgs,
  UndoConflictProposalArgs
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createOperationService } from "../history/operationService";
import type { createHostedAgentService } from "../hosted/hostedAgentService";
import { runGit, runGitMergeTree, runGitOrThrow } from "../git/git";

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
  source: "hosted" | "local";
  confidence: number | null;
  explanation: string | null;
  diff_patch: string;
  status: ConflictProposalStatus;
  job_id: string | null;
  artifact_id: string | null;
  applied_operation_id: string | null;
  created_at: string;
  updated_at: string;
};

const RISK_SCORE: Record<ConflictRiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3
};

const MAX_AUTO_LANES = 15;
const STALE_MS = 5 * 60_000;

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

function writePatchFile(content: string): string {
  const filePath = path.join(os.tmpdir(), `ade-proposal-${randomUUID()}.patch`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
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
  operationService,
  hostedAgentService,
  conflictPacksDir,
  onEvent
}: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  projectRoot: string;
  laneService: ReturnType<typeof createLaneService>;
  operationService?: ReturnType<typeof createOperationService>;
  hostedAgentService?: ReturnType<typeof createHostedAgentService>;
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
      totalLanes: options.totalLanes
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
    fs.mkdirSync(conflictPacksDir, { recursive: true });

    for (const status of assessment.lanes) {
      try {
        const overlaps = await listOverlaps({ laneId: status.laneId });
        const laneMatrix = assessment.matrix.filter(
          (entry) => entry.laneAId === status.laneId || entry.laneBId === status.laneId
        );
        const payload = {
          laneId: status.laneId,
          status,
          overlaps,
          matrix: laneMatrix,
          generatedAt: assessment.computedAt
        };
        const outPath = path.join(conflictPacksDir, `${status.laneId}.json`);
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

      let autoLimited = false;
      let comparisonLanes: LaneSummary[] = [];
      let basePredictionLanes: LaneSummary[] = [];
      let totalPairs = 0;

      if (targetLane) {
        comparisonLanes = lanes;
        basePredictionLanes = [targetLane];
        totalPairs = Math.max(0, lanes.length - 1);
      } else if (requestedLaneIds.length > 0) {
        const requestedSet = new Set(requestedLaneIds);
        const selected = lanes.filter((lane) => requestedSet.has(lane.id));
        if (selected.length === 0) {
          throw new Error("No valid lanes selected for conflict prediction");
        }
        autoLimited = selected.length > MAX_AUTO_LANES;
        comparisonLanes = selected.slice(0, autoLimited ? MAX_AUTO_LANES : selected.length);
        basePredictionLanes = comparisonLanes;
        totalPairs = Math.max(0, (comparisonLanes.length * (comparisonLanes.length - 1)) / 2);
      } else {
        autoLimited = lanes.length > MAX_AUTO_LANES;
        comparisonLanes = lanes.slice(0, autoLimited ? MAX_AUTO_LANES : lanes.length);
        basePredictionLanes = comparisonLanes;
        totalPairs = Math.max(0, (comparisonLanes.length * (comparisonLanes.length - 1)) / 2);
      }
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

      if (targetLane) {
        for (const peer of lanes) {
          if (peer.id === targetLane.id) continue;
          try {
            const pairId = `pair:${pairKey(targetLane.id, peer.id)}`;
            await runSerializedPairTask(pairId, async () => {
              await predictPairwise(targetLane, peer);
            });
          } catch (error) {
            logger.warn("conflicts.predict_pair_failed", {
              laneId: targetLane.id,
              peerId: peer.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
          completedPairs += 1;
          emitProgress({ laneAId: targetLane.id, laneBId: peer.id });
        }
      } else {
        for (let i = 0; i < comparisonLanes.length; i++) {
          for (let j = i + 1; j < comparisonLanes.length; j++) {
            const laneA = comparisonLanes[i]!;
            const laneB = comparisonLanes[j]!;
            try {
              const pairId = `pair:${pairKey(laneA.id, laneB.id)}`;
              await runSerializedPairTask(pairId, async () => {
                await predictPairwise(laneA, laneB);
              });
            } catch (error) {
              logger.warn("conflicts.predict_pair_failed", {
                laneId: laneA.id,
                peerId: laneB.id,
                error: error instanceof Error ? error.message : String(error)
              });
            }
            completedPairs += 1;
            emitProgress({ laneAId: laneA.id, laneBId: laneB.id });
          }
        }
      }

      const after = await buildBatchAssessment({
        progress: { completedPairs, totalPairs },
        truncated: targetLane ? false : autoLimited,
        comparedLaneIds: comparisonLanes.map((lane) => lane.id),
        maxAutoLanes: targetLane ? undefined : autoLimited ? MAX_AUTO_LANES : undefined,
        totalLanes: lanes.length
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
      const autoLimited = lanes.length > MAX_AUTO_LANES;
      const comparedLaneIds = lanes.slice(0, autoLimited ? MAX_AUTO_LANES : lanes.length).map((lane) => lane.id);
      return await buildBatchAssessment({
        truncated: autoLimited,
        comparedLaneIds,
        maxAutoLanes: autoLimited ? MAX_AUTO_LANES : undefined,
        totalLanes: lanes.length
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

  const requestProposal = async (args: RequestConflictProposalArgs): Promise<ConflictProposal> => {
    const lane = (await listActiveLanes()).find((entry) => entry.id === args.laneId);
    if (!lane) {
      throw new Error(`Lane not found: ${args.laneId}`);
    }

    if (!hostedAgentService || !hostedAgentService.getStatus().enabled) {
      throw new Error("Hosted provider is not configured. Set Provider Mode to Hosted and sign in first.");
    }

    let conflictContext: Record<string, unknown> = {
      laneId: args.laneId,
      peerLaneId: args.peerLaneId ?? null,
      overlaps: await listOverlaps({ laneId: args.laneId }),
      status: await getLaneStatus({ laneId: args.laneId })
    };

    if (conflictPacksDir) {
      const packPath = path.join(conflictPacksDir, `${args.laneId}.json`);
      if (fs.existsSync(packPath)) {
        try {
          const raw = fs.readFileSync(packPath, "utf8");
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            conflictContext = parsed as Record<string, unknown>;
          }
        } catch {
          // Ignore malformed conflict pack and fall back to runtime context.
        }
      }
    }

    const hostedResult = await hostedAgentService.requestConflictProposal({
      laneId: args.laneId,
      peerLaneId: args.peerLaneId ?? null,
      conflictContext
    });

    const createdAt = new Date().toISOString();
    const proposalId = randomUUID();
    const predictionId = getLatestPredictionId(args.laneId, args.peerLaneId ?? null);

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
        ) values (?, ?, ?, ?, ?, 'hosted', ?, ?, ?, 'pending', ?, ?, null, ?, ?, ?)
      `,
      [
        proposalId,
        projectId,
        args.laneId,
        args.peerLaneId ?? null,
        predictionId,
        hostedResult.confidence,
        hostedResult.explanation,
        hostedResult.diffPatch,
        hostedResult.jobId,
        hostedResult.artifactId,
        JSON.stringify({
          rawContent: hostedResult.rawContent
        }),
        createdAt,
        createdAt
      ]
    );

    const row = getProposalRow(proposalId);
    if (!row) {
      throw new Error("Failed to persist conflict proposal");
    }
    return rowToProposal(row);
  };

  const applyProposal = async (args: ApplyConflictProposalArgs): Promise<ConflictProposal> => {
    const row = getProposalRow(args.proposalId);
    if (!row || row.lane_id !== args.laneId) {
      throw new Error(`Proposal not found: ${args.proposalId}`);
    }
    if (!row.diff_patch.trim()) {
      throw new Error("Proposal does not include a diff patch");
    }

    const lane = laneService.getLaneBaseAndBranch(args.laneId);
    const preHeadSha = await readHeadSha(lane.worktreePath);
    const operation = operationService?.start({
      laneId: args.laneId,
      kind: "conflict_proposal_apply",
      preHeadSha,
      metadata: {
        proposalId: args.proposalId
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
          set status = 'applied',
              applied_operation_id = ?,
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [operation?.operationId ?? null, now, args.proposalId, projectId]
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

    const patchFile = writePatchFile(row.diff_patch);
    try {
      const undoResult = await runGit(
        ["apply", "-R", "--3way", "--whitespace=nowarn", patchFile],
        { cwd: lane.worktreePath, timeoutMs: 60_000 }
      );
      if (undoResult.exitCode !== 0) {
        throw new Error(undoResult.stderr.trim() || "Failed to undo applied proposal patch");
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
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [now, args.proposalId, projectId]
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
      throw new Error(`Proposal not found after undo: ${args.proposalId}`);
    }
    return rowToProposal(updated);
  };

  return {
    getLaneStatus,
    listOverlaps,
    getRiskMatrix,
    simulateMerge,
    runPrediction,
    getBatchAssessment,
    listProposals,
    requestProposal,
    applyProposal,
    undoProposal
  };
}
