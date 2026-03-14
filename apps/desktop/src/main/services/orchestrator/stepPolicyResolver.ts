/**
 * stepPolicyResolver.ts
 *
 * Step policy resolution, context policy composition, autopilot config parsing,
 * and file claim normalization/matching extracted from orchestratorService.ts.
 */

import path from "node:path";
import type {
  OrchestratorClaimScope,
  OrchestratorContextPolicyProfile,
  OrchestratorExecutorKind,
  OrchestratorStep,
  StartOrchestratorRunStepInput,
} from "../../../shared/types";
import {
  normalizeClaimScope,
  normalizeExecutorKind,
  asIntInRange,
  DEFAULT_CONTEXT_POLICY,
} from "./orchestratorQueries";

// ── Step Policy Types ──────────────────────────────────────────────

export type StepPolicy = {
  docsMaxBytes?: number;
  claimScopes?: Array<{
    scopeKind: OrchestratorClaimScope;
    scopeValue: string;
    ttlMs?: number;
  }>;
};

export type AutopilotConfig = {
  enabled: boolean;
  executorKind: OrchestratorExecutorKind;
  ownerId: string;
  parallelismCap: number;
};

export type ResolvedOrchestratorRuntimeConfig = {
  teammatePlanMode: "off" | "auto" | "required";
  maxParallelWorkers: number;
  defaultMergePolicy: "sequential" | "batch-at-end" | "per-step";
  defaultConflictHandoff: "auto-resolve" | "ask-user" | "orchestrator-decides";
  workerHeartbeatIntervalMs: number;
  workerHeartbeatTimeoutMs: number;
  workerIdleTimeoutMs: number;
  stepTimeoutDefaultMs: number;
  maxRetriesPerStep: number;
  contextPressureThreshold: number;
  progressiveLoading: boolean;
  maxTotalTokenBudget: number | null;
  maxPerStepTokenBudget: number | null;
  fileReservationGuardMode: "off" | "warn" | "block";
};

export const DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG: ResolvedOrchestratorRuntimeConfig = {
  teammatePlanMode: "auto",
  maxParallelWorkers: 4,
  defaultMergePolicy: "sequential",
  defaultConflictHandoff: "auto-resolve",
  workerHeartbeatIntervalMs: 30_000,
  workerHeartbeatTimeoutMs: 90_000,
  workerIdleTimeoutMs: 300_000,
  stepTimeoutDefaultMs: 300_000,
  maxRetriesPerStep: 2,
  contextPressureThreshold: 0.8,
  progressiveLoading: true,
  maxTotalTokenBudget: null,
  maxPerStepTokenBudget: null,
  fileReservationGuardMode: "warn"
};

// ── Step Policy Resolution ─────────────────────────────────────────

function parseClaimScopes(
  raw: unknown[]
): Array<{ scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number }> {
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const obj = entry as Record<string, unknown>;
      const scopeKind = normalizeClaimScope(String(obj.scopeKind ?? "lane"));
      const scopeValue = String(obj.scopeValue ?? "").trim();
      if (!scopeValue) return null;
      const ttlRaw = Number(obj.ttlMs ?? NaN);
      const normalized: { scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number } = {
        scopeKind,
        scopeValue
      };
      if (Number.isFinite(ttlRaw) && ttlRaw > 0) {
        normalized.ttlMs = Math.floor(ttlRaw);
      }
      return normalized;
    })
    .filter((entry): entry is { scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number } => entry != null);
}

export function resolveStepPolicy(step: OrchestratorStep): StepPolicy {
  const metadata = step.metadata ?? {};
  const rawPolicy = metadata.policy;
  if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) return {};
  const record = rawPolicy as Record<string, unknown>;
  const claimScopes = Array.isArray(record.claimScopes)
    ? parseClaimScopes(record.claimScopes)
    : undefined;
  return {
    docsMaxBytes: Number.isFinite(Number(record.docsMaxBytes)) ? Number(record.docsMaxBytes) : undefined,
    claimScopes
  };
}

export function resolveContextPolicy(args: {
  stepPolicy: StepPolicy;
}): OrchestratorContextPolicyProfile {
  return {
    ...DEFAULT_CONTEXT_POLICY,
    maxDocBytes:
      typeof args.stepPolicy.docsMaxBytes === "number" && Number.isFinite(args.stepPolicy.docsMaxBytes) && args.stepPolicy.docsMaxBytes > 0
        ? Math.floor(args.stepPolicy.docsMaxBytes)
        : DEFAULT_CONTEXT_POLICY.maxDocBytes
  };
}

