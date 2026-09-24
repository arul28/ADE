import {
  AgentChatEventEnvelope,
  claudeInputText,
  claudeNoticeMessages,
  claudeSdkCreateSessionCompat,
  createAgentChatService,
  createClaudeStreamFixture,
  createMemoryTurnUsageLedger,
  createService,
  makeDefaultClaudeSession,
  path,
  query,
  readPersistedChatState,
  runClaudeStreamFixture,
  startup,
  waitFor,
  waitForCondition,
  waitForEvent,
  waitForFakeTimers,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

/**
 * Claude fixture that withholds the provider's answer to `/compact` until ADE
 * has actually sent it. Yielding both results up front lets the turn's own
 * post-result drain swallow the second one, which is not how the SDK behaves.
 */
async function createClaudeCompactionFixture(args: {
  sdkSessionId: string;
  first: Array<Record<string, unknown>>;
  afterCompact: Array<Record<string, unknown>>;
}) {
  const events: AgentChatEventEnvelope[] = [];
  const setPermissionMode = vi.fn().mockResolvedValue(undefined);
  let resolveCompactSent: () => void = () => {};
  const compactSent = new Promise<void>((resolve) => { resolveCompactSent = resolve; });
  const send = vi.fn(async (message: unknown) => {
    if (claudeInputText(message) === "/compact") resolveCompactSent();
  });
  let streamCall = 0;

  const stream = vi.fn(() => (async function* () {
    streamCall += 1;
    if (streamCall === 1) {
      yield {
        type: "system",
        subtype: "init",
        session_id: args.sdkSessionId,
        slash_commands: [],
      };
      return;
    }
    for (const message of args.first) yield message;
    await compactSent;
    for (const message of args.afterCompact) yield message;
  })());

  vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
    send,
    stream,
    close: vi.fn(),
    sessionId: args.sdkSessionId,
    setPermissionMode,
  } as any);

  const harness = createService({
    onEvent: (event: AgentChatEventEnvelope) => events.push(event),
  });
  const { service } = harness;
  const session = await service.createSession({
    laneId: "lane-1",
    provider: "claude",
    model: "claude-sonnet-5",
    modelId: "anthropic/claude-sonnet-5",
  });

  await service.runSessionTurn({
    sessionId: session.id,
    text: "Exercise Claude streaming text.",
  });

  return { ...harness, events, session, send };
}

