/**
 * Conflict pack builder — generates conflict packs by running merge-tree
 * analysis and computing overlap.  Also provides helpers for reading
 * conflict prediction packs and deriving conflict state.
 */

import fs from "node:fs";
import path from "node:path";
import { runGit, runGitMergeTree, runGitOrThrow } from "../git/git";
import type { createLaneService } from "../lanes/laneService";
import type {
  GitConflictState,
  LaneSummary,
  LaneLineageV1,
  PackConflictStateV1
} from "../../../shared/types";
import { parseDiffNameOnly, uniqueSorted } from "../shared/utils";
import {
  asString,
  isRecord,
  normalizeConflictStatus,
  type ConflictPredictionPackFile
} from "./packUtils";

// ── Deps ─────────────────────────────────────────────────────────────────────

export type ConflictPackBuilderDeps = {
  projectRoot: string;
  laneService: ReturnType<typeof createLaneService>;
  getConflictPredictionPath: (laneId: string) => string;
  getLegacyConflictPredictionPath: (laneId: string) => string;
  getLanePackPath: (laneId: string) => string;
};

// ── Conflict prediction reading ──────────────────────────────────────────────

export function readConflictPredictionPack(
  deps: ConflictPackBuilderDeps,
  laneId: string
): ConflictPredictionPackFile | null {
  const candidates = [deps.getConflictPredictionPath(laneId), deps.getLegacyConflictPredictionPath(laneId)];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) continue;
      return parsed as ConflictPredictionPackFile;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Git conflict state ──────────────────────────────────────────────────────

export async function readGitConflictState(
  deps: ConflictPackBuilderDeps,
  laneId: string
): Promise<GitConflictState | null> {
  const lane = deps.laneService.getLaneBaseAndBranch(laneId);
  const gitDirRes = await runGit(["rev-parse", "--absolute-git-dir"], { cwd: lane.worktreePath, timeoutMs: 10_000 });
  const gitDir = gitDirRes.exitCode === 0 ? gitDirRes.stdout.trim() : "";
  const hasRebase =
    gitDir.length > 0 &&
    (fs.existsSync(path.join(gitDir, "rebase-apply")) || fs.existsSync(path.join(gitDir, "rebase-merge")));
  const hasMerge = gitDir.length > 0 && fs.existsSync(path.join(gitDir, "MERGE_HEAD"));
  const kind: GitConflictState["kind"] = hasRebase ? "rebase" : hasMerge ? "merge" : null;

  const unmergedRes = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: lane.worktreePath, timeoutMs: 10_000 });
  const conflictedFiles =
    unmergedRes.exitCode === 0 ? parseDiffNameOnly(unmergedRes.stdout).sort((a, b) => a.localeCompare(b)) : [];

  const inProgress = kind != null;
  return {
    laneId,
    kind,
    inProgress,
    conflictedFiles,
    canContinue: inProgress && conflictedFiles.length === 0,
    canAbort: inProgress
  };
}

// ── Derive conflict state from prediction pack ──────────────────────────────

export function deriveConflictStateForLane(
  deps: ConflictPackBuilderDeps,
  laneId: string
): PackConflictStateV1 | null {
  const pack = readConflictPredictionPack(deps, laneId);
  if (!pack || !isRecord(pack.status)) return null;
  const status = pack.status as NonNullable<ConflictPredictionPackFile["status"]>;
  const statusValue = normalizeConflictStatus(asString(status.status).trim()) ?? "unknown";
  const overlappingFileCount = Number(status.overlappingFileCount ?? 0);
  const peerConflictCount = Number(status.peerConflictCount ?? 0);
  const lastPredictedAt = asString(status.lastPredictedAt).trim() || null;
  const strategy = asString(pack.strategy).trim() || undefined;
  const pairwisePairsComputed = Number.isFinite(Number(pack.pairwisePairsComputed)) ? Number(pack.pairwisePairsComputed) : undefined;
  const pairwisePairsTotal = Number.isFinite(Number(pack.pairwisePairsTotal)) ? Number(pack.pairwisePairsTotal) : undefined;
  const lastRecomputedAt = asString(pack.lastRecomputedAt).trim() || asString(pack.generatedAt).trim() || null;

  return {
    status: statusValue,
    lastPredictedAt,
    overlappingFileCount: Number.isFinite(overlappingFileCount) ? overlappingFileCount : 0,
    peerConflictCount: Number.isFinite(peerConflictCount) ? peerConflictCount : 0,
    unresolvedPairCount: Number.isFinite(peerConflictCount) ? peerConflictCount : 0,
    truncated: Boolean(pack.truncated),
    strategy,
    pairwisePairsComputed,
    pairwisePairsTotal,
    lastRecomputedAt
  };
}

// ── Lane lineage ────────────────────────────────────────────────────────────

export function computeLaneLineage(args: { laneId: string; lanesById: Map<string, LaneSummary> }): LaneLineageV1 {
  const lane = args.lanesById.get(args.laneId) ?? null;
  const stackDepth = Number(lane?.stackDepth ?? 0);
  const parentLaneId = lane?.parentLaneId ?? null;
  let baseLaneId: string | null = lane?.id ?? args.laneId;
  let cursor = lane;
  const visited = new Set<string>();
  while (cursor?.parentLaneId && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const parent = args.lanesById.get(cursor.parentLaneId) ?? null;
    if (!parent) break;
    baseLaneId = parent.id;
    cursor = parent;
  }
  return {
    laneId: args.laneId,
    parentLaneId,
    baseLaneId,
    stackDepth: Number.isFinite(stackDepth) ? stackDepth : 0
  };
}

