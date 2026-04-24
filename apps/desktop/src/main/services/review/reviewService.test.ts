import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewPublicationDestination, ReviewRunConfig } from "../../../shared/types";

const mockMaterializer = vi.hoisted(() => ({
  materialize: vi.fn(),
}));

const mockContextBuilder = vi.hoisted(() => ({
  buildContext: vi.fn(),
}));

vi.mock("./reviewTargetMaterializer", () => ({
  createReviewTargetMaterializer: () => ({
    materialize: (...args: unknown[]) => mockMaterializer.materialize(...args),
  }),
}));

vi.mock("./reviewContextBuilder", () => ({
  createReviewContextBuilder: () => ({
    buildContext: (...args: unknown[]) => mockContextBuilder.buildContext(...args),
  }),
}));

import { createReviewService } from "./reviewService";

type SqlValue = string | number | null | Uint8Array;
type AdeDb = {
  run: (sql: string, params?: SqlValue[]) => void;
  get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T | null;
  all: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T[];
};

function mapExecRows(rows: { columns: string[]; values: unknown[][] }[]): Record<string, unknown>[] {
  const first = rows[0];
  if (!first) return [];
  return first.values.map((row) => {
    const out: Record<string, unknown> = {};
    first.columns.forEach((column, index) => {
      out[column] = row[index];
    });
    return out;
  });
}

let SQL: SqlJsStatic;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const wasmDir = path.dirname(wasmPath);
  SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir, file),
  });
});

function createInMemoryAdeDb(): { db: AdeDb; raw: Database } {
  const raw = new SQL.Database();
  raw.run(`
    create table review_runs(
      id text primary key,
      project_id text not null,
      lane_id text not null,
      target_json text not null,
      config_json text not null,
      target_label text not null,
      compare_target_json text,
      status text not null,
      summary text,
      error_message text,
      finding_count integer not null default 0,
      severity_summary_json text,
      chat_session_id text,
      created_at text not null,
      started_at text not null,
      ended_at text,
      updated_at text not null
    )
  `);
  raw.run(`
    create table review_findings(
      id text primary key,
      run_id text not null,
      title text not null,
      severity text not null,
      finding_class text,
      body text not null,
      confidence real not null default 0.5,
      evidence_json text,
      file_path text,
      line integer,
      anchor_state text not null,
      source_pass text not null,
      publication_state text not null,
      originating_passes_json text,
      adjudication_json text,
      diff_context_json text,
      suppression_match_json text
    )
  `);
  raw.run(`
    create table review_finding_feedback(
      id text primary key,
      finding_id text not null,
      run_id text not null,
      project_id text not null,
      kind text not null,
      reason text,
      note text,
      snooze_until text,
      created_at text not null
    )
  `);
  raw.run(`
    create table review_suppressions(
      id text primary key,
      project_id text not null,
      scope text not null,
      repo_key text,
      path_pattern text,
      title text not null,
      title_norm text not null,
      finding_class text,
      severity text,
      reason text,
      note text,
      embedding_json text,
      source_finding_id text,
      hit_count integer not null default 0,
      created_at text not null,
      last_matched_at text
    )
  `);
  raw.run(`
    create table review_run_artifacts(
      id text primary key,
      run_id text not null,
      artifact_type text not null,
      title text not null,
      mime_type text not null,
      content_text text,
      metadata_json text,
      created_at text not null
    )
  `);
  raw.run(`
    create table review_run_publications(
      id text primary key,
      run_id text not null,
      destination_json text not null,
      review_event text not null,
      status text not null,
      review_url text,
      remote_review_id text,
      summary_body text not null,
      inline_comments_json text not null default '[]',
      summary_finding_ids_json text not null default '[]',
      error_message text,
      created_at text not null,
      updated_at text not null,
      completed_at text
    )
  `);

  const run = (sql: string, params: SqlValue[] = []) => raw.run(sql, params);
  const all = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] =>
    mapExecRows(raw.exec(sql, params)) as T[];
  const get = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | null =>
    all<T>(sql, params)[0] ?? null;

  return { raw, db: { run, all, get } };
}

async function waitFor<T>(fn: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for review service state");
}

function makeConfig(overrides: Partial<ReviewRunConfig> = {}): ReviewRunConfig {
  return {
    compareAgainst: { kind: "default_branch" },
    selectionMode: "full_diff",
    dirtyOnly: false,
    modelId: "openai/gpt-5.4-codex",
    reasoningEffort: "medium",
    budgets: {
      maxFiles: 60,
      maxDiffChars: 180_000,
      maxPromptChars: 220_000,
      maxFindings: 12,
      maxFindingsPerPass: 6,
      maxPublishedFindings: 6,
    },
    publishBehavior: "local_only",
    ...overrides,
  };
}

