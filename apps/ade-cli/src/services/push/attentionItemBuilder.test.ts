import { describe, expect, it, vi } from "vitest";
import {
  agentAttentionEventKind,
  agentAttentionPrivacyPreview,
  agentAttentionTitle,
  agentEventKindForPhase,
  attentionProjectRef,
  buildAttentionItems,
  rosterAttentionPhase,
  type ActivityRosterProject,
  type AgentRunState,
  type AttentionItemBuildContext,
  type PrLiveActivityState,
} from "./attentionItemBuilder";

function run(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    sessionId: "s-1",
    scopeKey: "scope-a",
    kind: "chat",
    title: "Fix login",
    lane: "auth-lane",
    model: "gpt-5",
    agent: "Codex",
    phase: "running",
    detail: null,
    itemId: null,
    startedAt: 1_000,
    lastActiveAt: 2_000,
    statusSinceAt: 1_500,
    metaResolved: true,
    backgroundTaskIds: new Set<string>(),
    chatActivityMode: null,
    chatMetaCheckedAt: 0,
    deferredTerminalPhase: null,
    ...overrides,
  };
}

function rosterProject(
  overrides: Partial<ActivityRosterProject["chats"][number]> = {},
): ActivityRosterProject {
  return {
    projectId: "roster-project",
    rootPath: "/projects/roster",
    displayName: "Roster project",
    booted: false,
    runningCount: 0,
    attentionCount: 0,
    lanes: [{ id: "lane-roster", name: "Roster lane" }],
    chats: [{
      id: "disk-session-1",
      laneId: "lane-roster",
      title: "Disk session",
      provider: "codex",
      model: "gpt-5",
      toolType: "codex-chat",
      status: "idle" as const,
      lastActivityAt: "2026-08-01T12:00:00.000Z",
      preview: "Processed 3 files",
      ...overrides,
    }],
  } as ActivityRosterProject;
}

function context(
  overrides: Partial<AttentionItemBuildContext> = {},
): AttentionItemBuildContext {
  return {
    nowMs: Date.parse("2026-08-01T12:00:00.000Z"),
    includeRoster: false,
    machineKey: "machine-1",
    accountMachineIdentity: null,
    machineName: "Studio",
    runs: new Map<string, AgentRunState>(),
    recentRuns: new Map<string, AgentRunState>(),
    prActivities: new Map<string, PrLiveActivityState>(),
    scopes: new Map([["scope-a", { projectName: "ADE", projectRoot: "/workspace/ADE" }]]),
    rosterPhaseAnchors: new Map(),
    loadRoster: async () => [],
    canonicalProjectId: (rootPath) => (rootPath ? `project_${rootPath}` : null),
    lastPublishedRevisionById: new Map(),
    remoteAcknowledgedRevisionById: new Map(),
    ...overrides,
  };
}

describe("attention item vocabulary", () => {
  it("titles the session, not the provider-phase sentence", async () => {
    // Privacy-safe copy stays generic; the row the user reads is the chat
    // name. Both paths used to say "Codex is idle" and every in-flight row
    // on the island collapsed to "Cursor is working".
    const live = await buildAttentionItems(context({
      runs: new Map([["s-1", run({ phase: "stale" })]]),
    }));
    const roster = await buildAttentionItems(context({
      includeRoster: true,
      loadRoster: async () => [rosterProject({ status: "idle" })],
    }));

    expect(live[0]?.phase).toBe("stale");
    expect(roster[0]?.phase).toBe("stale");
    expect(live[0]?.title).toBe("Fix login");
    expect(roster[0]?.title).toBe("Disk session");
    expect(live[0]?.privacyPreview).toBe("An ADE agent is idle.");
    expect(roster[0]?.privacyPreview).toBe("An ADE agent is idle.");
  });

  it("says 'idle' and never 'stale' or 'quiet' for the resting state", async () => {
    // Regression: one state, three words. The title said "is idle", the
    // privacy preview said "An ADE agent SESSION is idle", the row label said
    // "Stale" and the desktop sheet said "has gone quiet". `idle` is now a
    // first-class state group (`ACTIVITY_STATE_GLYPHS.idle`, label "Idle",
    // `activityStateSentence` → "<Agent> is idle"), so every string the
    // publisher emits for it uses that one word.
    const [item] = await buildAttentionItems(context({
      runs: new Map([["s-1", run({ phase: "stale" })]]),
    }));

    expect(item?.privacyPreview).toBe("An ADE agent is idle.");
    for (const copy of [item?.title ?? "", item?.privacyPreview ?? ""]) {
      expect(copy.toLowerCase()).not.toMatch(/stale|quiet/);
    }
  });

  it("derives one event kind per published phase for both paths", () => {
    expect(agentEventKindForPhase(rosterAttentionPhase("awaiting"))).toBe("agent_needs_you");
    expect(agentEventKindForPhase(rosterAttentionPhase("failed"))).toBe("agent_failed");
    expect(agentEventKindForPhase(rosterAttentionPhase("ended"))).toBe("agent_completed");
    expect(agentEventKindForPhase(rosterAttentionPhase("idle"))).toBe("agent_running");
    // A run held at `running` by live background work must not ship the
    // `agent_completed` kind its raw phase would suggest.
    expect(agentAttentionEventKind(run({
      phase: "completed",
      backgroundTaskIds: new Set(["task-1"]),
    }))).toBe("agent_running");
    expect(agentAttentionTitle("Claude", "completed")).toBe("Claude is done");
    expect(agentAttentionPrivacyPreview("needs_you")).toBe("An ADE agent needs you.");
  });

  it("resolves the cross-machine project id once per item", () => {
    const canonicalProjectId = vi.fn(() => "project_hash");
    expect(attentionProjectRef("scope-a", "ADE", "/workspace/ADE", canonicalProjectId)).toEqual({
      projectId: "scope-a",
      canonicalId: "project_hash",
      name: "ADE",
      rootPath: "/workspace/ADE",
    });
    expect(canonicalProjectId).toHaveBeenCalledTimes(1);
  });

  it("omits canonicalId rather than inventing one when the root is unknown", () => {
    expect(attentionProjectRef("scope-a", "ADE", null, () => null)).toEqual({
      projectId: "scope-a",
      name: "ADE",
      rootPath: null,
    });
  });
});

