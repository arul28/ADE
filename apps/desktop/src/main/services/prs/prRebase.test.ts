import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LaneSummary, RebaseNeed } from "../../../shared/types";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
// prRebaseResolver imports resolverUtils — we mock it with replica behavior so
// rebase-resolver tests stay decoupled from git. The resolverUtils describe
// block below uses `vi.importActual` to exercise the REAL implementation.

vi.mock("./resolverUtils", () => ({
  mapPermissionMode: (mode: string | undefined) => {
    if (mode === "full_edit") return "full-auto";
    if (mode === "read_only") return "plan";
    return "edit";
  },
  mapPermissionModeForModelFamily: (mode: string | undefined, family: string | undefined) => {
    if (family === "openai" && mode === "guarded_edit") return "default";
    if (mode === "full_edit") return "full-auto";
    if (mode === "read_only") return "plan";
    return "edit";
  },
  readRecentCommits: vi.fn(async (_worktreePath: string, _count?: number, ref?: string) => {
    if (ref && ref.startsWith("origin/")) {
      return [
        { sha: "aaa1111222233334444555566667777aaaabbbb", subject: "Upstream fix for auth" },
        { sha: "bbb2222333344445555666677778888bbbbcccc", subject: "Bump dependencies" },
      ];
    }
    if (ref && !ref.startsWith("origin/") && ref !== "HEAD") {
      return [{ sha: "local111222233334444555566667777aaaabbbb", subject: "Local base commit" }];
    }
    return [
      { sha: "ccc3333444455556666777788889999ccccdddd", subject: "Add feature X" },
      { sha: "ddd4444555566667777888899990000ddddeee0", subject: "Fix tests for X" },
    ];
  }),
}));

vi.mock("../git/git", () => ({
  runGit: vi.fn(),
}));

import { runGit } from "../git/git";
import { launchRebaseResolutionChat } from "./prRebaseResolver";

const mockRunGit = vi.mocked(runGit);

// ---------------------------------------------------------------------------
// resolverUtils — exercises the REAL module via vi.importActual
// ---------------------------------------------------------------------------

