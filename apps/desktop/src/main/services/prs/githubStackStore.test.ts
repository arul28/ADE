import { describe, expect, it, vi } from "vitest";
import type { AdeDb } from "../state/kvDb";
import type { GithubService } from "../github/githubService";
import { createGithubStackStore } from "./githubStackStore";

const projectId = "proj-1";
const repo = { owner: "ade", name: "desktop" };

function stackRow() {
  return {
    project_id: projectId,
    repo_owner: "ade",
    repo_name: "desktop",
    github_stack_number: 4,
    github_stack_id: "stack-4",
    github_node_id: "S_4",
    base_branch: "main",
    is_open: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    synced_at: "2026-01-01T00:00:00.000Z",
    last_error: null,
  };
}

function entryRow() {
  return {
    project_id: projectId,
    repo_owner: "ade",
    repo_name: "desktop",
    github_stack_number: 4,
    github_pr_number: 7,
    position: 1,
    state: "open",
    is_draft: 0,
    merged_at: null,
    head_branch: "feat/layer",
    head_sha: "abc123",
  };
}

function githubStackPayload() {
  return {
    id: "stack-4",
    number: 4,
    node_id: "S_4",
    open: true,
    created_at: "2026-01-01T00:00:00.000Z",
    base: { ref: "main" },
    pull_requests: [{
      number: 7,
      state: "closed",
      draft: false,
      merged_at: "2026-01-01T00:01:00.000Z",
      head: { ref: "feat/layer", sha: "abc123" },
    }],
  };
}

function createStore(apiRequest: GithubService["apiRequest"]) {
  const stacks = [stackRow()];
  const entries = [entryRow()];
  const db = {
    all: (sql: string) => {
      if (sql.includes("from github_pr_stack_entries")) return entries;
      if (sql.includes("from github_pr_stacks")) return stacks;
      return [];
    },
    get: () => null,
    run: vi.fn(),
  } as unknown as AdeDb;
  return createGithubStackStore({
    db,
    projectId,
    githubService: { apiRequest } as unknown as GithubService,
    logger: { warn: vi.fn() },
    onSnapshotChanged: vi.fn(),
    onReconciled: vi.fn(),
  });
}

describe("githubStackStore.merge", () => {
  it("falls back to merge-async when the stack API returns 403", async () => {
    const apiRequest = vi.fn(async (args: { method: string; path: string }) => {
      if (args.method === "POST" && args.path.endsWith("/stacks/4/merge")) {
        throw new Error("Resource not accessible by integration");
      }
      if (args.method === "PUT" && args.path.endsWith("/pulls/7/merge-async")) {
        return { data: {}, response: { status: 202 } };
      }
      if (args.method === "GET" && args.path.endsWith("/pulls/7")) {
        return {
          data: { merged: true, merged_at: "2026-01-01T00:01:00.000Z", merge_commit_sha: "def456" },
          response: { status: 200 },
        };
      }
      if (args.method === "GET" && args.path.endsWith("/stacks/4")) {
        return { data: githubStackPayload(), response: { status: 200 } };
      }
      throw new Error(`unexpected ${args.method} ${args.path}`);
    });
    const store = createStore(apiRequest as GithubService["apiRequest"]);
    const result = await store.merge(repo, 4);
    expect(result.ok).toBe(true);
    expect(result.method).toBe("merge_async");
    expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      path: "/repos/ade/desktop/pulls/7/merge-async",
    }));
  });

  it("does not fall back when the stack API reports a merge conflict", async () => {
    const apiRequest = vi.fn(async (args: { method: string; path: string }) => {
      if (args.method === "POST" && args.path.endsWith("/stacks/4/merge")) {
        throw new Error("GitHub API request failed (HTTP 409)");
      }
      throw new Error(`unexpected ${args.method} ${args.path}`);
    });
    const store = createStore(apiRequest as GithubService["apiRequest"]);
    const result = await store.merge(repo, 4);
    expect(result).toMatchObject({
      ok: false,
      method: "stack_api",
      error: "GitHub API request failed (HTTP 409)",
    });
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("queues a second merge until the first stack mutation finishes", async () => {
    let releasePoll: (() => void) | undefined;
    const firstPollHeld = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    let firstPostSeen!: () => void;
    const firstPosted = new Promise<void>((resolve) => {
      firstPostSeen = resolve;
    });
    let mergePosts = 0;
    const apiRequest = vi.fn(async (args: { method: string; path: string }) => {
      if (args.method === "POST" && args.path.endsWith("/stacks/4/merge")) {
        mergePosts += 1;
        if (mergePosts === 1) firstPostSeen();
        return { data: {}, response: { status: 202 } };
      }
      if (args.method === "GET" && args.path.endsWith("/pulls/7")) {
        if (mergePosts === 1) await firstPollHeld;
        return {
          data: { merged: true, merged_at: "2026-01-01T00:01:00.000Z", merge_commit_sha: "def456" },
          response: { status: 200 },
        };
      }
      if (args.method === "GET" && args.path.endsWith("/stacks/4")) {
        return { data: githubStackPayload(), response: { status: 200 } };
      }
      throw new Error(`unexpected ${args.method} ${args.path}`);
    });
    const store = createStore(apiRequest as GithubService["apiRequest"]);
    const first = store.merge(repo, 4);
    await firstPosted;
    const second = store.merge(repo, 4);
    await Promise.resolve();
    expect(mergePosts).toBe(1);
    releasePoll?.();
    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(mergePosts).toBe(2);
  });
});

describe("githubStackStore.rebase", () => {
  it("marks rebase unavailable when update-branch rejects stacked PRs", async () => {
    const apiRequest = vi.fn(async (args: { method: string; path: string }) => {
      if (args.method === "POST" && args.path.endsWith("/stacks/4/rebase")) {
        throw new Error("Not Found");
      }
      if (args.method === "PUT" && args.path.endsWith("/pulls/7/update-branch")) {
        throw new Error("Updating a stacked PR's branch via this endpoint is not supported.");
      }
      throw new Error(`unexpected ${args.method} ${args.path}`);
    });
    const store = createStore(apiRequest as GithubService["apiRequest"]);
    const result = await store.rebase(repo, 4);
    expect(result).toMatchObject({
      ok: false,
      method: "unavailable",
    });
    expect(result.disabledReason).toMatch(/does not expose stack rebase/i);
  });
});
