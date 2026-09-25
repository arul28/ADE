import {
  AgentChatEventEnvelope,
  codexComputerUseClientCandidates,
  createAgentChatService,
  createService,
  mockState,
  path,
  tmpHomeRoot,
  tmpRoot,
  waitFor,
  waitForEvent,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("Codex app-server requests and commands", () => {
    it("awaits and injects the opted-in signed Computer Use MCP client into Codex threads", async () => {
      const signedClient = codexComputerUseClientCandidates(path.join(tmpHomeRoot, ".codex"))[0]!;

      const { service } = createService({
        resolveCodexComputerUseMcp: async () => ({ command: signedClient, args: ["mcp"], enabled: true }),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
      });
      await service.sendMessage({ sessionId: session.id, text: "List visible apps." }, { awaitDispatch: true });

      const threadStart = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect(threadStart?.params).toMatchObject({
        config: {
          model_reasoning_effort: "low",
          mcp_servers: {
            computer_use: {
              command: signedClient,
              args: ["mcp"],
              enabled: true,
            },
          },
        },
      });
    });

    it("answers the app-server external clock request with Unix seconds", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
      });
      await service.sendMessage({ sessionId: session.id, text: "Check the time." }, { awaitDispatch: true });

      const before = Math.floor(Date.now() / 1_000);
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "clock-1",
        method: "currentTime/read",
        params: { threadId: "thread-1" },
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "clock-1")).toEqual({
          id: "clock-1",
          result: {
            currentTimeAt: expect.any(Number),
          },
        });
      });
      const response = mockState.codexRequestPayloads.find((payload) => payload.id === "clock-1");
      expect((response?.result as { currentTimeAt?: number })?.currentTimeAt).toBeGreaterThanOrEqual(before);
    });

    it("keeps Computer Use per-app elicitation user-controlled in full-auto sessions", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "full-auto",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
      });
      await service.sendMessage({ sessionId: session.id, text: "Inspect Calculator." }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cu-approval-1",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "computer_use",
          mode: "form",
          _meta: { persist: ["always"] },
          message: "Allow Codex to use Calculator?",
          requestedSchema: { type: "object", properties: {} },
        },
      });

      const approval = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => event.event.type === "approval_request"
          && event.event.itemId === "mcp-elicitation:computer_use:cu-approval-1",
      );
      expect((approval.event.detail as any)?.request).toMatchObject({
        kind: "approval",
        description: "Allow Codex to use Calculator?",
        providerMetadata: {
          mcpElicitation: true,
          persistenceSupported: true,
        },
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.id === "cu-approval-1")).toBe(false);

      await service.respondToInput({
        sessionId: session.id,
        itemId: approval.event.itemId,
        decision: "accept_for_session",
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cu-approval-1")).toEqual({
        id: "cu-approval-1",
        result: {
          action: "accept",
          content: {},
          _meta: { persist: "always" },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cu-approval-2",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "computer_use",
          mode: "form",
          meta: { persist: ["always"] },
          message: "Allow Codex to use Preview?",
          requestedSchema: { type: "object", properties: {} },
        },
      });
      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request"
        && event.event.itemId === "mcp-elicitation:computer_use:cu-approval-2");
      await service.respondToInput({
        sessionId: session.id,
        itemId: "mcp-elicitation:computer_use:cu-approval-2",
        decision: "accept",
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cu-approval-2")).toEqual({
        id: "cu-approval-2",
        result: { action: "accept", content: {}, _meta: null },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cu-approval-3",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "computer_use",
          mode: "form",
          message: "Allow Codex to use Notes?",
          requestedSchema: { type: "object", properties: {} },
        },
      });
      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request"
        && event.event.itemId === "mcp-elicitation:computer_use:cu-approval-3");
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "cu-approval-3",
        },
      });
      const resolved = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "pending_input_resolved" }>;
      } => event.event.type === "pending_input_resolved"
        && event.event.itemId === "mcp-elicitation:computer_use:cu-approval-3");
      expect(resolved.event.resolution).toBe("cancelled");
    });

    it("routes Codex /inject to thread/inject_items and emits a notice", async () => {
      mockState.codexResponseOverrides.set("thread/inject_items", () => ({}));
      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/inject Remember this for the rest of the thread.\nSecond line here.",
      }, { awaitDispatch: true });

      const injectRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/inject_items");
      // ThreadInjectItemsParams.items takes raw Responses API items
      // (ResponseItem::Message), not a synthetic { type: "user_message" } shape.
      expect(injectRequest?.params).toMatchObject({
        threadId: expect.any(String),
        items: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Remember this for the rest of the thread.\nSecond line here." },
            ],
          },
        ],
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      const injectedNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice" && typeof env.event.message === "string" && env.event.message.startsWith("[injected]"));
      const completionNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice" && env.event.message === "Context injected into Codex thread history.");
      expect(injectedNotice?.event.message).toContain("Remember this for the rest of the thread.");
      expect(injectedNotice?.event.turnId).toBe(completionNotice?.event.turnId);
    });

    it("completes Codex /inject when the app-server RPC fails", async () => {
      mockState.delayedCodexMethods.add("thread/inject_items");
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "/inject Save this context.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/inject_items")).toBe(true);
      });
      const injectRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/inject_items");
      expect(injectRequest?.id).toBeTruthy();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: injectRequest?.id,
        error: { code: -32001, message: "inject RPC failed" },
      });
      await sendPromise;

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Codex context injection failed: inject RPC failed"
      )).toBe(true);
      expect(events.some((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "completed"
      )).toBe(true);
      expect(events.some((event) =>
        event.event.type === "done"
        && event.event.status === "completed"
      )).toBe(true);
    });

    it("rejects /inject without context body", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/inject   ",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/inject_items")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
    });

    it("does not classify compaction items as manual before /compact is accepted", async () => {
      mockState.delayedCodexMethods.add("thread/compact/start");
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "/compact",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/compact/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "compact-before-ack",
            type: "contextCompaction",
          },
        },
      });

      const compactionEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "context_compact" }>;
        } =>
          event.event.type === "context_compact"
          && event.event.state === "started",
      );
      expect(compactionEvent.event.trigger).toBe("auto");

      mockState.flushCodexResponses();
      await sendPromise;
    });

    it("routes /review with no args to review/start with target type=uncommittedChanges", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review",
      }, { awaitDispatch: true });

      // ReviewTarget union (codex v2 protocol): uncommittedChanges | baseBranch | commit | custom.
      const reviewRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "review/start");
      expect(reviewRequest?.params).toMatchObject({
        threadId: expect.any(String),
        target: { type: "uncommittedChanges" },
      });
    });

    it("routes /review branch <name> to review/start with target type=baseBranch", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review branch feature/foo",
      }, { awaitDispatch: true });

      const reviewRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "review/start");
      expect(reviewRequest?.params).toMatchObject({
        target: { type: "baseBranch", branch: "feature/foo" },
      });
    });

    it("routes /review prompt <text> to review/start with target type=custom", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review prompt audit the auth middleware",
      }, { awaitDispatch: true });

      const reviewRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "review/start");
      expect(reviewRequest?.params).toMatchObject({
        target: { type: "custom", instructions: "audit the auth middleware" },
      });
    });

    it("rejects /review branch with no name and does not call review/start", async () => {
      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review branch   ",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "review/start")).toBe(false);
      const usageNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice"
          && typeof env.event.message === "string"
          && env.event.message.includes("/review branch"));
      expect(usageNotice).toBeDefined();
    });

    it("rejects /review prompt with no text and does not call review/start", async () => {
      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review prompt   ",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "review/start")).toBe(false);
      const usageNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice"
          && typeof env.event.message === "string"
          && env.event.message.includes("/review prompt"));
      expect(usageNotice).toBeDefined();
    });

    it("routes /review diff to target.uncommittedChanges", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review diff",
      }, { awaitDispatch: true });

      const reviewRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "review/start");
      expect(reviewRequest?.params).toMatchObject({
        target: { type: "uncommittedChanges" },
      });
    });

    it("surfaces Codex deprecation/warning/guardian/config notifications as system_notice rows", async () => {
      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Kick off codex.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "deprecationNotice",
        params: { message: "old feature gone" },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "warning",
        params: { message: "watch out" },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "guardianWarning",
        params: { message: "sandbox tripped" },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "configWarning",
        params: { message: "config layer stale" },
      });

      await vi.waitFor(() => {
        const notices = onEvent.mock.calls
          .map((call) => call[0])
          .filter((env: any) => env?.event?.type === "system_notice");
        const messages = notices.map((env: any) => env.event.message);
        expect(messages).toEqual(expect.arrayContaining([
          "⚠ deprecated: old feature gone",
          "⚠ watch out",
          "🛡 guardian: sandbox tripped",
          "⚙ config: config layer stale",
        ]));
      });

      const guardianNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice" && env.event.message.startsWith("🛡 guardian:"));
      expect(guardianNotice?.event.noticeKind).toBe("error");

      const deprecationNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice" && env.event.message.startsWith("⚠ deprecated:"));
      expect(deprecationNotice?.event.noticeKind).toBe("warning");

      const configNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice" && env.event.message.startsWith("⚙ config:"));
      expect(configNotice?.event.noticeKind).toBe("config");
    });

    it("dispatches Codex notifications with top-level emittedAtMs normally", async () => {
      const { service, logger } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({ sessionId: session.id, text: "Start Codex." });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });
      logger.warn.mockClear();
      logger.info.mockClear();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "account/updated",
        params: {},
        emittedAtMs: 1_783_891_200_000,
      });

      await vi.waitFor(() => {
        expect(logger.info).toHaveBeenCalledWith("agent_chat.codex_account_updated", { sessionId: session.id });
      });
      expect(logger.warn).not.toHaveBeenCalledWith(
        "agent_chat.codex_unhandled_notification",
        expect.anything(),
      );
    });

    it("populates optOutNotificationMethods in initialize when runtimeMode is 'print'", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "print",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Hello.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "initialize")).toBe(true);
      });

      const initializeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "initialize");
      const capabilities = (initializeRequest?.params as { capabilities?: { optOutNotificationMethods?: string[] } })
        ?.capabilities;
      const expectedOptOut = [
        "item/agentMessage/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
        "item/commandExecution/outputDelta",
      ];
      expect(capabilities?.optOutNotificationMethods).toEqual(expect.arrayContaining(expectedOptOut));
      expect(capabilities?.optOutNotificationMethods).toHaveLength(expectedOptOut.length);
    });

    it("sends an empty optOutNotificationMethods list when runtimeMode is undefined (default interactive)", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Hello.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "initialize")).toBe(true);
      });

      const initializeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "initialize");
      const capabilities = (initializeRequest?.params as { capabilities?: { optOutNotificationMethods?: string[] } })
        ?.capabilities;
      expect(capabilities?.optOutNotificationMethods).toEqual([]);
    });

    it("compacts large Codex command output before storing chat history", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run a noisy command.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const output = `head-marker\n${"x".repeat(96 * 1024)}\ntail-marker`;
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "cmd-large-output",
            type: "commandExecution",
            command: "npm test",
            cwd: tmpRoot,
            status: "completed",
            aggregatedOutput: output,
            exitCode: 0,
            durationMs: 1234,
          },
        },
      });

      const commandEvent = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "command" }>;
      } => event.event.type === "command" && event.event.itemId === "cmd-large-output");

      expect(commandEvent.event.output).toBe(output);
      expect(commandEvent.event.outputOriginalBytes).toBeUndefined();
      expect(commandEvent.event.outputOmittedBytes).toBeUndefined();

      const historyEvent = (await service.getChatEventHistory(session.id)).events.find((event) =>
        event.event.type === "command" && event.event.itemId === "cmd-large-output"
      );
      expect(historyEvent?.event.type).toBe("command");
      if (historyEvent?.event.type !== "command") throw new Error("Expected command history event");
      expect(historyEvent.event.output).toContain("Large command output was shortened");
      expect(historyEvent.event.output).toContain("head-marker");
      expect(historyEvent.event.output).toContain("tail-marker");
      expect(historyEvent.event.output).not.toContain("x".repeat(80 * 1024));
      expect(historyEvent.event.outputOriginalBytes).toBe(Buffer.byteLength(output, "utf8"));
      expect(historyEvent.event.outputOmittedBytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(historyEvent.event.output, "utf8")).toBeLessThan(20 * 1024);
    });

    it("bounds stored Codex command output while streaming deltas", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run a streaming noisy command.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const chunks = [
        `stream-head\n${"a".repeat(2048)}`,
        `${"b".repeat(2048)}\nstream-tail`,
        `${"z".repeat(4096)}\nafter-close-1`,
        `${"z".repeat(4096)}\nafter-close-2`,
      ];
      for (const chunk of chunks) {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "item/commandExecution/outputDelta",
          params: {
            turnId: "turn-1",
            itemId: "cmd-stream-output",
            delta: chunk,
          },
        });
      }

      await vi.waitFor(() => {
        expect(events.filter((event) =>
          event.event.type === "command" && event.event.itemId === "cmd-stream-output"
        )).toHaveLength(4);
      });

      const commandEvents = events.filter((event) =>
        event.event.type === "command" && event.event.itemId === "cmd-stream-output"
      );
      expect(commandEvents.map((event) =>
        event.event.type === "command" ? event.event.output : "",
      )).toEqual(chunks);

      const storedCommandEvents = (await service.getChatEventHistory(session.id)).events.filter((event) =>
        event.event.type === "command" && event.event.itemId === "cmd-stream-output"
      );
      expect(storedCommandEvents).toHaveLength(2);
      const compactedEvent = storedCommandEvents.at(-1);
      expect(compactedEvent?.event.type).toBe("command");
      if (compactedEvent?.event.type !== "command") throw new Error("Expected compacted command event");
      expect(compactedEvent.event.output).toContain("Large command output was shortened");
      expect(compactedEvent.event.output).toContain("stream-head");
      expect(compactedEvent.event.output).toContain("stream-tail");
      expect(compactedEvent.event.output).not.toContain("after-close");
      expect(compactedEvent.event.outputOriginalBytes).toBe(Buffer.byteLength(`${chunks[0]}${chunks[1]}`, "utf8"));
      expect(compactedEvent.event.outputOmittedBytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(storedCommandEvents.map((event) =>
        event.event.type === "command" ? event.event.output : "",
      ).join(""), "utf8")).toBeLessThan(12 * 1024);
      expect(storedCommandEvents.some((event) =>
        event.event.type === "command" && event.event.output.includes("after-close")
      )).toBe(false);
    });

    it("omits oversized inline Codex image data from history without changing live previews", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Generate two icons.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const smallData = "data:image/png;base64,AAAA";
      const largeData = `data:image/png;base64,${"B".repeat(80 * 1024)}`;
      for (const [id, result] of [["image-small", smallData], ["image-large", largeData]] as const) {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              id,
              type: "imageGeneration",
              prompt: "A tiny icon",
              status: "completed",
              result,
            },
          },
        });
      }
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "image-view-large",
            type: "imageView",
            title: "Inline preview",
            status: "completed",
            url: largeData,
          },
        },
      });

      const liveLarge = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "codex_image_generation" }> } =>
          event.event.type === "codex_image_generation" && event.event.itemId === "image-large",
      );
      expect(liveLarge.event.result).toBe(largeData);
      expect(liveLarge.event.resultOriginalBytes).toBeUndefined();

      const history = (await service.getChatEventHistory(session.id)).events;
      const storedSmall = history.find((event) =>
        event.event.type === "codex_image_generation" && event.event.itemId === "image-small"
      );
      expect(storedSmall?.event.type).toBe("codex_image_generation");
      if (storedSmall?.event.type !== "codex_image_generation") throw new Error("Expected small stored image");
      expect(storedSmall.event.result).toBe(smallData);
      expect(storedSmall.event.resultOmittedBytes).toBeUndefined();

      const storedLarge = history.find((event) =>
        event.event.type === "codex_image_generation" && event.event.itemId === "image-large"
      );
      expect(storedLarge?.event.type).toBe("codex_image_generation");
      if (storedLarge?.event.type !== "codex_image_generation") throw new Error("Expected large stored image");
      expect(storedLarge.event.result).toBeNull();
      expect(storedLarge.event.resultOriginalBytes).toBe(Buffer.byteLength(largeData, "utf8"));
      expect(storedLarge.event.resultOmittedBytes).toBe(Buffer.byteLength(largeData, "utf8"));
      expect(JSON.stringify(storedLarge.event)).not.toContain("B".repeat(1024));

      const storedView = history.find((event) =>
        event.event.type === "codex_image_view" && event.event.itemId === "image-view-large"
      );
      expect(storedView?.event.type).toBe("codex_image_view");
      if (storedView?.event.type !== "codex_image_view") throw new Error("Expected stored image view");
      expect(storedView.event.url).toBeNull();
      expect(storedView.event.urlOriginalBytes).toBe(Buffer.byteLength(largeData, "utf8"));
      expect(storedView.event.urlOmittedBytes).toBe(Buffer.byteLength(largeData, "utf8"));
    });

    it("compacts large tool result and file diff payloads before storing chat history", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run tools.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const toolResult = {
        stdout: `tool-head\n${"a".repeat(80 * 1024)}\ntool-tail`,
        metadata: { useful: true },
      };
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "tool-large-result",
            type: "toolCall",
            tool: "largeTool",
            status: "completed",
            result: toolResult,
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "tool-empty-result",
            type: "toolCall",
            tool: "emptyTool",
            status: "completed",
          },
        },
      });

      const diff = `diff --git a/file.ts b/file.ts\n${"+".repeat(1)}diff-head\n${"+x\n".repeat(40 * 1024)}+diff-tail\n`;
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "file-large-diff",
            type: "fileChange",
            status: "completed",
            changes: [{ path: "src/file.ts", kind: "modify", diff }],
          },
        },
      });

      const toolEvent = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "tool_result" }>;
      } => event.event.type === "tool_result" && event.event.itemId === "tool-large-result");
      expect(toolEvent.event.result).toStrictEqual(toolResult);
      expect(toolEvent.event.resultOriginalBytes).toBeUndefined();
      expect(toolEvent.event.resultOmittedBytes).toBeUndefined();

      const emptyToolEvent = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "tool_result" }>;
      } => event.event.type === "tool_result" && event.event.itemId === "tool-empty-result");
      expect(emptyToolEvent.event.result).toBeUndefined();
      expect(emptyToolEvent.event.resultOmittedBytes).toBeUndefined();

      const fileEvent = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "file_change" }>;
      } => event.event.type === "file_change" && event.event.itemId === "file-large-diff");
      expect(fileEvent.event.diff).toBe(diff);
      expect(fileEvent.event.diffOriginalBytes).toBeUndefined();
      expect(fileEvent.event.diffOmittedBytes).toBeUndefined();

      const history = (await service.getChatEventHistory(session.id)).events;
      const storedToolEvent = history.find((event) =>
        event.event.type === "tool_result" && event.event.itemId === "tool-large-result"
      );
      expect(storedToolEvent?.event.type).toBe("tool_result");
      if (storedToolEvent?.event.type !== "tool_result") throw new Error("Expected stored tool event");
      expect(storedToolEvent.event.resultOriginalBytes).toBeGreaterThan(80 * 1024);
      expect(storedToolEvent.event.resultOmittedBytes).toBeGreaterThan(0);
      expect(storedToolEvent.event.result).toMatchObject({
        summary: expect.stringContaining("Large tool result was shortened"),
        preview: expect.stringContaining("tool-tail"),
      });
      expect(JSON.stringify(storedToolEvent.event.result)).not.toContain("a".repeat(64 * 1024));

      const storedFileEvent = history.find((event) =>
        event.event.type === "file_change" && event.event.itemId === "file-large-diff"
      );
      expect(storedFileEvent?.event.type).toBe("file_change");
      if (storedFileEvent?.event.type !== "file_change") throw new Error("Expected stored file event");
      expect(storedFileEvent.event.diff).toContain("Large file diff was shortened");
      expect(storedFileEvent.event.diff).toContain("diff-head");
      expect(storedFileEvent.event.diff).toContain("diff-tail");
      expect(storedFileEvent.event.diffOriginalBytes).toBe(Buffer.byteLength(diff, "utf8"));
      expect(storedFileEvent.event.diffOmittedBytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(storedFileEvent.event.diff, "utf8")).toBeLessThan(36 * 1024);
    });

    it("ignores deprecation/warning notifications with missing or empty message", async () => {
      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Kick off codex.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      const beforeNoticeCount = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "system_notice").length;

      // Missing payload entirely.
      mockState.emitCodexPayload({ jsonrpc: "2.0", method: "deprecationNotice" });
      // Empty params.
      mockState.emitCodexPayload({ jsonrpc: "2.0", method: "warning", params: {} });
      // Wrong field name (handler should silently no-op).
      mockState.emitCodexPayload({ jsonrpc: "2.0", method: "configWarning", params: { note: "ignored" } });
      // Whitespace-only.
      mockState.emitCodexPayload({ jsonrpc: "2.0", method: "guardianWarning", params: { message: "   " } });

      // Settle: emit a real notice so vi.waitFor has something to wait on.
      mockState.emitCodexPayload({ jsonrpc: "2.0", method: "warning", params: { message: "real one" } });
      await vi.waitFor(() => {
        const messages = onEvent.mock.calls
          .map((call) => call[0])
          .filter((env: any) => env?.event?.type === "system_notice")
          .map((env: any) => env.event.message);
        expect(messages).toContain("⚠ real one");
      });

      const afterMessages = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "system_notice")
        .map((env: any) => env.event.message);
      // Only the real notice should have been added beyond the baseline.
      expect(afterMessages.length).toBe(beforeNoticeCount + 1);
    });
  });
});