describe("resolverUtils (real module)", () => {
  // Lazy-loaded handles to the real module so the prRebaseResolver mock above
  // does not interfere.
  let mapPermissionMode: (mode: string | undefined) => string;
  let mapPermissionModeForModelFamily: (
    mode: string | undefined,
    family: string | undefined,
  ) => string;
  let readRecentCommits: (worktreePath: string, count?: number, ref?: string) => Promise<Array<{ sha: string; subject: string }>>;

  beforeAll(async () => {
    const real = await vi.importActual<typeof import("./resolverUtils")>("./resolverUtils");
    mapPermissionMode = real.mapPermissionMode;
    mapPermissionModeForModelFamily = real.mapPermissionModeForModelFamily;
    readRecentCommits = real.readRecentCommits;
  });

  describe("mapPermissionMode", () => {
    it("maps full_edit to full-auto", () => {
      expect(mapPermissionMode("full_edit")).toBe("full-auto");
    });

    it("maps read_only to plan", () => {
      expect(mapPermissionMode("read_only")).toBe("plan");
    });

    it("maps guarded_edit to edit", () => {
      expect(mapPermissionMode("guarded_edit")).toBe("edit");
    });

    it("maps undefined to edit", () => {
      expect(mapPermissionMode(undefined)).toBe("edit");
    });

    it("maps an unrecognized value to edit", () => {
      expect(mapPermissionMode("some_other_value" as any)).toBe("edit");
    });
  });

  describe("mapPermissionModeForModelFamily", () => {
    it("maps guarded_edit to Codex default permissions for OpenAI CLI models", () => {
      expect(mapPermissionModeForModelFamily("guarded_edit", "openai")).toBe("default");
    });

    it("keeps guarded_edit as edit for non-OpenAI models", () => {
      expect(mapPermissionModeForModelFamily("guarded_edit", "anthropic")).toBe("edit");
    });
  });

  describe("readRecentCommits", () => {
    it("parses git log output into sha/subject pairs", async () => {
      mockRunGit.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "abc123def456\tAdd feature X\nbbb222ccc333\tFix tests\n",
        stderr: "",
      } as any);

      const commits = await readRecentCommits("/tmp/worktree", 8);

      expect(mockRunGit).toHaveBeenCalledWith(
        ["log", "--format=%H%x09%s", "-n", "8", "HEAD"],
        { cwd: "/tmp/worktree", timeoutMs: 10_000 },
      );
      expect(commits).toEqual([
        { sha: "abc123def456", subject: "Add feature X" },
        { sha: "bbb222ccc333", subject: "Fix tests" },
      ]);
    });

    it("defaults to 8 commits and HEAD ref", async () => {
      mockRunGit.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "aaa111bbb222\tFirst commit\n",
        stderr: "",
      } as any);

      await readRecentCommits("/tmp/worktree");

      expect(mockRunGit).toHaveBeenCalledWith(
        ["log", "--format=%H%x09%s", "-n", "8", "HEAD"],
        expect.objectContaining({ cwd: "/tmp/worktree" }),
      );
    });

    it("uses a custom ref when provided", async () => {
      mockRunGit.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "aaa111bbb222\tRemote commit\n",
        stderr: "",
      } as any);

      await readRecentCommits("/tmp/worktree", 5, "origin/main");

      expect(mockRunGit).toHaveBeenCalledWith(
        ["log", "--format=%H%x09%s", "-n", "5", "origin/main"],
        expect.objectContaining({ cwd: "/tmp/worktree" }),
      );
    });

    it("returns empty array when git exits with non-zero", async () => {
      mockRunGit.mockResolvedValueOnce({
        exitCode: 128,
        stdout: "",
        stderr: "fatal: bad default revision 'HEAD'",
      } as any);

      const commits = await readRecentCommits("/tmp/worktree");

      expect(commits).toEqual([]);
    });

    it("filters out empty lines and entries with no sha or subject", async () => {
      mockRunGit.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "abc123\tGood commit\n\n  \n\t\n",
        stderr: "",
      } as any);

      const commits = await readRecentCommits("/tmp/worktree");

      expect(commits).toEqual([{ sha: "abc123", subject: "Good commit" }]);
    });

    it("handles tab characters in the commit subject", async () => {
      mockRunGit.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "abc123\tSubject\twith\ttabs\n",
        stderr: "",
      } as any);

      const commits = await readRecentCommits("/tmp/worktree");

      expect(commits).toEqual([{ sha: "abc123", subject: "Subject\twith\ttabs" }]);
    });
  });
});

// ---------------------------------------------------------------------------
// launchRebaseResolutionChat — uses the mocked resolverUtils
// ---------------------------------------------------------------------------

