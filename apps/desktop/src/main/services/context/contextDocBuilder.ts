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
import { parseStructuredOutput } from "../ai/utils";
import { readDocPaths } from "../orchestrator/stepPolicyResolver";
import type {
  ContextDocHealth,
  ContextDocOutputSource,
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
const DOC_TEXT_EXT_RE = /\.(md|mdx|txt|rst)$/i;
const DOC_CONTEXT_EXT_RE = /\.(md|mdx|txt|rst|yaml|yml|json)$/i;
const DOC_PRD_HINT_RE = /(prd|product|roadmap|feature|requirement|spec|user-story|planning)/i;
const DOC_ARCH_HINT_RE = /(architecture|system|design|technical|infra|platform|lanes|conflict|pack)/i;
const DOC_GUIDE_HINT_RE = /(readme|guide|overview|context|contributing|claude|agents)/i;
const CONTEXT_DOC_MAX_CHARS = 8_000;

type ContextDocId = ContextDocStatus["id"];

const CONTEXT_DOC_SPECS: Record<ContextDocId, {
  label: string;
  relPath: string;
  fallbackFileName: string;
  title: string;
  requiredHeadings: string[];
}> = {
  prd_ade: {
    label: "PRD (ADE minimized)",
    relPath: ADE_DOC_PRD_REL,
    fallbackFileName: "PRD.ade.md",
    title: "# PRD.ade",
    requiredHeadings: [
      "## What this is",
      "## Who it's for",
      "## Feature areas",
      "## Current state",
      "## Working norms",
    ],
  },
  architecture_ade: {
    label: "Architecture (ADE minimized)",
    relPath: ADE_DOC_ARCH_REL,
    fallbackFileName: "ARCHITECTURE.ade.md",
    title: "# ARCHITECTURE.ade",
    requiredHeadings: [
      "## System shape",
      "## Core services",
      "## Data and state",
      "## Integration points",
      "## Key patterns",
    ],
  },
};

type ContextSourceDigest = {
  relPath: string;
  title: string;
  blurb: string;
  headings: string[];
};

type HybridSourceBundle = {
  productDigests: ContextSourceDigest[];
  technicalDigests: ContextSourceDigest[];
  codeAnchors: Array<{ relPath: string; excerpt: string }>;
  gitHistory: string;
  gitChanges: string;
};

type PersistedDocResult = ContextGenerateDocsResult["docResults"][number];

type PersistedContextDocRun = {
  generatedAt?: string;
  provider?: string;
  trigger?: string;
  modelId?: string | null;
  reasoningEffort?: string | null;
  prdPath?: string;
  architecturePath?: string;
  degraded?: boolean;
  warnings?: Array<{ code?: string; message?: string; actionLabel?: string; actionPath?: string }>;
  docResults?: Array<{
    id?: string;
    health?: string;
    source?: string;
    sizeBytes?: number;
  }>;
};

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

const clipText = (value: string, maxChars: number): string => {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n...(truncated)`;
};

function normalizeContextDocSource(value: unknown): ContextDocOutputSource {
  const normalized = String(value ?? "").trim();
  if (normalized === "deterministic" || normalized === "previous_good") return normalized;
  return "ai";
}

const VALID_CONTEXT_DOC_HEALTH = new Set<ContextDocHealth>(["missing", "incomplete", "fallback", "stale", "ready"]);

function normalizeContextDocHealth(value: unknown): ContextDocHealth | null {
  const normalized = String(value ?? "").trim();
  return VALID_CONTEXT_DOC_HEALTH.has(normalized as ContextDocHealth) ? normalized as ContextDocHealth : null;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^#{1,6}\s+/gm, " ")
    .replace(/[*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function computeDocOverlap(left: string, right: string): number {
  const toTokens = (input: string) =>
    stripMarkdown(input)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4);
  const leftSet = new Set(toTokens(left));
  const rightSet = new Set(toTokens(right));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = leftSet.size + rightSet.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function extractMarkdownTitle(text: string, fallback: string): string {
  const lines = text.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line.trim()));
  return heading ? heading.trim().replace(/^#\s+/, "") : fallback;
}

function extractParagraph(text: string, maxChars = 260): string {
  const lines = text.split(/\r?\n/);
  const parts: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (parts.length > 0) break;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (line.startsWith(">")) continue;
    if (line === "---") continue;
    parts.push(line);
    if (parts.join(" ").length >= maxChars) break;
  }
  return clipText(parts.join(" "), maxChars);
}

function extractHeadings(text: string, maxHeadings = 5): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, ""))
    .slice(0, maxHeadings);
}

function extractSectionBullets(text: string, heading: string, maxBullets = 5): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^##\s+/.test(line)) {
      if (inside) break;
      inside = line.toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (!inside) continue;
    if (/^[-*]\s+/.test(line)) {
      out.push(line.replace(/^[-*]\s+/, "").trim());
      if (out.length >= maxBullets) break;
    }
  }
  return out;
}

function collectSourceDigest(projectRoot: string, relPath: string): ContextSourceDigest | null {
  const absPath = path.join(projectRoot, relPath);
  const { text } = safeReadDoc(absPath, 24_000);
  if (!text.trim()) return null;
  return {
    relPath,
    title: extractMarkdownTitle(text, path.basename(relPath)),
    blurb: extractParagraph(text),
    headings: extractHeadings(text),
  };
}

function formatSourceDigests(label: string, digests: ContextSourceDigest[], maxChars: number): string {
  const lines: string[] = [`## ${label}`];
  for (const digest of digests) {
    const entry = [
      `- ${digest.relPath}`,
      `  title: ${digest.title}`,
      digest.blurb ? `  summary: ${digest.blurb}` : "",
      digest.headings.length > 0 ? `  sections: ${digest.headings.join(" | ")}` : "",
    ].filter(Boolean).join("\n");
    const next = [...lines, entry].join("\n");
    if (next.length > maxChars) break;
    lines.push(entry);
  }
  return lines.join("\n");
}

function readSectionExcerpt(
  projectRoot: string,
  relPath: string,
  pattern: RegExp,
  linesBefore = 2,
  linesAfter = 26,
): { relPath: string; excerpt: string } | null {
  const absPath = path.join(projectRoot, relPath);
  const { text } = safeReadDoc(absPath, 18_000);
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/);
  const matchIndex = lines.findIndex((line) => pattern.test(line));
  const start = Math.max(0, matchIndex >= 0 ? matchIndex - linesBefore : 0);
  const end = Math.min(lines.length, matchIndex >= 0 ? matchIndex + linesAfter : Math.min(lines.length, 30));
  const excerpt = lines.slice(start, end).join("\n").trim();
  if (!excerpt) return null;
  return { relPath, excerpt: clipText(excerpt, 1_600) };
}

