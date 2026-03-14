/**
 * Shared utility functions for pack builders.
 *
 * These helpers are extracted from `packService.ts` to be reusable across
 * the project, lane, mission, and conflict pack builder modules.
 */

import fs from "node:fs";
import path from "node:path";
import type { AdeDb } from "../state/kvDb";
import type {
  ConflictRiskLevel,
  ConflictStatusValue,
  PackMergeReadiness,
  PackType,
  SessionDeltaSummary,
  TestRunStatus
} from "../../../shared/types";
import { safeJsonParse } from "../shared/utils";
import type { PackGraphEnvelopeV1, PackRelation } from "../../../shared/contextContract";
import {
  ADE_INTENT_END,
  ADE_INTENT_START,
  ADE_NARRATIVE_END,
  ADE_NARRATIVE_START,
  ADE_TASK_SPEC_END,
  ADE_TASK_SPEC_START,
  ADE_TODOS_END,
  ADE_TODOS_START
} from "../../../shared/contextContract";
import type { SectionLocator } from "./packSections";

// ── Row types ────────────────────────────────────────────────────────────────

export type LaneSessionRow = {
  id: string;
  lane_id: string;
  tracked: number;
  started_at: string;
  ended_at: string | null;
  head_sha_start: string | null;
  head_sha_end: string | null;
  transcript_path: string;
};

export type SessionDeltaRow = {
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

export type ParsedNumStat = {
  insertions: number;
  deletions: number;
  files: Set<string>;
};

// ── Conflict prediction pack shape ───────────────────────────────────────────

export type ConflictPredictionPackFile = {
  laneId?: string;
  status?: {
    laneId?: string;
    status?: string;
    overlappingFileCount?: number;
    peerConflictCount?: number;
    lastPredictedAt?: string | null;
  };
  predictionAt?: string | null;
  lastRecomputedAt?: string | null;
  stalePolicy?: { ttlMs?: number };
  overlaps?: Array<{
    peerId?: string | null;
    peerName?: string;
    riskLevel?: string;
    files?: Array<{ path?: string }>;
  }>;
  openConflictSummaries?: Array<{
    peerId?: string | null;
    peerLabel?: string;
    riskLevel?: string;
    fileCount?: number;
    lastSeenAt?: string | null;
    riskSignals?: string[];
  }>;
  matrix?: Array<{
    laneAId?: string;
    laneBId?: string;
    riskLevel?: string;
    overlapCount?: number;
    hasConflict?: boolean;
    computedAt?: string | null;
    stale?: boolean;
  }>;
  generatedAt?: string;
  truncated?: boolean;
  strategy?: string;
  pairwisePairsComputed?: number;
  pairwisePairsTotal?: number;
};

// ── Pure helper functions ────────────────────────────────────────────────────

export function safeJsonParseArray(raw: string | null | undefined): string[] {
  const parsed = safeJsonParse<unknown>(raw, null);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => String(entry));
}