function makeChangedFile(overrides: Partial<{
  filePath: string;
  excerpt: string;
  lineNumbers: number[];
  diffPositionsByLine: Record<number, number>;
}> = {}) {
  return {
    filePath: "src/review.ts",
    excerpt: "@@ -1,2 +1,4 @@\n context\n+return null;\n+missing fallback\n",
    lineNumbers: [2, 3],
    diffPositionsByLine: { 2: 1, 3: 2 },
    ...overrides,
  };
}

function makeMaterializedTarget(overrides: Partial<{
  targetLabel: string;
  publicationTarget: ReviewPublicationDestination | null;
  fullPatchText: string;
  changedFiles: ReturnType<typeof makeChangedFile>[];
}> = {}) {
  const fullPatchText = overrides.fullPatchText
    ?? "diff --git a/src/review.ts b/src/review.ts\n@@ -1,2 +1,4 @@\n context\n+return null;\n+missing fallback\n";
  const changedFiles = overrides.changedFiles ?? [makeChangedFile()];
  return {
    targetLabel: overrides.targetLabel ?? "feature/review-tab vs main",
    compareTarget: {
      kind: "default_branch",
      label: "main",
      ref: "main",
      laneId: null,
      branchRef: "main",
    },
    publicationTarget: overrides.publicationTarget ?? null,
    fullPatchText,
    changedFiles,
    artifacts: [
      {
        artifactType: "diff_bundle",
        title: "Diff bundle",
        mimeType: "text/plain",
        contentText: fullPatchText,
        metadata: null,
      },
    ],
  };
}

function makeFinding(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    title: "Missing fallback",
    severity: "high",
    body: "The branch returns null without the previous fallback path.",
    confidence: 0.84,
    filePath: "src/review.ts",
    line: 2,
    evidence: [
      {
        summary: "The diff adds a direct null return.",
        filePath: "src/review.ts",
        line: 2,
        quote: "+return null;",
      },
    ],
    ...overrides,
  };
}

function makeOutput(summary: string, findings: Array<Record<string, unknown>>): string {
  return JSON.stringify({ summary, findings });
}

