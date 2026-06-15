import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseInitialLane, chooseMostRecentSessionLane, chooseTuiLaunchLane, detectProjectLaunchContext, resolveTuiChatRefreshTarget } from "../project";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";

function lane(overrides: Partial<LaneSummary>): LaneSummary {
  return {
    id: "main",
    name: "main",
    laneType: "primary",
    baseRef: "main",
    branchRef: "main",
    worktreePath: "/repo",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function chat(sessionId: string, laneId: string, lastActivityAt: string): AgentChatSessionSummary {
  return {
    sessionId,
    laneId,
    provider: "codex",
    model: "gpt-5.5",
    status: "idle",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    lastActivityAt,
    lastOutputPreview: null,
    summary: null,
  };
}

describe("chooseInitialLane", () => {
  it("accepts an explicit lane hint from the CLI launch context", () => {
    const context = detectProjectLaunchContext({
      cwd: "/tmp",
      projectRoot: "/tmp",
      workspaceRoot: "/tmp",
      laneHint: "feature-a",
    });

    expect(context.laneHint).toBe("feature-a");
  });

  it("allows remote-only roots and carries the initial session hint", () => {
    const context = detectProjectLaunchContext({
      cwd: "/tmp",
      projectRoot: "/remote/project",
      workspaceRoot: "/remote/project/.ade/worktrees/work",
      laneHint: "work",
      sessionHint: "session-remote",
      remote: true,
    });

    expect(context.projectRoot).toBe("/remote/project");
    expect(context.workspaceRoot).toBe("/remote/project/.ade/worktrees/work");
    expect(context.laneHint).toBe("work");
    expect(context.sessionHint).toBe("session-remote");
    expect(context.remote).toBe(true);
  });

  it("prefers the ADE worktree lane hint", () => {
    const lanes = [
      lane({ id: "main", name: "main", laneType: "primary", worktreePath: "/repo" }),
      lane({ id: "feature-a", name: "Feature A", laneType: "worktree", branchRef: "feature/a", worktreePath: "/repo/.ade/worktrees/feature-a" }),
    ];
    expect(chooseInitialLane(lanes, {
      workspaceRoot: "/repo/.ade/worktrees/feature-a",
      laneHint: "feature-a",
    })?.id).toBe("feature-a");
  });

  it("falls back to matching the workspace path", () => {
    const worktreePath = path.resolve("/repo/.ade/worktrees/feature-b");
    const lanes = [
      lane({ id: "main", laneType: "primary", worktreePath: "/repo" }),
      lane({ id: "feature-b", laneType: "worktree", worktreePath }),
    ];
    expect(chooseInitialLane(lanes, {
      workspaceRoot: path.join(worktreePath, "apps/desktop"),
      laneHint: null,
    })?.id).toBe("feature-b");
  });
});

describe("chooseTuiLaunchLane", () => {
  it("uses the persisted last lane when launch context only resolves to primary", () => {
    const lanes = [
      lane({ id: "main", name: "main", laneType: "primary", worktreePath: "/repo" }),
      lane({ id: "feature-b", name: "Feature B", laneType: "worktree", worktreePath: "/repo/.ade/worktrees/feature-b" }),
    ];

    expect(chooseTuiLaunchLane(lanes, {
      workspaceRoot: "/repo",
      laneHint: null,
    }, "feature-b")?.id).toBe("feature-b");
  });

  it("keeps an explicit worktree launch ahead of the persisted last lane", () => {
    const featureAPath = path.resolve("/repo/.ade/worktrees/feature-a");
    const lanes = [
      lane({ id: "main", name: "main", laneType: "primary", worktreePath: "/repo" }),
      lane({ id: "feature-a", name: "Feature A", laneType: "worktree", worktreePath: featureAPath }),
      lane({ id: "feature-b", name: "Feature B", laneType: "worktree", worktreePath: "/repo/.ade/worktrees/feature-b" }),
    ];

    expect(chooseTuiLaunchLane(lanes, {
      workspaceRoot: path.join(featureAPath, "apps/desktop"),
      laneHint: null,
    }, "feature-b")?.id).toBe("feature-a");
  });
});

describe("chooseMostRecentSessionLane", () => {
  it("uses runtime chat activity to choose the launch preview lane", () => {
    const lanes = [
      lane({ id: "main", name: "main", laneType: "primary", worktreePath: "/repo" }),
      lane({ id: "feature-a", name: "Feature A", laneType: "worktree", worktreePath: "/repo/.ade/worktrees/feature-a" }),
      lane({ id: "feature-b", name: "Feature B", laneType: "worktree", worktreePath: "/repo/.ade/worktrees/feature-b" }),
    ];

    expect(chooseMostRecentSessionLane(lanes, [
      chat("old", "feature-a", "2026-01-01T00:00:00.000Z"),
      chat("recent", "feature-b", "2026-01-02T00:00:00.000Z"),
    ])?.id).toBe("feature-b");
  });

  it("ignores sessions for lanes missing from the current runtime state", () => {
    const lanes = [
      lane({ id: "main", name: "main", laneType: "primary", worktreePath: "/repo" }),
    ];

    expect(chooseMostRecentSessionLane(lanes, [
      chat("stale", "deleted-lane", "2026-01-02T00:00:00.000Z"),
    ])).toBeNull();
  });
});

describe("resolveTuiChatRefreshTarget", () => {
  it("uses the active session lane when an initial session hint points outside the default lane", () => {
    const lanes = [
      lane({ id: "main", name: "main", laneType: "primary", worktreePath: "/repo" }),
      lane({ id: "feature-a", name: "Feature A", laneType: "worktree", worktreePath: "/repo/.ade/worktrees/feature-a" }),
    ];
    const hinted = chat("hinted-chat", "feature-a", "2026-01-02T00:00:00.000Z");

    const target = resolveTuiChatRefreshTarget({
      lanes,
      sessions: [
        chat("main-chat", "main", "2026-01-01T00:00:00.000Z"),
        hinted,
      ],
      context: { workspaceRoot: "/repo", laneHint: null },
      lastLaneId: "main",
      activeLaneId: null,
      activeSessionId: "hinted-chat",
      draftChatActive: false,
      initialNewChatPreview: false,
      newChatPreviewLaneId: null,
      selectedDrawerChatAction: null,
      drawerLaneId: null,
    });

    expect(target.laneId).toBe("feature-a");
    expect(target.session?.sessionId).toBe("hinted-chat");
  });

  it("launches into a new-chat preview for the most recent runtime lane without hydrating its last chat", () => {
    const lanes = [
      lane({ id: "main", name: "main", laneType: "primary", worktreePath: "/repo" }),
      lane({ id: "feature-a", name: "Feature A", laneType: "worktree", worktreePath: "/repo/.ade/worktrees/feature-a" }),
      lane({ id: "feature-b", name: "Feature B", laneType: "worktree", worktreePath: "/repo/.ade/worktrees/feature-b" }),
    ];
    const recent = chat("recent-chat", "feature-b", "2026-01-02T00:00:00.000Z");

    const target = resolveTuiChatRefreshTarget({
      lanes,
      sessions: [
        chat("old-chat", "feature-a", "2026-01-01T00:00:00.000Z"),
        recent,
      ],
      context: { workspaceRoot: "/repo", laneHint: null },
      lastLaneId: "feature-a",
      activeLaneId: null,
      activeSessionId: null,
      draftChatActive: false,
      initialNewChatPreview: true,
      newChatPreviewLaneId: null,
      selectedDrawerChatAction: null,
      drawerLaneId: null,
    });

    expect(target.laneId).toBe("feature-b");
    expect(target.launchToNewChatPreview).toBe(true);
    expect(target.previewMode).toBe(true);
    expect(target.session).toBeNull();
    expect(target.seedSession?.sessionId).toBe(recent.sessionId);
  });

  it("lets the initial new-chat launch target override a stale active lane", () => {
    const lanes = [
      lane({ id: "main", name: "main", laneType: "primary", worktreePath: "/repo" }),
      lane({ id: "feature-a", name: "Feature A", laneType: "worktree", worktreePath: "/repo/.ade/worktrees/feature-a" }),
      lane({ id: "feature-b", name: "Feature B", laneType: "worktree", worktreePath: "/repo/.ade/worktrees/feature-b" }),
    ];
    const recent = chat("recent-chat", "feature-b", "2026-01-02T00:00:00.000Z");

    const target = resolveTuiChatRefreshTarget({
      lanes,
      sessions: [
        chat("old-chat", "feature-a", "2026-01-01T00:00:00.000Z"),
        recent,
      ],
      context: { workspaceRoot: "/repo", laneHint: null },
      lastLaneId: "feature-a",
      activeLaneId: "feature-a",
      activeSessionId: null,
      draftChatActive: false,
      initialNewChatPreview: true,
      newChatPreviewLaneId: null,
      selectedDrawerChatAction: null,
      drawerLaneId: null,
    });

    expect(target.laneId).toBe("feature-b");
    expect(target.session).toBeNull();
    expect(target.seedSession?.sessionId).toBe(recent.sessionId);
  });

  it("keeps the new-chat preview on later refreshes instead of snapping to the newest lane chat", () => {
    const lanes = [
      lane({ id: "main", name: "main", laneType: "primary", worktreePath: "/repo" }),
      lane({ id: "feature-b", name: "Feature B", laneType: "worktree", worktreePath: "/repo/.ade/worktrees/feature-b" }),
    ];

    const target = resolveTuiChatRefreshTarget({
      lanes,
      sessions: [chat("recent-chat", "feature-b", "2026-01-02T00:00:00.000Z")],
      context: { workspaceRoot: "/repo", laneHint: null },
      lastLaneId: "main",
      activeLaneId: "feature-b",
      activeSessionId: null,
      draftChatActive: false,
      initialNewChatPreview: false,
      newChatPreviewLaneId: "feature-b",
      selectedDrawerChatAction: "new-chat",
      drawerLaneId: "feature-b",
    });

    expect(target.laneId).toBe("feature-b");
    expect(target.previewMode).toBe(true);
    expect(target.session).toBeNull();
  });

  it("prefers the drawer-browsed chat over the newest lane chat during refresh", () => {
    const lanes = [
      lane({ id: "feature-b", name: "Feature B", laneType: "worktree", worktreePath: "/repo/.ade/worktrees/feature-b" }),
    ];
    const older = chat("older-chat", "feature-b", "2026-01-01T00:00:00.000Z");
    const newer = chat("newer-chat", "feature-b", "2026-01-02T00:00:00.000Z");

    const target = resolveTuiChatRefreshTarget({
      lanes,
      sessions: [older, newer],
      context: { workspaceRoot: "/repo", laneHint: null },
      lastLaneId: "feature-b",
      activeLaneId: "feature-b",
      activeSessionId: null,
      draftChatActive: false,
      initialNewChatPreview: false,
      newChatPreviewLaneId: null,
      selectedDrawerChatAction: null,
      drawerLaneId: "feature-b",
      drawerBrowsingChatId: "older-chat",
      drawerBrowsingNewChat: false,
    });

    expect(target.session?.sessionId).toBe("older-chat");
    expect(target.previewMode).toBe(false);
  });
});
