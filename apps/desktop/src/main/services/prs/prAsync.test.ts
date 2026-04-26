import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { createPrPollingService } from "./prPollingService";
import { buildPrSummaryPrompt, createPrSummaryService, parsePrSummaryJson } from "./prSummaryService";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function createSummary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "proj-1",
    repoOwner: "acme",
    repoName: "ade",
    githubPrNumber: 101,
    githubUrl: "https://github.com/acme/ade/pull/101",
    githubNodeId: "node-101",
    title: "Initial title",
    state: "open",
    baseBranch: "main",
    headBranch: "feature/pr-1",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 3,
    deletions: 1,
    lastSyncedAt: "2026-03-24T00:00:00.000Z",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    ...overrides,
  };
}

async function seedSummaryDb(db: any, prId: string, headSha: string | null) {
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
      prId, "proj", "lane-1", "arul28", "ADE", 1,
      "https://github.com/arul28/ADE/pull/1", null, "Test", "open", "main", "feat",
      "passing", "approved", 0, 0, now, now, now, headSha,
    ],
  );
}

// ---------------------------------------------------------------------------
// prPollingService — hot refresh, backoff, notifications
// ---------------------------------------------------------------------------

describe("prPollingService", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refreshes only hot PRs and ignores updatedAt-only churn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary();
    let hotIds: string[] = [];
    const refreshCalls: Array<{ prId?: string; prIds?: string[] } | undefined> = [];
    const events: Array<{ type: string }> = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async (args?: { prId?: string; prIds?: string[] }) => {
        refreshCalls.push(args);
        summary = { ...summary, updatedAt: new Date(Date.now()).toISOString() };
        return [summary];
      }),
      getHotRefreshDelayMs: () => (hotIds.length ? 5_000 : null),
      getHotRefreshPrIds: () => hotIds,
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(refreshCalls).toEqual([undefined]);
    expect(events.filter((event) => event.type === "prs-updated")).toHaveLength(1);

    hotIds = ["pr-1"];
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshCalls[1]).toEqual({ prIds: ["pr-1"] });
    expect(events.filter((event) => event.type === "prs-updated")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshCalls[2]).toEqual({ prIds: ["pr-1"] });
    expect(events.filter((event) => event.type === "prs-updated")).toHaveLength(1);
  });

  it("keeps rate-limit backoff ahead of hot wakeups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const summary = createSummary();
    let hotIds: string[] = [];
    let calls = 0;

    const refresh = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("rate limited") as Error & { rateLimitResetAtMs?: number };
        error.rateLimitResetAtMs = Date.now() + 20_000;
        throw error;
      }
      return [summary];
    });

    const prService = {
      listAll: () => [summary],
      refresh,
      getHotRefreshDelayMs: () => (hotIds.length ? 5_000 : null),
      getHotRefreshPrIds: () => hotIds,
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: { github: { prPollingIntervalSeconds: 5 } } }) } as any,
      onEvent: () => {},
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    hotIds = ["pr-1"];
    service.poke();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith({ prIds: ["pr-1"] });
  });

  it("emits review_requested notification with generic messaging", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      title: "Add feature",
      headBranch: "feature/add",
      checksStatus: "passing",
      reviewStatus: "none",
    });
    let refreshCount = 0;
    const events: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, reviewStatus: "requested" as const, updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContainEqual(expect.objectContaining({
      type: "pr-notification",
      kind: "review_requested",
      title: "Review requested",
      message: "This pull request is waiting on an approving review.",
      prTitle: "Add feature",
      repoOwner: "acme",
      repoName: "ade",
      baseBranch: "main",
      headBranch: "feature/add",
    }));
  });

  it("emits changes_requested notification with generic messaging", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      title: "Refactor module",
      headBranch: "refactor/module",
      checksStatus: "passing",
      reviewStatus: "requested",
    });
    let refreshCount = 0;
    const events: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, reviewStatus: "changes_requested" as const, updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContainEqual(expect.objectContaining({
      type: "pr-notification",
      kind: "changes_requested",
      title: "Changes requested",
      message: "A reviewer requested changes before this pull request can merge.",
      prTitle: "Refactor module",
      repoOwner: "acme",
      repoName: "ade",
    }));
  });

  it("emits merge_ready notification when checks pass and review is approved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      title: "Ready PR",
      headBranch: "feature/ready",
      checksStatus: "pending",
      reviewStatus: "approved",
    });
    let refreshCount = 0;
    const events: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, checksStatus: "passing" as const, updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContainEqual(expect.objectContaining({
      type: "pr-notification",
      kind: "merge_ready",
      title: "Checks passing & approved",
      message: expect.stringContaining("Required checks are passing"),
      prTitle: "Ready PR",
      repoOwner: "acme",
      repoName: "ade",
      baseBranch: "main",
      headBranch: "feature/ready",
    }));
  });

  it("notification title no longer includes the PR number", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      githubPrNumber: 999,
      checksStatus: "passing",
      reviewStatus: "none",
    });
    let refreshCount = 0;
    const events: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, checksStatus: "failing" as const, updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    const notification = events.find((e) => e.type === "pr-notification" && e.kind === "checks_failing");
    expect(notification, "Expected a checks_failing notification to be emitted").toBeTruthy();
    expect(notification.title).not.toContain("#999");
    expect(notification.title).toBe("Checks failing");
  });

  it("includes onPullRequestsChanged hook with changed PRs details", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      checksStatus: "passing",
      reviewStatus: "approved",
    });
    let refreshCount = 0;
    const changedCalls: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, checksStatus: "failing" as const, updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: () => {},
      onPullRequestsChanged: (args) => { changedCalls.push(args); },
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(changedCalls).toHaveLength(0);

    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(changedCalls).toHaveLength(1);
    expect(changedCalls[0].changedPrs).toHaveLength(1);
    expect(changedCalls[0].changes[0]).toEqual(expect.objectContaining({
      previousChecksStatus: "passing",
    }));
    expect(changedCalls[0].changes[0].pr.checksStatus).toBe("failing");
  });

  it("emits informative PR notifications with PR metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      title: "Fix lanes tab",
      headBranch: "fix-lanes-tab",
      checksStatus: "passing",
      reviewStatus: "approved",
    });
    let refreshCount = 0;
    const events: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, checksStatus: "failing", updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContainEqual(expect.objectContaining({
      type: "pr-notification",
      kind: "checks_failing",
      title: "Checks failing",
      prTitle: "Fix lanes tab",
      repoOwner: "acme",
      repoName: "ade",
      baseBranch: "main",
      headBranch: "fix-lanes-tab",
      message: "One or more required CI checks failed on this pull request.",
    }));
  });
});

// ---------------------------------------------------------------------------
// prSummaryService — prompt building, JSON parsing, summary cache
// ---------------------------------------------------------------------------

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
      reviews: [
        {
          reviewer: "coderabbitai[bot]",
          reviewerAvatarUrl: null,
          state: "commented",
          body: "Formal bot review body",
          submittedAt: null,
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
      await seedSummaryDb(db, "pr-1", "headA");
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
      await seedSummaryDb(db, "pr-1", "headA");

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
        getReviews: vi.fn(async () => []),
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
      await seedSummaryDb(db, "pr-1", "headA");
      const prService = {
        listAll: () => [{ id: "pr-1", title: "t" } as any],
        getDetail: async () => null,
        getFiles: async () => [],
        getComments: async () => [],
        getReviewThreads: async () => [],
        getReviews: async () => [],
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
