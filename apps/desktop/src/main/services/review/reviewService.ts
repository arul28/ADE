import { randomUUID } from "node:crypto";
import type {
  ReviewArtifactType,
  ReviewDiffContext,
  ReviewDismissReason,
  ReviewEventPayload,
  ReviewEvidence,
  ReviewFeedbackKind,
  ReviewFeedbackRecord,
  ReviewFinding,
  ReviewFindingAdjudication,
  ReviewFindingClass,
  ReviewFindingSuppressionMatch,
  ReviewListSuppressionsArgs,
  ReviewPublication,
  ReviewPublicationDestination,
  ReviewPublicationInlineComment,
  ReviewPublicationState,
  ReviewQualityReport,
  ReviewRecordFeedbackArgs,
  ReviewResolvedCompareTarget,
  ReviewRun,
  ReviewRunArtifact,
  ReviewRunConfig,
  ReviewRunDetail,
  ReviewRunStatus,
  ReviewPassKey,
  ReviewSeverity,
  ReviewSeveritySummary,
  ReviewSourcePass,
  ReviewStartRunArgs,
  ReviewSuppression,
  ReviewSuppressionScope,
  ReviewTarget,
  ReviewListRunsArgs,
  ReviewLaunchContext,
  ReviewLaunchLane,
  ReviewLaunchCommit,
} from "../../../shared/types";
import { getDefaultModelDescriptor, getModelById, resolveChatProviderForDescriptor } from "../../../shared/modelRegistry";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { getErrorMessage, isRecord, nowIso, safeJsonParse } from "../shared/utils";
import type { createLaneService } from "../lanes/laneService";
import type { createGitOperationsService } from "../git/gitOperationsService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createSessionService } from "../sessions/sessionService";
import type { createSessionDeltaService } from "../sessions/sessionDeltaService";
import type { createPrService } from "../prs/prService";
import type { createIssueInventoryService } from "../prs/issueInventoryService";
import type { createTestService } from "../tests/testService";
import { createReviewTargetMaterializer } from "./reviewTargetMaterializer";
import { createReviewContextBuilder, type ReviewContextPacket } from "./reviewContextBuilder";
import {
  collectRulePromptGuidance,
  overlayMatchesPath,
  type MatchedReviewRuleOverlay,
} from "./reviewRuleRegistry";
import { createReviewSuppressionService, type ReviewSuppressionService } from "./reviewSuppressionService";
import { buildDiffContextForFinding } from "./reviewDiffContext";
import { buildToolBackedEvidence } from "./reviewToolEvidence";
import type { EmbeddingService } from "../memory/embeddingService";

type ReviewRunRow = {
  id: string;
  project_id: string;
  lane_id: string;
  target_json: string;
  config_json: string;
  target_label: string;
  compare_target_json: string | null;
  status: string;
  summary: string | null;
  error_message: string | null;
  finding_count: number;
  severity_summary_json: string | null;
  chat_session_id: string | null;
  created_at: string;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
};

type ReviewFindingRow = {
  id: string;
  run_id: string;
  title: string;
  severity: string;
  finding_class: string | null;
  body: string;
  confidence: number;
  evidence_json: string | null;
  file_path: string | null;
  line: number | null;
  anchor_state: string;
  source_pass: string;
  publication_state: string;
  originating_passes_json: string | null;
  adjudication_json: string | null;
  diff_context_json: string | null;
  suppression_match_json: string | null;
};

type ReviewFindingFeedbackRow = {
  id: string;
  finding_id: string;
  run_id: string;
  project_id: string;
  kind: string;
  reason: string | null;
  note: string | null;
  snooze_until: string | null;
  created_at: string;
};

type ReviewRunArtifactRow = {
  id: string;
  run_id: string;
  artifact_type: string;
  title: string;
  mime_type: string;
  content_text: string | null;
  metadata_json: string | null;
  created_at: string;
};

