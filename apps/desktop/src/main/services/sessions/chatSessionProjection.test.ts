import { describe, expect, it } from "vitest";
import type { AgentChatSessionSummary, TerminalSessionSummary } from "../../../shared/types";
import {
  listSessionsWithChatProjection,
  projectChatOntoSession,
  projectChatSummariesOntoSessions,
} from "./chatSessionProjection";

function session(): TerminalSessionSummary {
  return {
    id: "chat-1",
    laneId: "lane-1",
    laneName: "Planning state",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "codex-chat",
    title: "Planning state",
    status: "running",
    startedAt: "2026-08-01T10:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "/tmp/chat-1.jsonl",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "idle",
    resumeCommand: null,
  };
}

function chat(overrides: Partial<AgentChatSessionSummary> = {}): AgentChatSessionSummary {
  return {
    sessionId: "chat-1",
    laneId: "lane-1",
    provider: "codex",
    model: "openai/gpt-5.6-sol",
    status: "idle",
    startedAt: "2026-08-01T10:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-08-01T10:01:00.000Z",
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
    ...overrides,
  };
}

describe("chatSessionProjection", () => {
  it("carries the chat's provider account onto the terminal row", () => {
    expect(projectChatOntoSession(session(), chat({ instanceId: "acct-work" })).instanceId)
      .toBe("acct-work");
  });

  it("leaves the account absent when the chat is on the provider default", () => {
    expect(projectChatOntoSession(session(), chat()).instanceId).toBeUndefined();
    expect(projectChatOntoSession(session(), chat({ instanceId: "   " })).instanceId).toBeUndefined();
  });

  it("stamps provider_structured only when it can name the card", () => {
    const projected = projectChatOntoSession(session(), chat({ awaitingInput: true, pendingInputItemId: "item-7" }));
    expect(projected.pendingInputItemId).toBe("item-7");
    expect(projected.attentionSource).toBe("provider_structured");
  });

  it("never manufactures a Needs you with a null pending item id", () => {
    // `canonicalSessionState` treats `provider_structured` as a needs-you
    // trigger in its own right, so stamping it with no item id creates a card
    // that names nothing: there is no request to answer, and answering the one
    // that just settled cannot clear it. That is the stuck "Needs you".
    const projected = projectChatOntoSession(session(), chat({ awaitingInput: true }));
    expect(projected.pendingInputItemId).toBeNull();
    expect(projected.attentionSource).toBeUndefined();
  });

  it("leaves a non-structured attention source alone when there is no item id", () => {
    // An `ade chat ask` escalation is a different source and a different claim;
    // the projection must not overwrite it just because awaitingInput is set.
    const row = { ...session(), attentionSource: "agent_explicit" as const };
    const projected = projectChatOntoSession(row, chat({ awaitingInput: true }));
    expect(projected.attentionSource).toBe("agent_explicit");
  });

  it("projects current plan mode without changing idle chat lifecycle", () => {
    const projected = projectChatOntoSession(session(), chat({
      provider: "claude",
      interactionMode: "plan",
      permissionMode: "plan",
    }));

    expect(projected.chatActivityMode).toBe("planning");
    expect(projected.runtimeState).toBe("idle");
    expect(projected.activeBackgroundTaskCount).toBe(0);
  });

  it("projects Planning from exact provider-reported current modes", () => {
    const planningChats: Array<Partial<AgentChatSessionSummary>> = [
      { provider: "claude", interactionMode: "plan" },
      { provider: "codex", codexEffectiveCollaborationMode: "plan" },
      { provider: "cursor", cursorModeId: "plan" },
      { provider: "cursor", cursorModeId: "plan", cursorModeSnapshot: { currentModeId: "agent", availableModeIds: ["agent", "plan"] } },
      { provider: "cursor", cursorModeSnapshot: {
        currentModeId: "plan",
        availableModeIds: ["agent", "plan"],
      } },
      { provider: "droid", interactionMode: "plan" },
      { provider: "opencode", opencodePermissionMode: "plan" },
      { provider: "qwen", acpConfigSnapshot: { currentModeId: "plan" } },
      { provider: "kimi", acpConfigSnapshot: {
        configOptions: [{
          id: "mode",
          name: "Mode",
          type: "select",
          currentValue: "plan",
          options: [{ value: "default", label: "Default" }, { value: "plan", label: "Plan" }],
        }],
      } },
      { provider: "copilot", acpConfigSnapshot: {
        currentModeId: "https://agentclientprotocol.com/protocol/session-modes#plan",
      } },
    ];

    for (const currentMode of planningChats) {
      expect(projectChatOntoSession(session(), chat(currentMode)).chatActivityMode)
        .toBe("planning");
    }
  });

  it("does not infer Planning from legacy permission labels, available modes, or Grok", () => {
    const nonPlanningChats: Array<Partial<AgentChatSessionSummary>> = [
      { provider: "codex", permissionMode: "plan", interactionMode: "plan" },
      { provider: "codex", codexEffectiveCollaborationMode: "default", permissionMode: "plan" },
      {
        provider: "codex",
        codexConfigSource: "flags",
        codexApprovalPolicy: "on-request",
        codexSandbox: "read-only",
      },
      {
        provider: "codex",
        codexConfigSource: "config-toml",
        codexApprovalPolicy: "on-request",
        codexSandbox: "read-only",
      },
      { provider: "cursor", cursorModeId: "agent", interactionMode: "plan" },
      { provider: "cursor", cursorModeId: "agent", cursorModeSnapshot: { currentModeId: "plan", availableModeIds: ["agent", "plan"] } },
      { provider: "cursor", cursorModeId: null, cursorModeSnapshot: { currentModeId: "plan", availableModeIds: ["agent", "plan"] } },
      { provider: "cursor", cursorModeIdWasCleared: true, cursorModeSnapshot: { currentModeId: "plan", availableModeIds: ["agent", "plan"] } },
      { provider: "droid", droidPermissionMode: "read-only" },
      { provider: "droid", permissionMode: "plan" },
      { provider: "opencode", permissionMode: "plan", interactionMode: "plan" },
      { provider: "qwen", acpConfigSnapshot: {
        currentModeId: "default",
        availableModeIds: ["default", "plan"],
      } },
      { provider: "kimi", acpConfigSnapshot: {
        configOptions: [{ id: "mode", name: "Mode", type: "boolean", currentValue: true }],
      } },
      { provider: "grok", acpConfigSnapshot: { currentModeId: "plan" } },
    ];

    for (const currentMode of nonPlanningChats) {
      expect(projectChatOntoSession(session(), chat(currentMode)).chatActivityMode)
        .toBeNull();
    }
  });

  it("projects authoritative background count and the next armed wake", () => {
    const projected = projectChatOntoSession(session(), chat({
      activeBackgroundTaskCount: 2,
      nextWakeAt: "2026-08-01T12:00:00.000Z",
    }));

    expect(projected.activeBackgroundTaskCount).toBe(2);
    expect(projected.nextWakeAt).toBe("2026-08-01T12:00:00.000Z");
    expect(projected.runtimeState).toBe("idle");
  });

  it("clears stale presentation metadata when the chat reports normal mode and no tasks", () => {
    const projected = projectChatOntoSession({
      ...session(),
      chatActivityMode: "planning",
      activeBackgroundTaskCount: 3,
    }, chat({
      interactionMode: "default",
      permissionMode: "default",
      activeBackgroundTaskCount: 0,
    }));

    expect(projected.chatActivityMode).toBeNull();
    expect(projected.activeBackgroundTaskCount).toBe(0);
    expect(projected.nextWakeAt).toBeNull();
  });

  it("does not mistake a read-only legacy permission projection for plan interaction mode", () => {
    const projected = projectChatOntoSession(session(), chat({
      interactionMode: "default",
      permissionMode: "plan",
    }));

    expect(projected.chatActivityMode).toBeNull();
    expect(projected.runtimeState).toBe("idle");
    expect(projected.activeBackgroundTaskCount).toBe(0);
  });

  it("copies chat lastActivityAt, cursorCloudAgentId, and cursorRuntime onto the Work row", () => {
    const projected = projectChatOntoSession(session(), chat({
      lastActivityAt: "2026-08-13T20:26:10.000Z",
      cursorCloudAgentId: "bc-cloud-agent",
      cursorRuntime: "local",
    }));

    expect(projected.lastActivityAt).toBe("2026-08-13T20:26:10.000Z");
    expect(projected.cursorCloudAgentId).toBe("bc-cloud-agent");
    expect(projected.cursorRuntime).toBe("local");
  });

  it("clears the parked deadline when the chat has none", () => {
    const projected = projectChatOntoSession({
      ...session(),
      usageLimitParkedUntil: "2026-08-17T12:47:00.000Z",
    }, chat({
      usageLimitParkedUntil: null,
    }));

    expect(projected.usageLimitParkedUntil ?? null).toBeNull();
  });

  it("keeps Codex steering live on an active chat without Needs you", () => {
    const projected = projectChatOntoSession(session(), chat({
      status: "active",
      awaitingInput: false,
      steeringInput: true,
    }));

    expect(projected.runtimeState).toBe("running");
    expect(projected.pendingInputItemId).toBeNull();
    expect(projected.steeringInput).toBe(true);
  });

  it("reads a sent chat whose turn has not started yet as running from the acceptance", () => {
    const projected = projectChatOntoSession(session(), chat({
      status: "idle",
      turnAcceptedAt: "2026-08-01T10:00:30.000Z",
    }));

    expect(projected.runtimeState).toBe("running");
    expect(projected.currentTurnStartedAt).toBe("2026-08-01T10:00:30.000Z");
  });

  it("projects model handoff history onto the Work row", () => {
    const projected = projectChatOntoSession(session(), chat({
      modelHandoffHistory: [{
        fromProvider: "claude",
        toProvider: "codex",
        fromModelId: "anthropic/claude-sonnet-5",
        toModelId: "openai/gpt-5.4",
      }],
    }));

    expect(projected.modelHandoffHistory).toEqual([{
      fromProvider: "claude",
      toProvider: "codex",
      fromModelId: "anthropic/claude-sonnet-5",
      toModelId: "openai/gpt-5.4",
    }]);
  });
});

