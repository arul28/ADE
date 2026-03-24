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
} from "../shared/packLegacyUtils";

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

// ── Codebase snapshot builder (deterministic, no AI) ─────────────────────────

const MANIFEST_NAMES = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile", "build.gradle", "pom.xml"];
const ENTRY_POINT_NAMES = [
  "main.ts", "index.ts", "app.ts", "server.ts",
  "main.tsx", "index.tsx", "app.tsx",
  "main.go", "main.rs", "lib.rs",
  "main.py", "app.py", "manage.py", "__main__.py",
];
const ENTRY_SEARCH_DIRS = ["", "src", "cmd", "lib", "app"];
const DEEP_SCAN_DIRS = ["src", "lib", "apps", "packages"];
const KEY_DOC_NAMES = ["README.md", "CLAUDE.md", "AGENTS.md"];
const TECH_INDICATORS: Array<[string, string]> = [
  ["package.json", "Node.js"],
  ["tsconfig.json", "TypeScript"],
  ["Cargo.toml", "Rust"],
  ["go.mod", "Go"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  [".python-version", "Python"],
  ["Gemfile", "Ruby"],
  ["build.gradle", "Java/Kotlin (Gradle)"],
  ["pom.xml", "Java (Maven)"],
  ["docker-compose.yml", "Docker Compose"],
  ["docker-compose.yaml", "Docker Compose"],
  ["Dockerfile", "Docker"],
  [".github/workflows", "GitHub Actions CI"],
  [".gitlab-ci.yml", "GitLab CI"],
  ["Makefile", "Make"],
  ["next.config.js", "Next.js"],
  ["next.config.ts", "Next.js"],
  ["vite.config.ts", "Vite"],
  ["vite.config.js", "Vite"],
  ["tailwind.config.ts", "Tailwind CSS"],
  ["tailwind.config.js", "Tailwind CSS"],
  ["prisma/schema.prisma", "Prisma ORM"],
  ["electron-builder.yml", "Electron"],
  ["forge.config.ts", "Electron Forge"],
];

function buildCodebaseSnapshot(projectRoot: string): string {
  const lines: string[] = [];
  const MAX_SNAPSHOT_CHARS = 8000;

  // 1. Directory tree — top-level + 2 levels into deep-scan dirs
  lines.push("## Directory tree");
  const topEntries: string[] = [];
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "__pycache__")
      .slice(0, 60);
    for (const entry of entries) {
      const prefix = entry.isDirectory() ? "dir" : "file";
      topEntries.push(`- ${prefix}: ${entry.name}`);
    }
  } catch { /* skip */ }

  const deepEntries: string[] = [];
  for (const dir of DEEP_SCAN_DIRS) {
    const absDir = path.join(projectRoot, dir);
    try {
      if (!fs.statSync(absDir).isDirectory()) continue;
    } catch { continue; }
    const walk = (base: string, depth: number) => {
      if (depth > 2 || deepEntries.length >= 120) return;
      try {
        const entries = fs.readdirSync(base, { withFileTypes: true })
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "__pycache__");
        for (const entry of entries) {
          if (deepEntries.length >= 120) return;
          const rel = path.relative(projectRoot, path.join(base, entry.name));
          const prefix = entry.isDirectory() ? "dir" : "file";
          deepEntries.push(`- ${prefix}: ${rel}`);
          if (entry.isDirectory()) walk(path.join(base, entry.name), depth + 1);
        }
      } catch { /* skip */ }
    };
    walk(absDir, 0);
  }

  const allTreeEntries = [...topEntries, ...deepEntries].slice(0, 150);
  for (const entry of allTreeEntries) lines.push(entry);
  lines.push("");

  // 2. Package manifest — first 60 lines
  for (const manifest of MANIFEST_NAMES) {
    const abs = path.join(projectRoot, manifest);
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch { continue; }
    const read = safeReadDoc(abs, 8_000);
    if (!read.text.trim()) continue;
    const manifestLines = read.text.split("\n").slice(0, 60);
    lines.push(`## Package manifest (${manifest})`);
    for (const line of manifestLines) lines.push(line);
    if (read.truncated || manifestLines.length >= 60) lines.push("...(truncated)");
    lines.push("");
    break; // only first manifest found
  }

  // 3. Tech stack signals
  const detected: string[] = [];
  for (const [indicator, label] of TECH_INDICATORS) {
    try {
      const abs = path.join(projectRoot, indicator);
      if (fs.existsSync(abs)) {
        if (!detected.includes(label)) detected.push(label);
      }
    } catch { /* skip */ }
  }
  if (detected.length) {
    lines.push("## Tech stack signals");
    for (const tech of detected) lines.push(`- ${tech}`);
    lines.push("");
  }

  // 4. Entry point headers — first 25 lines of up to 4 files
  const foundEntryPoints: string[] = [];
  for (const dir of ENTRY_SEARCH_DIRS) {
    if (foundEntryPoints.length >= 4) break;
    for (const name of ENTRY_POINT_NAMES) {
      if (foundEntryPoints.length >= 4) break;
      const rel = dir ? path.join(dir, name) : name;
      const abs = path.join(projectRoot, rel);
      try {
        if (!fs.statSync(abs).isFile()) continue;
      } catch { continue; }
      if (foundEntryPoints.includes(rel)) continue;
      foundEntryPoints.push(rel);
      const read = safeReadDoc(abs, 4_000);
      if (!read.text.trim()) continue;
      const headerLines = read.text.split("\n").slice(0, 25);
      lines.push(`## Entry point: ${rel}`);
      for (const line of headerLines) lines.push(line);
      lines.push("...");
      lines.push("");
    }
  }

  // 5. Key doc excerpts — first 30 lines of README, CLAUDE.md, AGENTS.md
  let docCount = 0;
  for (const docName of KEY_DOC_NAMES) {
    if (docCount >= 3) break;
    const abs = path.join(projectRoot, docName);
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch { continue; }
    const read = safeReadDoc(abs, 6_000);
    if (!read.text.trim()) continue;
    docCount++;
    const docLines = read.text.split("\n").slice(0, 30);
    lines.push(`## Doc excerpt: ${docName}`);
    for (const line of docLines) lines.push(line);
    if (read.truncated || docLines.length >= 30) lines.push("...(truncated)");
    lines.push("");
  }

  // 6. Git log — last 10 commits oneline
  // (git log is async via runGit, so we skip it here since this fn is sync;
  //  the caller will append git log separately)

  // Trim to max snapshot size
  let snapshot = lines.join("\n");
  if (snapshot.length > MAX_SNAPSHOT_CHARS) {
    snapshot = snapshot.slice(0, MAX_SNAPSHOT_CHARS - 20) + "\n...(snapshot truncated)";
  }
  return snapshot;
}

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
      requestedAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      source: null,
      event: null,
      reason: null,
      provider: null,
      modelId: null,
      reasoningEffort: null,
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

  // 1. Build deterministic codebase snapshot from actual code
  let snapshot = buildCodebaseSnapshot(deps.projectRoot);

  // Append git log (async) — last 10 commits
  try {
    const gitLogResult = await runGit(
      ["log", "--oneline", "-n", "10"],
      { cwd: deps.projectRoot, timeoutMs: 8_000 }
    );
    if (gitLogResult.exitCode === 0 && gitLogResult.stdout.trim()) {
      snapshot += "\n## Recent git history\n" + gitLogResult.stdout.trim() + "\n";
    }
  } catch { /* git unavailable — skip silently */ }

  // 2. Detect mode: first-gen vs update
  const prdAbsPath = path.join(deps.projectRoot, ADE_DOC_PRD_REL);
  const archAbsPath = path.join(deps.projectRoot, ADE_DOC_ARCH_REL);
  const existingPrd = readFileIfExists(prdAbsPath).trim();
  const existingArch = readFileIfExists(archAbsPath).trim();
  const MIN_DOC_SIZE = 200;
  const isUpdateMode = existingPrd.length > MIN_DOC_SIZE && existingArch.length > MIN_DOC_SIZE;

  // 3. For update mode, get changes since last generation
  let gitChanges = "";
  if (isUpdateMode) {
    const lastRunRaw = deps.db.getJson<{ generatedAt?: string }>(CONTEXT_DOC_LAST_RUN_KEY);
    const lastDate = lastRunRaw?.generatedAt ?? null;
    if (lastDate) {
      try {
        const gitLogStatResult = await runGit(
          ["log", "--oneline", "--stat", `--since=${lastDate}`],
          { cwd: deps.projectRoot, timeoutMs: 10_000 }
        );
        if (gitLogStatResult.exitCode === 0 && gitLogStatResult.stdout.trim()) {
          gitChanges = gitLogStatResult.stdout.trim();
        }
      } catch { /* git unavailable — fallback handled in prompt */ }
    }
  }

  // 4. Build prompt
  let prompt: string;
  if (isUpdateMode) {
    const changesSection = gitChanges
      ? gitChanges
      : "Git history unavailable. Compare the snapshot below against the current docs.";
    const lastDate = deps.db.getJson<{ generatedAt?: string }>(CONTEXT_DOC_LAST_RUN_KEY)?.generatedAt ?? "unknown";
    prompt = [
      "You are updating existing reference cards that AI agents read at the start of every session.",
      "",
      "Current docs:",
      `<prd>${existingPrd}</prd>`,
      `<architecture>${existingArch}</architecture>`,
      "",
      `Changes since last generation (${lastDate}):`,
      `<changes>${changesSection}</changes>`,
      "",
      "Current codebase snapshot:",
      `<snapshot>${snapshot}</snapshot>`,
      "",
      "You have read-only tools. Use them to inspect changed files if needed. Keep tool calls under 5.",
      "Update the docs IN-PLACE — no changelogs, no deltas. Return the full updated documents.",
      "If nothing material changed, return existing content as-is.",
      "",
      "CRITICAL: Each document MUST be under 8000 characters.",
      "",
      'Return ONLY: {"prd":"<markdown>","architecture":"<markdown>"}'
    ].join("\n");
  } else {
    prompt = [
      "You are producing two compact reference cards that AI coding agents read at the start of every session for quick orientation. Dense and structured — every sentence earns its place.",
      "",
      "Here is a snapshot of the codebase:",
      `<snapshot>${snapshot}</snapshot>`,
      "",
      "You have read-only tools: readFile, glob, grep, listDir, gitLog. Use them to inspect key files — entry points, service definitions, types, config. Keep tool calls under 8.",
      "",
      "CRITICAL: Each document MUST be under 8000 characters.",
      "",
      'Return ONLY: {"prd":"<markdown>","architecture":"<markdown>"}',
      "",
      "PRD.ade.md structure:",
      "1. **What this is** — product name, what it does, who uses it (2-3 sentences)",
      "2. **Stack** — languages, frameworks, key deps, repo structure (bullets)",
      "3. **Feature areas** — each major feature, one line each (bullets)",
      "4. **Current state** — what's shipped, what's being built (2-3 sentences)",
      "5. **Working norms** — conventions, testing, deployment (bullets)",
      "",
      "ARCHITECTURE.ade.md structure:",
      "1. **System shape** — layers, boundaries, how the app is structured (3-5 sentences)",
      "2. **Core services** — name, responsibility, key interface (bullets)",
      "3. **Data model** — storage, state management (bullets)",
      "4. **Integration points** — external services, APIs, IPC (bullets)",
      "5. **Key patterns** — naming, error handling, extension points (bullets)"
    ].join("\n");
  }

  // 5. Call AI with prompt (model now gets read-only tools automatically)
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
            // fall through to snapshot-based fallback below.
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

  // 6. Fallback: write snapshot-based reference doc instead of empty
  if (!generatedPrd.trim()) {
    generatedPrd = `# PRD.ade\n\n> Auto-generated from codebase snapshot. Regenerate with AI for richer content.\n\n${snapshot}\n`;
    warnings.push({ code: "generator_fallback_prd", message: "Used snapshot-based fallback PRD." });
  }
  if (!generatedArch.trim()) {
    generatedArch = `# ARCHITECTURE.ade\n\n> Auto-generated from codebase snapshot. Regenerate with AI for richer content.\n\n${snapshot}\n`;
    warnings.push({ code: "generator_fallback_architecture", message: "Used snapshot-based fallback architecture." });
  }

  // 7. Write files + update lastRun — same as before
  const prdWrite = writeDocWithFallback({
    preferredAbsPath: prdAbsPath,
    fallbackFileName: "PRD.ade.md",
    content: generatedPrd,
    fallbackRoot: FALLBACK_GENERATED_ROOT
  });
  const archWrite = writeDocWithFallback({
    preferredAbsPath: archAbsPath,
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
