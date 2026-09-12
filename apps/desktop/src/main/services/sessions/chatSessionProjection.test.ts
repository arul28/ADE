import { describe, expect, it } from "vitest";
import type { AgentChatSessionSummary, TerminalSessionSummary } from "../../../shared/types";
import {
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
      interactionMode: "plan",
      permissionMode: "plan",
    }));

    expect(projected.chatActivityMode).toBe("planning");
    expect(projected.runtimeState).toBe("idle");
    expect(projected.activeBackgroundTaskCount).toBe(0);
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

  it("copies chat lastActivityAt and cursorCloudAgentId onto the Work row", () => {
    const projected = projectChatOntoSession(session(), chat({
      lastActivityAt: "2026-08-13T20:26:10.000Z",
      cursorCloudAgentId: "bc-cloud-agent",
    }));

    expect(projected.lastActivityAt).toBe("2026-08-13T20:26:10.000Z");
    expect(projected.cursorCloudAgentId).toBe("bc-cloud-agent");
  });

  it("clears a parked usage-limit deadline when the chat no longer has one", () => {
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

  it("stamps parentIdentityKey on a child whose orchestration parent is the CTO", () => {
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
