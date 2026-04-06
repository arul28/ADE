import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockMaterializer = vi.hoisted(() => ({
  materialize: vi.fn(),
}));

vi.mock("./reviewTargetMaterializer", () => ({
  createReviewTargetMaterializer: () => ({
    materialize: (...args: unknown[]) => mockMaterializer.materialize(...args),
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
      body text not null,
      confidence real not null default 0.5,
      evidence_json text,
      file_path text,
      line integer,
      anchor_state text not null,
      source_pass text not null,
      publication_state text not null
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

describe("reviewService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a completed review run and reopens its findings later", async () => {
    const { db, raw } = createInMemoryAdeDb();
    mockMaterializer.materialize.mockResolvedValue({
      targetLabel: "feature/review-tab vs main",
      compareTarget: {
        kind: "default_branch",
        label: "main",
        ref: "main",
        laneId: null,
        branchRef: "main",
      },
      publicationTarget: null,
      fullPatchText: "diff --git a/src/review.ts b/src/review.ts\n@@ -1,1 +1,2 @@\n+return null;\n",
      changedFiles: [
        {
          filePath: "src/review.ts",
          excerpt: "@@ -1,1 +1,2 @@\n+return null;",
          lineNumbers: [2],
          diffPositionsByLine: { 2: 1 },
        },
      ],
      artifacts: [
        {
          artifactType: "diff_bundle",
          title: "Diff bundle",
          mimeType: "text/plain",
          contentText: "diff --git a/src/review.ts b/src/review.ts\n@@ -1,1 +1,2 @@\n+return null;\n",
          metadata: null,
        },
      ],
    });

    const events: Array<{ type: string; runId?: string; status?: string }> = [];
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
        list: vi.fn(async () => [
          {
            id: "lane-review",
            name: "feature/review-tab",
            laneType: "worktree",
            baseRef: "main",
            branchRef: "feature/review-tab",
            color: null,
          },
        ]),
      } as any,
      gitService: {
        listRecentCommits: vi.fn(async () => [
          {
            sha: "abc1234567890",
            shortSha: "abc1234",
            parents: [],
            authorName: "Arul",
            authoredAt: "2026-04-05T12:00:00.000Z",
            subject: "Recent review work",
            pushed: true,
          },
        ]),
      } as any,
      agentChatService: {
        createSession: vi.fn(async () => ({
          id: "session-review-1",
          laneId: "lane-review",
          provider: "codex",
          model: "gpt-5.4-codex",
          modelId: "openai/gpt-5.4-codex",
        })),
        getSessionSummary: vi.fn(async () => ({
          sessionId: "session-review-1",
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
        runSessionTurn: vi.fn(async () => ({
          sessionId: "session-review-1",
          provider: "codex",
          model: "gpt-5.4-codex",
          modelId: "openai/gpt-5.4-codex",
          outputText: JSON.stringify({
            summary: "One anchored finding.",
            findings: [
              {
                title: "Missing fallback",
                severity: "high",
                body: "The new branch returns null without a fallback path.",
                confidence: 0.91,
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
              },
            ],
          }),
        })),
      } as any,
      sessionService: {
        updateMeta: vi.fn(),
      } as any,
      onEvent: (event) => {
        events.push({ type: event.type, runId: (event as any).runId, status: (event as any).status });
      },
    });

    const run = await service.startRun({
      target: { mode: "lane_diff", laneId: "lane-review" },
    });

    expect(run.status).toBe("queued");

    const completed = await waitFor(
      () => service.listRuns(),
      (runs) => runs[0]?.status === "completed",
    );
    expect(completed[0]?.targetLabel).toBe("feature/review-tab vs main");

    const detail = await service.getRunDetail({ runId: run.id });
    expect(detail?.summary).toBe("One anchored finding.");
    expect(detail?.findingCount).toBe(1);
    expect(detail?.findings[0]?.anchorState).toBe("anchored");
    expect(detail?.artifacts.some((artifact) => artifact.artifactType === "prompt")).toBe(true);
    expect(detail?.artifacts.some((artifact) => artifact.artifactType === "review_output")).toBe(true);
    expect(detail?.publications).toEqual([]);
    expect(detail?.chatSession?.sessionId).toBe("session-review-1");
    expect(events.some((event) => event.type === "run-completed" && event.runId === run.id && event.status === "completed")).toBe(true);

    const persistedRuns = mapExecRows(raw.exec("select status, finding_count from review_runs"));
    expect(String(persistedRuns[0]?.status)).toBe("completed");
    expect(Number(persistedRuns[0]?.finding_count)).toBe(1);
  });

  it("reruns a prior review with the same target and config", async () => {
    const { db } = createInMemoryAdeDb();
    mockMaterializer.materialize.mockResolvedValue({
      targetLabel: "feature/review-tab vs main",
      compareTarget: {
        kind: "default_branch",
        label: "main",
        ref: "main",
        laneId: null,
        branchRef: "main",
      },
      publicationTarget: null,
      fullPatchText: "",
      changedFiles: [],
      artifacts: [
        {
          artifactType: "diff_bundle",
          title: "Diff bundle",
          mimeType: "text/plain",
          contentText: "",
          metadata: null,
        },
      ],
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
        list: vi.fn(async () => []),
      } as any,
      gitService: {
        listRecentCommits: vi.fn(async () => []),
      } as any,
      agentChatService: {
        createSession: vi.fn(async () => ({
          id: "session-review-2",
          laneId: "lane-review",
          provider: "codex",
          model: "gpt-5.4-codex",
          modelId: "openai/gpt-5.4-codex",
        })),
        getSessionSummary: vi.fn(async () => null),
        runSessionTurn: vi.fn(async () => ({
          sessionId: "session-review-2",
          provider: "codex",
          model: "gpt-5.4-codex",
          modelId: "openai/gpt-5.4-codex",
          outputText: JSON.stringify({ summary: "No issues.", findings: [] }),
        })),
      } as any,
      sessionService: {
        updateMeta: vi.fn(),
      } as any,
    });

    const first = await service.startRun({
      target: {
        mode: "commit_range",
        laneId: "lane-review",
        baseCommit: "abc123456789",
        headCommit: "def456789012",
      },
      config: {
        selectionMode: "selected_commits",
        compareAgainst: { kind: "default_branch" },
        dirtyOnly: false,
        modelId: "openai/gpt-5.4-codex",
        reasoningEffort: "high",
        budgets: { maxFiles: 10, maxDiffChars: 1000, maxPromptChars: 1000, maxFindings: 4 },
        publishBehavior: "local_only",
      },
    });
    await waitFor(() => service.listRuns(), (runs) => runs.some((run) => run.id === first.id && run.status === "completed"));

    const rerun = await service.rerun(first.id);
    expect(rerun.id).not.toBe(first.id);
    await waitFor(() => service.listRuns(), (runs) => runs.some((run) => run.id === rerun.id && run.status === "completed"));

    const allRuns = await service.listRuns();
    const rerunRecord = allRuns.find((entry) => entry.id === rerun.id);
    expect(rerunRecord?.target).toEqual({
      mode: "commit_range",
      laneId: "lane-review",
      baseCommit: "abc123456789",
      headCommit: "def456789012",
    });
    expect(rerunRecord?.config.selectionMode).toBe("selected_commits");
    expect(rerunRecord?.config.reasoningEffort).toBe("high");
  });

  it("publishes PR-backed review runs, preserves summary findings, and reruns with the same publication flow", async () => {
    const { db } = createInMemoryAdeDb();
    mockMaterializer.materialize.mockResolvedValue({
      targetLabel: "PR #80 feature/pr-80 -> main",
      compareTarget: {
        kind: "default_branch",
        label: "main",
        ref: "main",
        laneId: null,
        branchRef: "main",
      },
      publicationTarget: {
        kind: "github_pr_review",
        prId: "pr-80",
        repoOwner: "ade-dev",
        repoName: "ade",
        prNumber: 80,
        githubUrl: "https://github.com/ade-dev/ade/pull/80",
      },
      fullPatchText: "diff --git a/src/review.ts b/src/review.ts\n@@ -10,2 +10,4 @@\n context\n+anchored\n+summary only\n",
      changedFiles: [
        {
          filePath: "src/review.ts",
          excerpt: "@@ -10,2 +10,4 @@\n context\n+anchored\n+summary only",
          lineNumbers: [10, 11, 12],
          diffPositionsByLine: { 10: 1, 11: 2, 12: 3 },
        },
      ],
      artifacts: [
        {
          artifactType: "diff_bundle",
          title: "Diff bundle",
          mimeType: "text/plain",
          contentText: "diff --git a/src/review.ts b/src/review.ts\n@@ -10,2 +10,4 @@\n context\n+anchored\n+summary only\n",
          metadata: null,
        },
      ],
    });

    const publishReviewPublication = vi.fn(async (args: any) => ({
      id: `publication-${args.runId}`,
      runId: args.runId,
      destination: args.destination,
      reviewEvent: "COMMENT",
      status: "published",
      reviewUrl: "https://github.com/ade-dev/ade/pull/80#pullrequestreview-1",
      remoteReviewId: "1",
      summaryBody: "Summary body",
      inlineComments: [
        {
          findingId: args.findings[0].id,
          path: "src/review.ts",
          line: 11,
          position: 2,
          body: "Inline comment",
        },
      ],
      summaryFindingIds: [args.findings[1].id],
      errorMessage: null,
      createdAt: "2026-04-06T10:00:00.000Z",
      updatedAt: "2026-04-06T10:00:02.000Z",
      completedAt: "2026-04-06T10:00:02.000Z",
    }));

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
          branchRef: "feature/pr-80",
          worktreePath: "/tmp/ade/lane",
          laneType: "worktree",
        }),
        list: vi.fn(async () => []),
      } as any,
      gitService: {
        listRecentCommits: vi.fn(async () => []),
      } as any,
      agentChatService: {
        createSession: vi.fn(async () => ({
          id: "session-pr-review",
          laneId: "lane-review",
          provider: "codex",
          model: "gpt-5.4-codex",
          modelId: "openai/gpt-5.4-codex",
        })),
        getSessionSummary: vi.fn(async () => null),
        runSessionTurn: vi.fn(async () => ({
          sessionId: "session-pr-review",
          provider: "codex",
          model: "gpt-5.4-codex",
          modelId: "openai/gpt-5.4-codex",
          outputText: JSON.stringify({
            summary: "Two findings on the PR.",
            findings: [
              {
                title: "Anchored finding",
                severity: "high",
                body: "This should post inline.",
                confidence: 0.92,
                filePath: "src/review.ts",
                line: 11,
              },
              {
                title: "Summary finding",
                severity: "medium",
                body: "This should stay in the summary body.",
                confidence: 0.64,
                filePath: "src/review.ts",
                line: 200,
              },
            ],
          }),
        })),
      } as any,
      sessionService: {
        updateMeta: vi.fn(),
      } as any,
      prService: {
        getReviewSnapshot: vi.fn(),
        publishReviewPublication,
      } as any,
    });

    const first = await service.startRun({
      target: { mode: "pr", laneId: "lane-review", prId: "pr-80" },
      config: { publishBehavior: "auto_publish" },
    });

    await waitFor(
      () => service.listRuns(),
      (runs) => runs.some((run) => run.id === first.id && run.status === "completed"),
    );

    const detail = await service.getRunDetail({ runId: first.id });
    expect(publishReviewPublication).toHaveBeenCalledWith(expect.objectContaining({
      runId: first.id,
      targetLabel: "PR #80 feature/pr-80 -> main",
    }));
    expect(detail?.publications).toHaveLength(1);
    expect(detail?.publications[0]?.status).toBe("published");
    expect(detail?.publications[0]?.summaryFindingIds).toHaveLength(1);
    expect(detail?.artifacts.some((artifact) => artifact.artifactType === "publication_request")).toBe(true);
    expect(detail?.artifacts.some((artifact) => artifact.artifactType === "publication_result")).toBe(true);
    expect(detail?.findings.every((finding) => finding.publicationState === "published")).toBe(true);

    const savedRuns = await service.listRuns();
    const savedPrRun = savedRuns.find((run) => run.id === first.id);
    expect(savedPrRun?.target).toEqual({ mode: "pr", laneId: "lane-review", prId: "pr-80" });
    expect(savedPrRun?.config.publishBehavior).toBe("auto_publish");

    const rerun = await service.rerun(first.id);
    await waitFor(
      () => service.listRuns(),
      (runs) => runs.some((run) => run.id === rerun.id && run.status === "completed"),
    );

    expect(publishReviewPublication).toHaveBeenCalledTimes(2);
    const rerunDetail = await service.getRunDetail({ runId: rerun.id });
    expect(rerunDetail?.publications).toHaveLength(1);
  });
});
