import { describe, expect, it, vi } from "vitest";

import {
  reactionGroupsByNodeId,
  resolveReactableSubjectId,
  toPrReactions,
  type GithubCommentApi,
} from "./prCommentMutations";

const REPO = { owner: "test-owner", name: "test-repo" };

describe("toPrReactions", () => {
  it("keeps REST count rollups as unknown users", () => {
    expect(toPrReactions({ "+1": 3, heart: 1, laugh: 0, total_count: 4 }, "octocat")).toEqual([
      { id: "rest:+1", content: "+1", user: "unknown", count: 3 },
      { id: "rest:heart", content: "heart", user: "unknown", count: 1 },
    ]);
  });

  it("marks reactionGroups as the write viewer when viewerHasReacted", () => {
    expect(toPrReactions([
      { content: "THUMBS_UP", viewerHasReacted: true, reactors: { totalCount: 2 } },
      { content: "HEART", viewerHasReacted: false, reactors: { totalCount: 1 } },
    ], "octocat")).toEqual([
      { id: "group:+1", content: "+1", user: "octocat", count: 2 },
      { id: "group:heart", content: "heart", user: "unknown", count: 1 },
    ]);
  });

  it("keeps GraphQL reaction node logins", () => {
    expect(toPrReactions({
      nodes: [{ id: "r1", content: "THUMBS_UP", user: { login: "octocat" } }],
    })).toEqual([
      { id: "r1", content: "+1", user: "octocat" },
    ]);
  });
});

describe("reactionGroupsByNodeId", () => {
  it("skips nodes that are not Reactable", () => {
    const mapped = reactionGroupsByNodeId({
      nodes: [
        { id: "PR_1" },
        {
          id: "IC_1",
          reactionGroups: [
            { content: "THUMBS_UP", viewerHasReacted: true, reactors: { totalCount: 1 } },
          ],
        },
      ],
    }, "octocat");
    expect(mapped.has("PR_1")).toBe(false);
    expect(mapped.get("IC_1")).toEqual([
      { id: "group:+1", content: "+1", user: "octocat", count: 1 },
    ]);
  });
});

describe("resolveReactableSubjectId", () => {
  it("passes GraphQL node ids through", async () => {
    const githubService = { apiRequest: vi.fn() } as GithubCommentApi;
    await expect(resolveReactableSubjectId({
      githubService,
      repo: REPO,
      prNumber: 90,
      commentId: "IC_kwDO123",
    })).resolves.toBe("IC_kwDO123");
    expect(githubService.apiRequest).not.toHaveBeenCalled();
  });

  it("resolves a REST issue-comment id that belongs to the PR", async () => {
    const githubService = {
      apiRequest: vi.fn(async () => ({
        data: {
          id: 555,
          node_id: "IC_kwDO123",
          issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/90",
        },
      })),
    } as GithubCommentApi;
    await expect(resolveReactableSubjectId({
      githubService,
      repo: REPO,
      prNumber: 90,
      commentId: "555",
    })).resolves.toBe("IC_kwDO123");
    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      path: "/repos/test-owner/test-repo/issues/comments/555",
    }));
  });

  it("falls through to review comments when the issue comment is on another PR", async () => {
    const githubService = {
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path.endsWith("/issues/comments/555")) {
          return {
            data: {
              id: 555,
              node_id: "IC_other",
              issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/91",
            },
          };
        }
        return {
          data: {
            id: 555,
            node_id: "PRRC_kwDO123",
            pull_request_url: "https://api.github.com/repos/test-owner/test-repo/pulls/90",
          },
        };
      }),
    } as GithubCommentApi;
    await expect(resolveReactableSubjectId({
      githubService,
      repo: REPO,
      prNumber: 90,
      commentId: "555",
    })).resolves.toBe("PRRC_kwDO123");
  });

  it("rejects a numeric id that is not on the target PR", async () => {
    const githubService = {
      apiRequest: vi.fn(async () => {
        throw new Error("Not Found");
      }),
    } as GithubCommentApi;
    await expect(resolveReactableSubjectId({
      githubService,
      repo: REPO,
      prNumber: 90,
      commentId: "555",
    })).rejects.toThrow("Comment does not belong to the target PR.");
  });

  it("rethrows auth failures instead of treating them as a missing comment", async () => {
    const githubService = {
      apiRequest: vi.fn(async () => {
        throw new Error("Bad credentials");
      }),
    } as GithubCommentApi;
    await expect(resolveReactableSubjectId({
      githubService,
      repo: REPO,
      prNumber: 90,
      commentId: "555",
    })).rejects.toThrow("Bad credentials");
  });
});
