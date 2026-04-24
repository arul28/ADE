import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPrService } from "./prService";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function makeMockDb() {
  return {
    get: vi.fn((sql: string) => {
      if (!sql.includes("from pull_requests")) return null;
      return {
        id: "pr-80",
        lane_id: "lane-1",
        project_id: "proj-1",
        repo_owner: "test-owner",
        repo_name: "test-repo",
        github_pr_number: 80,
        github_url: "https://github.com/test-owner/test-repo/pull/80",
        github_node_id: "PR_kwDOExample",
        title: "Review publication",
        state: "open",
        base_branch: "main",
        head_branch: "feature/pr-80",
        checks_status: "passing",
        review_status: "commented",
        additions: 2,
        deletions: 0,
        last_synced_at: "2026-04-06T10:00:00.000Z",
        created_at: "2026-04-06T09:55:00.000Z",
        updated_at: "2026-04-06T10:00:00.000Z",
      };
    }),
    all: vi.fn(() => []),
    run: vi.fn(),
  } as any;
}

function makeLaneService() {
  return {
    list: vi.fn(async () => []),
    getLaneBaseAndBranch: vi.fn(),
  } as any;
}

describe("prService.publishReviewPublication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts anchored findings inline and routes unanchored findings into the review summary", async () => {
    const apiRequest = vi.fn(async ({ method, path, body }: { method: string; path: string; body?: Record<string, unknown> }) => {
      if (method === "GET" && path === "/repos/test-owner/test-repo/pulls/80") {
        return {
          data: {
            number: 80,
            html_url: "https://github.com/test-owner/test-repo/pull/80",
            node_id: "PR_kwDOExample",
            title: "Review publication",
            state: "open",
            draft: false,
            merged_at: null,
            head: { ref: "feature/pr-80", sha: "def456789012" },
            base: { ref: "main", sha: "abc123456789" },
            additions: 2,
            deletions: 0,
          },
        };
      }
      if (method === "GET" && path === "/repos/test-owner/test-repo/pulls/80/files") {
        return {
          data: [
            {
              filename: "src/review.ts",
              status: "modified",
              additions: 2,
              deletions: 0,
              patch: "@@ -10,1 +10,3 @@\n context\n+anchored\n+summary only\n",
              previous_filename: null,
            },
          ],
        };
      }
      if (method === "GET" && path === "/repos/test-owner/test-repo/commits/def456789012/status") {
        return { data: { state: "success", statuses: [] } };
      }
      if (method === "GET" && path === "/repos/test-owner/test-repo/commits/def456789012/check-runs") {
        return { data: { check_runs: [] } };
      }
      if (method === "GET" && path === "/repos/test-owner/test-repo/pulls/80/reviews") {
        return { data: [] };
      }
      if (method === "POST" && path === "/repos/test-owner/test-repo/pulls/80/reviews") {
        return {
          data: {
            id: 123,
            html_url: "https://github.com/test-owner/test-repo/pull/80#pullrequestreview-123",
          },
        };
      }
      throw new Error(`Unexpected request: ${method} ${path} ${JSON.stringify(body ?? {})}`);
    });

    const service = createPrService({
      db: makeMockDb(),
      logger: makeLogger(),
      projectId: "proj-1",
      projectRoot: "/tmp/test-project",
      laneService: makeLaneService(),
      operationService: {} as any,
      githubService: {
        apiRequest,
        getRepoOrThrow: vi.fn(),
        getStatus: vi.fn(),
        setToken: vi.fn(),
        clearToken: vi.fn(),
        getTokenOrThrow: vi.fn(() => "ghp_mock"),
      } as any,
      projectConfigService: { get: vi.fn(() => ({ effective: { ai: {} } })) } as any,
      openExternal: vi.fn(async () => undefined),
    });

    const publication = await service.publishReviewPublication({
      runId: "run-1",
      destination: {
        kind: "github_pr_review",
        prId: "pr-80",
        repoOwner: "test-owner",
        repoName: "test-repo",
        prNumber: 80,
        githubUrl: "https://github.com/test-owner/test-repo/pull/80",
      },
      targetLabel: "PR #80 feature/pr-80 -> main",
      summary: "One finding can anchor, one cannot.",
      findings: [
        {
          id: "finding-inline",
          runId: "run-1",
          title: "Anchored finding",
          severity: "high",
          body: "This should post inline.",
          confidence: 0.9,
          evidence: [],
          filePath: "src/review.ts",
          line: 11,
          anchorState: "anchored",
          sourcePass: "adjudicated",
          publicationState: "local_only",
          originatingPasses: ["diff-risk", "cross-file-impact"],
          adjudication: {
            score: 8.2,
            candidateCount: 2,
            mergedFindingIds: ["raw-1", "raw-2"],
            rationale: "Merged overlapping findings from diff-risk and cross-file-impact.",
            publicationEligible: true,
          },
        },
        {
          id: "finding-summary",
          runId: "run-1",
          title: "Summary finding",
          severity: "medium",
          body: "This should stay in the top-level review body.",
          confidence: 0.6,
          evidence: [],
          filePath: "src/review.ts",
          line: 200,
          anchorState: "file_only",
          sourcePass: "adjudicated",
          publicationState: "local_only",
          originatingPasses: ["checks-and-tests"],
          adjudication: {
            score: 5.7,
            candidateCount: 1,
            mergedFindingIds: ["raw-3"],
            rationale: "Accepted because the finding carried concrete evidence and cleared the adjudication threshold.",
            publicationEligible: true,
          },
        },
      ],
      changedFiles: [
        {
          filePath: "src/review.ts",
          diffPositionsByLine: { 11: 2 },
        },
      ],
    });

    expect(publication.status).toBe("published");
    expect(publication.inlineComments).toEqual([
      expect.objectContaining({
        findingId: "finding-inline",
        path: "src/review.ts",
        line: 11,
        position: 2,
      }),
    ]);
    expect(publication.summaryFindingIds).toEqual(["finding-summary"]);

    const postCall = apiRequest.mock.calls.find(
      ([request]: [{ method: string; path: string }]) => request.method === "POST" && request.path.endsWith("/reviews"),
    )?.[0];
    expect(postCall?.body).toEqual(expect.objectContaining({
      event: "COMMENT",
      commit_id: "def456789012",
      comments: [
        expect.objectContaining({
          path: "src/review.ts",
          position: 2,
        }),
      ],
    }));
    expect(String(postCall?.body?.body ?? "")).toContain("Summary finding");
    expect(String(postCall?.body?.body ?? "")).toContain("Anchored inline comments posted: 1.");
  });
});