function makeContextPacket(overrides: Partial<Record<string, any>> = {}) {
  return {
    matchedRuleOverlays: [],
    provenance: {
      summary: "1 mission, 1 late-stage signal",
      prompt: "- Mission: keep renderer and preload behavior aligned.\n- Late-stage signal: recent validation failed on src/review.ts",
      payload: {
        changedPaths: ["src/review.ts"],
        laneSnapshot: {
          updatedAt: "2026-04-06T09:58:00.000Z",
          agentSummary: "Recent ADE chat focused on restoring the review fallback path.",
          missionSummary: "Finish the review engine rollout cleanly.",
        },
        missions: [
          {
            id: "mission-1",
            title: "Restore review fallback behavior",
            status: "running",
            outcomeSummary: null,
            intentSummary: "Keep fallback behavior and ship the review engine safely.",
            updatedAt: "2026-04-06T09:59:00.000Z",
          },
        ],
        workerDigests: [
          {
            id: "digest-1",
            stepKey: "implement",
            status: "succeeded",
            summary: "Updated the review engine behavior.",
            filesChanged: ["src/review.ts"],
            testsSummary: "1 failed",
            warnings: [],
            createdAt: "2026-04-06T10:00:00.000Z",
          },
        ],
        sessionDeltas: [
          {
            sessionId: "session-delta-1",
            startedAt: "2026-04-06T09:55:00.000Z",
            endedAt: "2026-04-06T09:57:00.000Z",
            filesChanged: 1,
            touchedFiles: ["src/review.ts"],
            failureLines: ["AssertionError: fallback missing"],
            computedAt: "2026-04-06T09:57:10.000Z",
          },
        ],
        priorReviews: [
          {
            runId: "prior-run-1",
            status: "completed",
            summary: "Earlier ADE review flagged the same fallback path.",
            findingCount: 1,
            publicationCount: 0,
            overlappingPaths: ["src/review.ts"],
            createdAt: "2026-04-05T16:00:00.000Z",
          },
        ],
        lateStageSignals: [
          {
            kind: "validation_failure_followed_by_edits",
            summary: "Recent validation failed on src/review.ts before this edit.",
            filePaths: ["src/review.ts"],
            source: "session-delta-1",
            occurredAt: "2026-04-06T09:57:10.000Z",
          },
        ],
      },
      metadata: {
        summary: "1 mission, 1 worker digest, 1 session delta, 1 late-stage signal",
        provenanceCount: 4,
        missionCount: 1,
        workerDigestCount: 1,
        sessionDeltaCount: 1,
        priorReviewCount: 1,
        lateStageSignalCount: 1,
      },
    },
    rules: {
      summary: "1 rule overlay matched",
      prompt: "- Preload bridge: matched src/review.ts; missing companion coverage: renderer consumer",
      payload: {
        changedPaths: ["src/review.ts"],
        overlays: [],
      },
      metadata: {
        summary: "1 rule overlay matched",
        matchedRuleCount: 1,
        ruleCount: 1,
        pathCount: 1,
        matchedRuleIds: ["renderer-surface"],
      },
    },
    validation: {
      summary: "2 validation signals, 1 check, 1 test run",
      prompt: "- Validation signal: unit-tests failure\n- Validation signal: fallback assertion failed",
      payload: {
        linkedPr: null,
        reviewSnapshot: null,
        checks: [
          {
            name: "unit-tests",
            status: "completed",
            conclusion: "failure",
            detailsUrl: "https://ci.example/unit-tests",
            startedAt: "2026-04-06T10:00:00.000Z",
            completedAt: "2026-04-06T10:03:00.000Z",
          },
        ],
        suites: ["unit"],
        testRuns: [
          {
            runId: "test-run-1",
            suiteId: "unit",
            suiteName: "Unit",
            status: "failed",
            exitCode: 1,
            startedAt: "2026-04-06T10:00:00.000Z",
            endedAt: "2026-04-06T10:02:00.000Z",
            logExcerpt: "AssertionError: fallback missing",
          },
        ],
        issueInventory: [],
        sessionFailures: [
          {
            sessionId: "session-delta-1",
            touchedFiles: ["src/review.ts"],
            failureLines: ["AssertionError: fallback missing"],
            computedAt: "2026-04-06T09:57:10.000Z",
          },
        ],
        signals: [
          {
            kind: "pr_check_failure",
            summary: "unit-tests: completed / failure",
            filePaths: [],
            sourceId: "unit-tests",
          },
          {
            kind: "session_failure",
            summary: "AssertionError: fallback missing",
            filePaths: ["src/review.ts"],
            sourceId: "session-delta-1",
          },
        ],
      },
      metadata: {
        summary: "2 validation signals, 1 check, 1 test run",
        signalCount: 2,
        checkCount: 1,
        testRunCount: 1,
        issueCount: 0,
        sessionFailureCount: 1,
        suiteCount: 1,
      },
    },
    ...overrides,
  };
}

function buildPublicationResult(args: {
  runId: string;
  destination: ReviewPublicationDestination;
  findings: Array<{ id: string; filePath: string | null; line: number | null }>;
}) {
  const firstInline = args.findings.find((finding) => finding.filePath && finding.line != null) ?? null;
  return {
    id: `publication-${args.runId}`,
    runId: args.runId,
    destination: args.destination,
    reviewEvent: "COMMENT" as const,
    status: "published" as const,
    reviewUrl: "https://github.com/ade-dev/ade/pull/80#pullrequestreview-1",
    remoteReviewId: "1",
    summaryBody: "Summary body",
    inlineComments: firstInline ? [{
      findingId: firstInline.id,
      path: firstInline.filePath ?? "src/review.ts",
      line: firstInline.line ?? 1,
      position: 2,
      body: "Inline comment",
    }] : [],
    summaryFindingIds: args.findings.filter((finding) => !firstInline || finding.id !== firstInline.id).map((finding) => finding.id),
    errorMessage: null,
    createdAt: "2026-04-06T10:00:00.000Z",
    updatedAt: "2026-04-06T10:00:02.000Z",
    completedAt: "2026-04-06T10:00:02.000Z",
  };
}