type ReviewRunPublicationRow = {
  id: string;
  run_id: string;
  destination_json: string;
  review_event: string;
  status: string;
  review_url: string | null;
  remote_review_id: string | null;
  summary_body: string;
  inline_comments_json: string;
  summary_finding_ids_json: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

const REVIEW_MODEL_FALLBACK_ID = "openai/gpt-5.4-codex";

function resolveBuiltinReviewModelId(): string {
  const candidates = [
    getDefaultModelDescriptor("codex")?.id ?? null,
    getDefaultModelDescriptor("opencode")?.id ?? null,
    REVIEW_MODEL_FALLBACK_ID,
    getDefaultModelDescriptor("claude")?.id ?? null,
    getDefaultModelDescriptor("cursor")?.id ?? null,
  ].filter((modelId): modelId is string => Boolean(modelId?.trim()));

  for (const modelId of candidates) {
    const descriptor = getModelById(modelId);
    if (descriptor) return descriptor.id;
  }

  return REVIEW_MODEL_FALLBACK_ID;
}

const DEFAULT_REVIEW_MODEL_ID = resolveBuiltinReviewModelId();

const DEFAULT_BUDGETS: ReviewRunConfig["budgets"] = {
  maxFiles: 60,
  maxDiffChars: 180_000,
  maxPromptChars: 220_000,
  maxFindings: 12,
  maxFindingsPerPass: 6,
  maxPublishedFindings: 6,
};

const REVIEW_PASS_ORDER: ReviewPassKey[] = [
  "diff-risk",
  "cross-file-impact",
  "checks-and-tests",
];

const SEVERITY_SCORE: Record<ReviewSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

type MaterializedChangedFile = {
  filePath: string;
  excerpt: string;
  lineNumbers: number[];
  diffPositionsByLine: Record<number, number>;
};

type PassDefinition = {
  key: ReviewPassKey;
  label: string;
  focus: string;
  extraInstructions: string[];
};

type PassCandidateFinding = {
  id: string;
  runId: string;
  passKey: ReviewPassKey;
  title: string;
  severity: ReviewSeverity;
  findingClass: ReviewFindingClass | null;
  body: string;
  confidence: number;
  evidence: ReviewEvidence[];
  filePath: string | null;
  line: number | null;
  anchorState: ReviewFinding["anchorState"];
  evidenceScore: number;
  lowSignal: boolean;
  score: number;
};

type ReviewContextArtifactIds = {
  provenanceArtifactId: string;
  rulesArtifactId: string;
  validationArtifactId: string;
};

type PassExecutionResult = {
  pass: PassDefinition;
  summary: string | null;
  candidates: PassCandidateFinding[];
  promptArtifactId: string;
  outputArtifactId: string;
  findingsArtifactId: string;
  budgetTrimmedCount: number;
};

type AdjudicationRejectedFinding = {
  candidateIds: string[];
  passKeys: ReviewPassKey[];
  title: string;
  reason: "low_evidence" | "low_signal" | "duplicate" | "budget" | "rule_policy";
  detail: string;
  score: number;
};

type AdjudicationOutcome = {
  summary: string;
  findings: ReviewFinding[];
  rejected: AdjudicationRejectedFinding[];
  publicationEligibleCount: number;
  totalCandidateCount: number;
};

function defaultSeveritySummary(): ReviewSeveritySummary {
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...(truncated)...\n`;
}

function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSeverity(value: unknown): ReviewSeverity {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "critical") return "critical";
  if (raw === "high" || raw === "major") return "high";
  if (raw === "medium" || raw === "moderate") return "medium";
  if (raw === "low" || raw === "minor") return "low";
  return "info";
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampNumber(value, 0, 1);
  }
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (raw === "high") return 0.85;
    if (raw === "medium") return 0.65;
    if (raw === "low") return 0.35;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clampNumber(parsed, 0, 1);
  }
  return 0.5;
}

function normalizeFindingClass(value: unknown): ReviewFindingClass | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (raw === "intent_drift") return "intent_drift";
  if (raw === "incomplete_rollout") return "incomplete_rollout";
  if (raw === "late_stage_regression") return "late_stage_regression";
  return null;
}

const FINDING_CLASS_PRIORITY: ReviewFindingClass[] = [
  "late_stage_regression",
  "incomplete_rollout",
  "intent_drift",
];

function mergeFindingClass(classes: Array<ReviewFindingClass | null | undefined>): ReviewFindingClass | null {
  for (const findingClass of FINDING_CLASS_PRIORITY) {
    if (classes.some((candidate) => candidate === findingClass)) {
      return findingClass;
    }
  }
  return null;
}

function normalizeBudgetConfig(budgets?: Partial<ReviewRunConfig["budgets"]> | null): ReviewRunConfig["budgets"] {
  return {
    maxFiles: clampNumber(Number(budgets?.maxFiles ?? DEFAULT_BUDGETS.maxFiles), 1, 500),
    maxDiffChars: clampNumber(Number(budgets?.maxDiffChars ?? DEFAULT_BUDGETS.maxDiffChars), 4_000, 1_000_000),
    maxPromptChars: clampNumber(Number(budgets?.maxPromptChars ?? DEFAULT_BUDGETS.maxPromptChars), 4_000, 1_000_000),
    maxFindings: clampNumber(Number(budgets?.maxFindings ?? DEFAULT_BUDGETS.maxFindings), 1, 50),
    maxFindingsPerPass: clampNumber(
      Number(budgets?.maxFindingsPerPass ?? DEFAULT_BUDGETS.maxFindingsPerPass ?? DEFAULT_BUDGETS.maxFindings),
      1,
      50,
    ),
    maxPublishedFindings: clampNumber(
      Number(budgets?.maxPublishedFindings ?? DEFAULT_BUDGETS.maxPublishedFindings ?? DEFAULT_BUDGETS.maxFindings),
      1,
      50,
    ),
  };
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed.length) candidates.push(trimmed);
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fencedMatch?.[1]) candidates.push(fencedMatch[1].trim());

  const firstBrace = raw.indexOf("{");
  if (firstBrace >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = firstBrace; index < raw.length; index += 1) {
      const char = raw[index] ?? "";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(raw.slice(firstBrace, index + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function resolveTargetLaneId(target: ReviewTarget): string {
  return target.laneId;
}

function mapLaunchLane(lane: Awaited<ReturnType<ReturnType<typeof createLaneService>["list"]>>[number]): ReviewLaunchLane {
  return {
    id: lane.id,
    name: lane.name,
    laneType: lane.laneType,
    branchRef: lane.branchRef,
    baseRef: lane.baseRef,
    color: lane.color ?? null,
  };
}

function mapLaunchCommit(commit: Awaited<ReturnType<ReturnType<typeof createGitOperationsService>["listRecentCommits"]>>[number]): ReviewLaunchCommit {
  return {
    sha: commit.sha,
    shortSha: commit.shortSha,
    subject: commit.subject,
    authoredAt: commit.authoredAt,
    pushed: commit.pushed,
  };
}

function serializeSeveritySummary(summary: ReviewSeveritySummary): string {
  return JSON.stringify(summary);
}

const REVIEW_PASSES: PassDefinition[] = [
  {
    key: "diff-risk",
    label: "Diff risk",
    focus: "changed-file correctness, regressions, edge cases, migrations, and unsafe behavior directly visible in the diff",
    extraInstructions: [
      "Stay anchored to the changed code and changed lines first.",
      "Prioritize regressions, broken invariants, unsafe defaults, and risky data handling.",
    ],
  },
  {
    key: "cross-file-impact",
    label: "Cross-file impact",
    focus: "impacted call sites, shared contracts, dependent code paths, and regressions likely to surface outside the touched files",
    extraInstructions: [
      "Follow interfaces, configuration, and likely callers beyond the edited files.",
      "Reject speculative concerns unless the diff gives a concrete reason to believe a wider breakage is likely.",
    ],
  },
  {
    key: "checks-and-tests",
    label: "Checks and tests",
    focus: "failing checks, validation gaps, and the strongest missing-test risks that would allow a regression to slip through",
    extraInstructions: [
      "Prefer concrete missing-test risks over generic 'add more tests' advice.",
      "Use check/test context when present, but do not invent failures that were not supplied.",
    ],
  },
];

function buildChangedFilesSummary(changedFiles: Array<{ filePath: string }>): string {
  const changedFilesSummary = changedFiles.length > 0
    ? changedFiles.map((entry) => `- ${entry.filePath}`).join("\n")
    : "- No changed files were detected.";
  return changedFilesSummary;
}

function buildContextArtifactHints(args: {
  artifactIds: ReviewContextArtifactIds;
  includeValidation: boolean;
}): string[] {
  const lines = [
    `- provenance_brief artifact id: ${args.artifactIds.provenanceArtifactId}`,
    `- rule_overlays artifact id: ${args.artifactIds.rulesArtifactId}`,
  ];
  if (args.includeValidation) {
    lines.push(`- validation_signals artifact id: ${args.artifactIds.validationArtifactId}`);
  }
  return lines;
}

function buildPassPrompt(args: {
  run: ReviewRun;
  pass: PassDefinition;
  diffText: string;
  changedFiles: Array<{ filePath: string }>;
  context: ReviewContextPacket;
  contextArtifactIds: ReviewContextArtifactIds;
}): string {
  const changedFilesSummary = buildChangedFilesSummary(args.changedFiles);
  const includeValidation = args.pass.key === "checks-and-tests";
  const ruleGuidance = collectRulePromptGuidance(args.context.matchedRuleOverlays, args.pass.key);

  return [
    "You are ADE's local code reviewer.",
    "Review only the provided local diff bundle.",
    `This pass is ${args.pass.label.toLowerCase()} and it focuses on ${args.pass.focus}.`,
    "Prioritize correctness, regressions, security, data loss, race conditions, risky migrations, and missing tests.",
    "Do not suggest style-only nits or speculative rewrites.",
    "Every finding must include concrete evidence from the diff bundle or supplied review context.",
    `Return strict JSON only with this exact top-level shape: {"summary": string, "findings": Finding[]}.`,
    "Each Finding must be an object with:",
    '- "title": short issue title',
    '- "severity": one of "critical", "high", "medium", "low", "info"',
    '- "findingClass": optional, one of "intent_drift", "incomplete_rollout", "late_stage_regression", or null',
    '- "body": concise explanation of the risk and why it matters',
    '- "confidence": number between 0 and 1',
    '- "filePath": changed file path when known, otherwise null',
    '- "line": line number when known, otherwise null',
    '- "evidence": array of objects with {"summary": string, "quote": string|null, "filePath": string|null, "line": number|null, "artifactId": string|null}',
    `Return at most ${args.run.config.budgets.maxFindingsPerPass ?? args.run.config.budgets.maxFindings} findings.`,
    "If there are no real issues, return an empty findings array and explain that in summary.",
    "",
    `Pass key: ${args.pass.key}`,
    `Review target: ${args.run.targetLabel}`,
    `Selection mode: ${args.run.config.selectionMode}`,
    `Publish behavior: ${args.run.config.publishBehavior}`,
    "",
    "Pass guidance:",
    ...args.pass.extraInstructions.map((instruction) => `- ${instruction}`),
    ...(ruleGuidance.length > 0 ? ["", "Matched rule guidance:", ...ruleGuidance.map((instruction) => `- ${instruction}`)] : []),
    "",
    "Changed files:",
    changedFilesSummary,
    "",
    "Context artifact ids you may cite in evidence when relevant:",
    ...buildContextArtifactHints({
      artifactIds: args.contextArtifactIds,
      includeValidation,
    }),
    "",
    "ADE provenance and intent context:",
    args.context.provenance.prompt,
    "",
    "Repo/path rule overlays:",
    args.context.rules.prompt,
    "",
    "Checks and validation context:",
    includeValidation ? args.context.validation.prompt : "- Full validation evidence is reserved for the checks-and-tests pass.",
    "",
    "Diff bundle:",
    truncateText(args.diffText, args.run.config.budgets.maxPromptChars),
  ].join("\n");
}

function parseEvidence(value: unknown): ReviewEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const summary = cleanLine(String(entry.summary ?? ""));
    if (!summary) return [];
    const rawKind = typeof entry.kind === "string" ? entry.kind.trim().toLowerCase() : "";
    const kind: ReviewEvidence["kind"] =
      rawKind === "artifact"
        ? "artifact"
        : rawKind === "file_snapshot"
          ? "file_snapshot"
          : rawKind === "diff_hunk"
            ? "diff_hunk"
            : "quote";
    return [{
      kind,
      summary,
      filePath: typeof entry.filePath === "string" ? entry.filePath.trim() || null : null,
      line: typeof entry.line === "number" && Number.isInteger(entry.line) && entry.line > 0 ? entry.line : null,
      quote: typeof entry.quote === "string" ? entry.quote.trim() || null : null,
      artifactId: typeof entry.artifactId === "string" ? entry.artifactId.trim() || null : null,
    }];
  });
}

function computeAnchorState(args: {
  filePath: string | null;
  line: number | null;
  changedFilesByPath: Map<string, { excerpt: string; lineNumbers: Set<number> }>;
}): "anchored" | "file_only" | "missing" {
  if (!args.filePath) return "missing";
  const match = args.changedFilesByPath.get(args.filePath);
  if (!match) return "missing";
  if (args.line == null) return "file_only";
  return match.lineNumbers.has(args.line) ? "anchored" : "file_only";
}

function hasConcreteEvidence(evidence: ReviewEvidence[]): boolean {
  return evidence.some((entry) => {
    if (entry.kind === "artifact") return false;
    return Boolean(
      (typeof entry.quote === "string" && entry.quote.trim().length > 0)
      || (entry.filePath && entry.line != null)
      || (entry.filePath && entry.kind === "diff_hunk"),
    );
  });
}

function scoreEvidence(evidence: ReviewEvidence[]): number {
  if (evidence.length === 0) return 0;
  const quoteCount = evidence.filter((entry) => typeof entry.quote === "string" && entry.quote.trim().length > 0).length;
  const anchoredCount = evidence.filter((entry) => Boolean(entry.filePath) && entry.line != null).length;
  const artifactCount = evidence.filter((entry) => entry.kind === "artifact" && entry.artifactId).length;
  return clampNumber(
    0.18
      + Math.min(quoteCount, 3) * 0.18
      + Math.min(anchoredCount, 2) * 0.12
      + Math.min(artifactCount, 2) * 0.08,
    0,
    1,
  );
}

function isLowSignalFinding(args: {
  title: string;
  body: string;
  severity: ReviewSeverity;
  confidence: number;
  evidenceScore: number;
}): boolean {
  const text = `${args.title} ${args.body}`.toLowerCase();
  const nitPatterns = [
    /\bnit\b/,
    /\bnitpick\b/,
    /\bstyle\b/,
    /\bformat(?:ting)?\b/,
    /\bwhitespace\b/,
    /\brename\b/,
    /\bnaming\b/,
    /\bcomment\b/,
    /\btypo\b/,
    /\bdocs?\b/,
  ];
  const looksNitpicky = nitPatterns.some((pattern) => pattern.test(text));
  return looksNitpicky && args.severity !== "critical" && args.severity !== "high" && args.confidence < 0.8 && args.evidenceScore < 0.7;
}

function buildCandidateScore(args: {
  severity: ReviewSeverity;
  confidence: number;
  evidenceScore: number;
  passCount?: number;
}): number {
  const corroborationBonus = Math.max(0, (args.passCount ?? 1) - 1) * 0.15;
  return Number((SEVERITY_SCORE[args.severity] + args.confidence * 2 + args.evidenceScore * 1.5 + corroborationBonus).toFixed(4));
}

function tokenizeFindingText(value: string): string[] {
  return cleanLine(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3)
    .filter((token) => !new Set([
      "this",
      "that",
      "with",
      "from",
      "into",
      "when",
      "then",
      "there",
      "return",
      "returns",
      "added",
      "change",
      "changes",
      "issue",
      "risk",
      "will",
      "could",
      "should",
      "missing",
      "tests",
      "test",
      "check",
      "checks",
      "code",
      "file",
      "files",
    ]).has(token));
}

function similarityScore(left: string, right: string): number {
  const leftTokens = tokenizeFindingText(left);
  const rightTokens = tokenizeFindingText(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const intersection = Array.from(leftSet).filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? intersection / union : 0;
}

function hasOverlappingEvidence(left: PassCandidateFinding, right: PassCandidateFinding): boolean {
  for (const leftEntry of left.evidence) {
    for (const rightEntry of right.evidence) {
      if (leftEntry.filePath && leftEntry.filePath === rightEntry.filePath && leftEntry.line != null && leftEntry.line === rightEntry.line) {
        return true;
      }
      if (leftEntry.quote && rightEntry.quote && cleanLine(leftEntry.quote) === cleanLine(rightEntry.quote)) {
        return true;
      }
    }
  }
  return false;
}

function findingsOverlap(left: PassCandidateFinding, right: PassCandidateFinding): boolean {
  const sameFile = left.filePath && right.filePath && left.filePath === right.filePath;
  const lineDistance = left.line != null && right.line != null ? Math.abs(left.line - right.line) : null;
  const titleSimilarity = similarityScore(left.title, right.title);
  const bodySimilarity = similarityScore(left.body, right.body);
  const similarText = Math.max(titleSimilarity, bodySimilarity, similarityScore(`${left.title} ${left.body}`, `${right.title} ${right.body}`));
  if (sameFile && lineDistance != null && lineDistance <= 3 && similarText >= 0.22) return true;
  if (sameFile && similarText >= 0.35) return true;
  if (hasOverlappingEvidence(left, right) && similarText >= 0.18) return true;
  return !left.filePath && !right.filePath && similarText >= 0.65;
}

function dedupeEvidenceEntries(evidence: ReviewEvidence[]): ReviewEvidence[] {
  const seen = new Set<string>();
  const deduped: ReviewEvidence[] = [];
  for (const entry of evidence) {
    const key = JSON.stringify([
      entry.kind,
      entry.summary,
      entry.filePath,
      entry.line,
      entry.quote,
      entry.artifactId,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function normalizeParsedFindings(args: {
  runId: string;
  passKey: ReviewPassKey;
  parsed: Record<string, unknown> | null;
  changedFilesByPath: Map<string, { excerpt: string; lineNumbers: Set<number> }>;
}): { summary: string | null; findings: PassCandidateFinding[] } {
  const findingsRaw = Array.isArray(args.parsed?.findings) ? args.parsed?.findings : [];
  const findings = findingsRaw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const title = cleanLine(String(entry.title ?? ""));
    const body = cleanLine(String(entry.body ?? ""));
    if (!title || !body) return [];
    const filePath = typeof entry.filePath === "string" ? entry.filePath.trim() || null : null;
    const line = typeof entry.line === "number" && Number.isInteger(entry.line) && entry.line > 0 ? entry.line : null;
    const computedEvidence = parseEvidence(entry.evidence);
    const fallbackFile = filePath ? args.changedFilesByPath.get(filePath) : null;
    const evidence: ReviewEvidence[] = computedEvidence.length > 0
      ? computedEvidence
      : fallbackFile
        ? [{
            kind: "diff_hunk" as const,
            summary: `Relevant diff context from ${filePath}`,
            filePath,
            line,
            quote: fallbackFile.excerpt || null,
            artifactId: null,
          }]
        : [];
    const anchorState = computeAnchorState({
      filePath,
      line,
      changedFilesByPath: args.changedFilesByPath,
    });
    const evidenceScore = scoreEvidence(evidence);
    const confidence = normalizeConfidence(entry.confidence);
    const finding: PassCandidateFinding = {
      id: randomUUID(),
      runId: args.runId,
      passKey: args.passKey,
      title,
      severity: normalizeSeverity(entry.severity),
      findingClass: normalizeFindingClass(entry.findingClass),
      body,
      confidence,
      evidence,
      filePath,
      line,
      anchorState,
      evidenceScore,
      lowSignal: isLowSignalFinding({
        title,
        body,
        severity: normalizeSeverity(entry.severity),
        confidence,
        evidenceScore,
      }),
      score: buildCandidateScore({
        severity: normalizeSeverity(entry.severity),
        confidence,
        evidenceScore,
      }),
    };
    return [finding];
  });

  const summary = typeof args.parsed?.summary === "string" ? cleanLine(args.parsed.summary) : null;
  return { summary, findings };
}

function summarizeAdjudication(args: {
  keptFindings: ReviewFinding[];
  rejected: AdjudicationRejectedFinding[];
  totalCandidateCount: number;
}): string {
  if (args.keptFindings.length === 0) {
    if (args.totalCandidateCount === 0) {
      return "Multi-pass review completed with no actionable findings.";
    }
    return "Multi-pass review completed, but every candidate was filtered out during adjudication.";
  }

  const corroboratedCount = args.keptFindings.filter((finding) => (finding.originatingPasses?.length ?? 0) > 1).length;
  const publicationEligibleCount = args.keptFindings.filter((finding) => finding.adjudication?.publicationEligible).length;
  return [
    `Multi-pass review kept ${args.keptFindings.length} high-signal finding(s) from ${args.totalCandidateCount} candidate(s).`,
    corroboratedCount > 0 ? `${corroboratedCount} finding(s) were corroborated by multiple passes.` : null,
    publicationEligibleCount > 0 ? `${publicationEligibleCount} finding(s) cleared the publication threshold.` : null,
    args.rejected.length > 0 ? `${args.rejected.length} candidate(s) were filtered during adjudication.` : null,
  ].filter((line): line is string => Boolean(line)).join(" ");
}

function selectPreferredAnchor(findings: PassCandidateFinding[]): Pick<PassCandidateFinding, "filePath" | "line" | "anchorState"> {
  const ranked = [...findings].sort((left, right) => {
    const anchorDelta = (left.anchorState === "anchored" ? 2 : left.anchorState === "file_only" ? 1 : 0)
      - (right.anchorState === "anchored" ? 2 : right.anchorState === "file_only" ? 1 : 0);
    if (anchorDelta !== 0) return -anchorDelta;
    if (left.filePath && !right.filePath) return -1;
    if (!left.filePath && right.filePath) return 1;
    return (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER);
  });
  const preferred = ranked[0];
  return {
    filePath: preferred?.filePath ?? null,
    line: preferred?.line ?? null,
    anchorState: preferred?.anchorState ?? "missing",
  };
}

function combineConfidence(findings: PassCandidateFinding[]): number {
  const combined = findings.reduce((product, finding) => product * (1 - clampNumber(finding.confidence, 0, 1)), 1);
  return clampNumber(1 - combined, 0, 0.99);
}

function groupPassCandidates(candidates: PassCandidateFinding[]): PassCandidateFinding[][] {
  const remaining = [...candidates].sort((left, right) => right.score - left.score);
  const groups: PassCandidateFinding[][] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift();
    if (!seed) continue;
    const group = [seed];
    let index = 0;
    while (index < remaining.length) {
      const candidate = remaining[index];
      if (candidate && group.some((entry) => findingsOverlap(entry, candidate))) {
        group.push(candidate);
        remaining.splice(index, 1);
        continue;
      }
      index += 1;
    }
    groups.push(group);
  }
  return groups;
}

function getCandidatePathSet(group: PassCandidateFinding[]): string[] {
  return Array.from(new Set(
    group.flatMap((candidate) => [
      candidate.filePath,
      ...candidate.evidence.map((entry) => entry.filePath),
    ]).filter((value): value is string => Boolean(value?.trim())),
  ));
}

function countConcreteAnchorFiles(evidence: ReviewEvidence[]): number {
  return new Set(
    evidence
      .filter((entry) => entry.kind !== "artifact")
      .filter((entry) => Boolean(entry.filePath) && (entry.line != null || (entry.quote?.trim() ?? "").length > 0 || entry.kind === "diff_hunk"))
      .map((entry) => entry.filePath as string),
  ).size;
}

function hasArtifactEvidence(evidence: ReviewEvidence[], artifactIds: string[]): boolean {
  const allowed = new Set(artifactIds);
  return evidence.some((entry) => entry.kind === "artifact" && entry.artifactId && allowed.has(entry.artifactId));
}

function buildContextArtifactEvidence(args: {
  group: PassCandidateFinding[];
  context: ReviewContextPacket;
  artifactIds: ReviewContextArtifactIds;
  relevantOverlays: MatchedReviewRuleOverlay[];
}): ReviewEvidence[] {
  const pathSet = new Set(getCandidatePathSet(args.group));
  const evidence: ReviewEvidence[] = [];
  if (args.relevantOverlays.length > 0) {
    evidence.push({
      kind: "artifact",
      summary: `Matched rule overlays: ${args.relevantOverlays.map((overlay) => overlay.id).join(", ")}`,
      filePath: null,
      line: null,
      quote: null,
      artifactId: args.artifactIds.rulesArtifactId,
    });
  }
  const lateStageMatches = args.context.provenance.payload.lateStageSignals.filter((signal) =>
    signal.filePaths.some((filePath) => pathSet.has(filePath)),
  );
  if (lateStageMatches.length > 0) {
    evidence.push({
      kind: "artifact",
      summary: `Late-stage ADE signals overlap this area: ${lateStageMatches.map((signal) => signal.summary).join(" | ")}`,
      filePath: null,
      line: null,
      quote: null,
      artifactId: args.artifactIds.provenanceArtifactId,
    });
  }
  const includesChecksPass = args.group.some((candidate) => candidate.passKey === "checks-and-tests");
  if (includesChecksPass && args.context.validation.payload.signals.length > 0) {
    evidence.push({
      kind: "artifact",
      summary: `Validation signals: ${args.context.validation.payload.signals.slice(0, 2).map((signal) => signal.summary).join(" | ")}`,
      filePath: null,
      line: null,
      quote: null,
      artifactId: args.artifactIds.validationArtifactId,
    });
  }
  return evidence;
}

function inferFindingClass(args: {
  group: PassCandidateFinding[];
  context: ReviewContextPacket;
  relevantOverlays: MatchedReviewRuleOverlay[];
}): ReviewFindingClass | null {
  const explicitClass = mergeFindingClass(args.group.map((candidate) => candidate.findingClass));
  if (explicitClass) return explicitClass;
  const pathSet = new Set(getCandidatePathSet(args.group));
  const hasLateStageSignal = args.context.provenance.payload.lateStageSignals.some((signal) =>
    signal.filePaths.some((filePath) => pathSet.has(filePath)),
  );
  if (hasLateStageSignal) return "late_stage_regression";
  const hasStrictMissingRollout = args.relevantOverlays.some((overlay) =>
    overlay.adjudicationPolicy.evidenceMode === "cross_boundary" && overlay.missingFamilies.length > 0,
  );
  if (hasStrictMissingRollout) return "incomplete_rollout";
  const hasIntentContext = Boolean(
    args.context.provenance.payload.missions.length > 0
    || args.context.provenance.payload.laneSnapshot?.agentSummary
    || args.context.provenance.payload.laneSnapshot?.missionSummary,
  );
  const wordingSuggestsDrift = args.group.some((candidate) =>
    /\b(expected|intent|should|instead|missing|omits?|drift)\b/i.test(`${candidate.title} ${candidate.body}`),
  );
  if (hasIntentContext && wordingSuggestsDrift) {
    return "intent_drift";
  }
  return null;
}

function evaluateRuleEvidencePolicy(args: {
  evidence: ReviewEvidence[];
  relevantOverlays: MatchedReviewRuleOverlay[];
  artifactIds: ReviewContextArtifactIds;
}): { ok: boolean; detail: string | null } {
  const strictOverlays = args.relevantOverlays.filter((overlay) => overlay.adjudicationPolicy.evidenceMode === "cross_boundary");
  if (strictOverlays.length === 0) {
    return { ok: true, detail: null };
  }
  const concreteAnchorFiles = countConcreteAnchorFiles(args.evidence);
  const hasSupportArtifact = hasArtifactEvidence(args.evidence, [
    args.artifactIds.provenanceArtifactId,
    args.artifactIds.validationArtifactId,
  ]);
  if (concreteAnchorFiles >= 2 || (concreteAnchorFiles >= 1 && hasSupportArtifact)) {
    return { ok: true, detail: null };
  }
  return {
    ok: false,
    detail: `Rule overlays ${strictOverlays.map((overlay) => overlay.id).join(", ")} require either two concrete file anchors or one concrete anchor plus provenance/validation artifact support.`,
  };
}

function adjudicatePassFindings(args: {
  runId: string;
  passResults: PassExecutionResult[];
  budgets: ReviewRunConfig["budgets"];
  context: ReviewContextPacket;
  artifactIds: ReviewContextArtifactIds;
}): AdjudicationOutcome {
  const allCandidates = args.passResults.flatMap((result) => result.candidates);
  const groupedCandidates = groupPassCandidates(allCandidates);
  const findings: ReviewFinding[] = [];
  const rejected: AdjudicationRejectedFinding[] = [];

  for (const group of groupedCandidates) {
    const passes = Array.from(new Set(group.map((candidate) => candidate.passKey))).sort(
      (left, right) => REVIEW_PASS_ORDER.indexOf(left) - REVIEW_PASS_ORDER.indexOf(right),
    );
    const bestCandidate = [...group].sort((left, right) => right.score - left.score)[0];
    if (!bestCandidate) continue;
    const candidatePaths = getCandidatePathSet(group);
    const relevantOverlays = args.context.matchedRuleOverlays.filter((overlay) =>
      candidatePaths.some((filePath) => overlayMatchesPath(overlay, filePath)),
    );
    const mergedEvidence = dedupeEvidenceEntries([
      ...group.flatMap((candidate) => candidate.evidence),
      ...args.passResults
        .filter((result) => passes.includes(result.pass.key))
        .map((result) => ({
          kind: "artifact" as const,
          summary: `Raw ${result.pass.key} pass output`,
          filePath: null,
          line: null,
          quote: null,
          artifactId: result.findingsArtifactId,
        })),
      ...buildContextArtifactEvidence({
        group,
        context: args.context,
        artifactIds: args.artifactIds,
        relevantOverlays,
      }),
    ]).slice(0, 10);
    const evidenceScore = Math.max(bestCandidate.evidenceScore, scoreEvidence(mergedEvidence));
    const lowSignal = group.every((candidate) => candidate.lowSignal);
    const findingClass = inferFindingClass({
      group,
      context: args.context,
      relevantOverlays,
    });
    const score = buildCandidateScore({
      severity: group
        .map((candidate) => candidate.severity)
        .sort((left, right) => SEVERITY_SCORE[right] - SEVERITY_SCORE[left])[0] ?? bestCandidate.severity,
      confidence: combineConfidence(group),
      evidenceScore,
      passCount: passes.length,
    });

    if (!hasConcreteEvidence(mergedEvidence)) {
      rejected.push({
        candidateIds: group.map((candidate) => candidate.id),
        passKeys: passes,
        title: bestCandidate.title,
        reason: "low_evidence",
        detail: "The finding did not retain enough concrete evidence after adjudication.",
        score,
      });
      continue;
    }

    if (lowSignal && passes.length < 2) {
      rejected.push({
        candidateIds: group.map((candidate) => candidate.id),
        passKeys: passes,
        title: bestCandidate.title,
        reason: "low_signal",
        detail: "The finding looked nitpicky and was not corroborated by another pass.",
        score,
      });
      continue;
    }

    const rulePolicy = evaluateRuleEvidencePolicy({
      evidence: mergedEvidence,
      relevantOverlays,
      artifactIds: args.artifactIds,
    });
    if (!rulePolicy.ok) {
      rejected.push({
        candidateIds: group.map((candidate) => candidate.id),
        passKeys: passes,
        title: bestCandidate.title,
        reason: "rule_policy",
        detail: rulePolicy.detail ?? "The finding did not satisfy the matched repo/path rule evidence policy.",
        score,
      });
      continue;
    }

    const preferredAnchor = selectPreferredAnchor(group);
    const confidence = combineConfidence(group);
    const severity = group
      .map((candidate) => candidate.severity)
      .sort((left, right) => SEVERITY_SCORE[right] - SEVERITY_SCORE[left])[0] ?? bestCandidate.severity;
    const publicationEligible = evidenceScore >= 0.55 && confidence >= 0.45 && severity !== "info";
    const adjudication: ReviewFindingAdjudication = {
      score,
      candidateCount: group.length,
      mergedFindingIds: group.map((candidate) => candidate.id),
      rationale: [
        passes.length > 1
          ? `Merged overlapping findings from ${passes.join(", ")} with shared evidence.`
          : "Accepted because the finding carried concrete evidence and cleared the adjudication threshold.",
        relevantOverlays.length > 0
          ? `Matched rule overlays: ${relevantOverlays.map((overlay) => overlay.id).join(", ")}.`
          : null,
        findingClass ? `Primary ADE-native class: ${findingClass}.` : null,
      ].filter((value): value is string => Boolean(value)).join(" "),
      publicationEligible,
    };

    findings.push({
      id: randomUUID(),
      runId: args.runId,
      title: bestCandidate.title,
      severity,
      findingClass,
      body: passes.length > 1
        ? `${bestCandidate.body} This risk was corroborated by ${passes.join(", ")}.`
        : bestCandidate.body,
      confidence,
      evidence: mergedEvidence,
      filePath: preferredAnchor.filePath,
      line: preferredAnchor.line,
      anchorState: preferredAnchor.anchorState,
      sourcePass: "adjudicated" as ReviewSourcePass,
      publicationState: "local_only" as ReviewPublicationState,
      originatingPasses: passes,
      adjudication,
    });
  }

  const keptFindings = findings
    .sort((left, right) => (right.adjudication?.score ?? 0) - (left.adjudication?.score ?? 0))
    .slice(0, args.budgets.maxFindings);
  const keptIds = new Set(keptFindings.map((finding) => finding.id));
  for (const finding of findings) {
    if (keptIds.has(finding.id)) continue;
    rejected.push({
      candidateIds: finding.adjudication?.mergedFindingIds ?? [],
      passKeys: finding.originatingPasses ?? [],
      title: finding.title,
      reason: "budget",
      detail: "The finding cleared adjudication but was trimmed by the run-level budget.",
      score: finding.adjudication?.score ?? 0,
    });
  }

  const publicationEligibleCount = keptFindings.filter((finding) => finding.adjudication?.publicationEligible).length;
  return {
    summary: summarizeAdjudication({
      keptFindings,
      rejected,
      totalCandidateCount: allCandidates.length,
    }),
    findings: keptFindings,
    rejected,
    publicationEligibleCount,
    totalCandidateCount: allCandidates.length,
  };
}

function deriveRepoKey(target: ReviewPublicationDestination | null, fallbackProjectId: string): string {
  if (target && target.kind === "github_pr_review") {
    if (target.repoOwner && target.repoName) {
      return `${target.repoOwner}/${target.repoName}`.toLowerCase();
    }
  }
  return `project:${fallbackProjectId}`;
}

function tallySeveritySummary(findings: ReviewFinding[]): ReviewSeveritySummary {
  const summary = defaultSeveritySummary();
  for (const finding of findings) {
    summary[finding.severity] += 1;
  }
  return summary;
}

function mapRunRow(row: ReviewRunRow): ReviewRun {
  const config = safeJsonParse<ReviewRunConfig>(row.config_json, {
    compareAgainst: { kind: "default_branch" },
    selectionMode: "full_diff",
    dirtyOnly: false,
    modelId: DEFAULT_REVIEW_MODEL_ID,
    reasoningEffort: null,
    budgets: DEFAULT_BUDGETS,
    publishBehavior: "local_only",
  });
  return {
    id: row.id,
    projectId: row.project_id,
    laneId: row.lane_id,
    target: safeJsonParse<ReviewTarget>(row.target_json, {
      mode: "working_tree",
      laneId: row.lane_id,
    }),
    config: {
      ...config,
      budgets: normalizeBudgetConfig(config.budgets),
    },
    targetLabel: row.target_label,
    compareTarget: safeJsonParse<ReviewResolvedCompareTarget | null>(row.compare_target_json, null),
    status: (row.status as ReviewRunStatus) ?? "failed",
    summary: row.summary,
    errorMessage: row.error_message,
    findingCount: Number(row.finding_count ?? 0),
    severitySummary: safeJsonParse<ReviewSeveritySummary>(row.severity_summary_json, defaultSeveritySummary()),
    chatSessionId: row.chat_session_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
  };
}

function mapFindingRow(row: ReviewFindingRow): ReviewFinding {
  return {
    id: row.id,
    runId: row.run_id,
    title: row.title,
    severity: normalizeSeverity(row.severity),
    findingClass: normalizeFindingClass(row.finding_class),
    body: row.body,
    confidence: clampNumber(Number(row.confidence ?? 0.5), 0, 1),
    evidence: safeJsonParse<ReviewEvidence[]>(row.evidence_json, []),
    filePath: row.file_path,
    line: typeof row.line === "number" ? row.line : null,
    anchorState: (row.anchor_state as ReviewFinding["anchorState"]) ?? "missing",
    sourcePass: (row.source_pass as ReviewSourcePass) ?? "single_pass",
    publicationState: (row.publication_state as ReviewPublicationState) ?? "local_only",
    originatingPasses: safeJsonParse<ReviewPassKey[]>(row.originating_passes_json, []),
    adjudication: safeJsonParse<ReviewFindingAdjudication | null>(row.adjudication_json, null),
    diffContext: safeJsonParse<ReviewDiffContext | null>(row.diff_context_json, null),
    suppressionMatch: safeJsonParse<ReviewFindingSuppressionMatch | null>(row.suppression_match_json, null),
  };
}

function mapFeedbackRow(row: ReviewFindingFeedbackRow): ReviewFeedbackRecord {
  return {
    id: row.id,
    findingId: row.finding_id,
    runId: row.run_id,
    kind: (row.kind as ReviewFeedbackKind) ?? "acknowledge",
    reason: (row.reason as ReviewDismissReason | null) ?? null,
    note: row.note,
    snoozeUntil: row.snooze_until,
    createdAt: row.created_at,
  };
}

function mapArtifactRow(row: ReviewRunArtifactRow): ReviewRunArtifact {
  return {
    id: row.id,
    runId: row.run_id,
    artifactType: (row.artifact_type as ReviewArtifactType) ?? "diff_bundle",
    title: row.title,
    mimeType: row.mime_type,
    contentText: row.content_text,
    metadata: safeJsonParse<Record<string, unknown> | null>(row.metadata_json, null),
    createdAt: row.created_at,
  };
}

function mapPublicationRow(row: ReviewRunPublicationRow): ReviewPublication {
  return {
    id: row.id,
    runId: row.run_id,
    destination: safeJsonParse<ReviewPublicationDestination>(row.destination_json, {
      kind: "github_pr_review",
      prId: "",
      repoOwner: "",
      repoName: "",
      prNumber: 0,
      githubUrl: null,
    }),
    reviewEvent: row.review_event as ReviewPublication["reviewEvent"],
    status: row.status === "published" ? "published" : "failed",
    reviewUrl: row.review_url,
    remoteReviewId: row.remote_review_id,
    summaryBody: row.summary_body,
    inlineComments: safeJsonParse<ReviewPublicationInlineComment[]>(row.inline_comments_json, []),
    summaryFindingIds: safeJsonParse<string[]>(row.summary_finding_ids_json, []),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function createReviewService({
  db,
  logger,
  projectId,
  projectRoot,
  projectDefaultBranch,
  laneService,
  gitService,
  agentChatService,
  sessionService,
  sessionDeltaService,
  testService,
  issueInventoryService,
  prService,
  embeddingService,
  onEvent,
}: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  projectRoot: string;
  projectDefaultBranch: string | null;
  laneService: Pick<ReturnType<typeof createLaneService>, "getLaneBaseAndBranch" | "getStateSnapshot" | "list">;
  gitService: Pick<ReturnType<typeof createGitOperationsService>, "listRecentCommits">;
  agentChatService: Pick<ReturnType<typeof createAgentChatService>, "createSession" | "getSessionSummary" | "runSessionTurn">;
  sessionService: Pick<ReturnType<typeof createSessionService>, "updateMeta">;
  sessionDeltaService: Pick<ReturnType<typeof createSessionDeltaService>, "listRecentLaneSessionDeltas">;
  testService: Pick<ReturnType<typeof createTestService>, "listRuns" | "getLogTail" | "listSuites">;
  issueInventoryService: Pick<ReturnType<typeof createIssueInventoryService>, "getInventory">;
  prService?: Pick<ReturnType<typeof createPrService>, "getReviewSnapshot" | "getChecks" | "publishReviewPublication">;
  embeddingService?: Pick<EmbeddingService, "embed"> | null;
  onEvent?: (event: ReviewEventPayload) => void;
}) {
  const materializer = createReviewTargetMaterializer({ laneService, prService });
  const contextBuilder = createReviewContextBuilder({
    db,
    projectId,
    logger,
    laneService,
    sessionDeltaService,
    testService,
    issueInventoryService,
    prService,
  });
  const suppressionService: ReviewSuppressionService = createReviewSuppressionService({
    db,
    logger,
    projectId,
    embeddingService: embeddingService ?? null,
  });
  const activeRuns = new Set<string>();
  const cancelledRuns = new Set<string>();
  let disposed = false;
  const configuredDefaultModelId =
    getDefaultModelDescriptor("codex")?.id
    ?? getDefaultModelDescriptor("opencode")?.id
    ?? REVIEW_MODEL_FALLBACK_ID;
  const defaultReviewModelId = getModelById(configuredDefaultModelId)?.id ?? DEFAULT_REVIEW_MODEL_ID;

  if (defaultReviewModelId !== configuredDefaultModelId) {
    logger.warn("review.default_model_fallback_selected", {
      requestedModelId: configuredDefaultModelId,
      resolvedModelId: defaultReviewModelId,
    });
  }

  function assertNotDisposed(): void {
    if (disposed) {
      throw new Error("Review service is disposed.");
    }
  }

  function emit(event: ReviewEventPayload): void {
    if (disposed) return;
    onEvent?.(event);
  }

  function getRunRow(runId: string): ReviewRunRow | null {
    return db.get<ReviewRunRow>(
      "select * from review_runs where id = ? and project_id = ? limit 1",
      [runId, projectId],
    );
  }

  function updateRun(runId: string, patch: Partial<{
    target_label: string;
    compare_target_json: string | null;
    status: ReviewRunStatus;
    summary: string | null;
    error_message: string | null;
    finding_count: number;
    severity_summary_json: string;
    chat_session_id: string | null;
    ended_at: string | null;
    updated_at: string;
  }>): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch)) {
      sets.push(`${key} = ?`);
      params.push(value ?? null);
    }
    if (sets.length === 0) return;
    params.push(runId, projectId);
    db.run(`update review_runs set ${sets.join(", ")} where id = ? and project_id = ?`, params);
  }

  function insertRun(run: ReviewRun): void {
    db.run(
      `insert into review_runs (
        id,
        project_id,
        lane_id,
        target_json,
        config_json,
        target_label,
        compare_target_json,
        status,
        summary,
        error_message,
        finding_count,
        severity_summary_json,
        chat_session_id,
        created_at,
        started_at,
        ended_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.projectId,
        run.laneId,
        JSON.stringify(run.target),
        JSON.stringify(run.config),
        run.targetLabel,
        run.compareTarget ? JSON.stringify(run.compareTarget) : null,
        run.status,
        run.summary,
        run.errorMessage,
        run.findingCount,
        serializeSeveritySummary(run.severitySummary),
        run.chatSessionId,
        run.createdAt,
        run.startedAt,
        run.endedAt,
        run.updatedAt,
      ],
    );
  }

  function insertArtifact(runId: string, artifact: Omit<ReviewRunArtifact, "id" | "runId" | "createdAt">): ReviewRunArtifact {
    const record: ReviewRunArtifact = {
      id: randomUUID(),
      runId,
      artifactType: artifact.artifactType,
      title: artifact.title,
      mimeType: artifact.mimeType,
      contentText: artifact.contentText,
      metadata: artifact.metadata ?? null,
      createdAt: nowIso(),
    };
    db.run(
      `insert into review_run_artifacts (
        id,
        run_id,
        artifact_type,
        title,
        mime_type,
        content_text,
        metadata_json,
        created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.runId,
        record.artifactType,
        record.title,
        record.mimeType,
        record.contentText,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.createdAt,
      ],
    );
    return record;
  }

  function insertPublication(publication: ReviewPublication): void {
    db.run(
      `insert into review_run_publications (
        id,
        run_id,
        destination_json,
        review_event,
        status,
        review_url,
        remote_review_id,
        summary_body,
        inline_comments_json,
        summary_finding_ids_json,
        error_message,
        created_at,
        updated_at,
        completed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publication.id,
        publication.runId,
        JSON.stringify(publication.destination),
        publication.reviewEvent,
        publication.status,
        publication.reviewUrl,
        publication.remoteReviewId,
        publication.summaryBody,
        JSON.stringify(publication.inlineComments),
        JSON.stringify(publication.summaryFindingIds),
        publication.errorMessage,
        publication.createdAt,
        publication.updatedAt,
        publication.completedAt,
      ],
    );
  }

  function insertFinding(finding: ReviewFinding): void {
    db.run(
      `insert into review_findings (
        id,
        run_id,
        title,
        severity,
        finding_class,
        body,
        confidence,
        evidence_json,
        file_path,
        line,
        anchor_state,
        source_pass,
        publication_state,
        originating_passes_json,
        adjudication_json,
        diff_context_json,
        suppression_match_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finding.id,
        finding.runId,
        finding.title,
        finding.severity,
        finding.findingClass ?? null,
        finding.body,
        finding.confidence,
        JSON.stringify(finding.evidence),
        finding.filePath,
        finding.line,
        finding.anchorState,
        finding.sourcePass,
        finding.publicationState,
        JSON.stringify(finding.originatingPasses ?? []),
        finding.adjudication ? JSON.stringify(finding.adjudication) : null,
        finding.diffContext ? JSON.stringify(finding.diffContext) : null,
        finding.suppressionMatch ? JSON.stringify(finding.suppressionMatch) : null,
      ],
    );
  }

  function updateFindingPublicationState(runId: string, findingId: string, publicationState: ReviewPublicationState): void {
    db.run(
      "update review_findings set publication_state = ? where id = ? and run_id = ?",
      [publicationState, findingId, runId],
    );
  }

  async function listLaunchContext(): Promise<ReviewLaunchContext> {
    assertNotDisposed();
    const lanes = await laneService.list();
    const laneSummaries = lanes.map(mapLaunchLane);
    const recentCommitsByLane = Object.fromEntries(await Promise.all(
      laneSummaries.map(async (lane) => {
        const commits = await gitService.listRecentCommits({ laneId: lane.id, limit: 20 });
        return [lane.id, commits.map(mapLaunchCommit)] as const;
      }),
    ));
    return {
      defaultLaneId: laneSummaries[0]?.id ?? null,
      defaultBranchName: projectDefaultBranch ?? laneSummaries.find((lane) => lane.laneType === "primary")?.branchRef ?? null,
      lanes: laneSummaries,
      recentCommitsByLane,
      recommendedModelId: defaultReviewModelId,
    };
  }

  function resolveConfig(target: ReviewTarget, partial?: Partial<ReviewRunConfig> | null): ReviewRunConfig {
    return {
      compareAgainst: partial?.compareAgainst ?? { kind: "default_branch" },
      selectionMode: partial?.selectionMode
        ?? (target.mode === "commit_range"
          ? "selected_commits"
          : target.mode === "working_tree"
            ? "dirty_only"
            : "full_diff"),
      dirtyOnly: partial?.dirtyOnly ?? target.mode === "working_tree",
      modelId: partial?.modelId?.trim() || defaultReviewModelId,
      reasoningEffort: partial?.reasoningEffort?.trim() || null,
      budgets: normalizeBudgetConfig(partial?.budgets),
      publishBehavior: target.mode === "pr" && partial?.publishBehavior === "auto_publish"
        ? "auto_publish"
        : "local_only",
    };
  }

  async function publishRun(args: {
    runId: string;
    targetLabel: string;
    summary: string | null;
    config: ReviewRunConfig;
    findings: ReviewFinding[];
    publicationTarget: ReviewPublicationDestination | null;
    changedFiles: Array<{ filePath: string; diffPositionsByLine: Record<number, number> }>;
  }): Promise<ReviewPublication | null> {
    if (args.config.publishBehavior !== "auto_publish" || !args.publicationTarget || !prService) {
      return null;
    }

    const publishableFindings = [...args.findings]
      .filter((finding) => finding.sourcePass === "adjudicated" && finding.adjudication?.publicationEligible)
      .sort((left, right) => (right.adjudication?.score ?? 0) - (left.adjudication?.score ?? 0))
      .slice(0, args.config.budgets.maxPublishedFindings ?? args.config.budgets.maxFindings);

    insertArtifact(args.runId, {
      artifactType: "publication_request",
      title: "Review publication request",
      mimeType: "application/json",
      contentText: JSON.stringify({
        destination: args.publicationTarget,
        targetLabel: args.targetLabel,
        summary: args.summary,
        findingIds: publishableFindings.map((finding) => finding.id),
        changedFiles: args.changedFiles,
      }, null, 2),
      metadata: {
        publishBehavior: args.config.publishBehavior,
        findingCount: publishableFindings.length,
        skipped: publishableFindings.length === 0,
      },
    });

    if (publishableFindings.length === 0) {
      return null;
    }

    const publication = await prService.publishReviewPublication({
      runId: args.runId,
      destination: args.publicationTarget,
      targetLabel: args.targetLabel,
      summary: args.summary,
      findings: publishableFindings,
      changedFiles: args.changedFiles,
    });
    insertPublication(publication);
    insertArtifact(args.runId, {
      artifactType: "publication_result",
      title: "Review publication result",
      mimeType: "application/json",
      contentText: JSON.stringify(publication, null, 2),
      metadata: {
        status: publication.status,
        destinationKind: publication.destination.kind,
      },
    });

    if (publication.status === "published") {
      const publishedFindingIds = new Set([
        ...publication.inlineComments.map((comment) => comment.findingId),
        ...publication.summaryFindingIds,
      ]);
      for (const finding of publishableFindings) {
        if (!publishedFindingIds.has(finding.id)) continue;
        updateFindingPublicationState(args.runId, finding.id, "published");
      }
    }

    return publication;
  }

  async function executePass(args: {
    runId: string;
    run: ReviewRun;
    sessionId: string;
    sessionTitle: string;
    descriptorId: string;
    pass: PassDefinition;
    diffText: string;
    changedFiles: MaterializedChangedFile[];
    changedFilesByPath: Map<string, { excerpt: string; lineNumbers: Set<number> }>;
    context: ReviewContextPacket;
    contextArtifactIds: ReviewContextArtifactIds;
  }): Promise<PassExecutionResult> {
    const prompt = buildPassPrompt({
      run: args.run,
      pass: args.pass,
      diffText: args.diffText,
      changedFiles: args.changedFiles,
      context: args.context,
      contextArtifactIds: args.contextArtifactIds,
    });
    const promptArtifact = insertArtifact(args.runId, {
      artifactType: "pass_prompt",
      title: `${args.pass.label} prompt`,
      mimeType: "text/plain",
      contentText: prompt,
      metadata: {
        passKey: args.pass.key,
        modelId: args.descriptorId,
        reasoningEffort: args.run.config.reasoningEffort,
        matchedRuleIds: args.context.rules.metadata.matchedRuleIds ?? [],
      },
    });
    const result = await agentChatService.runSessionTurn({
      sessionId: args.sessionId,
      text: prompt,
      displayText: `${args.sessionTitle} · ${args.pass.label}`,
      reasoningEffort: args.run.config.reasoningEffort,
      timeoutMs: 15 * 60 * 1000,
    });
    const outputArtifact = insertArtifact(args.runId, {
      artifactType: "pass_output",
      title: `${args.pass.label} output`,
      mimeType: "application/json",
      contentText: result.outputText,
      metadata: {
        passKey: args.pass.key,
        provider: result.provider,
        model: result.model,
        modelId: result.modelId ?? args.descriptorId,
      },
    });
    const parsed = extractJsonObject(result.outputText);
    const normalized = normalizeParsedFindings({
      runId: args.runId,
      passKey: args.pass.key,
      parsed,
      changedFilesByPath: args.changedFilesByPath,
    });
    const candidates = [...normalized.findings]
      .sort((left, right) => right.score - left.score)
      .slice(0, args.run.config.budgets.maxFindingsPerPass ?? args.run.config.budgets.maxFindings);
    const findingsArtifact = insertArtifact(args.runId, {
      artifactType: "pass_findings",
      title: `${args.pass.label} findings`,
      mimeType: "application/json",
      contentText: JSON.stringify({
        passKey: args.pass.key,
        summary: normalized.summary,
        totalParsedCount: normalized.findings.length,
        keptCount: candidates.length,
        budgetTrimmedCount: Math.max(0, normalized.findings.length - candidates.length),
        candidates,
      }, null, 2),
      metadata: {
        passKey: args.pass.key,
        summary: normalized.summary,
        totalParsedCount: normalized.findings.length,
        keptCount: candidates.length,
        budgetTrimmedCount: Math.max(0, normalized.findings.length - candidates.length),
      },
    });
    return {
      pass: args.pass,
      summary: normalized.summary,
      candidates,
      promptArtifactId: promptArtifact.id,
      outputArtifactId: outputArtifact.id,
      findingsArtifactId: findingsArtifact.id,
      budgetTrimmedCount: Math.max(0, normalized.findings.length - candidates.length),
    };
  }

  async function executeRun(runId: string): Promise<void> {
    if (disposed || activeRuns.has(runId)) return;
    activeRuns.add(runId);
    try {
      if (disposed) return;
      const row = getRunRow(runId);
      if (!row) return;
      const run = mapRunRow(row);
      if (disposed) return;
      if (cancelledRuns.has(runId)) {
        cancelledRuns.delete(runId);
        const endedAt = nowIso();
        updateRun(runId, {
          status: "cancelled",
          summary: "Run cancelled before execution began.",
          error_message: null,
          ended_at: endedAt,
          updated_at: endedAt,
        });
        emit({ type: "run-completed", runId, laneId: run.laneId, status: "cancelled" });
        emit({ type: "runs-updated", runId, laneId: run.laneId, status: "cancelled" });
        return;
      }
      updateRun(runId, {
        status: "running",
        updated_at: nowIso(),
      });
      emit({ type: "runs-updated", runId, laneId: run.laneId, status: "running" });

      const materialized = await materializer.materialize({
        target: run.target,
        config: run.config,
      });
      if (disposed) return;

      updateRun(runId, {
        target_label: materialized.targetLabel,
        compare_target_json: materialized.compareTarget ? JSON.stringify(materialized.compareTarget) : null,
        updated_at: nowIso(),
      });

      for (const artifact of materialized.artifacts) {
        if (disposed) return;
        insertArtifact(runId, artifact);
      }

      if (disposed) return;
      if (!materialized.fullPatchText.trim()) {
        const endedAt = nowIso();
        updateRun(runId, {
          status: "completed",
          summary: "No changes to review.",
          error_message: null,
          finding_count: 0,
          severity_summary_json: serializeSeveritySummary(defaultSeveritySummary()),
          ended_at: endedAt,
          updated_at: endedAt,
        });
        emit({ type: "run-completed", runId, laneId: run.laneId, status: "completed" });
        emit({ type: "runs-updated", runId, laneId: run.laneId, status: "completed" });
        return;
      }

      const descriptor = getModelById(run.config.modelId);
      if (!descriptor) {
        throw new Error(`Unknown review model '${run.config.modelId}'.`);
      }
      const { provider, model } = resolveChatProviderForDescriptor(descriptor);
      const session = await agentChatService.createSession({
        laneId: run.laneId,
        provider,
        model,
        modelId: descriptor.id,
        reasoningEffort: run.config.reasoningEffort,
        permissionMode: "plan",
        sessionProfile: "workflow",
        surface: "automation",
      });
      if (disposed) return;
      const sessionTitle = `Review: ${materialized.targetLabel}`;
      sessionService.updateMeta({
        sessionId: session.id,
        title: sessionTitle,
      });
      updateRun(runId, {
        chat_session_id: session.id,
        updated_at: nowIso(),
      });
      const effectiveRun: ReviewRun = {
        ...run,
        targetLabel: materialized.targetLabel,
        compareTarget: materialized.compareTarget,
      };
      const diffText = truncateText(materialized.fullPatchText, effectiveRun.config.budgets.maxDiffChars);
      const changedFiles = materialized.changedFiles.slice(0, effectiveRun.config.budgets.maxFiles);
      const reviewContext = await contextBuilder.buildContext({
        run: effectiveRun,
        materialized: {
          ...materialized,
          changedFiles,
        },
      });
      const provenanceArtifact = insertArtifact(runId, {
        artifactType: "provenance_brief",
        title: "Provenance brief",
        mimeType: "application/json",
        contentText: JSON.stringify(reviewContext.provenance.payload, null, 2),
        metadata: reviewContext.provenance.metadata,
      });
      const rulesArtifact = insertArtifact(runId, {
        artifactType: "rule_overlays",
        title: "Rule overlays",
        mimeType: "application/json",
        contentText: JSON.stringify(reviewContext.rules.payload, null, 2),
        metadata: reviewContext.rules.metadata,
      });
      const validationArtifact = insertArtifact(runId, {
        artifactType: "validation_signals",
        title: "Validation signals",
        mimeType: "application/json",
        contentText: JSON.stringify(reviewContext.validation.payload, null, 2),
        metadata: reviewContext.validation.metadata,
      });
      const contextArtifactIds: ReviewContextArtifactIds = {
        provenanceArtifactId: provenanceArtifact.id,
        rulesArtifactId: rulesArtifact.id,
        validationArtifactId: validationArtifact.id,
      };
      insertArtifact(runId, {
        artifactType: "prompt",
        title: "Review harness plan",
        mimeType: "application/json",
        contentText: JSON.stringify({
          targetLabel: materialized.targetLabel,
          passKeys: REVIEW_PASSES.map((pass) => pass.key),
          budgets: effectiveRun.config.budgets,
          changedFiles: changedFiles.map((entry) => entry.filePath),
          context: {
            provenanceSummary: reviewContext.provenance.summary,
            rulesSummary: reviewContext.rules.summary,
            validationSummary: reviewContext.validation.summary,
            matchedRuleIds: reviewContext.rules.metadata.matchedRuleIds ?? [],
            contextArtifactIds,
          },
        }, null, 2),
        metadata: {
          modelId: descriptor.id,
          reasoningEffort: effectiveRun.config.reasoningEffort,
          passCount: REVIEW_PASSES.length,
          matchedRuleCount: reviewContext.rules.metadata.matchedRuleCount ?? 0,
          matchedRuleIds: reviewContext.rules.metadata.matchedRuleIds ?? [],
          provenanceCount: reviewContext.provenance.metadata.provenanceCount ?? 0,
          validationSignalCount: reviewContext.validation.metadata.signalCount ?? 0,
        },
      });

      const changedFilesByPath = new Map(changedFiles.map((entry) => [
        entry.filePath,
        {
          excerpt: entry.excerpt,
          lineNumbers: new Set(entry.lineNumbers),
          diffPositionsByLine: entry.diffPositionsByLine,
        },
      ]));
      const passResults: PassExecutionResult[] = [];
      for (const pass of REVIEW_PASSES) {
        if (disposed) return;
        if (cancelledRuns.has(runId)) {
          cancelledRuns.delete(runId);
          const endedAt = nowIso();
          updateRun(runId, {
            status: "cancelled",
            summary: "Run cancelled during review passes.",
            error_message: null,
            ended_at: endedAt,
            updated_at: endedAt,
          });
          emit({ type: "run-completed", runId, laneId: run.laneId, status: "cancelled" });
          emit({ type: "runs-updated", runId, laneId: run.laneId, status: "cancelled" });
          return;
        }
        const passResult = await executePass({
          runId,
          run: effectiveRun,
          sessionId: session.id,
          sessionTitle,
          descriptorId: descriptor.id,
          pass,
          diffText,
          changedFiles,
          changedFilesByPath,
          context: reviewContext,
          contextArtifactIds,
        });
        passResults.push(passResult);
      }

      if (disposed) return;
      const adjudication = adjudicatePassFindings({
        runId,
        passResults,
        budgets: effectiveRun.config.budgets,
        context: reviewContext,
        artifactIds: contextArtifactIds,
      });
      insertArtifact(runId, {
        artifactType: "adjudication_result",
        title: "Review adjudication",
        mimeType: "application/json",
        contentText: JSON.stringify({
          summary: adjudication.summary,
          totalCandidateCount: adjudication.totalCandidateCount,
          publicationEligibleCount: adjudication.publicationEligibleCount,
          rejected: adjudication.rejected,
          passSummaries: passResults.map((result) => ({
            passKey: result.pass.key,
            summary: result.summary,
            keptCount: result.candidates.length,
            budgetTrimmedCount: result.budgetTrimmedCount,
            findingsArtifactId: result.findingsArtifactId,
          })),
        }, null, 2),
        metadata: {
          acceptedCount: adjudication.findings.length,
          rejectedCount: adjudication.rejected.length,
          publicationEligibleCount: adjudication.publicationEligibleCount,
        },
      });
      insertArtifact(runId, {
        artifactType: "merged_findings",
        title: "Merged review findings",
        mimeType: "application/json",
        contentText: JSON.stringify({
          summary: adjudication.summary,
          findings: adjudication.findings,
        }, null, 2),
        metadata: {
          findingCount: adjudication.findings.length,
          publicationEligibleCount: adjudication.publicationEligibleCount,
        },
      });
      insertArtifact(runId, {
        artifactType: "review_output",
        title: "Adjudicated review output",
        mimeType: "application/json",
        contentText: JSON.stringify({
          summary: adjudication.summary,
          findings: adjudication.findings,
        }, null, 2),
        metadata: {
          stage: "adjudicated",
          findingCount: adjudication.findings.length,
        },
      });

      const repoKey = deriveRepoKey(materialized.publicationTarget, projectId);
      const enrichedFindings: ReviewFinding[] = [];
      for (const finding of adjudication.findings) {
        if (disposed) return;
        const diffContext = buildDiffContextForFinding({
          filePath: finding.filePath,
          anchoredLine: finding.line,
          patches: materialized.changedFiles.map((entry) => ({ filePath: entry.filePath, excerpt: entry.excerpt })),
        });
        const toolEvidence = buildToolBackedEvidence({
          finding,
          validation: reviewContext.validation.payload,
          artifactIdByKey: { validation_signals: contextArtifactIds.validationArtifactId },
        });
        const suppressionMatch = await suppressionService.match({ finding, repoKey }).catch((error) => {
          logger.warn("review.suppression.match_failed", {
            findingId: finding.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        enrichedFindings.push({
          ...finding,
          evidence: toolEvidence.length > 0 ? [...finding.evidence, ...toolEvidence] : finding.evidence,
          diffContext,
          suppressionMatch,
        });
      }
      const findings = enrichedFindings;
      for (const finding of findings) {
        if (disposed) return;
        insertFinding(finding);
      }
      if (disposed) return;
      if (cancelledRuns.has(runId)) {
        cancelledRuns.delete(runId);
        const endedAt = nowIso();
        updateRun(runId, {
          status: "cancelled",
          summary: "Run cancelled before publication.",
          error_message: null,
          finding_count: findings.length,
          severity_summary_json: serializeSeveritySummary(tallySeveritySummary(findings)),
          ended_at: endedAt,
          updated_at: endedAt,
        });
        emit({ type: "run-completed", runId, laneId: run.laneId, status: "cancelled" });
        emit({ type: "runs-updated", runId, laneId: run.laneId, status: "cancelled" });
        return;
      }
      const publishableFindings = findings.filter((finding) => finding.suppressionMatch == null);
      const suppressedCount = findings.length - publishableFindings.length;
      if (suppressedCount > 0) {
        insertArtifact(runId, {
          artifactType: "tool_evidence",
          title: "Suppression filter summary",
          mimeType: "application/json",
          contentText: JSON.stringify({
            suppressedCount,
            suppressedFindingIds: findings
              .filter((finding) => finding.suppressionMatch != null)
              .map((finding) => finding.id),
          }, null, 2),
          metadata: { suppressedCount },
        });
      }
      await publishRun({
        runId,
        targetLabel: materialized.targetLabel,
        summary: adjudication.summary,
        config: effectiveRun.config,
        findings: publishableFindings,
        publicationTarget: materialized.publicationTarget,
        changedFiles: materialized.changedFiles.map((entry) => ({
          filePath: entry.filePath,
          diffPositionsByLine: entry.diffPositionsByLine,
        })),
      });
      if (disposed) return;
      const severitySummary = tallySeveritySummary(findings);
      const endedAt = nowIso();
      const cancelledDuringPublish = cancelledRuns.has(runId);
      if (cancelledDuringPublish) cancelledRuns.delete(runId);
      updateRun(runId, {
        status: cancelledDuringPublish ? "cancelled" : "completed",
        summary: adjudication.summary,
        error_message: null,
        finding_count: findings.length,
        severity_summary_json: serializeSeveritySummary(severitySummary),
        ended_at: endedAt,
        updated_at: endedAt,
      });
      const finalStatus = cancelledDuringPublish ? "cancelled" : "completed";
      emit({ type: "run-completed", runId, laneId: run.laneId, status: finalStatus });
      emit({ type: "runs-updated", runId, laneId: run.laneId, status: finalStatus });
    } catch (error) {
      if (disposed) return;
      const endedAt = nowIso();
      updateRun(runId, {
        status: "failed",
        error_message: getErrorMessage(error),
        ended_at: endedAt,
        updated_at: endedAt,
      });
      logger.warn("review.run_failed", {
        runId,
        projectRoot,
        error: getErrorMessage(error),
      });
      const row = getRunRow(runId);
      emit({
        type: "run-completed",
        runId,
        laneId: row?.lane_id ?? "",
        status: "failed",
      });
      emit({ type: "runs-updated", runId, laneId: row?.lane_id ?? "", status: "failed" });
    } finally {
      activeRuns.delete(runId);
      cancelledRuns.delete(runId);
    }
  }

  async function startRun(args: ReviewStartRunArgs): Promise<ReviewRun> {
    assertNotDisposed();
    const laneId = resolveTargetLaneId(args.target);
    laneService.getLaneBaseAndBranch(laneId);
    if (args.target.mode === "pr" && !prService) {
      throw new Error("PR-backed review runs are not available in this workspace.");
    }
    const config = resolveConfig(args.target, args.config);
    const startedAt = nowIso();
    const run: ReviewRun = {
      id: randomUUID(),
      projectId,
      laneId,
      target: args.target,
      config,
      targetLabel: args.target.mode === "commit_range"
        ? `${laneId} ${args.target.baseCommit.slice(0, 7)}..${args.target.headCommit.slice(0, 7)}`
        : args.target.mode === "pr"
          ? `PR ${args.target.prId}`
        : args.target.mode === "working_tree"
          ? `${laneId} working tree`
          : `${laneId} review`,
      compareTarget: null,
      status: "queued",
      summary: null,
      errorMessage: null,
      findingCount: 0,
      severitySummary: defaultSeveritySummary(),
      chatSessionId: null,
      createdAt: startedAt,
      startedAt,
      endedAt: null,
      updatedAt: startedAt,
    };
    insertRun(run);
    emit({ type: "run-started", runId: run.id, laneId });
    emit({ type: "runs-updated", runId: run.id, laneId, status: "queued" });
    void executeRun(run.id);
    return run;
  }

  async function rerun(runId: string): Promise<ReviewRun> {
    assertNotDisposed();
    const row = getRunRow(runId);
    if (!row) throw new Error(`Review run '${runId}' was not found.`);
    const existing = mapRunRow(row);
    return startRun({
      target: existing.target,
      config: existing.config,
    });
  }

  async function listRuns(args: ReviewListRunsArgs = {}): Promise<ReviewRun[]> {
    assertNotDisposed();
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit ?? 50)));
    const sql = [
      "select * from review_runs where project_id = ?",
      args.laneId ? "and lane_id = ?" : "",
      args.status && args.status !== "all" ? "and status = ?" : "",
      "order by created_at desc limit ?",
    ].join(" ");
    const params: Array<string | number> = [projectId];
    if (args.laneId) params.push(args.laneId);
    if (args.status && args.status !== "all") params.push(args.status);
    params.push(limit);
    return db.all<ReviewRunRow>(sql, params).map(mapRunRow);
  }

  async function getRunDetail(args: { runId: string }): Promise<ReviewRunDetail | null> {
    assertNotDisposed();
    const row = getRunRow(args.runId);
    if (!row) return null;
    const run = mapRunRow(row);
    const rawFindings = db.all<ReviewFindingRow>(
      `select * from review_findings
       where run_id = ?
       order by
         case severity
           when 'critical' then 0
           when 'high' then 1
           when 'medium' then 2
           when 'low' then 3
           else 4
         end asc,
         coalesce(file_path, '') asc,
         coalesce(line, 2147483647) asc,
         title asc`,
      [args.runId],
    ).map(mapFindingRow);
    const feedbackByFinding = new Map<string, ReviewFeedbackRecord>();
    const feedbackRows = db.all<ReviewFindingFeedbackRow>(
      "select * from review_finding_feedback where run_id = ? order by created_at asc",
      [args.runId],
    );
    for (const feedbackRow of feedbackRows) {
      const record = mapFeedbackRow(feedbackRow);
      feedbackByFinding.set(record.findingId, record);
    }
    const findings = rawFindings.map((finding) => ({
      ...finding,
      feedback: feedbackByFinding.get(finding.id) ?? null,
    }));
    const artifacts = db.all<ReviewRunArtifactRow>(
      "select * from review_run_artifacts where run_id = ? order by created_at asc",
      [args.runId],
    ).map(mapArtifactRow);
    const publications = db.all<ReviewRunPublicationRow>(
      "select * from review_run_publications where run_id = ? order by created_at asc",
      [args.runId],
    ).map(mapPublicationRow);
    const chatSession = run.chatSessionId
      ? await agentChatService.getSessionSummary(run.chatSessionId).catch(() => null)
      : null;
    return {
      ...run,
      findings,
      artifacts,
      publications,
      chatSession,
    };
  }

  async function cancelRun(args: { runId: string }): Promise<ReviewRun | null> {
    assertNotDisposed();
    const row = getRunRow(args.runId);
    if (!row) return null;
    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      return mapRunRow(row);
    }
    cancelledRuns.add(args.runId);
    const endedAt = nowIso();
    updateRun(args.runId, {
      status: "cancelled",
      summary: row.summary ?? "Cancellation requested; finishing current pass.",
      ended_at: endedAt,
      updated_at: endedAt,
    });
    const refreshed = getRunRow(args.runId);
    if (refreshed) {
      emit({ type: "runs-updated", runId: args.runId, laneId: refreshed.lane_id, status: "cancelled" });
    }
    return refreshed ? mapRunRow(refreshed) : null;
  }

  async function recordFeedback(args: ReviewRecordFeedbackArgs): Promise<ReviewFeedbackRecord> {
    assertNotDisposed();
    const findingRow = db.get<ReviewFindingRow & { project_id?: string }>(
      `select rf.*, rr.project_id as project_id
         from review_findings rf
         join review_runs rr on rr.id = rf.run_id
         where rf.id = ? limit 1`,
      [args.findingId],
    );
    if (!findingRow) throw new Error(`Finding '${args.findingId}' was not found.`);
    if (findingRow.project_id !== projectId) {
      throw new Error("Cannot record feedback for a finding outside this project.");
    }
    const snoozeUntil = args.snoozeDurationMs && args.snoozeDurationMs > 0
      ? new Date(Date.now() + Math.min(args.snoozeDurationMs, 1000 * 60 * 60 * 24 * 365)).toISOString()
      : null;
    const record: ReviewFeedbackRecord = {
      id: `rfb_${randomUUID()}`,
      findingId: args.findingId,
      runId: findingRow.run_id,
      kind: args.kind,
      reason: args.reason ?? null,
      note: args.note ?? null,
      snoozeUntil,
      createdAt: nowIso(),
    };
    db.run(
      `insert into review_finding_feedback (
        id, finding_id, run_id, project_id, kind, reason, note, snooze_until, created_at
      ) values (?,?,?,?,?,?,?,?,?)`,
      [
        record.id,
        record.findingId,
        record.runId,
        projectId,
        record.kind,
        record.reason,
        record.note,
        record.snoozeUntil,
        record.createdAt,
      ],
    );

    if (args.kind === "suppress") {
      const requestedScope: ReviewSuppressionScope = args.suppression?.scope ?? "repo";
      const requestedPathPattern = args.suppression?.pathPattern
        ?? (requestedScope === "path" ? findingRow.file_path : null);
      const hasUsablePathPattern = typeof requestedPathPattern === "string" && requestedPathPattern.trim().length > 0;
      const scope: ReviewSuppressionScope = requestedScope === "path" && !hasUsablePathPattern
        ? "repo"
        : requestedScope;
      const pathPattern = scope === "path" ? requestedPathPattern : null;
      const finding = mapFindingRow(findingRow);
      const publicationRow = db.get<ReviewRunPublicationRow>(
        "select * from review_run_publications where run_id = ? order by created_at desc limit 1",
        [findingRow.run_id],
      );
      const destination = publicationRow ? mapPublicationRow(publicationRow).destination : null;
      const repoKey = deriveRepoKey(destination, projectId);
      await suppressionService
        .create({
          scope,
          title: finding.title,
          repoKey: scope === "global" ? null : repoKey,
          pathPattern,
          findingClass: finding.findingClass ?? null,
          severity: finding.severity,
          reason: args.reason ?? null,
          note: args.note ?? null,
          sourceFindingId: finding.id,
          seedText: `${finding.title}\n${finding.body}`,
        })
        .catch((error) => {
          logger.warn("review.suppression.create_failed", {
            findingId: finding.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      emit({ type: "suppressions-updated" });
    }

    emit({ type: "feedback-updated", findingId: args.findingId, runId: findingRow.run_id });
    return record;
  }

  async function listSuppressions(args: ReviewListSuppressionsArgs = {}): Promise<ReviewSuppression[]> {
    assertNotDisposed();
    return suppressionService.list({ limit: args.limit ?? null, scope: args.scope ?? null });
  }

  async function deleteSuppression(args: { suppressionId: string }): Promise<boolean> {
    assertNotDisposed();
    const removed = suppressionService.remove(args.suppressionId);
    if (removed) emit({ type: "suppressions-updated" });
    return removed;
  }

  async function qualityReport(): Promise<ReviewQualityReport> {
    assertNotDisposed();
    const totalRunsRow = db.get<{ n: number }>(
      "select count(*) as n from review_runs where project_id = ?",
      [projectId],
    );
    const totalFindingsRow = db.get<{ n: number }>(
      `select count(*) as n from review_findings rf
         join review_runs rr on rr.id = rf.run_id
         where rr.project_id = ?`,
      [projectId],
    );
    const publishedRow = db.get<{ n: number }>(
      `select count(*) as n from review_findings rf
         join review_runs rr on rr.id = rf.run_id
         where rr.project_id = ? and rf.publication_state = 'published'`,
      [projectId],
    );
    // Count each finding once, using only its latest feedback entry. Without
    // the row_number() filter, a user who toggled feedback (e.g. acknowledge
    // then dismiss) would be counted twice and noiseRate could exceed 1.0.
    const feedbackCounts = db.all<{ kind: string; n: number }>(
      `with latest as (
         select finding_id, kind,
                row_number() over (partition by finding_id order by created_at desc) as rn
           from review_finding_feedback
          where project_id = ?
       )
       select kind, count(*) as n from latest where rn = 1 group by kind`,
      [projectId],
    );
    const kindMap = new Map(feedbackCounts.map((row) => [row.kind, Number(row.n ?? 0)]));
    const byClassRows = db.all<{ finding_class: string | null; total: number; addressed: number }>(
      `with latest_only as (
         select finding_id, kind from (
           select finding_id, kind,
                  row_number() over (partition by finding_id order by created_at desc) as rn
             from review_finding_feedback
            where project_id = ?
         ) where rn = 1
       )
       select rf.finding_class as finding_class,
              count(*) as total,
              sum(case when fb.kind = 'acknowledge' then 1 else 0 end) as addressed
         from review_findings rf
         join review_runs rr on rr.id = rf.run_id
         left join latest_only fb on fb.finding_id = rf.id
         where rr.project_id = ?
         group by rf.finding_class
         order by total desc
         limit 20`,
      [projectId, projectId],
    );
    const recentFeedback = db.all<ReviewFindingFeedbackRow>(
      "select * from review_finding_feedback where project_id = ? order by created_at desc limit 20",
      [projectId],
    ).map(mapFeedbackRow);

    const totalFindings = Number(totalFindingsRow?.n ?? 0);
    const dismissedCount = kindMap.get("dismiss") ?? 0;
    const suppressedCount = kindMap.get("suppress") ?? 0;
    const addressedCount = kindMap.get("acknowledge") ?? 0;
    const snoozedCount = kindMap.get("snooze") ?? 0;
    const noiseRate = totalFindings > 0
      ? Math.max(0, Math.min(1, Number(((dismissedCount + suppressedCount) / totalFindings).toFixed(3))))
      : 0;

    return {
      projectId,
      totalRuns: Number(totalRunsRow?.n ?? 0),
      totalFindings,
      addressedCount,
      dismissedCount,
      snoozedCount,
      suppressedCount,
      publishedCount: Number(publishedRow?.n ?? 0),
      noiseRate,
      recentFeedback,
      byClass: byClassRows.map((row) => ({
        findingClass: (row.finding_class as ReviewFindingClass | null) ?? "uncategorized",
        total: Number(row.total ?? 0),
        addressed: Number(row.addressed ?? 0),
      })),
    };
  }

  return {
    listLaunchContext,
    startRun,
    rerun,
    cancelRun,
    listRuns,
    getRunDetail,
    recordFeedback,
    listSuppressions,
    deleteSuppression,
    qualityReport,
    dispose() {
      disposed = true;
      activeRuns.clear();
      cancelledRuns.clear();
    },
  };
}
