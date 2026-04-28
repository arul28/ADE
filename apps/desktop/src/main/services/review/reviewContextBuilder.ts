import type {
  IssueInventorySnapshot,
  PrCheck,
  PrReviewSnapshot,
  ReviewRun,
  SessionDeltaSummary,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createPrService } from "../prs/prService";
import type { createIssueInventoryService } from "../prs/issueInventoryService";
import { parseWorkerDigestRow } from "../orchestrator/workerTracking";
import type { createSessionDeltaService } from "../sessions/sessionDeltaService";
import type { AdeDb } from "../state/kvDb";
import type { createTestService } from "../tests/testService";
import { getErrorMessage } from "../shared/utils";
import type { ReviewMaterializedTarget } from "./reviewTargetMaterializer";
import {
  matchReviewRuleOverlays,
  type MatchedReviewRuleOverlay,
} from "./reviewRuleRegistry";

const MISSION_LIMIT = 1;
const WORKER_DIGEST_LIMIT = 3;
const SESSION_DELTA_LIMIT = 3;
const PRIOR_REVIEW_LIMIT = 2;
const VALIDATION_SIGNAL_LIMIT = 5;
const ISSUE_INVENTORY_LIMIT = 5;
const MAX_TEXT_FIELD = 220;
const MAX_PROMPT_SECTION = 6_000;

type LinkedPrRow = {
  id: string;
  title: string | null;
  state: string;
  github_url: string;
  repo_owner: string;
  repo_name: string;
  github_pr_number: number;
  updated_at: string;
};

type MissionRow = {
  mission_id: string | null;
  title: string | null;
  prompt: string | null;
  status: string | null;
  outcome_summary: string | null;
  updated_at: string | null;
};

type PriorReviewRow = {
  id: string;
  status: string;
  summary: string | null;
  finding_count: number;
  created_at: string;
  publication_count: number;
};

type WorkerDigestRow = {
  id: string;
  mission_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  lane_id: string | null;
  session_id: string | null;
  step_key: string | null;
  status: string;
  summary: string;
  files_changed_json: string | null;
  tests_run_json: string | null;
  warnings_json: string | null;
  tokens_json: string | null;
  cost_usd: number | null;
  suggested_next_actions_json: string | null;
  created_at: string;
};

export type ReviewContextProvenancePayload = {
  changedPaths: string[];
  laneSnapshot: {
    updatedAt: string | null;
    agentSummary: string | null;
    missionSummary: string | null;
  } | null;
  missions: Array<{
    id: string;
    title: string;
    status: string | null;
    outcomeSummary: string | null;
    intentSummary: string | null;
    updatedAt: string | null;
  }>;
  workerDigests: Array<{
    id: string;
    stepKey: string | null;
    status: string;
    summary: string;
    filesChanged: string[];
    testsSummary: string | null;
    warnings: string[];
    createdAt: string;
  }>;
  sessionDeltas: Array<{
    sessionId: string;
    startedAt: string;
    endedAt: string | null;
    filesChanged: number;
    touchedFiles: string[];
    failureLines: string[];
    computedAt: string | null;
  }>;
  priorReviews: Array<{
    runId: string;
    status: string;
    summary: string | null;
    findingCount: number;
    publicationCount: number;
    overlappingPaths: string[];
    createdAt: string;
  }>;
  lateStageSignals: Array<{
    kind: "validation_failure_followed_by_edits" | "review_feedback_followed_by_edits" | "prior_review_overlap";
    summary: string;
    filePaths: string[];
    source: string;
    occurredAt: string | null;
  }>;
};

export type ReviewContextRulesPayload = {
  changedPaths: string[];
  overlays: Array<{
    id: MatchedReviewRuleOverlay["id"];
    label: string;
    description: string;
    matchedPaths: string[];
    rolloutExpectations: string[];
    coveredFamilies: Array<{ id: string; label: string }>;
    missingFamilies: Array<{ id: string; label: string }>;
    adjudicationPolicy: MatchedReviewRuleOverlay["adjudicationPolicy"];
  }>;
};