describe("chatSessionProjection — identity lineage (U8)", () => {
  /** A terminal row for a spawned chat. Lineage lives on the CHAT summary, not
   *  here — the terminal row is what the projection writes onto. */
  function child(id: string): TerminalSessionSummary {
    return { ...session(), id, title: id };
  }

  it("stamps parentIdentityKey on a child whose spawn parent is the CTO", () => {
    const sessions = [
      { ...session(), id: "cto-session", title: "CTO" },
      child("child-of-cto"),
      child("child-of-chat"),
      { ...session(), id: "plain-chat", title: "Plain chat" },
    ];
    const chats: AgentChatSessionSummary[] = [
      chat({ sessionId: "cto-session", identityKey: "cto" }),
      chat({ sessionId: "plain-chat" }),
      chat({ sessionId: "child-of-cto", orchestrationParentSessionId: "cto-session", spawnKind: "subagent" }),
      chat({ sessionId: "child-of-chat", orchestrationParentSessionId: "plain-chat", spawnKind: "subagent" }),
    ];

    const projected = projectChatSummariesOntoSessions(sessions, chats);
    const byId = new Map(projected.map((s) => [s.id, s]));

    // The identity row itself is still filtered out of the roster — that is
    // precisely why the child has to be told who its parent is.
    expect(byId.has("cto-session")).toBe(false);
    expect(byId.get("child-of-cto")?.parentIdentityKey).toBe("cto");
    // An ordinary chat parent stamps nothing: absent is the single no-op value.
    expect("parentIdentityKey" in (byId.get("child-of-chat") ?? {})).toBe(false);
    expect("parentIdentityKey" in (byId.get("plain-chat") ?? {})).toBe(false);
  });

  it("stamps nothing when the parent is not in the projected chat set", () => {
    // A reparented or deleted parent must not leave a stale CTO claim behind.
    const projected = projectChatSummariesOntoSessions(
      [child("orphan")],
      [chat({ sessionId: "orphan", orchestrationParentSessionId: "gone" })],
    );
    expect("parentIdentityKey" in (projected[0] ?? {})).toBe(false);
  });

  it("never stamps the key without a parent id", () => {
    // The field is a claim ABOUT a parent; the two travel together or not at all.
    const projected = projectChatOntoSession(session(), chat(), "cto");
    expect("parentIdentityKey" in projected).toBe(false);
  });
});

