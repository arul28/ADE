import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createReviewContextBuilder } from "./reviewContextBuilder";

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
    create table lanes(
      id text primary key,
      project_id text not null,
      mission_id text
    );
  `);
  raw.run(`
    create table missions(
      id text primary key,
      project_id text not null,
      title text,
      prompt text,
      status text,
      outcome_summary text,
      updated_at text
    );
  `);
  raw.run(`
    create table orchestrator_worker_digests(
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      step_id text not null,
      attempt_id text not null,
      lane_id text,
      session_id text,
      step_key text,
      status text not null,
      summary text not null,
      files_changed_json text,
      tests_run_json text,
      warnings_json text,
      tokens_json text,
      cost_usd real,
      suggested_next_actions_json text,
      created_at text not null
    );
  `);
  raw.run(`
    create table pull_requests(
      id text primary key,
      project_id text not null,
      lane_id text not null,
      repo_owner text not null,
      repo_name text not null,
      github_pr_number integer not null,
      github_url text not null,
      title text,
      state text not null,
      updated_at text not null
    );
  `);
  raw.run(`
    create table review_runs(
      id text primary key,
      project_id text not null,
      lane_id text not null,
      summary text,
      status text not null,
      finding_count integer not null default 0,
      created_at text not null
    );
  `);
  raw.run(`
    create table review_findings(
      id text primary key,
      run_id text not null,
      file_path text
    );
  `);
  raw.run(`
    create table review_run_publications(
      id text primary key,
      run_id text not null
    );
  `);

  const run = (sql: string, params: SqlValue[] = []) => raw.run(sql, params);
  const all = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] =>
    mapExecRows(raw.exec(sql, params)) as T[];
  const get = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | null =>
    all<T>(sql, params)[0] ?? null;
  return { raw, db: { run, all, get } };
}

function makeRun() {
  return {
    id: "run-current",
    projectId: "project-1",
    laneId: "lane-review",
    target: { mode: "lane_diff", laneId: "lane-review" },
    config: {
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
    },
    targetLabel: "lane-review vs main",
    compareTarget: null,
    status: "running",
    summary: null,
    errorMessage: null,
    findingCount: 0,
    severitySummary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    chatSessionId: null,
    createdAt: "2026-04-06T10:00:00.000Z",
    startedAt: "2026-04-06T10:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-04-06T10:00:00.000Z",
  } as const;
}

function makeMaterialized(changedPaths: string[]) {
  return {
    targetLabel: "lane-review vs main",
    compareTarget: null,
    publicationTarget: null,
    fullPatchText: "diff --git a/file b/file",
    changedFiles: changedPaths.map((filePath) => ({
      filePath,
      excerpt: `@@ -1 +1 @@\n+${filePath}`,
      lineNumbers: [1],
      diffPositionsByLine: { 1: 1 },
    })),
    artifacts: [],
  };
}

describe("reviewContextBuilder", () => {
  it("builds a bounded compact packet from ADE-native provenance, rules, and validation signals", async () => {
    const { db } = createInMemoryAdeDb();
    db.run("insert into lanes(id, project_id, mission_id) values (?, ?, ?)", ["lane-review", "project-1", "mission-1"]);
    db.run(
      "insert into missions(id, project_id, title, prompt, status, outcome_summary, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      [
        "mission-1",
        "project-1",
        "Keep preload and renderer aligned",
        "This is a very long mission prompt that should be clipped in the compact provenance packet because raw prompt bloat is not review-safe and should never be copied wholesale into prompts or artifacts.",
        "running",
        "Workers are still converging on the bridge rollout.",
        "2026-04-06T09:59:00.000Z",
      ],
    );
    for (let index = 0; index < 4; index += 1) {
      db.run(
        `
          insert into orchestrator_worker_digests(
            id, project_id, mission_id, run_id, step_id, attempt_id, lane_id, session_id, step_key, status,
            summary, files_changed_json, tests_run_json, warnings_json, tokens_json, cost_usd, suggested_next_actions_json, created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          `digest-${index}`,
          "project-1",
          "mission-1",
          "orchestrator-run-1",
          `step-${index}`,
          `attempt-${index}`,
          "lane-review",
          `session-${index}`,
          `step-${index}`,
          index === 0 ? "failed" : "succeeded",
          `Worker digest ${index} repeated text ${"x".repeat(80)}`,
          JSON.stringify(["apps/desktop/src/preload/reviewBridge.ts"]),
          JSON.stringify({ passed: 0, failed: 1, skipped: 0, summary: "bridge unit failed" }),
          JSON.stringify(["warning one", "warning two"]),
          null,
          null,
          JSON.stringify(["fix the bridge"]),
          `2026-04-06T10:0${index}:00.000Z`,
        ],
      );
    }
    db.run(
      `
        insert into pull_requests(
          id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, title, state, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "pr-1",
        "project-1",
        "lane-review",
        "ade-dev",
        "ade",
        26,
        "https://github.com/ade-dev/ade/pull/26",
        "Bridge rollout",
        "open",
        "2026-04-06T10:05:00.000Z",
      ],
    );
    db.run(
      "insert into review_runs(id, project_id, lane_id, summary, status, finding_count, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      ["run-prior", "project-1", "lane-review", "Prior ADE review on the same bridge path", "completed", 1, "2026-04-05T15:00:00.000Z"],
    );
    db.run("insert into review_findings(id, run_id, file_path) values (?, ?, ?)", [
      "finding-prior",
      "run-prior",
      "apps/desktop/src/preload/reviewBridge.ts",
    ]);
    db.run("insert into review_run_publications(id, run_id) values (?, ?)", ["publication-prior", "run-prior"]);

    const builder = createReviewContextBuilder({
      db: db as any,
      projectId: "project-1",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any,
      laneService: {
        getStateSnapshot: vi.fn().mockReturnValue({
          laneId: "lane-review",
          agentSummary: { summary: "Recent ADE chat distilled the bridge rollout intent." },
          missionSummary: { summary: "Finish the preload bridge rollout cleanly." },
          updatedAt: "2026-04-06T09:58:00.000Z",
        }),
      } as any,
      sessionDeltaService: {
        listRecentLaneSessionDeltas: vi.fn().mockReturnValue([
          {
            sessionId: "delta-1",
            laneId: "lane-review",
            startedAt: "2026-04-06T09:40:00.000Z",
            endedAt: "2026-04-06T09:50:00.000Z",
            headShaStart: null,
            headShaEnd: null,
            filesChanged: 1,
            insertions: 10,
            deletions: 2,
            touchedFiles: ["apps/desktop/src/preload/reviewBridge.ts"],
            failureLines: ["AssertionError: bridge mismatch", "Traceback: renderer bridge failed"],
            computedAt: "2026-04-06T09:50:10.000Z",
          },
          {
            sessionId: "delta-2",
            laneId: "lane-review",
            startedAt: "2026-04-06T09:20:00.000Z",
            endedAt: "2026-04-06T09:25:00.000Z",
            headShaStart: null,
            headShaEnd: null,
            filesChanged: 2,
            insertions: 5,
            deletions: 1,
            touchedFiles: ["apps/desktop/src/shared/ipc.ts"],
            failureLines: ["Error: shared IPC shape drifted"],
            computedAt: "2026-04-06T09:25:10.000Z",
          },
          {
            sessionId: "delta-3",
            laneId: "lane-review",
            startedAt: "2026-04-06T09:00:00.000Z",
            endedAt: "2026-04-06T09:05:00.000Z",
            headShaStart: null,
            headShaEnd: null,
            filesChanged: 1,
            insertions: 3,
            deletions: 0,
            touchedFiles: ["apps/desktop/src/renderer/review/ReviewPanel.tsx"],
            failureLines: ["Error: renderer still expects old bridge"],
            computedAt: "2026-04-06T09:05:10.000Z",
          },
          {
            sessionId: "delta-4",
            laneId: "lane-review",
            startedAt: "2026-04-06T08:00:00.000Z",
            endedAt: "2026-04-06T08:05:00.000Z",
            headShaStart: null,
            headShaEnd: null,
            filesChanged: 1,
            insertions: 1,
            deletions: 1,
            touchedFiles: ["unrelated.ts"],
            failureLines: ["Error: unrelated"],
            computedAt: "2026-04-06T08:05:10.000Z",
          },
        ]),
      } as any,
      testService: {
        listSuites: vi.fn().mockReturnValue([{ id: "unit" }, { id: "lint" }, { id: "e2e" }]),
        listRuns: vi.fn().mockReturnValue([
          {
            id: "test-run-1",
            suiteId: "unit",
            suiteName: "Unit",
            laneId: "lane-review",
            status: "failed",
            exitCode: 1,
            durationMs: 1200,
            startedAt: "2026-04-06T10:00:00.000Z",
            endedAt: "2026-04-06T10:02:00.000Z",
            logPath: "/tmp/test-run-1.log",
          },
        ]),
        getLogTail: vi.fn().mockReturnValue(
          `${"noise ".repeat(200)}\nAssertionError: bridge mismatch repeated ${"y".repeat(200)}\n`,
        ),
      } as any,
      issueInventoryService: {
        getInventory: vi.fn().mockReturnValue({
          prId: "pr-1",
          items: Array.from({ length: 6 }, (_, index) => ({
            id: `inventory-${index}`,
            prId: "pr-1",
            source: "human",
            type: "review_thread",
            externalId: `thread-${index}`,
            state: "new",
            round: 1,
            filePath: index === 0 ? "apps/desktop/src/preload/reviewBridge.ts" : "apps/desktop/src/renderer/review/ReviewPanel.tsx",
            line: 20 + index,
            severity: "major",
            headline: `Review feedback ${index}`,
            body: `Feedback body ${index}`,
            author: "reviewer",
            url: null,
            dismissReason: null,
            agentSessionId: null,
            createdAt: "2026-04-06T10:01:00.000Z",
            updatedAt: `2026-04-06T10:0${index}:00.000Z`,
          })),
          convergence: { currentRound: 1 },
          runtime: { currentRound: 1 },
        }),
      } as any,
      prService: {
        getChecks: vi.fn().mockResolvedValue([
          {
            name: "unit-tests",
            status: "completed",
            conclusion: "failure",
            detailsUrl: "https://ci.example/unit-tests",
            startedAt: "2026-04-06T10:00:00.000Z",
            completedAt: "2026-04-06T10:03:00.000Z",
          },
          {
            name: "lint",
            status: "completed",
            conclusion: "success",
            detailsUrl: null,
            startedAt: "2026-04-06T10:04:00.000Z",
            completedAt: "2026-04-06T10:05:00.000Z",
          },
        ]),
        getReviewSnapshot: vi.fn().mockResolvedValue({
          id: "pr-1",
          repoOwner: "ade-dev",
          repoName: "ade",
          githubPrNumber: 26,
          githubUrl: "https://github.com/ade-dev/ade/pull/26",
          baseBranch: "main",
          headBranch: "feature/bridge",
          baseSha: "abc123",
          headSha: "def456",
          files: [{ filename: "apps/desktop/src/preload/reviewBridge.ts" }],
        }),
      } as any,
    });

    const packet = await builder.buildContext({
      run: makeRun() as any,
      materialized: makeMaterialized([
        "apps/desktop/src/preload/reviewBridge.ts",
        "apps/desktop/src/shared/ipc.ts",
      ]) as any,
    });

    expect(packet.provenance.payload.workerDigests).toHaveLength(3);
    expect(packet.provenance.payload.sessionDeltas).toHaveLength(3);
    expect(packet.validation.payload.issueInventory).toHaveLength(5);
    expect(packet.validation.payload.signals.length).toBeLessThanOrEqual(5);
    expect(packet.provenance.payload.missions[0]?.intentSummary?.length ?? 0).toBeLessThanOrEqual(220);
    expect(packet.validation.payload.testRuns[0]?.logExcerpt?.length ?? 0).toBeLessThanOrEqual(220);
    expect(packet.validation.prompt).not.toContain("noise noise noise noise noise noise");
    expect(packet.rules.metadata.matchedRuleIds).toContain("preload-bridge");
    expect(packet.rules.metadata.matchedRuleIds).toContain("shared-contract");
  });

  it("emits late-stage signals for validation failures, reviewer feedback, and prior review overlap", async () => {
    const { db } = createInMemoryAdeDb();
    db.run("insert into lanes(id, project_id, mission_id) values (?, ?, ?)", ["lane-review", "project-1", null]);
    db.run(
      `
        insert into pull_requests(
          id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, title, state, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["pr-1", "project-1", "lane-review", "ade-dev", "ade", 26, "https://github.com/ade-dev/ade/pull/26", "Bridge rollout", "open", "2026-04-06T10:05:00.000Z"],
    );
    db.run(
      "insert into review_runs(id, project_id, lane_id, summary, status, finding_count, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      ["run-prior", "project-1", "lane-review", "Prior review flagged the bridge", "completed", 1, "2026-04-05T15:00:00.000Z"],
    );
    db.run("insert into review_findings(id, run_id, file_path) values (?, ?, ?)", [
      "finding-prior",
      "run-prior",
      "apps/desktop/src/preload/reviewBridge.ts",
    ]);

    const builder = createReviewContextBuilder({
      db: db as any,
      projectId: "project-1",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      laneService: {
        getStateSnapshot: vi.fn().mockReturnValue(null),
      } as any,
      sessionDeltaService: {
        listRecentLaneSessionDeltas: vi.fn().mockReturnValue([
          {
            sessionId: "delta-1",
            laneId: "lane-review",
            startedAt: "2026-04-06T09:40:00.000Z",
            endedAt: "2026-04-06T09:50:00.000Z",
            headShaStart: null,
            headShaEnd: null,
            filesChanged: 1,
            insertions: 1,
            deletions: 0,
            touchedFiles: ["apps/desktop/src/preload/reviewBridge.ts"],
            failureLines: ["AssertionError: bridge mismatch"],
            computedAt: "2026-04-06T09:50:10.000Z",
          },
        ]),
      } as any,
      testService: {
        listSuites: vi.fn().mockReturnValue([]),
        listRuns: vi.fn().mockReturnValue([]),
        getLogTail: vi.fn().mockReturnValue(""),
      } as any,
      issueInventoryService: {
        getInventory: vi.fn().mockReturnValue({
          prId: "pr-1",
          items: [
            {
              id: "inventory-1",
              prId: "pr-1",
              source: "human",
              type: "review_thread",
              externalId: "thread-1",
              state: "new",
              round: 1,
              filePath: "apps/desktop/src/preload/reviewBridge.ts",
              line: 10,
              severity: "major",
              headline: "Reviewer says the preload bridge still drifts",
              body: null,
              author: "reviewer",
              url: null,
              dismissReason: null,
              agentSessionId: null,
              createdAt: "2026-04-06T10:01:00.000Z",
              updatedAt: "2026-04-06T10:02:00.000Z",
            },
          ],
          convergence: { currentRound: 1 },
          runtime: { currentRound: 1 },
        }),
      } as any,
      prService: {
        getChecks: vi.fn().mockResolvedValue([]),
        getReviewSnapshot: vi.fn().mockResolvedValue({
          id: "pr-1",
          repoOwner: "ade-dev",
          repoName: "ade",
          githubPrNumber: 26,
          githubUrl: "https://github.com/ade-dev/ade/pull/26",
          baseBranch: "main",
          headBranch: "feature/bridge",
          baseSha: "abc123",
          headSha: "def456",
          files: [{ filename: "apps/desktop/src/preload/reviewBridge.ts" }],
        }),
      } as any,
    });

    const packet = await builder.buildContext({
      run: makeRun() as any,
      materialized: makeMaterialized(["apps/desktop/src/preload/reviewBridge.ts"]) as any,
    });

    const kinds = packet.provenance.payload.lateStageSignals.map((signal) => signal.kind);
    expect(kinds).toContain("validation_failure_followed_by_edits");
    expect(kinds).toContain("review_feedback_followed_by_edits");
    expect(kinds).toContain("prior_review_overlap");
  });
});