describe("buildAttentionItems", () => {
  it("lets a live roster row outrank a frozen terminal run on the same id", async () => {
    const items = await buildAttentionItems(context({
      includeRoster: true,
      machineKey: "machine-1",
      runs: new Map([["disk-session-1", run({
        sessionId: "disk-session-1",
        phase: "completed",
      })]]),
      loadRoster: async () => [rosterProject({ status: "running" })],
    }));

    expect(items).toHaveLength(1);
    expect(items[0]?.phase).toBe("running");
  });

  it("never moves a republished row's revision backwards", async () => {
    const items = await buildAttentionItems(context({
      runs: new Map([["s-1", run({ lastActiveAt: 2_000 })]]),
      lastPublishedRevisionById: new Map([["agent:machine-1:s-1", 5_000]]),
      remoteAcknowledgedRevisionById: new Map([["agent:machine-1:s-1", 9_000]]),
    }));

    expect(items[0]?.revision).toBe(9_000);
  });

  it("prunes phase anchors for roster rows that are gone", async () => {
    const rosterPhaseAnchors = new Map([
      ["agent:machine-1:vanished", { status: "running" as const, statusSinceAt: 1 }],
    ]);
    await buildAttentionItems(context({
      includeRoster: true,
      rosterPhaseAnchors,
      loadRoster: async () => [rosterProject()],
    }));

    expect([...rosterPhaseAnchors.keys()]).toEqual(["agent:machine-1:disk-session-1"]);
  });

  it("drops identity chats and shells nested under a visible chat", async () => {
    const project = rosterProject();
    project.chats = [
      { ...project.chats[0]!, id: "chat-1" },
      { ...project.chats[0]!, id: "cto-1", identityKey: "cto" },
      { ...project.chats[0]!, id: "shell-1", chatSessionId: "chat-1" },
    ];
    const items = await buildAttentionItems(context({
      includeRoster: true,
      loadRoster: async () => [project],
    }));

    expect(items.map((item) => item.destination)).toEqual([
      expect.objectContaining({ sessionId: "chat-1" }),
    ]);
  });

  it("does not let a stuck live run bury a roster failure", async () => {
    const items = await buildAttentionItems(context({
      includeRoster: true,
      machineKey: "machine-1",
      runs: new Map([["disk-session-1", run({
        sessionId: "disk-session-1",
        phase: "running",
        title: "phase 3 running; will hold before phase 4",
      })]]),
      loadRoster: async () => [rosterProject({
        status: "failed",
        lastTurnFailedAt: "2026-08-01T11:00:00.000Z",
        title: "Align ADE Code With Work Tab",
      })],
    }));

    expect(items).toHaveLength(1);
    expect(items[0]?.phase).toBe("failed");
    expect(items[0]?.title).toBe("Align ADE Code With Work Tab");
  });

  it("publishes a snoozed running chat as idle, even if a live run is still open", async () => {
    const snoozedUntil = "2126-07-10T00:00:00.000Z";
    const items = await buildAttentionItems(context({
      includeRoster: true,
      machineKey: "machine-1",
      nowMs: Date.parse("2026-08-12T00:00:00.000Z"),
      runs: new Map([["disk-session-1", run({
        sessionId: "disk-session-1",
        phase: "running",
        title: "ADE-121 Prototype",
      })]]),
      loadRoster: async () => [rosterProject({
        status: "running",
        title: "ADE-121 Prototype",
        snoozedUntil,
        snoozedAt: "2026-07-27T00:00:00.000Z",
      })],
    }));

    expect(items).toHaveLength(1);
    expect(items[0]?.phase).toBe("stale");
    expect(items[0]?.activityTier).toBe("idle");
    expect(items[0]?.title).toBe("ADE-121 Prototype");
  });
});