function createHarness(args: {
  outputs: string[];
  targetLabel?: string;
  publicationTarget?: ReviewPublicationDestination | null;
  config?: Partial<ReviewRunConfig>;
  target?: { mode: "lane_diff" | "pr" | "commit_range" | "working_tree"; laneId: string; prId?: string; baseCommit?: string; headCommit?: string };
}) {
  const { db, raw } = createInMemoryAdeDb();
  let sessionCount = 0;
  const queuedOutputs = [...args.outputs];
  const publishReviewPublication = vi.fn(async (input: any) => buildPublicationResult({
    runId: input.runId,
    destination: input.destination,
    findings: input.findings,
  }));

  mockMaterializer.materialize.mockResolvedValue(makeMaterializedTarget({
    targetLabel: args.targetLabel,
    publicationTarget: args.publicationTarget ?? null,
  }));
  mockContextBuilder.buildContext.mockResolvedValue(makeContextPacket());

  const runSessionTurn = vi.fn(async () => {
    const outputText = queuedOutputs.shift();
    if (!outputText) throw new Error("No mock review output left.");
    return {
      sessionId: `session-review-${sessionCount}`,
      provider: "codex",
      model: "gpt-5.4-codex",
      modelId: "openai/gpt-5.4-codex",
      outputText,
    };
  });

  const service = createReviewService({
    db: db as any,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any,
    projectId: "project-1",
    projectRoot: "/tmp/ade",
    projectDefaultBranch: "main",
    laneService: {
      getLaneBaseAndBranch: vi.fn().mockReturnValue({
        baseRef: "main",
        branchRef: "feature/review-tab",
        worktreePath: "/tmp/ade/lane",
        laneType: "worktree",
      }),
      getStateSnapshot: vi.fn().mockReturnValue(null),
      list: vi.fn(async () => []),
    } as any,
    gitService: {
      listRecentCommits: vi.fn(async () => []),
    } as any,
    agentChatService: {
      createSession: vi.fn(async () => {
        sessionCount += 1;
        return {
          id: `session-review-${sessionCount}`,
          laneId: "lane-review",
          provider: "codex",
          model: "gpt-5.4-codex",
          modelId: "openai/gpt-5.4-codex",
        };
      }),
      getSessionSummary: vi.fn(async (sessionId: string) => ({
        sessionId,
        laneId: "lane-review",
        provider: "codex",
        model: "gpt-5.4-codex",
        modelId: "openai/gpt-5.4-codex",
        title: "Review transcript",
        surface: "automation",
        status: "idle",
        startedAt: "2026-04-05T12:00:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-04-05T12:05:00.000Z",
        lastOutputPreview: "Review output",
        summary: "Saved review transcript",
      })),
      runSessionTurn,
    } as any,
    sessionService: {
      updateMeta: vi.fn(),
    } as any,
    sessionDeltaService: {
      listRecentLaneSessionDeltas: vi.fn().mockReturnValue([]),
    } as any,
    testService: {
      listRuns: vi.fn().mockReturnValue([]),
      getLogTail: vi.fn().mockReturnValue(""),
      listSuites: vi.fn().mockReturnValue([]),
    } as any,
    issueInventoryService: {
      getInventory: vi.fn().mockReturnValue({ prId: "pr-80", items: [], convergence: {}, runtime: {} }),
    } as any,
    prService: args.publicationTarget ? {
      getReviewSnapshot: vi.fn(),
      getChecks: vi.fn(async () => [
        {
          name: "unit-tests",
          status: "completed",
          conclusion: "failure",
          detailsUrl: "https://ci.example/unit-tests",
          startedAt: "2026-04-06T10:00:00.000Z",
          completedAt: "2026-04-06T10:03:00.000Z",
        },
      ]),
      publishReviewPublication,
    } as any : undefined,
  });

  const target = args.target?.mode === "pr"
    ? { mode: "pr" as const, laneId: args.target.laneId, prId: args.target.prId ?? "pr-80" }
    : args.target?.mode === "commit_range"
      ? {
          mode: "commit_range" as const,
          laneId: args.target.laneId,
          baseCommit: args.target.baseCommit ?? "abc123456789",
          headCommit: args.target.headCommit ?? "def456789012",
        }
      : args.target?.mode === "working_tree"
        ? { mode: "working_tree" as const, laneId: args.target.laneId }
        : { mode: "lane_diff" as const, laneId: args.target?.laneId ?? "lane-review" };

  return {
    raw,
    service,
    runSessionTurn,
    publishReviewPublication,
    start: (config?: Partial<ReviewRunConfig>) => service.startRun({
      target,
      config: makeConfig({
        ...(args.config ?? {}),
        ...(config ?? {}),
      }),
    }),
  };
}

