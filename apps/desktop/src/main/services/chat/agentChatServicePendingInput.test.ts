import {
  AgentChatEventEnvelope,
  claudeSdkCreateSessionCompat,
  createAgentChatService,
  createService,
  mockState,
  path,
  readPersistedChatState,
  waitForEvent,
  writePersistedChatState,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("pending input", () => {
    it("bridges Claude AskUserQuestion through ADE's question UI", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let permissionResult: Record<string, unknown> | null = null;

      const askInput = {
        questions: [
          {
            question: "What should we do about the two task list views?",
            header: "Task views",
            options: [
              {
                label: "Remove the TurnSummaryCard tasks",
                description: "Keep only the inline task list.",
                preview: "<div><strong>Inline only</strong><p>Compact stream, no bottom summary card.</p></div>",
              },
              {
                label: "Keep both, improve summary",
                description: "Keep both task views, but make the summary less intrusive.",
                preview: "<div><strong>Hybrid</strong><p>Inline progress plus a compact summary card.</p></div>",
              },
            ],
            multiSelect: false,
          },
          {
            question: "Should the inline task list pin while tasks are active?",
            header: "Inline pinning",
            options: [
              { label: "Yes, pin while active" },
              { label: "No, let it scroll" },
            ],
            multiSelect: false,
          },
        ],
      };

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-ask-user",
            slash_commands: [],
          };
          return;
        }

        const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
        permissionResult = await sessionOpts.canUseTool("AskUserQuestion", askInput, {
          signal: new AbortController().signal,
          toolUseID: "tool-ask-user-1",
        });

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Thanks, I can continue now." }],
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
        sessionId: "sdk-session-ask-user",
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
        permissionMode: "plan",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Figure out the task list UX and ask any clarifying questions you need.",
      });

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && typeof (event.event.detail as { request?: { providerMetadata?: { tool?: string } } } | undefined)?.request?.providerMetadata?.tool === "string"
          && ((event.event.detail as { request?: { providerMetadata?: { tool?: string } } }).request?.providerMetadata?.tool === "AskUserQuestion"),
      );

      const request = (approvalEvent.event.detail as {
        request: {
          kind: string;
          questions: Array<{
            id: string;
            question: string;
            options?: Array<{ preview?: string; previewFormat?: string }>;
          }>;
        };
      }).request;
      expect(request.kind).toBe("structured_question");
      expect(request.questions.map((question) => question.question)).toEqual([
        "What should we do about the two task list views?",
        "Should the inline task list pin while tasks are active?",
      ]);
      expect(request.questions[0]?.options?.[0]).toMatchObject({
        preview: "<div><strong>Inline only</strong><p>Compact stream, no bottom summary card.</p></div>",
        previewFormat: "markdown",
      });

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
        answers: {
          question_1: "Keep both, improve summary",
          question_2: "Yes, pin while active",
        },
      });

      await sendPromise;

      expect(permissionResult).toMatchObject({
        behavior: "allow",
        updatedInput: {
          answers: {
            "What should we do about the two task list views?": "Keep both, improve summary",
            "Should the inline task list pin while tasks are active?": "Yes, pin while active",
          },
        },
      });
    });

    it("keeps standalone ask_user declines explicit without emitting a fake cleanup tool_result", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const requestPromise = service.requestChatInput({
        chatSessionId: session.id,
        title: "Planning question",
        body: "Which part of the planning UI should we test first?",
        questions: [{
          id: "answer",
          header: "Question 1",
          question: "Which part of the planning UI should we test first?",
          options: [
            { label: "Question flow", value: "question_flow" },
            { label: "Plan updates", value: "plan_updates" },
          ],
          allowsFreeform: true,
        }],
      });

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => {
          const detail = event.event.type === "approval_request"
            ? (event.event.detail as { request?: { title?: string } } | undefined)
            : undefined;
          return event.event.type === "approval_request" && detail?.request?.title === "Planning question";
        },
      );

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "decline",
      });

      const result = await requestPromise;
      expect(result.decision).toBe("decline");
      expect(events.filter((event) => event.event.type === "tool_result")).toHaveLength(0);
    });

    it("replaces blank question text with the body rather than publishing an empty prompt", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      // OpenCode and Droid hand over an EMPTY question rather than omitting it,
      // which every caller's `??` fallback misses — and `questions` outranks
      // `body` here, so the card rendered with no prompt on it and a blank
      // description underneath.
      const requestPromise = service.requestChatInput({
        chatSessionId: session.id,
        title: "Blank question",
        body: "Which database should the worker read from?",
        questions: [{
          id: "answer",
          header: "Question 1",
          question: "   ",
          allowsFreeform: true,
        }],
      });

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => {
          const detail = event.event.type === "approval_request"
            ? (event.event.detail as { request?: { title?: string } } | undefined)
            : undefined;
          return event.event.type === "approval_request" && detail?.request?.title === "Blank question";
        },
      );

      const request = (approvalEvent.event.detail as {
        request: { description?: string; questions: Array<{ question: string }> };
      }).request;
      expect(request.questions[0]?.question).toBe("Which database should the worker read from?");
      expect(request.description).toBe("Which database should the worker read from?");

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "decline",
      });
      await requestPromise;
    });

    it("persists awaitingInput while chat input is pending and clears it after resolution", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const requestPromise = service.requestChatInput({
        chatSessionId: session.id,
        title: "Pending question",
        body: "Which path should we take?",
        questions: [{
          id: "__proto__",
          header: "Question 1",
          question: "Which path should we take?",
          allowsFreeform: true,
        }],
      });

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => {
          const detail = event.event.type === "approval_request"
            ? (event.event.detail as { request?: { title?: string } } | undefined)
            : undefined;
          return event.event.type === "approval_request" && detail?.request?.title === "Pending question";
        },
      );

      expect(readPersistedChatState(session.id).awaitingInput).toBe(true);
      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
        awaitingInput: true,
        pendingInputItemId: approvalEvent.event.itemId,
      });

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
        responseText: "Take the safe path.",
      });

      const result = await requestPromise;
      expect(result).toMatchObject({
        decision: "accept",
        responseText: "Take the safe path.",
      });
      expect(Object.prototype.hasOwnProperty.call(result.answers, "__proto__")).toBe(true);
      expect(result.answers.__proto__).toEqual(["Take the safe path."]);
      const resolutionEvent = events.find((event) =>
        event.sessionId === session.id
        && event.event.type === "pending_input_resolved"
        && event.event.itemId === approvalEvent.event.itemId,
      );
      expect(resolutionEvent?.event).toMatchObject({
        type: "pending_input_resolved",
        itemId: approvalEvent.event.itemId,
        resolution: "accepted",
      });
      const recorded = resolutionEvent?.event.type === "pending_input_resolved"
        ? resolutionEvent.event.answers
        : undefined;
      expect(Object.prototype.hasOwnProperty.call(recorded, "__proto__")).toBe(true);
      expect(recorded?.__proto__).toBe("Take the safe path.");
      expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
    });

    it.each([
      ["claude", "sonnet", undefined],
      ["codex", "gpt-5.4", undefined],
      ["opencode", "", "opencode/anthropic/claude-sonnet-5"],
      ["cursor", "composer-2", "cursor/composer-2"],
      ["droid", "claude-opus-4-6", "droid/claude-opus-4-6"],
    ] as const)(
      "clears pending input and persisted awaitingInput when a %s session is settled",
      async (provider, model, modelId) => {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider,
          model,
          ...(modelId ? { modelId } : {}),
        });
        const requestPromise = service.requestChatInput({
          chatSessionId: session.id,
          title: "Pending settlement question",
          body: "Should this session remain open?",
          questions: [{
            id: "answer",
            header: "Question",
            question: "Should this session remain open?",
            allowsFreeform: true,
          }],
        });
        const approvalEvent = await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope & {
            event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
          } =>
            event.event.type === "approval_request"
            && ((event.event.detail as { request?: { title?: string } } | undefined)?.request?.title === "Pending settlement question"),
        );

        expect(readPersistedChatState(session.id).awaitingInput).toBe(true);
        await service.dismissPendingInputForSettlement({ sessionId: session.id });

        await expect(requestPromise).resolves.toMatchObject({ decision: "cancel" });
        expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
        await expect(service.getSessionSummary(session.id)).resolves.not.toMatchObject({
          awaitingInput: true,
          pendingInputItemId: approvalEvent.event.itemId,
        });
      },
    );

    it.each([
      ["claude", "sonnet", undefined],
      ["codex", "gpt-5.4", undefined],
      ["opencode", "", "opencode/anthropic/claude-sonnet-5"],
      ["cursor", "composer-2", "cursor/composer-2"],
      ["droid", "claude-opus-4-6", "droid/claude-opus-4-6"],
    ] as const)(
      "clears a restored stale awaitingInput marker for %s without a live provider waiter",
      async (provider, model, modelId) => {
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider,
          model,
          ...(modelId ? { modelId } : {}),
        });
        writePersistedChatState(session.id, {
          ...readPersistedChatState(session.id),
          awaitingInput: true,
        });

        await service.dismissPendingInputForSettlement({ sessionId: session.id });

        expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
        await expect(service.getSessionSummary(session.id)).resolves.not.toMatchObject({
          awaitingInput: true,
        });
      },
    );

    it("rejects normal chat sends while a pending input request is waiting", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const requestPromise = service.requestChatInput({
        chatSessionId: session.id,
        title: "Pending question",
        body: "Which path should we take?",
        questions: [{
          id: "answer",
          header: "Question 1",
          question: "Which path should we take?",
          allowsFreeform: true,
        }],
      });

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => {
          const detail = event.event.type === "approval_request"
            ? (event.event.detail as { request?: { title?: string } } | undefined)
            : undefined;
          return event.event.type === "approval_request" && detail?.request?.title === "Pending question";
        },
      );

      await expect(service.sendMessage({
        sessionId: session.id,
        text: "Treat this as the answer even though it came through chat.send.",
      })).rejects.toThrow("Answer or decline the pending request before sending another message.");

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "decline",
      });

      await expect(requestPromise).resolves.toMatchObject({ decision: "decline" });
    });

    it("maps freeform replies to the single pending question when only one answer is needed", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const requestPromise = service.requestChatInput({
        chatSessionId: session.id,
        title: "Single question",
        body: "Which area should we test first?",
        questions: [{
          id: "answer",
          header: "Question 1",
          question: "Which area should we test first?",
          allowsFreeform: true,
        }],
      });

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => {
          const detail = event.event.type === "approval_request"
            ? (event.event.detail as { request?: { title?: string } } | undefined)
            : undefined;
          return event.event.type === "approval_request" && detail?.request?.title === "Single question";
        },
      );

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
        responseText: "Question flow",
      });

      await expect(requestPromise).resolves.toMatchObject({
        decision: "accept",
        answers: { answer: ["Question flow"] },
        responseText: "Question flow",
      });
    });

    // The reply must not be copied into every question — that is the fan-out this
    // test was written for. It must also not land under a synthetic "response"
    // key, which is where it used to go: Claude's `question.reply` takes one
    // answer array per ASKED question, so that key matched nothing and the user's
    // reply never reached the model. It answers the first question, and only the
    // first, which is what the desktop composer produces for the same input.
    it("lands a single freeform reply on one question rather than fanning it out", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const requestPromise = service.requestChatInput({
        chatSessionId: session.id,
        title: "Multiple questions",
        body: "Tell me which plan we should use and whether to pin tasks.",
        questions: [
          {
            id: "plan_focus",
            header: "Plan focus",
            question: "What kind of planning scenario should I use?",
            allowsFreeform: true,
          },
          {
            id: "task_pinning",
            header: "Task pinning",
            question: "Should the inline task list stay pinned?",
            allowsFreeform: true,
          },
        ],
      });

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => {
          const detail = event.event.type === "approval_request"
            ? (event.event.detail as { request?: { title?: string } } | undefined)
            : undefined;
          return event.event.type === "approval_request" && detail?.request?.title === "Multiple questions";
        },
      );

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
        responseText: "Start with the UI planning case.",
      });

      const resolved = await requestPromise;
      expect(resolved).toMatchObject({
        decision: "accept",
        answers: { plan_focus: ["Start with the UI planning case."] },
        responseText: "Start with the UI planning case.",
      });
      expect(Object.keys(resolved.answers ?? {})).toEqual(["plan_focus"]);
    });

    it("responds to native Codex requestUserInput declines with empty answers instead of interrupting the turn", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Ask one planning question before coding.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "native-request-1",
        method: "item/tool/requestUserInput",
        params: {
          itemId: "codex-question-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "plan_focus",
              header: "Plan focus",
              question: "What kind of planning scenario should I use?",
              isOther: true,
              options: [
                { label: "UI planning" },
                { label: "Bug fix planning" },
              ],
            },
          ],
        },
      });

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && event.event.itemId === "codex-question-1",
      );

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "cancel",
      });

      expect(
        mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt"),
      ).toBe(false);
      expect(
        mockState.codexRequestPayloads.find((payload) => payload.id === "native-request-1"),
      ).toMatchObject({
        id: "native-request-1",
        result: {
          answers: {},
        },
      });
    });

    it("keeps Codex isBlocking:false as live steering instead of awaiting you", async () => {
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
        text: "Keep going while I answer.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "steering-request-1",
        method: "item/tool/requestUserInput",
        params: {
          itemId: "codex-steer-1",
          threadId: "thread-1",
          turnId: "turn-1",
          isBlocking: false,
          questions: [{
            id: "steer",
            header: "Steer",
            question: "Want a tighter plan?",
            isOther: true,
            options: [{ label: "Yes" }, { label: "No" }],
          }],
        },
      });
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && event.event.itemId === "codex-steer-1",
      );
      expect((approvalEvent.event.detail as { request?: { blocking?: boolean } } | undefined)?.request?.blocking)
        .toBe(false);

      await service.sendMessage({
        sessionId: session.id,
        text: "Keep coding; I'll answer in the card.",
      }, { awaitDispatch: true, routeActiveToSteer: true });

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.awaitingInput).toBeUndefined();
      expect(summary?.pendingInputItemId).toBeUndefined();
      expect(summary?.steeringInput).toBe(true);
      expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
      expect(readPersistedChatState(session.id).steeringInput).toBeUndefined();
    });

    it("points pendingInputItemId at a blocking Codex request when a steering card is already live", async () => {
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
        text: "Keep going.",
      }, { awaitDispatch: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "steer-then-block-1",
        method: "item/tool/requestUserInput",
        params: {
          itemId: "codex-steer-first",
          isBlocking: false,
          questions: [{ id: "steer", question: "Want more tests?", options: [{ label: "Yes" }] }],
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "approval_request" && event.event.itemId === "codex-steer-first",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "steer-then-block-2",
        method: "item/tool/requestUserInput",
        params: {
          itemId: "codex-block-second",
          questions: [{ id: "block", question: "Approve this command?", options: [{ label: "Allow" }] }],
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "approval_request" && event.event.itemId === "codex-block-second",
      );

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.awaitingInput).toBe(true);
      expect(summary?.pendingInputItemId).toBe("codex-block-second");
      expect(summary?.steeringInput).toBe(true);
    });

    it("still blocks Codex requestUserInput when isBlocking is omitted", async () => {
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
        text: "Ask before coding.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "blocking-request-1",
        method: "item/tool/requestUserInput",
        params: {
          itemId: "codex-block-1",
          questions: [{
            id: "plan",
            header: "Plan",
            question: "Which plan?",
            options: [{ label: "A" }],
          }],
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "approval_request"
          && event.event.itemId === "codex-block-1",
      );

      await expect(service.sendMessage({
        sessionId: session.id,
        text: "Treat this as the answer.",
      })).rejects.toThrow("Answer or decline the pending request before sending another message.");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.awaitingInput).toBe(true);
      expect(summary?.pendingInputItemId).toBe("codex-block-1");
      expect(summary?.steeringInput).toBeUndefined();
    });

    it("cancels a Codex steering card when the turn completes", async () => {
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
        text: "Keep going.",
      }, { awaitDispatch: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "steering-request-done",
        method: "item/tool/requestUserInput",
        params: {
          itemId: "codex-steer-done",
          isBlocking: false,
          questions: [{ id: "steer", question: "Want more tests?", options: [{ label: "Yes" }] }],
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "approval_request" && event.event.itemId === "codex-steer-done",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "pending_input_resolved"
          && event.event.itemId === "codex-steer-done",
      );
      const summary = await service.getSessionSummary(session.id);
      expect(summary?.steeringInput).not.toBe(true);
      expect(summary?.awaitingInput).not.toBe(true);
    });
  });
});