describe("chatSessionProjection — model", () => {
  it("projects the model and canonical id onto the terminal row", () => {
    const projected = projectChatOntoSession(session(), chat({
      model: "openai/gpt-5.6-sol",
      modelId: "openai/gpt-5.6-sol",
    }));
    expect(projected.model).toBe("openai/gpt-5.6-sol");
    expect(projected.modelId).toBe("openai/gpt-5.6-sol");
  });

  it("leaves both absent when the provider reported nothing usable", () => {
    // "We do not know" and "no model" have to be the SAME value on the row, or
    // every display site has to re-test for an empty string.
    const blank = projectChatOntoSession(session(), chat({ model: "   " }));
    expect("model" in blank).toBe(false);
    expect("modelId" in blank).toBe(false);
  });

  it("trims a padded model ref rather than passing the padding on", () => {
    const projected = projectChatOntoSession(session(), chat({ model: "  claude-opus-5  " }));
    expect(projected.model).toBe("claude-opus-5");
  });
});

describe("listSessionsWithChatProjection — summarizes only what the page shows", () => {
  /**
   * A chat service that, like the real one, filters lists by lane and summarizes
   * only the ids it is asked for. `getSessionSummary` and `getSessionIdentityKey`
   * read by id from every chat. `outsideWindow` ids are chats the list does not
   * return (older than its newest-chats window), but a read by id still finds them.
   */
  function chatService(allChats: AgentChatSessionSummary[], outsideWindow: readonly string[] = []) {
    const calls: Array<readonly string[] | undefined> = [];
    const parentReads: string[] = [];
    const identityReads: string[] = [];
    const windowed = new Set(outsideWindow);
    return {
      calls,
      parentReads,
      identityReads,
      service: {
        listSessions: async (laneId?: string, options?: { sessionIds?: readonly string[] }) => {
          calls.push(options?.sessionIds);
          const named = options?.sessionIds ? new Set(options.sessionIds) : null;
          return allChats.filter((summary) =>
            (!laneId || summary.laneId === laneId)
            && (!named || named.has(summary.sessionId))
            && !windowed.has(summary.sessionId));
        },
        getSessionSummary: async (sessionId: string) => {
          parentReads.push(sessionId);
          return allChats.find((summary) => summary.sessionId === sessionId) ?? null;
        },
        getSessionIdentityKey: async (sessionId: string) => {
          identityReads.push(sessionId);
          return allChats.find((summary) => summary.sessionId === sessionId)?.identityKey ?? null;
        },
      },
    };
  }

  async function run(sessions: TerminalSessionSummary[], allChats: AgentChatSessionSummary[]) {
    const chats = chatService(allChats);
    const rows = await listSessionsWithChatProjection(
      {
        sessionService: { list: () => sessions, get: () => null },
        ptyService: null,
        agentChatService: chats.service,
        logger: { warn: () => {} },
      },
      { limit: 500 },
    );
    return { calls: chats.calls, parentReads: chats.parentReads, rows };
  }

  it("summarizes the chats on the page and nothing else", async () => {
    const shell: TerminalSessionSummary = { ...session(), id: "shell-1", toolType: "shell" };
    const { calls } = await run(
      [{ ...session(), id: "chat-a", title: "A" }, shell, { ...session(), id: "chat-b", title: "B" }],
      [chat({ sessionId: "chat-a" }), chat({ sessionId: "chat-b" }), chat({ sessionId: "chat-off-page" })],
    );
    expect(calls).toEqual([["chat-a", "chat-b"]]);
  });

  it("reads a listed child's spawn parent by id when the parent sits outside the page", async () => {
    const { calls, parentReads, rows } = await run(
      [{ ...session(), id: "child", title: "Child" }],
      [
        chat({ sessionId: "cto-session", identityKey: "cto" }),
        chat({ sessionId: "child", orchestrationParentSessionId: "cto-session", spawnKind: "subagent" }),
      ],
    );
    expect(calls).toEqual([["child"]]);
    expect(parentReads).toEqual(["cto-session"]);
    expect(rows.map((row) => row.id)).toEqual(["child"]);
    expect(rows[0]?.parentIdentityKey).toBe("cto");
  });

  it("reads no parent when every parent is already on the page", async () => {
    const { calls, parentReads } = await run(
      [{ ...session(), id: "cto-session", title: "CTO" }, { ...session(), id: "child", title: "Child" }],
      [
        chat({ sessionId: "cto-session", identityKey: "cto" }),
        chat({ sessionId: "child", orchestrationParentSessionId: "cto-session", spawnKind: "subagent" }),
      ],
    );
    expect(calls).toEqual([["cto-session", "child"]]);
    expect(parentReads).toEqual([]);
  });

  it("keeps the CTO marker on a child listed on a lane page whose CTO sits in another lane", async () => {
    // The page lists its chats by lane. The parent is read by id, so the lane
    // filter does not drop a CTO that lives in another lane.
    const chats = chatService([
      chat({ sessionId: "cto-session", laneId: "lane-1", identityKey: "cto" }),
      chat({
        sessionId: "child",
        laneId: "lane-2",
        orchestrationParentSessionId: "cto-session",
        spawnKind: "subagent",
      }),
    ]);
    const rows = await listSessionsWithChatProjection(
      {
        sessionService: {
          list: () => [{ ...session(), id: "child", laneId: "lane-2", title: "Child" }],
          get: () => null,
        },
        ptyService: null,
        agentChatService: chats.service,
        logger: { warn: () => {} },
      },
      { laneId: "lane-2", limit: 200 },
    );
    expect(rows.map((row) => row.id)).toEqual(["child"]);
    expect(rows[0]?.parentIdentityKey).toBe("cto");
    expect(chats.parentReads).toEqual(["cto-session"]);
  });

  it("reads a CTO that is on the page but older than the list window, so the child keeps its marker", async () => {
    // The CTO row is on the page, yet the list did not return it. It is read by
    // id, so it is hidden as an identity row and its child keeps the marker.
    const chats = chatService(
      [
        chat({ sessionId: "cto-session", identityKey: "cto" }),
        chat({ sessionId: "child", orchestrationParentSessionId: "cto-session", spawnKind: "subagent" }),
      ],
      ["cto-session"],
    );
    const rows = await listSessionsWithChatProjection(
      {
        sessionService: {
          list: () => [
            { ...session(), id: "cto-session", title: "CTO" },
            { ...session(), id: "child", title: "Child" },
          ],
          get: () => null,
        },
        ptyService: null,
        agentChatService: chats.service,
        logger: { warn: () => {} },
      },
      { limit: 500 },
    );
    expect(rows.map((row) => row.id)).toEqual(["child"]);
    expect(rows[0]?.parentIdentityKey).toBe("cto");
    expect(chats.parentReads).toEqual(["cto-session"]);
  });

  it("hides an old CTO on the page that no listed child names, as it hides an in-window one", async () => {
    // Nothing on the page points at this CTO, so no child read finds it. The list
    // did not return it (it is older than the window), but it is on the page, so it
    // is read by id and filtered out as an identity row instead of shown as a chat.
    const chats = chatService(
      [
        chat({ sessionId: "cto-old", identityKey: "cto" }),
        chat({ sessionId: "chat-b" }),
      ],
      ["cto-old"],
    );
    const rows = await listSessionsWithChatProjection(
      {
        sessionService: {
          list: () => [
            { ...session(), id: "cto-old", title: "CTO" },
            { ...session(), id: "chat-b", title: "B" },
          ],
          get: () => null,
        },
        ptyService: null,
        agentChatService: chats.service,
        logger: { warn: () => {} },
      },
      { limit: 500 },
    );
    expect(rows.map((row) => row.id)).toEqual(["chat-b"]);
    expect(chats.parentReads).toEqual(["cto-old"]);
  });

  it("reads an identity chat outside the window only when the page lists it", async () => {
    // A CTO the window missed and the page does not list is not read at all: the
    // identity read is bounded to the ids on the returned page.
    const chats = chatService(
      [
        chat({ sessionId: "cto-old", identityKey: "cto" }),
        chat({ sessionId: "cto-off-page", identityKey: "cto" }),
        chat({ sessionId: "chat-b" }),
      ],
      ["cto-old", "cto-off-page"],
    );
    const rows = await listSessionsWithChatProjection(
      {
        sessionService: {
          list: () => [
            { ...session(), id: "cto-old", title: "CTO" },
            { ...session(), id: "chat-b", title: "B" },
          ],
          get: () => null,
        },
        ptyService: null,
        agentChatService: chats.service,
        logger: { warn: () => {} },
      },
      { limit: 500 },
    );
    expect(rows.map((row) => row.id)).toEqual(["chat-b"]);
    expect(chats.identityReads).toEqual(["cto-old"]);
    expect(chats.parentReads).toEqual(["cto-old"]);
  });

  it("checks an out-of-window page chat for identity without summarizing it, and keeps its row", async () => {
    // Not an identity row, so the page keeps the row it had before: it is not
    // summarized, and nothing else about it is read.
    const chats = chatService(
      [chat({ sessionId: "chat-old" }), chat({ sessionId: "chat-b" })],
      ["chat-old"],
    );
    const rows = await listSessionsWithChatProjection(
      {
        sessionService: {
          list: () => [
            { ...session(), id: "chat-old", title: "Old" },
            { ...session(), id: "chat-b", title: "B" },
          ],
          get: () => null,
        },
        ptyService: null,
        agentChatService: chats.service,
        logger: { warn: () => {} },
      },
      { limit: 500 },
    );
    expect(rows.map((row) => row.id)).toEqual(["chat-old", "chat-b"]);
    expect(chats.identityReads).toEqual(["chat-old"]);
    expect(chats.parentReads).toEqual([]);
  });
});