describe("reviewService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges overlapping multi-pass findings and persists the pass-level artifact trail", async () => {
    const harness = createHarness({
      outputs: [
        makeOutput("Direct diff risk.", [
          makeFinding(),
        ]),
        makeOutput("Cross-file corroboration.", [
          makeFinding({
            title: "Fallback path removed",
            body: "The previous fallback is gone, so downstream callers can now receive null.",
            confidence: 0.79,
          }),
        ]),
        makeOutput("No extra check findings.", []),
      ],
    });

    const run = await harness.start();
    await waitFor(
      () => harness.service.listRuns(),
      (runs) => runs[0]?.status === "completed",
    );

    const detail = await harness.service.getRunDetail({ runId: run.id });
    expect(detail?.findingCount).toBe(1);
    expect(detail?.findings[0]?.sourcePass).toBe("adjudicated");
    expect(detail?.findings[0]?.originatingPasses).toEqual(["diff-risk", "cross-file-impact"]);
    expect(detail?.findings[0]?.adjudication?.mergedFindingIds).toHaveLength(2);
    expect(detail?.artifacts.filter((artifact) => artifact.artifactType === "pass_prompt")).toHaveLength(3);
    expect(detail?.artifacts.filter((artifact) => artifact.artifactType === "pass_output")).toHaveLength(3);
    expect(detail?.artifacts.filter((artifact) => artifact.artifactType === "pass_findings")).toHaveLength(3);
    expect(detail?.artifacts.some((artifact) => artifact.artifactType === "adjudication_result")).toBe(true);
    expect(detail?.artifacts.some((artifact) => artifact.artifactType === "merged_findings")).toBe(true);

    const persistedFindings = mapExecRows(harness.raw.exec("select source_pass, originating_passes_json, adjudication_json from review_findings"));
    expect(String(persistedFindings[0]?.source_pass)).toBe("adjudicated");
    expect(String(persistedFindings[0]?.originating_passes_json)).toContain("diff-risk");
    expect(String(persistedFindings[0]?.adjudication_json)).toContain("publicationEligible");
  });

  it("persists provenance, rules, and validation artifacts and keeps renderer findings on the normal evidence path", async () => {
    const harness = createHarness({
      outputs: [
        makeOutput("Renderer regression.", [
          makeFinding({
            title: "Fallback intent drift",
            findingClass: "intent_drift",
          }),
        ]),
        makeOutput("No cross-file issues.", []),
        makeOutput("No checks issues.", []),
      ],
    });
    mockContextBuilder.buildContext.mockResolvedValueOnce(makeContextPacket({
      matchedRuleOverlays: [
        {
          id: "renderer-surface",
          label: "Renderer surface",
          description: "Renderer rule",
          pathPatterns: ["src/review.ts"],
          rolloutExpectations: ["Check user-visible fallback behavior."],
          companionFamilies: [{ id: "renderer", label: "renderer", pathPatterns: ["src/review.ts"] }],
          promptGuidance: { "diff-risk": ["Treat this as a visible renderer flow."] },
          adjudicationPolicy: { evidenceMode: "normal" },
          matchedPaths: ["src/review.ts"],
          coveredFamilies: [{ id: "renderer", label: "renderer" }],
          missingFamilies: [],
        },
      ],
      rules: {
        summary: "1 rule overlay matched",
        prompt: "- Renderer surface: check user-visible fallback behavior.",
        payload: {
          changedPaths: ["src/review.ts"],
          overlays: [{
            id: "renderer-surface",
            label: "Renderer surface",
            description: "Renderer rule",
            matchedPaths: ["src/review.ts"],
            rolloutExpectations: ["Check user-visible fallback behavior."],
            coveredFamilies: [{ id: "renderer", label: "renderer" }],
            missingFamilies: [],
            adjudicationPolicy: { evidenceMode: "normal" },
          }],
        },
        metadata: {
          summary: "1 rule overlay matched",
          matchedRuleCount: 1,
          ruleCount: 1,
          pathCount: 1,
          matchedRuleIds: ["renderer-surface"],
        },
      },
    }));

    const run = await harness.start();
    await waitFor(() => harness.service.listRuns(), (runs) => runs[0]?.status === "completed");

    const detail = await harness.service.getRunDetail({ runId: run.id });
    expect(detail?.findings).toHaveLength(1);
    expect(detail?.findings[0]?.findingClass).toBe("intent_drift");
    expect(detail?.artifacts.some((artifact) => artifact.artifactType === "provenance_brief")).toBe(true);
    expect(detail?.artifacts.some((artifact) => artifact.artifactType === "rule_overlays")).toBe(true);
    expect(detail?.artifacts.some((artifact) => artifact.artifactType === "validation_signals")).toBe(true);

    const harnessArtifact = detail?.artifacts.find((artifact) => artifact.artifactType === "prompt");
    expect(harnessArtifact?.metadata).toMatchObject({
      matchedRuleCount: 1,
      provenanceCount: 4,
      validationSignalCount: 2,
      matchedRuleIds: ["renderer-surface"],
    });

    const firstPassPrompt = detail?.artifacts.find((artifact) => artifact.artifactType === "pass_prompt");
    expect(firstPassPrompt?.contentText).toContain("provenance_brief artifact id");
    expect(firstPassPrompt?.contentText).toContain("rule_overlays artifact id");

    const persisted = mapExecRows(harness.raw.exec("select finding_class from review_findings"));
    expect(String(persisted[0]?.finding_class)).toBe("intent_drift");
  });

  it("rejects strict preload/shared findings without cross-boundary or provenance-backed evidence", async () => {
    const harness = createHarness({
      outputs: [
        makeOutput("Bridge mismatch.", [
          makeFinding({
            title: "Bridge rollout incomplete",
            findingClass: "incomplete_rollout",
            evidence: [
              {
                summary: "The preload diff changes the exposed method name.",
                filePath: "src/review.ts",
                line: 2,
                quote: "+exposeReviewV2()",
              },
            ],
          }),
        ]),
        makeOutput("No cross-file issues.", []),
        makeOutput("No checks issues.", []),
      ],
    });
    mockContextBuilder.buildContext.mockResolvedValueOnce(makeContextPacket({
      provenance: {
        summary: "No ADE provenance context",
        prompt: "- No ADE provenance or intent context was available.",
        payload: {
          changedPaths: ["src/review.ts"],
          laneSnapshot: null,
          missions: [],
          workerDigests: [],
          sessionDeltas: [],
          priorReviews: [],
          lateStageSignals: [],
        },
        metadata: {
          summary: "No ADE provenance context",
          provenanceCount: 0,
          missionCount: 0,
          workerDigestCount: 0,
          sessionDeltaCount: 0,
          priorReviewCount: 0,
          lateStageSignalCount: 0,
        },
      },
      matchedRuleOverlays: [
        {
          id: "preload-bridge",
          label: "Preload bridge",
          description: "Strict bridge rule",
          pathPatterns: ["src/review.ts"],
          rolloutExpectations: ["Keep bridge and consumer updates aligned."],
          companionFamilies: [
            { id: "preload", label: "preload", pathPatterns: ["src/review.ts"] },
            { id: "renderer", label: "renderer", pathPatterns: ["src/renderer.ts"] },
          ],
          promptGuidance: { "cross-file-impact": ["Check both sides of the bridge."] },
          adjudicationPolicy: { evidenceMode: "cross_boundary" },
          matchedPaths: ["src/review.ts"],
          coveredFamilies: [{ id: "preload", label: "preload" }],
          missingFamilies: [{ id: "renderer", label: "renderer" }],
        },
      ],
      rules: {
        summary: "1 rule overlay matched",
        prompt: "- Preload bridge: missing companion coverage: renderer",
        payload: {
          changedPaths: ["src/review.ts"],
          overlays: [{
            id: "preload-bridge",
            label: "Preload bridge",
            description: "Strict bridge rule",
            matchedPaths: ["src/review.ts"],
            rolloutExpectations: ["Keep bridge and consumer updates aligned."],
            coveredFamilies: [{ id: "preload", label: "preload" }],
            missingFamilies: [{ id: "renderer", label: "renderer" }],
            adjudicationPolicy: { evidenceMode: "cross_boundary" },
          }],
        },
        metadata: {
          summary: "1 rule overlay matched",
          matchedRuleCount: 1,
          ruleCount: 1,
          pathCount: 1,
          matchedRuleIds: ["preload-bridge"],
        },
      },
      validation: {
        summary: "No validation signals",
        prompt: "- No prior ADE validation signals were available.",
        payload: {
          linkedPr: null,
          reviewSnapshot: null,
          checks: [],
          suites: [],
          testRuns: [],
          issueInventory: [],
          sessionFailures: [],
          signals: [],
        },
        metadata: {
          summary: "No validation signals",
          signalCount: 0,
          checkCount: 0,
          testRunCount: 0,
          issueCount: 0,
          sessionFailureCount: 0,
          suiteCount: 0,
        },
      },
    }));

    const run = await harness.start();
    await waitFor(() => harness.service.listRuns(), (runs) => runs[0]?.status === "completed");

    const detail = await harness.service.getRunDetail({ runId: run.id });
    expect(detail?.findings).toEqual([]);
    const adjudicationArtifact = detail?.artifacts.find((artifact) => artifact.artifactType === "adjudication_result");
    expect(adjudicationArtifact?.contentText).toContain("rule_policy");
  });

  it("cites validation and provenance artifacts when late-stage signals back the finding", async () => {
    const harness = createHarness({
      outputs: [
        makeOutput("No diff-risk issues.", []),
        makeOutput("No cross-file issues.", []),
        makeOutput("Validation-backed regression.", [
          makeFinding({
            title: "Fallback broke after the failed validation loop",
            filePath: "src/review.ts",
            line: 2,
            evidence: [
              {
                summary: "The diff still returns null directly.",
                filePath: "src/review.ts",
                line: 2,
                quote: "+return null;",
              },
            ],
          }),
        ]),
      ],
    });
    mockContextBuilder.buildContext.mockResolvedValueOnce(makeContextPacket({
      matchedRuleOverlays: [
        {
          id: "renderer-surface",
          label: "Renderer surface",
          description: "Renderer rule",
          pathPatterns: ["src/review.ts"],
          rolloutExpectations: ["Check the fallback behavior."],
          companionFamilies: [{ id: "renderer", label: "renderer", pathPatterns: ["src/review.ts"] }],
          promptGuidance: {},
          adjudicationPolicy: { evidenceMode: "normal" },
          matchedPaths: ["src/review.ts"],
          coveredFamilies: [{ id: "renderer", label: "renderer" }],
          missingFamilies: [],
        },
      ],
      rules: {
        summary: "1 rule overlay matched",
        prompt: "- Renderer surface: check fallback behavior.",
        payload: {
          changedPaths: ["src/review.ts"],
          overlays: [{
            id: "renderer-surface",
            label: "Renderer surface",
            description: "Renderer rule",
            matchedPaths: ["src/review.ts"],
            rolloutExpectations: ["Check the fallback behavior."],
            coveredFamilies: [{ id: "renderer", label: "renderer" }],
            missingFamilies: [],
            adjudicationPolicy: { evidenceMode: "normal" },
          }],
        },
        metadata: {
          summary: "1 rule overlay matched",
          matchedRuleCount: 1,
          ruleCount: 1,
          pathCount: 1,
          matchedRuleIds: ["renderer-surface"],
        },
      },
    }));

    const run = await harness.start();
    await waitFor(() => harness.service.listRuns(), (runs) => runs[0]?.status === "completed");

    const detail = await harness.service.getRunDetail({ runId: run.id });
    expect(detail?.findings).toHaveLength(1);
    expect(detail?.findings[0]?.findingClass).toBe("late_stage_regression");
    expect(detail?.findings[0]?.evidence.some((entry) => entry.artifactId && entry.artifactId.length > 0)).toBe(true);
    const artifactKinds = new Set(detail?.findings[0]?.evidence.map((entry) => entry.artifactId).filter(Boolean));
    expect(artifactKinds.size).toBeGreaterThanOrEqual(2);
  });

  it("uses late-stage regression when overlapping passes disagree on ADE-native class", async () => {
    const harness = createHarness({
      outputs: [
        makeOutput("Intent drift.", [
          makeFinding({
            title: "Fallback intent drift",
            findingClass: "intent_drift",
          }),
        ]),
        makeOutput("Late-stage corroboration.", [
          makeFinding({
            title: "Fallback intent drift",
            findingClass: "late_stage_regression",
            body: "The same fallback regression reappeared after the failed validation loop.",
            confidence: 0.79,
          }),
        ]),
        makeOutput("No checks issues.", []),
      ],
    });

    const run = await harness.start();
    await waitFor(() => harness.service.listRuns(), (runs) => runs[0]?.status === "completed");

    const detail = await harness.service.getRunDetail({ runId: run.id });
    expect(detail?.findings).toHaveLength(1);
    expect(detail?.findings[0]?.findingClass).toBe("late_stage_regression");
  });

  it("filters weak findings that do not carry concrete evidence", async () => {
    const harness = createHarness({
      outputs: [
        makeOutput("Weak comment.", [
          makeFinding({
            title: "Maybe rename this helper",
            severity: "low",
            body: "This name could be clearer for future readers.",
            confidence: 0.31,
            filePath: null,
            line: null,
            evidence: [],
          }),
        ]),
        makeOutput("No cross-file issues.", []),
        makeOutput("No checks issues.", []),
      ],
    });

    const run = await harness.start();
    await waitFor(
      () => harness.service.listRuns(),
      (runs) => runs[0]?.status === "completed",
    );

    const detail = await harness.service.getRunDetail({ runId: run.id });
    expect(detail?.findings).toEqual([]);
    expect(detail?.summary).toContain("filtered out during adjudication");

    const adjudicationArtifact = detail?.artifacts.find((artifact) => artifact.artifactType === "adjudication_result");
    expect(adjudicationArtifact?.contentText).toContain("low_evidence");
  });

  it("applies run and publication budgets and only publishes adjudicated findings", async () => {
    const destination: ReviewPublicationDestination = {
      kind: "github_pr_review",
      prId: "pr-80",
      repoOwner: "ade-dev",
      repoName: "ade",
      prNumber: 80,
      githubUrl: "https://github.com/ade-dev/ade/pull/80",
    };
    const harness = createHarness({
      publicationTarget: destination,
      targetLabel: "PR #80 feature/pr-80 -> main",
      target: { mode: "pr", laneId: "lane-review", prId: "pr-80" },
      config: {
        publishBehavior: "auto_publish",
        budgets: {
          maxFiles: 60,
          maxDiffChars: 180_000,
          maxPromptChars: 220_000,
          maxFindings: 2,
          maxFindingsPerPass: 4,
          maxPublishedFindings: 1,
        },
      },
      outputs: [
        makeOutput("Diff-risk findings.", [
          makeFinding({ title: "Null fallback removed", filePath: "src/review.ts", line: 2 }),
          makeFinding({ title: "Summary-only risk", severity: "medium", filePath: "src/review.ts", line: 200, evidence: [{ summary: "The diff changes behavior without a regression test.", filePath: "src/review.ts", line: 200, quote: "+missing test coverage" }] }),
        ]),
        makeOutput("Cross-file overlap.", [
          makeFinding({ title: "Fallback path removed", body: "Downstream callers now receive null.", filePath: "src/review.ts", line: 2, confidence: 0.76 }),
          makeFinding({
            title: "Dispatch invariant removed",
            severity: "high",
            body: "The worker dispatch path now skips the invariant check before enqueueing work.",
            filePath: "src/worker.ts",
            line: 10,
            evidence: [{ summary: "The patch drops the invariant guard in the worker path.", filePath: "src/worker.ts", line: 10, quote: "+dispatchWithoutInvariant()" }],
          }),
        ]),
        makeOutput("Checks and tests.", [
          makeFinding({ title: "Missing regression coverage", severity: "medium", filePath: "src/review.ts", line: 200, evidence: [{ summary: "A failing unit check suggests the diff lacks the previous safety net.", filePath: "src/review.ts", line: 200, quote: "unit-tests: completed / failure" }] }),
        ]),
      ],
    });

    const run = await harness.start();
    await waitFor(
      () => harness.service.listRuns(),
      (runs) => runs[0]?.status === "completed",
    );

    expect(harness.publishReviewPublication).toHaveBeenCalledTimes(1);
    const publicationArgs = harness.publishReviewPublication.mock.calls[0]?.[0];
    expect(publicationArgs.findings).toHaveLength(1);
    expect(publicationArgs.findings[0]?.sourcePass).toBe("adjudicated");

    const detail = await harness.service.getRunDetail({ runId: run.id });
    expect(detail?.findings).toHaveLength(2);
    expect(detail?.findings.filter((finding) => finding.publicationState === "published")).toHaveLength(1);
    expect(detail?.publications).toHaveLength(1);
    expect(detail?.artifacts.some((artifact) => artifact.artifactType === "publication_request")).toBe(true);
  });

  it("reruns a saved multi-pass review through the same shared engine", async () => {
    const harness = createHarness({
      outputs: [
        makeOutput("First pass run.", [makeFinding()]),
        makeOutput("Cross-file overlap.", [makeFinding({ title: "Fallback path removed", confidence: 0.71 })]),
        makeOutput("Checks clear.", []),
        makeOutput("Second run diff-risk.", [makeFinding()]),
        makeOutput("Second run cross-file.", [makeFinding({ title: "Fallback path removed", confidence: 0.71 })]),
        makeOutput("Second run checks.", []),
      ],
      target: {
        mode: "commit_range",
        laneId: "lane-review",
        baseCommit: "abc123456789",
        headCommit: "def456789012",
      },
      config: {
        selectionMode: "selected_commits",
        reasoningEffort: "high",
      },
    });

    const first = await harness.start();
    await waitFor(
      () => harness.service.listRuns(),
      (runs) => runs.some((run) => run.id === first.id && run.status === "completed"),
    );

    const rerun = await harness.service.rerun(first.id);
    await waitFor(
      () => harness.service.listRuns(),
      (runs) => runs.some((run) => run.id === rerun.id && run.status === "completed"),
    );

    expect(harness.runSessionTurn).toHaveBeenCalledTimes(6);
    const rerunDetail = await harness.service.getRunDetail({ runId: rerun.id });
    expect(rerunDetail?.artifacts.filter((artifact) => artifact.artifactType === "pass_prompt")).toHaveLength(3);

    const rerunRecord = (await harness.service.listRuns()).find((entry) => entry.id === rerun.id);
    expect(rerunRecord?.target).toEqual({
      mode: "commit_range",
      laneId: "lane-review",
      baseCommit: "abc123456789",
      headCommit: "def456789012",
    });
    expect(rerunRecord?.config.selectionMode).toBe("selected_commits");
    expect(rerunRecord?.config.reasoningEffort).toBe("high");
  });
});