async function collectGitHistory(projectRoot: string): Promise<string> {
  try {
    const result = await runGit(["log", "--oneline", "-n", "8"], {
      cwd: projectRoot,
      timeoutMs: 8_000,
    });
    if (result.exitCode === 0) return result.stdout.trim();
  } catch {
    // ignore
  }
  return "";
}

async function collectGitChangesSince(projectRoot: string, lastDate: string | null): Promise<string> {
  if (!lastDate) return "";
  try {
    const result = await runGit(["log", "--oneline", "--stat", `--since=${lastDate}`], {
      cwd: projectRoot,
      timeoutMs: 10_000,
    });
    if (result.exitCode === 0) return result.stdout.trim();
  } catch {
    // ignore
  }
  return "";
}

async function buildHybridSourceBundle(projectRoot: string, lastGeneratedAt: string | null): Promise<HybridSourceBundle> {
  const productDigests: ContextSourceDigest[] = [];
  const technicalDigests: ContextSourceDigest[] = [];
  const pushDigest = (target: ContextSourceDigest[], relPath: string) => {
    const digest = collectSourceDigest(projectRoot, relPath);
    if (digest) target.push(digest);
  };

  for (const relPath of ["README.md", "AGENTS.md", "docs/PRD.md"]) {
    pushDigest(productDigests, relPath);
  }

  const featuresDir = path.join(projectRoot, "docs", "features");
  if (fs.existsSync(featuresDir)) {
    for (const entry of fs.readdirSync(featuresDir).sort()) {
      if (!DOC_TEXT_EXT_RE.test(entry)) continue;
      pushDigest(productDigests, path.join("docs", "features", entry).replace(/\\/g, "/"));
    }
  }

  const architectureDir = path.join(projectRoot, "docs", "architecture");
  if (fs.existsSync(architectureDir)) {
    for (const entry of fs.readdirSync(architectureDir).sort()) {
      if (!DOC_TEXT_EXT_RE.test(entry)) continue;
      pushDigest(technicalDigests, path.join("docs", "architecture", entry).replace(/\\/g, "/"));
    }
  }

  const codeAnchors = [
    readSectionExcerpt(projectRoot, "apps/desktop/src/main/main.ts", /createContextDocService/),
    readSectionExcerpt(projectRoot, "apps/desktop/src/main/services/ipc/registerIpc.ts", /IPC\.contextGetStatus/),
    readSectionExcerpt(projectRoot, "apps/desktop/src/preload/preload.ts", /context:\s*\{/),
    readSectionExcerpt(projectRoot, "apps/desktop/src/shared/types/packs.ts", /export type ContextDocStatus = \{/),
    readSectionExcerpt(projectRoot, "apps/mcp-server/src/index.ts", /^/),
  ].filter((value): value is { relPath: string; excerpt: string } => value != null);

  return {
    productDigests,
    technicalDigests,
    codeAnchors,
    gitHistory: await collectGitHistory(projectRoot),
    gitChanges: await collectGitChangesSince(projectRoot, lastGeneratedAt),
  };
}

function formatCodeAnchors(anchors: HybridSourceBundle["codeAnchors"], maxChars: number): string {
  const lines: string[] = ["## Code anchors"];
  for (const anchor of anchors) {
    const entry = [`- ${anchor.relPath}`, "```ts", anchor.excerpt, "```"].join("\n");
    const next = [...lines, entry].join("\n");
    if (next.length > maxChars) break;
    lines.push(entry);
  }
  return lines.join("\n");
}

function docSpecFor(id: ContextDocId) {
  return CONTEXT_DOC_SPECS[id];
}

function inferContextDocSource(content: string, persistedSource: ContextDocOutputSource | null): ContextDocOutputSource {
  if (persistedSource === "previous_good") return "previous_good";
  const looksDeterministic = /auto-generated from curated docs and code digests/i.test(content)
    || /auto-generated from codebase snapshot/i.test(content);
  return looksDeterministic ? "deterministic" : "ai";
}

/** Ensures generated markdown opens with the canonical doc title (models often skip the `# …` line). */
function ensureCanonicalContextDocTitle(id: ContextDocId, content: string): string {
  const spec = docSpecFor(id);
  const trimmed = content.trim();
  if (!trimmed.length) return trimmed;
  if (trimmed.startsWith(spec.title)) return trimmed;
  return `${spec.title}\n\n${trimmed}`;
}

function validateContextDoc(id: ContextDocId, content: string): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const spec = docSpecFor(id);
  const normalized = content.trim();
  if (!normalized) reasons.push("empty");
  if (normalized.length > CONTEXT_DOC_MAX_CHARS) reasons.push("too_long");
  const lowered = normalized.toLowerCase();
  const missingHeadings = spec.requiredHeadings.filter((heading) => !lowered.includes(heading.toLowerCase()));
  if (missingHeadings.length > 0) reasons.push(`missing_headings:${missingHeadings.join("|")}`);
  if (normalized.split(/\r?\n/).filter((line) => line.trim()).length < 10) reasons.push("too_short");
  return { valid: reasons.length === 0, reasons };
}

function compactGeneratedContextDoc(id: ContextDocId, content: string): string {
  const normalized = ensureCanonicalContextDocTitle(id, content);
  if (normalized.length <= CONTEXT_DOC_MAX_CHARS) return normalized;

  const spec = docSpecFor(id);

  const headingOffsets = spec.requiredHeadings.map((heading) => normalized.indexOf(heading));
  if (headingOffsets.some((offset) => offset < 0)) return normalized;
  for (let index = 1; index < headingOffsets.length; index += 1) {
    if (headingOffsets[index] <= headingOffsets[index - 1]) return normalized;
  }

  const sectionBodies = spec.requiredHeadings.map((heading, index) => {
    const bodyStart = headingOffsets[index] + heading.length;
    const sectionEnd = index + 1 < headingOffsets.length
      ? headingOffsets[index + 1]
      : normalized.length;
    return normalized.slice(bodyStart, sectionEnd).trim();
  });

  const scaffoldLines = [
    spec.title,
    "",
    ...spec.requiredHeadings.flatMap((heading) => [heading, ""]),
  ];
  const scaffoldLength = scaffoldLines.join("\n").length;
  const reservedEllipsisBudget = spec.requiredHeadings.length * 20;
  const bodyBudget = Math.max(
    120 * spec.requiredHeadings.length,
    CONTEXT_DOC_MAX_CHARS - scaffoldLength - reservedEllipsisBudget,
  );
  const perSectionBudget = Math.max(120, Math.floor(bodyBudget / spec.requiredHeadings.length));

  const compactedLines: string[] = [spec.title, ""];
  for (let index = 0; index < spec.requiredHeadings.length; index += 1) {
    compactedLines.push(spec.requiredHeadings[index]);
    compactedLines.push(clipText(sectionBodies[index], perSectionBudget));
    compactedLines.push("");
  }

  return compactedLines.join("\n").trim();
}

function computeContextDocHealth(args: {
  id: ContextDocId;
  exists: boolean;
  content: string;
  staleReason: string | null;
  source: ContextDocOutputSource;
}): ContextDocHealth {
  if (!args.exists) return "missing";
  if (args.staleReason) return "stale";
  const validation = validateContextDoc(args.id, args.content);
  if (!validation.valid) return "incomplete";
  if (args.source === "deterministic") return "fallback";
  return "ready";
}

function readPersistedDocResults(raw: PersistedContextDocRun | null | undefined): Partial<Record<ContextDocId, PersistedDocResult>> {
  const out: Partial<Record<ContextDocId, PersistedDocResult>> = {};
  if (!Array.isArray(raw?.docResults)) return out;
  for (const entry of raw.docResults) {
    const id = entry?.id === "prd_ade" || entry?.id === "architecture_ade" ? entry.id : null;
    if (!id) continue;
    out[id] = {
      id,
      health: normalizeContextDocHealth(entry.health) ?? "incomplete",
      source: normalizeContextDocSource(entry.source),
      sizeBytes: Number.isFinite(Number(entry.sizeBytes)) ? Math.max(0, Math.floor(Number(entry.sizeBytes))) : 0,
    };
  }
  return out;
}

function readContextDocFile(projectRoot: string, relPath: string): {
  exists: boolean;
  sizeBytes: number;
  updatedAt: string | null;
  fingerprint: string | null;
  body: string;
} {
  const absPath = path.join(projectRoot, relPath);
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) {
      return { exists: false, sizeBytes: 0, updatedAt: null, fingerprint: null, body: "" };
    }
    const body = fs.readFileSync(absPath, "utf8");
    return {
      exists: true,
      sizeBytes: st.size,
      updatedAt: st.mtime.toISOString(),
      fingerprint: sha256(body),
      body,
    };
  } catch {
    return { exists: false, sizeBytes: 0, updatedAt: null, fingerprint: null, body: "" };
  }
}