export function parseAutopilotConfig(
  metadata: Record<string, unknown> | null | undefined,
  defaultMaxParallelWorkers: number
): AutopilotConfig {
  const fallback: AutopilotConfig = {
    enabled: false,
    executorKind: "manual",
    ownerId: "orchestrator-autopilot",
    parallelismCap: defaultMaxParallelWorkers
  };
  if (!metadata) return fallback;
  const raw = metadata.autopilot;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const record = raw as Record<string, unknown>;
  const executorKind = normalizeExecutorKind(String(record.executorKind ?? "manual"));
  const enabled = record.enabled === true && executorKind !== "manual";
  const ownerId = String(record.ownerId ?? "").trim() || "orchestrator-autopilot";
  const parallelismCap = asIntInRange(
    record.parallelismCap,
    defaultMaxParallelWorkers,
    1,
    32
  );
  return {
    enabled,
    executorKind,
    ownerId,
    parallelismCap
  };
}

export function parseStepPolicyFromMetadata(metadata: Record<string, unknown>): StartOrchestratorRunStepInput["policy"] | undefined {
  const raw = metadata.policy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const includeNarrative = record.includeNarrative === true;
  const includeFullDocs = record.includeFullDocs === true;
  const docsMaxBytes = Number(record.docsMaxBytes);
  const claimScopes = Array.isArray(record.claimScopes)
    ? parseClaimScopes(record.claimScopes)
    : undefined;
  return {
    includeNarrative,
    includeFullDocs,
    docsMaxBytes: Number.isFinite(docsMaxBytes) && docsMaxBytes > 0 ? Math.floor(docsMaxBytes) : undefined,
    claimScopes
  };
}

export function parseStepAIPriority(step: OrchestratorStep): number | null {
  const numeric = Number(step.metadata?.aiPriority ?? Number.NaN);
  return Number.isFinite(numeric) ? numeric : null;
}

export function readyStepOrderComparator(a: OrchestratorStep, b: OrchestratorStep) {
  const aiPriorityA = parseStepAIPriority(a);
  const aiPriorityB = parseStepAIPriority(b);
  if (aiPriorityA != null || aiPriorityB != null) {
    if (aiPriorityA == null) return 1;
    if (aiPriorityB == null) return -1;
    const aiPriorityDiff = aiPriorityB - aiPriorityA;
    if (aiPriorityDiff !== 0) return aiPriorityDiff;
  }
  const createdOrderDiff = a.createdAt.localeCompare(b.createdAt);
  if (createdOrderDiff !== 0) return createdOrderDiff;
  return a.id.localeCompare(b.id);
}

// ── File Claim Helpers ─────────────────────────────────────────────

export function normalizeRepoRelativePath(projectRoot: string, rawPath: string): string | null {
  let value = String(rawPath ?? "").trim();
  if (!value.length) return null;
  if (path.isAbsolute(value)) {
    value = path.relative(projectRoot, value);
  }
  value = value.replace(/\\/g, "/");
  value = path.posix.normalize(value);
  while (value.startsWith("./")) value = value.slice(2);
  if (!value.length || value === ".") return null;
  if (value.startsWith("../")) return null;
  return value;
}

export function extractFileClaimPattern(scopeValue: string): string {
  let value = String(scopeValue ?? "").trim();
  if (value.startsWith("pattern:")) value = value.slice("pattern:".length);
  if (value.startsWith("glob:")) value = value.slice("glob:".length);
  return value.trim();
}

export function normalizeFileClaimScopeValue(projectRoot: string, scopeValue: string): string | null {
  let pattern = extractFileClaimPattern(scopeValue);
  if (!pattern.length) return null;
  pattern = pattern.replace(/\\/g, "/");
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }
  if (pattern.endsWith("/")) {
    pattern = `${pattern}**`;
  }
  const normalized = normalizeRepoRelativePath(projectRoot, pattern);
  if (!normalized) return null;
  return `glob:${normalized}`;
}

function staticGlobPrefix(globPattern: string): string {
  const wildcardIndex = globPattern.search(/[*?[\]]/);
  if (wildcardIndex < 0) return globPattern;
  return globPattern.slice(0, wildcardIndex);
}

