import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runGit, runGitMergeTree, runGitOrThrow } from "../git/git";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createOperationService } from "../history/operationService";
import type {
  Checkpoint,
  ConflictLineageV1,
  ContextDocStatus,
  ContextGenerateDocsArgs,
  ContextGenerateDocsResult,
  ContextStatus,
  ContextExportLevel,
  ConflictRiskLevel,
  ConflictStatusValue,
  GetConflictExportArgs,
  GetLaneExportArgs,
  GetProjectExportArgs,
  GitConflictState,
  LaneExportManifestV1,
  LaneLineageV1,
  LaneSummary,
  ListPackEventsSinceArgs,
  PackConflictStateV1,
  PackDeltaDigestArgs,
  PackDeltaDigestV1,
  PackDependencyStateV1,
  PackEvent,
  PackEventCategory,
  PackEventEntityRef,
  PackEventImportance,
  PackExport,
  PackHeadVersion,
  PackMergeReadiness,
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
  ADE_TODOS_START
} from "../../../shared/contextContract";
import { stripAnsi } from "../../utils/ansiStrip";
import { inferTestOutcomeFromText, parseTranscriptSummary } from "./transcriptInsights";
import { renderLanePackMarkdown } from "./lanePackTemplate";
import { computeSectionChanges, upsertSectionByHeading } from "./packSections";
import type { SectionLocator } from "./packSections";
import { buildConflictExport, buildLaneExport, buildProjectExport } from "./packExports";
import type { PackGraphEnvelopeV1, PackRelation } from "../../../shared/contextContract";

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
    metadata_json?: string | null;
  } | null;
  version: { versionId: string; versionNumber: number; contentHash: string } | null;
}): PackSummary {
  const packType = args.row?.pack_type ?? "project";
  const packPath = args.row?.pack_path ?? "";
  const body = packPath ? readFileIfExists(packPath) : "";
  const exists = packPath.length ? fs.existsSync(packPath) : false;
  const metadata = (() => {
    const raw = args.row?.metadata_json;
    if (!raw || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  })();

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

function extractSectionByHeading(existing: string, heading: string): string | null {
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

function statusFromCode(status: TestRunStatus): string {
  if (status === "passed") return "PASS";
  if (status === "failed") return "FAIL";
  if (status === "running") return "RUNNING";
  if (status === "canceled") return "CANCELED";
  return "TIMED_OUT";
}

function humanToolLabel(toolType: string | null | undefined): string {
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

function shellQuoteArg(arg: string): string {
  const value = String(arg);
  if (!value.length) return "''";
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function formatCommand(command: unknown): string {
  if (Array.isArray(command)) return command.map((part) => shellQuoteArg(String(part))).join(" ");
  if (typeof command === "string") return command.trim();
  return JSON.stringify(command);
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

function normalizeConflictStatus(value: string): ConflictStatusValue | null {
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

function normalizeRiskLevel(value: string): ConflictRiskLevel | null {
  const v = value.trim();
  if (v === "none" || v === "low" || v === "medium" || v === "high") return v;
  return null;
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
  operationService: ReturnType<typeof createOperationService>;
  onEvent?: (event: PackEvent) => void;
}) {
  const projectPackPath = path.join(packsDir, "project_pack.md");
  const projectBootstrapPath = path.join(packsDir, "_bootstrap", "project_bootstrap.md");

  const getLanePackPath = (laneId: string) => path.join(packsDir, "lanes", laneId, "lane_pack.md");
  const getFeaturePackPath = (featureKey: string) => path.join(packsDir, "features", safeSegment(featureKey), "feature_pack.md");
  const getPlanPackPath = (laneId: string) => path.join(packsDir, "plans", laneId, "plan_pack.md");
  const getConflictPackPath = (laneId: string, peer: string) =>
    path.join(packsDir, "conflicts", "v2", `${laneId}__${safeSegment(peer)}.md`);
  const conflictsRootDir = path.join(packsDir, "conflicts");
  const conflictPredictionsDir = path.join(conflictsRootDir, "predictions");
  const getConflictPredictionPath = (laneId: string) => path.join(conflictPredictionsDir, `${laneId}.json`);
  const getLegacyConflictPredictionPath = (laneId: string) => path.join(conflictsRootDir, `${laneId}.json`);

  const versionsDir = path.join(packsDir, "versions");
  const historyDir = path.join(path.dirname(packsDir), "history");
  const checkpointsDir = path.join(historyDir, "checkpoints");
  const eventsDir = path.join(historyDir, "events");

  const nowIso = () => new Date().toISOString();

  const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);

  const asString = (value: unknown): string => (typeof value === "string" ? value : "");

  const buildGraphEnvelope = (relations: PackRelation[]): PackGraphEnvelopeV1 => ({
    schema: "ade.packGraph.v1",
    relations
  });

  const computeMergeReadiness = (args: {
    requiredMerges: string[];
    behindCount: number;
    conflictStatus: ConflictStatusValue | null;
  }): PackMergeReadiness => {
    if (args.requiredMerges.length) return "blocked";
    if (args.conflictStatus === "unknown" || args.conflictStatus == null) return "unknown";
    if (args.conflictStatus === "conflict-active" || args.conflictStatus === "conflict-predicted") return "blocked";
    if (args.behindCount > 0) return "needs_sync";
    return "ready";
  };

  const importanceRank = (value: unknown): number => {
    const v = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (v === "high") return 3;
    if (v === "medium") return 2;
    if (v === "low") return 1;
    return 0;
  };

  const getDefaultSectionLocators = (packType: PackType): SectionLocator[] => {
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
  };

  const CONTEXT_VERSION = 1;
  const BOOTSTRAP_FINGERPRINT_RE = /<!--\s*ADE_DOCS_FINGERPRINT:([a-f0-9]{64})\s*-->/i;
  const ADE_DOC_PRD_REL = "docs/PRD.ade.md";
  const ADE_DOC_ARCH_REL = "docs/architecture/ARCHITECTURE.ade.md";
  const CONTEXT_DOC_LAST_RUN_KEY = "context:docs:lastRun.v1";
  const FALLBACK_GENERATED_ROOT = path.join(path.dirname(packsDir), "context", "generated");
  const CONTEXT_CLIP_TAG = "omitted_due_size";

  const nowTimestampSegment = () => {
    const iso = nowIso();
    return iso.replace(/[:]/g, "-").replace(/\..+$/, "Z");
  };

  const safeReadDoc = (absPath: string, maxBytes: number): { text: string; truncated: boolean } => {
    try {
      const fd = fs.openSync(absPath, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
        const text = buf.slice(0, Math.max(0, bytesRead)).toString("utf8");
        const size = fs.statSync(absPath).size;
        return { text, truncated: size > bytesRead };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { text: "", truncated: false };
    }
  };

  const formatDocDigest = (args: {
    title: string;
    sources: string[];
    maxChars: number;
  }): { content: string; warnings: string[] } => {
    const warnings: string[] = [];
    const lines: string[] = [
      `# ${args.title}`,
      "",
      "> ADE minimized context document. Generated deterministically for model context.",
      ""
    ];
    let usedChars = lines.join("\n").length;

    for (const rel of args.sources) {
      const abs = path.join(projectRoot, rel);
      if (!fs.existsSync(abs)) continue;
      const read = safeReadDoc(abs, 160_000);
      if (!read.text.trim()) continue;
      const normalized = read.text.replace(/\r\n/g, "\n");
      const sourceLines = normalized.split("\n");
      const digest: string[] = [];
      for (const line of sourceLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("```")) continue;
        digest.push(trimmed);
        if (digest.join(" ").length > 1_400) break;
      }
      const blockHeader = `## Source: ${rel}`;
      const block = [blockHeader, ...digest.slice(0, 16), ""].join("\n");
      if (usedChars + block.length > args.maxChars) {
        warnings.push(`${CONTEXT_CLIP_TAG}:${rel}`);
        lines.push(blockHeader);
        lines.push(`- ${CONTEXT_CLIP_TAG}: source exceeded generation cap`);
        lines.push("");
        continue;
      }
      lines.push(blockHeader);
      for (const entry of digest.slice(0, 16)) lines.push(entry);
      if (read.truncated) lines.push(`- ${CONTEXT_CLIP_TAG}: source file truncated while reading`);
      lines.push("");
      usedChars = lines.join("\n").length;
    }

    if (warnings.length) {
      lines.push("## Omitted");
      for (const warning of warnings) lines.push(`- ${warning}`);
      lines.push("");
    }

    return { content: `${lines.join("\n").trim()}\n`, warnings };
  };

  const resolveContextGeneratorCommand = (provider: ContextGenerateDocsArgs["provider"]): string[] => {
    const snapshot = projectConfigService.get();
    const providers = isRecord(snapshot.local.providers)
      ? snapshot.local.providers
      : isRecord(snapshot.effective.providers)
        ? snapshot.effective.providers
        : {};
    const contextTools = isRecord((providers as Record<string, unknown>).contextTools)
      ? ((providers as Record<string, unknown>).contextTools as Record<string, unknown>)
      : {};
    const generators = isRecord(contextTools.generators) ? (contextTools.generators as Record<string, unknown>) : {};
    const providerConfig = isRecord(generators[provider]) ? (generators[provider] as Record<string, unknown>) : {};
    const rawCommand = Array.isArray(providerConfig.command) ? providerConfig.command : [];
    return rawCommand.map((value) => String(value));
  };

  const runContextGeneratorCommand = (args: {
    provider: ContextGenerateDocsArgs["provider"];
    promptFile: string;
    outputPrd: string;
    outputArchitecture: string;
  }): { stdout: string; stderr: string; exitCode: number | null; command: string[] } => {
    const command = resolveContextGeneratorCommand(args.provider);
    if (!command.length) {
      return { stdout: "", stderr: "context_generator_command_missing", exitCode: null, command: [] };
    }
    const rendered = command.map((token) =>
      token
        .replace(/\{\{promptFile\}\}/g, args.promptFile)
        .replace(/\{\{projectRoot\}\}/g, projectRoot)
        .replace(/\{\{outputPrd\}\}/g, args.outputPrd)
        .replace(/\{\{outputArchitecture\}\}/g, args.outputArchitecture)
    );
    const bin = rendered[0];
    if (!bin) return { stdout: "", stderr: "context_generator_command_invalid", exitCode: null, command: rendered };
    const proc = spawnSync(bin, rendered.slice(1), {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 240_000,
      maxBuffer: 4 * 1024 * 1024
    });
    return {
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
      exitCode: proc.status,
      command: rendered
    };
  };

  const writeDocWithFallback = (args: {
    preferredAbsPath: string;
    fallbackFileName: string;
    content: string;
  }): { writtenPath: string; usedFallback: boolean; warning: string | null } => {
    try {
      ensureDirFor(args.preferredAbsPath);
      fs.writeFileSync(args.preferredAbsPath, args.content, "utf8");
      return { writtenPath: args.preferredAbsPath, usedFallback: false, warning: null };
    } catch (error) {
      const ts = nowTimestampSegment();
      const fallbackDir = path.join(FALLBACK_GENERATED_ROOT, ts);
      fs.mkdirSync(fallbackDir, { recursive: true });
      const fallbackPath = path.join(fallbackDir, args.fallbackFileName);
      fs.writeFileSync(fallbackPath, args.content, "utf8");
      const reason = error instanceof Error ? error.message : String(error);
      return {
        writtenPath: fallbackPath,
        usedFallback: true,
        warning: `write_failed_preferred_path:${args.preferredAbsPath}:${reason}`
      };
    }
  };

  const collectContextDocPaths = (): string[] => {
    const out = new Set<string>(["docs/PRD.md", ADE_DOC_PRD_REL, ADE_DOC_ARCH_REL]);
    const walk = (relDir: string, depth: number) => {
      if (depth < 0) return;
      const abs = path.join(projectRoot, relDir);
      if (!fs.existsSync(abs)) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const rel = path.join(relDir, entry.name).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          walk(rel, depth - 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(md|mdx|txt|yaml|yml|json)$/i.test(entry.name)) continue;
        out.add(rel);
      }
    };
    walk("docs/architecture", 3);
    walk("docs/features", 3);
    return [...out]
      .sort((a, b) => a.localeCompare(b))
      .sort((a, b) => {
        const aAde = a.endsWith(".ade.md") ? 0 : 1;
        const bAde = b.endsWith(".ade.md") ? 0 : 1;
        return aAde - bAde;
      });
  };

  const readContextDocMeta = (): {
    contextFingerprint: string;
    contextVersion: number;
    lastDocsRefreshAt: string | null;
    docsStaleReason: string | null;
  } => {
    const paths = collectContextDocPaths();
    const entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const rel of paths) {
      const abs = path.join(projectRoot, rel);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        entries.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // ignore missing files
      }
    }

    const contextFingerprint = sha256(JSON.stringify(entries));
    const latestMtime = entries.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0);
    return {
      contextFingerprint,
      contextVersion: CONTEXT_VERSION,
      lastDocsRefreshAt: latestMtime > 0 ? new Date(latestMtime).toISOString() : null,
      docsStaleReason: entries.length ? null : "docs_missing_or_unreadable"
    };
  };

  const collectCanonicalContextDocPaths = (): string[] =>
    collectContextDocPaths().filter((rel) => !rel.endsWith(".ade.md"));

  const readCanonicalDocMeta = (): {
    scanned: number;
    present: number;
    fingerprint: string;
    updatedAt: string | null;
  } => {
    const paths = collectCanonicalContextDocPaths();
    const present: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const rel of paths) {
      try {
        const st = fs.statSync(path.join(projectRoot, rel));
        if (!st.isFile()) continue;
        present.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // ignore
      }
    }
    const latestMtime = present.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0);
    return {
      scanned: paths.length,
      present: present.length,
      fingerprint: sha256(JSON.stringify(present)),
      updatedAt: latestMtime > 0 ? new Date(latestMtime).toISOString() : null
    };
  };

  const readDocStatus = (args: {
    id: ContextDocStatus["id"];
    label: string;
    relPath: string;
    canonicalUpdatedAt: string | null;
    fallbackCount: number;
  }): ContextDocStatus => {
    const absPath = path.join(projectRoot, args.relPath);
    let exists = false;
    let sizeBytes = 0;
    let updatedAt: string | null = null;
    let fingerprint: string | null = null;
    try {
      const st = fs.statSync(absPath);
      if (st.isFile()) {
        exists = true;
        sizeBytes = st.size;
        updatedAt = st.mtime.toISOString();
        const body = fs.readFileSync(absPath, "utf8");
        fingerprint = sha256(body);
      }
    } catch {
      // ignore
    }
    const staleReason = (() => {
      if (!exists) return "missing";
      if (!updatedAt || !args.canonicalUpdatedAt) return null;
      const docTs = Date.parse(updatedAt);
      const canonicalTs = Date.parse(args.canonicalUpdatedAt);
      if (Number.isFinite(docTs) && Number.isFinite(canonicalTs) && docTs < canonicalTs) {
        return "older_than_canonical_docs";
      }
      return null;
    })();
    return {
      id: args.id,
      label: args.label,
      preferredPath: args.relPath,
      exists,
      sizeBytes,
      updatedAt,
      fingerprint,
      staleReason,
      fallbackCount: args.fallbackCount
    };
  };

  const countFallbackWrites = (): number => {
    if (!fs.existsSync(FALLBACK_GENERATED_ROOT)) return 0;
    const walk = (dir: string): number => {
      let total = 0;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return 0;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) total += walk(abs);
        if (entry.isFile() && entry.name.endsWith(".ade.md")) total += 1;
      }
      return total;
    };
    return walk(FALLBACK_GENERATED_ROOT);
  };

  const readContextStatus = (): ContextStatus => {
    const canonical = readCanonicalDocMeta();
    const fallbackCount = countFallbackWrites();
    const latestRunRaw = db.getJson<{
      warnings?: Array<{ code?: string; message?: string; actionLabel?: string; actionPath?: string }>;
    }>(CONTEXT_DOC_LAST_RUN_KEY);
    const latestWarnings = Array.isArray(latestRunRaw?.warnings)
      ? latestRunRaw!.warnings!.map((warning) => ({
          code: String(warning?.code ?? "unknown"),
          message: String(warning?.message ?? ""),
          ...(warning?.actionLabel ? { actionLabel: String(warning.actionLabel) } : {}),
          ...(warning?.actionPath ? { actionPath: String(warning.actionPath) } : {})
        }))
      : [];
    const docs = [
      readDocStatus({
        id: "prd_ade",
        label: "PRD (ADE minimized)",
        relPath: ADE_DOC_PRD_REL,
        canonicalUpdatedAt: canonical.updatedAt,
        fallbackCount
      }),
      readDocStatus({
        id: "architecture_ade",
        label: "Architecture (ADE minimized)",
        relPath: ADE_DOC_ARCH_REL,
        canonicalUpdatedAt: canonical.updatedAt,
        fallbackCount
      })
    ];

    const projectPackIndex = db.get<{ metadata_json: string | null; deterministic_updated_at: string | null }>(
      `
        select metadata_json, deterministic_updated_at
        from packs_index
        where project_id = ?
          and pack_key = 'project'
        limit 1
      `,
      [projectId]
    );
    const projectPackMeta = (() => {
      if (!projectPackIndex?.metadata_json) return {} as Record<string, unknown>;
      try {
        const parsed = JSON.parse(projectPackIndex.metadata_json) as unknown;
        return isRecord(parsed) ? parsed : {};
      } catch {
        return {} as Record<string, unknown>;
      }
    })();

    const insufficientContextCount = Number(
      db.get<{ count: number }>(
        `
          select count(1) as count
          from conflict_proposals
          where project_id = ?
            and metadata_json like '%"insufficientContext":true%'
        `,
        [projectId]
      )?.count ?? 0
    );

    return {
      docs,
      canonicalDocsPresent: canonical.present,
      canonicalDocsScanned: canonical.scanned,
      canonicalDocsFingerprint: canonical.fingerprint,
      canonicalDocsUpdatedAt: canonical.updatedAt,
      projectExportFingerprint: typeof projectPackMeta.contextFingerprint === "string" ? projectPackMeta.contextFingerprint : null,
      projectExportUpdatedAt: projectPackIndex?.deterministic_updated_at ?? null,
      contextManifestRefs: {
        project: null,
        packs: null,
        transcripts: null
      },
      fallbackWrites: fallbackCount,
      insufficientContextCount,
      hostedTiming: null,
      hostedTimeoutCount: 0,
      hostedLastTimeoutReason: null,
      warnings: latestWarnings
    };
  };

  const extractGeneratedSection = (stdout: string, marker: string): string => {
    const start = `<!-- ${marker}_START -->`;
    const end = `<!-- ${marker}_END -->`;
    const from = stdout.indexOf(start);
    const to = stdout.indexOf(end);
    if (from < 0 || to < 0 || to <= from) return "";
    return stdout.slice(from + start.length, to).trim();
  };

  const runContextDocGeneration = (args: ContextGenerateDocsArgs): ContextGenerateDocsResult => {
    const provider = args.provider;
    const generatedAt = nowIso();
    const warnings: ContextGenerateDocsResult["warnings"] = [];
    const canonicalPaths = collectCanonicalContextDocPaths();

    const prdDigest = formatDocDigest({
      title: "PRD.ade",
      sources: canonicalPaths.filter((rel) => /prd|product|roadmap|feature/i.test(rel)).concat(["docs/PRD.md"]).filter(Boolean),
      maxChars: 18_000
    });
    const archDigest = formatDocDigest({
      title: "ARCHITECTURE.ade",
      sources: canonicalPaths.filter((rel) => /architecture|system|design|lanes|conflict|pack/i.test(rel)),
      maxChars: 20_000
    });
    for (const warning of [...prdDigest.warnings, ...archDigest.warnings]) {
      warnings.push({ code: "omitted_due_size", message: warning });
    }

    const tmpRoot = path.join(path.dirname(packsDir), "context", "tmp");
    fs.mkdirSync(tmpRoot, { recursive: true });
    const promptFile = path.join(tmpRoot, `generate-context-${Date.now()}.md`);
    const outputPrd = path.join(tmpRoot, `prd-${Date.now()}.ade.md`);
    const outputArch = path.join(tmpRoot, `architecture-${Date.now()}.ade.md`);
    const prompt = [
      "Generate two markdown documents from the provided repository context.",
      "Output markers exactly if using stdout:",
      "<!-- ADE_PRD_DOC_START --> ... <!-- ADE_PRD_DOC_END -->",
      "<!-- ADE_ARCH_DOC_START --> ... <!-- ADE_ARCH_DOC_END -->",
      "",
      "PRD source digest:",
      prdDigest.content,
      "",
      "Architecture source digest:",
      archDigest.content
    ].join("\n");
    fs.writeFileSync(promptFile, prompt, "utf8");

    const cmdResult = runContextGeneratorCommand({
      provider,
      promptFile,
      outputPrd,
      outputArchitecture: outputArch
    });

    let generatedPrd = "";
    let generatedArch = "";
    if (cmdResult.exitCode === 0) {
      if (fs.existsSync(outputPrd)) generatedPrd = fs.readFileSync(outputPrd, "utf8");
      if (fs.existsSync(outputArch)) generatedArch = fs.readFileSync(outputArch, "utf8");
      if (!generatedPrd) generatedPrd = extractGeneratedSection(cmdResult.stdout, "ADE_PRD_DOC");
      if (!generatedArch) generatedArch = extractGeneratedSection(cmdResult.stdout, "ADE_ARCH_DOC");
    } else {
      warnings.push({
        code: "generator_failed",
        message: `provider=${provider} exitCode=${cmdResult.exitCode ?? -1} stderr=${cmdResult.stderr.slice(0, 300)}`
      });
    }

    if (!generatedPrd.trim()) {
      generatedPrd = prdDigest.content;
      warnings.push({ code: "generator_fallback_prd", message: "Used deterministic fallback PRD digest." });
    }
    if (!generatedArch.trim()) {
      generatedArch = archDigest.content;
      warnings.push({ code: "generator_fallback_architecture", message: "Used deterministic fallback architecture digest." });
    }

    const prdWrite = writeDocWithFallback({
      preferredAbsPath: path.join(projectRoot, ADE_DOC_PRD_REL),
      fallbackFileName: "PRD.ade.md",
      content: generatedPrd
    });
    const archWrite = writeDocWithFallback({
      preferredAbsPath: path.join(projectRoot, ADE_DOC_ARCH_REL),
      fallbackFileName: "ARCHITECTURE.ade.md",
      content: generatedArch
    });
    if (prdWrite.warning) {
      warnings.push({
        code: "write_fallback_prd",
        message: prdWrite.warning,
        actionLabel: "Open fallback PRD",
        actionPath: prdWrite.writtenPath
      });
    }
    if (archWrite.warning) {
      warnings.push({
        code: "write_fallback_architecture",
        message: archWrite.warning,
        actionLabel: "Open fallback architecture",
        actionPath: archWrite.writtenPath
      });
    }

    db.setJson(CONTEXT_DOC_LAST_RUN_KEY, {
      generatedAt,
      provider,
      prdPath: prdWrite.writtenPath,
      architecturePath: archWrite.writtenPath,
      warnings
    });

    return {
      provider,
      generatedAt,
      prdPath: prdWrite.writtenPath,
      architecturePath: archWrite.writtenPath,
      usedFallbackPath: prdWrite.usedFallback || archWrite.usedFallback,
      warnings,
      outputPreview: `${cmdResult.stdout}\n${cmdResult.stderr}`.trim().slice(0, 1500)
    };
  };

  const resolveContextDocPath = (docId: ContextDocStatus["id"]): string => {
    if (docId === "prd_ade") return path.join(projectRoot, ADE_DOC_PRD_REL);
    return path.join(projectRoot, ADE_DOC_ARCH_REL);
  };

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

  const readHostedGatewayMeta = (): { apiBaseUrl: string | null; remoteProjectId: string | null } => {
    const snapshot = projectConfigService.get();
    const localProviders = isRecord(snapshot.local.providers) ? snapshot.local.providers : {};
    const effectiveProviders = isRecord(snapshot.effective.providers) ? snapshot.effective.providers : {};
    const localHosted = isRecord(localProviders.hosted) ? localProviders.hosted : {};
    const effectiveHosted = isRecord(effectiveProviders.hosted) ? effectiveProviders.hosted : {};
    const hosted = { ...effectiveHosted, ...localHosted };

    const apiBaseUrl = asString(hosted.apiBaseUrl).trim() || null;
    const remoteProjectId = asString(hosted.remoteProjectId).trim() || null;
    return { apiBaseUrl, remoteProjectId };
  };

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
      status: string;
      tracked: number;
      startedAt: string;
      endedAt: string | null;
      exitCode: number | null;
      filesChanged: number | null;
      insertions: number | null;
      deletions: number | null;
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
          s.status as status,
          s.tracked as tracked,
          s.started_at as startedAt,
          s.ended_at as endedAt,
          s.exit_code as exitCode,
          d.files_changed as filesChanged,
          d.insertions as insertions,
          d.deletions as deletions
        from terminal_sessions s
        left join session_deltas d on d.session_id = s.id
        where s.lane_id = ?
        order by s.started_at desc
        limit 6
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
      for (const rel of parsePorcelainPaths(statusRes.stdout)) {
        if (!deltas.has(rel)) deltas.set(rel, { insertions: 0, deletions: 0 });
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
      const res = await runGit(["log", "--oneline", `${mergeBaseSha}..${headSha ?? "HEAD"}`, "-n", "12"], {
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
        .slice(0, 10)
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

    const sessionsRows = recentSessions.slice(0, 5).map((session) => {
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
      return {
        when: isoTime(session.startedAt),
        tool,
        goal: goal.length > 80 ? `${goal.slice(0, 79)}…` : goal,
        result,
        delta
      };
    });

    const sessionHighlights = (() => {
      const clean = (raw: string) => stripAnsi(raw).replace(/\s+/g, " ").trim();
      const clipSummary = (value: string) => {
        const normalized = clean(value);
        if (normalized.length <= 260) return { summary: normalized, clipped: false };
        return { summary: `${normalized.slice(0, 259)}…`, clipped: true };
      };

      const pickSummary = (s: { summary: string | null; lastOutputPreview: string | null; transcriptPath: string | null }) => {
        const fromSummary = clean(String(s.summary ?? "")).trim();
        if (fromSummary) {
          const clipped = clipSummary(fromSummary);
          return {
            summary: clipped.summary,
            summarySource: "session_summary",
            summaryConfidence: "high",
            summaryOmissionTags: clipped.clipped ? ["summary_clipped"] : []
          };
        }
        const fromPreview = clean(String(s.lastOutputPreview ?? ""));
        if (fromPreview) {
          const clipped = clipSummary(fromPreview);
          return {
            summary: clipped.summary,
            summarySource: "preview_tail",
            summaryConfidence: "medium",
            summaryOmissionTags: clipped.clipped ? ["summary_clipped"] : []
          };
        }
        const transcriptTail = getTranscriptTail(s.transcriptPath);
        const parsed = parseTranscriptSummary(transcriptTail);
        if (!parsed) return null;
        const clipped = clipSummary(parsed.summary);
        return {
          summary: clipped.summary,
          summarySource: parsed.source,
          summaryConfidence: parsed.confidence,
          summaryOmissionTags: clipped.clipped ? [...parsed.omissionTags, "summary_clipped"] : parsed.omissionTags
        };
      };

      const out: Array<{
        when: string;
        tool: string;
        summary: string;
        summarySource: string;
        summaryConfidence: string;
        summaryOmissionTags: string[];
      }> = [];
      for (const s of recentSessions) {
        if (!s.endedAt) continue;
        const picked = pickSummary(s);
        if (!picked || !picked.summary.trim()) continue;
        out.push({
          when: isoTime(s.startedAt),
          tool: humanToolLabel(s.toolType),
          summary: picked.summary,
          summarySource: picked.summarySource,
          summaryConfidence: picked.summaryConfidence,
          summaryOmissionTags: picked.summaryOmissionTags
        });
      }
      return out.slice(0, 3);
    })();

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

    const narrativePlaceholder =
      providerMode === "guest"
        ? "AI narrative is disabled in Guest Mode. Switch to Hosted or BYOK in Settings to generate."
        : "AI narrative not yet generated. Click 'Update pack details with AI' to generate.";

    const narrativeFromMarkers = extractSection(existingBody, ADE_NARRATIVE_START, ADE_NARRATIVE_END, "");
    const legacyNarrative = narrativeFromMarkers.trim().length
      ? narrativeFromMarkers
      : extractSectionByHeading(existingBody, "## Narrative") ?? "";
    const narrative = legacyNarrative.trim().length ? legacyNarrative.trim() : narrativePlaceholder;

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
      sessionsRows,
      sessionHighlights,
      sessionsTotal: Number.isFinite(sessionsTotal) ? sessionsTotal : 0,
      sessionsRunning: Number.isFinite(sessionsRunning) ? sessionsRunning : 0,
      nextSteps,
      userTodosMarkers: { start: ADE_TODOS_START, end: ADE_TODOS_END },
      userTodos,
      narrativeMarkers: { start: ADE_NARRATIVE_START, end: ADE_NARRATIVE_END },
      narrative
    });

    return { body, lastHeadSha: headSha };
  };

  const buildProjectBootstrap = async (args: { lanes: LaneSummary[] }): Promise<string> => {
    const lanes = args.lanes;
    const primary = lanes.find((lane) => lane.laneType === "primary") ?? null;
    const historyRef = primary?.branchRef || primary?.baseRef || "HEAD";

    const topLevelEntries = (() => {
      try {
        return fs
          .readdirSync(projectRoot, { withFileTypes: true })
          .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
          .slice(0, 40)
          .map((entry) => `${entry.isDirectory() ? "dir" : "file"}: ${entry.name}`);
      } catch {
        return [];
      }
    })();

    const pickDocs = (): string[] => {
      const out: string[] = [];
      const push = (rel: string) => {
        const normalized = rel.replace(/\\/g, "/");
        if (out.includes(normalized)) return;
        const abs = path.join(projectRoot, normalized);
        try {
          if (fs.statSync(abs).isFile()) out.push(normalized);
        } catch {
          // ignore
        }
      };

      // Common docs that seed useful project context quickly.
      push("README.md");
      push("docs/README.md");
      push(ADE_DOC_PRD_REL);
      push(ADE_DOC_ARCH_REL);
      push("docs/PRD.md");
      push("docs/architecture/SYSTEM_OVERVIEW.md");
      push("docs/architecture/DESKTOP_APP.md");
      push("docs/architecture/HOSTED_AGENT.md");
      push("docs/features/LANES.md");
      push("docs/features/PACKS.md");
      push("docs/features/ONBOARDING_AND_SETTINGS.md");

      const addDir = (relDir: string, limit: number) => {
        const absDir = path.join(projectRoot, relDir);
        try {
          const entries = fs
            .readdirSync(absDir)
            .filter((name) => name.endsWith(".md"))
            .slice(0, limit);
          for (const name of entries) push(path.posix.join(relDir.replace(/\\/g, "/"), name));
        } catch {
          // ignore
        }
      };

      addDir("docs/architecture", 6);
      addDir("docs/features", 6);
      addDir("docs/guides", 4);

      return out.slice(0, 14);
    };

    const excerptDoc = (rel: string): { rel: string; title: string; blurb: string } | null => {
      const abs = path.join(projectRoot, rel);
      try {
        const fd = fs.openSync(abs, "r");
        try {
          const MAX = 48_000;
          const buf = Buffer.alloc(MAX);
          const read = fs.readSync(fd, buf, 0, MAX, 0);
          const raw = buf.slice(0, Math.max(0, read)).toString("utf8");
          const lines = raw.split(/\r?\n/);
          const titleLine = lines.find((line) => line.trim().startsWith("# "));
          const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : path.basename(rel);
          const blurbLines: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("#")) continue;
            if (/^table of contents/i.test(trimmed)) continue;
            if (trimmed.startsWith("---")) continue;
            blurbLines.push(trimmed);
            if (blurbLines.join(" ").length > 220) break;
          }
          const blurb = blurbLines.slice(0, 2).join(" ");
          return { rel, title, blurb };
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return null;
      }
    };

    const historyLines = await (async (): Promise<string[]> => {
      const res = await runGit(["log", historyRef, "-n", "18", "--date=short", "--pretty=format:%h %ad %s"], {
        cwd: projectRoot,
        timeoutMs: 12_000
      });
      if (res.exitCode !== 0) return [];
      return res.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    })();

    const lines: string[] = [];
    lines.push("## Bootstrap context (codebase + docs)");
    lines.push("");
    lines.push("### Repo map (top level)");
    if (topLevelEntries.length) {
      for (const entry of topLevelEntries) lines.push(`- ${entry}`);
    } else {
      lines.push("- (unavailable)");
    }
    lines.push("");

    lines.push("### Docs index");
    const docs = pickDocs().map(excerptDoc).filter(Boolean) as Array<{ rel: string; title: string; blurb: string }>;
    if (docs.length) {
      for (const doc of docs) {
        lines.push(`- ${doc.rel}: ${doc.title}`);
        if (doc.blurb) lines.push(`  - ${doc.blurb}`);
      }
    } else {
      lines.push("- no docs found");
    }
    lines.push("");

    lines.push(`### Git history seed (${historyRef})`);
    if (historyLines.length) {
      for (const entry of historyLines) lines.push(`- ${entry}`);
    } else {
      lines.push("- (no git history available)");
    }
    lines.push("");

    return `${lines.join("\n")}\n`;
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
    const docsMeta = readContextDocMeta();
    const existingBootstrapRaw = readFileIfExists(projectBootstrapPath);
    const existingFingerprint = (() => {
      const m = existingBootstrapRaw.match(BOOTSTRAP_FINGERPRINT_RE);
      return m?.[1]?.toLowerCase() ?? null;
    })();

    const shouldBootstrap =
      reason === "onboarding_init" ||
      !fs.existsSync(projectBootstrapPath) ||
      existingFingerprint !== docsMeta.contextFingerprint;
    if (shouldBootstrap) {
      try {
        const bootstrap = await buildProjectBootstrap({ lanes });
        ensureDirFor(projectBootstrapPath);
        const withMeta = [
          `<!-- ADE_DOCS_FINGERPRINT:${docsMeta.contextFingerprint} -->`,
          `<!-- ADE_CONTEXT_VERSION:${docsMeta.contextVersion} -->`,
          `<!-- ADE_LAST_DOCS_REFRESH_AT:${docsMeta.lastDocsRefreshAt ?? ""} -->`,
          bootstrap
        ].join("\n");
        fs.writeFileSync(projectBootstrapPath, withMeta, "utf8");
      } catch (error) {
        // Don't fail pack refresh on bootstrap scan errors; emit minimal context instead.
        logger.warn("packs.project_bootstrap_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const bootstrapBody = readFileIfExists(projectBootstrapPath)
      .replace(BOOTSTRAP_FINGERPRINT_RE, "")
      .replace(/<!--\s*ADE_CONTEXT_VERSION:[^>]+-->/gi, "")
      .replace(/<!--\s*ADE_LAST_DOCS_REFRESH_AT:[^>]*-->/gi, "")
      .trim();

    const lines: string[] = [];
    lines.push("# Project Pack");
    lines.push("");
    lines.push(`Deterministic updated: ${deterministicUpdatedAt}`);
    lines.push(`Trigger: ${reason}`);
    if (sourceLaneId) lines.push(`Source lane: ${sourceLaneId}`);
    lines.push(`Active lanes: ${lanes.length}`);
    lines.push(`Context fingerprint: ${docsMeta.contextFingerprint}`);
    lines.push(`Context version: ${docsMeta.contextVersion}`);
    lines.push(`Last docs refresh at: ${docsMeta.lastDocsRefreshAt ?? "unknown"}`);
    if (docsMeta.docsStaleReason) lines.push(`Docs stale reason: ${docsMeta.docsStaleReason}`);
    lines.push("");

    if (bootstrapBody) {
      lines.push(bootstrapBody);
    } else {
      lines.push("## Bootstrap context");
      lines.push("- Bootstrap scan not generated yet.");
      lines.push("- Run Onboarding → Generate Initial Packs, or refresh the Project pack once after onboarding.");
      lines.push("");
    }

    lines.push("## How To Run (Processes)");
    if (config.processes.length) {
      for (const proc of config.processes) {
        const cmd = formatCommand(proc.command);
        const cwd = proc.cwd && proc.cwd !== "." ? ` (cwd=${proc.cwd})` : "";
        lines.push(`- ${proc.name}: ${cmd}${cwd}`);
      }
    } else {
      lines.push("- no managed process definitions");
    }
    lines.push("");

    lines.push("## How To Test (Test Suites)");
    if (config.testSuites.length) {
      for (const suite of config.testSuites) {
        const cmd = formatCommand(suite.command);
        const cwd = suite.cwd && suite.cwd !== "." ? ` (cwd=${suite.cwd})` : "";
        lines.push(`- ${suite.name}: ${cmd}${cwd}`);
      }
    } else {
      lines.push("- no test suites configured");
    }
    lines.push("");

    lines.push("## Stack Buttons");
    if (config.stackButtons.length) {
      for (const stack of config.stackButtons) {
        lines.push(`- ${stack.name}: ${stack.processIds.join(", ")}`);
      }
    } else {
      lines.push("- no stack buttons configured");
    }
    lines.push("");

    lines.push("## Lane Snapshot");
    if (lanes.length) {
      for (const lane of lanes) {
        const dirty = lane.status.dirty ? "dirty" : "clean";
        const stack = lane.parentLaneId ? "stacked" : lane.laneType === "primary" ? "primary" : "root";
        lines.push(`- ${lane.name}: ${dirty} · ahead ${lane.status.ahead} · behind ${lane.status.behind} · ${stack}`);
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

  type ConflictPredictionPackFile = {
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

  const readConflictPredictionPack = (laneId: string): ConflictPredictionPackFile | null => {
    const candidates = [getConflictPredictionPath(laneId), getLegacyConflictPredictionPath(laneId)];
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
  };

  const readGitConflictState = async (laneId: string): Promise<GitConflictState | null> => {
    const lane = laneService.getLaneBaseAndBranch(laneId);
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
  };

  const deriveConflictStateForLane = (laneId: string): PackConflictStateV1 | null => {
    const pack = readConflictPredictionPack(laneId);
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
  };

  const computeLaneLineage = (args: { laneId: string; lanesById: Map<string, LaneSummary> }): LaneLineageV1 => {
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
  };

  const buildLaneConflictRiskSummaryLines = (laneId: string): string[] => {
    const pack = readConflictPredictionPack(laneId);
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
      const strategy = asString(pack.strategy).trim() || "partial";
      const computed = Number(pack.pairwisePairsComputed ?? NaN);
      const total = Number(pack.pairwisePairsTotal ?? NaN);
      if (Number.isFinite(computed) && Number.isFinite(total) && total > 0) {
        lines.push(`- Pairwise coverage: ${computed}/${total} pairs (strategy=\`${strategy}\`)`);
      } else {
        lines.push(`- Pairwise coverage: partial (strategy=\`${strategy}\`)`);
      }
    }

    return lines;
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
      const intent = extractSection(lanePackBody, ADE_INTENT_START, ADE_INTENT_END, "");
      const todos = extractSection(lanePackBody, ADE_TODOS_START, ADE_TODOS_END, "");

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

    getContextStatus(): ContextStatus {
      return readContextStatus();
    },

    generateContextDocs(args: ContextGenerateDocsArgs): ContextGenerateDocsResult {
      return runContextDocGeneration(args);
    },

    getContextDocPath(docId: ContextDocStatus["id"]): string {
      return resolveContextDocPath(docId);
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
      const failureLines = (() => {
        const out: string[] = [];
        const seen = new Set<string>();
        for (const rawLine of transcript.split("\n")) {
          const line = stripAnsi(rawLine).trim();
          if (!line) continue;
          if (!/\b(error|failed|exception|fatal|traceback)\b/i.test(line)) continue;
          // Collapse duplicates and near-duplicates (e.g. repeated prompts).
          const key = line.replace(/\s+/g, " ");
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(key);
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
            operationId: op.operationId,
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

        const metadata = {
          reason: args.reason,
          sessionId: args.sessionId ?? null,
          latestDeltaSessionId: latestDelta?.sessionId ?? null,
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash
        };

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
          metadata
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
          metadata,
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
            operationId: op.operationId,
            trigger: args.reason,
            laneId: args.laneId ?? null
          }
        });

        const version = createPackVersion({ packKey, packType: "project", body });

        const metadata = {
          ...readContextDocMeta(),
          reason: args.reason,
          sourceLaneId: args.laneId ?? null,
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash
        };

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
          metadata
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
          metadata,
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
      const { updated: updatedBody, insertedMarkers } = replaceNarrativeSection(existing, args.narrative);
      ensureDirFor(row.pack_path);
      fs.writeFileSync(row.pack_path, updatedBody, "utf8");

      const now = nowIso();
      createPackEvent({
        packKey,
        eventType: "narrative_update",
        payload: {
          source: args.source ?? "user",
          insertedMarkers
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
      const packType = getPackIndexRow(packKey)?.pack_type ?? (packKey.startsWith("lane:") ? "lane" : "project");
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

      const pack = this.getLanePack(laneId);
      if (!pack.exists || !pack.body.trim().length) {
        throw new Error("Lane pack is empty. Refresh deterministic packs first.");
      }

      const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
      const { apiBaseUrl, remoteProjectId } = readHostedGatewayMeta();
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

      const packRefreshAt = pack.deterministicUpdatedAt ?? null;
      const packRefreshAgeMs = (() => {
        if (!packRefreshAt) return null;
        const ts = Date.parse(packRefreshAt);
        if (!Number.isFinite(ts)) return null;
        return Math.max(0, Date.now() - ts);
      })();

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
          lastPackRefreshAt: packRefreshAt,
          isEditProtected: lane.isEditProtected,
          packStale: packRefreshAgeMs != null ? packRefreshAgeMs > 10 * 60_000 : null,
          ...(packRefreshAgeMs != null && packRefreshAgeMs > 10 * 60_000 ? { packStaleReason: `lastPackRefreshAgeMs=${packRefreshAgeMs}` } : {})
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
        }
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
      const pack = this.getProjectPack();
      const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
      const { apiBaseUrl, remoteProjectId } = readHostedGatewayMeta();
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

        const packRow = getPackIndexRow(`lane:${lane.id}`);
        const packRefreshAt = packRow?.deterministic_updated_at ?? null;
        const packRefreshAgeMs = (() => {
          if (!packRefreshAt) return null;
          const ts = Date.parse(packRefreshAt);
          if (!Number.isFinite(ts)) return null;
          return Math.max(0, Date.now() - ts);
        })();

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
            lastPackRefreshAt: packRefreshAt,
            isEditProtected: lane.isEditProtected,
            packStale: packRefreshAgeMs != null ? packRefreshAgeMs > 10 * 60_000 : null,
            ...(packRefreshAgeMs != null && packRefreshAgeMs > 10 * 60_000 ? { packStaleReason: `lastPackRefreshAgeMs=${packRefreshAgeMs}` } : {})
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

      const pack = this.getConflictPack({ laneId, peerLaneId });
      const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
      const { apiBaseUrl, remoteProjectId } = readHostedGatewayMeta();

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

      const { updated: updatedBody, insertedMarkers } = replaceNarrativeSection(existing, args.narrative);
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
          insertedMarkers,
          ...(args.metadata ?? {})
        }
      });

      const version = createPackVersion({ packKey, packType: "lane", body: updatedBody });

      const metadata = {
        source: "hosted",
        ...(args.metadata ?? {}),
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        contentHash: version.contentHash
      };

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
        metadata
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
        metadata,
        body: updatedBody
      };
    },

    recordEvent(args: { packKey: string; eventType: string; payload?: Record<string, unknown> }): PackEvent {
      return createPackEvent(args);
    }
  };
}