export function readFileIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function ensureDirFor(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function safeSegment(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "untitled";
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

export function parsePackMetadataJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseNumStat(stdout: string): ParsedNumStat {
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

export function parsePorcelainPaths(stdout: string): string[] {
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

export function parseChatTranscriptDelta(rawTranscript: string): {
  touchedFiles: string[];
  failureLines: string[];
} {
  const touched = new Set<string>();
  const failureLines: string[] = [];
  const seenFailure = new Set<string>();

  const pushFailure = (value: string | null | undefined) => {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!normalized.length) return;
    const clipped = normalized.length > 320 ? normalized.slice(0, 320) : normalized;
    if (seenFailure.has(clipped)) return;
    seenFailure.add(clipped);
    failureLines.push(clipped);
  };

  for (const rawLine of rawTranscript.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.length) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const event = (parsed as { event?: unknown }).event;
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const eventRecord = event as Record<string, unknown>;
    const type = typeof eventRecord.type === "string" ? eventRecord.type : "";

    if (type === "file_change") {
      const pathValue = String(eventRecord.path ?? "").trim();
      if (pathValue.length && !pathValue.startsWith("(")) touched.add(pathValue);
      continue;
    }

    if (type === "command") {
      const command = String(eventRecord.command ?? "").trim();
      const output = String(eventRecord.output ?? "");
      const status = String(eventRecord.status ?? "").trim();
      const exitCode = typeof eventRecord.exitCode === "number" ? eventRecord.exitCode : null;

      if (status === "failed" || (exitCode != null && exitCode !== 0)) {
        pushFailure(command.length ? `Command failed: ${command}` : "Command failed.");
      }

      for (const outputLine of output.split(/\r?\n/)) {
        const normalized = outputLine.replace(/\s+/g, " ").trim();
        if (!normalized.length) continue;
        if (!/\b(error|failed|exception|fatal|traceback)\b/i.test(normalized)) continue;
        pushFailure(normalized);
      }
      continue;
    }

    if (type === "error") {
      pushFailure(String(eventRecord.message ?? "Chat error."));
      continue;
    }

    if (type === "status") {
      const turnStatus = String(eventRecord.turnStatus ?? "").trim();
      if (turnStatus === "failed") {
        pushFailure(String(eventRecord.message ?? "Turn failed."));
      }
    }
  }

  return {
    touchedFiles: [...new Set(touched)].sort(),
    failureLines: failureLines.slice(-16)
  };
}

export function extractSection(existing: string, start: string, end: string, fallback: string): string {
  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return fallback;
  const body = existing.slice(startIdx + start.length, endIdx).trim();
  return body.length ? body : fallback;
}

export function extractSectionByHeading(existing: string, heading: string): string | null {
  const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*$`, "m");
  const match = re.exec(existing);
  if (!match?.index && match?.index !== 0) return null;

  const headingStart = match.index;
  const headingLineEnd = existing.indexOf("\n", headingStart);
  const sectionStart = headingLineEnd >= 0 ? headingLineEnd + 1 : existing.length;

  const nextHeading = (() => {
    const r = /^##\s+/gm;
    r.lastIndex = sectionStart;
    const m = r.exec(existing);
    return m ? m.index : -1;
  })();
  const nextHr = (() => {
    const r = /^---\s*$/gm;
    r.lastIndex = sectionStart;
    const m = r.exec(existing);
    return m ? m.index : -1;
  })();

  const candidates = [nextHeading, nextHr].filter((idx) => idx >= 0);
  const sectionEnd = candidates.length ? Math.min(...candidates) : existing.length;

  const body = existing.slice(sectionStart, sectionEnd).trim();
  return body.length ? body : "";
}

export function statusFromCode(status: TestRunStatus): string {
  if (status === "passed") return "PASS";
  if (status === "failed") return "FAIL";
  if (status === "running") return "RUNNING";
  if (status === "canceled") return "CANCELED";
  return "TIMED_OUT";
}

export function humanToolLabel(toolType: string | null | undefined): string {
  const normalized = String(toolType ?? "").trim().toLowerCase();
  if (!normalized) return "Shell";
  if (normalized === "claude") return "Claude";
  if (normalized === "codex") return "Codex";
  if (normalized === "cursor") return "Cursor";
  if (normalized === "aider") return "Aider";
  if (normalized === "continue") return "Continue";
  if (normalized === "shell") return "Shell";
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
}

export function shellQuoteArg(arg: string): string {
  const value = String(arg);
  if (!value.length) return "''";
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function formatCommand(command: unknown): string {
  if (Array.isArray(command)) return command.map((part) => shellQuoteArg(String(part))).join(" ");
  if (typeof command === "string") return command.trim();
  return JSON.stringify(command);
}

export function moduleFromPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const first = normalized.split("/")[0] ?? normalized;
  return first || ".";
}

export function normalizeConflictStatus(value: string): ConflictStatusValue | null {
  const v = value.trim();
  if (
    v === "merge-ready" ||
    v === "behind-base" ||
    v === "conflict-predicted" ||
    v === "conflict-active" ||
    v === "unknown"
  ) {
    return v;
  }
  return null;
}

export function normalizeRiskLevel(value: string): ConflictRiskLevel | null {
  const v = value.trim();
  if (v === "none" || v === "low" || v === "medium" || v === "high") return v;
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function computeMergeReadiness(args: {
  requiredMerges: string[];
  behindCount: number;
  conflictStatus: ConflictStatusValue | null;
}): PackMergeReadiness {
  if (args.requiredMerges.length) return "blocked";
  if (args.conflictStatus === "unknown" || args.conflictStatus == null) return "unknown";
  if (args.conflictStatus === "conflict-active" || args.conflictStatus === "conflict-predicted") return "blocked";
  if (args.behindCount > 0) return "needs_sync";
  return "ready";
}

export function buildGraphEnvelope(relations: PackRelation[]): PackGraphEnvelopeV1 {
  return {
    schema: "ade.packGraph.v1",
    relations
  };
}

export function importanceRank(value: unknown): number {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "high") return 3;
  if (v === "medium") return 2;
  if (v === "low") return 1;
  return 0;
}

export function getDefaultSectionLocators(packType: PackType): SectionLocator[] {
  if (packType === "lane") {
    return [
      { id: "task_spec", kind: "markers", startMarker: ADE_TASK_SPEC_START, endMarker: ADE_TASK_SPEC_END },
      { id: "intent", kind: "markers", startMarker: ADE_INTENT_START, endMarker: ADE_INTENT_END },
      { id: "todos", kind: "markers", startMarker: ADE_TODOS_START, endMarker: ADE_TODOS_END },
      { id: "narrative", kind: "markers", startMarker: ADE_NARRATIVE_START, endMarker: ADE_NARRATIVE_END },
      { id: "what_changed", kind: "heading", heading: "## What Changed" },
      { id: "validation", kind: "heading", heading: "## Validation" },
      { id: "errors", kind: "heading", heading: "## Errors & Issues" },
      { id: "sessions", kind: "heading", heading: "## Sessions" }
    ];
  }
  if (packType === "conflict") {
    return [
      { id: "overlap", kind: "heading", heading: "## Overlapping Files" },
      { id: "conflicts", kind: "heading", heading: "## Conflicts (merge-tree)" },
      { id: "lane_excerpt", kind: "heading", heading: "## Lane Pack (Excerpt)" }
    ];
  }
  return [
    { id: "bootstrap", kind: "heading", heading: "## Bootstrap context (codebase + docs)" },
    { id: "lane_snapshot", kind: "heading", heading: "## Lane Snapshot" }
  ];
}

export function rowToSessionDelta(row: SessionDeltaRow): SessionDeltaSummary {
  return {
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
  };
}

/**
 * Upsert a row into `packs_index`.
 */
export function upsertPackIndex({
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

export function toPackSummaryFromRow(args: {
  packKey: string;
  row: {
    pack_type: PackType;
    pack_path: string;
    deterministic_updated_at: string | null;
    narrative_updated_at: string | null;
    last_head_sha: string | null;
    metadata_json?: string | null;
  } | null;
  version: { versionId: string; versionNumber: number; contentHash: string } | null;
}) {
  const packType = args.row?.pack_type ?? "project";
  const packPath = args.row?.pack_path ?? "";
  const body = packPath ? readFileIfExists(packPath) : "";
  const exists = packPath.length ? fs.existsSync(packPath) : false;
  const metadata = parsePackMetadataJson(args.row?.metadata_json);

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
    metadata,
    body
  };
}
