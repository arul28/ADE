import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { buildPrSummaryPrompt, createPrSummaryService, parsePrSummaryJson } from "./prSummaryService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

async function seed(db: any, prId: string, headSha: string | null) {
  const now = "2026-04-14T00:00:00.000Z";
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    ["proj", "/tmp", "ADE", "main", now, now],
  );
  db.run(
    `
      insert into pull_requests(
        id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
        title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
        last_synced_at, created_at, updated_at, head_sha
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      prId,
      "proj",
      "lane-1",
      "arul28",
      "ADE",
      1,
      "https://github.com/arul28/ADE/pull/1",
      null,
      "Test",
      "open",
      "main",
      "feat",
      "passing",
      "approved",
      0,
      0,
      now,
      now,
      now,
      headSha,
    ],
  );
}

describe("buildPrSummaryPrompt", () => {
  it("includes title, body, file list, unresolved count, and bot summaries", () => {
    const prompt = buildPrSummaryPrompt({
      title: "Add feature",
      body: "Body content",
      changedFiles: [
        { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: null, previousFilename: null },
        { filename: "b.ts", status: "added", additions: 10, deletions: 0, patch: null, previousFilename: null },
      ],
      issueComments: [
        {
          id: "c1",
          author: "greptile-bot",
          authorAvatarUrl: null,
          body: "Looks risky",
          source: "issue",
          url: null,
          path: null,
          line: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      unresolvedThreadCount: 3,
    });
    expect(prompt).toContain("Add feature");
    expect(prompt).toContain("Body content");
    expect(prompt).toContain("modified a.ts");
    expect(prompt).toContain("added b.ts");
    expect(prompt).toContain("Unresolved review threads: 3");
    expect(prompt).toContain("@greptile-bot");
  });
});

describe("parsePrSummaryJson", () => {
  it("returns fields when valid JSON provided", () => {
    const result = parsePrSummaryJson(
      '```json\n{"summary":"x","riskAreas":["a"],"reviewerHotspots":["b"],"unresolvedConcerns":[]}\n```',
    );
    expect(result).toEqual({
      summary: "x",
      riskAreas: ["a"],
      reviewerHotspots: ["b"],
      unresolvedConcerns: [],
    });
  });

  it("filters non-string array entries", () => {
    const result = parsePrSummaryJson(
      '{"summary":"s","riskAreas":["ok", 5, null],"reviewerHotspots":[],"unresolvedConcerns":[]}',
    );
    expect(result?.riskAreas).toEqual(["ok"]);
  });

  it("returns null on missing JSON", () => {
    expect(parsePrSummaryJson("no json here")).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(parsePrSummaryJson("{ not json }")).toBeNull();
  });
});

describe("createPrSummaryService", () => {
  it("returns null from getSummary when no cache entry exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-sum-get-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      await seed(db, "pr-1", "headA");
      const svc = createPrSummaryService({
        db,
        logger: createLogger() as any,
        projectRoot: root,
        prService: {} as any,
      });
      await expect(svc.getSummary("pr-1")).resolves.toBeNull();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("regenerateSummary caches the result keyed by (prId, headSha) and parses JSON", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-sum-regen-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      await seed(db, "pr-1", "headA");

      const prService = {
        listAll: () => [
          {
            id: "pr-1",
            laneId: "lane-1",
            projectId: "proj",
            repoOwner: "arul28",
            repoName: "ADE",
            githubPrNumber: 1,
            githubUrl: "",
            githubNodeId: null,
            title: "PR title",
            state: "open",
            baseBranch: "main",
            headBranch: "feat",
            checksStatus: "passing",
            reviewStatus: "approved",
            additions: 0,
            deletions: 0,
            lastSyncedAt: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
        getDetail: vi.fn(async () => ({
          prId: "pr-1",
          body: "Detail body",
          labels: [],
          assignees: [],
          requestedReviewers: [],
          author: { login: "arul", avatarUrl: null },
          isDraft: false,
          milestone: null,
          linkedIssues: [],
        })),
        getFiles: vi.fn(async () => [
          { filename: "x.ts", status: "modified", additions: 1, deletions: 0, patch: null, previousFilename: null },
        ]),
        getComments: vi.fn(async () => []),
        getReviewThreads: vi.fn(async () => [
          {
            id: "t1",
            isResolved: false,
            isOutdated: false,
            path: "x.ts",
            line: 1,
            originalLine: 1,
            startLine: 0,
            originalStartLine: 0,
            diffSide: "RIGHT",
            url: null,
            createdAt: null,
            updatedAt: null,
            comments: [],
          },
        ]),
      };

      const aiIntegrationService = {
        draftPrDescription: vi.fn(async () => ({
          text: '{"summary":"ok","riskAreas":["a"],"reviewerHotspots":["b"],"unresolvedConcerns":["c"]}',
          durationMs: 10,
          executedAt: "x",
          model: "m",
          provider: "openai" as const,
          reasoningEffort: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          budgetState: null,
          taskType: "pr_description" as const,
          feature: "pr_descriptions" as const,
        })),
      };

      const svc = createPrSummaryService({
        db,
        logger: createLogger() as any,
        projectRoot: root,
        prService: prService as any,
        aiIntegrationService: aiIntegrationService as any,
      });

      const result = await svc.regenerateSummary("pr-1");
      expect(result.summary).toBe("ok");
      expect(result.riskAreas).toEqual(["a"]);
      expect(result.headSha).toBe("headA");
      expect(aiIntegrationService.draftPrDescription).toHaveBeenCalledTimes(1);

      const cached = await svc.getSummary("pr-1");
      expect(cached?.summary).toBe("ok");
      expect(cached?.headSha).toBe("headA");

      // regenerateSummary bypasses cache and always calls AI
      const again = await svc.regenerateSummary("pr-1");
      expect(again.summary).toBe("ok");
      expect(aiIntegrationService.draftPrDescription).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back gracefully when aiIntegrationService is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-sum-fallback-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      await seed(db, "pr-1", "headA");
      const prService = {
        listAll: () => [{ id: "pr-1", title: "t" } as any],
        getDetail: async () => null,
        getFiles: async () => [],
        getComments: async () => [],
        getReviewThreads: async () => [],
      };
      const svc = createPrSummaryService({
        db,
        logger: createLogger() as any,
        projectRoot: root,
        prService: prService as any,
      });
      const result = await svc.regenerateSummary("pr-1");
      expect(result.summary).toMatch(/0 file/);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
