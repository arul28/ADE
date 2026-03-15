/**
 * Project pack builder — generates the project-level context pack and
 * bootstrap scan. Also handles ADE context document generation and status reading.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import { extractFirstJsonObject } from "../ai/utils";
import { readDocPaths } from "../orchestrator/stepPolicyResolver";
import type {
  ContextDocStatus,
  ContextGenerateDocsArgs,
  ContextGenerateDocsResult,
  ContextStatus,
  LaneSummary
} from "../../../shared/types";
import { nowIso } from "../shared/utils";
import {
  ensureDirFor,
  formatCommand,
  isRecord,
  asString,
  readFileIfExists
} from "./packUtils";

// ── Constants ────────────────────────────────────────────────────────────────

const CONTEXT_VERSION = 1;
const BOOTSTRAP_FINGERPRINT_RE = /<!--\s*ADE_DOCS_FINGERPRINT:([a-f0-9]{64})\s*-->/i;
const ADE_DOC_PRD_REL = ".ade/context/PRD.ade.md";
const ADE_DOC_ARCH_REL = ".ade/context/ARCHITECTURE.ade.md";
const CONTEXT_DOC_LAST_RUN_KEY = "context:docs:lastRun.v1";
const CONTEXT_CLIP_TAG = "omitted_due_size";
const DOC_TEXT_EXT_RE = /\.(md|mdx|txt|rst)$/i;
const DOC_CONTEXT_EXT_RE = /\.(md|mdx|txt|rst|yaml|yml|json)$/i;
const DOC_PRD_HINT_RE = /(prd|product|roadmap|feature|requirement|spec|user-story|planning)/i;
const DOC_ARCH_HINT_RE = /(architecture|system|design|technical|infra|platform|lanes|conflict|pack)/i;
const DOC_GUIDE_HINT_RE = /(readme|guide|overview|context|contributing|claude|agents)/i;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type ProjectPackBuilderDeps = {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  projectId: string;
  packsDir: string;
  laneService: ReturnType<typeof createLaneService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
};

// ── Internal helpers ─────────────────────────────────────────────────────────

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

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
  projectRoot: string;
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
    const abs = path.join(args.projectRoot, rel);
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

const writeDocWithFallback = (args: {
  preferredAbsPath: string;
  fallbackFileName: string;
  content: string;
  fallbackRoot: string;
}): { writtenPath: string; usedFallback: boolean; warning: string | null } => {
  try {
    ensureDirFor(args.preferredAbsPath);
    fs.writeFileSync(args.preferredAbsPath, args.content, "utf8");
    return { writtenPath: args.preferredAbsPath, usedFallback: false, warning: null };
  } catch (error) {
    const ts = nowTimestampSegment();
    const fallbackDir = path.join(args.fallbackRoot, ts);
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

// ── Exported helpers used by packService.ts ──────────────────────────────────

export function collectContextDocPaths(projectRoot: string): string[] {
  const out = new Set<string>([ADE_DOC_PRD_REL, ADE_DOC_ARCH_REL]);
  for (const absPath of readDocPaths(projectRoot)) {
    const rel = path.relative(projectRoot, absPath).replace(/\\/g, "/");
    if (!rel.length || rel.startsWith("..")) continue;
    if (!DOC_CONTEXT_EXT_RE.test(rel)) continue;
    out.add(rel);
  }
  return [...out]
    .sort((a, b) => a.localeCompare(b))
    .sort((a, b) => {
      const aAde = a.endsWith(".ade.md") ? 0 : 1;
      const bAde = b.endsWith(".ade.md") ? 0 : 1;
      return aAde - bAde;
    });
}

function scoreDocPath(relPath: string): number {
  const rel = relPath.replace(/\\/g, "/");
  const base = path.posix.basename(rel).toLowerCase();
  let score = 0;
  if (rel.startsWith(".ade/context/")) score += 120;
  if (base === "readme.md" || base === "readme.mdx") score += 80;
  if (DOC_PRD_HINT_RE.test(rel)) score += 55;
  if (DOC_ARCH_HINT_RE.test(rel)) score += 50;
  if (DOC_GUIDE_HINT_RE.test(rel)) score += 25;
  if (rel.toLowerCase().includes("/docs/")) score += 12;
  score += Math.max(0, 35 - Math.floor(rel.length / 5));
  return score;
}

function rankDocPathsByRelevance(paths: string[]): string[] {
  return [...paths].sort((left, right) => {
    const scoreDiff = scoreDocPath(right) - scoreDocPath(left);
    if (scoreDiff !== 0) return scoreDiff;
    return left.localeCompare(right);
  });
}

export function readContextDocMeta(projectRoot: string): {
  contextFingerprint: string;
  contextVersion: number;
  lastDocsRefreshAt: string | null;
  docsStaleReason: string | null;
} {
  const paths = collectContextDocPaths(projectRoot);
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
}

export function readContextStatus(deps: {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  packsDir: string;
}): ContextStatus {
  const FALLBACK_GENERATED_ROOT = path.join(path.dirname(deps.packsDir), "context", "generated");

  const collectCanonicalContextDocPaths = (): string[] =>
    collectContextDocPaths(deps.projectRoot).filter((rel) => !rel.endsWith(".ade.md"));

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
        const st = fs.statSync(path.join(deps.projectRoot, rel));
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
    const absPath = path.join(deps.projectRoot, args.relPath);
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

  const canonical = readCanonicalDocMeta();
  const fallbackCount = countFallbackWrites();
  const latestRunRaw = deps.db.getJson<{
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

  const projectPackIndex = deps.db.get<{ metadata_json: string | null; deterministic_updated_at: string | null }>(
    `
      select metadata_json, deterministic_updated_at
      from packs_index
      where project_id = ?
        and pack_key = 'project'
      limit 1
    `,
    [deps.projectId]
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
    deps.db.get<{ count: number }>(
      `
        select count(1) as count
        from conflict_proposals
        where project_id = ?
          and metadata_json like '%"insufficientContext":true%'
      `,
      [deps.projectId]
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
    warnings: latestWarnings,
    generation: {
      state: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
    },
  };
}

export async function runContextDocGeneration(
  deps: ProjectPackBuilderDeps,
  args: ContextGenerateDocsArgs
): Promise<ContextGenerateDocsResult> {
  const FALLBACK_GENERATED_ROOT = path.join(path.dirname(deps.packsDir), "context", "generated");
  const provider = args.provider ?? "unified";
  const trigger = args.trigger ?? "manual";
  const modelId = typeof args.modelId === "string" && args.modelId.trim().length > 0 ? args.modelId.trim() : null;
  const reasoningEffort =
    typeof args.reasoningEffort === "string" && args.reasoningEffort.trim().length > 0
      ? args.reasoningEffort.trim()
      : null;
  const providerHint = provider === "codex" || provider === "claude" ? provider : undefined;
  const generatedAt = nowIso();
  const warnings: ContextGenerateDocsResult["warnings"] = [];
  const canonicalPaths = collectContextDocPaths(deps.projectRoot).filter((rel) => !rel.endsWith(".ade.md"));

  const rankedCanonicalPaths = rankDocPathsByRelevance(canonicalPaths);
  const prdSources = canonicalPaths.filter((rel) => DOC_PRD_HINT_RE.test(rel) || DOC_GUIDE_HINT_RE.test(rel));
  const archSources = canonicalPaths.filter((rel) => DOC_ARCH_HINT_RE.test(rel));

  const prdDigest = formatDocDigest({
    title: "PRD.ade",
    sources: prdSources.length > 0 ? prdSources : rankedCanonicalPaths.slice(0, 20),
    maxChars: 18_000,
    projectRoot: deps.projectRoot
  });
  const archDigest = formatDocDigest({
    title: "ARCHITECTURE.ade",
    sources: archSources.length > 0 ? archSources : rankedCanonicalPaths.slice(0, 20),
    maxChars: 20_000,
    projectRoot: deps.projectRoot
  });
  for (const warning of [...prdDigest.warnings, ...archDigest.warnings]) {
    warnings.push({ code: "omitted_due_size", message: warning });
  }

  const prompt = [
    "Generate two COMPLETE markdown documents from the provided repository context digest.",
    "These are canonical context docs. Rewrite them to match the CURRENT repository state (no changelog, no delta section, no historical timeline).",
    "Return ONLY one JSON object with this exact shape:",
    '{"prd":"<markdown>","architecture":"<markdown>"}',
    "Do not include markdown fences or prose outside JSON.",
    "",
    "PRD source digest:",
    prdDigest.content,
    "",
    "Architecture source digest:",
    archDigest.content
  ].join("\n");

  let generatedPrd = "";
  let generatedArch = "";
  let outputPreview = "";
  if (!deps.aiIntegrationService || deps.aiIntegrationService.getMode() === "guest") {
    warnings.push({
      code: "generator_failed",
      message: `provider=${provider} ai_unavailable`
    });
  } else {
    try {
      const aiResult = await deps.aiIntegrationService.generateInitialContext({
        cwd: deps.projectRoot,
        ...(providerHint ? { provider: providerHint } : {}),
        prompt,
        timeoutMs: 120_000,
        ...(modelId ? { model: modelId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        jsonSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            prd: { type: "string" },
            architecture: { type: "string" }
          },
          required: ["prd", "architecture"]
        }
      });

      outputPreview = aiResult.text.trim().slice(0, 1_500);
      const structured = isRecord(aiResult.structuredOutput) ? aiResult.structuredOutput : null;
      if (structured) {
        generatedPrd = asString(structured.prd).trim();
        generatedArch = asString(structured.architecture).trim();
      }
      if (!generatedPrd || !generatedArch) {
        const rawJson = extractFirstJsonObject(aiResult.text);
        if (rawJson) {
          try {
            const parsed = JSON.parse(rawJson);
            if (isRecord(parsed)) {
              if (!generatedPrd) generatedPrd = asString(parsed.prd).trim();
              if (!generatedArch) generatedArch = asString(parsed.architecture).trim();
            }
          } catch {
            // fall through to deterministic fallback below.
          }
        }
      }
    } catch (error) {
      warnings.push({
        code: "generator_failed",
        message: `provider=${provider}${modelId ? ` model=${modelId}` : ""} error=${error instanceof Error ? error.message : String(error)}`
      });
    }
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
    preferredAbsPath: path.join(deps.projectRoot, ADE_DOC_PRD_REL),
    fallbackFileName: "PRD.ade.md",
    content: generatedPrd,
    fallbackRoot: FALLBACK_GENERATED_ROOT
  });
  const archWrite = writeDocWithFallback({
    preferredAbsPath: path.join(deps.projectRoot, ADE_DOC_ARCH_REL),
    fallbackFileName: "ARCHITECTURE.ade.md",
    content: generatedArch,
    fallbackRoot: FALLBACK_GENERATED_ROOT
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

  deps.db.setJson(CONTEXT_DOC_LAST_RUN_KEY, {
    generatedAt,
    provider,
    trigger,
    modelId,
    reasoningEffort,
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
    outputPreview
  };
}

export function resolveContextDocPath(projectRoot: string, docId: ContextDocStatus["id"]): string {
  if (docId === "prd_ade") return path.join(projectRoot, ADE_DOC_PRD_REL);
  return path.join(projectRoot, ADE_DOC_ARCH_REL);
}

export async function buildProjectBootstrap(deps: ProjectPackBuilderDeps, args: { lanes: LaneSummary[] }): Promise<string> {
  const lanes = args.lanes;
  const primary = lanes.find((lane) => lane.laneType === "primary") ?? null;
  const historyRef = primary?.branchRef || primary?.baseRef || "HEAD";

  const topLevelEntries = (() => {
    try {
      return fs
        .readdirSync(deps.projectRoot, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
        .slice(0, 40)
        .map((entry) => `${entry.isDirectory() ? "dir" : "file"}: ${entry.name}`);
    } catch {
      return [];
    }
  })();

  const pickDocs = (): string[] => {
    const candidates = collectContextDocPaths(deps.projectRoot)
      .filter((rel) => DOC_TEXT_EXT_RE.test(rel))
      .filter((rel) => {
        const abs = path.join(deps.projectRoot, rel);
        try {
          return fs.statSync(abs).isFile();
        } catch {
          return false;
        }
      });
    return rankDocPathsByRelevance(candidates).slice(0, 14);
  };

  const excerptDoc = (rel: string): { rel: string; title: string; blurb: string } | null => {
    const abs = path.join(deps.projectRoot, rel);
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
      cwd: deps.projectRoot,
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
}

export async function buildProjectPackBody(
  deps: ProjectPackBuilderDeps,
  args: {
    reason: string;
    deterministicUpdatedAt: string;
    sourceLaneId?: string;
  }
): Promise<string> {
  const projectBootstrapPath = path.join(deps.packsDir, "_bootstrap", "project_bootstrap.md");
  const config = deps.projectConfigService.get().effective;
  const lanes = await deps.laneService.list({ includeArchived: false });
  const docsMeta = readContextDocMeta(deps.projectRoot);
  const existingBootstrapRaw = readFileIfExists(projectBootstrapPath);
  const existingFingerprint = (() => {
    const m = existingBootstrapRaw.match(BOOTSTRAP_FINGERPRINT_RE);
    return m?.[1]?.toLowerCase() ?? null;
  })();

  const shouldBootstrap =
    args.reason === "onboarding_init" ||
    !fs.existsSync(projectBootstrapPath) ||
    existingFingerprint !== docsMeta.contextFingerprint;
  if (shouldBootstrap) {
    try {
      const bootstrap = await buildProjectBootstrap(deps, { lanes });
      ensureDirFor(projectBootstrapPath);
      const withMeta = [
        `<!-- ADE_DOCS_FINGERPRINT:${docsMeta.contextFingerprint} -->`,
        `<!-- ADE_CONTEXT_VERSION:${docsMeta.contextVersion} -->`,
        `<!-- ADE_LAST_DOCS_REFRESH_AT:${docsMeta.lastDocsRefreshAt ?? ""} -->`,
        bootstrap
      ].join("\n");
      fs.writeFileSync(projectBootstrapPath, withMeta, "utf8");
    } catch (error) {
      deps.logger.warn("packs.project_bootstrap_failed", {
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
  lines.push(`Deterministic updated: ${args.deterministicUpdatedAt}`);
  lines.push(`Trigger: ${args.reason}`);
  if (args.sourceLaneId) lines.push(`Source lane: ${args.sourceLaneId}`);
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
    lines.push("- Run Onboarding -> Generate Initial Packs, or refresh the Project pack once after onboarding.");
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
    lines.push("- Narrative sections are AI-assisted when subscription providers are configured and available.");
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}
