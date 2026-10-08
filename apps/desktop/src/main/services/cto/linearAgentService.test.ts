import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinearAgentService, describeToolCall, type LinearAgentServiceDeps } from "./linearAgentService";

function serviceHarness(sessions: Record<string, unknown>[] = []) {
  let hooks: Parameters<LinearAgentServiceDeps["automation"]["setLinearAgentHooks"]>[0] = null;
  const relay = {
    claimSession: vi.fn(async () => ({ claimed: true, claimedByMachineId: "machine-1" })),
    postActivity: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ ok: true })),
    updateSession: vi.fn(async () => undefined),
    startWork: vi.fn(async () => undefined),
  };
  const automation = {
    dispatchIngressTrigger: vi.fn(async () => ({ status: "started" })),
    hasMatchingLinearAgentRule: vi.fn(() => true),
    setLinearAgentHooks: vi.fn((next) => { hooks = next; }),
    listAgentRules: vi.fn(() => []),
  };
  const chat = {
    sendMessage: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    respondToInput: vi.fn(async () => undefined),
    getAvailableModels: vi.fn(async () => []),
  };
  const deps = {
    relay,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    machine: { id: "machine-1", name: "Mac" },
    getAccountId: () => "account-1",
    kv: {
      getJson: () => sessions,
      setJson: vi.fn(),
    },
    automation,
    chat,
    lanes: {
      createLaneForIssue: vi.fn(async () => "lane-1"),
      attachIssueToSession: vi.fn(async () => undefined),
      getLaneName: vi.fn(async () => "ADE-123"),
    },
    fetchIssue: vi.fn(async () => null),
  } as unknown as LinearAgentServiceDeps;
  return { service: createLinearAgentService(deps), relay, automation, chat, deps, get hooks() { return hooks; } };
}

function ingressEvent(args: { routedAccountId?: string | null; createdAt?: string; action?: string; payload?: Record<string, unknown> }) {
  return {
    id: "event-1",
    source: "relay" as const,
    deliveryId: "delivery-1",
    eventId: "event-1",
    kind: "AgentSessionEvent",
    entityType: "AgentSession",
    action: args.action ?? "created",
    issueId: "issue-1",
    issueIdentifier: "ADE-123",
    summary: "ADE-123: Linear agent",
    payload: args.payload ?? {
      agentSession: {
        id: "agent-session-1",
        createdAt: args.createdAt ?? "2026-09-30T11:59:00.000Z",
        creator: { id: "creator-1", displayName: "Ada" },
        issue: { id: "issue-1", identifier: "ADE-123", title: "Linear agent" },
      },
    },
    createdAt: args.createdAt ?? "2026-09-30T11:59:00.000Z",
    routedAccountId: args.routedAccountId === undefined ? "account-1" : args.routedAccountId,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Linear agent service", () => {
  it.each([
    ["old backlog sessions", "account-1", "2026-09-30T11:40:00.000Z"],
    ["sessions routed to another account", "account-2", "2026-09-30T11:59:00.000Z"],
  ])("does not claim or launch %s", async (_case, routedAccountId, createdAt) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    const harness = serviceHarness();

    await harness.service.handleEvent(ingressEvent({ routedAccountId, createdAt }));

    expect(harness.relay.claimSession).not.toHaveBeenCalled();
    expect(harness.automation.dispatchIngressTrigger).not.toHaveBeenCalled();
    expect(harness.deps.fetchIssue).not.toHaveBeenCalled();
    harness.service.dispose();
  });

  it("lets only the session creator direct it and preserves unclear approval replies as chat text", async () => {
    const harness = serviceHarness([{
      agentSessionId: "agent-session-1",
      chatSessionId: "chat-1",
      laneId: "lane-1",
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "ADE-123",
      creatorId: "creator-1",
      startedAt: "2026-09-30T11:00:00.000Z",
      pendingInput: { itemId: "approval-1", kind: "approval", questionId: null, options: [{ label: "Allow", value: "accept" }, { label: "Deny", value: "decline" }] },
    }]);
    const reply = (userId: string, body = "maybe") => ingressEvent({
      action: "prompted",
      payload: {
        agentSession: { id: "agent-session-1", creator: { id: "creator-1", displayName: "Ada" } },
        agentActivity: { userId, content: { body } },
      },
    });

    await harness.service.handleEvent(reply("teammate-2"));
    expect(harness.chat.respondToInput).not.toHaveBeenCalled();
    expect(harness.chat.sendMessage).not.toHaveBeenCalled();
    expect(harness.relay.postActivity).toHaveBeenCalledWith("agent-session-1", expect.objectContaining({ type: "thought" }), undefined);

    await harness.service.handleEvent(reply("creator-1"));
    expect(harness.chat.respondToInput).not.toHaveBeenCalled();
    expect(harness.chat.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "chat-1",
      text: expect.stringContaining("maybe"),
      displayText: "maybe",
    }));

    await harness.service.handleEvent(reply("creator-1", "Allow"));
    expect(harness.chat.respondToInput).toHaveBeenCalledWith({ sessionId: "chat-1", itemId: "approval-1", decision: "accept" });
    harness.service.dispose();
  });

  // A reply to a question card is the creator answering it; downstream, a
  // response with no decision reads as a decline.
  it("answers a pending question card with the creator's reply as an accepted answer", async () => {
    const harness = serviceHarness([{
      agentSessionId: "agent-session-1",
      chatSessionId: "chat-1",
      laneId: "lane-1",
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "ADE-123",
      creatorId: "creator-1",
      startedAt: "2026-09-30T11:00:00.000Z",
      pendingInput: { itemId: "question-1", kind: "question", questionId: "scope", options: [{ label: "UI flow", value: "ui" }] },
    }]);

    await harness.service.handleEvent(ingressEvent({
      action: "prompted",
      payload: {
        agentSession: { id: "agent-session-1", creator: { id: "creator-1", displayName: "Ada" } },
        agentActivity: { userId: "creator-1", content: { body: "ui flow" } },
      },
    }));

    expect(harness.chat.respondToInput).toHaveBeenCalledWith({
      sessionId: "chat-1",
      itemId: "question-1",
      decision: "accept",
      answers: { scope: "ui" },
    });
    expect(harness.chat.sendMessage).not.toHaveBeenCalled();
    harness.service.dispose();
  });

  it("maps chat approvals and completion to Linear activities", () => {
    const harness = serviceHarness([{
      agentSessionId: "agent-session-1",
      chatSessionId: "chat-1",
      laneId: "lane-1",
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "ADE-123",
      creatorId: "creator-1",
      startedAt: "2026-09-30T11:00:00.000Z",
      pendingInput: null,
    }]);

    harness.service.onChatEvent({ sessionId: "chat-1", event: {
      type: "approval_request",
      itemId: "approval-1",
      description: "Run the requested command?",
    } } as never);
    expect(harness.relay.postActivity).toHaveBeenCalledWith("agent-session-1", expect.objectContaining({
      type: "elicitation",
      signal: "select",
      signalMetadata: { options: [{ label: "Allow", value: "accept" }, { label: "Deny", value: "decline" }] },
    }), undefined);

    harness.service.onChatEvent({ sessionId: "chat-1", event: { type: "done", status: "completed" } } as never);
    expect(harness.relay.postActivity).toHaveBeenLastCalledWith("agent-session-1", { type: "response", body: "Done." }, undefined);
    harness.service.dispose();
  });
});

