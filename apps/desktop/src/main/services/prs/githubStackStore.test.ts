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

function entryRow(overrides: Partial<{
  github_pr_number: number;
  position: number;
  head_branch: string;
  head_sha: string;
}> = {}) {
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
    ...overrides,
  };
}

function githubStackPayload(prNumbers = [7], options?: { merged?: boolean }) {
  const merged = options?.merged !== false;
  return {
    id: "stack-4",
    number: 4,
    node_id: "S_4",
    open: !merged,
    created_at: "2026-01-01T00:00:00.000Z",
    base: { ref: "main" },
    pull_requests: prNumbers.map((number) => ({
      number,
      state: merged ? "closed" : "open",
      draft: false,
      merged_at: merged ? "2026-01-01T00:01:00.000Z" : null,
      head: { ref: `feat/layer-${number}`, sha: `sha-${number}` },
    })),
  };
}

function createStore(
  apiRequest: GithubService["apiRequest"],
  entries = [entryRow()],
) {
  const stacks = [stackRow()];
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
    const store = createStore(apiRequest as unknown as GithubService["apiRequest"]);
    const result = await store.merge(repo, 4);
    expect(result.ok).toBe(true);
    expect(result.method).toBe("merge_async");
    expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      path: "/repos/ade/desktop/pulls/7/merge-async",
    }));
  });

  it("keeps polling merge-async after three seconds until GitHub reports merged", async () => {
    vi.useFakeTimers();
    let pullGets = 0;
    const apiRequest = vi.fn(async (args: { method: string; path: string }) => {
      if (args.method === "POST" && args.path.endsWith("/stacks/4/merge")) {
        throw new Error("Resource not accessible by integration");
      }
      if (args.method === "PUT" && args.path.endsWith("/pulls/7/merge-async")) {
        return { data: {}, response: { status: 202 } };
      }
      if (args.method === "GET" && args.path.endsWith("/pulls/7")) {
        pullGets += 1;
        if (pullGets < 5) {
          return { data: { merged: false }, response: { status: 200 } };
        }
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
    try {
      const store = createStore(apiRequest as unknown as GithubService["apiRequest"]);
      const pending = store.merge(repo, 4);
      await vi.advanceTimersByTimeAsync(8_000);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(pullGets).toBeGreaterThanOrEqual(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fall back when the stack API reports a merge conflict", async () => {
    const apiRequest = vi.fn(async (args: { method: string; path: string }) => {
      if (args.method === "POST" && args.path.endsWith("/stacks/4/merge")) {
        throw new Error("GitHub API request failed (HTTP 409)");
      }
      throw new Error(`unexpected ${args.method} ${args.path}`);
    });
    const store = createStore(apiRequest as unknown as GithubService["apiRequest"]);
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
    let stackGets = 0;
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
        stackGets += 1;
        return {
          data: githubStackPayload([7], { merged: stackGets > 1 }),
          response: { status: 200 },
        };
      }
      throw new Error(`unexpected ${args.method} ${args.path}`);
    });
    const store = createStore(apiRequest as unknown as GithubService["apiRequest"]);
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

  it("does not treat a 202 stack merge as done until every open layer is merged", async () => {
    vi.useFakeTimers();
    let layerEightGets = 0;
    let stackGets = 0;
    const apiRequest = vi.fn(async (args: { method: string; path: string }) => {
      if (args.method === "POST" && args.path.endsWith("/stacks/4/merge")) {
        return { data: {}, response: { status: 202 } };
      }
      if (args.method === "GET" && args.path.endsWith("/pulls/7")) {
        return {
          data: { merged: true, merged_at: "2026-01-01T00:01:00.000Z", merge_commit_sha: "aaa" },
          response: { status: 200 },
        };
      }
      if (args.method === "GET" && args.path.endsWith("/pulls/8")) {
        layerEightGets += 1;
        if (layerEightGets < 3) {
          return { data: { merged: false }, response: { status: 200 } };
        }
        return {
          data: { merged: true, merged_at: "2026-01-01T00:01:05.000Z", merge_commit_sha: "bbb" },
          response: { status: 200 },
        };
      }
      if (args.method === "GET" && args.path.endsWith("/stacks/4")) {
        stackGets += 1;
        return {
          data: githubStackPayload([7, 8], { merged: stackGets > 1 }),
          response: { status: 200 },
        };
      }
      throw new Error(`unexpected ${args.method} ${args.path}`);
    });
    try {
      const store = createStore(apiRequest as unknown as GithubService["apiRequest"], [
        entryRow(),
        entryRow({ github_pr_number: 8, position: 2, head_branch: "feat/top", head_sha: "def456" }),
      ]);
      const pending = store.merge(repo, 4);
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(layerEightGets).toBeGreaterThanOrEqual(3);
      expect(apiRequest).not.toHaveBeenCalledWith(expect.objectContaining({
        method: "PUT",
        path: "/repos/ade/desktop/pulls/7/merge-async",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls GitHub stack membership after 202 even when the local cache is empty", async () => {
    vi.useFakeTimers();
    let stackGets = 0;
    let pullGets = 0;
    const apiRequest = vi.fn(async (args: { method: string; path: string }) => {
      if (args.method === "POST" && args.path.endsWith("/stacks/4/merge")) {
        return { data: {}, response: { status: 202 } };
      }
      if (args.method === "GET" && args.path.endsWith("/pulls/7")) {
        pullGets += 1;
        return {
          data: {
            merged: pullGets >= 2,
            merged_at: pullGets >= 2 ? "2026-01-01T00:01:00.000Z" : null,
          },
          response: { status: 200 },
        };
      }
      if (args.method === "GET" && args.path.endsWith("/stacks/4")) {
        stackGets += 1;
        return {
          data: githubStackPayload([7], { merged: stackGets > 1 }),
          response: { status: 200 },
        };
      }
      throw new Error(`unexpected ${args.method} ${args.path}`);
    });
    try {
      const store = createStore(apiRequest as unknown as GithubService["apiRequest"], []);
      const pending = store.merge(repo, 4);
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(pullGets).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("githubStackStore.rebase", () => {
  it("marks rebase unavailable when update-branch rejects stacked PRs", async () => {
    const apiRequest = vi.fn(async (args: { method: string; path: string }) => {
      if (args.method === "POST" && args.path.endsWith("/stacks/4/rebase")) {
        throw new Error("Not Found");
      }
      if (args.method === "GET" && args.path.endsWith("/pulls/7")) {
        return { data: { merged: false, head: { sha: "abc123" } }, response: { status: 200 } };
      }
      if (args.method === "PUT" && args.path.endsWith("/pulls/7/update-branch")) {
        throw new Error("Updating a stacked PR's branch via this endpoint is not supported.");
      }
      throw new Error(`unexpected ${args.method} ${args.path}`);
    });
    const store = createStore(apiRequest as unknown as GithubService["apiRequest"]);
    const result = await store.rebase(repo, 4);
    expect(result).toMatchObject({
      ok: false,
      method: "unavailable",
    });
    expect(result.disabledReason).toMatch(/does not expose stack rebase/i);
  });

  it("waits for each update-branch head to move before rebasing the next layer", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let updatedSeven = false;
    let updatedEight = false;
    let layerSevenPolls = 0;
    const apiRequest = vi.fn(async (args: { method: string; path: string }) => {
      if (args.method === "POST" && args.path.endsWith("/stacks/4/rebase")) {
        throw new Error("Not Found");
      }
      if (args.method === "PUT" && args.path.endsWith("/pulls/7/update-branch")) {
        order.push("update-7");
        updatedSeven = true;
        return { data: {}, response: { status: 202 } };
      }
      if (args.method === "PUT" && args.path.endsWith("/pulls/8/update-branch")) {
        order.push("update-8");
        updatedEight = true;
        return { data: {}, response: { status: 202 } };
      }
      if (args.method === "GET" && args.path.endsWith("/pulls/7")) {
        order.push(updatedSeven ? "poll-7" : "live-7");
        if (!updatedSeven) {
          return { data: { merged: false, head: { sha: "abc123" } }, response: { status: 200 } };
        }
        layerSevenPolls += 1;
        if (layerSevenPolls < 3) {
          return { data: { merged: false, head: { sha: "abc123" } }, response: { status: 200 } };
        }
        return { data: { merged: false, head: { sha: "abc999" } }, response: { status: 200 } };
      }
      if (args.method === "GET" && args.path.endsWith("/pulls/8")) {
        order.push(updatedEight ? "poll-8" : "live-8");
        if (!updatedEight) {
          return { data: { merged: false, head: { sha: "def456" } }, response: { status: 200 } };
        }
        return { data: { merged: false, head: { sha: "def999" } }, response: { status: 200 } };
      }
      if (args.method === "GET" && args.path.endsWith("/stacks/4")) {
        return { data: githubStackPayload([7, 8]), response: { status: 200 } };
      }
      throw new Error(`unexpected ${args.method} ${args.path}`);
    });
    try {
      const store = createStore(apiRequest as unknown as GithubService["apiRequest"], [
        entryRow(),
        entryRow({ github_pr_number: 8, position: 2, head_branch: "feat/top", head_sha: "def456" }),
      ]);
      const pending = store.rebase(repo, 4);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(result.method).toBe("update_branch");
      expect(order.indexOf("update-8")).toBeGreaterThan(order.lastIndexOf("poll-7"));
      expect(order.indexOf("live-8")).toBeGreaterThan(order.indexOf("update-7"));
      expect(order.indexOf("update-8")).toBeGreaterThan(order.indexOf("live-8"));
    } finally {
      vi.useRealTimers();
    }
  });
});