function buildDeterministicPrdDoc(args: {
  productDigests: ContextSourceDigest[];
  featureDigests: ContextSourceDigest[];
  gitHistory: string;
  workingNorms: string[];
}): string {
  const overview = args.productDigests.find((digest) => digest.relPath === "docs/PRD.md")?.blurb
    || args.productDigests.find((digest) => digest.relPath === "README.md")?.blurb
    || "ADE is a local-first desktop workspace for orchestrating coding agents, lanes, missions, PR workflows, and proof capture.";
  const audience = "Developers and small teams coordinating multiple AI coding agents across parallel lanes and review workflows.";
  const featureBullets = args.featureDigests.slice(0, 10).map((digest) =>
    `- ${digest.title}: ${digest.blurb || `See ${digest.relPath} for current behavior.`}`
  );
  const currentState = args.gitHistory
    ? `ADE is actively evolving. Recent work is concentrated on ${args.gitHistory.split(/\r?\n/).slice(0, 3).join("; ")}.`
    : "ADE is actively evolving across desktop orchestration, iOS parity, and AI workflow hardening.";
  const norms = args.workingNorms.length > 0
    ? args.workingNorms.slice(0, 5).map((line) => `- ${line}`)
    : [
        "- Preserve existing desktop app patterns before introducing new abstractions.",
        "- Keep IPC contracts, preload types, shared types, and renderer usage in sync.",
        "- Validate the smallest relevant desktop/MCP checks first, then broaden coverage.",
      ];
  return clipText([
    CONTEXT_DOC_SPECS.prd_ade.title,
    "",
    "> Auto-generated from curated docs and code digests.",
    "",
    "## What this is",
    overview,
    "",
    "## Who it's for",
    audience,
    "",
    "## Feature areas",
    ...featureBullets,
    "",
    "## Current state",
    currentState,
    "",
    "## Working norms",
    ...norms,
    "",
  ].join("\n"), CONTEXT_DOC_MAX_CHARS);
}