export type ReviewContextValidationPayload = {
  linkedPr: {
    prId: string;
    title: string | null;
    state: string;
    repo: string;
    githubUrl: string;
    updatedAt: string;
  } | null;
  reviewSnapshot: {
    baseBranch: string | null;
    headBranch: string | null;
    baseSha: string | null;
    headSha: string | null;
    fileCount: number;
  } | null;
  checks: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    detailsUrl: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
  suites: string[];
  testRuns: Array<{
    runId: string;
    suiteId: string;
    suiteName: string;
    status: string;
    exitCode: number | null;
    startedAt: string;
    endedAt: string | null;
    logExcerpt: string | null;
  }>;
  issueInventory: Array<{
    id: string;
    source: string;
    type: string;
    state: string;
    round: number;
    headline: string;
    body: string | null;
    filePath: string | null;
    line: number | null;
    updatedAt: string;
  }>;
  sessionFailures: Array<{
    sessionId: string;
    touchedFiles: string[];
    failureLines: string[];
    computedAt: string | null;
  }>;
  signals: Array<{
    kind: "pr_check_failure" | "test_run_failure" | "review_feedback" | "session_failure";
    summary: string;
    filePaths: string[];
    sourceId: string;
  }>;
};

export type ReviewContextSection<TPayload extends Record<string, unknown>> = {
  summary: string;
  prompt: string;
  payload: TPayload;
  metadata: Record<string, unknown>;
};

export type ReviewContextPacket = {
  matchedRuleOverlays: MatchedReviewRuleOverlay[];
  provenance: ReviewContextSection<ReviewContextProvenancePayload>;
  rules: ReviewContextSection<ReviewContextRulesPayload>;
  validation: ReviewContextSection<ReviewContextValidationPayload>;
};

function clipText(value: string | null | undefined, maxChars: number = MAX_TEXT_FIELD): string | null {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function compactList(values: Array<string | null | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  const compacted: string[] = [];
  for (const value of values) {
    const clipped = clipText(value);
    if (!clipped || seen.has(clipped)) continue;
    seen.add(clipped);
    compacted.push(clipped);
    if (compacted.length >= limit) break;
  }
  return compacted;
}

function summarizeRecord(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  const directKeys = [
    "summary",
    "headline",
    "title",
    "goal",
    "currentTask",
    "statusSummary",
    "latestMessage",
    "intent",
    "mission",
  ];
  const directValues = directKeys
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string");
  const clippedDirect = compactList(directValues, 2);
  if (clippedDirect.length > 0) return clippedDirect.join(" | ");

  const nestedValues = Object.values(record)
    .flatMap((value) => {
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === "string");
      }
      return [];
    });
  const clippedNested = compactList(nestedValues, 2);
  return clippedNested.length > 0 ? clippedNested.join(" | ") : null;
}

function overlapsChangedPaths(candidatePaths: Array<string | null | undefined>, changedPaths: string[]): string[] {
  const changedSet = new Set(changedPaths);
  return candidatePaths
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0 && changedSet.has(value))
    .slice(0, 5);
}

function extractFailureExcerpt(rawTail: string): string | null {
  const lines = rawTail
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => /\b(error|failed|failure|exception|fatal|traceback)\b/i.test(line));
  return compactList(lines, 3).join(" | ") || null;
}

function truncatePromptSection(value: string): string {
  if (value.length <= MAX_PROMPT_SECTION) return value;
  return `${value.slice(0, MAX_PROMPT_SECTION)}\n...(truncated)...\n`;
}