describe("createAgentChatService", () => {
  describe("Codex app-server state", () => {
    it("enables Codex update_plan on every thread/start", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Plan then patch.",
      }, { awaitDispatch: true });
      const startPayload = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect(startPayload?.params).toMatchObject({
        config: { tools: { update_plan: { enabled: true } } },
      });
    });

    it("emits the Codex 50% five-hour plan notice from used_percent, not remaining/limit", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Keep working.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "account/rateLimits/updated",
        params: { remaining: 10, limit: 100 },
      });
      await Promise.resolve();
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Approaching Codex plan limit"
      )).toBe(false);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "account/rateLimits/updated",
        params: { rateLimits: { primary: { used_percent: 50 }, secondary: { used_percent: 10 } } },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.noticeKind === "rate_limit"
          && event.event.status === "allowed_warning"
          && event.event.message === "Approaching Codex plan limit"
        )).toBe(true);
      });
    });

    it("emits Computer Use status only on macOS and folds MCP live events into the working row", async () => {
      const originalPlatform = process.platform;
      const events: AgentChatEventEnvelope[] = [];
      try {
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });
        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        mockState.emitCodexPayload({
          method: "mcpServer/startupStatus/updated",
          params: { serverName: "computer_use", status: "ok" },
        });
        await Promise.resolve();
        expect(events.some((event) =>
          event.event.type === "tool_call" && event.event.tool === "computer_use"
        )).toBe(false);

        Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
        mockState.emitCodexPayload({
          method: "mcpServer/startupStatus/updated",
          params: { serverName: "computer_use", status: "ok" },
        });
        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "tool_call"
            && event.event.tool === "computer_use"
            && (event.event.args as { status?: string } | undefined)?.status === "ready"
          )).toBe(true);
        });

        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          id: "mcp-stream-1",
          method: "mcpServer/event/stream/start",
          params: { serverName: "docs" },
        });
        mockState.emitCodexPayload({
          method: "mcpServer/event/resource/updated",
          params: { serverName: "docs", message: "file changed" },
        });
        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "tool_call"
            && event.event.tool === "mcp_event"
            && (event.event.args as { event?: string } | undefined)?.event === "file changed"
          )).toBe(true);
        });
        expect(mockState.codexRequestPayloads.some((payload) =>
          payload.id === "mcp-stream-1" && payload.result && typeof payload.result === "object"
        )).toBe(true);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });

    it("lists installed Codex plugins from a live runtime without toggling them", async () => {
      mockState.codexResponseOverrides.set("plugin/list", () => ({
        marketplaces: [{
          name: "openai-bundled",
          plugins: [{
            id: "bundled.docs",
            name: "docs",
            enabled: true,
            installed: true,
            source: { type: "local" },
            installPolicy: "INSTALLED_BY_DEFAULT",
          }],
        }],
      }));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Open Codex.",
      }, { awaitDispatch: true });
      await expect(service.listCodexPlugins({})).resolves.toEqual([
        expect.objectContaining({
          id: "bundled.docs",
          name: "docs",
          enabled: true,
          origin: "bundled",
        }),
      ]);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "plugin/reconcile")).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "plugin/list")).toBe(true);
    });

    it("lists Codex plugins from the requested lane when sessionId is omitted", async () => {
      mockState.codexResponseOverrides.set("plugin/list", () => ({
        marketplaces: [{
          name: "openai-bundled",
          plugins: [{
            id: "bundled.docs",
            name: "docs",
            enabled: true,
            installed: true,
            source: { type: "local" },
            installPolicy: "INSTALLED_BY_DEFAULT",
          }],
        }],
      }));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Open Codex.",
      }, { awaitDispatch: true });
      await expect(service.listCodexPlugins({ laneId: "lane-missing" })).resolves.toEqual([]);
      await expect(service.listCodexPlugins({ laneId: "lane-1" })).resolves.toEqual([
        expect.objectContaining({ id: "bundled.docs", origin: "bundled" }),
      ]);
    });

    it("fails open on Codex plugin method-not-found and surfaces other plugin errors", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Open Codex.",
      }, { awaitDispatch: true });

      mockState.codexResponseOverrides.set("plugin/list", {
        error: { code: -32601, message: "Method not found" },
      });
      await expect(service.listCodexPlugins({ sessionId: session.id })).resolves.toEqual([]);

      mockState.codexResponseOverrides.set("plugin/list", {
        error: { code: -32000, message: "auth failed" },
      });
      await expect(service.listCodexPlugins({ sessionId: session.id })).rejects.toThrow(/auth failed/);
    });

    it("clears Codex modelId when the runtime reports an unregistered thread model", async () => {
      mockState.codexResponseOverrides.set("thread/start", () => ({
        thread: { id: "thread-unknown-model", model: "gpt-unknown-preview" },
      }));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        modelId: "openai/gpt-5.4",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Open Codex.",
      }, { awaitDispatch: true });
      const summary = await service.getSessionSummary(session.id);
      expect(summary?.model).toBe("gpt-unknown-preview");
      expect(summary?.modelId).toBeUndefined();
    });
  });
});