describe("Linear agent step lines", () => {
  const chatSession = [{
    agentSessionId: "agent-session-1",
    chatSessionId: "chat-1",
    laneId: "lane-1",
    runId: "run-1",
    issueId: "issue-1",
    issueIdentifier: "ADE-123",
    creatorId: "creator-1",
    startedAt: "2026-09-30T11:00:00.000Z",
    pendingInput: null,
  }];
  const postedSteps = (harness: ReturnType<typeof serviceHarness>): unknown[] =>
    (harness.relay.postActivity.mock.calls as unknown[][])
      .map((call) => call[1])
      .filter((body) => (body as { type?: string }).type === "action");

  it.each([
    ["a bare command after a cd into the lane", "cd /Users/admin/Projects/ADE/.ade/worktrees/lane-1 && npm test", "npm test"],
    ["a Codex bash -lc wrapper", "/bin/zsh -lc 'cd /Users/admin/Projects/ADE/.ade/worktrees/lane-1 && git status'", "git status"],
    ["a PowerShell -Command wrapper", "powershell.exe -NoProfile -Command \"cd 'C:\\Users\\me\\.ade\\worktrees\\lane-1'; npm test\"", "npm test"],
    ["a cmd /c wrapper", "cmd /c \"cd C:\\Users\\me\\.ade\\worktrees\\lane-1 && npm test\"", "npm test"],
  ])("shows the command itself for %s", (_label, command, parameter) => {
    expect(describeToolCall("Bash", { command })).toEqual({ action: "Ran", parameter });
  });

  it("names a bare cd by the tool's own description, and an edit by its path inside the lane", () => {
    expect(describeToolCall("Bash", { command: "cd /Users/admin/.ade/worktrees/lane-1", description: "Enter the lane" }))
      .toEqual({ action: "Ran", parameter: "Enter the lane" });
    expect(describeToolCall("Edit", { file_path: "C:\\Users\\me\\.ade\\worktrees\\lane-1\\src\\main.ts" }))
      .toEqual({ action: "Edited", parameter: "src\\main.ts" });
  });

  it("posts each command the agent ran, and skips the user's own ! shell runs", () => {
    const harness = serviceHarness(chatSession);
    harness.service.onChatEvent({ sessionId: "chat-1", event: {
      type: "command", command: "npm test", cwd: "/lane", output: "", itemId: "cmd-1", status: "running",
    } } as never);
    harness.service.onChatEvent({ sessionId: "chat-1", event: {
      type: "command", command: "ls ~", cwd: "/lane", output: "", itemId: "cmd-2", status: "completed", source: "userShell",
    } } as never);
    expect(postedSteps(harness)).toEqual([{ type: "action", action: "Ran", parameter: "npm test" }]);
    harness.service.dispose();
  });

  it("keeps every file of one Codex file-change item", () => {
    const harness = serviceHarness(chatSession);
    for (const path of ["/Users/admin/.ade/worktrees/lane-1/src/a.ts", "/Users/admin/.ade/worktrees/lane-1/src/b.ts"]) {
      harness.service.onChatEvent({ sessionId: "chat-1", event: {
        type: "file_change", path, diff: "", kind: "modify", itemId: "patch-1", status: "completed",
      } } as never);
    }
    expect(postedSteps(harness)).toEqual([
      { type: "action", action: "Edited", parameter: "src/a.ts" },
      { type: "action", action: "Edited", parameter: "src/b.ts" },
    ]);
    harness.service.dispose();
  });
});