describe("createAgentChatService", () => {
  describe("Claude streams", () => {
    it("emits immediate startup activity before Claude SDK stream output arrives", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => {
        releaseStream = () => resolve();
      });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          return;
        }

        await streamGate;
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Resolve the PR comments.",
      });

      const startedEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } => event.event.type === "status" && event.event.turnStatus === "started",
      );

      const startupActivity = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "activity" }>;
        } =>
          event.event.type === "activity"
          && event.event.turnId === startedEvent.event.turnId
          && (event.event.activity === "thinking" || event.event.activity === "working"),
      );

      expect(startupActivity.event.detail).toBeTruthy();

      releaseStream();
      await sendPromise;
    });

    it.each([
      { subtype: "error_during_execution", terminalReason: undefined, expectedStatus: "failed" },
      { subtype: "error_max_turns", terminalReason: undefined, expectedStatus: "failed" },
      { subtype: "error_max_budget_usd", terminalReason: undefined, expectedStatus: "failed" },
      { subtype: "error_max_structured_output_retries", terminalReason: undefined, expectedStatus: "failed" },
      { subtype: "success", terminalReason: "budget_exhausted", expectedStatus: "failed" },
      { subtype: "success", terminalReason: "structured_output_retry_exhausted", expectedStatus: "failed" },
      { subtype: "success", terminalReason: "max_turns", expectedStatus: "failed" },
      { subtype: "success", terminalReason: "api_error", expectedStatus: "failed" },
      { subtype: "success", terminalReason: "malformed_tool_use_exhausted", expectedStatus: "failed" },
      { subtype: "success", terminalReason: "prompt_too_long", expectedStatus: "failed" },
      { subtype: "error_during_execution", terminalReason: "aborted_streaming", expectedStatus: "interrupted" },
      { subtype: "error_during_execution", terminalReason: "aborted_tools", expectedStatus: "interrupted" },
    ])("maps Claude $subtype/$terminalReason results to $expectedStatus", async ({
      subtype,
      terminalReason,
      expectedStatus,
    }) => {
      const events = await runClaudeStreamFixture({
        sdkSessionId: `sdk-terminal-${subtype}-${terminalReason ?? "none"}`,
        messages: [{
          type: "result",
          subtype,
          is_error: subtype !== "success",
          ...(terminalReason ? { terminal_reason: terminalReason } : {}),
          usage: { input_tokens: 1, output_tokens: 1 },
        }],
      });

      const done = events.find((entry) =>
        entry.event.type === "done"
        && entry.event.terminalReason === terminalReason
      );
      expect(done?.event).toMatchObject({
        type: "done",
        status: expectedStatus,
        ...(terminalReason
          ? { terminalReason, terminalReasonSource: "sdk" }
          : {}),
      });
    });

    it("surfaces Claude protocol frames and adopts a reset conversation as the SDK resume pointer", async () => {
      const goal = {
        condition: "Finish the SDK wiring",
        iterations: 1,
        set_at: 100,
        tokens_at_start: 200,
        last_reason: "initial",
      };
      const { events, service, session } = await createClaudeStreamFixture({
        sdkSessionId: "sdk-protocol-surfaces",
        messages: [
          {
            type: "system",
            subtype: "init",
            session_id: "sdk-protocol-surfaces",
            slash_commands: [],
            capabilities: ["interrupt_receipt_v1", "future_capability", "interrupt_receipt_v1"],
          },
          {
            type: "conversation_reset",
            new_conversation_id: "conversation-after-clear",
            session_id: "sdk-protocol-surfaces",
            uuid: "conversation-reset-1",
          },
          { type: "active_goal", value: goal, session_id: "conversation-after-clear", uuid: "goal-1" },
          { type: "active_goal", value: goal, session_id: "conversation-after-clear", uuid: "goal-duplicate" },
          {
            type: "active_goal",
            value: { ...goal, iterations: 2, last_reason: "continued" },
            session_id: "conversation-after-clear",
            uuid: "goal-2",
          },
          { type: "active_goal", value: null, session_id: "conversation-after-clear", uuid: "goal-clear" },
          {
            type: "system",
            subtype: "api_retry",
            attempt: 2,
            max_retries: 5,
            retry_delay_ms: 750,
            error_status: 529,
            error: "overloaded",
          },
          { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      });

      expect(events.find((entry) => entry.event.type === "conversation_reset")?.event).toEqual(expect.objectContaining({
        type: "conversation_reset",
        newConversationId: "conversation-after-clear",
      }));
      expect(events.filter((entry) => entry.event.type === "claude_goal_updated")).toHaveLength(2);
      expect(events.filter((entry) => entry.event.type === "claude_goal_cleared")).toHaveLength(1);
      expect(events.find((entry) => entry.event.type === "api_retry")?.event).toMatchObject({
        attempt: 2,
        maxRetries: 5,
        retryDelayMs: 750,
        errorStatus: 529,
      });
      expect(readPersistedChatState(session.id)).toMatchObject({
        sdkSessionId: "conversation-after-clear",
        protocolCapabilities: ["interrupt_receipt_v1", "future_capability"],
      });
      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
        protocolCapabilities: ["interrupt_receipt_v1", "future_capability"],
      });
    });

    it("flushes buffered assistant text before a live-only Claude retry", async () => {
      const { events } = await createClaudeStreamFixture({
        sdkSessionId: "sdk-retry-flush-buffer",
        messages: [
          {
            type: "assistant",
            message: { id: "m-retry-flush", content: [{ type: "text", text: "Running." }] },
          },
          {
            type: "system",
            subtype: "api_retry",
            attempt: 2,
            max_retries: 10,
            retry_delay_ms: 4_000,
            error_status: 529,
            error: "overloaded",
          },
        ],
      });

      const textIndex = events.findIndex((entry) =>
        entry.event.type === "text" && entry.event.text === "Running.");
      const retryIndex = events.findIndex((entry) => entry.event.type === "api_retry");
      const retryActivityIndex = events.findIndex((entry) =>
        entry.event.type === "activity" && entry.event.providerRetry === true);
      expect(textIndex).toBeGreaterThanOrEqual(0);
      expect(retryIndex).toBeGreaterThan(textIndex);
      expect(retryActivityIndex).toBeGreaterThan(textIndex);
    });

    it("emits deduplicated command lifecycle events only for ADE-owned Claude messages", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-command-lifecycle", slash_commands: [] };
          return;
        }
        let sentUuid: string | undefined;
        await vi.waitFor(() => {
          const userMessage = events.find((entry) => entry.event.type === "user_message")?.event;
          sentUuid = userMessage?.type === "user_message" ? userMessage.messageId : undefined;
          expect(sentUuid).toEqual(expect.any(String));
        });
        yield { type: "command_lifecycle", command_uuid: "internal-command", status: "queued" };
        yield { type: "command_lifecycle", command_uuid: sentUuid, status: "queued" };
        yield { type: "command_lifecycle", command_uuid: sentUuid, status: "queued" };
        yield { type: "command_lifecycle", command_uuid: sentUuid, status: "started" };
        yield { type: "command_lifecycle", command_uuid: sentUuid, status: "discarded" };
        yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-command-lifecycle",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });
      await service.runSessionTurn({ sessionId: session.id, text: "Track this command." });

      const lifecycle = events
        .map((entry) => entry.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "command_lifecycle" }> =>
          event.type === "command_lifecycle");
      expect(lifecycle.map((event) => event.status)).toEqual(["queued", "started", "discarded"]);
      expect(lifecycle.every((event) => event.preview === "Track this command.")).toBe(true);
    });

    it("persists and rehydrates the current Claude active goal", async () => {
      const goal = {
        condition: "Prove goal persistence",
        iterations: 3,
        set_at: 1_234,
        tokens_at_start: 5_678,
        last_reason: "verification",
      };
      const harness = await createClaudeStreamFixture({
        sdkSessionId: "sdk-goal-persistence",
        messages: [
          { type: "active_goal", value: goal, session_id: "sdk-goal-persistence", uuid: "goal-persist" },
          { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      });

      expect(readPersistedChatState(harness.session.id).claudeGoal).toMatchObject({
        condition: goal.condition,
        iterations: 3,
        setAt: 1_234,
        tokensAtStart: 5_678,
        lastReason: "verification",
        updatedAt: expect.any(Number),
      });

      const rehydrated = createService({ sessionService: harness.sessionService });
      await expect(rehydrated.service.getSessionSummary(harness.session.id)).resolves.toMatchObject({
        claudeGoal: {
          condition: goal.condition,
          iterations: 3,
          setAt: 1_234,
          tokensAtStart: 5_678,
          lastReason: "verification",
          updatedAt: expect.any(Number),
        },
      });
    });

    it("attaches structured Claude tool outputs and enriches Agent and Task results", async () => {
      const toolUseResult = (toolUseId: string, structured: unknown) => ({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUseId, content: `result:${toolUseId}` }],
        },
        tool_use_result: structured,
      });
      const agentOutput = (summary: string, worktreePath: string) => ({
        status: "completed",
        content: [{ type: "text", text: summary }],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
        },
        toolStats: {
          readCount: 1,
          searchCount: 2,
          bashCount: 3,
          editFileCount: 4,
          otherToolCount: 5,
        },
        worktreePath,
        worktreeBranch: "feature/sdk-wiring",
      });
      const { events } = await createClaudeStreamFixture({
        sdkSessionId: "sdk-structured-tool-results",
        messages: [
          {
            type: "assistant",
            message: {
              id: "assistant-tools",
              content: [
                { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } },
                { type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: "needle" } },
                { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } },
                { type: "tool_use", id: "agent-1", name: "Agent", input: { prompt: "Inspect Agent output" } },
                { type: "tool_use", id: "task-1", name: "Task", input: { prompt: "Inspect Task output" } },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
          {
            type: "system",
            subtype: "task_started",
            task_id: "agent-task-1",
            agent_id: "agent-id-1",
            parent_tool_use_id: "agent-1",
            description: "Inspect Agent output",
          },
          {
            type: "system",
            subtype: "task_started",
            task_id: "agent-task-2",
            agent_id: "agent-id-2",
            parent_tool_use_id: "task-1",
            description: "Inspect Task output",
          },
          toolUseResult("bash-1", { timedOutAfterMs: 30_000, backgroundCwdHint: "cwd remains unchanged" }),
          toolUseResult("grep-1", { totalFiles: 7, totalLines: 19 }),
          toolUseResult("read-1", { futureShape: { preserved: true } }),
          toolUseResult("agent-1", agentOutput("Agent completed.", "/tmp/agent-worktree")),
          toolUseResult("task-1", agentOutput("Task completed.", "/tmp/task-worktree")),
          { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      });

      const toolResults = events
        .map((entry) => entry.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "tool_result" }> =>
          event.type === "tool_result");
      expect(toolResults.find((event) => event.itemId === "bash-1")).toMatchObject({
        structured: { timedOutAfterMs: 30_000, backgroundCwdHint: "cwd remains unchanged" },
        timedOutAfterMs: 30_000,
        backgroundCwdHint: "cwd remains unchanged",
      });
      expect(toolResults.find((event) => event.itemId === "grep-1")).toMatchObject({
        grepTotals: { files: 7, lines: 19 },
      });
      expect(toolResults.find((event) => event.itemId === "read-1")?.structured).toEqual({
        futureShape: { preserved: true },
      });

      const subagentResults = events
        .map((entry) => entry.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "subagent_result" }> =>
          event.type === "subagent_result" && event.worktreePath != null);
      expect(subagentResults).toEqual(expect.arrayContaining([
        expect.objectContaining({
          taskId: "agent-task-1",
          worktreePath: "/tmp/agent-worktree",
          worktreeBranch: "feature/sdk-wiring",
          totalTokens: 35,
          toolUseCount: 15,
        }),
        expect.objectContaining({
          taskId: "agent-task-2",
          worktreePath: "/tmp/task-worktree",
          worktreeBranch: "feature/sdk-wiring",
          totalTokens: 35,
          toolUseCount: 15,
        }),
      ]));
    });

    it("throttles live Claude context usage by both time and percentage movement", async () => {
      let now = 0;
      const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
      const messages = [
        {
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: "usage-message",
              usage: {
                input_tokens: 100_000,
                cache_read_input_tokens: 20_000,
                cache_creation_input_tokens: 30_000,
                output_tokens: 0,
              },
            },
          },
        },
        {
          type: "stream_event",
          event: { type: "message_delta", usage: { output_tokens: 20_000 } },
        },
        {
          type: "stream_event",
          event: { type: "message_delta", usage: { output_tokens: 5_000 } },
        },
        {
          type: "stream_event",
          event: { type: "message_delta", usage: { output_tokens: 20_000 } },
        },
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ];
      const timedMessages = (async function* () {
        now = 0;
        yield messages[0]!;
        now = 1_000;
        yield messages[1]!;
        now = 6_000;
        yield messages[2]!;
        now = 7_000;
        yield messages[3]!;
        yield messages[4]!;
      })();
      const materialized: Array<Record<string, unknown>> = [];
      for await (const message of timedMessages) materialized.push(message);
      // Re-apply the intended times from inside the SDK stream rather than while
      // materializing the fixtures.
      let streamCall = 0;
      const send = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-live-usage", slash_commands: [] };
          return;
        }
        now = 0;
        yield materialized[0]!;
        now = 1_000;
        yield materialized[1]!;
        now = 6_000;
        yield materialized[2]!;
        now = 7_000;
        yield materialized[3]!;
        yield materialized[4]!;
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-live-usage",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });
      await service.runSessionTurn({ sessionId: session.id, text: "Measure context." });
      dateNow.mockRestore();

      const usageEvents = events
        .map((entry) => entry.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "context_usage" }> =>
          event.type === "context_usage" && event.origin === "live");
      expect(usageEvents.map((event) => event.usage.percentage)).toEqual([15, 17]);
    });

    it("refreshes authoritative Claude context usage automatically after a settled turn", async () => {
      vi.useFakeTimers();
      try {
        const getContextUsage = vi.fn().mockResolvedValue({
          categories: [
            { name: "System", tokens: 10_000 },
            { name: "Messages", tokens: 40_000 },
          ],
          totalTokens: 50_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          percentage: 25,
          gridRows: [],
          model: "claude-sonnet-5",
        });
        let streamCall = 0;
        let releaseTail!: () => void;
        const tailGate = new Promise<void>((resolve) => { releaseTail = resolve; });
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          ...makeDefaultClaudeSession(),
          getContextUsage,
          stream: vi.fn(() => (async function* () {
            streamCall += 1;
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: "sdk-authoritative-context",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            if (streamCall > 1) await tailGate;
          })()),
        });
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "claude-sonnet-5",
          modelId: "anthropic/claude-sonnet-5",
        });

        const turn = service.runSessionTurn({
          sessionId: session.id,
          text: "Measure context after this turn.",
          timeoutMs: 15_000,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
        await turn;

        await waitForFakeTimers(() => {
          expect(getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
          expect(events.map((entry) => entry.event))
            .toEqual(expect.arrayContaining([
              expect.objectContaining({
                type: "context_usage",
                origin: "snapshot",
                state: "measured",
                usage: expect.objectContaining({ percentage: 25 }),
              }),
            ]));
        });
        releaseTail();
        await service.dispose({ sessionId: session.id });
      } finally {
        vi.useRealTimers();
      }
    });

    it("requests a full Claude context snapshot after compact and a summary after settle", async () => {
      const getContextUsage = vi.fn().mockResolvedValue({
        categories: [{ name: "Messages", tokens: 40_000 }],
        totalTokens: 40_000,
        maxTokens: 200_000,
        rawMaxTokens: 200_000,
        percentage: 20,
        gridRows: [],
        model: "claude-sonnet-5",
      });
      await createClaudeStreamFixture({
        sdkSessionId: "sdk-context-detail",
        getContextUsage,
        messages: [
          {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 90_000, post_tokens: 40_000 },
          },
          { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      });
      expect(getContextUsage).toHaveBeenCalledWith({ detail: "full" });
      expect(getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
    });

    it("records Claude modelUsage extras on done without changing outputTokens", async () => {
      const events = await runClaudeStreamFixture({
        sdkSessionId: "sdk-model-usage-extras",
        messages: [
          {
            type: "result",
            subtype: "success",
            is_error: false,
            usage: { input_tokens: 10, output_tokens: 20 },
            total_cost_usd: 0.01,
            queued_turn_count: 0,
            user_message_uuid: "user-msg-result",
            modelUsage: {
              "claude-sonnet-5": {
                inputTokens: 10,
                outputTokens: 20,
                thinkingTokens: 7,
                costUSD: 0.01,
                costBasis: "list",
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                webSearchRequests: 0,
                contextWindow: 200_000,
                maxOutputTokens: 16_000,
              },
            },
          },
        ],
      });
      const done = events
        .map((entry) => entry.event)
        .find((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> => event.type === "done");
      expect(done).toMatchObject({
        type: "done",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          thinkingTokens: 7,
        },
        costUsd: 0.01,
        costBasis: "list",
        queuedTurnCount: 0,
        userMessageUuid: "user-msg-result",
      });
      // One ModelUsage key naming the requested model is not a different served model.
      expect(done?.servedModel).toBeUndefined();
    });

    it("reports Claude's served model, 1h cache writes, and API-key account on done", async () => {
      const events = await runClaudeStreamFixture({
        sdkSessionId: "sdk-served-model",
        messages: [
          {
            type: "system",
            subtype: "init",
            session_id: "sdk-served-model",
            model: "claude-sonnet-5",
            apiKeySource: "ANTHROPIC_API_KEY",
            slash_commands: [],
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            usage: {
              input_tokens: 10,
              output_tokens: 920,
              cache_creation_input_tokens: 500,
              cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
            },
            modelUsage: {
              // The requested model answered little; a fallback carried the turn.
              "claude-sonnet-5": { inputTokens: 5, outputTokens: 20 },
              "claude-haiku-4-5": { inputTokens: 5, outputTokens: 900 },
            },
          },
        ],
      });
      const done = events
        .map((entry) => entry.event)
        .find((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> => event.type === "done");
      expect(done?.usage?.cacheWrite1hTokens).toBe(300);
      expect(done?.servedModel).toBe("claude-haiku-4-5");
      expect(done?.account).toMatchObject({ provider: "claude", kind: "api_key" });
      // An API-key turn is not billed to the login, so its email and plan stay off.
      expect(done?.account?.email).toBeUndefined();
    });

    it("gives the usage ledger every figure a Claude turn reports", async () => {
      const { ledger, rows } = createMemoryTurnUsageLedger();
      const requestStart = (usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
        type: "stream_event",
        ...extra,
        event: { type: "message_start", message: { id: `msg-${Object.values(usage).join("-")}`, usage } },
      });
      const { events, session } = await createClaudeStreamFixture({
        sdkSessionId: "sdk-ledger-complete",
        serviceOverrides: { turnUsageLedger: ledger },
        messages: [
          { type: "system", subtype: "init", session_id: "sdk-ledger-complete", model: "claude-sonnet-5", apiKeySource: "none", slash_commands: [] },
          requestStart({ input_tokens: 10, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 200, output_tokens: 1 }),
          // A subagent's request is its own; it is not a request of this turn.
          requestStart({ input_tokens: 90_000, output_tokens: 1 }, { parent_tool_use_id: "toolu_subagent" }),
          requestStart({ input_tokens: 4, cache_read_input_tokens: 5_200, cache_creation_input_tokens: 150, output_tokens: 1 }),
          {
            type: "result",
            subtype: "success",
            is_error: false,
            total_cost_usd: 0.0421,
            usage: {
              input_tokens: 14,
              output_tokens: 600,
              cache_read_input_tokens: 10_200,
              cache_creation_input_tokens: 350,
              cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 300 },
            },
            modelUsage: {
              "claude-sonnet-5": {
                inputTokens: 14,
                outputTokens: 600,
                cacheReadInputTokens: 10_200,
                cacheCreationInputTokens: 350,
                webSearchRequests: 0,
                costUSD: 0.0421,
                contextWindow: 1_000_000,
                maxOutputTokens: 64_000,
                provider: "firstParty",
                costBasis: "list",
              },
            },
          },
        ],
      });
      const done = events
        .map((entry) => entry.event)
        .find((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> => event.type === "done");
      expect(done).toMatchObject({
        status: "completed",
        usage: {
          inputTokens: 14,
          outputTokens: 600,
          cacheReadTokens: 10_200,
          cacheCreationTokens: 350,
          cacheWrite1hTokens: 300,
          // The last main-thread request's whole input side.
          contextTokens: 5_354,
          contextWindow: 1_000_000,
          requestCount: 2,
        },
        costUsd: 0.0421,
        costSource: "list_price",
        costBasis: "list",
        account: { provider: "claude", kind: "subscription" },
      });
      expect(done?.servedModel).toBeUndefined();
      expect(done?.account).not.toHaveProperty("routedAway");

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sessionId: session.id,
        provider: "claude",
        requestedModel: "anthropic/claude-sonnet-5",
        servedModel: null,
        inputTokens: 14,
        outputTokens: 600,
        cacheReadTokens: 10_200,
        cacheWriteTokens: 350,
        cacheWrite1hTokens: 300,
        contextTokens: 5_354,
        contextWindow: 1_000_000,
        requestCount: 2,
        costUsd: 0.0421,
        costSource: "list_price",
        usageConfidence: "measured",
        account: { provider: "claude", kind: "subscription" },
      });
    });

    it.each([
      { name: "an API key", apiKeySource: "ANTHROPIC_API_KEY", provider: "firstParty", env: {}, kind: "api_key", routedAway: undefined },
      { name: "Bedrock", apiKeySource: "none", provider: "bedrock", env: {}, kind: "unknown", routedAway: "cloud" },
      {
        name: "a redirected endpoint",
        apiKeySource: "none",
        provider: "firstParty",
        env: { ANTHROPIC_BASE_URL: "https://gateway.example" },
        kind: "unknown",
        routedAway: "endpoint",
      },
    ])("names who paid for a Claude turn on $name", async ({ apiKeySource, provider, env, kind, routedAway }) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      try {
        const { ledger, rows } = createMemoryTurnUsageLedger();
        const { events } = await createClaudeStreamFixture({
          sdkSessionId: `sdk-ledger-account-${provider}-${apiKeySource}`,
          serviceOverrides: { turnUsageLedger: ledger },
          messages: [
            { type: "system", subtype: "init", session_id: "sdk-ledger-account", model: "claude-sonnet-5", apiKeySource, slash_commands: [] },
            {
              type: "result",
              subtype: "success",
              is_error: false,
              total_cost_usd: 0.001,
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: { "claude-sonnet-5": { inputTokens: 1, outputTokens: 1, provider } },
            },
          ],
        });
        const done = events
          .map((entry) => entry.event)
          .find((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> => event.type === "done");
        expect(done?.account).toMatchObject({ provider: "claude", kind });
        expect(done?.account?.routedAway).toBe(routedAway);
        expect(rows[0]?.account).toMatchObject({ kind });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("counts each idle Claude turn's own requests and cost", async () => {
      const { ledger, rows } = createMemoryTurnUsageLedger();
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let releaseIdle!: () => void;
      const releaseIdlePromise = new Promise<void>((resolve) => { releaseIdle = resolve; });
      const requestStart = (id: string, input: number) => ({
        type: "stream_event",
        event: { type: "message_start", message: { id, usage: { input_tokens: input, output_tokens: 1 } } },
      });
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-idle-ledger", slash_commands: [] };
            return;
          }
          yield { type: "result", subtype: "success", is_error: false, session_id: "sdk-idle-ledger" };
          await releaseIdlePromise;
          // Background turn one: two requests.
          yield requestStart("idle-1a", 100);
          yield requestStart("idle-1b", 120);
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            total_cost_usd: 0.02,
            usage: { input_tokens: 220, output_tokens: 8 },
            session_id: "sdk-idle-ledger",
          };
          // Background turn two: one request of its own.
          yield requestStart("idle-2a", 140);
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            total_cost_usd: 0.01,
            usage: { input_tokens: 140, output_tokens: 4 },
            session_id: "sdk-idle-ledger",
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-idle-ledger",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        turnUsageLedger: ledger,
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await service.runSessionTurn({ sessionId: session.id, text: "Start background work." });
      releaseIdle();

      await waitForCondition(
        () => events.filter((event) => event.event.type === "done" && event.event.turnId.startsWith("claude-idle-")).length === 2,
        "two idle Claude turns",
      );
      const idleDone = events
        .map((entry) => entry.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> =>
          event.type === "done" && event.turnId.startsWith("claude-idle-"));
      expect(idleDone[0]).toMatchObject({
        usage: { inputTokens: 220, requestCount: 2, contextTokens: 120 },
        costUsd: 0.02,
        costSource: "list_price",
      });
      expect(idleDone[1]).toMatchObject({
        usage: { inputTokens: 140, requestCount: 1, contextTokens: 140 },
        costUsd: 0.01,
        costSource: "list_price",
      });
      expect(rows.filter((row) => row.turnId.startsWith("claude-idle-")).map((row) => row.requestCount)).toEqual([2, 1]);
      service.forceDisposeAll();
    });

    it("stamps user_message_uuid from the first assistant frame onto done", async () => {
      const events = await runClaudeStreamFixture({
        sdkSessionId: "sdk-early-user-message-uuid",
        messages: [
          {
            type: "assistant",
            user_message_uuid: "user-msg-early",
            message: {
              content: [{ type: "text", text: "hello" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        ],
      });
      const done = events
        .map((entry) => entry.event)
        .find((event): event is Extract<AgentChatEventEnvelope["event"], { type: "done" }> => event.type === "done");
      expect(done?.userMessageUuid).toBe("user-msg-early");
    });

    it("warns when Claude reports this client's hooks were ignored", async () => {
      const initializationResult = vi.fn().mockResolvedValue({ hooks_applied: false });
      const onClaudeHooksIgnored = vi.fn();
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
        initializationResult,
      });
      const { service, logger } = createService({ onClaudeHooksIgnored });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });
      await service.sendMessage({ sessionId: session.id, text: "hello" });
      await vi.waitFor(() => {
        expect(onClaudeHooksIgnored).toHaveBeenCalledWith({ sessionId: session.id });
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.claude_hooks_ignored",
        expect.objectContaining({ sessionId: session.id }),
      );
    });

    it("warns and records the plugins-ignored fact when the CLI applies no plugin", async () => {
      const initializationResult = vi.fn().mockResolvedValue({ hooks_applied: true, plugins_applied: false });
      const onClaudePluginsIgnored = vi.fn();
      const onClaudeHooksIgnored = vi.fn();
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
        initializationResult,
      });
      const { service, logger } = createService({ onClaudePluginsIgnored, onClaudeHooksIgnored });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });
      await service.sendMessage({ sessionId: session.id, text: "hello" });
      await vi.waitFor(() => {
        expect(onClaudePluginsIgnored).toHaveBeenCalledWith({ sessionId: session.id });
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.claude_plugins_ignored",
        expect.objectContaining({ sessionId: session.id }),
      );
      // Plugins and hooks are independent reports; a plugin miss must not be
      // reported as a hooks miss.
      expect(logger.warn).not.toHaveBeenCalledWith("agent_chat.claude_hooks_ignored", expect.anything());
      expect(onClaudeHooksIgnored).not.toHaveBeenCalled();
    });

    it("logs why the CLI could not start when a result frame carries a startup failure", async () => {
      const harness = await createClaudeStreamFixture({
        sdkSessionId: "sdk-startup-failure",
        messages: [
          {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            startup_failure_reason: "cwd_unavailable",
            errors: ["cwd unavailable"],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        ],
      });
      await vi.waitFor(() => {
        expect(harness.logger.warn).toHaveBeenCalledWith(
          "agent_chat.claude_startup_failure",
          expect.objectContaining({ reason: "cwd_unavailable" }),
        );
      });
    });

    it("lets natural compaction suppress the 97% fallback", async () => {
      const harness = await createClaudeStreamFixture({
        sdkSessionId: "sdk-natural-compact",
        messages: [
          {
            type: "stream_event",
            event: {
              type: "message_start",
              message: { id: "natural-usage", usage: { input_tokens: 980_000, output_tokens: 0 } },
            },
          },
          { type: "system", subtype: "status", status: "compacting" },
          {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 980_000, post_tokens: 500_000 },
          },
          { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      });

      expect(harness.send.mock.calls.map(([message]) => claudeInputText(message))).not.toContain("/compact");
      expect(harness.logger.info).toHaveBeenCalledWith(
        "agent_chat.claude_context_compaction_observed",
        expect.objectContaining({ trigger: "natural", occupancyPctAtTrigger: 98 }),
      );
    });

    it("starts a fresh guardrail episode after occupancy drops below 80%", async () => {
      const harness = await createClaudeStreamFixture({
        sdkSessionId: "sdk-guardrail-episode-reset",
        messages: [
          {
            type: "stream_event",
            event: {
              type: "message_start",
              message: { id: "first-episode", usage: { input_tokens: 920_000, output_tokens: 0 } },
            },
          },
          { type: "system", subtype: "status", status: "compacting" },
          {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 920_000, post_tokens: 700_000 },
          },
          {
            type: "stream_event",
            event: {
              type: "message_start",
              message: { id: "second-episode", usage: { input_tokens: 970_000, output_tokens: 0 } },
            },
          },
          { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      });

      await vi.waitFor(() => {
        expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
          .toHaveLength(1);
      });
    });

    it("issues one fallback compact at a 97% turn boundary", async () => {
      const harness = await createClaudeStreamFixture({
        sdkSessionId: "sdk-fallback-compact",
        messages: [
          {
            type: "stream_event",
            event: {
              type: "message_start",
              message: { id: "fallback-usage", usage: { input_tokens: 970_000, output_tokens: 0 } },
            },
          },
          { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      });

      await vi.waitFor(() => {
        expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
          .toHaveLength(1);
      });
      expect(harness.events.find((entry) =>
        entry.event.type === "context_compact"
        && entry.event.trigger === "ade_fallback"
        && entry.event.state === "started"
      )?.event).toMatchObject({ compactionId: expect.any(String) });
    });

    it("claims a compaction only after the SDK confirms the boundary", async () => {
      const harness = await createClaudeCompactionFixture({
        sdkSessionId: "sdk-compact-confirmed",
        first: [{
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "prompt_too_long",
          errors: ["prompt is too long for this context window"],
          usage: { input_tokens: 1, output_tokens: 0 },
        }],
        afterCompact: [
          {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "manual", pre_tokens: 900_000, post_tokens: 120_000 },
          },
          { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      });

      await vi.waitFor(() => {
        expect(claudeNoticeMessages(harness.events))
          .toContain("context overflowed — compacted; please re-send your last message");
      }, { timeout: 5_000 });
      expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
        .toHaveLength(1);
    });

    it("says it could not compact when the SDK has too few messages to compact", async () => {
      const harness = await createClaudeCompactionFixture({
        sdkSessionId: "sdk-compact-unavailable",
        first: [{
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "prompt_too_long",
          errors: ["prompt is too long for this context window"],
          usage: { input_tokens: 1, output_tokens: 0 },
        }],
        afterCompact: [{
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Not enough messages to compact."],
          usage: { input_tokens: 1, output_tokens: 0 },
        }],
      });

      await vi.waitFor(() => {
        expect(claudeNoticeMessages(harness.events))
          .toContain("Claude could not compact this conversation. Start a new chat or hand off with a shorter history.");
      }, { timeout: 5_000 });
      // The false claim is the bug: ADE told the user to re-send into the same
      // overflow after a compaction that never happened.
      expect(claudeNoticeMessages(harness.events))
        .not.toContain("context overflowed — compacted; please re-send your last message");
      // One refusal is the answer; ADE must not ask again.
      expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
        .toHaveLength(1);
    });

    it("re-arms the fallback compaction after a later turn completes normally", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const gate = (match: string) => {
        let resolve: () => void = () => {};
        const promise = new Promise<void>((r) => { resolve = r; });
        return { match, promise, resolve };
      };
      const compactSent = gate("/compact");
      const secondTurnSent = gate("turn two");
      const thirdTurnSent = gate("turn three");
      const send = vi.fn(async (message: unknown) => {
        const text = claudeInputText(message);
        for (const entry of [compactSent, secondTurnSent, thirdTurnSent]) {
          if (text === entry.match || text.includes(entry.match)) entry.resolve();
        }
      });
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-compact-rearm", slash_commands: [] };
          return;
        }
        // Turn one overflows, so ADE asks for a compaction.
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "prompt_too_long",
          errors: ["prompt is too long for this context window"],
          usage: { input_tokens: 1, output_tokens: 0 },
        };
        // The SDK refuses: one exchange is not enough to compact.
        await compactSent.promise;
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Not enough messages to compact."],
          usage: { input_tokens: 1, output_tokens: 0 },
        };
        // Turn two completes normally and the conversation has grown.
        await secondTurnSent.promise;
        yield {
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "rearm-low", usage: { input_tokens: 1_000, output_tokens: 0 } },
          },
        };
        yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
        // Turn three ends at the fallback threshold.
        await thirdTurnSent.promise;
        yield {
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "rearm-high", usage: { input_tokens: 970_000, output_tokens: 0 } },
          },
        };
        yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-compact-rearm",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({ sessionId: session.id, text: "turn one" });
      await vi.waitFor(() => {
        expect(claudeNoticeMessages(events))
          .toContain("Claude could not compact this conversation. Start a new chat or hand off with a shorter history.");
      }, { timeout: 5_000 });

      await service.runSessionTurn({ sessionId: session.id, text: "turn two" });
      await service.runSessionTurn({ sessionId: session.id, text: "turn three" });

      // The refusal described one moment, not the session: a grown conversation
      // must be compactable again.
      await vi.waitFor(() => {
        expect(send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
          .toHaveLength(2);
      }, { timeout: 5_000 });
    });

    it("reports a compaction the query teardown threw away", async () => {
      const events: AgentChatEventEnvelope[] = [];
      // The next turn cannot set its permission mode, so ADE rebuilds the query —
      // closing the input pump the /compact is still queued on.
      let failPermissionMode = false;
      const setPermissionMode = vi.fn(async () => {
        if (!failPermissionMode) return;
        failPermissionMode = false;
        throw new Error("claude query is gone");
      });
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-compact-abandoned", slash_commands: [] };
          return;
        }
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "prompt_too_long",
          errors: ["prompt is too long for this context window"],
          usage: { input_tokens: 1, output_tokens: 0 },
        };
        await new Promise<void>(() => {});
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-compact-abandoned",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({ sessionId: session.id, text: "first message" });
      await vi.waitFor(() => {
        expect(send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
          .toHaveLength(1);
      }, { timeout: 5_000 });

      failPermissionMode = true;
      await service.runSessionTurn({ sessionId: session.id, text: "second message" }).catch(() => undefined);

      await vi.waitFor(() => {
        expect(claudeNoticeMessages(events))
          .toContain("Claude could not compact this conversation. Its session restarted before the compaction ran.");
      }, { timeout: 5_000 });
      // The held notice never fires: no compaction happened.
      expect(claudeNoticeMessages(events))
        .not.toContain("context overflowed — compacted; please re-send your last message");
      expect(events.find((entry) => entry.event.type === "context_compact"
        && entry.event.state === "failed")?.event).toMatchObject({ failReason: "teardown" });
    });

    it("recovers once from prompt_too_long without replaying the failed user message", async () => {
      const harness = await createClaudeStreamFixture({
        sdkSessionId: "sdk-overflow-recovery",
        messages: [{
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "prompt_too_long",
          errors: ["prompt is too long for this context window"],
          usage: { input_tokens: 1, output_tokens: 0 },
        }],
      });

      await vi.waitFor(() => {
        expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
          .toHaveLength(1);
      });
      // The SDK has not confirmed a boundary, so ADE must not say it compacted.
      expect(claudeNoticeMessages(harness.events))
        .not.toContain("context overflowed — compacted; please re-send your last message");
      expect(harness.send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) =>
        text.includes("Exercise Claude streaming text."))).toHaveLength(1);
    });

    it("does not duplicate Claude thinking when the final assistant message repeats streamed content", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let reasoningCountAfterDelta = -1;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-thinking",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "thinking_delta",
              thinking: "Checking both imports before editing.",
            },
          },
        };
        await new Promise((resolve) => setTimeout(resolve, 120));
        reasoningCountAfterDelta = events.filter((event) => event.event.type === "reasoning").length;
        yield {
          type: "assistant",
          message: {
            content: [{ type: "thinking", thinking: "Checking both imports before editing." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-thinking",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Resolve the PR comments.",
      });

      const reasoningEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "reasoning" }> => event.type === "reasoning");
      expect(reasoningEvents.map((event) => event.text)).toEqual(["Checking both imports before editing."]);
      // The streamed thinking_delta must be what created the reasoning row — not the
      // final assistant message (which would also produce a row if dedupe broke).
      expect(reasoningCountAfterDelta).toBe(1);
      expect(events.some((event) => event.event.type === "activity" && event.event.activity === "thinking")).toBe(true);
      const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        includePartialMessages?: boolean;
        agentProgressSummaries?: boolean;
        forwardSubagentText?: boolean;
      } | undefined;
      expect(sessionOpts).toEqual(expect.objectContaining({
        includePartialMessages: true,
        agentProgressSummaries: true,
        forwardSubagentText: false,
      }));
    });

    it("does not duplicate Claude thinking when the snapshot reports a different content index", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-thinking-index",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "thinking", thinking: "" },
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "thinking_delta",
              thinking: "Checking both imports before editing.",
            },
          },
        };
        await new Promise((resolve) => setTimeout(resolve, 120));
        // The SDK strips a redacted/empty thinking block from the snapshot, so
        // the completed block lands at index 0 although the stream said 1.
        yield {
          type: "assistant",
          message: {
            content: [{ type: "thinking", thinking: "Checking both imports before editing." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-thinking-index",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Resolve the PR comments.",
      });

      const reasoningEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "reasoning" }> => event.type === "reasoning");
      expect(reasoningEvents.map((event) => event.text)).toEqual(["Checking both imports before editing."]);
    });

    it("groups Claude text deltas by the stable message id and suppresses the repeated snapshot", async () => {
      const messageId = "msg-stable-stream";
      const fragments = ["Stable ", "Claude ", "text ", "stays ", "whole."];
      const fullText = fragments.join("");
      const events = await runClaudeStreamFixture({
        sdkSessionId: "sdk-session-stable-stream",
        messages: [
          {
            type: "stream_event",
            uuid: "wire-message-start",
            event: {
              type: "message_start",
              message: { id: messageId, usage: { input_tokens: 1, output_tokens: 0 } },
            },
          },
          ...fragments.map((text, index) => ({
            type: "stream_event",
            uuid: `wire-delta-${index + 1}`,
            event: {
              type: "content_block_delta",
              index: 0,
              message: { id: messageId },
              delta: { type: "text_delta", text },
            },
          })),
          {
            type: "assistant",
            uuid: "wire-assistant-snapshot",
            supersedes: ["superseded-wire-message"],
            message: {
              id: messageId,
              content: [{ type: "text", text: fullText }],
              usage: { input_tokens: 1, output_tokens: 5 },
            },
          },
          { type: "result", usage: { input_tokens: 1, output_tokens: 5 } },
        ],
      });

      const textEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
      expect(textEvents.map((event) => event.text).join("")).toBe(fullText);
      expect(new Set(textEvents.map((event) => event.messageId))).toEqual(new Set([messageId]));

      const retraction = events.find((event) => event.event.type === "transcript_retraction");
      expect(retraction?.event).toMatchObject({
        type: "transcript_retraction",
        replacementMessageId: messageId,
      });
    });

    it("keeps sequential Claude text blocks ordered under one stable message id", async () => {
      const messageId = "msg-stable-blocks";
      const events = await runClaudeStreamFixture({
        sdkSessionId: "sdk-session-stable-blocks",
        messages: [
          {
            type: "stream_event",
            uuid: "wire-blocks-start",
            event: {
              type: "message_start",
              message: { id: messageId, usage: { input_tokens: 1, output_tokens: 0 } },
            },
          },
          {
            type: "stream_event",
            uuid: "wire-block-0-delta-1",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "First " },
            },
          },
          {
            type: "stream_event",
            uuid: "wire-block-0-delta-2",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "block. " },
            },
          },
          {
            type: "stream_event",
            uuid: "wire-block-1-delta-1",
            event: {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text: "Second " },
            },
          },
          {
            type: "stream_event",
            uuid: "wire-block-1-delta-2",
            event: {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text: "block." },
            },
          },
          {
            type: "assistant",
            uuid: "wire-blocks-snapshot",
            message: {
              id: messageId,
              content: [
                { type: "text", text: "First block. " },
                { type: "text", text: "Second block." },
              ],
              usage: { input_tokens: 1, output_tokens: 4 },
            },
          },
          { type: "result", usage: { input_tokens: 1, output_tokens: 4 } },
        ],
      });

      const textEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
      expect(textEvents.map((event) => event.text).join("")).toBe("First block. Second block.");
      expect(textEvents.every((event) => event.messageId === messageId)).toBe(true);
    });

    it("falls back to Claude wire UUIDs when streamed text has no stable message id", async () => {
      const events = await runClaudeStreamFixture({
        sdkSessionId: "sdk-session-wire-fallback",
        messages: [
          {
            type: "stream_event",
            uuid: "wire-fallback-start",
            event: { type: "message_start", message: {} },
          },
          {
            type: "stream_event",
            uuid: "wire-fallback-delta",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Fallback text." },
            },
          },
          {
            type: "assistant",
            uuid: "wire-fallback-snapshot",
            message: {
              content: [
                { type: "text", text: "Fallback text." },
                { type: "text", text: " Snapshot fallback." },
              ],
              usage: { input_tokens: 1, output_tokens: 2 },
            },
          },
          { type: "result", usage: { input_tokens: 1, output_tokens: 2 } },
        ],
      });

      const textEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
      expect(textEvents.map((event) => event.text).join("")).toBe("Fallback text. Snapshot fallback.");
      expect(textEvents.map((event) => event.messageId)).toEqual([
        "wire-fallback-delta",
        "wire-fallback-snapshot",
      ]);
    });

    it("does not duplicate Claude text when an assistant snapshot repeats id-less streamed deltas", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-text-dedupe",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Got it. Let me check" },
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: " the desktop app structure." },
          },
        };
        yield {
          type: "assistant",
          message: {
            id: "msg-text-dedupe",
            content: [{ type: "text", text: "Got it. Let me check the desktop app structure." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-text-dedupe",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Resolve the PR comments.",
      });

      const textEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
      expect(textEvents.map((event) => event.text)).toEqual(["Got it. Let me check the desktop app structure."]);
    });

    it("does not duplicate Claude text when the final assistant snapshot extends streamed deltas", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-text-suffix",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "I checked the renderer" },
          },
        };
        yield {
          type: "assistant",
          message: {
            id: "msg-text-suffix",
            content: [{ type: "text", text: "I checked the renderer and added focused tests." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-text-suffix",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Resolve the PR comments.",
      });

      const textEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
      expect(textEvents.map((event) => event.text).join("")).toBe("I checked the renderer and added focused tests.");
    });

    it("keeps Claude streamed text dedupable when a tool-use start arrives before the assistant snapshot", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-text-tool-dedupe",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Let me check the desktop app." },
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: {
              type: "tool_use",
              id: "tool-use-after-text",
              name: "Bash",
              input: { command: "ls" },
            },
          },
        };
        yield {
          type: "assistant",
          message: {
            id: "msg-text-tool-dedupe",
            content: [
              { type: "text", text: "Let me check the desktop app." },
              { type: "tool_use", id: "tool-use-after-text", name: "Bash", input: { command: "ls" } },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-text-tool-dedupe",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Resolve the PR comments.",
      });

      const textEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
      expect(textEvents.map((event) => event.text)).toEqual(["Let me check the desktop app."]);
      expect(events.some((event) => event.event.type === "tool_call" && event.event.tool === "Bash")).toBe(true);
    });

    it("re-emits a Claude tool_call with parsed args once the input has streamed in after content_block_start", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-streamed-args",
            slash_commands: [],
          };
          return;
        }

        // Stream path: tool_use starts with NO input; the input arrives via
        // input_json_delta and only parses at content_block_stop. Without the
        // enriched re-emit the persisted tool_call keeps args:{} forever.
        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tool-use-streamed-args", name: "Read", input: {} },
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"apps/desk" },
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "top/src/a.ts\"}" },
          },
        };
        yield {
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-streamed-args",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Read the file.",
      });

      const toolCalls = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "tool_call" }> => event.type === "tool_call")
        .filter((event) => event.tool === "Read");
      expect(toolCalls).toHaveLength(2);
      // Same itemId so renderers collapse both into a single entry.
      expect(new Set(toolCalls.map((event) => event.itemId)).size).toBe(1);
      expect(toolCalls[0]?.args).toEqual({});
      expect(toolCalls[1]?.args).toEqual({ file_path: "apps/desktop/src/a.ts" });
    });

    it("normalizes Claude server web and MCP blocks into compact activity lifecycles", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-structured-activity",
            slash_commands: [],
          };
          return;
        }
        yield {
          type: "assistant",
          message: {
            id: "msg-structured-activity",
            content: [
              {
                type: "server_tool_use",
                id: "search-1",
                name: "web_search",
                input: { query: "ADE transcript UI" },
              },
              {
                type: "web_search_tool_result",
                tool_use_id: "search-1",
                content: [{
                  type: "web_search_result",
                  title: "ADE",
                  url: "https://example.com/ade",
                  encrypted_content: "opaque",
                }],
              },
              {
                type: "mcp_tool_use",
                id: "mcp-1",
                server_name: "github",
                name: "search_issues",
                input: { query: "label:bug" },
              },
              {
                type: "mcp_tool_result",
                tool_use_id: "mcp-1",
                is_error: false,
                content: [{ type: "text", text: "Issue 1" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-structured-activity",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Research the transcript UI.",
      });

      expect(events.filter((event) =>
        event.event.type === "web_search" && event.event.itemId === "search-1"
      ).map((event) => event.event.type === "web_search" ? event.event.status : null)).toEqual([
        "running",
        "completed",
      ]);
      expect(events.filter((event) =>
        (event.event.type === "tool_call" || event.event.type === "tool_result")
        && event.event.itemId === "mcp-1"
      ).map((event) => event.event.type)).toEqual(["tool_call", "tool_result"]);
      expect(events.find((event) =>
        event.event.type === "tool_call" && event.event.itemId === "mcp-1"
      )?.event).toMatchObject({
        tool: "github:search_issues",
        mcp: { server: "github", tool: "search_issues" },
      });
    });

    it("emits completed Claude tool_result rows when tool_use_summary arrives", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-tool-summary",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-use-1",
              name: "Read",
              input: { file_path: "apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx" },
            },
          },
        };
        yield {
          type: "tool_use_summary",
          summary: "Checked the shared chat renderer",
          preceding_tool_use_ids: ["tool-use-1"],
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-tool-summary",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the shared chat renderer.",
      });

      const completedToolResults = events.filter((event) =>
        event.event.type === "tool_result"
        && event.event.itemId === "tool-use-1"
        && event.event.status === "completed"
      );

      expect(completedToolResults).toHaveLength(1);
      expect(completedToolResults[0]!.event.type).toBe("tool_result");
      if (completedToolResults[0]!.event.type !== "tool_result") {
        throw new Error("Expected tool_result");
      }
      expect(completedToolResults[0]!.event.result).toMatchObject({
        synthetic: true,
        source: "claude_tool_use_summary",
        summary: "Checked the shared chat renderer",
      });
    });

    it("emits completed Claude tool_result rows for open tools when the turn ends without a tool summary", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-tool-fallback",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-use-2",
              name: "Read",
              input: { file_path: "apps/desktop/src/renderer/components/chat/ChatWorkLogBlock.tsx" },
            },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-tool-fallback",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the grouped work log renderer.",
      });

      const completedToolResults = events.filter((event) =>
        event.event.type === "tool_result"
        && event.event.itemId === "tool-use-2"
        && event.event.status === "completed"
      );

      expect(completedToolResults).toHaveLength(1);
      expect(completedToolResults[0]!.event.type).toBe("tool_result");
      if (completedToolResults[0]!.event.type !== "tool_result") {
        throw new Error("Expected tool_result");
      }
      expect(completedToolResults[0]!.event.result).toMatchObject({
        synthetic: true,
        source: "claude_turn_finalization",
        finalTurnStatus: "completed",
      });
    });

    it("allows generic Claude tools without manufacturing updatedInput", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield { type: "system", subtype: "init", session_id: "sdk-can-use-tool", slash_commands: [] };
        })()),
        close: vi.fn(),
        sessionId: "sdk-can-use-tool",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);
      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });
      await vi.waitFor(() => expect(claudeSdkCreateSessionCompat).toHaveBeenCalled());
      const options = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
        canUseTool: (
          tool: string,
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };

      const result = await options.canUseTool(
        "Read",
        { file_path: "README.md" },
        { signal: new AbortController().signal, toolUseID: "read-tool-1" },
      );

      expect(result).toEqual({ behavior: "allow" });
      expect(result).not.toHaveProperty("updatedInput");
    });

    it("suppresses the 'tool calls were denied' notice for tool_use_ids resolved inline via canUseTool", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let service: ReturnType<typeof createService>["service"];
      let sessionId = "";

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-denial-suppression",
            slash_commands: [],
          };
          return;
        }

        const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;

        // Approve plan exit through canUseTool — this records the tool_use_id in
        // runtime.resolvedToolUseIds so the SDK's later permission_denials echo
        // for the same id should NOT surface a "denied this turn" notice.
        await sessionOpts.canUseTool("EnterPlanMode", {}, {
          signal: new AbortController().signal,
          toolUseID: "tool-enter-plan-suppress",
        });
        const exitPromise = sessionOpts.canUseTool("ExitPlanMode", {
          planDescription: "Ship the approved plan.",
        }, {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-plan-suppress",
        });
        const approvalEvent = await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope & {
            event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
          } =>
            event.event.type === "approval_request"
            && typeof ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind) === "string"
            && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
        );
        await service.approveToolUse({
          sessionId,
          itemId: approvalEvent.event.itemId,
          decision: "accept",
        });
        await exitPromise;

        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-exit-plan-suppress",
              name: "ExitPlanMode",
              input: { planDescription: "Ship the approved plan." },
            },
          },
        };
        yield {
          type: "system",
          subtype: "permission_denied",
          session_id: "sdk-session-denial-suppression",
          tool_name: "ExitPlanMode",
          tool_use_id: "tool-exit-plan-suppress",
          decision_reason: "echoed denial from the SDK",
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
          permission_denials: [
            // Resolved inline — must not surface a notice.
            { tool_name: "ExitPlanMode", tool_use_id: "tool-exit-plan-suppress" },
            // Genuine denial — must still surface a notice.
            { tool_name: "Bash", tool_use_id: "tool-bash-unresolved" },
          ],
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-denial-suppression",
        setPermissionMode,
      } as any);

      ({ service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      }));

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });
      sessionId = session.id;

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Plan, approve, and report.",
      });

      const denialNotices = events
        .map((envelope) => envelope.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
          event.type === "system_notice" && typeof event.message === "string" && event.message.includes("denied this turn"),
        );

      expect(denialNotices).toHaveLength(1);
      expect(denialNotices[0]!.message).toContain("Bash");
      expect(denialNotices[0]!.message).not.toContain("ExitPlanMode");
      expect(denialNotices[0]!.message).toMatch(/^1 tool call was denied this turn/);
      expect(events.filter((envelope) =>
        envelope.event.type === "tool_result"
        && envelope.event.itemId === "tool-exit-plan-suppress"
        && envelope.event.status === "failed"
      )).toHaveLength(0);
    });
  });
});