function buildDeterministicArchitectureDoc(args: {
  technicalDigests: ContextSourceDigest[];
  codeAnchors: Array<{ relPath: string; excerpt: string }>;
  workingNorms: string[];
}): string {
  const overview = args.technicalDigests.find((digest) => digest.relPath === "docs/architecture/SYSTEM_OVERVIEW.md")?.blurb
    || "ADE uses a trusted Electron main process, typed preload bridge, and untrusted renderer, with AI/runtime services operating through the main process.";
  const serviceBullets = args.technicalDigests.slice(0, 8).map((digest) =>
    `- ${digest.title}: ${digest.blurb || `See ${digest.relPath}.`}`
  );
  const dataBullets = [
    "- Project state lives under `.ade/`, with runtime metadata in `.ade/ade.db` and machine-local state in `.ade/secrets`, `.ade/cache`, and `.ade/artifacts`.",
    "- Generated agent context lives in `.ade/context/PRD.ade.md` and `.ade/context/ARCHITECTURE.ade.md`.",
    "- Shared types in `apps/desktop/src/shared` define IPC and renderer/main-process contracts.",
  ];
  const integrationBullets = [
    "- Desktop UI talks to trusted services over typed IPC via the preload bridge.",
    "- `apps/mcp-server` exposes ADE tools for headless and desktop-backed MCP flows.",
    "- AI execution remains provider-flexible across CLI subscriptions, API/OpenRouter, and local endpoints.",
  ];
  const patternBullets = (args.workingNorms.length > 0 ? args.workingNorms.slice(0, 4) : [
    "Renderer surfaces should not implement repo-mutation workarounds that belong in shared services.",
    "Computer-use flows must enforce policy and artifact ownership in code paths, not prompts alone.",
  ]).map((line) => `- ${line}`);
  const anchorBullets = args.codeAnchors.slice(0, 4).map((anchor) => `- ${anchor.relPath}`);
  return clipText([
    CONTEXT_DOC_SPECS.architecture_ade.title,
    "",
    "> Auto-generated from curated docs and code digests.",
    "",
    "## System shape",
    overview,
    "",
    "## Core services",
    ...serviceBullets,
    "",
    "## Data and state",
    ...dataBullets,
    "",
    "## Integration points",
    ...integrationBullets,
    ...(anchorBullets.length > 0 ? ["- Key code anchors:", ...anchorBullets] : []),
    "",
    "## Key patterns",
    ...patternBullets,
    "",
  ].join("\n"), CONTEXT_DOC_MAX_CHARS);
}