export function createReviewContextBuilder({
  db,
  projectId,
  logger,
  laneService,
  sessionDeltaService,
  testService,
  issueInventoryService,
  prService,
}: {
  db: AdeDb;
  projectId: string;
  logger: Logger;
  laneService: Pick<ReturnType<typeof createLaneService>, "getStateSnapshot">;
  sessionDeltaService: Pick<ReturnType<typeof createSessionDeltaService>, "listRecentLaneSessionDeltas">;
  testService: Pick<ReturnType<typeof createTestService>, "listRuns" | "getLogTail" | "listSuites">;
  issueInventoryService: Pick<ReturnType<typeof createIssueInventoryService>, "getInventory">;
  prService?: Pick<ReturnType<typeof createPrService>, "getChecks" | "getReviewSnapshot">;
}) {
  function getLinkedPrRow(run: ReviewRun): LinkedPrRow | null {
    if (run.target.mode === "pr") {
      return db.get<LinkedPrRow>(
        `
          select id, title, state, github_url, repo_owner, repo_name, github_pr_number, updated_at
          from pull_requests
          where id = ?
            and project_id = ?
          limit 1
        `,
        [run.target.prId, projectId],
      );
    }
    return db.get<LinkedPrRow>(
      `
        select id, title, state, github_url, repo_owner, repo_name, github_pr_number, updated_at
        from pull_requests
        where project_id = ?
          and lane_id = ?
          and state in ('open', 'draft')
        order by updated_at desc
        limit 1
      `,
      [projectId, run.laneId],
    );
  }

  function getMissionRow(laneId: string): MissionRow | null {
    return db.get<MissionRow>(
      `
        select
          l.mission_id as mission_id,
          m.title as title,
          m.prompt as prompt,
          m.status as status,
          m.outcome_summary as outcome_summary,
          m.updated_at as updated_at
        from lanes l
        left join missions m on m.id = l.mission_id
        where l.id = ?
          and l.project_id = ?
        limit 1
      `,
      [laneId, projectId],
    );
  }

  function listWorkerDigests(missionId: string | null, laneId: string): ReviewContextProvenancePayload["workerDigests"] {
    if (!missionId?.trim()) return [];
    const rows = db.all<WorkerDigestRow>(
      `
        select *
        from orchestrator_worker_digests
        where mission_id = ?
          and project_id = ?
          and (lane_id = ? or lane_id is null)
        order by created_at desc
        limit ?
      `,
      [missionId, projectId, laneId, WORKER_DIGEST_LIMIT],
    );
    return rows.map((row) => {
      const digest = parseWorkerDigestRow(row);
      return {
        id: digest.id,
        stepKey: digest.stepKey,
        status: digest.status,
        summary: clipText(digest.summary) ?? "No summary",
        filesChanged: digest.filesChanged.slice(0, 4),
        testsSummary: clipText(digest.testsRun?.summary ?? null),
        warnings: compactList(digest.warnings, 2),
        createdAt: digest.createdAt,
      };
    });
  }

  function listPriorReviews(runId: string, laneId: string, changedPaths: string[]): ReviewContextProvenancePayload["priorReviews"] {
    const rows = db.all<PriorReviewRow>(
      `
        select
          r.id,
          r.status,
          r.summary,
          r.finding_count,
          r.created_at,
          (
            select count(1)
            from review_run_publications p
            where p.run_id = r.id
          ) as publication_count
        from review_runs r
        where r.project_id = ?
          and r.lane_id = ?
          and r.id != ?
        order by r.created_at desc
        limit ?
      `,
      [projectId, laneId, runId, PRIOR_REVIEW_LIMIT],
    );
    return rows.map((row) => {
      const findingRows = db.all<{ file_path: string | null }>(
        `
          select file_path
          from review_findings
          where run_id = ?
            and file_path is not null
          order by file_path asc
          limit 16
        `,
        [row.id],
      );
      return {
        runId: row.id,
        status: row.status,
        summary: clipText(row.summary),
        findingCount: Number(row.finding_count ?? 0),
        publicationCount: Number(row.publication_count ?? 0),
        overlappingPaths: overlapsChangedPaths(findingRows.map((entry) => entry.file_path), changedPaths),
        createdAt: row.created_at,
      };
    });
  }

  async function buildValidationPayload(args: {
    laneId: string;
    changedPaths: string[];
    linkedPr: LinkedPrRow | null;
    sessionDeltas: ReviewContextProvenancePayload["sessionDeltas"];
  }): Promise<ReviewContextValidationPayload> {
    let reviewSnapshot: PrReviewSnapshot | null = null;
    let checks: PrCheck[] = [];
    let inventory: IssueInventorySnapshot | null = null;

    if (args.linkedPr?.id) {
      if (prService) {
        reviewSnapshot = await prService.getReviewSnapshot(args.linkedPr.id).catch((error) => {
          logger.debug("review.context_builder.review_snapshot_unavailable", {
            prId: args.linkedPr?.id,
            error: getErrorMessage(error),
          });
          return null;
        });
        checks = await prService.getChecks(args.linkedPr.id).catch((error) => {
          logger.debug("review.context_builder.pr_checks_unavailable", {
            prId: args.linkedPr?.id,
            error: getErrorMessage(error),
          });
          return [];
        });
      }
      try {
        inventory = issueInventoryService.getInventory(args.linkedPr.id);
      } catch (error) {
        logger.debug("review.context_builder.issue_inventory_unavailable", {
          prId: args.linkedPr?.id,
          error: getErrorMessage(error),
        });
      }
    }

    const suites = testService.listSuites().map((suite) => suite.id).slice(0, VALIDATION_SIGNAL_LIMIT);
    const testRuns = testService.listRuns({ laneId: args.laneId, limit: VALIDATION_SIGNAL_LIMIT });
    const normalizedTestRuns = testRuns.map((run) => ({
      runId: run.id,
      suiteId: run.suiteId,
      suiteName: clipText(run.suiteName, 80) ?? run.suiteId,
      status: run.status,
      exitCode: run.exitCode,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      logExcerpt: (run.status === "failed" || run.status === "timed_out")
        ? clipText(extractFailureExcerpt(testService.getLogTail({ runId: run.id, maxBytes: 12_000 })), 260)
        : null,
    }));
    const normalizedChecks = checks.map((check) => ({
      name: clipText(check.name, 100) ?? "unnamed check",
      status: check.status,
      conclusion: check.conclusion,
      detailsUrl: check.detailsUrl,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
    }));
    const unresolvedInventoryItems = (inventory?.items ?? [])
      .filter((item) => item.state !== "fixed" && item.state !== "dismissed")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, ISSUE_INVENTORY_LIMIT)
      .map((item) => ({
        id: item.id,
        source: item.source,
        type: item.type,
        state: item.state,
        round: item.round,
        headline: clipText(item.headline) ?? item.id,
        body: clipText(item.body),
        filePath: item.filePath,
        line: item.line,
        updatedAt: item.updatedAt,
      }));
    const sessionFailures = args.sessionDeltas
      .filter((delta) => delta.failureLines.length > 0)
      .slice(0, SESSION_DELTA_LIMIT)
      .map((delta) => ({
        sessionId: delta.sessionId,
        touchedFiles: delta.touchedFiles.slice(0, 5),
        failureLines: compactList(delta.failureLines, 3),
        computedAt: delta.computedAt,
      }));

    const signals: ReviewContextValidationPayload["signals"] = [];
    for (const check of normalizedChecks) {
      if (signals.length >= VALIDATION_SIGNAL_LIMIT) break;
      const failed = check.conclusion === "failure" || (check.status === "completed" && check.conclusion !== "success");
      if (!failed) continue;
      signals.push({
        kind: "pr_check_failure",
        summary: clipText(`${check.name}: ${check.status}${check.conclusion ? ` / ${check.conclusion}` : ""}${check.detailsUrl ? ` (${check.detailsUrl})` : ""}`, 260) ?? check.name,
        filePaths: [],
        sourceId: check.name,
      });
    }
    for (const run of normalizedTestRuns) {
      if (signals.length >= VALIDATION_SIGNAL_LIMIT) break;
      if (run.status !== "failed" && run.status !== "timed_out") continue;
      signals.push({
        kind: "test_run_failure",
        summary: clipText(`${run.suiteName}: ${run.status}${run.logExcerpt ? ` — ${run.logExcerpt}` : ""}`, 260) ?? run.suiteName,
        filePaths: [],
        sourceId: run.runId,
      });
    }
    for (const item of unresolvedInventoryItems) {
      if (signals.length >= VALIDATION_SIGNAL_LIMIT) break;
      signals.push({
        kind: "review_feedback",
        summary: clipText(`${item.headline}${item.filePath ? ` (${item.filePath}${item.line ? `:${item.line}` : ""})` : ""}`, 260) ?? item.id,
        filePaths: item.filePath ? [item.filePath] : [],
        sourceId: item.id,
      });
    }
    for (const delta of sessionFailures) {
      if (signals.length >= VALIDATION_SIGNAL_LIMIT) break;
      signals.push({
        kind: "session_failure",
        summary: clipText(delta.failureLines.join(" | "), 260) ?? delta.sessionId,
        filePaths: overlapsChangedPaths(delta.touchedFiles, args.changedPaths),
        sourceId: delta.sessionId,
      });
    }

    return {
      linkedPr: args.linkedPr ? {
        prId: args.linkedPr.id,
        title: clipText(args.linkedPr.title),
        state: args.linkedPr.state,
        repo: `${args.linkedPr.repo_owner}/${args.linkedPr.repo_name}`,
        githubUrl: args.linkedPr.github_url,
        updatedAt: args.linkedPr.updated_at,
      } : null,
      reviewSnapshot: reviewSnapshot ? {
        baseBranch: reviewSnapshot.baseBranch ?? null,
        headBranch: reviewSnapshot.headBranch ?? null,
        baseSha: reviewSnapshot.baseSha ?? null,
        headSha: reviewSnapshot.headSha ?? null,
        fileCount: reviewSnapshot.files.length,
      } : null,
      checks: normalizedChecks,
      suites,
      testRuns: normalizedTestRuns,
      issueInventory: unresolvedInventoryItems,
      sessionFailures,
      signals,
    };
  }

  function buildProvenancePayload(args: {
    materialized: ReviewMaterializedTarget;
    laneSnapshot: ReturnType<Pick<ReturnType<typeof createLaneService>, "getStateSnapshot">["getStateSnapshot"]>;
    missionRow: MissionRow | null;
    workerDigests: ReviewContextProvenancePayload["workerDigests"];
    sessionDeltas: SessionDeltaSummary[];
    priorReviews: ReviewContextProvenancePayload["priorReviews"];
    validation: ReviewContextValidationPayload;
  }): ReviewContextProvenancePayload {
    const changedPaths = args.materialized.changedFiles.map((file) => file.filePath);
    const normalizedSessionDeltas = args.sessionDeltas.slice(0, SESSION_DELTA_LIMIT).map((delta) => ({
      sessionId: delta.sessionId,
      startedAt: delta.startedAt,
      endedAt: delta.endedAt,
      filesChanged: delta.filesChanged,
      touchedFiles: delta.touchedFiles.slice(0, 5),
      failureLines: compactList(delta.failureLines, 3),
      computedAt: delta.computedAt,
    }));
    const missions = args.missionRow?.mission_id && MISSION_LIMIT > 0 ? [{
      id: args.missionRow.mission_id,
      title: clipText(args.missionRow.title, 120) ?? args.missionRow.mission_id,
      status: args.missionRow.status,
      outcomeSummary: clipText(args.missionRow.outcome_summary),
      intentSummary: clipText(args.missionRow.prompt),
      updatedAt: args.missionRow.updated_at,
    }] : [];
    const lateStageSignals: ReviewContextProvenancePayload["lateStageSignals"] = [];
    for (const delta of normalizedSessionDeltas) {
      const overlappingPaths = overlapsChangedPaths(delta.touchedFiles, changedPaths);
      if (overlappingPaths.length === 0 || delta.failureLines.length === 0) continue;
      lateStageSignals.push({
        kind: "validation_failure_followed_by_edits",
        summary: clipText(`Recent lane validation failed before edits touched ${overlappingPaths.join(", ")}: ${delta.failureLines.join(" | ")}`, 260) ?? delta.sessionId,
        filePaths: overlappingPaths,
        source: delta.sessionId,
        occurredAt: delta.computedAt ?? delta.endedAt,
      });
    }
    for (const item of args.validation.issueInventory) {
      if (lateStageSignals.length >= VALIDATION_SIGNAL_LIMIT) break;
      const overlappingPaths = overlapsChangedPaths([item.filePath], changedPaths);
      if (overlappingPaths.length === 0) continue;
      lateStageSignals.push({
        kind: "review_feedback_followed_by_edits",
        summary: clipText(`Open reviewer or check feedback still targets ${overlappingPaths.join(", ")}: ${item.headline}`, 260) ?? item.id,
        filePaths: overlappingPaths,
        source: item.id,
        occurredAt: item.updatedAt,
      });
    }
    for (const review of args.priorReviews) {
      if (lateStageSignals.length >= VALIDATION_SIGNAL_LIMIT) break;
      if (review.overlappingPaths.length === 0) continue;
      lateStageSignals.push({
        kind: "prior_review_overlap",
        summary: clipText(`A prior ADE review already flagged ${review.overlappingPaths.join(", ")} (${review.findingCount} finding${review.findingCount === 1 ? "" : "s"}).`, 260) ?? review.runId,
        filePaths: review.overlappingPaths,
        source: review.runId,
        occurredAt: review.createdAt,
      });
    }

    return {
      changedPaths,
      laneSnapshot: args.laneSnapshot ? {
        updatedAt: args.laneSnapshot.updatedAt,
        agentSummary: clipText(summarizeRecord(args.laneSnapshot.agentSummary)),
        missionSummary: clipText(summarizeRecord(args.laneSnapshot.missionSummary)),
      } : null,
      missions,
      workerDigests: args.workerDigests,
      sessionDeltas: normalizedSessionDeltas,
      priorReviews: args.priorReviews,
      lateStageSignals: lateStageSignals.slice(0, VALIDATION_SIGNAL_LIMIT),
    };
  }

  function buildProvenancePrompt(payload: ReviewContextProvenancePayload): string {
    const lines: string[] = [];
    if (payload.laneSnapshot?.agentSummary) {
      lines.push(`- Lane agent summary: ${payload.laneSnapshot.agentSummary}`);
    }
    if (payload.laneSnapshot?.missionSummary) {
      lines.push(`- Lane mission summary: ${payload.laneSnapshot.missionSummary}`);
    }
    for (const mission of payload.missions) {
      lines.push(`- Mission: ${mission.title}${mission.status ? ` [${mission.status}]` : ""}${mission.outcomeSummary ? ` — ${mission.outcomeSummary}` : mission.intentSummary ? ` — ${mission.intentSummary}` : ""}`);
    }
    for (const digest of payload.workerDigests) {
      lines.push(`- Worker digest: ${digest.stepKey ?? "worker"} ${digest.status} — ${digest.summary}`);
    }
    for (const delta of payload.sessionDeltas) {
      if (delta.failureLines.length > 0) {
        lines.push(`- Session delta: ${delta.failureLines.join(" | ")}`);
      }
    }
    for (const review of payload.priorReviews) {
      lines.push(`- Prior ADE review: ${review.summary ?? "No summary"}${review.overlappingPaths.length > 0 ? ` (overlaps ${review.overlappingPaths.join(", ")})` : ""}`);
    }
    for (const signal of payload.lateStageSignals) {
      lines.push(`- Late-stage signal: ${signal.summary}`);
    }
    return truncatePromptSection(lines.length > 0 ? lines.join("\n") : "- No ADE provenance or intent context was available.");
  }

  function buildRulesPrompt(overlays: MatchedReviewRuleOverlay[]): string {
    if (overlays.length === 0) {
      return "- No ADE repo/path-specific rule overlay matched the changed paths.";
    }
    const lines = overlays.map((overlay) => {
      const coverage = overlay.missingFamilies.length > 0
        ? `missing companion coverage: ${overlay.missingFamilies.map((family) => family.label).join(", ")}`
        : "companion families touched in this diff";
      return `- ${overlay.label}: matched ${overlay.matchedPaths.join(", ")}; ${coverage}; rollout expectations: ${overlay.rolloutExpectations.join(" ")}`;
    });
    return truncatePromptSection(lines.join("\n"));
  }

  function buildValidationPrompt(payload: ReviewContextValidationPayload): string {
    const lines: string[] = [];
    if (payload.linkedPr) {
      lines.push(`- Linked PR: ${payload.linkedPr.repo} #${payload.linkedPr.prId}${payload.linkedPr.title ? ` — ${payload.linkedPr.title}` : ""}`);
    }
    for (const signal of payload.signals) {
      lines.push(`- Validation signal: ${signal.summary}`);
    }
    if (payload.signals.length === 0 && payload.testRuns.length > 0) {
      const latestRuns = payload.testRuns.slice(0, 2).map((run) => `${run.suiteName}: ${run.status}`).join(" | ");
      lines.push(`- Recent test runs: ${latestRuns}`);
    }
    return truncatePromptSection(lines.length > 0 ? lines.join("\n") : "- No prior ADE validation signals were available.");
  }

  function buildProvenanceSummary(payload: ReviewContextProvenancePayload): string {
    const parts = [
      payload.missions.length > 0 ? `${payload.missions.length} mission` : null,
      payload.workerDigests.length > 0 ? `${payload.workerDigests.length} worker digest${payload.workerDigests.length === 1 ? "" : "s"}` : null,
      payload.sessionDeltas.length > 0 ? `${payload.sessionDeltas.length} session delta${payload.sessionDeltas.length === 1 ? "" : "s"}` : null,
      payload.priorReviews.length > 0 ? `${payload.priorReviews.length} prior review${payload.priorReviews.length === 1 ? "" : "s"}` : null,
      payload.lateStageSignals.length > 0 ? `${payload.lateStageSignals.length} late-stage signal${payload.lateStageSignals.length === 1 ? "" : "s"}` : null,
    ].filter((value): value is string => Boolean(value));
    return parts.length > 0 ? parts.join(", ") : "No ADE provenance context";
  }

  function buildRulesSummary(overlays: MatchedReviewRuleOverlay[]): string {
    if (overlays.length === 0) return "No rule overlays matched";
    return `${overlays.length} rule overlay${overlays.length === 1 ? "" : "s"} matched`;
  }

  function buildValidationSummary(payload: ReviewContextValidationPayload): string {
    const parts = [
      payload.signals.length > 0 ? `${payload.signals.length} validation signal${payload.signals.length === 1 ? "" : "s"}` : null,
      payload.checks.length > 0 ? `${payload.checks.length} check${payload.checks.length === 1 ? "" : "s"}` : null,
      payload.testRuns.length > 0 ? `${payload.testRuns.length} test run${payload.testRuns.length === 1 ? "" : "s"}` : null,
      payload.issueInventory.length > 0 ? `${payload.issueInventory.length} inventory item${payload.issueInventory.length === 1 ? "" : "s"}` : null,
    ].filter((value): value is string => Boolean(value));
    return parts.length > 0 ? parts.join(", ") : "No validation signals";
  }

  return {
    async buildContext(args: {
      run: ReviewRun;
      materialized: ReviewMaterializedTarget;
    }): Promise<ReviewContextPacket> {
      const changedPaths = args.materialized.changedFiles.map((file) => file.filePath);
      const laneSnapshot = laneService.getStateSnapshot(args.run.laneId);
      const missionRow = getMissionRow(args.run.laneId);
      const sessionDeltas = sessionDeltaService.listRecentLaneSessionDeltas(args.run.laneId, SESSION_DELTA_LIMIT);
      const workerDigests = listWorkerDigests(missionRow?.mission_id ?? null, args.run.laneId);
      const priorReviews = listPriorReviews(args.run.id, args.run.laneId, changedPaths);
      const linkedPr = getLinkedPrRow(args.run);
      const matchedRules = matchReviewRuleOverlays(changedPaths);
      const validationPayload = await buildValidationPayload({
        laneId: args.run.laneId,
        changedPaths,
        linkedPr,
        sessionDeltas: sessionDeltas.map((delta) => ({
          sessionId: delta.sessionId,
          startedAt: delta.startedAt,
          endedAt: delta.endedAt,
          filesChanged: delta.filesChanged,
          touchedFiles: delta.touchedFiles,
          failureLines: delta.failureLines,
          computedAt: delta.computedAt,
        })),
      });
      const provenancePayload = buildProvenancePayload({
        materialized: args.materialized,
        laneSnapshot,
        missionRow,
        workerDigests,
        sessionDeltas,
        priorReviews,
        validation: validationPayload,
      });
      const rulesPayload: ReviewContextRulesPayload = {
        changedPaths,
        overlays: matchedRules.map((overlay) => ({
          id: overlay.id,
          label: overlay.label,
          description: overlay.description,
          matchedPaths: overlay.matchedPaths,
          rolloutExpectations: overlay.rolloutExpectations,
          coveredFamilies: overlay.coveredFamilies,
          missingFamilies: overlay.missingFamilies,
          adjudicationPolicy: overlay.adjudicationPolicy,
        })),
      };

      return {
        matchedRuleOverlays: matchedRules,
        provenance: {
          summary: buildProvenanceSummary(provenancePayload),
          prompt: buildProvenancePrompt(provenancePayload),
          payload: provenancePayload,
          metadata: {
            summary: buildProvenanceSummary(provenancePayload),
            provenanceCount:
              provenancePayload.missions.length
              + provenancePayload.workerDigests.length
              + provenancePayload.sessionDeltas.length
              + provenancePayload.priorReviews.length
              + provenancePayload.lateStageSignals.length,
            missionCount: provenancePayload.missions.length,
            workerDigestCount: provenancePayload.workerDigests.length,
            sessionDeltaCount: provenancePayload.sessionDeltas.length,
            priorReviewCount: provenancePayload.priorReviews.length,
            lateStageSignalCount: provenancePayload.lateStageSignals.length,
          },
        },
        rules: {
          summary: buildRulesSummary(matchedRules),
          prompt: buildRulesPrompt(matchedRules),
          payload: rulesPayload,
          metadata: {
            summary: buildRulesSummary(matchedRules),
            matchedRuleCount: matchedRules.length,
            ruleCount: matchedRules.length,
            pathCount: changedPaths.length,
            matchedRuleIds: matchedRules.map((overlay) => overlay.id),
          },
        },
        validation: {
          summary: buildValidationSummary(validationPayload),
          prompt: buildValidationPrompt(validationPayload),
          payload: validationPayload,
          metadata: {
            summary: buildValidationSummary(validationPayload),
            signalCount: validationPayload.signals.length,
            checkCount: validationPayload.checks.length,
            testRunCount: validationPayload.testRuns.length,
            issueCount: validationPayload.issueInventory.length,
            sessionFailureCount: validationPayload.sessionFailures.length,
            suiteCount: validationPayload.suites.length,
          },
        },
      };
    },
  };
}
