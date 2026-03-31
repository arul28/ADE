import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { LaneSummary, RebaseNeed } from "../../../shared/types";
import { launchRebaseResolutionChat } from "./prRebaseResolver";

vi.mock("./resolverUtils", () => ({
  mapPermissionMode: (mode: string | undefined) => {
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
        provider: "unified",
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
        displayText: "Rebase feature/rebase-target onto main",
        reasoningEffort: "high",
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
