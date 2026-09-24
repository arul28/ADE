import {
  AgentChatCreateArgs,
  AgentChatEventEnvelope,
  buildCodingAgentSystemPrompt,
  createAgentChatService,
  createService,
  cursorModelsListMock,
  fs,
  mockState,
  parkCursorSend,
  path,
  probeCursorSdkModelDiscovery,
  readPersistedChatState,
  releaseCursorSdkConnection,
  tmpRoot,
  waitFor,
  waitForCondition,
  waitForEvent,
  waitForSessionTitle,
  writePersistedChatState,
} from "./agentChatServiceTestFixture";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  it("returns a failed Cursor Task transcript by call id when no agent id exists", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Delegate the failing check.",
    }, { awaitDispatch: true });
    mockState.cursorSdkPooled.bridge.onEvent({
      type: "tool_call",
      call_id: "task-call-failed",
      name: "task",
      status: "running",
      args: { description: "Inspect the failing check" },
    });
    mockState.cursorSdkPooled.bridge.onEvent({
      type: "tool_call",
      call_id: "task-call-failed",
      name: "task",
      status: "error",
      args: { description: "Inspect the failing check" },
      result: {
        status: "error",
        error: { message: "Child agent could not start" },
      },
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "subagent_result"
        && event.event.taskId === "task-call-failed"
        && event.event.status === "failed",
    );

    const transcript = await service.getSubagentTranscript({
      sessionId: session.id,
      agentId: "task-call-failed",
    });

    expect(transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.objectContaining({
          type: "subagent_started",
          taskId: "task-call-failed",
        }),
      }),
      expect.objectContaining({
        text: "Child agent could not start",
        message: expect.objectContaining({
          type: "subagent_result",
          taskId: "task-call-failed",
          status: "failed",
        }),
      }),
    ]));
  });

  it("ends a stored-login Cursor turn without asking getUsage; an API-key turn still asks", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
    });
    const runTurn = async (text: string) => {
      const doneCount = events.filter((event) => event.event.type === "done").length;
      await service.sendMessage({ sessionId: session.id, text }, { awaitDispatch: true });
      await waitForCondition(
        () => events.filter((event) => event.event.type === "done").length > doneCount,
        "Cursor turn done",
      );
    };
    const usageRequests = () => mockState.cursorSdkCloudRequests.filter((r) => r.type === "agent.getUsage");

    await runTurn("With a key.");
    expect(usageRequests()).toHaveLength(1);

    // The worker keeps running on the stored login once no key is configured.
    delete process.env.CURSOR_API_KEY;
    await runTurn("Stored login.");
    await runTurn("Stored login again.");
    expect(usageRequests()).toHaveLength(1);
  });

  it("renders Cursor SDK private plan control blocks without exposing them as chat text", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Plan this.",
    }, { awaitDispatch: true });

    mockState.cursorSdkPooled.bridge.onEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: [
            "```ade_update_plan",
            "{\"steps\":[{\"text\":\"Inspect current chat wiring\",\"status\":\"completed\"},{\"text\":\"Render ADE plan UI\",\"status\":\"in_progress\"}],\"explanation\":\"Cursor SDK should use ADE-native planning UI.\"}",
            "```",
          ].join("\n"),
        }],
      },
    });

    expect(events.some((event) =>
      event.event.type === "plan"
      && event.event.steps[1]?.text === "Render ADE plan UI"
    )).toBe(true);
    expect(events.some((event) =>
      event.event.type === "text"
      && event.event.text.includes("ade_update_plan")
    )).toBe(false);
  });

  it("does not pass ADE default titles as Cursor SDK agent names", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Run locally.",
    }, { awaitDispatch: true });

    expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(
      expect.objectContaining({ agentName: null }),
    );
  });

  it("passes only manual titles as Cursor SDK agent names", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
    });
    await service.updateSession({
      sessionId: session.id,
      title: "Manual Cursor Title",
      manuallyNamed: true,
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Run locally.",
    }, { awaitDispatch: true });

    expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(
      expect.objectContaining({ agentName: "Manual Cursor Title" }),
    );
  });

  it("buffers streamed Cursor SDK control blocks before rendering ADE plan UI", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Plan this.",
    }, { awaitDispatch: true });

    mockState.cursorSdkPooled.bridge.onEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: "```ade_",
        }],
      },
    });
    mockState.cursorSdkPooled.bridge.onEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: "update_plan{\"steps\":[{\"text\":\"Buffered Cursor plan\",\"status\":\"in_progress\"}],\"explanation\":\"No raw controls should leak.\"}```",
        }],
      },
    });

    expect(events.some((event) =>
      event.event.type === "plan"
      && event.event.steps[0]?.text === "Buffered Cursor plan"
    )).toBe(true);
    expect(events.some((event) =>
      event.event.type === "text"
      && (event.event.text.includes("ade_update_plan") || event.event.text.includes("```ade_"))
    )).toBe(false);
  });

  it("drops malformed Cursor SDK control blocks without crashing or leaking raw text", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Plan this.",
    }, { awaitDispatch: true });

    expect(() => {
      mockState.cursorSdkPooled.bridge.onEvent({
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: "Before ```ade_update_plan{\"steps\":[``` after",
          }],
        },
      });
    }).not.toThrow();

    expect(events.some((event) =>
      event.event.type === "text"
      && (event.event.text.includes("ade_update_plan") || event.event.text.includes("```ade_"))
    )).toBe(false);
  });

  it("preserves Cursor SDK text chunk spacing while parsing private controls", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Plan this.",
    }, { awaitDispatch: true });

    for (const text of ["Publishing", " a short", " demo", " plan."]) {
      mockState.cursorSdkPooled.bridge.onEvent({
        type: "assistant",
        message: {
          content: [{ type: "text", text }],
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    const streamedText = events
      .filter((event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "text" }>;
      } => event.event.type === "text")
      .map((event) => event.event.text)
      .join("");
    expect(streamedText).toContain("Publishing a short demo plan.");
  });

  it("uses Cursor SDK private question control blocks for ADE pending input", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Make a plan.",
    }, { awaitDispatch: true });

    mockState.cursorSdkPooled.bridge.onEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: [
            "```ade_request_user_input",
            "{\"title\":\"Plan question\",\"questions\":[{\"id\":\"scope\",\"header\":\"Scope\",\"question\":\"Which scope should I plan around?\",\"options\":[{\"label\":\"UI flow\"},{\"label\":\"Backend flow\"}],\"allowsFreeform\":true}]}",
            "```",
          ].join("\n"),
        }],
      },
    });

    const questionEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? event.event.detail as { request?: { title?: string; kind?: string } } | undefined
          : undefined;
        return event.event.type === "approval_request"
          && detail?.request?.title === "Plan question"
          && detail.request.kind === "structured_question";
      },
    );

    const sendCallCountBeforeAnswer = mockState.cursorSdkSendCalls.length;
    await service.respondToInput({
      sessionId: session.id,
      itemId: questionEvent.event.itemId,
      decision: "accept",
      answers: { scope: ["UI flow"] },
      responseText: "UI flow",
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (mockState.cursorSdkSendCalls.length > sendCallCountBeforeAnswer) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(mockState.cursorSdkSendCalls.length).toBeGreaterThan(sendCallCountBeforeAnswer);
    expect(mockState.cursorSdkSendCalls.at(-1)?.promptText).toEqual(
      expect.stringContaining("The user answered the Cursor planning question"),
    );
    expect(events.some((event) =>
      event.event.type === "user_message"
      && event.event.text.includes("The user answered the Cursor planning question")
    )).toBe(false);
  });

  it("keeps Cursor SDK approvals live when preview persistence fails", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service, sessionService, logger } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "agent",
    });

    const previewError = new Error("database is not open");
    vi.mocked(sessionService.setLastOutputPreview).mockImplementation(() => {
      throw previewError;
    });

    const releaseGate = parkCursorSend();

    const pendingTurn = service.sendMessage({
      sessionId: session.id,
      text: "Run a command that needs approval.",
    }, { awaitDispatch: true });

    try {
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBe(1);
      });

      expect(() => {
        mockState.cursorSdkPooled.bridge.onEvent({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "I need to inspect the lane." }],
          },
        });
      }).not.toThrow();

      const hookResponse = mockState.cursorSdkPooled.bridge.onHookRequest({
        id: "cursor-hook-preview-failure",
        toolName: "shell",
        title: "Run shell command",
        summary: "Run git status",
        cwd: tmpRoot,
        raw: { command: "git status --short" },
        toolInput: { command: "git status --short" },
        risk: "shell",
      });

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && event.event.itemId === "cursor-hook-preview-failure",
      );

      expect(service.listPendingInputs({ sessionId: session.id }).requests).toEqual([
        expect.objectContaining({
          itemId: "cursor-hook-preview-failure",
          source: "cursor",
          kind: "permissions",
          blocking: true,
          providerMetadata: expect.objectContaining({ cursorSdk: true, toolName: "shell" }),
        }),
      ]);

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept_for_session",
      });

      await expect(hookResponse).resolves.toEqual({ permission: "allow" });
      expect(service.listPendingInputs({ sessionId: session.id }).requests).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.preview_update_failed",
        expect.objectContaining({
          sessionId: session.id,
          error: "database is not open",
        }),
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        "agent_chat.approval_without_live_runtime",
        expect.anything(),
      );
      expect(releaseCursorSdkConnection).not.toHaveBeenCalled();
    } finally {
      releaseGate();
      await pendingTurn;
    }
  });

  it("exits Cursor SDK plan mode through ADE plan approval control blocks", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Make a plan.",
    }, { awaitDispatch: true });

    mockState.cursorSdkPooled.bridge.onEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: [
            "```ade_plan_approval{\"planDescription\":\"1. Inspect wiring\\n2. Patch Cursor controls\\n3. Verify\"}```",
          ].join("\n"),
        }],
      },
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } =>
        event.event.type === "approval_request"
        && (event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval",
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
    });

    expect(mockState.cursorSdkPolicyUpdates.at(-1)).toMatchObject({
      chatMode: "agent",
      approvalPolicy: "on-request",
    });
    await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
      cursorModeId: "agent",
    });
  });

  const setupCursorPermissionSession = async (
    controls: Pick<AgentChatCreateArgs, "permissionMode" | "cursorModeId"> = {},
  ) => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      ...controls,
    });
    return { service, session };
  };

  it("persists the native Cursor full-auto mode for a permissionMode-only create", async () => {
    // `ade new chat --provider cursor --permissions full-auto` sends only
    // `permissionMode`; the desktop composer is the only caller that sends
    // `cursorModeId`. The session used to run full-auto while reporting mode
    // "agent", so every mode-reading surface disagreed with the policy.
    const { service, session } = await setupCursorPermissionSession({
      permissionMode: "full-auto",
    });

    expect(session.cursorModeId).toBe("full-auto");

    await service.sendMessage({
      sessionId: session.id,
      text: "Run in full auto.",
    }, { awaitDispatch: true });

    await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
      cursorModeId: "full-auto",
      cursorModeSnapshot: expect.objectContaining({ currentModeId: "full-auto" }),
    });
  });

  it("leaves cursorModeId absent for the legacy modes Cursor runs as plain agent", async () => {
    // Materialising "agent" here would be read back as a real selection and
    // pin the chat to it, which is the durable-pin bug the Droid and Claude
    // native controls carry the same warning about.
    for (const permissionMode of ["default", "edit"] as const) {
      const { session } = await setupCursorPermissionSession({
        permissionMode,
      });
      expect(session.cursorModeId ?? null).toBeNull();
    }
  });

  it("does not let an explicit Cursor mode be overwritten by the legacy permission mode", async () => {
    const { session } = await setupCursorPermissionSession({
      permissionMode: "full-auto",
      cursorModeId: "agent",
    });

    expect(session.cursorModeId).toBe("agent");
  });

  it("clears a derived Cursor full-auto mode when the permission mode is lowered", async () => {
    const { service, session } = await setupCursorPermissionSession({
      permissionMode: "full-auto",
    });
    expect(session.cursorModeId).toBe("full-auto");

    // Without this the derived mode outlives the request that set it and the
    // chat keeps running full-auto after the caller asked it not to.
    const updated = await service.updateSession({
      sessionId: session.id,
      permissionMode: "default",
    });
    expect(updated.cursorModeId ?? null).toBeNull();
    expect(updated.permissionMode).toBe("default");
    await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
      cursorModeId: null,
      cursorModeIdWasCleared: true,
    });
  });

  it("broadcasts an explicit Cursor mode clear when lowering legacy permissions", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const cursorSession = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      permissionMode: "full-auto",
    });
    events.length = 0;

    await service.updateSession({
      sessionId: cursorSession.id,
      permissionMode: "default",
    });

    const metaEvent = events
      .map((envelope) => envelope.event)
      .find((event): event is Extract<typeof event, { type: "session_meta_updated" }> =>
        event.type === "session_meta_updated");
    expect(metaEvent).toMatchObject({
      permissionMode: "default",
      cursorModeId: null,
    });
  });

  it("preserves an explicit Cursor mode clear during native permission normalization", async () => {
    const { service, session } = await setupCursorPermissionSession({
      permissionMode: "full-auto",
    });
    expect(session.cursorModeId).toBe("full-auto");

    const updated = await service.updateSession({
      sessionId: session.id,
      cursorModeId: null,
    });

    expect(updated.cursorModeId).toBeNull();
    expect(updated.permissionMode).toBe("default");
  });

  it("pushes Cursor SDK mode changes into the live worker while a turn is active", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const { service } = createService();

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "agent",
    });

    const releaseGate = parkCursorSend();
    const pendingTurn = service.sendMessage({
      sessionId: session.id,
      text: "Keep this Cursor turn open while I switch modes.",
    }, { awaitDispatch: true });

    try {
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThan(0);
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        cursorModeId: "full-auto",
      });

      expect(updated.cursorModeId).toBe("full-auto");
      expect(updated.cursorModeSnapshot?.currentModeId).toBe("full-auto");
      expect(mockState.cursorSdkPolicyUpdates.at(-1)).toMatchObject({
        chatMode: "agent",
        approvalPolicy: "never",
        fullAuto: true,
      });
    } finally {
      releaseGate();
      await pendingTurn;
    }
  });

  it("defers Cursor SDK runtime reset when switching models during an active turn", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const { service } = createService();

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "agent",
    });

    const releaseGate = parkCursorSend();
    const firstPrompt = "Keep this Cursor turn open while I switch models.";
    const matchingFirstPromptCalls = () => mockState.cursorSdkSendCalls.filter((call) =>
      String(call.promptText ?? "").includes(firstPrompt)
    );
    const pendingTurn = service.sendMessage({
      sessionId: session.id,
      text: firstPrompt,
    }, { awaitDispatch: true });

    try {
      await vi.waitFor(() => {
        expect(matchingFirstPromptCalls()).toHaveLength(1);
      });

      await expect(service.updateSession({
        sessionId: session.id,
        modelId: "cursor/composer-2.5",
      })).resolves.toMatchObject({
        provider: "cursor",
        model: "cursor/composer-2.5",
        modelId: "cursor/composer-2.5",
      });

      expect(releaseCursorSdkConnection).not.toHaveBeenCalled();
    } finally {
      releaseGate();
      await pendingTurn;
    }
    expect(matchingFirstPromptCalls()).toHaveLength(1);

    await vi.waitFor(() => {
      expect(releaseCursorSdkConnection).toHaveBeenCalledTimes(1);
    });
    mockState.cursorSendPromptGate = null;

    await service.sendMessage({
      sessionId: session.id,
      text: "Use the newly selected Cursor model.",
    }, { awaitDispatch: true });

    expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(
      expect.objectContaining({ modelSdkId: "composer-2.5" }),
    );
    expect(mockState.cursorSdkSendCalls.at(-1)).toEqual(
      expect.objectContaining({ modelSdkId: "composer-2.5" }),
    );
  });

  it("configures a new Droid SDK session with the selected model before prompting", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "droid",
      model: "custom:claude-sonnet-5-thinking-32000",
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Use the selected Droid model.",
    }, { awaitDispatch: true });

    const doneEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
      } => event.event.type === "done" && event.sessionId === session.id,
    );
    const updated = await service.getSessionSummary(session.id);

    expect(mockState.droidAcquireCalls[0]?.settings).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
    });
    expect(mockState.droidAcquireCalls[0]?.baseEnv).toEqual(expect.objectContaining({
      ADE_DEFAULT_ROLE: "agent",
      ADE_CHAT_SESSION_ID: session.id,
      ADE_LANE_ID: "lane-1",
      ADE_PROJECT_ROOT: tmpRoot,
    }));
    expect(mockState.droidSettingsUpdates.at(-1)).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
      interactionMode: "auto",
    });
    expect(mockState.droidPromptCalls[0]?.settings).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
    });
    expect(vi.mocked(buildCodingAgentSystemPrompt)).toHaveBeenCalledWith(expect.objectContaining({
      runtime: "droid-sdk",
      mode: "coding",
    }));
    expect(mockState.droidPromptCalls[0]?.promptText).toContain("system prompt\n\n## User Request");
    const settingsOrder = mockState.droidPooled.updateSettings.mock.invocationCallOrder[0];
    const firstPromptOrder = mockState.droidPooled.sendPrompt.mock.invocationCallOrder[0];
    expect(settingsOrder).toBeDefined();
    expect(firstPromptOrder).toBeDefined();
    expect(settingsOrder).toBeLessThan(firstPromptOrder!);
    expect(updated?.model).toBe("custom:claude-sonnet-5-thinking-32000");
    expect(updated?.modelId).toBe("droid/custom:claude-sonnet-5-thinking-32000");
    expect(doneEvent.event.model).toBe("custom:claude-sonnet-5-thinking-32000");
    expect(doneEvent.event.modelId).toBe("droid/custom:claude-sonnet-5-thinking-32000");
  });

  it("lists and resolves a live Droid SDK permission card", async () => {
    let finishTurn = () => {};
    mockState.droidPromptGate = new Promise<void>((resolve) => { finishTurn = resolve; });
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "droid",
      model: "custom:claude-sonnet-5-thinking-32000",
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
    });

    try {
      const turnPromise = service.sendMessage({
        sessionId: session.id,
        text: "Read a file that needs permission.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(mockState.droidPromptCalls.length).toBeGreaterThan(0);
        expect(typeof mockState.droidPooled?.bridge.onPermissionRequest).toBe("function");
      });

      const permissionResponse = mockState.droidPooled.bridge.onPermissionRequest({
        id: "droid-permission-card",
        title: "Read file",
        summary: "Read README.md",
        toolName: "Read",
        toolInput: { filePath: "README.md" },
        toolUseIds: ["tool-use-1"],
        options: [
          { label: "Allow once", value: "proceed_once" },
          { label: "Cancel", value: "cancel" },
        ],
        raw: { filePath: "README.md" },
      });

      expect(service.listPendingInputs({ sessionId: session.id }).requests).toEqual([
        expect.objectContaining({
          itemId: "droid-permission-card",
          source: "droid",
          kind: "permissions",
          blocking: true,
          options: expect.arrayContaining([
            expect.objectContaining({ label: "Allow once", value: "proceed_once" }),
          ]),
        }),
      ]);

      await service.respondToInput({
        sessionId: session.id,
        itemId: "droid-permission-card",
        decision: "accept",
      });

      await expect(permissionResponse).resolves.toEqual({ selectedOption: "proceed_once" });
      expect(service.listPendingInputs({ sessionId: session.id }).requests).toEqual([]);
      finishTurn();
      await expect(turnPromise).resolves.toBeUndefined();
    } finally {
      finishTurn();
    }
  });

  it("sends Droid screenshots as attachment paths over worker IPC", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const imagePath = path.join(tmpRoot, "droid-shot.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "droid",
      model: "custom:claude-sonnet-5-thinking-32000",
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Look at this screenshot.",
      attachments: [{ path: imagePath, type: "image" }],
    }, { awaitDispatch: true });

    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
      } => event.event.type === "done" && event.sessionId === session.id,
    );

    const sentImages = mockState.droidPromptCalls[0]?.images as Array<{
      path?: string;
      data?: string;
      mimeType?: string;
      rootPath?: string;
    }> | undefined;
    expect(sentImages).toHaveLength(1);
    expect(sentImages?.[0]?.data).toBeUndefined();
    expect(sentImages?.[0]?.mimeType).toBe("image/png");
    expect(sentImages?.[0]?.rootPath).toBe(tmpRoot);
    expect(path.basename(sentImages?.[0]?.path ?? "")).toBe("droid-shot.png");
    expect(String(mockState.droidPromptCalls[0]?.promptText ?? "")).toContain("Look at this screenshot.");
    expect(String(mockState.droidPromptCalls[0]?.promptText ?? "")).not.toMatch(/iVBORw0KGgo/u);
  });

  it("uses Droid spec mode for ADE plan mode", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "droid",
      model: "custom:claude-sonnet-5-thinking-32000",
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      interactionMode: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Draft a Droid spec.",
    }, { awaitDispatch: true });

    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope => event.event.type === "done" && event.sessionId === session.id,
    );

    expect(mockState.droidAcquireCalls[0]?.settings).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
      interactionMode: "spec",
      specModeModelId: "custom:claude-sonnet-5-thinking-32000",
    });
    expect(mockState.droidSettingsUpdates.at(-1)).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
      interactionMode: "spec",
      specModeModelId: "custom:claude-sonnet-5-thinking-32000",
    });
  });

  it("resumes a Droid SDK session and applies the selected model during warmup", async () => {
    const { service } = createService();

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "droid",
      model: "custom:claude-sonnet-5-thinking-32000",
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
    });

    const persisted = readPersistedChatState(session.id);
    writePersistedChatState(session.id, {
      ...persisted,
      droidSdkSessionId: "persisted-droid-session-1",
    });

    await service.warmupModel({
      sessionId: session.id,
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
    });

    const updated = await service.getSessionSummary(session.id);

    expect(mockState.droidAcquireCalls[0]).toMatchObject({
      resumeSessionId: "persisted-droid-session-1",
      workspacePath: fs.realpathSync(tmpRoot),
    });
    expect(mockState.droidSettingsUpdates.at(-1)).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
    });
    expect(mockState.droidNewSessionCalls).toHaveLength(0);
    expect(updated?.model).toBe("custom:claude-sonnet-5-thinking-32000");
    expect(updated?.modelId).toBe("droid/custom:claude-sonnet-5-thinking-32000");
  });

  it("surfaces structured Droid SDK failures without collapsing them to [object Object]", async () => {
    const events: AgentChatEventEnvelope[] = [];
    mockState.droidPromptError = {
      code: -32603,
      message: "Connection error.",
      data: "This might be a network issue. Please check your internet connection.",
    };

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "droid",
      model: "custom:claude-sonnet-5-thinking-32000",
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "test",
    }, { awaitDispatch: true });

    const errorEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "error" }>;
      } => event.event.type === "error" && event.sessionId === session.id,
    );

    expect(errorEvent.event.message).toBe("Connection error.");
    expect(errorEvent.event.detail).toContain("network issue");
    expect(errorEvent.event.errorInfo).toMatchObject({
      category: "network",
      provider: "Factory Droid",
    });
  });

  describe("Cursor Cloud routing", () => {
    it("dispatches cloud.send.stream and persists cloud session fields on first cloud send", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Promote to cloud.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      const cloudCalls = mockState.cursorSdkCloudRequests.filter((r) => r.type === "cloud.send.stream");
      expect(cloudCalls.length).toBeGreaterThan(0);
      const sentPayload = cloudCalls[0].payload;
      expect(sentPayload.repoUrl).toBe("https://github.com/example/repo.git");
      expect(typeof sentPayload.promptText).toBe("string");
      expect(String(sentPayload.idempotencyKey ?? "")).toMatch(new RegExp(`^ade:${session.id}:.+:cursor-cloud:create$`));
      expect(sentPayload.mode).toBe("agent");

      const refreshed = await service.getSessionSummary(session.id);
      expect(refreshed?.cursorCloudAgentId).toBe("cloud-agent-1");
      expect(refreshed?.cursorRuntime).toBe("cloud");
      expect(refreshed?.cursorPromotedTurnId).toBeTruthy();
    });

    it("adopts Cursor Cloud auto-generated agent names and omits ADE defaults", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      mockState.cursorSdkCloudResponses.set("cloud.send.stream", {
        agentId: "cloud-agent-1",
        runId: "cloud-run-1",
        status: "finished",
        result: { status: "finished" },
        agentName: "Cursor Cloud Native Title",
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Let Cursor Cloud name this.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );
      await waitForSessionTitle(sessionService, session.id, "Cursor Cloud Native Title");

      const sent = mockState.cursorSdkCloudRequests.find((r) => r.type === "cloud.send.stream");
      expect(sent?.payload.agentName).toBeUndefined();
      expect(sessionService.get(session.id)?.manuallyNamed).toBe(false);
    });

    it("uses Cursor's remote name and hydrates a reopened cloud chat", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Create the cloud chat.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      mockState.cursorSdkCloudResponses.set("cloud.agent.get", {
        name: "Plugin platform linear parity",
      });
      mockState.cursorSdkCloudResponses.set("cloud.runs.list", {
        items: [{
          runId: "cloud-run-1",
          status: "finished",
          model: { id: "grok-4.6" },
        }],
      });
      mockState.cursorSdkCloudResponses.set("cloud.run.conversation", {
        turns: [{
          type: "agentConversationTurn",
          turn: {
            userMessage: { text: "Remote prompt" },
            steps: [{ type: "assistantMessage", message: { text: "Remote answer" } }],
          },
        }],
      });

      await service.openCursorCloudChat({
        cloudAgentId: "cloud-agent-1",
        laneId: "lane-1",
        sessionId: session.id,
      });

      expect(sessionService.get(session.id)?.title).toBe("Plugin platform linear parity");
      expect(events.some((event) => event.event.type === "text" && event.event.text === "Remote answer")).toBe(true);
      expect(mockState.cursorSdkCloudRequests.map((request) => request.type)).toEqual(
        expect.arrayContaining(["cloud.agent.get", "cloud.runs.list", "cloud.run.conversation"]),
      );
    });

    it("adopts a cloud run's model once, so a later pick survives the mirror refresh", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      mockState.cursorSdkCloudResponses.set("cloud.agent.get", { name: "Cloud chat" });
      mockState.cursorSdkCloudResponses.set("cloud.runs.list", {
        items: [{ runId: "cloud-run-1", status: "finished", model: { id: "grok-4.6" } }],
      });
      mockState.cursorSdkCloudResponses.set("cloud.run.conversation", { turns: [] });
      const readModel = async () => (await service.getSessionSummary(session.id))?.model;

      // First attach: the chat takes the model the agent last ran on.
      await service.openCursorCloudChat({ cloudAgentId: "cloud-agent-1", laneId: "lane-1", sessionId: session.id });
      expect(await readModel()).toBe("grok-4.6");

      // The user picks another model; the mirror re-reads the same finished run.
      await service.updateSession({ sessionId: session.id, modelId: "cursor/composer-2" });
      const picked = await readModel();
      expect(picked).not.toBe("grok-4.6");
      await service.openCursorCloudChat({ cloudAgentId: "cloud-agent-1", laneId: "lane-1", sessionId: session.id });
      expect(await readModel()).toBe(picked);

      // A new run (from cursor.com) on another model is adopted.
      mockState.cursorSdkCloudResponses.set("cloud.runs.list", {
        items: [
          { runId: "cloud-run-2", status: "finished", model: { id: "gpt-5.4" } },
          { runId: "cloud-run-1", status: "finished", model: { id: "grok-4.6" } },
        ],
      });
      await service.openCursorCloudChat({ cloudAgentId: "cloud-agent-1", laneId: "lane-1", sessionId: session.id });
      expect(await readModel()).toBe("gpt-5.4");
    });

    it("drops the choices an adopted cloud model cannot take, and keeps them while the catalog cannot say", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const createChoosingSession = () => service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
        reasoningEffort: "low",
        fastMode: true,
        cursorConfigValues: { verbosity: "verbose", max_context: true },
      } as any);
      mockState.cursorSdkCloudResponses.set("cloud.agent.get", { name: "Cloud chat" });
      mockState.cursorSdkCloudResponses.set("cloud.runs.list", {
        items: [{ runId: "cloud-run-1", status: "finished", model: { id: "grok-4.6" } }],
      });
      mockState.cursorSdkCloudResponses.set("cloud.run.conversation", { turns: [] });

      // Cold catalog: unknown is not unsupported, so every choice stays.
      const cold = await createChoosingSession();
      await service.openCursorCloudChat({ cloudAgentId: "cloud-agent-1", laneId: "lane-1", sessionId: cold.id });
      expect(await service.getSessionSummary(cold.id)).toMatchObject({
        model: "grok-4.6",
        reasoningEffort: "low",
        fastMode: true,
        cursorConfigValues: { verbosity: "verbose", max_context: true },
      });

      cursorModelsListMock.mockResolvedValue([
        {
          id: "grok-4.6",
          parameters: [
            { id: "reasoning_effort", values: [{ value: "high" }] },
            { id: "verbosity", values: [{ value: "terse" }] },
          ],
        },
      ]);
      await probeCursorSdkModelDiscovery("cursor-test-key");
      const warm = await createChoosingSession();
      await service.openCursorCloudChat({ cloudAgentId: "cloud-agent-2", laneId: "lane-1", sessionId: warm.id });
      const summary = await service.getSessionSummary(warm.id);
      expect(summary?.model).toBe("grok-4.6");
      // grok-4.6 has no `low` effort, no Fast tier, and no `verbose`. It does
      // not declare max_context at all, so that choice is inapplicable and stays.
      expect(summary?.reasoningEffort ?? null).toBeNull();
      expect(summary?.fastMode).not.toBe(true);
      expect(summary?.cursorConfigValues).toEqual({ max_context: true });
    });

    it("keeps a model picked while a local Cursor run is starting", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const releaseSend = parkCursorSend();
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      const firstSend = service.sendMessage({ sessionId: session.id, text: "Start on Composer." });
      try {
        await vi.waitFor(() => {
          expect(mockState.cursorSdkSendCalls.length).toBe(1);
        });
        // The switch lands while the turn is busy, so it is deferred to turn end.
        await service.updateSession({ sessionId: session.id, modelId: "cursor/gpt-5.4" });
        const picked = (await service.getSessionSummary(session.id))?.modelId;
        expect(picked).toBe("cursor/gpt-5.4");
        // The run then reports the model this runtime sent, the old one.
        mockState.cursorSdkPooled.bridge.onRunStarted({
          agentId: "cursor-sdk-agent-1",
          runId: "cursor-sdk-run-1",
          modelSdkId: "composer-2",
        }, { runtime: "local" });
        expect((await service.getSessionSummary(session.id))?.modelId).toBe("cursor/gpt-5.4");
      } finally {
        releaseSend();
      }
      await firstSend;
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope => event.event.type === "done" && event.sessionId === session.id,
      );
      await service.sendMessage({ sessionId: session.id, text: "Continue on GPT." }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBe(2);
      });
      expect(mockState.cursorSdkAcquireCalls.at(-1)).toMatchObject({ modelSdkId: "gpt-5.4" });
    });

    it("re-reads Cursor's name on the first visible turn while the ADE title is still a default", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Create the cloud chat.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );
      const agentGetCalls = () => mockState.cursorSdkCloudRequests.filter((request) => request.type === "cloud.agent.get").length;
      // A launched cloud chat keeps ADE's default title until Cursor names it; this test
      // session was auto-titled from its prompt because it started as a local chat.
      sessionService.updateMeta({ sessionId: session.id, title: "Cursor Chat" });

      // First hydrate: Cursor has not named the agent yet and the run has no visible turn.
      mockState.cursorSdkCloudResponses.set("cloud.agent.get", {});
      mockState.cursorSdkCloudResponses.set("cloud.runs.list", {
        items: [{ runId: "cloud-run-1", status: "running", model: { id: "grok-4.6" } }],
      });
      mockState.cursorSdkCloudResponses.set("cloud.run.conversation", { turns: [] });
      await service.openCursorCloudChat({ cloudAgentId: "cloud-agent-1", laneId: "lane-1", sessionId: session.id });
      const readsAfterFirstHydrate = agentGetCalls();
      expect(readsAfterFirstHydrate).toBeGreaterThan(0);
      expect(sessionService.get(session.id)?.title ?? "").not.toBe("Named after the first turn");

      // Next tick, well inside the 60 s TTL: the run now has a visible turn and Cursor has a
      // name. The title is still a default, so this tick re-reads the name without polling.
      mockState.cursorSdkCloudResponses.set("cloud.agent.get", { name: "Named after the first turn" });
      mockState.cursorSdkCloudResponses.set("cloud.run.conversation", {
        turns: [{
          type: "agentConversationTurn",
          turn: {
            userMessage: { text: "Remote prompt" },
            steps: [{ type: "assistantMessage", message: { text: "Remote answer" } }],
          },
        }],
      });
      await service.openCursorCloudChat({ cloudAgentId: "cloud-agent-1", laneId: "lane-1", sessionId: session.id });
      expect(agentGetCalls()).toBe(readsAfterFirstHydrate + 1);
      expect(sessionService.get(session.id)?.title).toBe("Named after the first turn");

      // Once named, later ticks inside the TTL do not read the name again.
      await service.openCursorCloudChat({ cloudAgentId: "cloud-agent-1", laneId: "lane-1", sessionId: session.id });
      expect(agentGetCalls()).toBe(readsAfterFirstHydrate + 1);
    });

    it("rejects ADE title writes after a chat becomes a Cursor Cloud agent", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Promote this chat.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      await expect(service.updateSession({
        sessionId: session.id,
        title: "ADE-owned title",
        manuallyNamed: true,
      })).rejects.toThrow("agent names are managed by Cursor");
      await expect(service.regenerateSessionMetadata({
        sessionId: session.id,
        fields: ["title"],
      })).rejects.toThrow("agent names are managed by Cursor");
    });

    it("uses cloud.followup with the durable agentId on subsequent cloud sends", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "First.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      // Drain previous done so we can wait for the next one cleanly.
      events.length = 0;
      await service.sendMessage({
        sessionId: session.id,
        text: "Follow-up.",
        runtime: "cloud",
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      const types = mockState.cursorSdkCloudRequests.map((r) => r.type);
      expect(types).toEqual(expect.arrayContaining(["cloud.send.stream", "cloud.followup"]));
      const followup = mockState.cursorSdkCloudRequests.find((r) => r.type === "cloud.followup");
      expect(followup?.payload.agentId).toBe("cloud-agent-1");
      expect(String(followup?.payload.idempotencyKey ?? "")).toContain(":cursor-cloud:followup");
      expect(followup?.payload.mode).toBe("agent");
    });

    it("returns the accepted run identity for a direct cloud follow-up after cleanup", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start the cloud thread.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      const result = await service.cursorCloudFollowUp({
        agentId: "cloud-agent-1",
        prompt: "Continue the cloud thread.",
      });

      expect(result).toEqual({ runId: "cloud-run-2", status: "completed" });
      expect(mockState.cursorSdkCloudRequests.filter((request) => request.type === "cloud.followup")).toHaveLength(1);
    });

    it("surfaces Cursor SDK agent busy conflicts as busy cloud errors", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "First.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      mockState.cursorSdkCloudResponses.set("cloud.followup", Object.assign(
        new Error("Cursor SDK cloud.followup failed: Cursor agent is already running another task. (agent_busy)"),
        { code: "agent_busy" },
      ));
      events.length = 0;

      await service.sendMessage({
        sessionId: session.id,
        text: "Second.",
        runtime: "cloud",
      } as any, { awaitDispatch: true });

      const errorEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "error" }> } =>
          event.event.type === "error" && event.sessionId === session.id,
      );

      expect(errorEvent.event.message).toContain("already running this agent");
      expect(errorEvent.event.errorInfo).toMatchObject({
        category: "busy",
        provider: "Cursor Cloud",
      });
    });

    it("emits a 'done' event after a cloud send and flips session runtime to cloud", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Cloud, please.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });

      const doneEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );
      expect(doneEvent.event.status).toBe("completed");
      const summary = await service.getSessionSummary(session.id);
      expect(summary?.cursorRuntime).toBe("cloud");
    });

    it("refuses to create a cloud agent it cannot give the chosen model settings", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      // A catalog whose model DOES declare a reasoning control, but has no
      // value for the effort the session chose. Cursor would silently pick one
      // of the other values, so the create has to fail instead.
      cursorModelsListMock.mockResolvedValue([{
        id: "composer-2",
        displayName: "Composer 2",
        parameters: [{
          id: "reasoning_effort",
          displayName: "Reasoning effort",
          values: [{ value: "high", displayName: "High" }],
        }],
      }]);
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
        reasoningEffort: "xhigh",
      } as any);

      await service.sendMessage({
        sessionId: session.id,
        text: "Create the cloud agent.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });

      const errorEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "error" }> } =>
          event.event.type === "error" && event.sessionId === session.id,
      );
      expect(errorEvent.event.message).toContain("could not verify the selected model settings");
      // Cursor Cloud substitutes its own default variant when `params` are
      // omitted, so a create it cannot express must not be dispatched at all.
      expect(mockState.cursorSdkCloudRequests.some((r) => r.type === "cloud.send.stream")).toBe(false);
    });

    it("creates a cloud agent on a model that declares no reasoning control", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      // Cursor's row for this model has no reasoning parameter at all, so the
      // effort left on the session by a previously chosen model is
      // inapplicable, not unmet. There is no variant Cursor could substitute.
      cursorModelsListMock.mockResolvedValue([{
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [{
          id: "speed",
          displayName: "Speed",
          values: [
            { value: "standard", displayName: "Standard" },
            { value: "fast", displayName: "Fast" },
          ],
        }],
      }]);
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2.5",
        modelId: "cursor/composer-2.5",
        reasoningEffort: "xhigh",
      } as any);

      await service.sendMessage({
        sessionId: session.id,
        text: "Create the cloud agent.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      expect(events.some((event) => event.event.type === "error")).toBe(false);
      const sent = mockState.cursorSdkCloudRequests.find((r) => r.type === "cloud.send.stream");
      expect(sent).toBeTruthy();
    });

    it("creates the cloud agent with the verified model params", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      cursorModelsListMock.mockResolvedValue([{
        id: "composer-2",
        displayName: "Composer 2",
        parameters: [{
          id: "reasoning_effort",
          displayName: "Reasoning effort",
          values: [{ value: "high", displayName: "High" }],
        }],
      }]);
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
        reasoningEffort: "high",
      } as any);

      await service.sendMessage({
        sessionId: session.id,
        text: "Create the cloud agent.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      const sent = mockState.cursorSdkCloudRequests.find((r) => r.type === "cloud.send.stream");
      expect(sent?.payload.modelParams).toEqual([{ id: "reasoning_effort", value: "high" }]);
    });

    it("treats a session that never chose a tier as having no tier opinion", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      // A catalog whose only service tier is "fast": there is no standard value
      // to express. A session that never chose a tier must not be verified as
      // having asked for one, on either cloud create path.
      cursorModelsListMock.mockResolvedValue([{
        id: "composer-2",
        displayName: "Composer 2",
        parameters: [
          {
            id: "reasoning_effort",
            displayName: "Reasoning effort",
            values: [{ value: "high", displayName: "High" }],
          },
          {
            id: "speed",
            displayName: "Speed",
            values: [{ value: "fast", displayName: "Fast" }],
          },
        ],
      }]);
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
        reasoningEffort: "high",
      } as any);

      await service.sendMessage({
        sessionId: session.id,
        text: "Create the cloud agent.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      const sent = mockState.cursorSdkCloudRequests.find((r) => r.type === "cloud.send.stream");
      expect(sent?.payload.modelParams).toEqual([{ id: "reasoning_effort", value: "high" }]);
    });

    it("stops refetching a terminal cloud run that keeps reading back empty", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Create the cloud chat.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      // A run that ended in error with no visible turns never produces one.
      mockState.cursorSdkCloudResponses.set("cloud.runs.list", {
        items: [{ runId: "cloud-run-empty", status: "error" }],
      });
      mockState.cursorSdkCloudResponses.set("cloud.run.conversation", { turns: [] });
      mockState.cursorSdkCloudRequests.length = 0;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await service.openCursorCloudChat({
          cloudAgentId: "cloud-agent-1",
          laneId: "lane-1",
          sessionId: session.id,
        });
      }

      const conversationReads = mockState.cursorSdkCloudRequests.filter((r) => (
        r.type === "cloud.run.conversation" && r.payload.runId === "cloud-run-empty"
      ));
      expect(conversationReads).toHaveLength(3);
      // The remote name is read on the first hydrate of the session and then at
      // most once a minute, not on every one of the five refreshes.
      expect(mockState.cursorSdkCloudRequests.filter((r) => r.type === "cloud.agent.get")).toHaveLength(1);
    });

    it("includes the cursorSdkSystemPrompt directive in the first cloud send promptText", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      process.env.ADE_CURSOR_PROMPT_INJECT = "1";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Hi cloud.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      const sent = mockState.cursorSdkCloudRequests.find((r) => r.type === "cloud.send.stream");
      expect(sent).toBeTruthy();
      const promptText = String(sent!.payload.promptText ?? "");
      // System-prompt sections should be present
      expect(promptText).toContain("ADE control protocol");
      expect(promptText).toContain("Cursor Cloud capability");
      expect(promptText).toContain("runtime: cloud");
      expect(promptText.length).toBeLessThanOrEqual(promptText.indexOf("Hi cloud.") + 1024);
    });
  });
});