function buildGenerationPrompt(args: {
  bundle: HybridSourceBundle;
  existingPrd: string;
  existingArch: string;
  lastGeneratedAt: string | null;
}): string {
  const productSources = formatSourceDigests("Product sources", args.bundle.productDigests, 7_000);
  const technicalSources = formatSourceDigests("Technical sources", args.bundle.technicalDigests, 7_000);
  const codeAnchors = formatCodeAnchors(args.bundle.codeAnchors, 4_500);
  const gitHistory = args.bundle.gitHistory ? `## Recent git history\n${args.bundle.gitHistory}` : "## Recent git history\nUnavailable";
  const gitChanges = args.bundle.gitChanges
    ? `## Changes since last generation (${args.lastGeneratedAt ?? "unknown"})\n${clipText(args.bundle.gitChanges, 4_500)}`
    : `## Changes since last generation (${args.lastGeneratedAt ?? "unknown"})\nUnavailable or unchanged`;

  const currentDocsSection = args.existingPrd.trim() && args.existingArch.trim()
    ? [
        "## Current generated docs",
        "<current_prd>",
        clipText(args.existingPrd, 4_500),
        "</current_prd>",
        "<current_architecture>",
        clipText(args.existingArch, 4_500),
        "</current_architecture>",
      ].join("\n")
    : "## Current generated docs\nNone yet.";

  return [
    "You are producing two dense bootstrap cards that ADE agents read at session start.",
    "",
    "Ownership rules:",
    "- `PRD.ade.md` owns product semantics: what ADE is, who it is for, feature areas, current shipped state, workflow expectations, and operator-facing norms.",
    "- `ARCHITECTURE.ade.md` owns implementation shape: trust boundaries, process/service layout, data/state model, IPC boundaries, integration points, and extension patterns.",
    "- Do not duplicate the same feature list or stack summary in both docs unless it is essential for orientation.",
    "",
    "Output rules:",
    "- Return JSON only: {\"prd\":\"...\",\"architecture\":\"...\"}.",
    "- The first character of your response must be `{` and the last character must be `}`.",
    "- Do not include narration, thinking text, Markdown fences, or any text before/after the JSON object.",
    `- Each doc must stay under ${CONTEXT_DOC_MAX_CHARS} characters.`,
    "- Use these exact headings and no changelog language.",
    "",
    "PRD headings:",
    ...CONTEXT_DOC_SPECS.prd_ade.requiredHeadings.map((heading) => `- ${heading}`),
    "",
    "Architecture headings:",
    ...CONTEXT_DOC_SPECS.architecture_ade.requiredHeadings.map((heading) => `- ${heading}`),
    "",
    currentDocsSection,
    "",
    productSources,
    "",
    technicalSources,
    "",
    codeAnchors,
    "",
    gitHistory,
    "",
    gitChanges,
  ].join("\n");
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
  const latestRunRaw = deps.db.getJson<PersistedContextDocRun>(CONTEXT_DOC_LAST_RUN_KEY);
  const persistedDocResults = readPersistedDocResults(latestRunRaw);
  const latestWarnings = Array.isArray(latestRunRaw?.warnings)
    ? latestRunRaw!.warnings!.map((warning) => ({
        code: String(warning?.code ?? "unknown"),
        message: String(warning?.message ?? ""),
        ...(warning?.actionLabel ? { actionLabel: String(warning.actionLabel) } : {}),
        ...(warning?.actionPath ? { actionPath: String(warning.actionPath) } : {})
      }))
    : [];
  const readDocStatus = (id: ContextDocId): ContextDocStatus => {
    const spec = docSpecFor(id);
    const file = readContextDocFile(deps.projectRoot, spec.relPath);
    const staleReason = (() => {
      if (!file.exists) return "missing";
      if (!file.updatedAt || !canonical.updatedAt) return null;
      const docTs = Date.parse(file.updatedAt);
      const canonicalTs = Date.parse(canonical.updatedAt);
      if (Number.isFinite(docTs) && Number.isFinite(canonicalTs) && docTs < canonicalTs) {
        return "older_than_canonical_docs";
      }
      return null;
    })();
    const persisted = persistedDocResults[id];
    const source = inferContextDocSource(file.body, persisted?.source ?? null);
    const health = computeContextDocHealth({
      id,
      exists: file.exists,
      content: file.body,
      staleReason,
      source,
    });
    return {
      id,
      label: spec.label,
      preferredPath: spec.relPath,
      exists: file.exists,
      sizeBytes: file.sizeBytes,
      updatedAt: file.updatedAt,
      fingerprint: file.fingerprint,
      staleReason,
      fallbackCount,
      health,
      source,
    };
  };
  const docs = [
    readDocStatus("prd_ade"),
    readDocStatus("architecture_ade"),
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
  const warnings: ContextGenerateDocsResult["warnings"] = [];
  const lastRunRaw = deps.db.getJson<PersistedContextDocRun>(CONTEXT_DOC_LAST_RUN_KEY);
  const lastGeneratedAt = typeof lastRunRaw?.generatedAt === "string" ? lastRunRaw.generatedAt : null;
  const persistedDocResults = readPersistedDocResults(lastRunRaw);
  const generationStartedAt = nowIso();
  const existingPrdFile = readContextDocFile(deps.projectRoot, ADE_DOC_PRD_REL);
  const existingArchFile = readContextDocFile(deps.projectRoot, ADE_DOC_ARCH_REL);
  const bundle = await buildHybridSourceBundle(deps.projectRoot, lastGeneratedAt);
  const prompt = buildGenerationPrompt({
    bundle,
    existingPrd: existingPrdFile.body,
    existingArch: existingArchFile.body,
    lastGeneratedAt,
  });

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
      const structuredCandidate = isRecord(aiResult.structuredOutput)
        ? aiResult.structuredOutput
        : parseStructuredOutput(aiResult.text);
      const structured = isRecord(structuredCandidate) ? structuredCandidate : null;
      if (structured) {
        generatedPrd = compactGeneratedContextDoc("prd_ade", asString(structured.prd));
        generatedArch = compactGeneratedContextDoc("architecture_ade", asString(structured.architecture));
      } else if (aiResult.text.trim()) {
        warnings.push({
          code: "generator_unstructured_output",
          message: "Model returned text instead of the required JSON object for context docs.",
        });
      } else {
        warnings.push({
          code: "generator_empty_output",
          message: "Model returned empty output for context docs.",
        });
      }
    } catch (error) {
      warnings.push({
        code: "generator_failed",
        message: `provider=${provider}${modelId ? ` model=${modelId}` : ""} error=${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  const prdValidation = validateContextDoc("prd_ade", generatedPrd);
  const archValidation = validateContextDoc("architecture_ade", generatedArch);
  let overlapScore = 0;
  if (generatedPrd.trim() && generatedArch.trim()) {
    overlapScore = computeDocOverlap(generatedPrd, generatedArch);
    if (overlapScore >= 0.72) {
      warnings.push({
        code: "generator_overlap_rejected",
        message: `Rejected generated docs because PRD/architecture overlap was too high (${overlapScore.toFixed(2)}).`,
      });
    }
  }
  if (!prdValidation.valid) {
    warnings.push({
      code: "generator_invalid_prd",
      message: `Generated PRD failed validation: ${prdValidation.reasons.join(", ") || "unknown"}.`,
    });
  }
  if (!archValidation.valid) {
    warnings.push({
      code: "generator_invalid_architecture",
      message: `Generated architecture doc failed validation: ${archValidation.reasons.join(", ") || "unknown"}.`,
    });
  }

  const agentsText = safeReadDoc(path.join(deps.projectRoot, "AGENTS.md"), 16_000).text;
  const workingNorms = extractSectionBullets(agentsText, "## Working norms", 6);
  const featureDigests = bundle.productDigests.filter((digest) => digest.relPath.startsWith("docs/features/"));
  const deterministicPrd = buildDeterministicPrdDoc({
    productDigests: bundle.productDigests,
    featureDigests,
    gitHistory: bundle.gitHistory,
    workingNorms,
  });
  const deterministicArch = buildDeterministicArchitectureDoc({
    technicalDigests: bundle.technicalDigests,
    codeAnchors: bundle.codeAnchors,
    workingNorms,
  });

  const existingPrdBaseHealth = computeContextDocHealth({
    id: "prd_ade",
    exists: existingPrdFile.exists,
    content: existingPrdFile.body,
    staleReason: null,
    source: inferContextDocSource(existingPrdFile.body, persistedDocResults.prd_ade?.source ?? null),
  });
  const existingArchBaseHealth = computeContextDocHealth({
    id: "architecture_ade",
    exists: existingArchFile.exists,
    content: existingArchFile.body,
    staleReason: null,
    source: inferContextDocSource(existingArchFile.body, persistedDocResults.architecture_ade?.source ?? null),
  });

  type ResolvedDoc = {
    content: string;
    source: ContextDocOutputSource;
    preserveExisting: boolean;
    health: ContextDocHealth;
  };

  const rejectBothForOverlap = overlapScore >= 0.72;

  function resolveDocStrategy(
    generated: string,
    existingFile: { body: string },
    existingHealth: ContextDocHealth,
    deterministicContent: string,
    allowAi: boolean,
  ): ResolvedDoc {
    if (allowAi) {
      return { content: generated, source: "ai", preserveExisting: false, health: "ready" };
    }
    if (existingHealth === "ready") {
      return { content: existingFile.body, source: "previous_good", preserveExisting: true, health: "ready" };
    }
    return { content: deterministicContent, source: "deterministic", preserveExisting: false, health: "fallback" };
  }

  const resolvedDocs: Record<ContextDocId, ResolvedDoc> = {
    prd_ade: resolveDocStrategy(
      generatedPrd,
      existingPrdFile,
      existingPrdBaseHealth,
      deterministicPrd,
      prdValidation.valid && !rejectBothForOverlap,
    ),
    architecture_ade: resolveDocStrategy(
      generatedArch,
      existingArchFile,
      existingArchBaseHealth,
      deterministicArch,
      archValidation.valid && !rejectBothForOverlap,
    ),
  };

  const FALLBACK_WARNINGS: Record<ContextDocOutputSource, Record<ContextDocId, { code: string; message: string } | null>> = {
    deterministic: {
      prd_ade: { code: "generator_fallback_prd", message: "Used deterministic fallback PRD." },
      architecture_ade: { code: "generator_fallback_architecture", message: "Used deterministic fallback architecture." },
    },
    previous_good: {
      prd_ade: { code: "generator_preserved_previous_prd", message: "Preserved the previous valid PRD because new output was degraded." },
      architecture_ade: { code: "generator_preserved_previous_architecture", message: "Preserved the previous valid architecture doc because new output was degraded." },
    },
    ai: { prd_ade: null, architecture_ade: null },
  };

  for (const [id, doc] of Object.entries(resolvedDocs) as Array<[ContextDocId, ResolvedDoc]>) {
    if (doc.source === "ai") continue;
    const warning = FALLBACK_WARNINGS[doc.source]?.[id];
    if (warning) warnings.push(warning);
  }

  const persistResolvedDoc = (id: ContextDocId) => {
    const spec = docSpecFor(id);
    const preferredAbsPath = path.join(deps.projectRoot, spec.relPath);
    const resolved = resolvedDocs[id];
    if (resolved.preserveExisting && fs.existsSync(preferredAbsPath)) {
      const stat = fs.statSync(preferredAbsPath);
      return {
        writtenPath: preferredAbsPath,
        usedFallback: false,
        warning: null,
        sizeBytes: stat.size,
      };
    }
    const write = writeDocWithFallback({
      preferredAbsPath,
      fallbackFileName: spec.fallbackFileName,
      content: resolved.content,
      fallbackRoot: FALLBACK_GENERATED_ROOT,
    });
    return {
      ...write,
      sizeBytes: Buffer.byteLength(resolved.content, "utf8"),
    };
  };

  const prdWrite = persistResolvedDoc("prd_ade");
  const archWrite = persistResolvedDoc("architecture_ade");
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
    generatedAt: generationStartedAt,
    provider,
    trigger,
    modelId,
    reasoningEffort,
    prdPath: prdWrite.writtenPath,
    architecturePath: archWrite.writtenPath,
    degraded: Object.values(resolvedDocs).some((doc) => doc.source !== "ai"),
    docResults: [
      {
        id: "prd_ade",
        health: resolvedDocs.prd_ade.health,
        source: resolvedDocs.prd_ade.source,
        sizeBytes: prdWrite.sizeBytes,
      },
      {
        id: "architecture_ade",
        health: resolvedDocs.architecture_ade.health,
        source: resolvedDocs.architecture_ade.source,
        sizeBytes: archWrite.sizeBytes,
      },
    ],
    warnings
  });

  return {
    provider,
    generatedAt: generationStartedAt,
    prdPath: prdWrite.writtenPath,
    architecturePath: archWrite.writtenPath,
    usedFallbackPath: prdWrite.usedFallback || archWrite.usedFallback,
    degraded: Object.values(resolvedDocs).some((doc) => doc.source !== "ai"),
    docResults: [
      {
        id: "prd_ade",
        health: resolvedDocs.prd_ade.health,
        source: resolvedDocs.prd_ade.source,
        sizeBytes: prdWrite.sizeBytes,
      },
      {
        id: "architecture_ade",
        health: resolvedDocs.architecture_ade.health,
        source: resolvedDocs.architecture_ade.source,
        sizeBytes: archWrite.sizeBytes,
      },
    ],
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