const createdTempDirs: string[] = [];
afterAll(() => {
  for (const dir of createdTempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  const worktreePath = overrides.worktreePath ?? fs.mkdtempSync(path.join(os.tmpdir(), "ade-rebase-test-"));
  if (!overrides.worktreePath) createdTempDirs.push(worktreePath);
  return {
    id: "lane-rebase-1",
    name: "feature/rebase-target",
    description: "Lane for rebase testing.",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/rebase-target",
    worktreePath,
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 3, behind: 5, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-03-25T10:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeRebaseNeed(overrides: Partial<RebaseNeed> = {}): RebaseNeed {
  return {
    laneId: "lane-rebase-1",
    laneName: "feature/rebase-target",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 5,
    conflictPredicted: true,
    conflictingFiles: ["src/auth.ts", "src/config.ts"],
    prId: null,
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
    ...overrides,
  };
}

function makeDeps(overrides: { rebaseNeed?: RebaseNeed | null } = {}) {
  const lane = makeLane();
  const createSession = vi.fn(async () => ({ id: "session-rebase-1" }));
  const sendMessage = vi.fn(async (_arg: any) => undefined);
  const updateMeta = vi.fn();
  const getRebaseNeed = vi.fn(async () => overrides.rebaseNeed !== undefined ? overrides.rebaseNeed : makeRebaseNeed());

  const deps = {
    laneService: {
      list: vi.fn(async () => [lane]),
      getLaneBaseAndBranch: vi.fn(() => ({
        baseRef: "main",
        branchRef: "feature/rebase-target",
        worktreePath: lane.worktreePath,
        laneType: "worktree",
      })),
    },
    agentChatService: { createSession, sendMessage },
    sessionService: { updateMeta },
    conflictService: { getRebaseNeed },
  };

  return { lane, deps, createSession, sendMessage, updateMeta, getRebaseNeed };
}

describe("launchRebaseResolutionChat", () => {
  it("creates a chat session with the correct parameters and sends the composed prompt", async () => {
    const { lane, deps, createSession, sendMessage, updateMeta } = makeDeps();

    const result = await launchRebaseResolutionChat(deps as any, {
      laneId: lane.id,
      modelId: "anthropic/claude-sonnet-4-6",
      reasoning: "high",
      permissionMode: "guarded_edit",
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: lane.id,
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-4-6",
        surface: "work",
        sessionProfile: "workflow",
        permissionMode: "edit",
        reasoningEffort: "high",
      }),
    );
    expect(updateMeta).toHaveBeenCalledWith({
      sessionId: "session-rebase-1",
      title: "Rebase feature/rebase-target onto main",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-rebase-1",
        reasoningEffort: "high",
        displayText: "Rebase feature/rebase-target onto main",
      }),
    );
    expect(result).toEqual({
      sessionId: "session-rebase-1",
      laneId: lane.id,
      href: `/work?laneId=${encodeURIComponent(lane.id)}&sessionId=session-rebase-1`,
    });
  });

  it("includes conflict info, base commits, and lane commits in the prompt", async () => {
    const { deps, sendMessage, lane } = makeDeps();

    await launchRebaseResolutionChat(deps as any, {
      laneId: lane.id,
      modelId: "anthropic/claude-sonnet-4-6",
    });

    const sentText = sendMessage.mock.calls[0][0].text as string;
    expect(sentText).toContain("resolving a rebase conflict");
    expect(sentText).toContain("Lane name: feature/rebase-target");
    expect(sentText).toContain("Base branch: main");
    expect(sentText).toContain("Behind by: 5 commits");
    expect(sentText).toContain("Conflict predicted: YES");
    expect(sentText).toContain("src/auth.ts");
    expect(sentText).toContain("src/config.ts");
    expect(sentText).toContain("Upstream fix for auth");
    expect(sentText).toContain("Add feature X");
  });

  it("defaults forcePushAfterRebase to true", async () => {
    const { deps, sendMessage, lane } = makeDeps();

    await launchRebaseResolutionChat(deps as any, {
      laneId: lane.id,
      modelId: "anthropic/claude-sonnet-4-6",
    });

    const sentText = sendMessage.mock.calls[0][0].text as string;
    expect(sentText).toContain("force push the rewritten branch");
  });

  it("omits force push instruction when forcePushAfterRebase is false", async () => {
    const { deps, sendMessage, lane } = makeDeps();

    await launchRebaseResolutionChat(deps as any, {
      laneId: lane.id,
      modelId: "anthropic/claude-sonnet-4-6",
      forcePushAfterRebase: false,
    });

    const sentText = sendMessage.mock.calls[0][0].text as string;
    expect(sentText).toContain("Do NOT push");
    expect(sentText).not.toContain("force push the rewritten branch");
  });

  it("maps full_edit permission mode to full-auto", async () => {
    const { deps, createSession, lane } = makeDeps();

    await launchRebaseResolutionChat(deps as any, {
      laneId: lane.id,
      modelId: "anthropic/claude-sonnet-4-6",
      permissionMode: "full_edit",
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "full-auto" }),
    );
  });

  it("maps read_only permission mode to plan", async () => {
    const { deps, createSession, lane } = makeDeps();

    await launchRebaseResolutionChat(deps as any, {
      laneId: lane.id,
      modelId: "anthropic/claude-sonnet-4-6",
      permissionMode: "read_only",
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "plan" }),
    );
  });

  it("omits reasoningEffort when reasoning is not provided", async () => {
    const { deps, createSession, sendMessage, lane } = makeDeps();

    await launchRebaseResolutionChat(deps as any, {
      laneId: lane.id,
      modelId: "anthropic/claude-sonnet-4-6",
    });

    const sessionArgs = (createSession.mock.calls as any[][])[0]?.[0];
    expect(sessionArgs).not.toHaveProperty("reasoningEffort");
    const messageArgs = (sendMessage.mock.calls as any[][])[0]?.[0];
    expect(messageArgs).not.toHaveProperty("reasoningEffort");
  });

  it("throws when model is unknown", async () => {
    const { deps, lane } = makeDeps();

    await expect(
      launchRebaseResolutionChat(deps as any, {
        laneId: lane.id,
        modelId: "unknown/model-xyz",
      }),
    ).rejects.toThrow("Unknown model");
  });

  it("throws when lane is not found", async () => {
    const { deps } = makeDeps();

    await expect(
      launchRebaseResolutionChat(deps as any, {
        laneId: "nonexistent-lane",
        modelId: "anthropic/claude-sonnet-4-6",
      }),
    ).rejects.toThrow("Lane not found");
  });

  it("throws when lane worktree is missing on disk", async () => {
    const lane = makeLane({ worktreePath: path.join(os.tmpdir(), "nonexistent-ade-worktree-path") });
    const deps = {
      laneService: {
        list: vi.fn(async () => [lane]),
        getLaneBaseAndBranch: vi.fn(),
      },
      agentChatService: { createSession: vi.fn(), sendMessage: vi.fn() },
      sessionService: { updateMeta: vi.fn() },
      conflictService: { getRebaseNeed: vi.fn() },
    };

    await expect(
      launchRebaseResolutionChat(deps as any, {
        laneId: lane.id,
        modelId: "anthropic/claude-sonnet-4-6",
      }),
    ).rejects.toThrow("Lane worktree is missing on disk");
  });

  it("throws when no rebase need is found", async () => {
    const { deps, lane } = makeDeps({ rebaseNeed: null });

    await expect(
      launchRebaseResolutionChat(deps as any, {
        laneId: lane.id,
        modelId: "anthropic/claude-sonnet-4-6",
      }),
    ).rejects.toThrow("No rebase need found");
  });

  it("handles singular commit count in prompt text", async () => {
    const { deps, sendMessage, lane } = makeDeps({
      rebaseNeed: makeRebaseNeed({ behindBy: 1 }),
    });

    await launchRebaseResolutionChat(deps as any, {
      laneId: lane.id,
      modelId: "anthropic/claude-sonnet-4-6",
    });

    const sentText = sendMessage.mock.calls[0][0].text as string;
    expect(sentText).toContain("Behind by: 1 commit");
    expect(sentText).not.toContain("1 commits");
  });

  it("handles no conflict predicted", async () => {
    const { deps, sendMessage, lane } = makeDeps({
      rebaseNeed: makeRebaseNeed({ conflictPredicted: false, conflictingFiles: [] }),
    });

    await launchRebaseResolutionChat(deps as any, {
      laneId: lane.id,
      modelId: "anthropic/claude-sonnet-4-6",
    });

    const sentText = sendMessage.mock.calls[0][0].text as string;
    expect(sentText).toContain("Conflict predicted: NO");
    expect(sentText).not.toContain("Files modified in both branches");
  });
});