// ── Conflict risk summary lines ─────────────────────────────────────────────

export function buildLaneConflictRiskSummaryLines(
  deps: ConflictPackBuilderDeps,
  laneId: string
): string[] {
  const pack = readConflictPredictionPack(deps, laneId);
  if (!pack || !isRecord(pack.status)) return [];

  const status = pack.status as NonNullable<ConflictPredictionPackFile["status"]>;
  const statusValue = asString(status.status).trim() || "unknown";
  const overlappingFileCount = Number(status.overlappingFileCount ?? 0);
  const peerConflictCount = Number(status.peerConflictCount ?? 0);
  const lastPredictedAt = asString(status.lastPredictedAt).trim() || null;

  const lines: string[] = [];
  lines.push(`- Conflict status: \`${statusValue}\``);
  lines.push(`- Overlapping files: ${Number.isFinite(overlappingFileCount) ? overlappingFileCount : 0}`);
  lines.push(`- Peer conflicts: ${Number.isFinite(peerConflictCount) ? peerConflictCount : 0}`);
  if (lastPredictedAt) lines.push(`- Last predicted: ${lastPredictedAt}`);
  if (asString(pack.generatedAt).trim()) lines.push(`- Generated: ${asString(pack.generatedAt).trim()}`);

  const overlaps = Array.isArray(pack.overlaps) ? pack.overlaps : [];
  const riskScore = (riskLevel: string): number => {
    const normalized = riskLevel.trim().toLowerCase();
    if (normalized === "high") return 3;
    if (normalized === "medium") return 2;
    if (normalized === "low") return 1;
    if (normalized === "none") return 0;
    return 0;
  };

  const peers = overlaps
    .filter((ov) => ov && ov.peerId != null)
    .map((ov) => {
      const peerName = asString(ov.peerName).trim() || "Unknown lane";
      const riskLevel = asString(ov.riskLevel).trim() || "unknown";
      const fileCount = Array.isArray(ov.files) ? ov.files.length : 0;
      return { peerName, riskLevel, fileCount, score: riskScore(riskLevel) };
    })
    .filter((ov) => ov.score > 0 || ov.fileCount > 0)
    .sort((a, b) => b.score - a.score || b.fileCount - a.fileCount || a.peerName.localeCompare(b.peerName))
    .slice(0, 5);

  if (peers.length) {
    lines.push("- Top risky peers:");
    for (const peer of peers) {
      lines.push(`  - ${peer.peerName}: \`${peer.riskLevel}\` (${peer.fileCount} files)`);
    }
  }

  if (pack.truncated) {
    const strategyValue = asString(pack.strategy).trim() || "partial";
    const computed = Number(pack.pairwisePairsComputed ?? NaN);
    const total = Number(pack.pairwisePairsTotal ?? NaN);
    if (Number.isFinite(computed) && Number.isFinite(total) && total > 0) {
      lines.push(`- Pairwise coverage: ${computed}/${total} pairs (strategy=\`${strategyValue}\`)`);
    } else {
      lines.push(`- Pairwise coverage: partial (strategy=\`${strategyValue}\`)`);
    }
  }

  return lines;
}

// ── Read lane pack excerpt ──────────────────────────────────────────────────

export function readLanePackExcerpt(deps: ConflictPackBuilderDeps, laneId: string): string | null {
  const filePath = deps.getLanePackPath(laneId);
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
}

// ── Build conflict pack body ────────────────────────────────────────────────

export async function buildConflictPackBody(
  deps: ConflictPackBuilderDeps,
  args: {
    laneId: string;
    peerLaneId: string | null;
    reason: string;
    deterministicUpdatedAt: string;
  }
): Promise<{ body: string; lastHeadSha: string | null }> {
  const laneA = deps.laneService.getLaneBaseAndBranch(args.laneId);
  const laneAHead = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: laneA.worktreePath, timeoutMs: 10_000 })).trim();
  const peerLabel = args.peerLaneId ? `lane:${args.peerLaneId}` : `base:${laneA.baseRef}`;

  const laneBHead = args.peerLaneId
    ? (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: deps.laneService.getLaneBaseAndBranch(args.peerLaneId).worktreePath, timeoutMs: 10_000 })).trim()
    : (await runGitOrThrow(["rev-parse", laneA.baseRef], { cwd: deps.projectRoot, timeoutMs: 10_000 })).trim();

  const mergeBase = (await runGitOrThrow(["merge-base", laneAHead, laneBHead], { cwd: deps.projectRoot, timeoutMs: 12_000 })).trim();
  const merge = await runGitMergeTree({
    cwd: deps.projectRoot,
    mergeBase,
    branchA: laneAHead,
    branchB: laneBHead,
    timeoutMs: 60_000
  });

  const touchedA = await runGit(["diff", "--name-only", `${mergeBase}..${laneAHead}`], { cwd: deps.projectRoot, timeoutMs: 20_000 });
  const touchedB = await runGit(["diff", "--name-only", `${mergeBase}..${laneBHead}`], { cwd: deps.projectRoot, timeoutMs: 20_000 });
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

  const lanePackBody = readLanePackExcerpt(deps, args.laneId);
  if (lanePackBody) {
    lines.push("## Lane Pack (Excerpt)");
    lines.push("```");
    lines.push(lanePackBody.trim());
    lines.push("```");
    lines.push("");
  }

  if (args.peerLaneId) {
    const peerPackBody = readLanePackExcerpt(deps, args.peerLaneId);
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
}