function globToRegExp(globPattern: string): RegExp {
  const escaped = globPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "__ADE_GLOB_STAR__")
    .replace(/\?/g, "__ADE_GLOB_Q__")
    .replace(/__ADE_GLOB_STAR____ADE_GLOB_STAR__/g, ".*")
    .replace(/__ADE_GLOB_STAR__/g, "[^/]*")
    .replace(/__ADE_GLOB_Q__/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

export function doesFileClaimMatchPath(scopeValue: string, repoPath: string): boolean {
  const pattern = extractFileClaimPattern(scopeValue);
  if (!pattern.length) return false;
  try {
    return globToRegExp(pattern).test(repoPath);
  } catch {
    return false;
  }
}

export function doFileClaimsOverlap(leftScopeValue: string, rightScopeValue: string): boolean {
  const left = extractFileClaimPattern(leftScopeValue);
  const right = extractFileClaimPattern(rightScopeValue);
  if (!left.length || !right.length) return false;
  if (left === right) return true;

  const leftWildcard = /[*?[\]]/.test(left);
  const rightWildcard = /[*?[\]]/.test(right);
  if (!leftWildcard && !rightWildcard) return left === right;
  if (!leftWildcard) return doesFileClaimMatchPath(rightScopeValue, left);
  if (!rightWildcard) return doesFileClaimMatchPath(leftScopeValue, right);

  const leftPrefix = staticGlobPrefix(left);
  const rightPrefix = staticGlobPrefix(right);
  if (leftPrefix.length > 0 && rightPrefix.length > 0) {
    if (leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix)) return true;
    const leftRoot = leftPrefix.split("/")[0] ?? "";
    const rightRoot = rightPrefix.split("/")[0] ?? "";
    if (leftRoot.length > 0 && leftRoot === rightRoot) return true;
    return false;
  }

  return true;
}

// ── Docs Path Cache ────────────────────────────────────────────────

import fs from "node:fs";

const docPathsCache = new Map<string, { paths: string[]; expiresAt: number }>();
const DOC_PATHS_CACHE_TTL_MS = 60_000;
const DOC_PRIORITY_REL_PATHS = [
  ".ade/context/PRD.ade.md",
  ".ade/context/ARCHITECTURE.ade.md",
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  "PRD.md",
  "ARCHITECTURE.md",
];
const DOC_SCAN_MAX_DEPTH = 4;
const DOC_SCAN_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode"
]);
const DOC_FILE_EXT_RE = /\.(md|mdx|txt|rst)$/i;
const DOC_FILE_NAME_HINT_RE = /(readme|architecture|arch|prd|design|spec|requirement|guide|overview|plan|context|claude|agents)/i;

export function readDocPaths(projectRoot: string): string[] {
  const cached = docPathsCache.get(projectRoot);
  if (cached && Date.now() < cached.expiresAt) return cached.paths;

  const priorityPaths: string[] = [];
  const prioritySet = new Set<string>();
  const scannedSet = new Set<string>();

  const addPriorityPath = (absPath: string) => {
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) return;
      const normalized = path.normalize(absPath);
      if (prioritySet.has(normalized)) return;
      prioritySet.add(normalized);
      priorityPaths.push(normalized);
    } catch {
      // ignore missing/unreadable files
    }
  };

  for (const relPath of DOC_PRIORITY_REL_PATHS) {
    addPriorityPath(path.join(projectRoot, relPath));
  }

  const walk = (root: string, depth: number) => {
    if (depth < 0) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".ade") continue;
      if (DOC_SCAN_SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(root, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth - 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!DOC_FILE_EXT_RE.test(entry.name)) continue;
      const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
      const inDocsDir = /(^|\/)docs\//i.test(rel);
      const hinted =
        DOC_FILE_NAME_HINT_RE.test(entry.name)
        || inDocsDir
        || rel.startsWith(".ade/context/");
      if (!hinted) continue;
      const normalized = path.normalize(abs);
      if (!prioritySet.has(normalized)) scannedSet.add(normalized);
    }
  };
  walk(projectRoot, DOC_SCAN_MAX_DEPTH);

  const scannedPaths = [...scannedSet].sort((a, b) => a.localeCompare(b));
  const paths = [...priorityPaths, ...scannedPaths];
  docPathsCache.set(projectRoot, { paths, expiresAt: Date.now() + DOC_PATHS_CACHE_TTL_MS });
  return paths;
}
