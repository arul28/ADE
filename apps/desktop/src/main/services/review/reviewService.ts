import { randomUUID } from "node:crypto";
import type {
  ReviewArtifactType,
  ReviewEventPayload,
  ReviewEvidence,
  ReviewFinding,
  ReviewPublication,
  ReviewPublicationDestination,
  ReviewPublicationInlineComment,
  ReviewPublicationState,
  ReviewResolvedCompareTarget,
  ReviewRun,
  ReviewRunArtifact,
  ReviewRunConfig,
  ReviewRunDetail,
  ReviewRunStatus,
  ReviewSeverity,
  ReviewSeveritySummary,
  ReviewSourcePass,
  ReviewStartRunArgs,
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
import type { createPrService } from "../prs/prService";
import { createReviewTargetMaterializer } from "./reviewTargetMaterializer";

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
  body: string;
  confidence: number;
  evidence_json: string | null;
  file_path: string | null;
  line: number | null;
  anchor_state: string;
  source_pass: string;
  publication_state: string;
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
    getDefaultModelDescriptor("unified")?.id ?? null,
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

function buildPrompt(args: {
  run: ReviewRun;
  diffText: string;
  changedFiles: Array<{ filePath: string }>;
}): string {
  const changedFilesSummary = args.changedFiles.length > 0
    ? args.changedFiles.map((entry) => `- ${entry.filePath}`).join("\n")
    : "- No changed files were detected.";

  return [
    "You are ADE's local code reviewer.",
    "Review only the provided local diff bundle.",
    "Prioritize correctness, regressions, security, data loss, race conditions, risky migrations, and missing tests.",
    "Do not suggest style-only nits or speculative rewrites.",
    `Return strict JSON only with this exact top-level shape: {"summary": string, "findings": Finding[]}.`,
    "Each Finding must be an object with:",
    '- "title": short issue title',
    '- "severity": one of "critical", "high", "medium", "low", "info"',
    '- "body": concise explanation of the risk and why it matters',
    '- "confidence": number between 0 and 1',
    '- "filePath": changed file path when known, otherwise null',
    '- "line": line number when known, otherwise null',
    '- "evidence": array of objects with {"summary": string, "quote": string|null, "filePath": string|null, "line": number|null}',
    `Return at most ${args.run.config.budgets.maxFindings} findings.`,
    "If there are no real issues, return an empty findings array and explain that in summary.",
    "",
    `Review target: ${args.run.targetLabel}`,
    `Selection mode: ${args.run.config.selectionMode}`,
    `Publish behavior: ${args.run.config.publishBehavior}`,
    "",
    "Changed files:",
    changedFilesSummary,
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
    return [{
      kind: "quote",
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

function normalizeParsedFindings(args: {
  runId: string;
  parsed: Record<string, unknown> | null;
  changedFilesByPath: Map<string, { excerpt: string; lineNumbers: Set<number> }>;
}): { summary: string | null; findings: ReviewFinding[] } {
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

    const finding: ReviewFinding = {
      id: randomUUID(),
      runId: args.runId,
      title,
      severity: normalizeSeverity(entry.severity),
      body,
      confidence: normalizeConfidence(entry.confidence),
      evidence,
      filePath,
      line,
      anchorState,
      sourcePass: "single_pass" as ReviewSourcePass,
      publicationState: "local_only" as ReviewPublicationState,
    };
    return [finding];
  });

  const summary = typeof args.parsed?.summary === "string" ? cleanLine(args.parsed.summary) : null;
  return { summary, findings };
}

function tallySeveritySummary(findings: ReviewFinding[]): ReviewSeveritySummary {
  const summary = defaultSeveritySummary();
  for (const finding of findings) {
    summary[finding.severity] += 1;
  }
  return summary;
}

function mapRunRow(row: ReviewRunRow): ReviewRun {
  return {
    id: row.id,
    projectId: row.project_id,
    laneId: row.lane_id,
    target: safeJsonParse<ReviewTarget>(row.target_json, {
      mode: "working_tree",
      laneId: row.lane_id,
    }),
    config: safeJsonParse<ReviewRunConfig>(row.config_json, {
      compareAgainst: { kind: "default_branch" },
      selectionMode: "full_diff",
      dirtyOnly: false,
      modelId: DEFAULT_REVIEW_MODEL_ID,
      reasoningEffort: null,
      budgets: DEFAULT_BUDGETS,
      publishBehavior: "local_only",
    }),
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
    body: row.body,
    confidence: clampNumber(Number(row.confidence ?? 0.5), 0, 1),
    evidence: safeJsonParse<ReviewEvidence[]>(row.evidence_json, []),
    filePath: row.file_path,
    line: typeof row.line === "number" ? row.line : null,
    anchorState: (row.anchor_state as ReviewFinding["anchorState"]) ?? "missing",
    sourcePass: (row.source_pass as ReviewSourcePass) ?? "single_pass",
    publicationState: (row.publication_state as ReviewPublicationState) ?? "local_only",
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
    reviewEvent: row.review_event === "COMMENT" ? "COMMENT" : "COMMENT",
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
  prService,
  onEvent,
}: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  projectRoot: string;
  projectDefaultBranch: string | null;
  laneService: Pick<ReturnType<typeof createLaneService>, "getLaneBaseAndBranch" | "list">;
  gitService: Pick<ReturnType<typeof createGitOperationsService>, "listRecentCommits">;
  agentChatService: Pick<ReturnType<typeof createAgentChatService>, "createSession" | "getSessionSummary" | "runSessionTurn">;
  sessionService: Pick<ReturnType<typeof createSessionService>, "updateMeta">;
  prService?: Pick<ReturnType<typeof createPrService>, "getReviewSnapshot" | "publishReviewPublication">;
  onEvent?: (event: ReviewEventPayload) => void;
}) {
  const materializer = createReviewTargetMaterializer({ laneService, prService });
  const activeRuns = new Set<string>();
  let disposed = false;
  const configuredDefaultModelId =
    getDefaultModelDescriptor("codex")?.id
    ?? getDefaultModelDescriptor("unified")?.id
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

  function insertArtifact(runId: string, artifact: Omit<ReviewRunArtifact, "id" | "runId" | "createdAt">): void {
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
        randomUUID(),
        runId,
        artifact.artifactType,
        artifact.title,
        artifact.mimeType,
        artifact.contentText,
        artifact.metadata ? JSON.stringify(artifact.metadata) : null,
        nowIso(),
      ],
    );
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
        body,
        confidence,
        evidence_json,
        file_path,
        line,
        anchor_state,
        source_pass,
        publication_state
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finding.id,
        finding.runId,
        finding.title,
        finding.severity,
        finding.body,
        finding.confidence,
        JSON.stringify(finding.evidence),
        finding.filePath,
        finding.line,
        finding.anchorState,
        finding.sourcePass,
        finding.publicationState,
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
      budgets: {
        maxFiles: clampNumber(Number(partial?.budgets?.maxFiles ?? DEFAULT_BUDGETS.maxFiles), 1, 500),
        maxDiffChars: clampNumber(Number(partial?.budgets?.maxDiffChars ?? DEFAULT_BUDGETS.maxDiffChars), 4_000, 1_000_000),
        maxPromptChars: clampNumber(Number(partial?.budgets?.maxPromptChars ?? DEFAULT_BUDGETS.maxPromptChars), 4_000, 1_000_000),
        maxFindings: clampNumber(Number(partial?.budgets?.maxFindings ?? DEFAULT_BUDGETS.maxFindings), 1, 50),
      },
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

    insertArtifact(args.runId, {
      artifactType: "publication_request",
      title: "Review publication request",
      mimeType: "application/json",
      contentText: JSON.stringify({
        destination: args.publicationTarget,
        targetLabel: args.targetLabel,
        summary: args.summary,
        findingIds: args.findings.map((finding) => finding.id),
        changedFiles: args.changedFiles,
      }, null, 2),
      metadata: {
        publishBehavior: args.config.publishBehavior,
      },
    });

    const publication = await prService.publishReviewPublication({
      runId: args.runId,
      destination: args.publicationTarget,
      targetLabel: args.targetLabel,
      summary: args.summary,
      findings: args.findings,
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
      for (const finding of args.findings) {
        if (!publishedFindingIds.has(finding.id)) continue;
        updateFindingPublicationState(args.runId, finding.id, "published");
      }
    }

    return publication;
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

      const prompt = buildPrompt({
        run: {
          ...run,
          targetLabel: materialized.targetLabel,
          compareTarget: materialized.compareTarget,
        },
        diffText: truncateText(materialized.fullPatchText, run.config.budgets.maxDiffChars),
        changedFiles: materialized.changedFiles.slice(0, run.config.budgets.maxFiles),
      });
      insertArtifact(runId, {
        artifactType: "prompt",
        title: "Review prompt",
        mimeType: "text/plain",
        contentText: prompt,
        metadata: {
          modelId: descriptor.id,
          reasoningEffort: run.config.reasoningEffort,
        },
      });

      const result = await agentChatService.runSessionTurn({
        sessionId: session.id,
        text: prompt,
        displayText: sessionTitle,
        reasoningEffort: run.config.reasoningEffort,
        timeoutMs: 15 * 60 * 1000,
      });
      if (disposed) return;
      insertArtifact(runId, {
        artifactType: "review_output",
        title: "Reviewer output",
        mimeType: "application/json",
        contentText: result.outputText,
        metadata: {
          provider: result.provider,
          model: result.model,
          modelId: result.modelId ?? descriptor.id,
        },
      });

      const changedFilesByPath = new Map(materialized.changedFiles.map((entry) => [
        entry.filePath,
        {
          excerpt: entry.excerpt,
          lineNumbers: new Set(entry.lineNumbers),
          diffPositionsByLine: entry.diffPositionsByLine,
        },
      ]));
      const parsed = extractJsonObject(result.outputText);
      const normalized = normalizeParsedFindings({
        runId,
        parsed,
        changedFilesByPath,
      });
      const findings = normalized.findings.slice(0, run.config.budgets.maxFindings);
      for (const finding of findings) {
        if (disposed) return;
        insertFinding(finding);
      }
      if (disposed) return;
      await publishRun({
        runId,
        targetLabel: materialized.targetLabel,
        summary: normalized.summary,
        config: run.config,
        findings,
        publicationTarget: materialized.publicationTarget,
        changedFiles: materialized.changedFiles.map((entry) => ({
          filePath: entry.filePath,
          diffPositionsByLine: entry.diffPositionsByLine,
        })),
      });
      if (disposed) return;
      const severitySummary = tallySeveritySummary(findings);
      const endedAt = nowIso();
      updateRun(runId, {
        status: "completed",
        summary: normalized.summary ?? (findings.length > 0 ? `Review completed with ${findings.length} finding(s).` : "No actionable findings."),
        error_message: null,
        finding_count: findings.length,
        severity_summary_json: serializeSeveritySummary(severitySummary),
        ended_at: endedAt,
        updated_at: endedAt,
      });
      emit({ type: "run-completed", runId, laneId: run.laneId, status: "completed" });
      emit({ type: "runs-updated", runId, laneId: run.laneId, status: "completed" });
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
    const findings = db.all<ReviewFindingRow>(
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

  return {
    listLaunchContext,
    startRun,
    rerun,
    listRuns,
    getRunDetail,
    dispose() {
      disposed = true;
      activeRuns.clear();
    },
  };
}
